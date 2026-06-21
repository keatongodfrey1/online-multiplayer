// Pure, deterministic Water Fight rules engine (the full ruleset: turn flow,
// draws + Events, shop, Support/Mischief, big attacks + modifiers, reactions,
// Storm Cloud, Sudden-Death). All functions are pure: clone-then-mutate, no I/O,
// no wall clock, no Math.random (the RNG state lives in GameState). The attack
// ladder lives in attack.ts; this module owns the turn flow, draws, damage/soak/
// win, and the legal-move surface that policies (bots/fuzz) read.

import { advanceLadder, bigStats, currentTarget, openAttack, openTarget } from "./attack.js";
import { COIN_VALUES, WF_STACK_IDS } from "../constants.js";
import { DRAW_PER_TURN } from "./data.js";
import { discardCard, drawMainCard, flipSplash } from "./deck.js";
import { rand } from "./rng.js";
import {
  ApplyResult,
  AttackKind,
  Awaiting,
  BigKind,
  CardKind,
  EventKind,
  GameEvent,
  GameState,
  Move,
  PendingAction,
  PlayerState,
  Resolution,
  Spread,
  StackId,
  SupportKind,
} from "./types.js";

const STACK_IDS: readonly StackId[] = WF_STACK_IDS;

/** Keep the in-memory log bounded so structuredClone (per reduce) and the save
 *  blob don't grow with game length. Only the last ~80 are ever synced. */
const ENGINE_LOG_CAP = 200;

function clone<T>(x: T): T {
  return structuredClone(x);
}

/** Trim the log to the last ENGINE_LOG_CAP lines (called once per reduce). */
function trimLog(s: GameState): void {
  if (s.log.length > ENGINE_LOG_CAP) s.log.splice(0, s.log.length - ENGINE_LOG_CAP);
}

/** Support cards whose effect is implemented. Only these are offered by
 *  legalMoves, so a bot/fuzz never plays an unimplemented one. */
const SUPPORT_IMPLEMENTED: SupportKind[] = [
  "firstaid", "backpack", "hiddenstash", "goggles",
  "needle", "pickpocket", "sabotage", "cardswap", "freezeout", "lemonadespill", "sneakypeek", "switcheroo",
];
/** Supports that require an opponent target. */
const TARGETED_SUPPORTS = new Set<SupportKind>([
  "needle", "pickpocket", "sabotage", "cardswap", "freezeout", "lemonadespill", "sneakypeek", "switcheroo",
]);

export function livingSeats(s: GameState): number[] {
  return s.players.filter((p) => !p.out).map((p) => p.seat);
}

function handHas(p: PlayerState, kind: CardKind): boolean {
  return p.hand.some((c) => c.kind === kind);
}

function handCount(p: PlayerState, kind: CardKind): number {
  return p.hand.reduce((n, c) => n + (c.kind === kind ? 1 : 0), 0);
}

/** A minimal sell (preferring Treasure/balloons, preserving the Wild) reaching
 *  `cost` coins; null if unaffordable. Coin values from COIN_VALUES. */
function minimalSell(p: PlayerState, cost: number): { balloons: number; treasures: number; wild: number } | null {
  const b = handCount(p, "balloon");
  const t = handCount(p, "treasure");
  const w = handCount(p, "wild");
  let coins = 0;
  let sb = 0;
  let st = 0;
  let sw = 0;
  while (coins < cost && st < t) {
    st += 1;
    coins += COIN_VALUES.treasure;
  }
  while (coins < cost && sb < b) {
    sb += 1;
    coins += COIN_VALUES.balloon;
  }
  if (coins < cost && w > 0) {
    sw = 1;
    coins += COIN_VALUES.wild;
  }
  return coins >= cost ? { balloons: sb, treasures: st, wild: sw } : null;
}

function actingSeat(s: GameState): number {
  return s.awaiting.seats[0] ?? -1;
}

// ---- turn flow --------------------------------------------------------------

/** Draw `n` cards from the main deck into a seat's hand. A drawn Event resolves
 *  immediately and counts as one of the draws (no replacement — D3/E5); drawing
 *  stops early if an Event ends the game or soaks the drawer. */
function drawCards(s: GameState, seat: number, n: number): void {
  const p = s.players[seat]!;
  for (let i = 0; i < n; i++) {
    if (s.over || p.out) return;
    const card = drawMainCard(s);
    if (!card) return;
    if (card.kind === "event") {
      discardCard(s, card); // resolved Events go to the main discard (reshuffle back — D3)
      resolveEvent(s, seat, card.event!);
      continue;
    }
    p.hand.push(card);
  }
}

/** Apply `dmg` to one seat, with the automatic Lifeguard save (E10) and soak. */
function damageSeat(s: GameState, seat: number, dmg: number): void {
  const t = s.players[seat]!;
  if (t.out) return;
  t.lives = Math.max(0, t.lives - dmg);
  s.log.push(`seat ${seat} -${dmg} -> ${t.lives} lives`);
  if (t.lives <= 0) {
    if (handHas(t, "lifeguard")) {
      spendKind(s, seat, "lifeguard");
      t.lives = 1;
      s.log.push(`seat ${seat} saved by Lifeguard (-> 1 life)`);
    } else {
      t.out = true;
      if (s.phase !== "sudden-death") {
        t.stormCloud = true; // soft elimination (D5): keeps playing from the sideline
        s.log.push(`seat ${seat} SOAKED -> Storm Cloud`);
      } else {
        s.log.push(`seat ${seat} SOAKED (out)`); // Sudden-Death: fully removed
      }
    }
  }
}

