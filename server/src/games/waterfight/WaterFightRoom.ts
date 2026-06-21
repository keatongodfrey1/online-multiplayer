/**
 * WaterFightRoom — the thin Colyseus adapter over the pure Water Fight engine.
 *
 * The engine (WaterFightEngine) is the ONLY source of truth and is never synced;
 * the schema is a top-down projection (deck counts, public seat status, each
 * seat's OWN hand via @view). The engine owns turns AND out-of-turn awaiting
 * (defenders/reactors are non-current seats), so this room has NO TurnManager —
 * it routes MOVE/RESOLVE by membership in `engine.awaiting.seats`, and a single
 * `clock.setTimeout` auto-advances bot / vacated / disconnected / timed-out seats.
 */
import type { Client } from "colyseus";
import type { Delayed } from "@colyseus/timer";
import {
  EndReason,
  Phase,
  WaterFightCard,
  WaterFightEngine as WF,
  WaterFightMsg,
  WaterFightPlayer,
  WaterFightSeat,
  WaterFightState,
  wfSettingByKey,
} from "@backbone/shared";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import { grantPrivateView, revokePrivateView } from "../../framework/privateState.js";
import { parseMove, parseResolution } from "./sanitize.js";
import { type ParsedSave, parseSave, serializeSave } from "./save.js";

type GameState = WF.GameState;
type Policy = WF.Policy;
type EngineCard = WF.Card;
type Resolution = WF.Resolution;

const LOG_CAP = 80;

export class WaterFightRoom extends BaseGameRoom<WaterFightState> {
  state = new WaterFightState();
  readonly minPlayers = 2;
  readonly maxPlayers = 5;
  override supportsBots = true;
  override allowLateJoin = true;
  override supportsReclaim = true;
  protected override supportsSaves = true;

  /** Server-only source of truth. */
  public engine!: GameState;
  /** sessionId by engine seat ("" = vacated/autopilot). */
  public seatOrder: string[] = [];
  /** Framework seat index by engine seat (for "win:<seat>"). */
  public frameworkSeatByEngineSeat: number[] = [];

  private ghost: Policy = new WF.RandomPolicy(1);
  public botBrains = new Map<string, Policy>();
  public botDelayMs = 700;
  private autoTimer?: Delayed;
  private seedOption?: number;
  /** The @view() hand array each session currently has granted. */
  private grantedHands = new Map<string, ReturnType<() => WaterFightSeat["hand"]>>();

  protected createPlayer(): WaterFightPlayer {
    return new WaterFightPlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;
    this.onMessage(WaterFightMsg.MOVE, (client, payload) => this.handleMove(client, payload));
    this.onMessage(WaterFightMsg.RESOLVE, (client, payload) => this.handleResolve(client, payload));
    this.onMessage(WaterFightMsg.CONFIG, (client, payload) => this.handleConfig(client, payload));
  }

  // ---- start / rematch ----------------------------------------------------

  protected onGameStart(): void {
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    const seed = this.seedOption ?? (Math.floor(Math.random() * 0xffffffff) >>> 0);
    const load = this.pendingLoad?.payload as ParsedSave | undefined;
    this.pendingLoad = undefined;

    if (load) {
      // Resume: reuse the validated engine, rebinding seats to the present
      // humans/bots by name; an unmatched saved seat stays vacated (autopilot).
      this.engine = load.engine;
      this.seatOrder = load.seats.map((s) =>
        s.gone ? "" : players.find((p) => p.isBot === s.isBot && p.nickname.toLowerCase() === s.nickname.toLowerCase())?.sessionId ?? "",
      );
      this.frameworkSeatByEngineSeat = this.seatOrder.map((sid) => players.find((p) => p.sessionId === sid)?.seat ?? -1);
    } else {
      this.engine = WF.createGame(players.length, seed, {
        startingLives: this.state.startingLives,
        splashHit: this.state.splashHit,
        splashMiss: this.state.splashMiss,
        handLimit: this.state.handLimit,
        shopCost: this.state.shopCost,
        eventDensity: this.state.eventDensity,
      });
      this.seatOrder = players.map((p) => p.sessionId);
      this.frameworkSeatByEngineSeat = players.map((p) => p.seat);
    }

    this.ghost = new WF.RandomPolicy((seed ^ 0x9e3779b9) >>> 0);
    this.botBrains.clear();
    this.seatOrder.forEach((sid, i) => {
      if (sid && this.state.players.get(sid)?.isBot) {
        this.botBrains.set(sid, new WF.GreedyPolicy((seed ^ ((i + 1) * 0x5bd1e995)) >>> 0));
      }
    });

    this.state.seats.clear();
    this.grantedHands.clear();
    this.seatOrder.forEach((sid, i) => {
      const seat = new WaterFightSeat();
      seat.sessionId = sid;
      seat.seat = i;
      seat.nickname = load ? (load.seats[i]?.nickname ?? `Seat ${i + 1}`) : (this.state.players.get(sid)?.nickname ?? `Seat ${i + 1}`);
      if (!sid) seat.gone = true;
      this.state.seats.push(seat);
      if (sid) this.regrantHand(sid, seat.hand);
    });

    this.afterApply();
  }

