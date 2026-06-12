/**
 * Catan board renderer - a pure function from (geometry, synced state, UI
 * intent) to an SVG string. The geometry is the engine's deterministic
 * pointy-top layout (unit-size hexes); everything is scaled into one viewBox
 * so the SVG stretches to its container on any tablet.
 *
 * Interaction: legal targets get transparent tap shapes carrying data-action
 * attributes ("tap-vertex" / "tap-edge" / "tap-hex" with data-id); the view's
 * delegated click handler turns them into messages. Nothing here mutates
 * anything.
 */
import type { CatanState } from "@backbone/shared";
import { CatanEngine } from "@backbone/shared";

type BoardGeometry = CatanEngine.BoardGeometry;

const { edgeMidpoint, edgeOutwardNormal } = CatanEngine;

/** Pixels per geometry unit (hex size 1). */
const S = 44;
/** Extra room around the island for the offshore port markers. */
const MARGIN = 1.9 * S;

const TERRAIN_FILL: Record<string, string> = {
  forest: "#2c7a3f",
  pasture: "#79b851",
  fields: "#d9b44a",
  hills: "#b2603a",
  mountains: "#8d93a3",
  desert: "#cdb98a",
};

export const PLAYER_COLOR: Record<string, string> = {
  red: "#e4574f",
  blue: "#4a90e2",
  white: "#e8eaf2",
  orange: "#e8943a",
};

/** Dice-odds pips printed under a number token. */
const PIPS: Record<number, number> = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

export interface BoardUi {
  /** Vertices to highlight + make tappable. */
  legalVertices?: ReadonlySet<number>;
  /** Edges to highlight + make tappable. */
  legalEdges?: ReadonlySet<number>;
  /** Hexes to make tappable (robber placement). */
  legalHexes?: ReadonlySet<number>;
}

export function boardViewBox(geo: BoardGeometry): string {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of geo.vertices) {
    minX = Math.min(minX, v.point.x * S);
    minY = Math.min(minY, v.point.y * S);
    maxX = Math.max(maxX, v.point.x * S);
    maxY = Math.max(maxY, v.point.y * S);
  }
  return `${(minX - MARGIN).toFixed(0)} ${(minY - MARGIN).toFixed(0)} ${(maxX - minX + 2 * MARGIN).toFixed(0)} ${(maxY - minY + 2 * MARGIN).toFixed(0)}`;
}

function px(n: number): string {
  return (n * S).toFixed(1);
}

function hexCorners(geo: BoardGeometry, hexId: number): string {
  return geo.hexes[hexId]!.vertices
    .map((v) => `${px(geo.vertices[v]!.point.x)},${px(geo.vertices[v]!.point.y)}`)
    .join(" ");
}

function seatColor(state: CatanState, seat: number): string {
  return PLAYER_COLOR[state.seats[seat]?.color ?? ""] ?? "#999";
}