/** Heal one seat by 1, capped at starting lives (E8). */
function healSeat(s: GameState, seat: number): void {
  const t = s.players[seat]!;
  if (!t.out) t.lives = Math.min(s.options.startingLives, t.lives + 1);
}

/** Move `n` Treasure cards from the main deck/discard into a seat's hand. */
function gainTreasure(s: GameState, seat: number, n: number): void {
  const p = s.players[seat]!;
  for (let i = 0; i < n; i++) {
    let idx = s.mainDeck.findIndex((c) => c.kind === "treasure");
    if (idx >= 0) {
      p.hand.push(s.mainDeck.splice(idx, 1)[0]!);
      continue;
    }
    idx = s.mainDiscard.findIndex((c) => c.kind === "treasure");
    if (idx >= 0) p.hand.push(s.mainDiscard.splice(idx, 1)[0]!);
  }
}

/** Table-wide damage. Suppressed entirely in Sudden-Death (E9). Otherwise, if a
 *  single source would soak EVERY living player at once, it triggers Sudden-Death
 *  and clamps each finalist to 1 life instead of wiping the table. */
function applyTableDamage(s: GameState, dmg: number): void {
  if (s.phase === "sudden-death") return; // E9: multi-target/table damage deals nothing
  const living = livingSeats(s);
  const wouldSoak = living.filter((seat) => !handHas(s.players[seat]!, "lifeguard") && s.players[seat]!.lives <= dmg);
  if (living.length > 1 && wouldSoak.length === living.length) {
    enterSuddenDeath(s, living);
    return;
  }
  for (const seat of living) damageSeat(s, seat, dmg);
}

/** Enter Sudden-Death (E9): clamp the tied finalists to 1 life. From here only
 *  single-target soaks happen, so the game ends with exactly one winner. */
function enterSuddenDeath(s: GameState, finalists: number[]): void {
  s.phase = "sudden-death";
  for (const seat of finalists) s.players[seat]!.lives = 1;
  s.log.push(`SUDDEN-DEATH: ${finalists.length} finalists clamped to 1 life`);
}

/** End the game if <= 1 living remains. Returns true if it concluded. */
function concludeIfOver(s: GameState): boolean {
  if (s.over) return true;
  const living = livingSeats(s);
  if (living.length <= 1) {
    endGame(s, living[0] ?? leaderByLives(s), "last-standing");
    return true;
  }
  return false;
}

/** Lost and Found (E7): the drawer takes a random card from each living opponent. */
function lostAndFound(s: GameState, seat: number): void {
  const p = s.players[seat]!;
  for (const t of livingSeats(s)) {
    if (t === seat) continue;
    const h = s.players[t]!.hand;
    if (h.length > 0) p.hand.push(h.splice(Math.floor(rand(s) * h.length), 1)[0]!);
  }
}

/** Resolve one Event immediately on draw (D3). All effects are self-contained
 *  (no awaiting), so this is safe to run inside a draw. */
function resolveEvent(s: GameState, drawer: number, event: EventKind): void {
  s.log.push(`seat ${drawer} draws Event: ${event}`);
  switch (event) {
    case "mudslide":
    case "stormsurge":
    case "heatwave":
    case "downpour":
    case "tidalwave":
      applyTableDamage(s, 1);
      break;
    case "lightning":
    case "targetedstorm": {
      const leader = leaderByLives(s); // anti-snowball: the life leader takes 1
      if (leader !== null) damageSeat(s, leader, 1);
      break;
    }
    case "sunbreak":
    case "rainbow":
      for (const t of livingSeats(s)) healSeat(s, t);
      break;
    case "waterparkpass":
      healSeat(s, drawer);
      break;
    case "treasurechest":
    case "supplycache":
      gainTreasure(s, drawer, 2);
      break;
    case "supplydrop":
      for (const t of livingSeats(s)) gainTreasure(s, t, 1);
      break;
    case "leakybucket":
      discardRandom(s, drawer, 1);
      break;
    case "springcleaning":
      for (const t of livingSeats(s)) discardRandom(s, t, 1);
      break;
    case "lostandfound":
      lostAndFound(s, drawer);
      break;
    case "calmwaters":
    case "falsealarm":
    case "gentlebreeze":
      break; // duds — variance only
  }
  concludeIfOver(s);
}

/** A Storm Cloud's draw (D5): `stormDraw` cards per turn (default 1); a drawn
 *  Event is discarded with no effect and still consumes the slot (E5). */
function drawStormCloud(s: GameState, seat: number): void {
  for (let i = 0; i < s.options.stormDraw; i++) {
    const card = drawMainCard(s);
    if (!card) return;
    if (card.kind === "event") {
      discardCard(s, card); // a Storm Cloud's Event has no effect
      continue;
    }
    s.players[seat]!.hand.push(card);
  }
}

