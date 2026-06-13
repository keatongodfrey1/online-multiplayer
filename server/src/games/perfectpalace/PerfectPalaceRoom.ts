/**
 * The Perfect Palace room — drives the ported pure engine
 * (shared/games/perfectpalace/engine) and mirrors it into the synced schema.
 *
 * Authority model: `engine` is the server-only source of truth. Clients send
 * tagged action JSON on PerfectPalaceMsg.ACTION; everything is whitelist-
 * sanitized (sanitize.ts — id/targetId bound to the sender, dice dropped), gated
 * by an isLegalSender phase check, then validated by the engine (tryReduce)
 * before it is adopted. The schema mirror (syncFromEngine) is rewritten in place
 * after every accepted action. All randomness is server-owned: die values come
 * from the engine's seeded PRNG, never from a client.
 *
 * Seats: engine players are array indices 0..N-1 in `seatOrder` order (players
 * sorted by framework seat at game start; engine id `p${i+1}`).
 * `frameworkSeatByEngineSeat` is snapshotted for the final "win:<seat>" mapping
 * because the winner may have left the players map by the time the game ends.
 *
 * No bots and no autopilot in v1: a player who leaves for good has any pending
 * decision auto-resolved with a safe default, then is removed via the engine's
 * system/removePlayer (Bailiff returns to the middle, turn advances, the game
 * auto-ends at <=1 player). The framework ends a <minPlayers game "abandoned".
 */
import { type Client } from "colyseus";
import {
  type BasePlayer,
  EndReason,
  PERFECT_PALACE,
  PERFECT_PALACE_COLORS,
  PerfectPalaceEngine,
  PerfectPalaceMsg,
  PerfectPalacePlayer,
  PerfectPalaceState,
  Phase,
  PPDuel,
  PPDuelStake,
  PPInventory,
  PPResourceSlot,
  PPSeat,
} from "@backbone/shared";
import { ArraySchema } from "@colyseus/schema";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import { sanitizeAction } from "./sanitize.js";
import { parseSave, serializeSave, type ParsedSave, type SaveSeat } from "./save.js";

const { createReadyState, tryReduce, rollDieFrom, getSquare, rankPlayers, totalPoints, staffWeight } =
  PerfectPalaceEngine;
type GameState = PerfectPalaceEngine.GameState;
type GameAction = PerfectPalaceEngine.GameAction;
type EngineInventory = PerfectPalaceEngine.PlayerInventory;

const LOG_CAP = 60;
/** Backstop for a pathological auto-advance loop (humans never approach this). */
const MAX_ACTIONS_PER_GAME = 100_000;

export class PerfectPalaceRoom extends BaseGameRoom<PerfectPalaceState> {
  state = new PerfectPalaceState();
  readonly minPlayers = 2;
  readonly maxPlayers = 6;
  override supportsSaves = true;
  // supportsBots / allowLateJoin / supportsReclaim stay false (defaults).

  /** Server-only engine truth (never synced). Public for white-box tests. */
  public engine!: GameState;
  /** sessionId per engine seat index ("" once a seat is vacated). */
  public seatOrder: string[] = [];
  /** Framework seat per engine seat, snapshotted at start (for win:<seat>). */
  public frameworkSeatByEngineSeat: number[] = [];
  /** sessionId -> engine id (`p1`..`pN`), rebuilt at game start. */
  private engineIdBySession = new Map<string, string>();
  private seedOption?: number;
  private actionsApplied = 0;

  protected createPlayer(): PerfectPalacePlayer {
    return new PerfectPalacePlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    // Optional deterministic seed (tests/dev); reused on rematch.
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;
    this.onMessage(PerfectPalaceMsg.ACTION, (client, payload) => this.handleAction(client, payload));
  }

  // ---- save/resume hooks (framework owns the orchestration) ----------------

  protected override isGameOver(): boolean {
    return !this.engine || this.engine.phase === "game-over";
  }

  protected override loadedSaveTurnLabel(parsed: unknown): number {
    return (parsed as ParsedSave).turnCount + 1;
  }

  protected override parseSave(raw: unknown): ParsedSave | null {
    return parseSave(raw);
  }

  protected override serializeSave(): object | null {
    return this.buildSave();
  }