export function renderBoardSvg(geo: BoardGeometry, state: CatanState, ui: BoardUi = {}): string {
  const parts: string[] = [];

  // terrain
  for (const hex of geo.hexes) {
    const terrain = state.hexTerrain[hex.id] ?? "desert";
    parts.push(
      `<polygon points="${hexCorners(geo, hex.id)}" fill="${TERRAIN_FILL[terrain] ?? "#666"}" stroke="#10131c" stroke-width="3"/>`,
    );
  }

  // ports (offshore marker + connector to its two vertices)
  for (let p = 0; p < state.portTypes.length; p++) {
    const vA = state.portVertices[p * 2] ?? 0;
    const vB = state.portVertices[p * 2 + 1] ?? 0;
    const a = geo.vertices[vA]!.point;
    const b = geo.vertices[vB]!.point;
    // the coastal edge between the two port vertices, for the outward normal
    const edge = geo.vertices[vA]!.edges.find((e) => geo.edges[e]!.vertices.includes(vB));
    const mid = edge !== undefined ? edgeMidpoint(geo, edge) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const n = edge !== undefined ? edgeOutwardNormal(geo, edge) : { x: mid.x, y: mid.y };
    const cx = mid.x + n.x * 0.95;
    const cy = mid.y + n.y * 0.95;
    const label = state.portTypes[p] === "generic" ? "3:1" : `2:1`;
    const icon = state.portTypes[p] === "generic" ? "" : ` ${resourceIcon(state.portTypes[p]!)}`;
    parts.push(
      `<line x1="${px(cx)}" y1="${px(cy)}" x2="${px(a.x)}" y2="${px(a.y)}" stroke="#56607a" stroke-width="2" stroke-dasharray="4 4"/>`,
      `<line x1="${px(cx)}" y1="${px(cy)}" x2="${px(b.x)}" y2="${px(b.y)}" stroke="#56607a" stroke-width="2" stroke-dasharray="4 4"/>`,
      `<circle cx="${px(cx)}" cy="${px(cy)}" r="15" fill="#1f2230" stroke="#56607a" stroke-width="2"/>`,
      `<text x="${px(cx)}" y="${px(cy)}" class="catan-port-label" text-anchor="middle" dominant-baseline="central">${label}${icon}</text>`,
    );
  }

  // number tokens + robber
  for (const hex of geo.hexes) {
    const token = state.hexToken[hex.id] ?? 0;
    const c = hex.center;
    if (token > 0) {
      const red = token === 6 || token === 8;
      parts.push(
        `<circle cx="${px(c.x)}" cy="${px(c.y)}" r="14" fill="#f4ecd8" stroke="#10131c" stroke-width="1.5"/>`,
        `<text x="${px(c.x)}" y="${px(c.y) /* number */}" dy="-1" text-anchor="middle" dominant-baseline="central" class="catan-token ${red ? "catan-token-red" : ""}">${token}</text>`,
        `<text x="${px(c.x)}" y="${px(c.y)}" dy="9" text-anchor="middle" class="catan-token-pips ${red ? "catan-token-red" : ""}">${"·".repeat(PIPS[token] ?? 0)}</text>`,
      );
    }
    if (state.robberHex === hex.id && state.phaseDetail !== "setupSettlement" && state.phaseDetail !== "setupRoad") {
      const rx = (c.x - 0.42) * S;
      const ry = (c.y - 0.3) * S;
      parts.push(
        `<g class="catan-robber"><circle cx="${rx.toFixed(1)}" cy="${ry.toFixed(1)}" r="9" fill="#23252e" stroke="#0c0e14" stroke-width="2"/><rect x="${(rx - 7).toFixed(1)}" y="${ry.toFixed(1)}" width="14" height="16" rx="4" fill="#23252e" stroke="#0c0e14" stroke-width="2"/></g>`,
      );
    }
  }

  // roads
  state.edgeOwner.forEach((owner, e) => {
    if (owner < 0) return;
    const [a, b] = geo.edges[e]!.vertices;
    const pa = geo.vertices[a]!.point;
    const pb = geo.vertices[b]!.point;
    // shorten slightly so roads do not overlap building shapes
    const t = 0.16;
    const x1 = pa.x + (pb.x - pa.x) * t;
    const y1 = pa.y + (pb.y - pa.y) * t;
    const x2 = pb.x + (pa.x - pb.x) * t;
    const y2 = pb.y + (pa.y - pb.y) * t;
    parts.push(
      `<line x1="${px(x1)}" y1="${px(y1)}" x2="${px(x2)}" y2="${px(y2)}" stroke="#10131c" stroke-width="11" stroke-linecap="round"/>`,
      `<line x1="${px(x1)}" y1="${px(y1)}" x2="${px(x2)}" y2="${px(y2)}" stroke="${seatColor(state, owner)}" stroke-width="7" stroke-linecap="round"/>`,
    );
  });

  // settlements & cities
  state.vertexOwner.forEach((owner, v) => {
    if (owner < 0) return;
    const p = geo.vertices[v]!.point;
    const color = seatColor(state, owner);
    const x = p.x * S;
    const y = p.y * S;
    if (state.vertexIsCity[v]) {
      parts.push(
        `<path d="M ${x - 13} ${y + 9} L ${x - 13} ${y - 4} L ${x - 6} ${y - 10} L ${x + 1} ${y - 4} L ${x + 1} ${y - 1} L ${x + 13} ${y - 1} L ${x + 13} ${y + 9} Z" fill="${color}" stroke="#10131c" stroke-width="2.5"/>`,
      );
    } else {
      parts.push(
        `<path d="M ${x - 9} ${y + 8} L ${x - 9} ${y - 2} L ${x} ${y - 10} L ${x + 9} ${y - 2} L ${x + 9} ${y + 8} Z" fill="${color}" stroke="#10131c" stroke-width="2.5"/>`,
      );
      // 2p variant: letter the neutral pieces so they match "Neutral A/B"
      if (state.seats[owner]?.neutral) {
        parts.push(
          `<text x="${x}" y="${y + 2}" text-anchor="middle" dominant-baseline="central" class="catan-neutral-letter">${owner === 2 ? "A" : "B"}</text>`,
        );
      }
    }
  });

  // interaction layer: tappable legal targets (drawn last = on top)
  if (ui.legalHexes?.size) {
    for (const h of ui.legalHexes) {
      parts.push(
        `<polygon points="${hexCorners(geo, h)}" class="catan-hl-hex" data-action="tap-hex" data-id="${h}"/>`,
      );
    }
  }
  if (ui.legalEdges?.size) {
    for (const e of ui.legalEdges) {
      const [a, b] = geo.edges[e]!.vertices;
      const pa = geo.vertices[a]!.point;
      const pb = geo.vertices[b]!.point;
      const mx = ((pa.x + pb.x) / 2) * S;
      const my = ((pa.y + pb.y) / 2) * S;
      parts.push(
        `<line x1="${px(pa.x)}" y1="${px(pa.y)}" x2="${px(pb.x)}" y2="${px(pb.y)}" class="catan-hl-edge-line"/>`,
        `<circle cx="${mx}" cy="${my}" r="15" class="catan-hl-spot" data-action="tap-edge" data-id="${e}"/>`,
      );
    }
  }
  if (ui.legalVertices?.size) {
    for (const v of ui.legalVertices) {
      const p = geo.vertices[v]!.point;
      parts.push(
        `<circle cx="${px(p.x)}" cy="${px(p.y)}" r="15" class="catan-hl-spot" data-action="tap-vertex" data-id="${v}"/>`,
      );
    }
  }

  return `<svg viewBox="${boardViewBox(geo)}" class="catan-svg" xmlns="http://www.w3.org/2000/svg">${parts.join("")}</svg>`;
}

export function resourceIcon(resource: string): string {
  switch (resource) {
    case "lumber": return "🪵";
    case "brick": return "🧱";
    case "wool": return "🐑";
    case "grain": return "🌾";
    case "ore": return "🪨";
    default: return "❔";
  }
}
