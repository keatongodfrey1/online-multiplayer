/**
 * Every game registers itself here with one entry.
 * The home screen's "create a game" menu is generated from this list.
 */
import { ARENA, CATAN, PERFECT_PALACE, SPACE_CHASE, SPLENDOR, TICTACTOE } from "@backbone/shared";
import type { GameDefinition } from "../framework/GameView.js";
import { ArenaView } from "./arena/ArenaView.js";
import { CatanView, renderCatanGameSummary, renderCatanLobbySettings } from "./catan/CatanView.js";
import {
  PerfectPalaceView,
  renderPerfectPalaceGameSummary,
  renderPerfectPalaceLobbySettings,
} from "./perfectpalace/PerfectPalaceView.js";
import {
  renderSpaceChaseGameSummary,
  renderSpaceChaseLobbySettings,
  SpaceChaseView,
} from "./spacechase/SpaceChaseView.js";
import {
  renderSplendorGameSummary,
  renderSplendorLobbySettings,
  SplendorView,
} from "./splendor/SplendorView.js";
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
    renderLobbySettings: renderSplendorLobbySettings,
    renderGameSummary: renderSplendorGameSummary,
  },
  {
    gameType: CATAN,
    displayName: "Catan",
    description: "2-4 players (2p = official variant)",
    createView: () => new CatanView(),
    renderLobbySettings: renderCatanLobbySettings,
    renderGameSummary: renderCatanGameSummary,
  },
  {
    gameType: SPACE_CHASE,
    displayName: "Space Chase",
    description: "2-5 players",
    createView: () => new SpaceChaseView(),
    renderLobbySettings: renderSpaceChaseLobbySettings,
    renderGameSummary: renderSpaceChaseGameSummary,
  },
  {
    gameType: PERFECT_PALACE,
    displayName: "The Perfect Palace",
    description: "A regal, Monopoly-style race to build palaces — 2–6 players.",
    createView: () => new PerfectPalaceView(),
    renderLobbySettings: renderPerfectPalaceLobbySettings,
    renderGameSummary: renderPerfectPalaceGameSummary,
  },
];

export function getGame(gameType: string): GameDefinition | undefined {
  return games.find((g) => g.gameType === gameType);
}
