/**
 * Splendor room - drives the ported pure engine (shared/games/splendor/engine)
 * and mirrors it into the synced schema.
 *
 * Authority model: `engine` is the server-only source of truth. Clients send
 * raw Move/Resolution JSON; everything is whitelist-sanitized and validated
 * before it touches the engine. The schema mirror (`syncFromEngine`) is
 * rebuilt in place after every accepted input.
 *
 * Seats: engine seats are 0..N-1 in `seatOrder` order (players sorted by
 * framework seat at game start). `frameworkSeatByEngineSeat` is snapshotted
 * for the final "win:<seat>" mapping because the winner may have left the
 * players map by the time the game ends.
 *
 * Players who leave for good mid-game (3-4p) are played out by a seeded
 * RandomPolicy ghost; 2p games end "abandoned" via the framework instead.
 */
import type { Client } from "colyseus";
import { ArraySchema } from "@colyseus/schema";
import {
  type BasePlayer,
  ColorCounts,
  EndReason,
  Phase,
  SPLENDOR,
  SplendorCard,
  SplendorEngine,
  SplendorMsg,
  SplendorNoble,
  SplendorPlayer,
  SplendorSeat,
  SplendorState,
} from "@backbone/shared";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import { TurnManager } from "../../framework/TurnManager.js";
import { grantPrivateView, revokePrivateView } from "../../framework/privateState.js";

const {
  COLORS,
  applyMove,
  applyPass,
  applyResolution,
  createGame,
  isLegalMove,
  legalMoves,
  playerPoints,
  ranking,
  RandomPolicy,
} = SplendorEngine;
type GameState = SplendorEngine.GameState;
type EngineCard = SplendorEngine.Card;
type EngineNoble = SplendorEngine.Noble;
type Move = SplendorEngine.Move;
type Resolution = SplendorEngine.Resolution;
type Color = SplendorEngine.Color;
type Tier = SplendorEngine.Tier;

export class SplendorRoom extends BaseGameRoom<SplendorState> {
  state = new SplendorState();
  readonly minPlayers = 2;
  readonly maxPlayers = 4;

  /** Server-only engine truth (never synced). Public for white-box tests. */
  public engine!: GameState;
  /** sessionIds in engine-seat order (index = engine seat), snapshotted at game start. */
  public seatOrder: string[] = [];
  /** Framework seat per engine seat, snapshotted at start (for win:<seat>). */
  public frameworkSeatByEngineSeat: number[] = [];

  /** Plays vacated seats (and their pending sub-decisions). Reseeded per game. */
  private ghost = new RandomPolicy(1);
  private seedOption?: number;
  /** The reserved-cards ArraySchema each session was granted (re-granted per game). */
  private grantedReserved = new Map<string, ArraySchema<SplendorCard>>();

  // Untimed in v1: with no turnSeconds, pause()/resume() are no-ops, kept for
  // symmetry so adding a turn clock later is just turnSeconds + onTimeout.
  private turns = new TurnManager(this, {
    onTurnChange: (sessionId) => {
      this.state.currentTurn = sessionId;
    },
  });

  protected createPlayer(): SplendorPlayer {
    return new SplendorPlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    // Optional deterministic shuffle seed (tests/dev). A set seed is reused
    // on rematch, so only ever pass one when reproducibility is the point.
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;
    this.onMessage(SplendorMsg.MOVE, (client, payload) => this.handleMove(client, payload));
    this.onMessage(SplendorMsg.RESOLVE, (client, payload) => this.handleResolve(client, payload));
  }

  protected onGameStart(): void {
    // Full re-init - this also runs on rematch.
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    this.seatOrder = players.map((p) => p.sessionId);
    this.frameworkSeatByEngineSeat = players.map((p) => p.seat);
    const seed = this.seedOption ?? Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.engine = createGame(players.length, seed);
    this.ghost = new RandomPolicy(seed ^ 0x9e3779b9);

    this.state.seats.clear();
    this.state.market.clear();
    for (let i = 0; i < 12; i++) this.state.market.push(new SplendorCard());
    for (const p of players) {
      const seat = new SplendorSeat();
      seat.sessionId = p.sessionId;
      seat.nickname = p.nickname;
      this.state.seats.push(seat);
      this.regrantReserved(p.sessionId, seat.reserved);
    }
    this.state.lastRound = false;
    this.syncFromEngine();
    this.turns.start(this.seatOrder);
  }

