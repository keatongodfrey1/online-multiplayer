// Whitelist sanitizer for client-sent Perfect Palace actions.
//
// Every accepted message is rebuilt FROM SCRATCH from a fixed whitelist — the
// client's object is never adopted. Two invariants matter for authority:
//   1. Player-addressed actions have their `id` forced to the SENDER's engine id
//      (you can never act as someone else).
//   2. Dice values are never read from the client (the room injects server-owned
//      rolls). turn/rollDie carries no value; turn/duelRollForPlayer's value is
//      added by the room, not here.
// Room-internal actions (setup/*, initialRoll/*, system/*, mapping/revealAll,
// turn/duelResolve, turn/rollDieWithValue, turn/advancePhase) are NOT accepted
// from clients and fall through to null.

import { PerfectPalaceEngine } from "@backbone/shared";

type GameAction = PerfectPalaceEngine.GameAction;
type ShopItem = PerfectPalaceEngine.ShopItem;
type BuildItem = PerfectPalaceEngine.BuildItem;

const SHOP_ITEMS: readonly ShopItem[] = ["brick", "stick", "worker", "server", "chef", "cleaner", "queen", "knight"];
const BUILD_ITEMS: readonly BuildItem[] = ["wall", "roof", "room", "building", "threeStoryBuilding", "palace"];
const BAILIFF_ITEMS = ["wall", "roof", "bricks", "sticks", "dollars"] as const;
type BailiffItem = (typeof BAILIFF_ITEMS)[number];
const RESOURCE_KINDS = ["sticks", "bricks", "dollars", "draw-card"] as const;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function inEnum<T extends string>(v: unknown, set: readonly T[]): v is T {
  return typeof v === "string" && (set as readonly string[]).includes(v);
}

/** Parse a 6-face resource card from untrusted input (the engine re-checks the
 *  one-to-one permutation rule via isValidResourceCard). */
function parseCard(v: unknown): PerfectPalaceEngine.ResourceCard | null {
  if (!Array.isArray(v) || v.length !== 6) return null;
  const out: PerfectPalaceEngine.ResourceOutcome[] = [];
  for (const slot of v) {
    if (!isObj(slot) || !inEnum(slot.kind, RESOURCE_KINDS)) return null;
    if (slot.kind === "draw-card") {
      out.push({ kind: "draw-card" });
    } else {
      if (!isNonNegInt(slot.amount)) return null;
      out.push({ kind: slot.kind, amount: slot.amount });
    }
  }
  return out as unknown as PerfectPalaceEngine.ResourceCard;
}

/**
 * Rebuild a legal engine action from a client payload, or null to reject.
 * `senderId` is the sender's engine player id (`p1`..`pN`); it is forced onto
 * every player-addressed action.
 */
