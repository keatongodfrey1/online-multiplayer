// Shared tuning constants used by BOTH the server engine and the client view.
// Kept OUT of engine/ (and free of engine imports) so the view can import these
// without pulling the whole server-only engine into the client bundle. The
// engine imports these from `../constants.js`; the schema index re-exports them.

// Type-only imports erase at runtime, so constants.ts stays engine-free.
import type { CardKind, EventKind, StackId } from "./engine/types.js";

/** Coins earned by selling each kind at the shop (D4 economy). */
export const COIN_VALUES = { balloon: 1, treasure: 2, wild: 5 } as const;

/** The three shop stacks in canonical order. This single tuple drives the engine
 *  iteration order, the schema's stackCounts[] indices, the sanitizer whitelist,
 *  and the client's buy buttons — so reordering is a one-line change. */
export const WF_STACK_IDS = ["defense", "mischief", "attack"] as const;

/** Player-facing info for EVERY card kind: an emoji+name label, a one-line
 *  beginner description, and (for shop cards) which stack it comes from. The
 *  single source of truth for the hand tiles, the tap-to-review modal, and the
 *  ❓ Help card legend — so the three surfaces can never drift. Typed as a full
 *  `Record<CardKind, …>`, so adding a card kind without a description fails
 *  `npm run typecheck`. `stack` is omitted for main-deck cards (incl. `event`). */
export interface CardInfo {
  label: string;
  desc: string;
  stack?: StackId;
}
export const CARD_INFO: Record<CardKind, CardInfo> = {
  // ---- main deck (no stack) ----
  balloon: { label: "💧 Balloon", desc: "Your basic attack — throw it to splash an opponent." },
  miss: { label: "🛡 Miss", desc: "Block one incoming balloon." },
  hit: { label: "💥 Hit", desc: "Push your attack through an opponent's block." },
  treasure: { label: "💎 Treasure", desc: "Worth coins when you sell it at the shop." },
  wild: { label: "🃏 Wild", desc: "Counts as a Miss or a Hit — whichever you need." },
  event: { label: "🎲 Event", desc: "A surprise that resolves the moment you draw it (a soak, a heal, free cards, or a dud)." },
  // ---- 🛡 Defense Depot ----
  umbrella: { label: "☂️ Umbrella", desc: "Fully blocks a normal balloon throw.", stack: "defense" },
  backpack: { label: "🎒 Backpack", desc: "Draw 2 cards right now.", stack: "defense" },
  firstaid: { label: "➕ First Aid", desc: "Heal 1 life (up to your starting lives).", stack: "defense" },
  towel: { label: "🧻 Towel", desc: "Cancel an attack or support card aimed at you.", stack: "defense" },
  goggles: { label: "🥽 Goggles", desc: "Peek at the top 3 cards of the draw pile.", stack: "defense" },
  needle: { label: "📌 Needle", desc: "An opponent discards all of their balloons.", stack: "defense" },
  lifeguard: { label: "🛟 Lifeguard", desc: "Auto-saves you once: when you'd be soaked, bounce back to 1 life.", stack: "defense" },
  // ---- 😈 Mischief Market ----
  pickpocket: { label: "🫳 Pickpocket", desc: "Steal a Treasure from an opponent's hand.", stack: "mischief" },
  sabotage: { label: "💣 Sabotage", desc: "An opponent discards 2 random cards.", stack: "mischief" },
  cardswap: { label: "🔄 Card Swap", desc: "Randomly trade up to 2 cards with an opponent.", stack: "mischief" },
  freezeout: { label: "❄️ Freeze Out", desc: "An opponent draws only 1 card next turn instead of 2.", stack: "mischief" },
  hiddenstash: { label: "📦 Hidden Stash", desc: "Pull up to 2 Treasures from the discard pile into your hand.", stack: "mischief" },
  redirect: { label: "↪️ Redirect", desc: "Send an incoming attack at a different player.", stack: "mischief" },
  lemonadespill: { label: "🍋 Lemonade Spill", desc: "An opponent discards 1 card and can't shop next turn.", stack: "mischief" },
  sneakypeek: { label: "👀 Sneaky Peek", desc: "Secretly look at an opponent's whole hand.", stack: "mischief" },
  watertrap: { label: "🪤 Water Trap", desc: "Bounce an attack back at whoever threw it.", stack: "mischief" },
  switcheroo: { label: "🌀 Switcheroo", desc: "Swap your entire hand with an opponent's.", stack: "mischief" },
  // ---- 🌊 Attack Arsenal ----
  mega: { label: "🌊 Mega", desc: "Big attack — needs 2 blocks to stop, and skips the splash draw.", stack: "attack" },
  launcher: { label: "🔫 Launcher", desc: "After your attack, take an extra basic throw.", stack: "attack" },
  triplesplash: { label: "💦 Triple Splash", desc: "Throw at up to 3 opponents at once.", stack: "attack" },
  golden: { label: "🏆 Golden", desc: "Big attack that draws you 2 cards, hit or miss.", stack: "attack" },
  rapidfire: { label: "⚡ Rapid Fire", desc: "After your attack, take an extra basic throw.", stack: "attack" },
  splashzone: { label: "🌐 Splash Zone", desc: "Throw at every opponent at once.", stack: "attack" },
  giant: { label: "🗿 Giant", desc: "Big attack — deals 2 damage, needs 1 block to stop.", stack: "attack" },
  soaker: { label: "🚿 Soaker", desc: "Add to a throw so the target's Miss blocks don't count.", stack: "attack" },
  flashflood: { label: "🌧 Flash Flood", desc: "Soak every opponent for 2 (each can block once).", stack: "attack" },
};

/** Friendly labels for the EventKinds that can be a finishing blow (they deal
 *  damage via `damageSeat`). The other 12 events never soak anyone, so they can
 *  never be a `finalBlow.means` — omitting them keeps the save whitelist tight.
 *  The end-of-game reveal maps a `finalBlow.means` of one of these to its label. */
export const EVENT_LABELS: Partial<Record<EventKind, string>> = {
  mudslide: "🌊 Mudslide",
  stormsurge: "🌊 Storm Surge",
  heatwave: "☀️ Heatwave",
  downpour: "🌧️ Downpour",
  tidalwave: "🌊 Tidal Wave",
  lightning: "⚡ Lightning",
  targetedstorm: "⚡ Targeted Storm",
};
