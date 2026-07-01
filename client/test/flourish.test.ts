// Client-side pure-logic tests for the Water Fight flourish layer. Runs on the same
// mocha + tsx harness as the server suite (flourish.ts is DOM-free — it imports only
// shared constants — so no browser/jsdom is needed).
import assert from "node:assert/strict";
import { EVENT_TONE, SUPPORT_TONE } from "@backbone/shared/games/waterfight/constants";
import { flourishContent, flourishTone, pickFlourish } from "../src/games/waterfight/flourish.js";

const ev = (kind: string, text = "x", detailKind = "") => ({ kind, text, detailKind });

describe("waterfight flourish: flourishTone", () => {
  it("harm is red, benefit/defense is green, Sudden-Death is yellow, the rest neutral", () => {
    assert.equal(flourishTone("damage", ""), "danger");
    assert.equal(flourishTone("soak", ""), "danger");
    assert.equal(flourishTone("heal", ""), "ok");
    assert.equal(flourishTone("save", ""), "ok");
    assert.equal(flourishTone("defend", "umbrella"), "ok");
    assert.equal(flourishTone("suddendeath", ""), "warn");
    assert.equal(flourishTone("attack", "golden"), "accent");
    assert.equal(flourishTone("react", "towel"), "accent");
    assert.equal(flourishTone("shop", ""), "accent");
    assert.equal(flourishTone("mystery-kind", ""), "accent"); // unknown → neutral, never throws
  });

  it("a harmful support flourishes red, a helpful one green, utility neutral (the polish)", () => {
    assert.equal(flourishTone("support", "sabotage"), "danger");
    assert.equal(flourishTone("support", "pickpocket"), "danger");
    assert.equal(flourishTone("support", "firstaid"), "ok");
    assert.equal(flourishTone("support", "backpack"), "ok");
    assert.equal(flourishTone("support", "goggles"), "accent");
    assert.equal(flourishTone("support", "switcheroo"), "accent");
  });

  it("event tone follows its effect: harm red, heal/gain green, dud neutral", () => {
    assert.equal(flourishTone("event", "mudslide"), "danger");
    assert.equal(flourishTone("event", "lightning"), "danger");
    assert.equal(flourishTone("event", "rainbow"), "ok");
    assert.equal(flourishTone("event", "treasurechest"), "ok");
    assert.equal(flourishTone("event", "calmwaters"), "accent");
  });

  it("flourishTone reads a valid tone for every entry in the support + event tables", () => {
    // The Record<Kind> types already give compile-time completeness (item 4); this guards
    // the integration — that flourishTone actually reads those tables and only yields valid tones.
    const valid = new Set(["danger", "ok", "warn", "accent"]);
    for (const [k, tone] of Object.entries(SUPPORT_TONE)) {
      assert.ok(valid.has(tone), `SUPPORT_TONE["${k}"] is not a valid tone: ${tone}`);
      assert.equal(flourishTone("support", k), tone);
    }
    for (const [k, tone] of Object.entries(EVENT_TONE)) {
      assert.ok(valid.has(tone), `EVENT_TONE["${k}"] is not a valid tone: ${tone}`);
      assert.equal(flourishTone("event", k), tone);
    }
  });
});

describe("waterfight flourish: flourishContent", () => {
  it("an event renders NAME + effect + themed emoji (not a generic die)", () => {
    const c = flourishContent(ev("event", "🎲 Keaton drew Mudslide", "mudslide"));
    assert.ok("name" in c);
    assert.equal(c.name, "Mudslide");
    assert.equal(c.desc, "Everyone takes 1 damage.");
    assert.equal(c.emoji, "🌊"); // themed, from EVENT_EMOJI — not "🎲"
  });

  it("a played card renders its name + effect from CARD_INFO", () => {
    const c = flourishContent(ev("support", "Keaton used Sabotage on Gemma", "sabotage"));
    assert.ok("name" in c);
    assert.equal(c.name, "Sabotage");
    assert.match(c.desc, /discards 2/i);
  });

  it("a secret/aggregate moment (no detailKind) falls back to the generic public text", () => {
    const c = flourishContent(ev("shop", "🛍️ Keaton buys 1 card from the Mischief Market", ""));
    assert.ok("line" in c);
    assert.equal(c.line, "🛍️ Keaton buys 1 card from the Mischief Market");
  });

  it("a detailKind that isn't a card or event falls back to the line (no crash)", () => {
    const c = flourishContent(ev("attack", "🌧 Flash Flood on everyone!", "flashflood-unknown"));
    assert.ok("line" in c);
  });
});

describe("waterfight flourish: pickFlourish", () => {
  it("collapses a multi-target reduce to ONE summary — the highest-priority event", () => {
    const best = pickFlourish([ev("attack", "flood!", "flashflood"), ev("damage", "-1"), ev("damage", "-1")]);
    assert.ok(best);
    assert.equal(best!.kind, "attack"); // 7 > damage 1
  });

  it("an event headline beats its own consequence in the same reduce", () => {
    const best = pickFlourish([ev("support", "loses a card"), ev("event", "drew Leaky Bucket", "leakybucket")]);
    assert.equal(best!.kind, "event"); // 8 > support 4
  });

  it("a turn-only reduce flourishes nothing (turn is excluded)", () => {
    assert.equal(pickFlourish([ev("turn", "Gemma's turn")]), null);
  });

  it("an empty batch, or one with only empty text, flourishes nothing", () => {
    assert.equal(pickFlourish([]), null);
    assert.equal(pickFlourish([ev("damage", "")]), null);
  });
});