/** Begin a seat's turn: apply pending statuses, draw, await their action. */
export function startTurn(s: GameState, seat: number): void {
  s.turnSeat = seat;
  s.supportUsed = false;
  s.stormThrowsUsed = 0;
  const p = s.players[seat]!;
  if (p.stormCloud) {
    drawStormCloud(s, seat); // D5: draw 1, Events void
    s.awaiting = { seats: [seat], kind: "MOVE" };
    return;
  }
  const draw = p.statuses.freezeOut ? 1 : DRAW_PER_TURN; // Freeze Out
  p.statuses.freezeOut = false;
  drawCards(s, seat, draw); // may resolve Events (D3)
  if (s.over) return;
  if (s.players[seat]!.out) {
    advanceTurn(s); // an Event soaked the turn player on their opening draw
    return;
  }
  s.awaiting = { seats: [seat], kind: "MOVE" };
}

/** Discard `n` random cards from a seat's hand (uses the game RNG). */
function discardRandom(s: GameState, seat: number, n: number): void {
  const hand = s.players[seat]!.hand;
  for (let i = 0; i < n && hand.length > 0; i++) {
    discardCard(s, hand.splice(Math.floor(rand(s) * hand.length), 1)[0]!);
  }
}

/** Swap up to 2 random cards each way between two hands (Card Swap). */
function cardSwap(s: GameState, a: number, b: number): void {
  const ha = s.players[a]!.hand;
  const hb = s.players[b]!.hand;
  for (let i = 0; i < 2; i++) {
    if (ha.length === 0 || hb.length === 0) break;
    const ca = ha.splice(Math.floor(rand(s) * ha.length), 1)[0]!;
    const cb = hb.splice(Math.floor(rand(s) * hb.length), 1)[0]!;
    ha.push(cb);
    hb.push(ca);
  }
}

/** Support card effects. Targeting Mischief cards apply immediately (the Towel
 *  reaction window arrives in B.6); "their choice" discards are randomized here. */
function applySupport(s: GameState, seat: number, support: SupportKind, target?: number): void {
  const p = s.players[seat]!;
  switch (support) {
    case "firstaid":
      p.lives = Math.min(s.options.startingLives, p.lives + 1); // E8: cap at starting lives
      return;
    case "backpack":
      drawCards(s, seat, 2);
      return;
    case "hiddenstash": {
      let taken = 0; // search the discard, take up to 2 Treasure
      for (let i = s.mainDiscard.length - 1; i >= 0 && taken < 2; i--) {
        if (s.mainDiscard[i]!.kind === "treasure") {
          p.hand.push(s.mainDiscard.splice(i, 1)[0]!);
          taken += 1;
        }
      }
      return;
    }
    case "needle": {
      const t = s.players[target!]!;
      const balloons = t.hand.filter((c) => c.kind === "balloon");
      t.hand = t.hand.filter((c) => c.kind !== "balloon");
      for (const c of balloons) discardCard(s, c);
      return;
    }
    case "pickpocket": {
      const t = s.players[target!]!;
      const idx = t.hand.findIndex((c) => c.kind === "treasure");
      if (idx >= 0) p.hand.push(t.hand.splice(idx, 1)[0]!);
      return;
    }
    case "sabotage":
      discardRandom(s, target!, 2);
      return;
    case "lemonadespill":
      discardRandom(s, target!, 1);
      s.players[target!]!.statuses.noShop = true;
      return;
    case "freezeout":
      s.players[target!]!.statuses.freezeOut = true;
      return;
    case "cardswap":
      cardSwap(s, seat, target!);
      return;
    case "switcheroo": {
      const t = s.players[target!]!;
      const tmp = p.hand;
      p.hand = t.hand;
      t.hand = tmp;
      return;
    }
    case "goggles": {
      // Peek the top 3 of the draw pile (a peek, never a draw — Events don't fire,
      // and the cards stay on top for the next drawer). Reveal in draw order.
      s.reveals.push({ seat, kind: "deck-top", cards: s.mainDeck.slice(-3).reverse().map((c) => ({ ...c })) });
      return;
    }
    case "sneakypeek": {
      s.reveals.push({ seat, kind: "hand", ofSeat: target!, cards: s.players[target!]!.hand.map((c) => ({ ...c })) });
      return;
    }
    default:
      throw new Error(`support ${support} not implemented yet`);
  }
}

/** End the active player's turn: discard down to the hand limit, then advance.
 *  If the turn player soaked themselves (a bounced Water Trap), skip the discard. */
function endActiveTurn(s: GameState): void {
  if (s.over) return;
  const seat = s.turnSeat;
  if (!s.players[seat]!.out && s.players[seat]!.hand.length > s.options.handLimit) {
    s.awaiting = { seats: [seat], kind: "DISCARD" };
    return;
  }
  advanceTurn(s);
}

function leaderByLives(s: GameState): number | null {
  let best: PlayerState | null = null;
  for (const p of s.players) {
    if (p.out) continue;
    if (!best || p.lives > best.lives || (p.lives === best.lives && p.seat < best.seat)) best = p;
  }
  return best ? best.seat : null;
}

function endGame(s: GameState, winner: number | null, reason: GameState["endReason"]): void {
  s.over = true;
  s.winner = winner;
  s.endReason = reason;
  s.awaiting = { seats: [], kind: "GAME_OVER" };
  s.log.push(`game over: ${reason}, winner seat ${winner}`);
}

