// Game setup: build the initial GameState (decks, players, opening turn).

import { buildMainDeck, buildStacks, ENGINE_VERSION } from "./data.js";
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
): GameState {
  if (playerCount < 2 || playerCount > 5) throw new Error("playerCount must be 2..5");
  const opts: GameOptions = { ...DEFAULT_OPTIONS, ...(options ?? {}) };
  if (opts.splashHit + opts.splashMiss < 1) throw new Error("splash pile must have >= 1 card");
  if (opts.startingLives < 1) throw new Error("startingLives must be >= 1");

  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({
      seat: i,
      name: `Player ${i + 1}`,
      lives: opts.startingLives,
      hand: [],
      out: false,
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
    players,
    mainDeck: buildMainDeck(),
    mainDiscard: [],
    usedPile: [],
    stacks: buildStacks(),
    splashPile,
    splashDiscard: [],
    turnSeat: 0,
    supportUsed: false,
    pending: null,
    awaiting: { seats: [0], kind: "MOVE" },
    turnCount: 0,
    over: false,
    winner: null,
    endReason: null,
    log: [],
  };

  shuffleInPlace(s.mainDeck, s);
  shuffleInPlace(s.splashPile, s);
  for (const id of ["defense", "mischief", "attack"] as const) shuffleInPlace(s.stacks[id], s);
  startTurn(s, 0); // deal the opening hand for seat 0
  return s;
}
