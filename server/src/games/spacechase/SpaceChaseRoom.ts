/**
 * Space Chase - the authoritative game room. All dice rolls, card draws,
 * shuffles and rule decisions happen here; clients only send intent
 * messages and render synced state.
 *
 * Turn flow (no TurnManager: Space Chase has extra turns - the same
 * player goes again - and multi-step card prompts, so the room owns the
 * rotation, like SplendorRoom):
 *
 *   startTurn -> (skip if lostTurns) -> awaiting ACTION
 *     ROLL -> moveBy -> afterResolution
 *     DRAW -> resolveCard -> (Stage 3: may open a prompt) -> afterResolution
 *   afterResolution -> collisions -> win check / tiebreaker -> advanceTurn
 *   advanceTurn -> extraTurns (same seat) | next live seat
 *                  (roundNumber++ when the rotation wraps - shields are
 *                   round-based, so extra turns never age a shield)
 *
 * STAGED BUILD - implemented so far: rotation/rounds, dice, the cards
 * that resolve without a prompt (movement, move-all, rover, teleports,
 * extra turns, lose turns), collisions, win + tiebreaker, rematch.
 * Cards that need a prompt (attacks, Kraken, Shooting Star, 6-7, Black
 * Hole, Worm Hole), Shield/Suit/Time Loop/Rocket/Satellite, the turn
 * timer, and bot play land in later stages (see PR #14); until then
 * those draws are a no-op that still spends the turn.
 */
import type { Client } from "colyseus";
import {
  type BasePlayer,
  type CardDef,
  getCard,
  isValidSpaceChaseTurnSeconds,
  Phase,
  ScAwait,
  ScEvent,
  type ScConfigPayload,
  SC_EVENT_LOG_MAX,
  SC_FINISH,
  SC_START,
  SpaceChaseEvent,
  SpaceChaseMsg,
  SpaceChasePlayer,
  SpaceChaseSeat,
  SpaceChaseState,
} from "@backbone/shared";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import {
  buildDeck,
  moveBy,
  mulberry32,
  scanCollisions,
  shuffle,
  teleportTo,
  type MoveStep,
} from "./engine.js";

/** Rover (#8): everyone else forward 5, the drawer forward 7. */
const ROVER_OTHERS = 5;
const ROVER_SELF = 7;

export class SpaceChaseRoom extends BaseGameRoom<SpaceChaseState> {
  state = new SpaceChaseState();
  readonly minPlayers = 2;
  readonly maxPlayers = 5;
  // supportsBots is flipped on in the bots stage - seating a bot before
  // the room can play its turns would stall the game on its ACTION.

  // ---- server-only truth (never synced). Public members are the
  // white-box test seams (Splendor precedent). ----
  /** Card ids; the TOP of the pile is the LAST element (draw = pop). */
  public deck: number[] = [];
  public discard: number[] = [];
  /** Tests push die values here; rollDie() consumes them before the RNG. */
  public forcedRolls: number[] = [];

  private rng: () => number = mulberry32(0);
  /** Optional deterministic seed from room options (reused on rematch). */
  private seedOption?: number;
  /** seats[] index of the acting player (mirrors state.currentSeat). */
  private turnIndex = 0;
  /**
   * Framework seat per seats[] index, snapshotted at game start: the
   * winner's players-map entry may be gone by the time the game ends.
   */
  private frameworkSeatBySeatIndex: number[] = [];
  /** Monotonic for the room's lifetime so a client can never see it rewind. */
  private eventSeq = 0;

  protected createPlayer(): SpaceChasePlayer {
    return new SpaceChasePlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    // Optional deterministic shuffle/dice seed (tests/dev). A set seed is
    // reused on rematch, so only pass one when reproducibility is the point.
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;

    this.onMessage(SpaceChaseMsg.ROLL, (client) => this.handleRoll(client));
    this.onMessage(SpaceChaseMsg.DRAW, (client) => this.handleDraw(client));
    this.onMessage(SpaceChaseMsg.CONFIG, (client, payload) => this.handleConfig(client, payload));
  }

