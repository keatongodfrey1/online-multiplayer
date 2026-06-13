/**
 * Space Chase - shared package. Constants + the synced schema are exported
 * flat; the pure rules engine is namespaced under SpaceChaseEngine (the
 * server drives it, clients never import the rules), mirroring Splendor.
 */
export * from "./constants.js";
export * from "./schema.js";
export * as SpaceChaseEngine from "./engine/index.js";