  /**
   * Point a session's private view at its current reserved-cards array.
   * Each game builds new SplendorSeat instances, so grants must be re-issued
   * (and stale ones revoked) on every onGameStart.
   */
  private regrantReserved(sessionId: string, reserved: ArraySchema<SplendorCard>): void {
    const client = this.clients.getById(sessionId);
    if (!client) return; // disconnected right now: granted in onPlayerReconnected
    const old = this.grantedReserved.get(sessionId);
    if (old && old !== reserved) revokePrivateView(client, old);
    grantPrivateView(client, reserved);
    this.grantedReserved.set(sessionId, reserved);
  }

  // ---- message handlers ----------------------------------------------------

  private handleMove(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    if (this.engine.awaiting.inputType !== "MOVE") return;
    if (this.seatOrder[this.engine.awaiting.seat] !== client.sessionId) return;
    const move = parseMove(payload);
    if (!move || !isLegalMove(this.engine, move)) return;
    this.engine = applyMove(this.engine, move).state;
    this.afterApply();
  }

  private handleResolve(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    const awaiting = this.engine.awaiting;
    if (awaiting.inputType === "MOVE") return;
    if (this.seatOrder[awaiting.seat] !== client.sessionId) return;
    const res = parseResolution(payload);
    if (!res || res.kind !== awaiting.inputType) return;
    try {
      this.engine = applyResolution(this.engine, res).state;
    } catch {
      return; // wrong count / noble not among choices / over-discard: ignore
    }
    this.afterApply();
  }

  // ---- engine driving --------------------------------------------------------

  private isVacated(engineSeat: number): boolean {
    const sessionId = this.seatOrder[engineSeat];
    return !sessionId || !this.state.players.has(sessionId);
  }

  /**
   * Resolve every state no connected human can act on, synchronously:
   *  - vacated seats are played by the ghost policy;
   *  - a present player with zero legal moves is force-passed (applyPass is
   *    only legal in exactly that case; chains of forced passes end the game
   *    as a stalemate).
   * Leaves the engine at a human-actionable state or game over.
   */
  private settleEngine(): void {
    let guard = 0;
    while (!this.engine.over && ++guard <= 10_000) {
      const awaiting = this.engine.awaiting;
      if (this.isVacated(awaiting.seat)) {
        this.engine = this.playOneDecisionFor(awaiting.seat).state;
      } else if (awaiting.inputType === "MOVE" && legalMoves(this.engine).length === 0) {
        this.engine = applyPass(this.engine).state;
      } else {
        break;
      }
    }
  }

  /**
   * Have the ghost policy act once for a seat (its move OR pending
   * sub-decision). Also the hook point for a future turn-timer timeout.
   */
  private playOneDecisionFor(engineSeat: number): SplendorEngine.ApplyResult {
    const awaiting = this.engine.awaiting;
    if (awaiting.seat !== engineSeat) throw new Error("not this seat's decision");
    if (awaiting.inputType === "MOVE") {
      const move = this.ghost.move(this.engine);
      return move ? applyMove(this.engine, move) : applyPass(this.engine);
    }
    if (awaiting.inputType === "PICK_NOBLE") {
      return applyResolution(this.engine, this.ghost.pickNoble(this.engine));
    }
    return applyResolution(this.engine, this.ghost.discard(this.engine));
  }

  /** Run after every accepted engine input (and after a mid-game departure). */
  private afterApply(): void {
    this.settleEngine();
    this.syncFromEngine();
    if (this.engine.over) {
      this.endGame(this.mapEndReason());
      return;
    }
    // Align the rotation with the engine. Post-settle the awaiting seat is a
    // present player, so its sessionId is in the rotation; bounded anyway.
    const target = this.seatOrder[this.engine.awaiting.seat];
    let steps = 0;
    while (target && this.turns.current() !== target && ++steps <= this.maxPlayers) {
      this.turns.next();
    }
  }

  private mapEndReason(): string {
    const winners = ranking(this.engine).filter((r) => r.rank === 1);
    if (winners.length === 1) {
      const frameworkSeat = this.frameworkSeatByEngineSeat[winners[0]!.seat];
      if (frameworkSeat !== undefined) return this.winBySeat(frameworkSeat);
    }
    return EndReason.DRAW;
  }

  // ---- engine -> schema mirror (in place; granted instances never replaced) --

