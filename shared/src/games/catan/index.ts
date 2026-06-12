/**
 * Catan — schema (synced state), message names, and the rules engine.
 *
 * The engine is namespaced (like SplendorEngine) because its domain names
 * (Phase, GameState, GameView, ...) collide with the framework's.
 */
export const CATAN = "catan";

export * as CatanEngine from "./engine/index.js";