/** Whether a seat takes a turn now: living players always; Storm Clouds in normal
 *  play (D5) but NOT in Sudden-Death (their splashes are suppressed — E9). */
function canActThisTurn(s: GameState, seat: number): boolean {
  const p = s.players[seat]!;
  if (s.phase === "sudden-death") return !p.out;
  return !p.out || p.stormCloud;
}

/** End the active player's turn and pass to the next seat that may act. */
function advanceTurn(s: GameState): void {
  if (s.over) return;
  s.players[s.turnSeat]!.statuses.noShop = false; // the finishing player's Lemonade Spill lifts
  s.turnCount += 1;
  if (s.turnCount > s.options.turnCap) {
    endGame(s, leaderByLives(s), "cap");
    return;
  }
  const N = s.players.length;
  let next = (s.turnSeat + 1) % N;
  for (let i = 0; i < N; i++) {
    if (canActThisTurn(s, next)) break;
    next = (next + 1) % N;
  }
  startTurn(s, next);
}

/** Remove one card of `kind` from a seat's hand to the discard/used pile. */
function spendKind(s: GameState, seat: number, kind: CardKind): void {
  const hand = s.players[seat]!.hand;
  const idx = hand.findIndex((c) => c.kind === kind);
  if (idx < 0) throw new Error(`seat ${seat} has no ${kind}`);
  discardCard(s, hand.splice(idx, 1)[0]!);
}

/** The seats a spread modifier hits (deduped, living opponents only, ≤3 for
 *  Triple Splash). The primary target leads; the rest inherit the one Hit (E3). */
function buildSpreadTargets(s: GameState, attacker: number, primary: number, spread: Spread): number[] {
  const opp = livingSeats(s).filter((t) => t !== attacker);
  if (spread.modifier === "splashzone") return [primary, ...opp.filter((t) => t !== primary)];
  const set = new Set<number>([primary, ...spread.extraTargets.filter((t) => opp.includes(t))]);
  return [...set].slice(0, 3);
}

/** After the whole attack resolves: Golden's draw, then an extra throw window
 *  (Launcher / Rapid Fire — E4) or end the turn. Bookkeeping belongs to the TURN
 *  player (who spent the Main Action), not the ladder attacker — a Water Trap may
 *  have swapped the ladder roles, but the turn and its extra throw still belong
 *  to the original mover. */
function afterAttack(s: GameState, kind: AttackKind): void {
  const owner = s.turnSeat;
  if (kind === "golden" && !s.players[owner]!.out) {
    drawCards(s, owner, 2); // Golden draws 2 whether it hit or missed (E2)
    s.log.push(`seat ${owner} draws 2 (Golden)`);
    if (s.over) return; // a Golden-drawn Event ended the game
  }
  s.awaiting = { seats: [], kind: "GAME_OVER" }; // clears the attack
  const p = s.players[owner]!;
  if (!p.out && (handHas(p, "launcher") || handHas(p, "rapidfire")) && handHas(p, "balloon")) {
    s.awaiting = { seats: [owner], kind: "EXTRA_THROW" }; // E4: optional extra basic throw
    return;
  }
  // A Storm Cloud may splash again if its per-turn throw budget (D5 dial) remains.
  if (p.stormCloud && s.stormThrowsUsed < s.options.stormThrows && handHas(p, "balloon") && livingSeats(s).length > 0) {
    s.awaiting = { seats: [owner], kind: "MOVE" };
    return;
  }
  endActiveTurn(s);
}

/** Apply the current target's result, then advance to the next target or finish. */
function resolveTarget(s: GameState, hit: boolean): void {
  const atk = s.awaiting.attack!;
  const tSeat = currentTarget(atk);
  // E9: in Sudden-Death, multi-target attacks deal no damage (single-target only).
  const suppressed = s.phase === "sudden-death" && atk.targets.length > 1;
  if (hit && !suppressed) damageSeat(s, tSeat, atk.damage);
  else s.log.push(`attack on seat ${tSeat} ${hit ? "suppressed (Sudden-Death AoE)" : "missed"}`);
  const living = livingSeats(s);
  if (living.length <= 1) {
    endGame(s, living[0] ?? null, "last-standing");
    return;
  }
  atk.targetIdx += 1; // skip any targets already soaked by an earlier instance
  while (atk.targetIdx < atk.targets.length && s.players[atk.targets[atk.targetIdx]!]!.out) atk.targetIdx += 1;
  if (atk.targetIdx < atk.targets.length) {
    openTarget(s);
    return;
  }
  afterAttack(s, atk.kind);
}

const REACTION_CARDS: CardKind[] = ["towel", "redirect", "watertrap"];

/** Whether the target holds a reaction that COULD affect this action (Towel works
 *  on anything targeting; Redirect / Water Trap only on attacks). Lets the engine
 *  auto-pass (no window) when there is genuinely nothing to react with. */
function hasUsefulReaction(p: PlayerState, kind: PendingAction["kind"]): boolean {
  if (handHas(p, "towel")) return true;
  return kind !== "SUPPORT" && (handHas(p, "redirect") || handHas(p, "watertrap"));
}

