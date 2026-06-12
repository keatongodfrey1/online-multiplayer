/**
 * Catan room - drives the ported pure engine (shared/games/catan/engine) and
 * mirrors it into the synced schema.
 *
 * Authority model: `engine` is the server-only source of truth. Clients send
 * tagged action JSON on CatanMsg.ACTION; everything is whitelist-sanitized
 * (sanitize.ts) and validated by the engine (tryReduce) before it is adopted.
 * The schema mirror (`project`) is rewritten in place after every accepted
 * action. There is no TurnManager: the engine's state machine owns the turn
 * order (setup snake, robber sub-phases, simultaneous discards, the 2-player
 * double roll), and the room mirrors the current actor(s) into the schema.
 *
 * Seats: engine seats are 0..N-1 in `seatOrder` order (players sorted by
 * framework seat at game start). `frameworkSeatByEngineSeat` is snapshotted
 * for the final "win:<seat>" mapping because the winner may have left the
 * players map by the time the game ends. A 2-human game starts the official
 * "CATAN for Two" variant: engine seats 2-3 are neutral piece sets with no
 * session at all.
 *
 * Players who leave for good mid-game (3-4p) are played out by a seeded
 * RandomPolicy ghost; 2p games end "abandoned" via the framework instead.
 */
import type { Client } from "colyseus";
import type { Delayed } from "@colyseus/timer";
import type { ArraySchema } from "@colyseus/schema";
import {
  type BasePlayer,
  CATAN,
  CATAN_NO_HOLDER,
  CatanDevCard,
  CatanEngine,
  CatanMsg,
  CatanPlayer,
  CatanResources,
  CatanSeat,
  CatanState,
  EndReason,
  Phase,
} from "@backbone/shared";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import { grantPrivateView, revokePrivateView } from "../../framework/privateState.js";
import { sanitizeAction, type BoardLimits } from "./sanitize.js";

const {
  RESOURCES,
  buildBoardGeometry,
  computeLongestRoadLength,
  createInitialGameState,
  victoryPoints,
  publicVictoryPoints,
  robberBountyResource,
  tryReduce,
  mulberry32,
  GreedyPolicy,
  RandomPolicy,
} = CatanEngine;
type Action = CatanEngine.Action;
type GameState = CatanEngine.GameState;
type Policy = CatanEngine.Policy;
type Resource = CatanEngine.Resource;
type EngineDevCard = CatanEngine.DevCard;

/** One immutable geometry shared by every room (pure, deterministic). */
const geo = buildBoardGeometry();
const LIMITS: BoardLimits = {
  hexes: geo.hexes.length,
  vertices: geo.vertices.length,
  edges: geo.edges.length,
  seats: 4,
};

const LOG_CAP = 60;
/** Backstop for pathological bot/ghost games (humans never get near this). */
const MAX_ACTIONS_PER_GAME = 10_000;

export class CatanRoom extends BaseGameRoom<CatanState> {
  state = new CatanState();
  readonly minPlayers = 2;
  readonly maxPlayers = 4;
  override supportsBots = true;

  /** Server-only engine truth (never synced). Public for white-box tests. */
  public engine!: GameState;
  /** sessionIds in engine-seat order (humans only), snapshotted at game start. */
  public seatOrder: string[] = [];
  /** Framework seat per engine seat, snapshotted at start (for win:<seat>). */
  public frameworkSeatByEngineSeat: number[] = [];
  /** Pace of bot decisions (~a second reads as "the bot took its turn"). */
  public botDelayMs = 900;

  /** Plays vacated seats (and their pending decisions). Reseeded per game. */
  private ghost: Policy = new RandomPolicy(1);
  /** Brains for seated AI players, by bot sessionId. Rebuilt per game. */
  private botBrains = new Map<string, Policy>();
  private botTimer?: Delayed;
  private seedOption?: number;
  /** The private instances each session was granted (re-granted per game). */
  private grantedPrivate = new Map<string, { hand: CatanResources; devCards: ArraySchema<CatanDevCard> }>();
  private actionsApplied = 0;

  protected createPlayer(): CatanPlayer {
    return new CatanPlayer();
  }

