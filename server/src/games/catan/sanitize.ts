/**
 * Whitelist-sanitize raw client payloads into engine Actions. Never hand a
 * raw client object to the engine: every field is type-checked, range-checked
 * and rebuilt from scratch; unknown action types and junk shapes return null.
 *
 * Trust decisions enforced here (the engine then validates legality):
 *  - rollDice never carries client dice (server RNG only);
 *  - discard / respondDomesticTrade get their `player` forced to the sender;
 *  - endSpecialBuild (dormant 5-6p flow) is not accepted at all.
 *
 * (Exported for direct unit testing.)
 */
import type { CatanEngine } from "@backbone/shared";

type Action = CatanEngine.Action;
type Resource = CatanEngine.Resource;
type ResourceBag = CatanEngine.ResourceBag;

const RESOURCE_SET = new Set(["lumber", "brick", "wool", "grain", "ore"]);

/** Board sizes the indices are checked against (from the room's geometry). */
export interface BoardLimits {
  hexes: number;
  vertices: number;
  edges: number;
  seats: number;
}

function parseIndex(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < max ? v : null;
}

function parseResource(v: unknown): Resource | null {
  return typeof v === "string" && RESOURCE_SET.has(v) ? (v as Resource) : null;
}

/** Rebuild a clean bag; rejects unknown keys and non-integer counts. */
function parseBag(raw: unknown): Partial<ResourceBag> | null {
  if (typeof raw !== "object" || raw === null) return null;
  const bag: Partial<ResourceBag> = {};
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    const res = parseResource(key);
    const count = parseIndex((raw as Record<string, unknown>)[key], 100);
    if (!res || count === null) return null;
    if (count > 0) bag[res] = count;
  }
  return bag;
}

export function sanitizeAction(raw: unknown, senderSeat: number, limits: BoardLimits): Action | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case "placeSetupSettlement": {
      const vertex = parseIndex(a.vertex, limits.vertices);
      return vertex === null ? null : { type: "placeSetupSettlement", vertex };
    }
    case "placeSetupRoad": {
      const edge = parseIndex(a.edge, limits.edges);
      return edge === null ? null : { type: "placeSetupRoad", edge };
    }
    case "rollDice":
      return { type: "rollDice" }; // client dice are dropped on the floor
    case "rollForOrder":
      return { type: "rollForOrder", player: senderSeat }; // dice dropped, player pinned
    case "discard": {
      const cards = parseBag(a.cards);
      return cards === null ? null : { type: "discard", player: senderSeat, cards };
    }
    case "moveRobber": {
      const hex = parseIndex(a.hex, limits.hexes);
      return hex === null ? null : { type: "moveRobber", hex };
    }
    case "steal": {
      if (a.target === null) return { type: "steal", target: null };
      const target = parseIndex(a.target, limits.seats);
      return target === null ? null : { type: "steal", target };
    }
    case "robberTake":
      return { type: "robberTake" }; // robberBounty house rule (engine-gated)
    case "buildRoad": {
      const edge = parseIndex(a.edge, limits.edges);
      return edge === null ? null : { type: "buildRoad", edge };
    }
    case "buildSettlement": {
      const vertex = parseIndex(a.vertex, limits.vertices);
      return vertex === null ? null : { type: "buildSettlement", vertex };
    }
    case "buildCity": {
      const vertex = parseIndex(a.vertex, limits.vertices);
      return vertex === null ? null : { type: "buildCity", vertex };
    }
    case "buyDevCard":
      return { type: "buyDevCard" };
    case "playKnight":
      return { type: "playKnight" };
    case "playRoadBuilding":
      return { type: "playRoadBuilding" };
    case "playYearOfPlenty": {
      if (!Array.isArray(a.resources) || a.resources.length !== 2) return null;
      const r1 = parseResource(a.resources[0]);
      const r2 = parseResource(a.resources[1]);
      return r1 && r2 ? { type: "playYearOfPlenty", resources: [r1, r2] } : null;
    }
    case "playMonopoly": {
      const resource = parseResource(a.resource);
      return resource ? { type: "playMonopoly", resource } : null;
    }
    case "maritimeTrade": {
      const give = parseResource(a.give);
      const receive = parseResource(a.receive);
      return give && receive ? { type: "maritimeTrade", give, receive } : null;
    }
    case "proposeDomesticTrade": {
      const give = parseBag(a.give);
      const receive = parseBag(a.receive);
      if (give === null || receive === null) return null;
      let to: number[] | undefined;
      if (a.to !== undefined) {
        if (!Array.isArray(a.to) || a.to.length > limits.seats) return null;
        to = [];
        for (const t of a.to) {
          const seat = parseIndex(t, limits.seats);
          if (seat === null) return null;
          to.push(seat);
        }
      }
      return { type: "proposeDomesticTrade", give, receive, ...(to ? { to } : {}) };
    }
    case "respondDomesticTrade": {
      if (typeof a.accept !== "boolean") return null;
      return { type: "respondDomesticTrade", player: senderSeat, accept: a.accept };
    }
    case "confirmDomesticTrade": {
      const partner = parseIndex(a.partner, limits.seats);
      return partner === null ? null : { type: "confirmDomesticTrade", partner };
    }
    case "cancelDomesticTrade":
      return { type: "cancelDomesticTrade" };
    case "endTurn":
      return { type: "endTurn" };
    // ---- "CATAN for Two" variant ----
    case "buildNeutral": {
      if (a.neutralId !== 0 && a.neutralId !== 1) return null;
      if (a.kind === "road") {
        const edge = parseIndex(a.edge, limits.edges);
        return edge === null ? null : { type: "buildNeutral", neutralId: a.neutralId, kind: "road", edge };
      }
      if (a.kind === "settlement") {
        const vertex = parseIndex(a.vertex, limits.vertices);
        return vertex === null
          ? null
          : { type: "buildNeutral", neutralId: a.neutralId, kind: "settlement", vertex };
      }
      return null;
    }
    case "playForcedTrade":
      return { type: "playForcedTrade" };
    case "forcedTradeGiveBack": {
      const cards = parseBag(a.cards);
      return cards === null ? null : { type: "forcedTradeGiveBack", cards };
    }
    case "playTokenRobber":
      return { type: "playTokenRobber" };
    case "discardKnightForTokens":
      return { type: "discardKnightForTokens" };
    default:
      return null;
  }
}