  private syncFromEngine(): void {
    const e = this.engine;
    writeColors(this.state.bank, e.supplyGems);
    this.state.bankGold = e.supplyGold;
    let slot = 0;
    for (const t of [1, 2, 3] as const) {
      for (let i = 0; i < 4; i++, slot++) {
        writeCard(this.state.market[slot]!, e.market[t][i] ?? null);
      }
      this.state.deckCounts[t - 1] = e.decks[t].length;
    }
    rebuildNobles(this.state.nobles, e.nobles);
    e.players.forEach((p, idx) => {
      const seat = this.state.seats[idx];
      if (!seat) return;
      writeColors(seat.gems, p.gems);
      seat.gold = p.gold;
      writeColors(seat.bonuses, p.bonuses);
      seat.points = playerPoints(p);
      rebuildCards(seat.built, p.built);
      rebuildNobles(seat.nobles, p.nobles);
      seat.reservedCount = p.reserved.length;
      this.syncReserved(this.seatOrder[idx], seat.reserved, p.reserved);
      if (this.isVacated(idx)) {
        seat.gone = true;
        seat.sessionId = "";
      }
    });
    this.state.awaitingSeat = e.awaiting.seat;
    this.state.awaitingType = e.over ? "" : e.awaiting.inputType;
    this.state.discardCount = e.awaiting.discardCount ?? 0;
    this.state.nobleChoices.clear();
    if (!e.over) for (const id of e.awaiting.nobleChoices ?? []) this.state.nobleChoices.push(id);
    this.state.lastRound = e.endFlag;
    this.state.turnCount = e.turnCount;
    // currentTurn is written ONLY by TurnManager.onTurnChange / onGameEnded.
  }

  /**
   * Mirror one seat's reserved cards. Unlike the public arrays, every card
   * instance pushed here must ALSO be added to the owner's StateView:
   * schema v4 keeps per-item gating for default-tag @view() collections
   * (granting the array only covers items present at grant time). Reserved
   * contents are id-stable, so a quick id diff skips untouched seats.
   */
  private syncReserved(
    sessionId: string | undefined,
    dst: ArraySchema<SplendorCard>,
    src: EngineCard[]
  ): void {
    if (dst.length === src.length && src.every((c, i) => dst[i]?.id === c.id)) return;
    dst.clear();
    const client = sessionId ? this.clients.getById(sessionId) : undefined;
    for (const c of src) {
      const card = new SplendorCard();
      writeCard(card, c);
      dst.push(card);
      if (client?.view) grantPrivateView(client, card);
    }
  }

  // ---- framework hooks -------------------------------------------------------

  protected override onPlayerDropped(player: BasePlayer): void {
    if (this.turns.current() === player.sessionId) this.turns.pause();
  }

  protected override onPlayerReconnected(player: BasePlayer): void {
    if (this.turns.current() === player.sessionId) this.turns.resume();
    if (this.state.phase !== Phase.PLAYING) return;
    const idx = this.seatOrder.indexOf(player.sessionId);
    const seat = idx >= 0 ? this.state.seats[idx] : undefined;
    const client = this.clients.getById(player.sessionId);
    // Re-grant if they were disconnected when the game (re)started, or if the
    // reconnected Client came back without its StateView.
    if (seat && (!client?.view || this.grantedReserved.get(player.sessionId) !== seat.reserved)) {
      this.regrantReserved(player.sessionId, seat.reserved);
    }
  }

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.turns.remove(player.sessionId);
    this.grantedReserved.delete(player.sessionId);
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    // With too few humans left, the framework ends the game as "abandoned"
    // right after this hook - do not ghost-complete it first.
    if (this.state.players.size < this.minPlayers) return;
    this.afterApply(); // ghost resolves the leaver's pending decision / turns
  }

  protected override onGameEnded(): void {
    this.turns.stop();
    this.state.currentTurn = "";
    this.state.awaitingType = "";
  }
}

// ---- engine -> schema writers (pure) ----------------------------------------

function writeColors(dst: ColorCounts, src: Record<Color, number>): void {
  dst.white = src.white;
  dst.blue = src.blue;
  dst.green = src.green;
  dst.red = src.red;
  dst.black = src.black;
}

function writeCard(dst: SplendorCard, src: EngineCard | null): void {
  if (!src) {
    dst.id = 0;
    dst.tier = 0;
    dst.bonus = "";
    dst.points = 0;
    dst.cost.white = dst.cost.blue = dst.cost.green = dst.cost.red = dst.cost.black = 0;
    return;
  }
  dst.id = src.id;
  dst.tier = src.tier;
  dst.bonus = src.bonus;
  dst.points = src.points;
  writeColors(dst.cost, src.cost);
}

