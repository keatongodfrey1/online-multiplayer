// Shared tuning constants used by BOTH the server engine and the client view.
// Kept OUT of engine/ (and free of engine imports) so the view can import these
// without pulling the whole server-only engine into the client bundle. The
// engine imports these from `../constants.js`; the schema index re-exports them.

/** Coins earned by selling each kind at the shop (D4 economy). */
export const COIN_VALUES = { balloon: 1, treasure: 2, wild: 5 } as const;

/** The three shop stacks in canonical order. This single tuple drives the engine
 *  iteration order, the schema's stackCounts[] indices, the sanitizer whitelist,
 *  and the client's buy buttons — so reordering is a one-line change. */
export const WF_STACK_IDS = ["defense", "mischief", "attack"] as const;
