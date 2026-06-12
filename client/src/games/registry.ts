/**
 * Every game registers itself here with one entry.
 * The home screen's "create a game" menu is generated from this list.
 */
import { ARENA, SPLENDOR, TICTACTOE } from "@backbone/shared";
import type { GameDefinition } from "../framework/GameView.js";
import { ArenaView } from "./arena/ArenaView.js";
import { SplendorView } from "./splendor/SplendorView.js";
import { TicTacToeView } from "./tictactoe/TicTacToeView.js";

export const games: GameDefinition[] = [
  {
    gameType: TICTACTOE,
    displayName: "Tic-Tac-Toe",
    description: "2 players",
    createView: () => new TicTacToeView(),
  },
  {
    gameType: ARENA,
    displayName: "Dot Arena",
    description: "2-8 players, real-time",
    createView: () => new ArenaView(),
  },
  {
    gameType: SPLENDOR,
    displayName: "Splendor",
    description: "2-4 players",
    createView: () => new SplendorView(),
  },
];

export function getGame(gameType: string): GameDefinition | undefined {
  return games.find((g) => g.gameType === gameType);
}