/** Open the pre-effect reaction window for the target (E10/E11), or resolve the
 *  action immediately when the target has nothing to react with (auto-pass). */
function offerReaction(s: GameState, pending: PendingAction): void {
  s.pending = pending;
  const t = s.players[pending.target]!;
  if (!t.out && hasUsefulReaction(t, pending.kind)) {
    s.awaiting = { seats: [pending.target], kind: "REACT" };
    return;
  }
  resolvePending(s);
}

/** Flip the Splash Pile for a (possibly redirected) basic throw, then resolve a
 *  Miss or open the ladder (spread consumed only on a Hit — E3). */
function resolveThrowFlip(s: GameState, attacker: number, target: number, soaker: boolean, spread?: Spread): void {
  const verdict = flipSplash(s);
  s.log.push(`seat ${attacker} throws at ${target}: splash ${verdict}`);
  if (verdict === "miss") {
    afterAttack(s, "basic");
    return;
  }
  let targets = [target];
  if (spread) {
    spendKind(s, attacker, spread.modifier);
    targets = buildSpreadTargets(s, attacker, target, spread);
  }
  openAttack(s, attacker, targets, "basic", 1, 1, soaker);
}

/** Execute the committed pending action now that the reaction window has passed. */
function resolvePending(s: GameState): void {
  const pa = s.pending!;
  s.pending = null;
  if (pa.kind === "SUPPORT") {
    applySupport(s, pa.attacker, pa.support!, pa.target);
    s.awaiting = { seats: [pa.attacker], kind: "MOVE" }; // Support does not end the turn
    return;
  }
  if (pa.kind === "THROW") {
    resolveThrowFlip(s, pa.attacker, pa.target, !!pa.soaker, pa.spread);
    return;
  }
  // PLAY_BIG auto-connects (E2)
  const { blockNumber, damage } = bigStats(pa.big!);
  let targets = [pa.target];
  if (pa.spread) {
    spendKind(s, pa.attacker, pa.spread.modifier);
    targets = buildSpreadTargets(s, pa.attacker, pa.target, pa.spread);
  }
  openAttack(s, pa.attacker, targets, pa.big!, blockNumber, damage, !!pa.soaker);
}

/** Commit a basic throw (spend balloon + Soaker), then open the reaction window. */
function startThrow(s: GameState, attacker: number, target: number, soaker: boolean, spread?: Spread): void {
  spendKind(s, attacker, "balloon");
  if (soaker) spendKind(s, attacker, "soaker"); // R2: declared pre-flip (wasted on a Miss)
  offerReaction(s, { kind: "THROW", attacker, target, soaker, spread, redirectedSeats: [] });
}

/** Commit a big attack (spend the card + Soaker), then open the reaction window. */
function startBig(s: GameState, attacker: number, target: number, big: BigKind, soaker: boolean, spread?: Spread): void {
  spendKind(s, attacker, big);
  if (soaker) spendKind(s, attacker, "soaker");
  offerReaction(s, { kind: "PLAY_BIG", attacker, target, big, soaker, spread, redirectedSeats: [] });
}

// ---- legal surface ----------------------------------------------------------

export function legalMoves(s: GameState): Move[] {
  if (s.over || s.awaiting.kind !== "MOVE") return [];
  const seat = s.turnSeat;
  const p = s.players[seat]!;
  if (p.stormCloud) {
    // D5: a Storm Cloud may only pass or splash a random living player.
    const moves: Move[] = [{ kind: "END_TURN" }];
    if (handHas(p, "balloon") && livingSeats(s).length > 0 && s.stormThrowsUsed < s.options.stormThrows) {
      moves.push({ kind: "STORM_THROW" });
    }
    return moves;
  }
  const opponents = livingSeats(s).filter((t) => t !== seat);
  const moves: Move[] = [{ kind: "END_TURN" }];
  if (!s.supportUsed) {
    for (const sup of SUPPORT_IMPLEMENTED) {
      if (!handHas(p, sup)) continue;
      if (TARGETED_SUPPORTS.has(sup)) {
        for (const t of opponents) moves.push({ kind: "PLAY_SUPPORT", support: sup, target: t });
      } else {
        moves.push({ kind: "PLAY_SUPPORT", support: sup });
      }
    }
  }
  if (handHas(p, "balloon")) {
    for (const t of opponents) {
      moves.push({ kind: "THROW", target: t });
      if (handHas(p, "soaker")) moves.push({ kind: "THROW", target: t, soaker: true }); // R2 pre-flip gamble
    }
    if (opponents.length >= 2) {
      // Spread variants (only meaningful with ≥2 opponents); primary leads the list.
      if (handHas(p, "splashzone")) {
        moves.push({ kind: "THROW", target: opponents[0]!, spread: { modifier: "splashzone", extraTargets: [] } });
      }
      if (handHas(p, "triplesplash")) {
        moves.push({ kind: "THROW", target: opponents[0]!, spread: { modifier: "triplesplash", extraTargets: opponents.slice(1, 3) } });
      }
    }
  }
  for (const big of ["mega", "giant", "golden"] as const) {
    if (handHas(p, big)) for (const t of opponents) moves.push({ kind: "PLAY_BIG", big, target: t });
  }
  const sell = minimalSell(p, s.options.shopCost);
  if (sell && !p.statuses.noShop) {
    for (const st of STACK_IDS) if (s.stacks[st].length > 0) moves.push({ kind: "SHOP", sell, buy: [st] });
  }
  return moves;
}