export function sanitizeAction(payload: unknown, senderId: string): GameAction | null {
  if (!isObj(payload) || typeof payload.type !== "string") return null;
  const p = payload;
  switch (p.type) {
    // ---- initial mapping (own card only) ----
    case "mapping/setInitial": {
      const card = parseCard(p.card);
      return card ? { type: "mapping/setInitial", id: senderId, card } : null;
    }
    case "mapping/changeOneSlot": {
      if (!isNonNegInt(p.slotIndex) || p.slotIndex > 5) return null;
      if (!isNonNegInt(p.option) || p.option > 5) return null;
      return { type: "mapping/changeOneSlot", id: senderId, slotIndex: p.slotIndex, option: p.option };
    }

    // ---- opening turn-order roll (no client value; the room injects it) ----
    case "initialRoll/roll":
      return { type: "initialRoll/roll" };

    // ---- rolling (no client value; the room/engine roll the die) ----
    case "turn/rollDie":
      return { type: "turn/rollDie" };

    // ---- Bailiff steal (targetId is an opponent; engine validates target) ----
    case "turn/bailiffStealPreRoll":
    case "turn/bailiffStealPreMove":
    case "turn/bailiffStealPostRoll": {
      if (typeof p.targetId !== "string" || p.targetId.length === 0) return null;
      if (!inEnum<BailiffItem>(p.item, BAILIFF_ITEMS)) return null;
      return { type: p.type, targetId: p.targetId, item: p.item };
    }
    case "turn/bailiffStealSkip":
    case "turn/bailiffStealPreMoveSkip":
    case "turn/bailiffStealPostRollSkip":
      return { type: p.type };

    // ---- square-effect decisions ----
    case "turn/acceptAlliance":
    case "turn/declineAlliance":
    case "turn/gift10Bricks":
    case "turn/gift1Wall":
      return { type: p.type };

    // ---- duel ----
    case "turn/duelSetStake": {
      const st = p.stake;
      if (!isObj(st)) return null;
      const f = (k: string) => (isNonNegInt(st[k]) ? (st[k] as number) : null);
      const dollars = f("dollars"), bricks = f("bricks"), sticks = f("sticks");
      const walls = f("walls"), roofs = f("roofs"), rooms = f("rooms");
      if ([dollars, bricks, sticks, walls, roofs, rooms].some((x) => x === null)) return null;
      return {
        type: "turn/duelSetStake",
        stake: { dollars: dollars!, bricks: bricks!, sticks: sticks!, walls: walls!, roofs: roofs!, rooms: rooms! },
      };
    }
    case "turn/duelRollForPlayer":
      // Own roll only; value is injected by the room from the seeded PRNG.
      return { type: "turn/duelRollForPlayer", id: senderId, value: 0 };
    case "turn/duelCancel":
      // No-contest: only the arriver, only before stakes are set (engine re-checks).
      return { type: "turn/duelCancel" };

    // ---- fine payment ----
    case "turn/payFine": {
      if (!isNonNegInt(p.bricks) || !isNonNegInt(p.sticks) || !isNonNegInt(p.walls) || !isNonNegInt(p.roofs)) return null;
      return { type: "turn/payFine", bricks: p.bricks, sticks: p.sticks, walls: p.walls, roofs: p.roofs };
    }

    // ---- optional actions ----
    case "turn/buy": {
      if (!inEnum<ShopItem>(p.item, SHOP_ITEMS)) return null;
      if (p.quantity !== undefined && !isNonNegInt(p.quantity)) return null;
      return { type: "turn/buy", item: p.item, quantity: p.quantity as number | undefined };
    }
    case "turn/trade": {
      if (!inEnum(p.from, ["bricks", "sticks"] as const)) return null;
      if (!isNonNegInt(p.amount)) return null;
      return { type: "turn/trade", from: p.from, amount: p.amount };
    }
    case "turn/traderWallsBuy":
      return isNonNegInt(p.batches) ? { type: "turn/traderWallsBuy", batches: p.batches } : null;
    case "turn/traderBricksSell":
      return isNonNegInt(p.batches) ? { type: "turn/traderBricksSell", batches: p.batches } : null;
    case "turn/halfPriceCleanerBuy":
      return isNonNegInt(p.count) ? { type: "turn/halfPriceCleanerBuy", count: p.count } : null;
    case "turn/build": {
      if (!inEnum<BuildItem>(p.item, BUILD_ITEMS)) return null;
      if (!isNonNegInt(p.count)) return null;
      return { type: "turn/build", item: p.item, count: p.count };
    }
    case "turn/buildFromScratch": {
      if (!inEnum<BuildItem>(p.item, BUILD_ITEMS)) return null;
      if (!isNonNegInt(p.count)) return null;
      return { type: "turn/buildFromScratch", item: p.item, count: p.count };
    }
    case "turn/setWorkerPreference":
      return inEnum(p.preference, ["wall-roof", "wall-wall"] as const)
        ? { type: "turn/setWorkerPreference", preference: p.preference }
        : null;
    case "turn/endTurn":
      return { type: "turn/endTurn" };

    // ---- dungeon ----
    case "dungeon/redeemPardon":
      return { type: "dungeon/redeemPardon" };

    default:
      return null; // everything else is room-internal / never client-sent
  }
}
