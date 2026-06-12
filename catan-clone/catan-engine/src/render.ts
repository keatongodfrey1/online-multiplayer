/**
 * render.ts — a dependency-free SVG renderer for a board, to demonstrate the
 * geometry/state is drawable (it addresses the "no UI" gap; a real interactive
 * client is an app-layer concern). Pure: takes geometry + state, returns an
 * SVG string. Uses the pointy-top layout and the render helpers from
 * geometry.ts, so the picture always matches the topology.
 */

import { edgeMidpoint, edgeOutwardNormal, type BoardGeometry } from "./geometry.ts";
import type { GameState, Terrain } from "./types.ts";

const TERRAIN_FILL: Record<Terrain, string> = {
  forest: "#2f7d32",
  pasture: "#9ccc65",
  fields: "#f6c945",
  hills: "#cd6a37",
  mountains: "#9aa0a6",
  desert: "#e7d7a8",
};
const PLAYER_FILL: Record<string, string> = {
  red: "#d23b3b", blue: "#2f6fd2", white: "#f4f4f4", orange: "#e08a2e", green: "#3aa657", brown: "#7a5230",
};
const PORT_LABEL: Record<string, string> = {
  generic: "3:1", lumber: "2:1\nwood", brick: "2:1\nbrick", wool: "2:1\nwool", grain: "2:1\ngrain", ore: "2:1\nore",
};

export interface RenderOptions { scale?: number; showPortLabels?: boolean }

export function renderBoardSVG(geo: BoardGeometry, state: GameState, opts: RenderOptions = {}): string {
  const S = opts.scale ?? 64;
  const showPorts = opts.showPortLabels ?? true;

  // bounding box over all vertices (scaled), plus margin for offshore ports
  const xs = geo.vertices.map((v) => v.point.x * S);
  const ys = geo.vertices.map((v) => v.point.y * S);
  const margin = S * 1.6;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  const W = maxX - minX, H = maxY - minY;
  const tx = (x: number) => x * S - minX;
  const ty = (y: number) => y * S - minY;

  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W.toFixed(1)} ${H.toFixed(1)}" font-family="system-ui,sans-serif">`);
  out.push(`<rect x="0" y="0" width="${W.toFixed(1)}" height="${H.toFixed(1)}" fill="#a9d6e5"/>`); // sea

  // ports: a small offshore marker + connector to its edge
  if (showPorts) {
    state.board.ports.forEach((port) => {
      const eid = geo.edges.findIndex((e) => e.vertices.every((v) => port.vertices.includes(v)) && port.vertices.length === 2 && e.vertices.length === 2 && port.vertices.includes(e.vertices[0]) && port.vertices.includes(e.vertices[1]));
      // fall back: find the edge whose vertex pair matches the port's two vertices
      let edgeId = eid;
      if (edgeId < 0) edgeId = geo.edges.findIndex((e) => (e.vertices[0] === port.vertices[0] && e.vertices[1] === port.vertices[1]) || (e.vertices[0] === port.vertices[1] && e.vertices[1] === port.vertices[0]));
      if (edgeId < 0) return;
      const m = edgeMidpoint(geo, edgeId);
      const n = edgeOutwardNormal(geo, edgeId);
      const px = m.x * S + n.x * S * 0.9, py = m.y * S + n.y * S * 0.9;
      out.push(`<line x1="${tx(m.x).toFixed(1)}" y1="${ty(m.y).toFixed(1)}" x2="${(px - minX).toFixed(1)}" y2="${(py - minY).toFixed(1)}" stroke="#6b4f2a" stroke-width="2" stroke-dasharray="4 3"/>`);
      out.push(`<circle cx="${(px - minX).toFixed(1)}" cy="${(py - minY).toFixed(1)}" r="${(S * 0.34).toFixed(1)}" fill="#f5e8c8" stroke="#6b4f2a" stroke-width="2"/>`);
      const lines = PORT_LABEL[port.type].split("\n");
      lines.forEach((ln, i) => out.push(`<text x="${(px - minX).toFixed(1)}" y="${(py - minY + (i - (lines.length - 1) / 2) * S * 0.22 + S * 0.07).toFixed(1)}" font-size="${(S * 0.2).toFixed(1)}" text-anchor="middle" fill="#3a2c12">${ln}</text>`));
    });
  }

  // hexes
  geo.hexes.forEach((hex) => {
    const hs = state.board.hexes[hex.id];
    const pts = hex.vertices.map((vid) => `${tx(geo.vertices[vid].point.x).toFixed(1)},${ty(geo.vertices[vid].point.y).toFixed(1)}`).join(" ");
    out.push(`<polygon points="${pts}" fill="${TERRAIN_FILL[hs.terrain]}" stroke="#7a6a3a" stroke-width="2"/>`);
    const c = hex.center;
    if (hs.numberToken !== null) {
      const red = hs.numberToken === 6 || hs.numberToken === 8;
      out.push(`<circle cx="${tx(c.x).toFixed(1)}" cy="${ty(c.y).toFixed(1)}" r="${(S * 0.28).toFixed(1)}" fill="#f3ecd2" stroke="#5b4a22" stroke-width="1.5"/>`);
      out.push(`<text x="${tx(c.x).toFixed(1)}" y="${(ty(c.y) + S * 0.1).toFixed(1)}" font-size="${(S * 0.3).toFixed(1)}" font-weight="700" text-anchor="middle" fill="${red ? "#c0392b" : "#222"}">${hs.numberToken}</text>`);
    }
    if (state.board.robberHex === hex.id) {
      out.push(`<circle cx="${(tx(c.x) + S * 0.34).toFixed(1)}" cy="${(ty(c.y) - S * 0.3).toFixed(1)}" r="${(S * 0.16).toFixed(1)}" fill="#2b2b2b" stroke="#000" stroke-width="1"/>`);
    }
  });

  // roads
  state.board.edges.forEach((es, eid) => {
    if (!es.road) return;
    const [a, b] = geo.edges[eid].vertices;
    const ax = tx(geo.vertices[a].point.x), ay = ty(geo.vertices[a].point.y);
    const bx = tx(geo.vertices[b].point.x), by = ty(geo.vertices[b].point.y);
    const color = PLAYER_FILL[state.players[es.road.owner].color] ?? "#000";
    out.push(`<line x1="${ax.toFixed(1)}" y1="${ay.toFixed(1)}" x2="${bx.toFixed(1)}" y2="${by.toFixed(1)}" stroke="${color}" stroke-width="${(S * 0.13).toFixed(1)}" stroke-linecap="round"/>`);
  });

  // settlements & cities
  state.board.vertices.forEach((vs, vid) => {
    if (!vs.building) return;
    const v = geo.vertices[vid].point;
    const color = PLAYER_FILL[state.players[vs.building.owner].color] ?? "#000";
    const x = tx(v.x), y = ty(v.y);
    if (vs.building.type === "settlement") {
      const r = S * 0.16;
      out.push(`<rect x="${(x - r).toFixed(1)}" y="${(y - r).toFixed(1)}" width="${(r * 2).toFixed(1)}" height="${(r * 2).toFixed(1)}" rx="${(r * 0.4).toFixed(1)}" fill="${color}" stroke="#111" stroke-width="1.5"/>`);
    } else {
      const r = S * 0.22;
      out.push(`<polygon points="${x.toFixed(1)},${(y - r).toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${(y + r).toFixed(1)} ${(x - r).toFixed(1)},${y.toFixed(1)}" fill="${color}" stroke="#111" stroke-width="1.5"/>`);
    }
  });

  out.push(`</svg>`);
  return out.join("\n");
}
