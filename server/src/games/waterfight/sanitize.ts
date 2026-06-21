/**
 * Whitelist sanitizers: rebuild a clean engine Move / Resolution from untrusted
 * client JSON. We never trust the client object — we read named fields, validate
 * each against the allowed set, and construct a fresh value (or return null).
 * The engine then validates LEGALITY; this layer only guarantees a well-typed
 * value so applyMove/applyResolution can't be fed garbage.
 */
import type { WaterFightEngine as WF } from "@backbone/shared";

type Move = WF.Move;
type Resolution = WF.Resolution;
type Spread = WF.Spread;

const STACK_IDS = ["defense", "mischief", "attack"] as const;
const BIG_KINDS = ["mega", "giant", "golden"] as const;
const SPREAD_MODS = ["triplesplash", "splashzone"] as const;
const SUPPORTS = [
  "firstaid", "backpack", "goggles", "needle", "pickpocket", "sabotage",
  "cardswap", "freezeout", "hiddenstash", "lemonadespill", "sneakypeek", "switcheroo",
] as const;
const DEFENSES = ["miss", "umbrella", "wild_miss", "pass"] as const;
const RESPONDS = ["hit", "wild_hit", "pass"] as const;
const REACT_ACTIONS = ["pass", "towel", "redirect", "watertrap"] as const;
const EXTRA_ACTIONS = ["throw", "pass"] as const;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function isSeat(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 8;
}
function inSet<T extends readonly string[]>(set: T, x: unknown): x is T[number] {
  return typeof x === "string" && (set as readonly string[]).includes(x);
}
function isCount(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 50;
}

function parseSpread(x: unknown): Spread | undefined {
  if (!isObj(x)) return undefined;
  if (!inSet(SPREAD_MODS, x.modifier)) return undefined;
  const extra = Array.isArray(x.extraTargets) ? x.extraTargets.filter(isSeat).slice(0, 4) : [];
  return { modifier: x.modifier, extraTargets: extra };
}

export function parseMove(payload: unknown): Move | null {
  if (!isObj(payload)) return null;
  switch (payload.kind) {
    case "END_TURN":
      return { kind: "END_TURN" };
    case "STORM_THROW":
      return { kind: "STORM_THROW" };
    case "PLAY_SUPPORT": {
      if (!inSet(SUPPORTS, payload.support)) return null;
      const move: Move = { kind: "PLAY_SUPPORT", support: payload.support };
      if (isSeat(payload.target)) move.target = payload.target;
      return move;
    }
    case "THROW": {
      if (!isSeat(payload.target)) return null;
      const move: Move = { kind: "THROW", target: payload.target };
      if (payload.soaker === true) move.soaker = true;
      const spread = parseSpread(payload.spread);
      if (spread) move.spread = spread;
      return move;
    }
    case "PLAY_BIG": {
      if (!inSet(BIG_KINDS, payload.big) || !isSeat(payload.target)) return null;
      const move: Move = { kind: "PLAY_BIG", big: payload.big, target: payload.target };
      if (payload.soaker === true) move.soaker = true;
      const spread = parseSpread(payload.spread);
      if (spread) move.spread = spread;
      return move;
    }
    case "SHOP": {
      const sell = isObj(payload.sell) ? payload.sell : {};
      const balloons = isCount(sell.balloons) ? sell.balloons : 0;
      const treasures = isCount(sell.treasures) ? sell.treasures : 0;
      const wild = isCount(sell.wild) ? sell.wild : 0;
      const buy = Array.isArray(payload.buy) ? payload.buy.filter((b) => inSet(STACK_IDS, b)).slice(0, 4) : [];
      return { kind: "SHOP", sell: { balloons, treasures, wild }, buy: buy as WF.StackId[] };
    }
    default:
      return null;
  }
}

export function parseResolution(payload: unknown): Resolution | null {
  if (!isObj(payload)) return null;
  switch (payload.kind) {
    case "REACT": {
      if (!inSet(REACT_ACTIONS, payload.action)) return null;
      const res: Resolution = { kind: "REACT", action: payload.action };
      if (isSeat(payload.target)) res.target = payload.target;
      return res;
    }
    case "DEFEND":
      return inSet(DEFENSES, payload.defense) ? { kind: "DEFEND", defense: payload.defense } : null;
    case "ATTACKER_RESPOND":
      return inSet(RESPONDS, payload.respond) ? { kind: "ATTACKER_RESPOND", respond: payload.respond } : null;
    case "EXTRA": {
      if (!inSet(EXTRA_ACTIONS, payload.action)) return null;
      const res: Resolution = { kind: "EXTRA", action: payload.action };
      if (isSeat(payload.target)) res.target = payload.target;
      if (payload.soaker === true) res.soaker = true;
      return res;
    }
    case "DISCARD": {
      if (!Array.isArray(payload.cardIds)) return null;
      const cardIds = payload.cardIds.filter((id) => typeof id === "number" && Number.isInteger(id)).slice(0, 50);
      return { kind: "DISCARD", cardIds };
    }
    default:
      return null;
  }
}
