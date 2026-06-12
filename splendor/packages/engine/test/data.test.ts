import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GAME_DATA, validateGameData } from "../src/index";

test("embedded GAME_DATA passes all code-level checks", () => {
  const failures = validateGameData(GAME_DATA);
  assert.deepEqual(failures, [], `data validation failures:\n${failures.join("\n")}`);
});

test("embedded GAME_DATA matches the canonical data/splendor_data.json (no drift)", () => {
  const path = join(__dirname, "..", "..", "data", "splendor_data.json");
  if (!existsSync(path)) {
    // Fall back to the package-local copy path layout.
    const alt = join(__dirname, "..", "data", "splendor_data.json");
    if (!existsSync(alt)) {
      console.warn("canonical JSON not found; skipping drift check");
      return;
    }
  }
  const onDisk = JSON.parse(readFileSync(existsSync(path) ? path : join(__dirname, "..", "data", "splendor_data.json"), "utf8"));
  // Compare the parts the engine relies on.
  assert.deepEqual(JSON.parse(JSON.stringify(GAME_DATA.cards)), onDisk.cards, "cards drifted from JSON — run npm run gen:data");
  assert.deepEqual(JSON.parse(JSON.stringify(GAME_DATA.nobles)), onDisk.nobles, "nobles drifted from JSON — run npm run gen:data");
});