  protected override onRoomCreate(options: unknown): void {
    // Optional deterministic seed (tests/dev). A set seed is reused on
    // rematch, so only ever pass one when reproducibility is the point.
    const seed = (options as { seed?: unknown } | null)?.seed;
    if (typeof seed === "number" && Number.isFinite(seed)) this.seedOption = seed >>> 0;
    this.onMessage(CatanMsg.ACTION, (client, payload) => this.handleAction(client, payload));
    this.onMessage(CatanMsg.CONFIG, (client, payload) => this.handleConfig(client, payload));
  }

  /** Host adjusts the pre-game rule toggles while in the lobby. */
  private handleConfig(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const p = payload as { useTwoPlayerVariant?: unknown; robberBounty?: unknown } | null;
    if (typeof p?.useTwoPlayerVariant === "boolean") this.state.useTwoPlayerVariant = p.useTwoPlayerVariant;
    if (typeof p?.robberBounty === "boolean") this.state.robberBounty = p.robberBounty;
  }

  protected onGameStart(): void {
    // Full re-init - this also runs on rematch.
    const players = [...this.state.players.values()].sort((a, b) => a.seat - b.seat);
    this.seatOrder = players.map((p) => p.sessionId);
    this.frameworkSeatByEngineSeat = players.map((p) => p.seat);
    const seed = this.seedOption ?? Math.floor(Math.random() * 0xffffffff) >>> 0;
    const twoPlayerVariant = players.length === 2 && this.state.useTwoPlayerVariant;
    // The official "highest roll starts": a seeded-random starting seat.
    const startingPlayer = Math.floor(mulberry32(seed ^ 0x5eed1e55)() * players.length);
    this.engine = createInitialGameState(geo, {
      numPlayers: players.length,
      seed,
      numbers: "spiral",
      startingPlayer,
      twoPlayerVariant,
      robberBounty: this.state.robberBounty,
    });
    this.ghost = new RandomPolicy((seed ^ 0x9e3779b9) >>> 0);
    this.botBrains.clear();
    players.forEach((p, i) => {
      if (p.isBot) this.botBrains.set(p.sessionId, new GreedyPolicy((seed ^ ((i + 1) * 0x5bd1e995)) >>> 0));
    });
    this.actionsApplied = 0;

    // Seats mirror engine players: humans first, then neutrals in the variant.
    this.state.seats.clear();
    this.engine.players.forEach((ep, i) => {
      const seat = new CatanSeat();
      const human = players[i];
      if (human) {
        seat.sessionId = human.sessionId;
        seat.nickname = human.nickname;
      } else {
        seat.neutral = true;
        seat.nickname = `Neutral ${i === 2 ? "A" : "B"}`;
      }
      seat.color = ep.color;
      this.state.seats.push(seat);
      if (human) this.regrantPrivate(human.sessionId, seat);
    });

    // Board arrays are sized once per game, then mutated by index.
    fillArray(this.state.hexTerrain, geo.hexes.length, "");
    fillArray(this.state.hexToken, geo.hexes.length, 0);
    fillArray(this.state.vertexOwner, geo.vertices.length, -1);
    fillArray(this.state.vertexIsCity, geo.vertices.length, false);
    fillArray(this.state.edgeOwner, geo.edges.length, -1);
    fillArray(this.state.portTypes, this.engine.board.ports.length, "");
    fillArray(this.state.portVertices, this.engine.board.ports.length * 2, 0);

    this.state.log.clear();
    if (twoPlayerVariant) {
      const colorOf = (i: number) => this.engine.players[i]?.color ?? "";
      this.pushLog("Two players — official CATAN-for-Two rules: trade tokens are in play.");
      this.pushLog(
        `Neutral A (${colorOf(2)}) and Neutral B (${colorOf(3)}) start with one settlement each and never play a turn — but every road or settlement you build also places a free piece for a neutral of your choice.`,
      );
    } else if (players.length === 2) {
      this.pushLog("Two players — plain standard rules (no neutral players or trade tokens).");
    } else {
      this.pushLog("Game started.");
    }
    if (this.state.robberBounty) {
      this.pushLog("House rule on: the robber's mover may take the tile's resource from the bank instead of stealing.");
    }
    this.pushLog(`${this.nickname(this.engine.currentPlayer)} places first.`);
    this.project();
    this.maybeScheduleBot(); // a bot can hold the first setup placement
  }