  /** Current game -> save blob. Public for white-box tests. */
  public buildSave(): object {
    const seats: SaveSeat[] = this.seatOrder.map((sessionId, i) => ({
      nickname: this.state.seats[i]?.nickname ?? `Seat ${i + 1}`,
      isBot: false,
      gone: !sessionId,
    }));
    // turnCount label = the furthest-along base turn (equal-turns accounting).
    const turnCount = this.engine.players.reduce((m, p) => Math.max(m, p.baseTurnsTaken), 0);
    return serializeSave({ engine: this.engine, seats, turnCount });
  }

  // ---- game start ----------------------------------------------------------

  protected onGameStart(): void {
    // Full re-init (also runs on rematch). A staged saved game is consumed here
    // and cleared, so a later rematch starts fresh.
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    const load = this.pendingLoad?.payload as ParsedSave | undefined;
    this.pendingLoad = undefined;
    this.state.loadedSave = "";
    const seed = this.seedOption ?? Math.floor(Math.random() * 0xffffffff) >>> 0;

    if (load) {
      this.engine = load.engine;
      // Match saved seats to present players by nickname; a gone seat stays "".
      this.seatOrder = load.seats.map((s) => {
        if (s.gone) return "";
        const match = players.find((p) => p.nickname.toLowerCase() === s.nickname.toLowerCase());
        return match?.sessionId ?? "";
      });
      this.engine.log = [`Game resumed (turn ${load.turnCount + 1}).`];
    } else {
      this.engine = createReadyState(
        players.map((p) => ({ name: p.nickname })),
        seed,
      );
      // createReadyState builds engine.players in seat order: players[i] <-> p${i+1}.
      this.seatOrder = players.map((p) => p.sessionId);
    }
    this.frameworkSeatByEngineSeat = this.seatOrder.map((sid) =>
      sid ? players.find((p) => p.sessionId === sid)?.seat ?? -1 : -1,
    );
    this.engineIdBySession.clear();
    this.engine.players.forEach((ep, i) => {
      const sid = this.seatOrder[i];
      if (sid) this.engineIdBySession.set(sid, ep.id);
    });
    this.actionsApplied = 0;

    // Seats mirror engine players (rebuilt every game; the view never persists).
    this.state.seats.clear();
    this.engine.players.forEach((ep, i) => {
      const seat = new PPSeat();
      seat.engineId = ep.id;
      seat.sessionId = this.seatOrder[i] ?? "";
      seat.nickname = ep.name;
      seat.colorIndex = ep.colorIndex % PERFECT_PALACE_COLORS.length;
      this.state.seats.push(seat);
    });

    this.syncFromEngine();
  }

  // ---- message handling ----------------------------------------------------

