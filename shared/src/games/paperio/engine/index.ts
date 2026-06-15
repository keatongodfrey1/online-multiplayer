/**
 * Paper.io pure rules engine. Server-only source of truth; the client never
 * imports it. Namespaced as PaperIoEngine from the shared package.
 */
export * from "./types.js";
export * from "./constants.js";
export { mulberry32 } from "./rng.js";
export { PaperIoWorld } from "./world.js";
