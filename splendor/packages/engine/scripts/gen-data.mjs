// Regenerates src/gameData.ts from data/splendor_data.json.
// Run: npm run gen:data
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const data = JSON.parse(readFileSync(join(pkg, "data", "splendor_data.json"), "utf8"));
const COLORS = ["white", "blue", "green", "red", "black"];
const cmap = (m) => "{" + COLORS.map((k) => `${k}:${m[k]}`).join(", ") + "}";

const lines = [];
lines.push("// AUTO-GENERATED from data/splendor_data.json by scripts/gen-data.mjs — do not edit by hand.");
lines.push("// Regenerate with: npm run gen:data");
lines.push("/* eslint-disable */");
lines.push("export const GAME_DATA = {");
lines.push("  meta: " + JSON.stringify(data.meta) + ",");
lines.push("  cards: [");
for (const c of data.cards) {
  lines.push(`    {id:${c.id}, tier:${c.tier}, bonus:"${c.bonus}", points:${c.points}, cost:${cmap(c.cost)}},`);
}
lines.push("  ],");
lines.push("  nobles: [");
for (const n of data.nobles) {
  lines.push(`    {id:${n.id}, name:${JSON.stringify(n.name ?? "")}, points:${n.points}, requirement:${cmap(n.requirement)}},`);
}
lines.push("  ],");
lines.push("} as const;");
lines.push("");
writeFileSync(join(pkg, "src", "gameData.ts"), lines.join("\n"));
console.log(`wrote src/gameData.ts: ${data.cards.length} cards, ${data.nobles.length} nobles`);