export function legalResolutions(s: GameState): Resolution[] {
  if (s.over) return [];
  const seat = actingSeat(s);
  if (seat < 0) return [];
  const p = s.players[seat]!;
  if (s.awaiting.kind === "REACT") {
    const pa = s.pending!;
    const out: Resolution[] = [{ kind: "REACT", action: "pass" }];
    if (handHas(p, "towel")) out.push({ kind: "REACT", action: "towel" });
    const canDiscrete = pa.kind !== "SUPPORT" && !pa.redirectedSeats.includes(seat); // Redirect/Trap: attacks only, once/seat
    if (canDiscrete && handHas(p, "redirect")) {
      for (const t of livingSeats(s)) if (t !== seat) out.push({ kind: "REACT", action: "redirect", target: t });
    }
    // Water Trap bounces to the attacker, so it is unavailable vs a Storm Cloud
    // splash (a Storm Cloud cannot be targeted).
    if (canDiscrete && handHas(p, "watertrap") && !s.players[pa.attacker]!.out) {
      out.push({ kind: "REACT", action: "watertrap" });
    }
    return out;
  }
  if (s.awaiting.kind === "DEFEND") {
    const out: Resolution[] = [{ kind: "DEFEND", defense: "pass" }];
    if (!s.awaiting.attack?.soaker && handHas(p, "miss")) out.push({ kind: "DEFEND", defense: "miss" }); // R2: Soaker negates hand-Miss
    if (handHas(p, "umbrella")) out.push({ kind: "DEFEND", defense: "umbrella" });
    if (handHas(p, "wild")) out.push({ kind: "DEFEND", defense: "wild_miss" });
    return out;
  }
  if (s.awaiting.kind === "ATTACKER_RESPOND") {
    const out: Resolution[] = [{ kind: "ATTACKER_RESPOND", respond: "pass" }];
    if (handHas(p, "hit")) out.push({ kind: "ATTACKER_RESPOND", respond: "hit" });
    if (handHas(p, "wild")) out.push({ kind: "ATTACKER_RESPOND", respond: "wild_hit" });
    return out;
  }
  if (s.awaiting.kind === "EXTRA_THROW") {
    const out: Resolution[] = [{ kind: "EXTRA", action: "pass" }];
    if (handHas(p, "balloon")) {
      for (const t of livingSeats(s)) if (t !== seat) out.push({ kind: "EXTRA", action: "throw", target: t });
    }
    return out;
  }
  return [];
}

// ---- validation -------------------------------------------------------------

function validateMove(s: GameState, move: Move): void {
  if (s.over) throw new Error("game over");
  if (s.awaiting.kind !== "MOVE") throw new Error("not awaiting a move");
  const seat = s.turnSeat;
  const p = s.players[seat]!;
  if (p.stormCloud) {
    if (move.kind === "END_TURN") return;
    if (move.kind !== "STORM_THROW") throw new Error("a Storm Cloud may only pass or splash");
    if (!handHas(p, "balloon")) throw new Error("no Water Balloon to splash");
    if (livingSeats(s).length === 0) throw new Error("no living target for the splash");
    if (s.stormThrowsUsed >= s.options.stormThrows) throw new Error("no Storm Cloud throws left this turn");
    return;
  }
  if (move.kind === "STORM_THROW") throw new Error("only a Storm Cloud may STORM_THROW");
  if (move.kind === "END_TURN") return;
  if (move.kind === "PLAY_SUPPORT") {
    if (s.supportUsed) throw new Error("already used a Support this turn");
    if (!SUPPORT_IMPLEMENTED.includes(move.support)) throw new Error(`support ${move.support} not available`);
    if (!handHas(p, move.support)) throw new Error(`no ${move.support} in hand`);
    if (TARGETED_SUPPORTS.has(move.support)) {
      if (move.target === undefined || move.target === seat) throw new Error("invalid Support target");
      const t = s.players[move.target];
      if (!t || t.out) throw new Error("target not a living player");
    }
    return;
  }
  if (move.kind === "SHOP") {
    if (p.statuses.noShop) throw new Error("cannot Shop this turn (Lemonade Spill)");
    const { balloons, treasures, wild } = move.sell;
    if (balloons < 0 || treasures < 0 || wild < 0 || wild > 1) throw new Error("invalid sell");
    if (handCount(p, "balloon") < balloons) throw new Error("not enough balloons to sell");
    if (handCount(p, "treasure") < treasures) throw new Error("not enough Treasure to sell");
    if (handCount(p, "wild") < wild) throw new Error("not enough Wild to sell");
    const coins = balloons * COIN_VALUES.balloon + treasures * COIN_VALUES.treasure + wild * COIN_VALUES.wild;
    if (coins < move.buy.length * s.options.shopCost) throw new Error("not enough coins");
    const need: Record<StackId, number> = { defense: 0, mischief: 0, attack: 0 };
    for (const st of move.buy) need[st] += 1;
    for (const st of STACK_IDS) if (need[st] > s.stacks[st].length) throw new Error(`stack ${st} has too few cards`);
    return;
  }
  // THROW / PLAY_BIG (targeted)
  if (move.target === seat) throw new Error("cannot target yourself");
  const t = s.players[move.target];
  if (!t || t.out) throw new Error("target not a living player");
  if (move.kind === "THROW") {
    if (!handHas(p, "balloon")) throw new Error("no Water Balloon in hand");
  } else if (!handHas(p, move.big)) {
    throw new Error(`no ${move.big} in hand`);
  }
  if (move.soaker && !handHas(p, "soaker")) throw new Error("no Soaker Cannon in hand");
  if (move.spread) {
    if (!handHas(p, move.spread.modifier)) throw new Error(`no ${move.spread.modifier} in hand`);
    if (livingSeats(s).filter((x) => x !== seat).length < 2) throw new Error("spread needs >= 2 living opponents");
    for (const et of move.spread.extraTargets) {
      if (et === seat || !s.players[et] || s.players[et]!.out) throw new Error("invalid spread target");
    }
  }
}