  private handleAction(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.phase === "game-over") return;
    const senderId = this.engineIdBySession.get(client.sessionId);
    if (!senderId) return;
    const action = sanitizeAction(payload, senderId);
    if (!action) return;
    if (!this.isLegalSender(action, senderId)) return;
    this.applyClientAction(action, senderId);
  }

  /**
   * Pin WHO may attempt each action, off the engine phase. The engine still
   * validates the move's legality; this stops a forged sender entirely.
   */
  private isLegalSender(action: GameAction, senderId: string): boolean {
    const e = this.engine;
    const tp = e.turn.phase;
    switch (action.type) {
      case "mapping/setInitial": {
        if (e.phase !== "initial-mapping") return false;
        return e.players.find((p) => p.id === senderId)?.mappingLocked !== true;
      }
      case "mapping/changeOneSlot":
        // Own card; the engine gates phase + lap credits.
        return true;
      case "turn/duelSetStake":
        // The arriver (current player) sets the stake.
        return tp === "duel" && senderId === e.currentPlayerId;
      case "turn/duelRollForPlayer":
        return tp === "duel" && !!e.duel?.contenders.includes(senderId) && e.duel.rolls[senderId] == null;
      default:
        // Everything else is the current player's action.
        return senderId === e.currentPlayerId;
    }
  }

  /** Client action: inject a server-owned die for the value-taking duel roll,
   *  then dispatch through the engine. */
  private applyClientAction(action: GameAction, senderId: string): void {
    if (action.type === "turn/duelRollForPlayer") {
      const { value, rngState } = rollDieFrom(this.engine);
      this.engine = { ...this.engine, rngState };
      this.dispatch({ type: "turn/duelRollForPlayer", id: senderId, value });
      return;
    }
    this.dispatch(action);
  }

  /** Validate via the engine; adopt + funnel when accepted. */
  private dispatch(action: GameAction): boolean {
    const out = tryReduce(this.engine, action);
    if (!out.ok) return false;
    this.engine = out.state;
    this.actionsApplied++;
    this.afterApply();
    return true;
  }

  /** Single funnel after every accepted action and roster change. */
  private afterApply(): void {
    this.autoAdvance();
    this.syncFromEngine();
    if (this.engine.phase === "game-over") this.finishGame();
  }

  /**
   * Drive the two server-side transitions the hotseat UI used buttons for:
   *  - reveal all resource cards once every active player has locked their pick;
   *  - resolve a duel once every contender has rolled (tie re-rounds clear the
   *    rolls, so the loop re-checks and stops to wait for the re-rolls).
   * Loops because one transition can enable the next; never recurses afterApply.
   */
  private autoAdvance(): void {
    let guard = 0;
    while (++guard <= 1000) {
      const e = this.engine;
      if (e.phase === "game-over") return;
      if (e.phase === "initial-mapping") {
        const active = e.players.filter((p) => !p.removed);
        if (active.length > 0 && active.every((p) => p.mappingLocked)) {
          const out = tryReduce(e, { type: "mapping/revealAll" });
          if (out.ok) {
            this.engine = out.state;
            this.actionsApplied++;
            continue;
          }
        }
        return;
      }
      if (e.turn.phase === "duel" && e.duel) {
        const d = e.duel;
        if (d.contenders.length > 0 && d.contenders.every((id) => d.rolls[id] != null)) {
          const out = tryReduce(e, { type: "turn/duelResolve" });
          if (out.ok) {
            this.engine = out.state;
            this.actionsApplied++;
            continue;
          }
        }
        return;
      }
      return;
    }
  }

  private finishGame(): void {
    const winnerId = this.computeWinnerId();
    this.state.winnerId = winnerId;
    const engineSeat = this.engine.players.findIndex((p) => p.id === winnerId);
    const fwSeat = engineSeat >= 0 ? this.frameworkSeatByEngineSeat[engineSeat] : undefined;
    this.endGame(fwSeat !== undefined && fwSeat >= 0 ? this.winBySeat(fwSeat) : EndReason.DRAW);
  }

  /** Winner = top of the staff-weighted tiebreaker (points -> staff -> cash). */
  private computeWinnerId(): string {
    const entries = this.engine.players
      .filter((p) => !p.removed)
      .map((p) => ({
        id: p.id,
        name: p.name,
        points: totalPoints(p.inventory),
        staff: staffWeight(p.inventory),
        cash: p.inventory.dollars,
      }));
    if (!entries.length) return "";
    return rankPlayers(entries)[0]?.id ?? "";
  }

  // ---- engine -> schema mirror (in place) ----------------------------------

  private syncFromEngine(): void {
    const e = this.engine;
    const s = this.state;
    const over = e.phase === "game-over";
    // The initial pick is hidden: cards are only published once revealed.
    const cardsRevealed = e.phase !== "initial-mapping" && e.phase !== "initial-roll" && e.phase !== "setup";

    e.players.forEach((ep, i) => {
      const seat = s.seats[i];
      if (!seat) return;
      const sid = this.seatOrder[i] ?? "";
      set(seat, "sessionId", sid);
      set(seat, "nickname", ep.name);
      set(seat, "colorIndex", ep.colorIndex % PERFECT_PALACE_COLORS.length);
      set(seat, "position", ep.position);
      writeInventory(seat.inventory, ep.inventory);
      set(seat, "inDungeon", ep.dungeon.inDungeon);
      set(seat, "dungeonTurnsServed", ep.dungeon.turnsServed);
      set(seat, "mappingLocked", ep.mappingLocked === true);
      set(seat, "baseTurnsTaken", ep.baseTurnsTaken);
      set(seat, "removed", ep.removed);
      set(seat, "gone", !sid || ep.removed);
      set(seat, "mappingChangesAvailable", ep.mappingChangesAvailable);
      set(seat, "workerPreference", ep.workerPreference);
      if (cardsRevealed) writeResourceCard(seat.resourceCard, ep.resourceCard);
      else if (seat.resourceCard.length) seat.resourceCard.clear();
    });

    set(s, "enginePhase", e.phase);
    set(s, "turnPhase", e.turn.phase);
    set(s, "currentPlayerId", e.currentPlayerId ?? "");
    rewriteStrings(s.turnOrder, e.turnOrder);
    set(s, "activePlayerIndex", e.turn.activePlayerIndex);
    set(s, "lastRoll", e.turn.lastRoll ?? 0);
    set(s, "extraTurnsQueued", e.turn.extraTurnsQueued);
    set(s, "bailiffStealUsed", e.turn.bailiffStealUsedThisTurnSequence);
    set(s, "acquiredBailiffThisTurn", e.turn.acquiredBailiffThisTurn);
    set(s, "enteredDungeonThisTurn", e.turn.enteredDungeonThisTurn);
    set(s, "skipOptionalActions", e.turn.skipOptionalActions);
    set(s, "traderUsedThisTurn", e.turn.traderUsedThisTurn);

    const fine = e.turn.pendingFine;
    set(s, "finePending", !!fine);
    set(s, "fineAmount", fine?.amount ?? 0);
    set(s, "fineSource", fine?.source ?? "");

    const d = e.duel;
    set(s, "duelActive", !!d && e.turn.phase === "duel");
    if (d) {
      set(s.duel, "squareNumber", d.squareNumber);
      rewriteStrings(s.duel.participants, d.participants);
      rewriteStrings(s.duel.contenders, d.contenders);
      writeStake(s.duel.stake, d.stake);
      const rollIds = Object.keys(d.rolls);
      rewriteStrings(s.duel.rollPlayers, rollIds);
      rewriteNumbers(s.duel.rollValues, rollIds.map((id) => d.rolls[id] ?? 0));
      set(s.duel, "winner", d.winner ?? "");
    } else {
      clearDuel(s.duel);
    }

    set(s, "bailiffKind", e.bailiff.kind);
    set(s, "bailiffBy", e.bailiff.kind === "held" ? e.bailiff.by : "");
    set(s, "deckCount", e.deck.length);
    set(s, "discardCount", e.discard.length);

    set(s, "winnerId", over ? this.computeWinnerId() : "");
    set(s, "palaceBuiltBy", e.palaceBuiltBy ?? "");
    set(s, "palaceTriggerTurnIndex", e.palaceTriggerTurnIndex ?? -1);

    rewriteStrings(s.log, e.log.slice(-LOG_CAP));
    set(s, "currentTurn", this.singleActorSession());
  }

  /** sessionId of the sole actor, or "" during multi-actor phases / game over. */
  private singleActorSession(): string {
    const e = this.engine;
    if (e.phase === "game-over" || e.phase === "initial-mapping" || e.turn.phase === "duel") return "";
    const idx = e.players.findIndex((p) => p.id === e.currentPlayerId);
    return idx >= 0 ? this.seatOrder[idx] ?? "" : "";
  }

  // ---- departures ----------------------------------------------------------

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    const engineId = this.engineIdBySession.get(player.sessionId);
    this.engineIdBySession.delete(player.sessionId);
    const idx = this.seatOrder.indexOf(player.sessionId);
    if (idx >= 0) this.seatOrder[idx] = ""; // mark the seat vacated

    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.phase === "game-over") return;
    // With too few humans left the framework ends the game "abandoned" right
    // after this hook — just reflect the vacated seat, don't remove from engine.
    if (this.state.players.size < this.minPlayers) {
      this.syncFromEngine();
      return;
    }
    if (!engineId) return;
    // Auto-resolve anything the leaver owed (safe defaults), then remove them.
    this.autoResolvePendingFor(engineId);
    // (auto-resolution may itself have ended the game, e.g. an endTurn that
    //  completed the palace-win tally — re-read the phase as a plain string.)
    const phaseAfter: string = this.engine.phase;
    if (phaseAfter !== "game-over") this.dispatch({ type: "system/removePlayer", id: engineId });
  }

  /**
   * Clear any pause the leaving player is blocking, with a safe default, so the
   * table never stalls. Duels are fully resolved with seeded rolls (dice are
   * server-owned, so auto-rolling the remaining contenders is fair) to avoid a
   * dangling duel surviving the removal.
   */
  private autoResolvePendingFor(engineId: string): void {
    const e = this.engine;
    const tp = e.turn.phase;
    if (tp === "duel" && e.duel) {
      this.resolveDuelFully();
      return;
    }
    if (e.currentPlayerId !== engineId) return; // only the active player can block
    switch (tp) {
      case "pre-move-bailiff":
        this.dispatch({ type: "turn/bailiffStealPreMoveSkip" });
        break;
      case "post-roll-bailiff":
        this.dispatch({ type: "turn/bailiffStealPostRollSkip" });
        break;
      case "square-effect": {
        if (e.turn.pendingFine) {
          this.dispatch({ type: "turn/payFine", bricks: 0, sticks: 0, walls: 0, roofs: 0 });
          break;
        }
        const me = e.players.find((p) => p.id === engineId);
        const sq = me ? getSquare(me.position) : undefined;
        if (sq?.effect.kind === "bricks-or-wall") this.dispatch({ type: "turn/gift10Bricks" });
        else this.dispatch({ type: "turn/declineAlliance" });
        break;
      }
      default:
        break; // turn-start/rolling/optional-actions: removePlayer handles it
    }
  }

  /** Roll (seeded) for every contender who hasn't, until the duel clears. */
  private resolveDuelFully(): void {
    let guard = 0;
    while (this.engine.duel && this.engine.turn.phase === "duel" && ++guard <= 100) {
      const d = this.engine.duel;
      const next = d.contenders.find((id) => d.rolls[id] == null);
      if (next === undefined) break; // all rolled; autoAdvance will resolve
      const { value, rngState } = rollDieFrom(this.engine);
      this.engine = { ...this.engine, rngState };
      this.dispatch({ type: "turn/duelRollForPlayer", id: next, value });
    }
  }

  protected override onGameEnded(): void {
    this.state.currentTurn = "";
    this.state.duelActive = false;
  }
}

