// Game setup: build the initial GameState (decks, players, opening turn).

import { WF_STACK_IDS } from "../constants.js";
import { buildEventCards, buildMainDeck, buildStacks, ENGINE_VERSION, EVENT_KINDS, EVENT_TOTAL, mainDeckSize } from "./data.js";
import { startTurn } from "./engine.js";
import { shuffleInPlace } from "./rng.js";
import {
  DEFAULT_OPTIONS,
  GameOptions,
  GameState,
  PlayerState,
  SplashCard,
} from "./types.js";

export function createGame(
  playerCount: number,
  seed: number,
  options?: Partial<GameOptions>,
  /** Real player nicknames by seat (for log readability). Falls back to "Player N".
   *  Passed in here so names exist before the opening draw can log an Event. */
  names?: string[],
): GameState {
  if (playerCount < 2 || playerCount > 5) throw new Error("playerCount must be 2..5");
  const opts: GameOptions = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  if (opts.splashHit + opts.splashMiss < 1) throw new Error("splash pile must have >= 1 card");
  if (opts.startingLives < 1) throw new Error("startingLives must be >= 1");
  if (opts.eventDensity < 0 || opts.eventDensity > EVENT_TOTAL) throw new Error(`eventDensity must be 0..${EVENT_TOTAL}`);
  if (opts.mainHit < 0 || opts.mainMiss < 0) throw new Error("mainHit/mainMiss must be >= 0");
  if (opts.stormDraw < 0 || opts.stormThrows < 0 || opts.maxReactions < 0) throw new Error("storm/maxReactions must be >= 0");

  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      seat: i,
      name: names?.[i]?.trim() || `Player ${i + 1}`,
      lives: opts.startingLives,
      hand: [],
      out: false,
      stormCloud: false,
      statuses: { freezeOut: false, noShop: false },
    });
  }

  const splashPile: SplashCard[] = [
    ...Array.from<SplashCard>({ length: opts.splashHit }).fill("hit"),
    ...Array.from<SplashCard>({ length: opts.splashMiss }).fill("miss"),
  ];

  const s: GameState = {
    engineVersion: ENGINE_VERSION,
    seed,
    rngState: seed >>> 0,
    options: opts,
    mainIdMax: mainDeckSize(opts.mainHit, opts.mainMiss),
    players,
    mainDeck: buildMainDeck(opts.mainHit, opts.mainMiss),
    mainDiscard: [],
    usedPile: [],
    stacks: buildStacks(),
    splashPile,
    splashDiscard: [],
    phase: "playing",
    turnSeat: 0,
    supportUsed: false,
    stormThrowsUsed: 0,
    pending: null,
    pendingFlip: null,
    awaiting: { seats: [0], kind: "MOVE" },
    turnCount: 0,
    over: false,
    winner: null,
    endReason: null,
    log: [],
    lastSplash: null,
    finalBlow: null,
    reveals: [],
    events: [],
  };

  // Shuffle the main deck, then deal each NON-first player a 1-card opening
  // cushion (#6) from the still-event-free deck — so the first player draws their
  // normal 2 on turn one while everyone else starts with a card to defend with,
  // and a starting hand can never hold an Event.
  shuffleInPlace(s.mainDeck, s);
  for (let seat = 1; seat < playerCount; seat++) {
    const card = s.mainDeck.pop();
    if (card) s.players[seat]!.hand.push(card);
  }

  // Seed a random subset of the 19 Events (D3): shuffle the roster, take the
  // first `eventDensity`, and mix those event cards into the main deck.
  if (opts.eventDensity > 0) {
    const roster = [...EVENT_KINDS];
    shuffleInPlace(roster, s);
    s.mainDeck.push(...buildEventCards(roster.slice(0, opts.eventDensity)));
  }
  shuffleInPlace(s.mainDeck, s);
  shuffleInPlace(s.splashPile, s);
  for (const id of WF_STACK_IDS) shuffleInPlace(s.stacks[id], s);
  startTurn(s, 0); // the first player draws their normal 2
  return s;
}