function validateResolution(s: GameState, res: Resolution): void {
  if (s.over) throw new Error("game over");
  if (s.awaiting.kind === "DISCARD") {
    if (res.kind !== "DISCARD") throw new Error("must discard");
    const seat = actingSeat(s);
    const hand = s.players[seat]!.hand;
    const need = hand.length - s.options.handLimit;
    if (res.cardIds.length !== need) throw new Error(`must discard exactly ${need}`);
    if (new Set(res.cardIds).size !== res.cardIds.length) throw new Error("duplicate discard id");
    for (const id of res.cardIds) if (!hand.some((c) => c.id === id)) throw new Error(`card ${id} not in hand`);
    return;
  }
  if (res.kind === "DISCARD") throw new Error("not awaiting a discard");
  if (s.awaiting.kind === "REACT") {
    if (res.kind !== "REACT") throw new Error("must react");
    const reactor = actingSeat(s);
    const rp = s.players[reactor]!;
    const pa = s.pending!;
    if (res.action === "pass") return;
    if (res.action === "towel") {
      if (!handHas(rp, "towel")) throw new Error("no Towel in hand");
      return;
    }
    if (pa.kind === "SUPPORT") throw new Error("Redirect/Water Trap apply to attacks only");
    if (pa.redirectedSeats.includes(reactor)) throw new Error("already used a discrete reaction this attack");
    if (res.action === "redirect") {
      if (!handHas(rp, "redirect")) throw new Error("no Redirect in hand");
      if (res.target === undefined || res.target === reactor) throw new Error("invalid Redirect target");
      const t = s.players[res.target];
      if (!t || t.out) throw new Error("Redirect target not a living player");
      return;
    }
    if (!handHas(rp, "watertrap")) throw new Error("no Water Trap in hand");
    if (s.players[pa.attacker]!.out) throw new Error("cannot Water Trap a Storm Cloud's splash");
    return;
  }
  if (res.kind === "REACT") throw new Error("not awaiting a reaction");
  if (s.awaiting.kind === "EXTRA_THROW") {
    if (res.kind !== "EXTRA") throw new Error("must resolve the extra throw");
    if (res.action === "pass") return;
    const seat = actingSeat(s);
    const p = s.players[seat]!;
    if (res.target === undefined || res.target === seat) throw new Error("invalid extra-throw target");
    const t = s.players[res.target];
    if (!t || t.out) throw new Error("target not a living player");
    if (!handHas(p, "balloon")) throw new Error("no Water Balloon for the extra throw");
    if (res.soaker && !handHas(p, "soaker")) throw new Error("no Soaker Cannon in hand");
    return;
  }
  if (res.kind === "EXTRA") throw new Error("not awaiting an extra throw");
  const allowed = legalResolutions(s);
  const ok = allowed.some((r) =>
    r.kind === res.kind &&
    (r.kind === "DEFEND"
      ? r.defense === (res as Extract<Resolution, { kind: "DEFEND" }>).defense
      : r.kind === "ATTACKER_RESPOND"
        ? r.respond === (res as Extract<Resolution, { kind: "ATTACKER_RESPOND" }>).respond
        : false),
  );
  if (!ok) throw new Error(`illegal resolution for await ${s.awaiting.kind}`);
}

export function isLegalMove(s: GameState, move: Move): boolean {
  try {
    validateMove(s, move);
    return true;
  } catch {
    return false;
  }
}

// ---- applying input ---------------------------------------------------------