  protected onGameStart(): void {
    const seed = this.seedOption ?? Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.rng = mulberry32(seed);
    this.deck = buildDeck(this.rng);
    this.discard = [];
    this.state.deckCount = this.deck.length;
    this.state.discardCount = 0;
    this.state.lastCardId = 0;
    this.state.roundNumber = 0;
    this.state.events.clear();
    this.state.turnDeadline = 0;
    this.clearPrompt();

    // Seat order = framework seat order; seat 0 (the host) goes first.
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    this.frameworkSeatBySeatIndex = players.map((p) => p.seat);
    this.state.seats.clear();
    for (const p of players) {
      const seat = new SpaceChaseSeat();
      seat.sessionId = p.sessionId;
      seat.nickname = p.nickname;
      this.state.seats.push(seat);
    }

    this.turnIndex = 0;
    this.startTurn();
  }

  // ---- turn machine -------------------------------------------------------

  private startTurn(): void {
    const seat = this.state.seats[this.turnIndex]!;
    // The portal re-entry guard protects only the move that exited; it
    // lifts when the owner's next turn begins.
    seat.justExitedPortal = 0;

    if (seat.lostTurns > 0) {
      seat.lostTurns--;
      this.pushEvent(ScEvent.SKIP_TURN, this.turnIndex, seat.lostTurns, 0,
        `${seat.nickname} loses a turn (${seat.lostTurns} more to go)`);
      this.advanceTurn();
      return;
    }

    this.state.currentSeat = this.turnIndex;
    this.state.currentTurn = seat.sessionId;
    this.clearPrompt();
    this.state.awaitingType = ScAwait.ACTION;
    this.state.promptSeat = this.turnIndex;
  }

  private advanceTurn(): void {
    if (this.state.phase !== Phase.PLAYING) return;
    const cur = this.state.seats[this.turnIndex]!;
    if (!cur.gone && cur.extraTurns > 0) {
      cur.extraTurns--;
      this.pushEvent(ScEvent.EXTRA_TURNS, this.turnIndex, cur.extraTurns, 0,
        `${cur.nickname} goes again!`);
      this.startTurn();
      return;
    }
    const prev = this.turnIndex;
    this.turnIndex = this.nextLiveIndex(this.turnIndex);
    // Wrapping back to (or past) the front of the order = one full
    // go-around of the table. Round-based shields expire off this count.
    if (this.turnIndex <= prev) this.state.roundNumber++;
    this.startTurn();
  }

  private nextLiveIndex(from: number): number {
    const n = this.state.seats.length;
    for (let k = 1; k <= n; k++) {
      const idx = (from + k) % n;
      if (!this.state.seats[idx]!.gone) return idx;
    }
    return from;
  }

  private clearPrompt(): void {
    this.state.awaitingType = "";
    this.state.promptSeat = 0;
    this.state.promptCardId = 0;
    this.state.promptContext = "";
    this.state.promptMult = 1;
    this.state.promptCount = 0;
    this.state.promptTargetSeat = -1;
  }

  /** Guards shared by every in-game action from the current player. */
  private actingSeat(client: Client, awaiting: string): SpaceChaseSeat | undefined {
    if (this.state.phase !== Phase.PLAYING) return undefined;
    if (this.state.awaitingType !== awaiting) return undefined;
    if (client.sessionId !== this.state.currentTurn) return undefined;
    return this.state.seats[this.turnIndex];
  }

  // ---- actions ------------------------------------------------------------

