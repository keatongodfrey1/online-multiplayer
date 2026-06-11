/**
 * Every game registers itself here with one entry.
 * The home screen's "create a game" menu is generated from this list.
 */
import { TICTACTOE } from "@backbone/shared";
import type { GameDefinition } from "../framework/GameView.js";
import { TicTacToeView } from "./tictactoe/TicTacToeView.js";

export const games: GameDefinition[] = [
  {
    gameType: TICTACTOE,
    displayName: "Tic-Tac-Toe",
    description: "2 players",
    createView: () => new TicTacToeView(),
  },
];

export function getGame(gameType: string): GameDefinition | undefined {
  return games.find((g) => g.gameType === gameType);
}