function rebuildCards(dst: ArraySchema<SplendorCard>, src: EngineCard[]): void {
  dst.clear();
  for (const c of src) {
    const card = new SplendorCard();
    writeCard(card, c);
    dst.push(card);
  }
}

function rebuildNobles(dst: ArraySchema<SplendorNoble>, src: EngineNoble[]): void {
  dst.clear();
  for (const n of src) {
    const noble = new SplendorNoble();
    noble.id = n.id;
    noble.points = n.points;
    writeColors(noble.requirement, n.requirement);
    dst.push(noble);
  }
}

// ---- sanitizers: whitelist-copy clean objects from client JSON ---------------
// Never hand a raw client object to the engine - reject unknown kinds, wrong
// types, duplicate colors, and out-of-range values, then rebuild the payload
// from scratch. (Exported for direct unit testing.)

const COLOR_SET = new Set<string>(COLORS);

function parseTier(v: unknown): Tier | null {
  return v === 1 || v === 2 || v === 3 ? v : null;
}

function parseColor(v: unknown): Color | null {
  return typeof v === "string" && COLOR_SET.has(v) ? (v as Color) : null;
}

function parseCount(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : null;
}

export function parseMove(raw: unknown): Move | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.kind) {
    case "TAKE_THREE": {
      // 1..3 colors: the engine tolerates an empty take when all piles are
      // empty, but that would reset the forced-pass streak and stall
      // stalemate detection - never accept it from a client.
      if (!Array.isArray(m.colors) || m.colors.length < 1 || m.colors.length > 3) return null;
      const colors: Color[] = [];
      for (const c of m.colors) {
        const color = parseColor(c);
        if (!color) return null;
        colors.push(color);
      }
      if (new Set(colors).size !== colors.length) return null;
      return { kind: "TAKE_THREE", colors };
    }
    case "TAKE_TWO": {
      const color = parseColor(m.color);
      return color ? { kind: "TAKE_TWO", color } : null;
    }
    case "RESERVE": {
      const from = m.from as Record<string, unknown> | null | undefined;
      if (typeof from !== "object" || from === null) return null;
      if ("market" in from) {
        const market = from.market as Record<string, unknown> | null | undefined;
        const tier = parseTier(market?.tier);
        const index = parseCount(market?.index, 3);
        if (tier === null || index === null) return null;
        return { kind: "RESERVE", from: { market: { tier, index } } };
      }
      if ("deck" in from) {
        const deck = from.deck as Record<string, unknown> | null | undefined;
        const tier = parseTier(deck?.tier);
        return tier === null ? null : { kind: "RESERVE", from: { deck: { tier } } };
      }
      return null;
    }
    case "BUY": {
      const from = m.from as Record<string, unknown> | null | undefined;
      if (typeof from !== "object" || from === null) return null;
      if ("market" in from) {
        const market = from.market as Record<string, unknown> | null | undefined;
        const tier = parseTier(market?.tier);
        const index = parseCount(market?.index, 3);
        if (tier === null || index === null) return null;
        return { kind: "BUY", from: { market: { tier, index } } };
      }
      if ("reserve" in from) {
        const reserve = from.reserve as Record<string, unknown> | null | undefined;
        const cardId = parseCount(reserve?.cardId, 90);
        if (cardId === null || cardId < 1) return null;
        return { kind: "BUY", from: { reserve: { cardId } } };
      }
      return null;
    }
    default:
      return null;
  }
}

export function parseResolution(raw: unknown): Resolution | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind === "PICK_NOBLE") {
    const nobleId = parseCount(r.nobleId, 10);
    return nobleId !== null && nobleId >= 1 ? { kind: "PICK_NOBLE", nobleId } : null;
  }
  if (r.kind === "DISCARD") {
    const gemsIn = (typeof r.gems === "object" && r.gems !== null ? r.gems : {}) as Record<
      string,
      unknown
    >;
    const gems: Partial<Record<Color, number>> = {};
    for (const key of Object.keys(gemsIn)) {
      const color = parseColor(key);
      const count = parseCount(gemsIn[key], 10);
      if (!color || count === null) return null;
      if (count > 0) gems[color] = count;
    }
    const gold = r.gold === undefined ? 0 : parseCount(r.gold, 5);
    if (gold === null) return null;
    return { kind: "DISCARD", gems, gold };
  }
  return null;
}

export { SPLENDOR };