export function applyMove(state: GameState, move: Move): ApplyResult {
  validateMove(state, move);
  const s = clone(state);
  trimLog(s);
  s.reveals = []; // a fresh reduce produces its own peeks
  const seat = s.turnSeat;
  const events: GameEvent[] = [{ type: move.kind, seat, detail: move }];

  if (move.kind === "END_TURN") {
    endActiveTurn(s);
    return { state: s, awaiting: s.awaiting, events };
  }

  if (move.kind === "STORM_THROW") {
    // D5: the engine picks the target at random (no ganging up). The Storm Cloud
    // is the ladder attacker and may play Hit from its kept hand.
    const targets = livingSeats(s);
    const target = targets[Math.floor(rand(s) * targets.length)]!;
    s.stormThrowsUsed += 1;
    s.log.push(`Storm Cloud seat ${seat} splashes random target ${target}`);
    startThrow(s, seat, target, false);
    return { state: s, awaiting: s.awaiting, events };
  }

  if (move.kind === "PLAY_SUPPORT") {
    const supHand = s.players[seat]!.hand;
    const supIdx = supHand.findIndex((c) => c.kind === move.support);
    const [supCard] = supHand.splice(supIdx, 1);
    discardCard(s, supCard!);
    s.supportUsed = true;
    if (move.target !== undefined && TARGETED_SUPPORTS.has(move.support)) {
      // E11: a targeting Support opens a Towel window before it resolves.
      offerReaction(s, { kind: "SUPPORT", attacker: seat, target: move.target, support: move.support, redirectedSeats: [] });
    } else {
      applySupport(s, seat, move.support, move.target); // may draw (Backpack) -> resolve an Event
      if (s.over) {
        // game ended on a drawn Event; awaiting is already GAME_OVER
      } else if (s.players[seat]!.out) {
        endActiveTurn(s); // a Backpack-drawn Event soaked the player mid-turn
      } else {
        s.awaiting = { seats: [seat], kind: "MOVE" }; // Support does NOT end the turn
      }
    }
    return { state: s, awaiting: s.awaiting, events };
  }

  if (move.kind === "SHOP") {
    const hand = s.players[seat]!.hand;
    const sellKind = (kind: CardKind, n: number): void => {
      for (let i = 0; i < n; i++) {
        const idx = hand.findIndex((c) => c.kind === kind);
        const [c] = hand.splice(idx, 1);
        discardCard(s, c!);
      }
    };
    sellKind("balloon", move.sell.balloons);
    sellKind("treasure", move.sell.treasures);
    sellKind("wild", move.sell.wild);
    for (const st of move.buy) {
      const card = s.stacks[st].pop();
      if (card) hand.push(card);
    }
    s.log.push(`seat ${seat} shops -> buys [${move.buy.join(", ")}]`);
    endActiveTurn(s);
    return { state: s, awaiting: s.awaiting, events };
  }

  // THROW / PLAY_BIG: spend the card(s) + modifiers, then run the attack machine.
  if (move.kind === "THROW") {
    startThrow(s, seat, move.target, !!move.soaker, move.spread);
  } else {
    startBig(s, seat, move.target, move.big, !!move.soaker, move.spread);
  }
  return { state: s, awaiting: s.awaiting, events };
}

export function applyResolution(state: GameState, res: Resolution): ApplyResult {
  validateResolution(state, res);
  const s = clone(state);
  trimLog(s);
  s.reveals = [];
  const seat = actingSeat(s);
  const events: GameEvent[] = [{ type: res.kind, seat, detail: res }];
  if (res.kind === "DISCARD") {
    const hand = s.players[seat]!.hand;
    for (const id of res.cardIds) {
      const idx = hand.findIndex((c) => c.id === id);
      const [card] = hand.splice(idx, 1);
      discardCard(s, card!);
    }
    advanceTurn(s);
    return { state: s, awaiting: s.awaiting, events };
  }
  if (res.kind === "REACT") {
    const pa = s.pending!;
    if (res.action === "pass") {
      resolvePending(s);
      return { state: s, awaiting: s.awaiting, events };
    }
    if (res.action === "towel") {
      spendKind(s, seat, "towel"); // E11: cancel the targeting card outright
      s.log.push(`seat ${seat} Towels the ${pa.kind}`);
      s.pending = null;
      if (pa.kind === "SUPPORT") s.awaiting = { seats: [pa.attacker], kind: "MOVE" };
      else afterAttack(s, pa.kind === "PLAY_BIG" ? pa.big! : "basic");
      return { state: s, awaiting: s.awaiting, events };
    }
    // Redirect / Water Trap: spend the card, drop any spread (the redirected
    // instance is single-target — R3), re-open the window for the new target.
    pa.redirectedSeats.push(seat);
    pa.spread = undefined;
    if (res.action === "redirect") {
      spendKind(s, seat, "redirect");
      s.log.push(`seat ${seat} Redirects to ${res.target}`);
      pa.target = res.target!;
    } else {
      spendKind(s, seat, "watertrap");
      s.log.push(`seat ${seat} Water Traps -> bounces to ${pa.attacker}`);
      pa.target = pa.attacker; // the original attacker must now defend
      pa.attacker = seat; // the trapper's Hits resolve in the ladder
    }
    offerReaction(s, pa);
    return { state: s, awaiting: s.awaiting, events };
  }
  if (res.kind === "EXTRA") {
    if (res.action === "pass") {
      endActiveTurn(s); // E4: declined the extra throw
      return { state: s, awaiting: s.awaiting, events };
    }
    // Spend a Rapid Fire (preferred) or Launcher, then throw again.
    spendKind(s, seat, handHas(s.players[seat]!, "rapidfire") ? "rapidfire" : "launcher");
    startThrow(s, seat, res.target!, !!res.soaker);
    return { state: s, awaiting: s.awaiting, events };
  }
  const outcome = advanceLadder(s, res);
  if (outcome.resolved) resolveTarget(s, outcome.hit);
  return { state: s, awaiting: s.awaiting, events };
}

export function isGameOver(s: GameState): boolean {
  return s.over;
}
