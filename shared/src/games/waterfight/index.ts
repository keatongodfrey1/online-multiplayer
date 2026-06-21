/**
 * Water Fight — shared engine namespace + game id.
 *
 * The rules live in the pure, server-driven engine (./engine/). The Colyseus
 * schema classes + message constants (the public mirror synced to clients) are
 * added here in Phase C, mirroring shared/src/games/splendor/index.ts.
 */
export * as WaterFightEngine from "./engine/index.js";

export const WATER_FIGHT = "waterfight";
