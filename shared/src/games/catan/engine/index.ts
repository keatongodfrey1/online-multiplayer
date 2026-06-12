// Ported from catan-clone/catan-engine/src (a pure, deterministic Catan rules
// engine; rules reference: catan-clone/catan_clone_spec.md). Mechanical
// changes for this repo: ESM .js import extensions and non-null assertions
// for noUncheckedIndexedAccess. Functional additions, each documented at its
// definition: spiral number placement (the official A-R variable setup), the
// startingPlayer option, and the "CATAN for Two" official 2-player variant.
// Do NOT change ported behavior here without carrying the engine tests along
// (server/test/catanEngine.test.ts).
//
// FUTURE WORK (deliberately out of scope for now): 5-6 player games. The
// engine already runs 3-6 players and the special building phase (dormant —
// the room caps at 4 players), but the official 5-6 player experience also
// needs the bigger 30-hex retail board layout, its port positions, two more
// piece colors, and UI for the special build window.
export * from "./types.js";
export * from "./geometry.js";
export * from "./stateMachine.js";
export * from "./policies.js";