  /**
   * Point a session's private view at its seat's hand + dev cards. Each game
   * builds new CatanSeat instances, so grants must be re-issued (and stale
   * ones revoked) on every onGameStart. Adding a container to a view covers
   * the items present at grant time; items added later are granted per-item
   * in syncDevCards.
   */
  private regrantPrivate(sessionId: string, seat: CatanSeat): void {
    const client = this.clients.getById(sessionId);
    if (!client) return; // disconnected right now: granted in onPlayerReconnected
    const old = this.grantedPrivate.get(sessionId);
    if (old && old.hand !== seat.hand) revokePrivateView(client, old.hand, old.devCards);
    grantPrivateView(client, seat.hand, seat.devCards);
    this.grantedPrivate.set(sessionId, { hand: seat.hand, devCards: seat.devCards });
  }

  // ---- message handling ------------------------------------------------------

  private handleAction(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.winner !== null) return;
    const senderSeat = this.seatOrder.indexOf(client.sessionId);
    if (senderSeat < 0) return;
    const action = sanitizeAction(payload, senderSeat, LIMITS);
    if (!action) return;
    // Sender authorization. The engine validates legality; this guard pins
    // WHO may even attempt the action:
    //  - discard: any seat that owes one (sanitize forced player = sender);
    //  - respondDomesticTrade: any candidate (engine checks candidacy);
    //  - everything else: only the current actor.
    if (action.type === "discard") {
      if (this.engine.pendingDiscards[senderSeat] === undefined) return;
    } else if (action.type !== "respondDomesticTrade") {
      if (senderSeat !== this.engine.currentPlayer) return;
    }
    this.applyAction(action);
  }

  /** Validate via the engine; adopt + narrate + settle when accepted. */
  private applyAction(action: Action): boolean {
    const prev = this.engine;
    const out = tryReduce(geo, prev, action);
    if (!out.ok) return false;
    this.engine = out.state;
    this.actionsApplied++;
    this.narrate(action, prev, this.engine);
    this.afterApply();
    return true;
  }

  /** Run after every accepted engine action (and after a mid-game departure). */
  private afterApply(): void {
    this.settleEngine();
    this.project();
    if (this.engine.winner !== null) {
      this.pushLog(`${this.nickname(this.engine.winner)} wins with ${victoryPoints(this.engine, this.engine.winner)} points!`);
      const frameworkSeat = this.frameworkSeatByEngineSeat[this.engine.winner];
      this.endGame(frameworkSeat !== undefined ? this.winBySeat(frameworkSeat) : EndReason.DRAW);
      return;
    }
    // Backstop: a stalled all-bot/ghost game ends for the current VP leader.
    if (this.actionsApplied > MAX_ACTIONS_PER_GAME) {
      const humanSeats = this.seatOrder.map((_, i) => i);
      const leader = humanSeats.reduce((a, b) => (victoryPoints(this.engine, b) > victoryPoints(this.engine, a) ? b : a));
      const frameworkSeat = this.frameworkSeatByEngineSeat[leader];
      this.endGame(frameworkSeat !== undefined ? this.winBySeat(frameworkSeat) : EndReason.DRAW);
      return;
    }
    this.maybeScheduleBot();
  }

  // ---- engine driving ----------------------------------------------------------

  /** A human seat whose player has left for good (never a neutral seat). */
  private isVacated(engineSeat: number): boolean {
    if (engineSeat >= this.seatOrder.length) return false; // neutral seats never act
    const sessionId = this.seatOrder[engineSeat];
    return !sessionId || !this.state.players.has(sessionId);
  }

  /** The brain for a seat: its bot policy if it is a bot, else the ghost. */
  private policyFor(engineSeat: number): Policy {
    return this.botBrains.get(this.seatOrder[engineSeat] ?? "") ?? this.ghost;
  }

  private isBotSeat(engineSeat: number): boolean {
    const sessionId = this.seatOrder[engineSeat];
    return !!sessionId && this.state.players.get(sessionId)?.isBot === true;
  }

  /** Seats that must act right now (everyone who owes during a discard). */
  private awaitingEngineSeats(): number[] {
    if (this.engine.winner !== null) return [];
    if (this.engine.phase === "discard") {
      return Object.keys(this.engine.pendingDiscards)
        .map(Number)
        .sort((a, b) => a - b);
    }
    return [this.engine.currentPlayer];
  }

  /**
   * Resolve every state no present player can act on, synchronously: vacated
   * seats are played by the ghost policy (including each vacated seat owing a
   * discard). Leaves the engine human/bot-actionable or finished. If a policy
   * ever produces an illegal action (a bug), the loop stops rather than spin.
   */
  private settleEngine(): void {
    let guard = 0;
    while (this.engine.winner === null && ++guard <= MAX_ACTIONS_PER_GAME) {
      const vacated = this.awaitingEngineSeats().filter((s) => this.isVacated(s));
      if (!vacated.length) break;
      const seat = vacated[0]!;
      const prev = this.engine;
      const out = tryReduce(geo, prev, this.policyFor(seat).act(geo, prev, seat));
      if (!out.ok) {
        console.warn(`[catan ${this.roomId}] ghost produced an illegal action for seat ${seat}: ${out.error}`);
        break;
      }
      this.engine = out.state;
      this.actionsApplied++;
    }
  }

  /**
   * If a bot must act next, schedule one decision a beat from now. Each
   * decision runs afterApply(), which calls back here - so chained decisions
   * and back-to-back bot seats each get their own visible beat.
   */
  private maybeScheduleBot(): void {
    this.botTimer?.clear();
    this.botTimer = undefined;
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.winner !== null) return;
    const nextBot = this.awaitingEngineSeats().find((s) => this.isBotSeat(s));
    if (nextBot === undefined) return;
    this.botTimer = this.clock.setTimeout(() => {
      this.botTimer = undefined;
      if (this.state.phase !== Phase.PLAYING || this.engine.winner !== null) return;
      const seat = this.awaitingEngineSeats().find((s) => this.isBotSeat(s));
      if (seat === undefined) return;
      const action = this.policyFor(seat).act(geo, this.engine, seat);
      if (!this.applyAction(action)) {
        console.warn(`[catan ${this.roomId}] bot action rejected for seat ${seat}`);
      }
    }, this.botDelayMs);
  }

  // ---- engine -> schema mirror (in place; granted instances never replaced) ----

  private project(): void {
    const e = this.engine;
    const s = this.state;
    const over = e.winner !== null;

    e.board.hexes.forEach((h, i) => {
      if (s.hexTerrain[i] !== h.terrain) s.hexTerrain[i] = h.terrain;
      const token = h.numberToken ?? 0;
      if (s.hexToken[i] !== token) s.hexToken[i] = token;
    });
    s.robberHex = e.board.robberHex;
    e.board.vertices.forEach((v, i) => {
      const owner = v.building ? v.building.owner : -1;
      const isCity = v.building?.type === "city";
      if (s.vertexOwner[i] !== owner) s.vertexOwner[i] = owner;
      if (s.vertexIsCity[i] !== isCity) s.vertexIsCity[i] = isCity;
    });
    e.board.edges.forEach((ed, i) => {
      const owner = ed.road ? ed.road.owner : -1;
      if (s.edgeOwner[i] !== owner) s.edgeOwner[i] = owner;
    });
    e.board.ports.forEach((p, i) => {
      if (s.portTypes[i] !== p.type) s.portTypes[i] = p.type;
      const [a, b] = [p.vertices[0] ?? 0, p.vertices[1] ?? p.vertices[0] ?? 0];
      if (s.portVertices[i * 2] !== a) s.portVertices[i * 2] = a;
      if (s.portVertices[i * 2 + 1] !== b) s.portVertices[i * 2 + 1] = b;
    });

    writeBag(s.bank, e.bank);
    s.devDeckCount = e.devDeck.length;

    e.players.forEach((ep, i) => {
      const seat = s.seats[i];
      if (!seat) return;
      const handCount = RESOURCES.reduce((t, r) => t + ep.hand[r], 0);
      if (seat.handCount !== handCount) seat.handCount = handCount;
      if (seat.devCardCount !== ep.devCards.length) seat.devCardCount = ep.devCards.length;
      if (seat.knightsPlayed !== ep.knightsPlayed) seat.knightsPlayed = ep.knightsPlayed;
      // While playing, hidden VP cards stay hidden; once the game is over the
      // final scores reveal them (the table moment where everyone shows cards).
      const pubVP = over ? victoryPoints(e, i) : publicVictoryPoints(e, i);
      if (seat.publicVP !== pubVP) seat.publicVP = pubVP;
      const lr = e.longestRoadHolder === i;
      const la = e.largestArmyHolder === i;
      if (seat.hasLongestRoad !== lr) seat.hasLongestRoad = lr;
      if (seat.hasLargestArmy !== la) seat.hasLargestArmy = la;
      const roadLength = computeLongestRoadLength(geo, e.board, i);
      if (seat.roadLength !== roadLength) seat.roadLength = roadLength;
      if (seat.roadsLeft !== ep.piecesLeft.roads) seat.roadsLeft = ep.piecesLeft.roads;
      if (seat.settlementsLeft !== ep.piecesLeft.settlements) seat.settlementsLeft = ep.piecesLeft.settlements;
      if (seat.citiesLeft !== ep.piecesLeft.cities) seat.citiesLeft = ep.piecesLeft.cities;
      if (seat.tradeTokens !== ep.tradeTokens) seat.tradeTokens = ep.tradeTokens;
      writeBag(seat.hand, ep.hand);
      this.syncDevCards(this.seatOrder[i], seat.devCards, ep.devCards);
      if (!seat.neutral && this.isVacated(i) && !seat.gone) {
        seat.gone = true;
        seat.sessionId = "";
      }
    });

    s.phaseDetail = over ? "gameOver" : e.phase;
    s.currentSeat = e.currentPlayer;
    const awaiting = over ? [] : this.awaitingEngineSeats();
    rewriteNumbers(s.awaitingSeats, awaiting);
    rewriteNumbers(
      s.discardOwed,
      e.phase === "discard" ? awaiting.map((seat) => this.engine.pendingDiscards[seat] ?? 0) : [],
    );
    s.currentTurn = !over && awaiting.length === 1 ? this.seatOrder[awaiting[0]!] ?? "" : "";
    s.lastSettlementVertex = e.lastSettlementVertex ?? -1;
    s.dice1 = e.dice?.[0] ?? 0;
    s.dice2 = e.dice?.[1] ?? 0;
    s.firstDice1 = e.firstDice?.[0] ?? 0;
    s.firstDice2 = e.firstDice?.[1] ?? 0;
    s.rollsThisTurn = e.rollsThisTurn;
    s.freeRoads = e.freeRoads;
    s.devCardPlayedThisTurn = e.devCardPlayedThisTurn;
    s.pendingNeutralBuilds = e.pendingNeutralBuilds;
    s.twoPlayerVariant = e.twoPlayerVariant;
    s.tokenSupply = e.tokenSupply;
    s.knightDiscardedThisTurn = e.knightDiscardedThisTurn;

    const t = e.pendingTrade;
    s.tradeOpen = t !== null;
    s.tradeProposer = t?.proposer ?? 0;
    writeBag(s.tradeGive, { ...emptyBagValues, ...(t?.give ?? {}) });
    writeBag(s.tradeReceive, { ...emptyBagValues, ...(t?.receive ?? {}) });
    rewriteNumbers(s.tradeCandidates, t?.candidates ?? []);
    rewriteNumbers(s.tradeAcceptances, t?.acceptances ?? []);

    s.longestRoadHolder = e.longestRoadHolder ?? CATAN_NO_HOLDER;
    s.largestArmyHolder = e.largestArmyHolder ?? CATAN_NO_HOLDER;
    s.turnCount = e.log.reduce((n, ev) => (ev.type === "endTurn" ? n + 1 : n), 0);
  }

  /**
   * Mirror one seat's dev cards. Every card instance pushed here must ALSO be
   * added to the owner's StateView: schema v4 keeps per-item gating for
   * default-tag @view() collections (granting the array only covers items
   * present at grant time). Card lists are small and order-stable.
   */
  private syncDevCards(
    sessionId: string | undefined,
    dst: ArraySchema<CatanDevCard>,
    src: EngineDevCard[],
  ): void {
    const same =
      dst.length === src.length &&
      src.every((c, i) => {
        const d = dst[i];
        return d?.kind === c.type && d.boughtThisTurn === c.boughtThisTurn && d.played === c.played;
      });
    if (same) return;
    dst.clear();
    const client = sessionId ? this.clients.getById(sessionId) : undefined;
    for (const c of src) {
      const card = new CatanDevCard();
      card.kind = c.type;
      card.boughtThisTurn = c.boughtThisTurn;
      card.played = c.played;
      dst.push(card);
      if (client?.view) grantPrivateView(client, card);
    }
  }

  // ---- the event feed ----------------------------------------------------------

  private nickname(engineSeat: number): string {
    return this.state.seats[engineSeat]?.nickname || `Seat ${engineSeat + 1}`;
  }

  private pushLog(line: string): void {
    this.state.log.push(line);
    while (this.state.log.length > LOG_CAP) this.state.log.shift();
  }

  /**
   * Narrate an accepted action. Privacy: steals and forced trades never name
   * the resources that moved (only the owners' private hand views know);
   * monopoly / Year of Plenty announce theirs like the physical cards do.
   */
  private narrate(action: Action, prev: GameState, next: GameState): void {
    const actorSeat = action.type === "discard" ? action.player : prev.currentPlayer;
    const who = this.nickname(actorSeat);
    switch (action.type) {
      case "placeSetupSettlement":
        this.pushLog(`${who} placed a starting settlement.`);
        break;
      case "placeSetupRoad":
        break; // pairs with the settlement; not worth a line
      case "rollDice": {
        const [d1, d2] = next.dice!;
        const sum = d1 + d2;
        if (sum === 7) {
          this.pushLog(`${who} rolled ${d1}+${d2} = 7 — robber!`);
        } else {
          const gains = this.productionSummary(prev, next);
          this.pushLog(`${who} rolled ${sum}.${gains ? ` ${gains}` : ""}`);
        }
        break;
      }
      case "discard":
        this.pushLog(`${who} discarded ${bagTotal(action.cards)} cards.`);
        break;
      case "moveRobber":
        this.pushLog(`${who} moved the robber.`);
        break;
      case "steal":
        if (action.target !== null) {
          const before = RESOURCES.reduce((t, r) => t + prev.players[action.target!]!.hand[r], 0);
          const after = RESOURCES.reduce((t, r) => t + next.players[action.target!]!.hand[r], 0);
          if (after < before) this.pushLog(`${who} stole a card from ${this.nickname(action.target)}.`);
        }
        break;
      case "robberTake":
        this.pushLog(`${who} took 1 ${robberBountyResource(prev) ?? "card"} from the bank with the robber.`);
        break;
      case "buildRoad":
        this.pushLog(`${who} built a road.`);
        break;
      case "buildSettlement":
        this.pushLog(`${who} built a settlement.`);
        break;
      case "buildCity":
        this.pushLog(`${who} upgraded to a city.`);
        break;
      case "buyDevCard":
        this.pushLog(`${who} bought a development card.`);
        break;
      case "playKnight":
        this.pushLog(`${who} played a Knight.`);
        break;
      case "playRoadBuilding":
        this.pushLog(`${who} played Road Building (2 free roads).`);
        break;
      case "playYearOfPlenty":
        this.pushLog(`${who} played Year of Plenty (${action.resources.join(", ")}).`);
        break;
      case "playMonopoly":
        this.pushLog(`${who} played Monopoly on ${action.resource}.`);
        break;
      case "maritimeTrade":
        this.pushLog(`${who} traded ${action.give} for ${action.receive} with the bank.`);
        break;
      case "proposeDomesticTrade":
        this.pushLog(`${who} offered a trade.`);
        break;
      case "respondDomesticTrade":
        break; // mirrored live in the trade panel instead
      case "confirmDomesticTrade":
        this.pushLog(`${who} traded with ${this.nickname(action.partner)}.`);
        break;
      case "cancelDomesticTrade":
        this.pushLog(`${who} withdrew the trade offer.`);
        break;
      case "endTurn":
        break;
      case "buildNeutral": {
        const neutralName = this.nickname(prev.neutralPlayerIds[action.neutralId] ?? 2);
        this.pushLog(`${who} placed a ${action.kind} for ${neutralName}.`);
        break;
      }
      case "playForcedTrade":
        this.pushLog(`${who} used a Forced Trade.`);
        break;
      case "forcedTradeGiveBack":
        break;
      case "playTokenRobber":
        this.pushLog(`${who} paid tokens to send the robber to the desert.`);
        break;
      case "discardKnightForTokens":
        this.pushLog(`${who} turned in a knight for 2 trade tokens.`);
        break;
    }
    this.narrateAwards(prev, next);
  }

  private narrateAwards(prev: GameState, next: GameState): void {
    if (prev.longestRoadHolder !== next.longestRoadHolder) {
      this.pushLog(
        next.longestRoadHolder !== null
          ? `${this.nickname(next.longestRoadHolder)} now holds Longest Road (+2).`
          : "Longest Road was set aside.",
      );
    }
    if (prev.largestArmyHolder !== next.largestArmyHolder) {
      this.pushLog(
        next.largestArmyHolder !== null
          ? `${this.nickname(next.largestArmyHolder)} now holds Largest Army (+2).`
          : "Largest Army was set aside.",
      );
    }
  }

  /** "Ann +2 ore, Ben +1 wool" - production is public information. */
  private productionSummary(prev: GameState, next: GameState): string {
    const parts: string[] = [];
    next.players.forEach((np, i) => {
      const pp = prev.players[i]!;
      const gains: string[] = [];
      for (const r of RESOURCES) {
        const d = np.hand[r] - pp.hand[r];
        if (d > 0) gains.push(`+${d} ${r}`);
      }
      if (gains.length) parts.push(`${this.nickname(i)} ${gains.join(" ")}`);
    });
    return parts.join(", ");
  }

  // ---- framework hooks -----------------------------------------------------------

  protected override onPlayerReconnected(player: BasePlayer): void {
    if (this.state.phase !== Phase.PLAYING) return;
    const idx = this.seatOrder.indexOf(player.sessionId);
    const seat = idx >= 0 ? this.state.seats[idx] : undefined;
    const client = this.clients.getById(player.sessionId);
    // Re-grant if they were disconnected when the game (re)started, or if the
    // reconnected Client came back without its StateView.
    if (seat && (!client?.view || this.grantedPrivate.get(player.sessionId)?.hand !== seat.hand)) {
      this.regrantPrivate(player.sessionId, seat);
    }
  }

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.grantedPrivate.delete(player.sessionId);
    if (this.state.phase !== Phase.PLAYING || !this.engine || this.engine.winner !== null) return;
    // With too few humans left the framework ends the game as "abandoned"
    // right after this hook - do not ghost-complete it first.
    if (this.state.players.size < this.minPlayers) return;
    const seat = this.seatOrder.indexOf(player.sessionId);
    if (seat >= 0) {
      this.pushLog(`${player.nickname} left the game — their seat plays on autopilot.`);
      // Decline their pending trade response so the proposer is not left waiting.
      const t = this.engine.pendingTrade;
      if (t && t.candidates.includes(seat)) {
        const out = tryReduce(geo, this.engine, { type: "respondDomesticTrade", player: seat, accept: false });
        if (out.ok) this.engine = out.state;
      }
    }
    this.afterApply(); // the ghost resolves anything the leaver owed
  }

  protected override onGameEnded(): void {
    this.botTimer?.clear();
    this.botTimer = undefined;
    this.state.currentTurn = "";
    this.state.awaitingSeats.clear();
    this.state.discardOwed.clear();
    this.state.phaseDetail = "gameOver";
  }
}

// ---- small pure helpers ---------------------------------------------------------

const emptyBagValues: Record<Resource, number> = { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };

function writeBag(dst: CatanResources, src: Record<Resource, number>): void {
  if (dst.lumber !== src.lumber) dst.lumber = src.lumber;
  if (dst.brick !== src.brick) dst.brick = src.brick;
  if (dst.wool !== src.wool) dst.wool = src.wool;
  if (dst.grain !== src.grain) dst.grain = src.grain;
  if (dst.ore !== src.ore) dst.ore = src.ore;
}

function bagTotal(bag: Partial<Record<Resource, number>>): number {
  return Object.values(bag).reduce((a, b) => a + (b ?? 0), 0);
}

function fillArray<T>(arr: ArraySchema<T>, length: number, value: T): void {
  arr.clear();
  for (let i = 0; i < length; i++) arr.push(value);
}

function rewriteNumbers(dst: ArraySchema<number>, src: number[]): void {
  if (dst.length === src.length && src.every((v, i) => dst[i] === v)) return;
  dst.clear();
  for (const v of src) dst.push(v);
}

export { CATAN };