// ---- small pure helpers ----------------------------------------------------

/** Assign only when changed (minimises schema patches / network churn). */
function set<T, K extends keyof T>(obj: T, key: K, value: T[K]): void {
  if (obj[key] !== value) obj[key] = value;
}

function writeInventory(dst: PPInventory, src: EngineInventory): void {
  set(dst, "bricks", src.bricks);
  set(dst, "sticks", src.sticks);
  set(dst, "dollars", src.dollars);
  set(dst, "walls", src.walls);
  set(dst, "roofs", src.roofs);
  set(dst, "rooms", src.rooms);
  set(dst, "buildings", src.buildings);
  set(dst, "threeStoryBuildings", src.threeStoryBuildings);
  set(dst, "palaces", src.palaces);
  set(dst, "workers", src.workers);
  set(dst, "servers", src.servers);
  set(dst, "chefs", src.chefs);
  set(dst, "cleaners", src.cleaners);
  set(dst, "wholeHouseCleaners", src.wholeHouseCleaners);
  set(dst, "queen", src.queen);
  set(dst, "knight", src.knight);
  set(dst, "allied", src.allied);
  set(dst, "pardonCards", src.pardonCards);
}

function writeStake(dst: PPDuelStake, src: PerfectPalaceEngine.DuelStake): void {
  set(dst, "dollars", src.dollars);
  set(dst, "bricks", src.bricks);
  set(dst, "sticks", src.sticks);
  set(dst, "walls", src.walls);
  set(dst, "roofs", src.roofs);
  set(dst, "rooms", src.rooms);
}