  // ---- save / resume ------------------------------------------------------

  protected override isGameOver(): boolean {
    return !this.engine || this.engine.over;
  }

  protected override loadedSaveTurnLabel(parsed: unknown): number {
    return (parsed as ParsedSave).engine.turnCount + 1;
  }

  protected override onSaveStaged(parsed: unknown): void {
    const o = (parsed as ParsedSave).options;
    this.state.startingLives = o.startingLives;
    this.state.splashHit = o.splashHit;
    this.state.splashMiss = o.splashMiss;
    this.state.handLimit = o.handLimit;
    this.state.shopCost = o.shopCost;
    this.state.eventDensity = o.eventDensity;
    this.state.turnSeconds = o.turnSeconds;
    this.state.reactionSeconds = o.reactionSeconds;
  }

  protected override parseSave(raw: unknown): ParsedSave | null {
    return parseSave(raw);
  }

  protected override serializeSave(): object | null {
    return serializeSave({
      engine: this.engine,
      seats: this.seatOrder.map((sid, i) => {
        const p = sid ? this.state.players.get(sid) : undefined;
        return { nickname: this.state.seats[i]?.nickname ?? `Seat ${i + 1}`, isBot: p?.isBot === true, gone: !p };
      }),
      options: {
        startingLives: this.state.startingLives,
        splashHit: this.state.splashHit,
        splashMiss: this.state.splashMiss,
        handLimit: this.state.handLimit,
        shopCost: this.state.shopCost,
        eventDensity: this.state.eventDensity,
        turnSeconds: this.state.turnSeconds,
        reactionSeconds: this.state.reactionSeconds,
      },
    });
  }

  // ---- message handlers ---------------------------------------------------

  private engineSeatOf(sessionId: string): number {
    return this.seatOrder.indexOf(sessionId);
  }

  private handleMove(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    if (this.engine.awaiting.kind !== "MOVE") return;
    const seat = this.engineSeatOf(client.sessionId);
    if (seat < 0 || !this.engine.awaiting.seats.includes(seat)) return; // not the awaited mover
    const move = parseMove(payload);
    if (!move || !WF.isLegalMove(this.engine, move)) return;
    this.engine = WF.applyMove(this.engine, move).state;
    this.afterApply();
  }

  private handleResolve(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    const awaiting = this.engine.awaiting;
    if (awaiting.kind === "MOVE" || awaiting.kind === "GAME_OVER") return;
    const seat = this.engineSeatOf(client.sessionId);
    if (seat < 0 || !awaiting.seats.includes(seat)) return; // not an awaited reactor
    const res = parseResolution(payload);
    if (!res) return;
    try {
      this.engine = WF.applyResolution(this.engine, res).state;
    } catch {
      return; // illegal for the current await: reject silently
    }
    this.afterApply();
  }

