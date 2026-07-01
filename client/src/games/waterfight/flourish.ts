/**
 * Pure, DOM-free flourish logic — extracted from WaterFightView so it can be unit-tested.
 * Imports ONLY shared constants (no framework, no DOM, no timers), so a plain mocha+tsx test
 * can exercise the priority pick, tone, and content mapping without a browser.
 */
// Import from the pure constants sub-path (NOT the "@backbone/shared" barrel) so this
// module — and its mocha+tsx unit test — never load the Colyseus schema classes in
// state.ts, whose decorators only compile under a tsconfig that includes ../shared/src.
import {
  CARD_INFO,
  EVENT_DESCRIPTIONS,
  EVENT_EMOJI,
  EVENT_NAMES,
  EVENT_TONE,
  type FlourishTone,
  SUPPORT_TONE,
} from "@backbone/shared/games/waterfight/constants";

/** Per-reduce headline priority — one flourish per reduce shows the highest-priority event,
 *  so a multi-target moment (Flash Flood: attack + N damage) collapses to one summary. */
export const EVENT_PRIORITY: Record<string, number> = {
  suddendeath: 9, event: 8, attack: 7, turn: 6, defend: 6, save: 5, soak: 5,
  support: 4, react: 4, shop: 4, draw: 3, heal: 2, damage: 1,
};
/** Kinds that get a centered explanatory flourish. `turn` is excluded — the banner +
 *  `wf-pulse` already announce whose turn it is, and a flourish every turn is spam. */
export const FLOURISH_KINDS = new Set(Object.keys(EVENT_PRIORITY).filter((k) => k !== "turn"));

/** Flourish timing (owner-chosen, mockup-confirmed): held ~2.6s total so a player can read
 *  the effect line — ~3× the old toast. */
export const FLOURISH_IN_MS = 260;
export const FLOURISH_HOLD_MS = 1900;
export const FLOURISH_OUT_MS = 420;
/** Total time one flourish occupies the host (pop-in + hold + fade) — paces the queue and
 *  matches the `wf-flourish-anim` keyframe duration. */
export const FLOURISH_TOTAL_MS = FLOURISH_IN_MS + FLOURISH_HOLD_MS + FLOURISH_OUT_MS;
/** Each flourish is ~2.6s, so under bot pacing (≈700ms/action) the queue would back up;
 *  cap it and drop the oldest so flourishes track the newest, current moments. */
export const FLOURISH_QUEUE_MAX = 3;

// Labels + one-line descriptions come from the shared CARD_INFO table (single source of truth
// — the hand tiles, tap-to-review modal, and ❓ Help all read it).
export const cardLabel = (kind: string): string => CARD_INFO[kind as keyof typeof CARD_INFO]?.label ?? kind;
export const cardDesc = (kind: string): string => CARD_INFO[kind as keyof typeof CARD_INFO]?.desc ?? "";
export const cardEmoji = (kind: string): string => cardLabel(kind).split(" ")[0] ?? "🃏";
export const cardName = (kind: string): string => cardLabel(kind).split(" ").slice(1).join(" ") || kind;

/** Color band for a flourish — color REINFORCES the word (meaning never rests on color alone,
 *  since every flourish also carries an emoji + a word). Harmful supports/events read red,
 *  helpful ones green, utility/neutral blue, Sudden-Death yellow. */
export const flourishTone = (kind: string, detailKind: string): FlourishTone => {
  if (kind === "damage" || kind === "soak") return "danger";
  if (kind === "save" || kind === "heal" || kind === "defend") return "ok";
  if (kind === "suddendeath") return "warn";
  if (kind === "event") return EVENT_TONE[detailKind as keyof typeof EVENT_TONE] ?? "accent";
  if (kind === "support") return SUPPORT_TONE[detailKind as keyof typeof SUPPORT_TONE] ?? "accent";
  return "accent";
};

export type FlourishEvent = { kind: string; text: string; detailKind: string };

/** Build the explanatory flourish content: a NAME + one-line effect when we know the specific
 *  public card/event (detailKind), else the event's generic public text. The caller escapes
 *  every dynamic field (text/name/desc) — nicknames are user-controlled. */
export const flourishContent = (
  ev: FlourishEvent,
): { emoji: string; name: string; desc: string } | { line: string } => {
  const dk = ev.detailKind;
  if (dk) {
    if (ev.kind === "event" && EVENT_NAMES[dk as keyof typeof EVENT_NAMES]) {
      const emoji = EVENT_EMOJI[dk as keyof typeof EVENT_EMOJI] ?? "🎲"; // themed per-event, all 19
      return {
        emoji,
        name: EVENT_NAMES[dk as keyof typeof EVENT_NAMES],
        desc: EVENT_DESCRIPTIONS[dk as keyof typeof EVENT_DESCRIPTIONS] ?? "",
      };
    }
    if (CARD_INFO[dk as keyof typeof CARD_INFO]) {
      return { emoji: cardEmoji(dk), name: cardName(dk), desc: cardDesc(dk) };
    }
  }
  return { line: ev.text };
};

/** Pick the ONE flourish for a per-reduce batch: the highest-priority flourish-worthy event
 *  (`turn` excluded, empty text skipped). Returns null when the batch has nothing to show.
 *  Returns a plain SNAPSHOT (not the batch element) — the caller queues it for ~2.6s, and the
 *  batch elements are live Colyseus schema instances that a later sync can mutate/recycle. */
export const pickFlourish = (batch: FlourishEvent[]): FlourishEvent | null => {
  let best: FlourishEvent | undefined;
  for (const e of batch) {
    if (!FLOURISH_KINDS.has(e.kind)) continue;
    if (!best || (EVENT_PRIORITY[e.kind] ?? 0) > (EVENT_PRIORITY[best.kind] ?? 0)) best = e;
  }
  return best && best.text ? { kind: best.kind, text: best.text, detailKind: best.detailKind } : null;
};
