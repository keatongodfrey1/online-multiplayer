// The Perfect Palace — public surface for the shared package.
//
// This file grows in two stages: (1) the pure engine namespace + the game's
// identity/message constants (no Colyseus), and (2) the Colyseus schema mirror
// (PerfectPalaceState etc.) that the room rewrites from the engine each turn.

/** Lobby/registry gameType id. */
export const PERFECT_PALACE = "perfectpalace";

/** Client → server message names. The only game message is a sanitized action. */
export const PerfectPalaceMsg = {
  ACTION: "perfectpalace/action",
} as const;

// The pure, Colyseus-free rules engine (server-only source of truth).
export * as PerfectPalaceEngine from "./engine/index.js";