  private handleConfig(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    if (typeof payload !== "object" || payload === null) return;
    const { key, value } = payload as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || typeof value !== "number" || !Number.isFinite(value)) return;
    const setting = wfSettingByKey(key);
    if (!setting) return;
    const v = Math.min(setting.max, Math.max(setting.min, Math.round(value)));
    (this.state as unknown as Record<string, number>)[key] = v;
  }

  // ---- the funnel ---------------------------------------------------------

  private afterApply(): void {
    this.syncFromEngine();
    if (this.engine.over) {
      this.finishGame();
      return;
    }
    this.scheduleAuto();
  }

  private finishGame(): void {
    this.autoTimer?.clear();
    this.autoTimer = undefined;
    const w = this.engine.winner;
    if (w !== null && w >= 0) this.endGame(this.winBySeat(this.frameworkSeatByEngineSeat[w] ?? w));
    else this.endGame(EndReason.DRAW);
  }

  // ---- auto-advance (bots / vacated / disconnected / idle) ----------------

  private awaitedSeat(): number {
    return this.engine.awaiting.seats[0] ?? -1;
  }

  private isAutoSeat(seat: number): boolean {
    const sid = this.seatOrder[seat];
    if (!sid) return true; // vacated
    const p = this.state.players.get(sid);
    if (!p) return true;
    return p.isBot === true || p.connected === false;
  }

  private timeoutSecondsFor(kind: string): number {
    return kind === "MOVE" || kind === "DISCARD" ? this.state.turnSeconds : this.state.reactionSeconds;
  }

  private scheduleAuto(): void {
    this.autoTimer?.clear();
    this.autoTimer = undefined;
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    const seat = this.awaitedSeat();
    if (seat < 0) return;
    const auto = this.isAutoSeat(seat);
    if (auto) {
      this.state.actionDeadline = 0;
      this.autoTimer = this.clock.setTimeout(() => this.autoPlay(seat), this.botDelayMs);
      return;
    }
    const seconds = this.timeoutSecondsFor(this.engine.awaiting.kind);
    if (seconds <= 0) {
      this.state.actionDeadline = 0; // wait for the human
      return;
    }
    const ms = seconds * 1000;
    this.state.actionDeadline = Date.now() + ms;
    this.autoTimer = this.clock.setTimeout(() => this.autoPlay(seat), ms);
  }

  /** Drive one decision for an awaited seat: bots play their brain, everyone else
   *  auto-passes (the gentle default for vacated/disconnected/timed-out seats). */
  private autoPlay(seat: number): void {
    this.autoTimer = undefined;
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    if (this.awaitedSeat() !== seat) return; // the table already moved on
    const sid = this.seatOrder[seat];
    const isBot = !!sid && this.state.players.get(sid)?.isBot === true;
    try {
      if (isBot) {
        const policy = this.botBrains.get(sid) ?? this.ghost;
        const a = this.engine.awaiting;
        this.engine =
          a.kind === "MOVE"
            ? WF.applyMove(this.engine, policy.move(this.engine)).state
            : WF.applyResolution(this.engine, policy.resolve(this.engine)).state;
      } else {
        this.applyGentle(seat);
      }
    } catch {
      return;
    }
    this.afterApply();
  }

  /** The safe "do nothing" decision for the current await (pass / END_TURN / discard). */
  private applyGentle(seat: number): void {
    const a = this.engine.awaiting;
    if (a.kind === "MOVE") {
      this.engine = WF.applyMove(this.engine, { kind: "END_TURN" }).state;
      return;
    }
    let res: Resolution;
    switch (a.kind) {
      case "REACT":
        res = { kind: "REACT", action: "pass" };
        break;
      case "DEFEND":
        res = { kind: "DEFEND", defense: "pass" };
        break;
      case "ATTACKER_RESPOND":
        res = { kind: "ATTACKER_RESPOND", respond: "pass" };
        break;
      case "EXTRA_THROW":
        res = { kind: "EXTRA", action: "pass" };
        break;
      case "DISCARD": {
        const hand = this.engine.players[seat]!.hand;
        const need = Math.max(0, hand.length - this.engine.options.handLimit);
        res = { kind: "DISCARD", cardIds: hand.slice(0, need).map((c) => c.id) };
        break;
      }
      default:
        return;
    }
    this.engine = WF.applyResolution(this.engine, res).state;
  }

  // ---- hidden hands -------------------------------------------------------

  /** Point a session's private view at its (stable) hand array, revoking a stale one. */
  private regrantHand(sessionId: string, hand: WaterFightSeat["hand"]): void {
    if (!sessionId) return;
    const client = this.clients.getById(sessionId);
    if (!client) return; // disconnected: re-granted in onPlayerReconnected
    const old = this.grantedHands.get(sessionId);
    if (old && old !== hand) revokePrivateView(client, old);
    grantPrivateView(client, hand);
    for (const card of hand) grantPrivateView(client, card);
    this.grantedHands.set(sessionId, hand);
  }

  /** Rebuild a seat's hand cards in place, granting each new card to its owner and
   *  revoking the old ones (diff-skips when nothing changed). A stolen/swapped card
   *  becomes a fresh instance under the new owner — never leaking to the old view. */
  private syncHand(seat: number, dst: WaterFightSeat["hand"], src: EngineCard[]): void {
    if (dst.length === src.length && src.every((c, i) => dst[i]?.id === c.id)) return;
    const sid = this.seatOrder[seat];
    const client = sid ? this.clients.getById(sid) : undefined;
    if (client?.view) for (const old of dst) revokePrivateView(client, old);
    dst.clear();
    for (const c of src) {
      const card = new WaterFightCard();
      card.id = c.id;
      card.kind = c.kind;
      dst.push(card);
      if (client?.view) grantPrivateView(client, card);
    }
  }

  // ---- projection ---------------------------------------------------------

  private syncFromEngine(): void {
    const e = this.engine;
    this.state.mainDeckCount = e.mainDeck.length;
    this.state.mainDiscardCount = e.mainDiscard.length;
    this.state.splashPileCount = e.splashPile.length;
    this.state.splashDiscardCount = e.splashDiscard.length;
    this.state.usedPileCount = e.usedPile.length;
    this.state.stackCounts[0] = e.stacks.defense.length;
    this.state.stackCounts[1] = e.stacks.mischief.length;
    this.state.stackCounts[2] = e.stacks.attack.length;

    e.players.forEach((p, i) => {
      const seat = this.state.seats[i];
      if (!seat) return;
      seat.lives = p.lives;
      seat.out = p.out;
      seat.stormCloud = p.stormCloud;
      seat.handCount = p.hand.length;
      seat.freezeOut = p.statuses.freezeOut;
      seat.noShop = p.statuses.noShop;
      if (!this.seatOrder[i]) {
        seat.gone = true;
        seat.sessionId = "";
      }
      this.syncHand(i, seat.hand, p.hand);
    });

    const a = e.awaiting;
    this.state.turnSeat = e.turnSeat;
    this.state.currentTurn = e.over ? "" : (this.seatOrder[e.turnSeat] ?? "");
    this.state.awaitingKind = e.over ? "" : a.kind;
    this.state.awaitingSeats.clear();
    if (!e.over) for (const s of a.seats) this.state.awaitingSeats.push(s);
    this.state.discardCount =
      a.kind === "DISCARD" && a.seats[0] !== undefined
        ? Math.max(0, e.players[a.seats[0]]!.hand.length - e.options.handLimit)
        : 0;

    const atk = a.attack;
    this.state.attackActive = !!atk && !e.over;
    if (atk) {
      this.state.attackKind = atk.kind;
      this.state.attackerSeat = atk.attackerSeat;
      this.state.attackTarget = atk.targets[atk.targetIdx] ?? 0;
      this.state.attackBlockNumber = atk.blockNumber;
      this.state.attackDamage = atk.damage;
      this.state.attackSoaker = atk.soaker;
    } else {
      this.state.attackKind = "";
      this.state.attackBlockNumber = 0;
      this.state.attackDamage = 0;
      this.state.attackSoaker = false;
    }
    this.state.pendingKind = e.pending ? e.pending.kind : "";

    this.state.suddenDeath = e.phase === "sudden-death";
    this.state.turnCount = e.turnCount;

    if (this.state.log.length !== Math.min(e.log.length, LOG_CAP) || e.log.length === 0) {
      this.state.log.clear();
      for (const line of e.log.slice(-LOG_CAP)) this.state.log.push(line);
    } else {
      const tail = e.log.slice(-LOG_CAP);
      if (tail.some((v, i) => this.state.log[i] !== v)) {
        this.state.log.clear();
        for (const line of tail) this.state.log.push(line);
      }
    }
  }

  // ---- lifecycle hooks ----------------------------------------------------

  protected override onPlayerDropped(): void {
    this.scheduleAuto(); // a disconnected awaited seat becomes auto
  }

  protected override onPlayerReconnected(player: WaterFightPlayer): void {
    if (this.state.phase === Phase.PLAYING) {
      const seat = this.engineSeatOf(player.sessionId);
      if (seat >= 0) this.regrantHand(player.sessionId, this.state.seats[seat]!.hand);
    }
    this.scheduleAuto();
  }

  protected override onPlayerLeftForGood(player: WaterFightPlayer): void {
    this.grantedHands.delete(player.sessionId);
    this.botBrains.delete(player.sessionId);
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.over) return;
    const seat = this.engineSeatOf(player.sessionId);
    if (seat >= 0) {
      this.seatOrder[seat] = ""; // vacated → ghost autopilot
      const s = this.state.seats[seat];
      if (s) {
        s.gone = true;
        s.sessionId = "";
      }
    }
    if (this.state.players.size < this.minPlayers) return; // framework ends it "abandoned"
    this.afterApply();
  }

  protected override findReclaimableSeat(): number {
    return this.seatOrder.findIndex((sid) => sid === "");
  }

  protected override reclaimSeat(seat: number, player: WaterFightPlayer): void {
    const s = this.state.seats[seat];
    if (!s) return;
    this.seatOrder[seat] = player.sessionId;
    this.frameworkSeatByEngineSeat[seat] = player.seat;
    s.sessionId = player.sessionId;
    s.nickname = player.nickname;
    s.gone = false;
    this.regrantHand(player.sessionId, s.hand);
    this.afterApply();
  }

  protected override onGameEnded(): void {
    this.autoTimer?.clear();
    this.autoTimer = undefined;
    this.state.actionDeadline = 0;
    this.state.currentTurn = "";
    this.state.awaitingKind = "";
    this.state.awaitingSeats.clear();
    this.state.attackActive = false;
  }
}