  private handleRoll(client: Client): void {
    const seat = this.actingSeat(client, ScAwait.ACTION);
    if (!seat) return;
    this.state.awaitingType = "";

    const mult = this.consumeSuit(seat, this.turnIndex);
    const die = this.rollDie();
    const amount = die * mult;
    // Time Loop replays the amount actually moved - doubled if it was.
    seat.lastActionType = "dice";
    seat.lastActionValue = amount;
    this.pushEvent(ScEvent.ROLL, this.turnIndex, die, amount,
      `${seat.nickname} rolls a ${die}${mult > 1 ? ` - doubled to ${amount} by the Space Suit!` : ""}`);
    this.applySteps(this.turnIndex, moveBy(seat, amount));
    this.afterResolution();
  }

  private handleDraw(client: Client): void {
    const seat = this.actingSeat(client, ScAwait.ACTION);
    if (!seat) return;
    this.state.awaitingType = "";

    const card = this.drawCard();
    const mult = this.consumeSuit(seat, this.turnIndex);
    // Time Loop must read the action BEFORE it, so it never overwrites.
    if (card.type !== "timeLoop") {
      seat.lastActionType = "card";
      seat.lastActionValue = card.id;
    }
    this.pushEvent(ScEvent.DRAW, this.turnIndex, 0, card.id,
      `${seat.nickname} draws ${card.name}`);
    this.resolveCard(card, this.turnIndex, mult);
  }

  private handleConfig(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const turnSeconds = (payload as Partial<ScConfigPayload> | null)?.turnSeconds;
    if (!isValidSpaceChaseTurnSeconds(turnSeconds)) return;
    this.state.turnSeconds = turnSeconds;
  }

  // ---- card resolution ----------------------------------------------------

  private drawCard(): CardDef {
    if (this.deck.length === 0) {
      this.deck = shuffle(this.discard, this.rng);
      this.discard = [];
      this.pushEvent(ScEvent.RESHUFFLE, -1, 0, 0, "The deck is reshuffled!");
    }
    const id = this.deck.pop()!;
    this.discard.push(id);
    this.state.deckCount = this.deck.length;
    this.state.discardCount = this.discard.length;
    this.state.lastCardId = id;
    return getCard(id)!;
  }

  /**
   * Apply a drawn card. Every branch ends in afterResolution() - a card
   * with no useful effect still spends the turn (no redraw, no refund).
   */
  private resolveCard(card: CardDef, i: number, mult: number): void {
    const seat = this.state.seats[i]!;
    switch (card.type) {
      case "moveForward":
        this.applySteps(i, moveBy(seat, card.amount! * mult));
        break;

      case "moveBack":
        if (this.isShielded(seat)) {
          this.shieldBlock(i, card);
        } else {
          this.applySteps(i, moveBy(seat, -card.amount! * mult));
        }
        break;

      case "moveAll":
        // Suit doubles ONLY the wearer's movement; everyone else base.
        this.forEachLiveSeat((j, other) => {
          this.applySteps(j, moveBy(other, card.amount! * (j === i ? mult : 1)));
        });
        break;

      case "moveAllBack":
        this.forEachLiveSeat((j, other) => {
          if (this.isShielded(other)) {
            this.shieldBlock(j, card);
          } else {
            this.applySteps(j, moveBy(other, -card.amount! * (j === i ? mult : 1)));
          }
        });
        break;

      case "rover":
        this.forEachLiveSeat((j, other) => {
          if (j === i) return;
          this.applySteps(j, moveBy(other, ROVER_OTHERS));
        });
        this.applySteps(i, moveBy(seat, ROVER_SELF * mult));
        break;

      case "teleport":
        // Time Bomb (-> START) is a negative effect, so a shield blocks
        // it even self-drawn (GAME_RULES §6 lists send-to-START).
        // Landmark teleports are "go to" cards, never shield-blocked.
        if (card.destination === SC_START && this.isShielded(seat)) {
          this.shieldBlock(i, card);
        } else {
          this.applySteps(i, teleportTo(seat, card.destination!));
        }
        break;

      case "extraTurns":
        seat.extraTurns += card.amount! * mult;
        this.pushEvent(ScEvent.EXTRA_TURNS, i, seat.extraTurns, 0,
          `${seat.nickname} will take ${card.amount! * mult} extra turn(s)!`);
        break;

      case "loseTurns":
        if (this.isShielded(seat)) {
          this.shieldBlock(i, card);
        } else {
          seat.lostTurns += card.amount! * mult;
          this.pushEvent(ScEvent.LOSE_TURNS, i, seat.lostTurns, 0,
            `${seat.nickname} loses ${card.amount! * mult} turn(s)!`);
        }
        break;

      default:
        // STAGE 3 PLACEHOLDER: attack / spaceKraken / shootingStar /
        // sixSeven / timeLoop / rocketJump / shield / spaceSuit /
        // satellite. Until those land, the draw fizzles (turn spent).
        this.pushEvent(ScEvent.NOOP, i, 0, card.id, `${card.name} fizzles... nothing happens`);
        break;
    }
    this.afterResolution();
  }