function writeResourceCard(dst: ArraySchema<PPResourceSlot>, src: PerfectPalaceEngine.ResourceCard): void {
  // Order-stable, length 6; only rebuild when the contents actually differ.
  const same =
    dst.length === src.length &&
    src.every((o, i) => {
      const d = dst[i];
      const amount = o.kind === "draw-card" ? 0 : o.amount;
      return d?.kind === o.kind && d.amount === amount;
    });
  if (same) return;
  dst.clear();
  for (const o of src) {
    const slot = new PPResourceSlot();
    slot.kind = o.kind;
    slot.amount = o.kind === "draw-card" ? 0 : o.amount;
    dst.push(slot);
  }
}

function clearDuel(d: PPDuel): void {
  if (d.squareNumber !== 0) d.squareNumber = 0;
  if (d.participants.length) d.participants.clear();
  if (d.contenders.length) d.contenders.clear();
  if (d.rollPlayers.length) d.rollPlayers.clear();
  if (d.rollValues.length) d.rollValues.clear();
  if (d.winner !== "") d.winner = "";
  writeStake(d.stake, { dollars: 0, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 });
}

function rewriteStrings(dst: ArraySchema<string>, src: readonly string[]): void {
  if (dst.length === src.length && src.every((v, i) => dst[i] === v)) return;
  dst.clear();
  for (const v of src) dst.push(v);
}

function rewriteNumbers(dst: ArraySchema<number>, src: readonly number[]): void {
  if (dst.length === src.length && src.every((v, i) => dst[i] === v)) return;
  dst.clear();
  for (const v of src) dst.push(v);
}

export { PERFECT_PALACE };