  private forEachLiveSeat(fn: (index: number, seat: SpaceChaseSeat) => void): void {
    this.state.seats.forEach((seat, index) => {
      if (!seat.gone) fn(index, seat);
    });
  }

  private isShielded(seat: SpaceChaseSeat): boolean {
    // Round-based: blocks UNLIMITED hits until the table has gone around
    // SC_SHIELD_ROUNDS times. Never decremented, never doubled.
    return seat.shieldExpiresRound > 0 && this.state.roundNumber < seat.shieldExpiresRound;
  }

  private shieldBlock(i: number, card: CardDef): void {
    const seat = this.state.seats[i]!;
    this.pushEvent(ScEvent.SHIELD_BLOCK, i, 0, card.id,
      `${seat.nickname}'s Shield blocks ${card.name}!`);
  }

  /** The Space Suit is consumed by the very next card or roll, no matter what. */
  private consumeSuit(seat: SpaceChaseSeat, i: number): number {
    if (!seat.spaceSuit) return 1;
    seat.spaceSuit = false;
    return 2;
  }

  private rollDie(): number {
    return this.forcedRolls.shift() ?? 1 + Math.floor(this.rng() * 6);
  }

  // ---- resolution epilogue ------------------------------------------------

  private afterResolution(): void {
    if (this.state.phase !== Phase.PLAYING) return;

    // Collisions: 2+ rockets sharing a board space ALL go back to START,
    // no matter how they got there. One scan after movement fully
    // resolves (so move-all cards collide once, not mid-resolution).
    for (const group of scanCollisions([...this.state.seats])) {
      const names = group.map((j) => this.state.seats[j]!.nickname).join(" and ");
      const space = this.state.seats[group[0]!]!.position;
      for (const j of group) {
        const seat = this.state.seats[j]!;
        seat.position = SC_START;
        seat.justExitedPortal = 0;
      }
      this.pushEvent(ScEvent.COLLISION, -1, space, 0,
        `${names} collide on space ${space} - everyone back to START!`);
    }

    // Finishers: land on or pass the Finish. A rocket inside a portal
    // can never finish - its position is frozen at the entry mouth.
    const finishers: number[] = [];
    this.forEachLiveSeat((j, seat) => {
      if (seat.portalId === 0 && seat.position >= SC_FINISH) finishers.push(j);
    });
    if (finishers.length === 1) {
      this.win(finishers[0]!);
      return;
    }
    if (finishers.length > 1) {
      this.runTiebreaker(finishers);
      return;
    }

    this.advanceTurn();
  }

  private win(i: number): void {
    const seat = this.state.seats[i]!;
    this.pushEvent(ScEvent.WIN, i, seat.position, 0, `${seat.nickname} reaches the Finish and WINS!`);
    this.endGame(this.winBySeat(this.frameworkSeatBySeatIndex[i]!));
  }

  /**
   * Several rockets crossed the Finish on the same turn: dice roll-off,
   * highest wins, re-roll among those still tied. The server rolls -
   * there is no decision to make, so no prompts.
   */
  private runTiebreaker(finishers: number[]): void {
    this.pushEvent(ScEvent.TIEBREAK_START, -1, 0, 0,
      "Photo finish! The tied players roll off - highest roll wins!");
    let contenders = finishers;
    for (let round = 0; round < 50; round++) {
      const rolls = contenders.map(() => this.rollDie());
      contenders.forEach((j, k) => {
        this.pushEvent(ScEvent.TIEBREAK_ROLL, j, rolls[k]!, 0,
          `${this.state.seats[j]!.nickname} rolls a ${rolls[k]}`);
      });
      const top = Math.max(...rolls);
      const winners = contenders.filter((_, k) => rolls[k] === top);
      if (winners.length === 1) {
        this.win(winners[0]!);
        return;
      }
      contenders = winners;
      this.pushEvent(ScEvent.TIEBREAK_START, -1, 0, 0, "Still tied - roll again!");
    }
    this.win(contenders[0]!); // unreachable safety stop
  }

  // ---- events -------------------------------------------------------------

  /** Translate engine movement steps into synced events. */
  private applySteps(i: number, steps: MoveStep[]): void {
    const name = this.state.seats[i]!.nickname;
    for (const step of steps) {
      switch (step.kind) {
        case "move":
          this.pushEvent(ScEvent.MOVE, i, step.from, step.to,
            `${name} ${step.to > step.from ? "moves forward" : "goes back"} to ${spaceName(step.to)}`);
          break;
        case "teleport":
          this.pushEvent(ScEvent.TELEPORT, i, step.from, step.to,
            step.to === SC_START
              ? `${name} is sent back to START!`
              : `${name} teleports to ${spaceName(step.to)}!`);
          break;
        case "enterPortal":
          this.pushEvent(ScEvent.ENTER_PORTAL, i, step.portalId, step.mouth,
            `${name} is pulled into the portal at space ${step.mouth}!`);
          break;
        case "portalMove":
          this.pushEvent(ScEvent.PORTAL_MOVE, i, step.from, step.to,
            `${name} travels through the portal`);
          break;
        case "exitPortal":
          this.pushEvent(ScEvent.EXIT_PORTAL, i, step.portalId, step.mouth,
            `${name} exits the portal at space ${step.mouth}`);
          break;
      }
    }
  }

  private pushEvent(kind: string, seat: number, a: number, b: number, text: string): void {
    const event = new SpaceChaseEvent();
    event.seq = ++this.eventSeq;
    event.kind = kind;
    event.seat = seat;
    event.a = a;
    event.b = b;
    event.text = text;
    this.state.events.push(event);
    while (this.state.events.length > SC_EVENT_LOG_MAX) this.state.events.shift();
  }

  // ---- lifecycle hooks ----------------------------------------------------

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    const i = this.state.seats.findIndex((s) => s.sessionId === player.sessionId);
    if (i < 0) return; // left before the first game started
    const seat = this.state.seats[i]!;
    seat.gone = true;
    if (this.state.phase !== Phase.PLAYING) return;
    // Rocket leaves the board entirely.
    seat.position = SC_START;
    seat.portalId = 0;
    seat.portalProgress = 0;
    if (this.state.currentTurn === player.sessionId) {
      // Their (only possible) pending decision was the roll/draw choice;
      // nothing to auto-answer yet, just move on.
      this.advanceTurn();
    }
  }

  protected override onGameEnded(): void {
    this.state.currentTurn = "";
    this.state.turnDeadline = 0;
    this.clearPrompt();
    // Seats and events stay in place - the game-over summary reads them.
  }
}

function spaceName(space: number): string {
  if (space === SC_START) return "START";
  if (space >= SC_FINISH) return "the Finish";
  return `space ${space}`;
}
