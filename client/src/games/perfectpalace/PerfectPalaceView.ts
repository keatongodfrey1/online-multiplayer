/**
 * The Perfect Palace — in-game view (vanilla TS + DOM, no React).
 *
 * Renders the 30-square perimeter board, player panels, a phase-driven action
 * area, and the event log from room.state, and sends sanitized actions on
 * PerfectPalaceMsg.ACTION. The server is authoritative: the view never mutates
 * game state, never rolls dice, and never decides legality — it offers buttons
 * and the room accepts or ignores them. Turn alerts fire on the rising edge of
 * "I must act now" (my roll, a duel I'm in, a fine, a decision, a card).
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  PERFECT_PALACE_COLORS,
  PerfectPalaceEngine,
  PerfectPalaceMsg,
  type PerfectPalaceState,
  type PPSeat,
} from "@backbone/shared";
import { LobbyMsg } from "@backbone/shared";
import type { GameView, GameViewContext, LobbySettingsContext } from "../../framework/GameView.js";
import { escapeHtml } from "../../framework/dom.js";
import { hookSaveData, renderSaveSlots } from "../../framework/saveSlots.js";
import { clockChime, flashToast, isMuted, setMuted, turnChime } from "../../framework/turnAlert.js";

const { BOARD, CARDS, getSquare, RESOURCE_OPTIONS, PRICE, RECIPE, totalPoints, staffWeight, quickBuildCost } =
  PerfectPalaceEngine;

type PPCardEffect = (typeof CARDS)[number]["effect"];

/** Kid-friendly one-liner for a card's effect (deck reference). */
function cardEffectLabel(e: PPCardEffect): string {
  switch (e.kind) {
    case "gain-dollars": return `+$${e.amount}`;
    case "gain-bricks": return `+${e.amount} 🧱 bricks`;
    case "gain-sticks": return `+${e.amount} 🪵 sticks`;
    case "gain-bricks-and-sticks": return `+${e.bricks} 🧱 +${e.sticks} 🪵`;
    case "get-building": return "a free Building 🏢";
    case "get-server": return "a free Server 🍽️";
    case "get-chef": return "a free Chef 👨‍🍳";
    case "get-cleaner": return "a free Cleaner 🧹";
    case "get-room": return "a free Room 🚪";
    case "alliance-or-bonus": return "ally with the Kingdom (or +$50 if already allied)";
    case "draw-another": return "draw another card";
    case "royal-pardon": return "keep it to escape the dungeon ⛓️";
    case "get-bailiff": return "take the Bailiff 🎩";
    default: return "";
  }
}
const PP_SAVES_KEY = "perfectpalace-saves";

type Outcome = PerfectPalaceEngine.ResourceOutcome;
const BAILIFF_ITEMS = ["bricks", "sticks", "wall", "roof", "dollars"] as const;

/** "30s", "1 min", "1m30", "2 min" … for the turn-timer dropdown + countdown. */
function fmtSecs(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m}m${String(r).padStart(2, "0")}`;
}

/** Kid-friendly label for one resource-card face. */
function outcomeLabel(o: Outcome): string {
  switch (o.kind) {
    case "sticks": return `🪵 ${o.amount} sticks`;
    case "bricks": return `🧱 ${o.amount} bricks`;
    case "dollars": return `💰 $${o.amount}`;
    case "draw-card": return `🃏 draw a card`;
  }
}

/** (row,col) on the 10-wide × 7-tall perimeter for square 1..30. */
function squarePos(n: number): { row: number; col: number } {
  if (n <= 10) return { row: 1, col: n };          // top: #1..#10 -> col 1..10
  if (n <= 16) return { row: n - 9, col: 10 };     // right: #11..#16 -> row 2..7
  if (n <= 25) return { row: 7, col: 10 - (n - 16) }; // bottom: #17..#25 -> col 9..1
  return { row: 7 - (n - 25), col: 1 };            // left: #26..#30 -> row 6..2
}

const CORNERS = new Set([1, 10, 16, 25]);

type PPSquare = (typeof BOARD)[number];
type PPInv = PPSeat["inventory"];

/** A terse, glyphy "what happens here" line for a board square (full prose lives
 *  in the square-info callout + hover tooltip). Mirrors board.ts effect kinds. */
function shortEffect(def: PPSquare): string {
  const e = def.effect;
  switch (e.kind) {
    case "start": return "+$10 · swap 1 slot";
    case "royal-court": return "⛓️ to Dungeon";
    case "bricks-or-wall": return "🎁 10🧱 or 1 wall";
    case "dungeon-just-passing": return "—";
    case "gain-room": return "+🚪 Room";
    case "gain-resources": {
      const parts: string[] = [];
      if (e.bricks) parts.push(`+${e.bricks}🧱`);
      if (e.sticks) parts.push(`+${e.sticks}🪵`);
      if (e.dollars) parts.push(`+$${e.dollars}`);
      return parts.join(" ");
    }
    case "alliance-offer": return `🤝 ally ${e.cost.bricks}🧱+${e.cost.sticks}🪵`;
    case "invasion": return `⚔️ pay $${e.cost}`;
    case "lose-money": return `💸 pay $${e.amount}`;
    case "get-bailiff": return "🎩 take Bailiff";
    case "draw-cards": return `🃏 draw ${e.count}`;
    case "fortune-teller": return `🃏 draw ${e.count}`;
    case "trader-walls": return "🛒 $10 → 3 walls";
    case "trader-bricks": return "🛒 10🧱 → $15";
    case "half-price-cleaner": return "🧹 $10 each";
    case "get-server": return "+🍽️ Server";
    case "get-building": return "+🏢 Building";
    case "roll-again": return "🎲 roll again";
  }
}

const PP_OK = { ok: true, reason: "" } as const;
const ppHasRoom = (inv: PPInv): boolean =>
  inv.rooms + inv.buildings + inv.threeStoryBuildings + inv.palaces >= 1;

/** Mirror of the engine's canBuy (reducer.ts). PRESENTATION ONLY — the server
 *  re-validates every buy. Bias is toward false-enable: when unsure, leave the
 *  button clickable and let the room reject (a harmless no-op). */
function ppCanBuy(inv: PPInv, item: string): { ok: boolean; reason: string } {
  switch (item) {
    case "worker":
      return inv.dollars >= PRICE.worker ? PP_OK : { ok: false, reason: `Need $${PRICE.worker}.` };
    case "server":
    case "chef":
    case "cleaner": {
      if (!ppHasRoom(inv)) return { ok: false, reason: "Needs a Room first." };
      const price = item === "server" ? PRICE.server : item === "chef" ? PRICE.chef : PRICE.cleaner;
      return inv.dollars >= price ? PP_OK : { ok: false, reason: `Need $${price}.` };
    }
    case "knight":
      if (inv.knight) return { ok: false, reason: "Already own one." };
      return inv.dollars >= PRICE.knight ? PP_OK : { ok: false, reason: `Need $${PRICE.knight}.` };
    case "queen":
      if (inv.queen) return { ok: false, reason: "Already own one." };
      return inv.dollars >= PRICE.queen ? PP_OK : { ok: false, reason: `Need $${PRICE.queen}.` };
    default:
      return PP_OK;
  }
}

/** Mirror of the engine's canBuild (reducer.ts), incl. the Building/3-Story staff
 *  prereqs (a Whole-House-Cleaner counts as a Cleaner). PRESENTATION ONLY. */
function ppCanBuild(inv: PPInv, item: string): { ok: boolean; reason: string } {
  const eff = inv.cleaners + inv.wholeHouseCleaners;
  const no = (reason: string) => ({ ok: false, reason });
  switch (item) {
    case "wall":
      return inv.bricks >= RECIPE.wall.bricks ? PP_OK : no(`Need ${RECIPE.wall.bricks} bricks (have ${inv.bricks}).`);
    case "roof":
      return inv.sticks >= RECIPE.roof.sticks ? PP_OK : no(`Need ${RECIPE.roof.sticks} sticks (have ${inv.sticks}).`);
    case "room":
      if (inv.walls < RECIPE.room.walls) return no(`Need ${RECIPE.room.walls} walls (have ${inv.walls}).`);
      if (inv.roofs < RECIPE.room.roofs) return no(`Need ${RECIPE.room.roofs} roof (have ${inv.roofs}).`);
      return PP_OK;
    case "building":
      if (inv.rooms < RECIPE.building.rooms) return no(`Need ${RECIPE.building.rooms} rooms (have ${inv.rooms}).`);
      if (inv.servers + inv.chefs + eff < 1) return no("Need 1 staff (Server/Chef/Cleaner).");
      return PP_OK;
    case "threeStoryBuilding":
      if (inv.buildings < RECIPE.threeStoryBuilding.buildings) return no(`Need ${RECIPE.threeStoryBuilding.buildings} buildings (have ${inv.buildings}).`);
      if (inv.servers < 1) return no("Need a Server.");
      if (inv.chefs < 1) return no("Need a Chef.");
      if (eff < 1) return no("Need a Cleaner.");
      return PP_OK;
    case "palace":
      return inv.threeStoryBuildings >= RECIPE.palace.threeStoryBuildings
        ? PP_OK
        : no(`Need ${RECIPE.palace.threeStoryBuildings} 3-Story (have ${inv.threeStoryBuildings}).`);
    default:
      return no("");
  }
}

/** How many of `item` you could build right now (for the "Max ×N" quick-build).
 *  Over/under-estimates are safe: the engine builds the affordable prefix and
 *  stops, so a too-large count just caps itself. */
function ppBuildMax(inv: PPInv, item: string): number {
  switch (item) {
    case "wall": return Math.floor(inv.bricks / RECIPE.wall.bricks);
    case "roof": return Math.floor(inv.sticks / RECIPE.roof.sticks);
    case "room": return Math.min(Math.floor(inv.walls / RECIPE.room.walls), Math.floor(inv.roofs / RECIPE.room.roofs));
    default: return ppCanBuild(inv, item).ok ? 1 : 0;
  }
}

export class PerfectPalaceView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, PerfectPalaceState>;
  private ctx?: GameViewContext;
  private readonly onState = () => this.render();
  private readonly onClick = (e: MouseEvent) => this.handleClick(e);
  private readonly onChange = (e: Event) => this.handleChange(e);
  /** Local-only initial-mapping draft: slot i -> option index (a permutation). */
  private mappingDraft = [0, 1, 2, 3, 4, 5];
  /** Local-only fine forfeit selection. */
  private fineSel = { bricks: 0, sticks: 0, walls: 0, roofs: 0 };
  /** Rising-edge guard so a brand-new fine clears any stale forfeit selection. */
  private finePendingPrev = false;
  /** Local-only stepper drafts (amounts the player is adjusting before committing). */
  private tradeAmt: { bricks: number; sticks: number } = { bricks: 10, sticks: 10 };
  private traderQty = 1; // batches at the #8 / #29 trader squares
  private cleanerQty = 1; // cleaners at the #14 half-price square
  private duelStakeDraft: { kind: string; amount: number } = { kind: "dollars", amount: 5 };
  /** Per-row buy/build quantities (the +/- steppers). Keyed by item; clamped on
   *  every adjust + on render so a stale draft never exceeds what's affordable. */
  private buyQty: Record<string, number> = { brick: 5, stick: 5, worker: 1, server: 1, chef: 1, cleaner: 1 };
  private buildQty: Record<string, number> = { wall: 1, roof: 1 }; // turn/build
  private scratchQty: Record<string, number> = { room: 1, building: 1, threeStoryBuilding: 1, palace: 1 }; // turn/buildFromScratch
  /** Local-only Bailiff steal selection (so the "Take it" button can grey when the
   *  chosen target lacks the chosen item). */
  private stealSel: { target: string; item: string } = { target: "", item: "" };
  /** Dedup key for the card-draw reveal toast (the most recent `drew "…"` line). */
  private lastCardLine = "";
  /** Board square whose full explanation the info callout shows (tap to change);
   *  undefined = follow where you are. */
  private infoSquare?: number;
  private iWasActing = false;
  /** Whether the rules/help modal is open. */
  private showRules = false;
  /** Dice + card-reveal animations: portal elements (outside the re-rendered DOM) + timers. */
  private diceLayer?: HTMLElement;
  private cardLayer?: HTMLElement;
  /** Whether the "what's in the deck" reference modal is open. */
  private showDeck = false;
  private diceTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastSeenRollSeq = 0;
  /** Turn-timer countdown ticker + once-per-deadline chime guard. */
  private ticker?: ReturnType<typeof setInterval>;
  private clockChimedFor = 0;

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, PerfectPalaceState>;
    this.ctx = ctx;
    root.classList.add("pp");
    root.addEventListener("click", this.onClick);
    root.addEventListener("change", this.onChange);
    // Dice overlay lives on <body> so the full innerHTML re-render never wipes it
    // mid-tumble. Start in sync so a roll that happened before we joined doesn't replay.
    this.diceLayer = document.createElement("div");
    this.diceLayer.className = "pp-dice-layer";
    document.body.appendChild(this.diceLayer);
    // Card-reveal overlay shares the same body-portal pattern as the dice.
    this.cardLayer = document.createElement("div");
    this.cardLayer.className = "pp-card-layer";
    document.body.appendChild(this.cardLayer);
    this.lastSeenRollSeq = this.room.state?.lastRollSeq ?? 0;
    // Don't replay a card reveal for a draw that happened before we joined/resumed.
    this.lastCardLine = [...(this.room.state?.log ?? [])].reverse().find((l) => l.includes('drew "')) ?? "";
    hookSaveData(this.room, PP_SAVES_KEY, (blob) => (blob?.turnCount ?? 0) + 1, () =>
      flashToast(this.root!, "Game saved ✓"),
    );
    this.ticker = setInterval(() => this.updateTimer(), 500);
    this.room.onStateChange(this.onState);
    this.render();
  }

  unmount(): void {
    this.room?.onStateChange.remove(this.onState);
    this.root?.removeEventListener("click", this.onClick);
    this.root?.removeEventListener("change", this.onChange);
    this.root?.classList.remove("pp");
    for (const t of this.diceTimers) clearTimeout(t);
    this.diceTimers.clear();
    this.diceLayer?.remove();
    this.diceLayer = undefined;
    this.cardLayer?.remove();
    this.cardLayer = undefined;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.root = undefined;
    this.room = undefined;
  }

  /** Refresh the header countdown (cheap; runs every 500ms). */
  private updateTimer(): void {
    const el = this.root?.querySelector<HTMLElement>(".pp-timer");
    const state = this.room?.state;
    if (!el || !state) return;
    if (!state.turnSeconds || state.enginePhase === "game-over") {
      el.textContent = "";
      el.classList.remove("warn");
      return;
    }
    if (state.turnDeadline === 0) {
      el.textContent = "⏱ paused";
      el.classList.remove("warn");
      return;
    }
    const left = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
    el.textContent = `⏱ ${fmtSecs(left)}`;
    el.classList.toggle("warn", left <= 15);
    if (left <= 15 && left > 0 && state.currentTurn === this.ctx?.mySessionId && this.clockChimedFor !== state.turnDeadline) {
      this.clockChimedFor = state.turnDeadline;
      clockChime();
    }
  }

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.diceTimers.delete(t);
      fn();
    }, ms);
    this.diceTimers.add(t);
  }

  /** Tumble a die that lands on `value` (matching Space Chase's timing/feel). */
  private showDice(value: number, who: string): void {
    const layer = this.diceLayer;
    if (!layer) return;
    const FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];
    const face = (n: number) => FACES[Math.max(0, Math.min(5, n - 1))]!;
    layer.innerHTML = `<div class="pp-dice"><div class="pp-die"></div><div class="pp-die-cap">${escapeHtml(who)} rolled a ${value}</div></div>`;
    layer.classList.add("show");
    const die = layer.querySelector<HTMLElement>(".pp-die")!;
    let flips = 0;
    const spin = () => {
      if (flips++ > 6) {
        die.textContent = face(value);
        die.classList.add("landed");
        return;
      }
      die.textContent = face(Math.floor(Math.random() * 6) + 1);
      this.after(80, spin);
    };
    spin();
    this.after(1750, () => layer.classList.remove("show"));
  }

  /** Flip a drawn card into view (body portal, same pattern as the dice). Fires for
   *  every player's draw so the table sees what came up. */
  private showCard(name: string, effect: string, who: string): void {
    const layer = this.cardLayer;
    if (!layer) return;
    layer.innerHTML = `
      <div class="pp-card-reveal">
        <div class="pp-card-face">
          <div class="pp-card-face-top">🃏</div>
          <div class="pp-card-name">${escapeHtml(name)}</div>
          ${effect ? `<div class="pp-card-effect">${escapeHtml(effect)}</div>` : ""}
        </div>
        <div class="pp-card-cap">${escapeHtml(who)} drew a card</div>
      </div>`;
    layer.classList.add("show");
    this.after(2300, () => layer.classList.remove("show"));
  }

  // ---- identity helpers ----------------------------------------------------

  private mySeat(): PPSeat | undefined {
    const s = this.room?.state;
    return s ? [...s.seats].find((seat) => seat.sessionId === this.ctx?.mySessionId) : undefined;
  }
  private myId(): string {
    return this.mySeat()?.engineId ?? "";
  }
  private seatById(id: string): PPSeat | undefined {
    return [...(this.room?.state.seats ?? [])].find((s) => s.engineId === id);
  }

  /** Am I the one expected to act right now? Drives the turn chime. */
  private iMustAct(): boolean {
    const s = this.room?.state;
    const me = this.mySeat();
    if (!s || !me) return false;
    if (s.enginePhase === "game-over") return false;
    if (s.enginePhase === "initial-roll") return me.initialRoll <= 0;
    if (s.enginePhase === "initial-mapping") return !me.mappingLocked;
    if (s.turnPhase === "duel") {
      return !!s.duel && [...s.duel.contenders].includes(me.engineId) && !this.hasRolled(me.engineId);
    }
    return s.currentTurn === this.ctx?.mySessionId;
  }
  private hasRolled(id: string): boolean {
    const d = this.room?.state.duel;
    if (!d) return false;
    // Roll VALUES are redacted (0) until the duel resolves; membership in
    // rollPlayers is how we know someone has rolled.
    return [...d.rollPlayers].includes(id);
  }

  private send(action: Record<string, unknown>): void {
    this.room?.send(PerfectPalaceMsg.ACTION, action);
  }

  // ---- render --------------------------------------------------------------

  private render(): void {
    if (!this.root || !this.room?.state) return;
    const s = this.room.state;
    const me = this.mySeat();
    // A fresh server roll (seq bumped) tumbles the dice overlay.
    if (s.lastRollSeq > this.lastSeenRollSeq) {
      this.lastSeenRollSeq = s.lastRollSeq;
      this.showDice(s.lastRollValue, this.seatById(s.lastRollBy)?.nickname ?? "Someone");
    }
    const acting = this.iMustAct();
    if (acting && !this.iWasActing) {
      turnChime();
      flashToast(this.root, "Your turn!");
    }
    this.iWasActing = acting;

    // Card-draw reveal: when a new `<who> drew "<name>" — <effect>` line lands in the
    // log (any player's draw), flip a card overlay so the deck draw isn't just a quiet
    // log line.
    const lastCard = [...s.log].reverse().find((l) => l.includes('drew "')) ?? "";
    if (lastCard && lastCard !== this.lastCardLine) {
      this.lastCardLine = lastCard;
      const m = lastCard.match(/^(.*?) drew "(.+?)"(?: — (.+))?$/);
      if (m) this.showCard(m[2]!, m[3] ?? "", m[1]!);
      else flashToast(this.root, `🃏 ${lastCard}`);
    }

    // A brand-new fine (rising edge of finePending while it's my decision) clears
    // any leftover forfeit selection from a previous fine so it can't pre-fill an
    // invalid payment.
    const fineMine = !!s.finePending && s.currentTurn === this.ctx?.mySessionId;
    if (fineMine && !this.finePendingPrev) {
      this.fineSel = { bricks: 0, sticks: 0, walls: 0, roofs: 0 };
    }
    this.finePendingPrev = fineMine;

    // During the simultaneous initial pick, the board is idle — give the picker the
    // whole main area (it's cramped in the narrow side panel).
    const pickInCenter = s.enginePhase === "initial-mapping" && !!me && !me.mappingLocked;

    this.root.innerHTML = `
      <div class="pp-top">
        <div class="pp-title">The Perfect Palace</div>
        <div class="pp-phasebar">${escapeHtml(this.phaseHeadline())} <span class="pp-timer"></span></div>
        <div class="pp-toptools">
          <button class="pp-icon" data-action="rules" title="Rules & help">❓</button>
          <button class="pp-icon" data-action="mute" title="${isMuted() ? "Sounds off" : "Sounds on"}">${isMuted() ? "🔕" : "🔔"}</button>
          ${me ? `<button class="subtle" data-action="save">Save</button>` : ""}
        </div>
      </div>
      <div class="pp-main">
        <div class="pp-left">
          <div class="pp-boardwrap">${pickInCenter ? this.renderMappingPicker() : this.renderBoard()}</div>
          <div class="pp-underboard">
            <div class="pp-players">${this.renderPlayers()}</div>
            <div class="pp-log">${this.renderLog()}</div>
          </div>
        </div>
        <div class="pp-side">
          <div class="pp-sqinfo">${this.renderSquareInfo()}</div>
          <div class="pp-action">${this.renderAction()}</div>
        </div>
      </div>
      ${this.showRules ? this.renderRulesModal() : ""}
      ${this.showDeck ? this.renderDeckModal() : ""}`;
  }

  /** The always-present "what's on this square" callout. Tapping a board square
   *  pins it here; otherwise it follows where you are (your token). */
  private renderSquareInfo(): string {
    const s = this.room!.state;
    const me = this.mySeat();
    const focus = this.infoSquare ?? me?.position ?? this.seatById(s.currentPlayerId)?.position ?? 1;
    const def = getSquare(focus);
    const fx = shortEffect(def);
    return `
      <div class="pp-sqinfo-head">
        <span class="pp-sqinfo-n">#${def.number}</span>
        <strong>${escapeHtml(def.label)}</strong>
        ${fx ? `<span class="pp-sqinfo-fx">${escapeHtml(fx)}</span>` : ""}
      </div>
      <div class="pp-sqinfo-body">${escapeHtml(def.flavor ?? "")}</div>`;
  }

  /** A condensed, kid-friendly rulebook (ported from the standalone RulesModal). */
  private renderRulesModal(): string {
    return `
      <div class="pp-modal-backdrop">
        <div class="pp-modal">
          <div class="pp-modal-header">
            <h2>📖 How to play</h2>
            <button class="pp-icon" data-action="closeRules" title="Close">✕</button>
          </div>
          <div class="pp-rules-body">
            <h3>🎯 Goal</h3>
            <p>Build a <b>Palace</b> first. When someone builds one, everyone gets the same number of turns, then the <b>most points</b> wins.</p>

            <h3>🎴 Your resource card</h3>
            <p>You map die faces 1–6 to six rewards (5🪵, 5🧱, 10🧱, $5, $10, draw a card). Whenever <i>anyone</i> rolls, <i>every</i> player gains what their own card says for that number. Pass or land on Start for +$10 and a credit to swap one card slot — spend it from the <b>🎴 Your roll card</b> panel on your turn (it swaps two faces).</p>

            <h3>🎲 Your turn</h3>
            <p>If you hold the Bailiff you may steal first. <b>Roll</b> (everyone gains from their card), move, and trigger the square. Then <b>shop, trade, and build</b> as much as you like, and end your turn.</p>

            <h3>🏗 Build ladder (points)</h3>
            <ul>
              <li>Wall = 5🧱 · Roof = 5🪵</li>
              <li>Room = 4 walls + 1 roof — <b>5 pts</b></li>
              <li>Building = 3 rooms + any 1 staff — <b>20 pts</b></li>
              <li>3-Story = 3 buildings + a Server, Chef &amp; Cleaner — <b>75 pts</b></li>
              <li>Palace = 3 three-storys — <b>300 pts</b></li>
            </ul>

            <h3>🛍 Shop (on your turn)</h3>
            <p>🧱/🪵 $1 each (in $5 bundles) · 👷 Worker $50 · 🍽️ Server $15 · 👨‍🍳 Chef $30 · 🧹 Cleaner $20 (these need a Room) · 🛡️ Knight $75 (blocks the Bailiff) · 👑 Queen $300 (200 pts).</p>
            <p>👷 A <b>Worker</b> makes resources for you at the start of every turn — choose <b>+1 wall +1 roof</b> or <b>+2 walls</b> per worker. Collect <b>5 Cleaners</b> (with a Building) and they fuse into a <b>Whole-House Cleaner</b> that pays <b>$15 every turn</b>.</p>
            <p>🏗 <b>Build from scratch</b>: once you have the cash, click <b>Build Room/Building/…</b> and it buys the missing bricks/sticks and assembles in one step (a Room from nothing is $25).</p>

            <h3>🃏 The card deck</h3>
            <p>Fortune-Teller squares (15 &amp; 23) and some effects make you <i>draw</i>. Cards give cash, bricks/sticks, or a free Room/Server/Chef/Cleaner/Building; others ally you with the Kingdom, hand you the Bailiff, or are a <b>Royal Pardon</b> you keep to escape the dungeon. A drawn card pops up and is noted in the log.</p>

            <h3>🎩 The Bailiff</h3>
            <p>Pick it up on squares 5, 13, 27 or by card. You may steal 1 wall, 1 roof, 5🧱, 5🪵, or $5 from any opponent who doesn't hold a Knight — <b>once per turn</b>. Your steal window opens either <i>before your roll</i> (if you already hold it), or <i>right when you grab it</i> (by a card before you move, or by landing on 5/13/27 after you move). Land in the dungeon and you drop it back to the middle.</p>

            <h3>⛓️ The Dungeon</h3>
            <p>Landing on Royal Court (10) sends you to the dungeon: no moving, buying, or building (but you still collect resources from everyone's rolls). Escape three ways: <b>roll a 1</b>, or your <b>3rd turn</b> there frees you anyway, or play a <b>Royal Pardon</b> card to pop out to Just Passing and take a full normal turn. You drop the Bailiff when you're sent in.</p>

            <h3>⚔️ Same-square duel</h3>
            <p>Land where another player sits and you duel: the arriver sets a stake, everyone matches and rolls — highest roll takes the whole pot (ties re-roll).</p>

            <h3>🤝 Alliances</h3>
            <p>Become allied at a Neighboring Kingdom square (3 or 20) by paying the bricks/sticks, or via the "Ally with the Kingdom" card. Once allied (it's permanent — you'll see a 🤝 badge): the <b>$100 invasion tribute</b> on 7 &amp; 28 is waived, the Ally card pays you <b>+$50</b> instead, and landing on an alliance square again gives you those bricks/sticks <b>for free</b>.</p>

            <h3>💸 Fines &amp; invasions</h3>
            <p>Squares 7, 11 &amp; 28 charge you. Cash is taken first; if you're short you forfeit items (🧱/🪵 = $1, wall/roof = $5). An Alliance waives the $100 invasion tribute (above).</p>

            <h3>🔁 Roll Again (square 24)</h3>
            <p>You take another turn immediately — but the landing turn <b>skips the shop/build/trade step</b> (you go straight to your next roll), and the bonus turn <b>doesn't count</b> toward the equal-turns finish.</p>

            <h3>🏁 Winning &amp; ties</h3>
            <p>The first Palace starts the finish: every other player gets exactly <b>one more turn</b> so everyone has had the same number of turns (Roll-Again bonus turns don't count). Then the game ends and the <b>most points</b> wins. Tie-break by total staff (Queen = 10, Whole-House-Cleaner = 5, others = 1), then by most cash.</p>
          </div>
        </div>
      </div>`;
  }

  /** A reference of every card in the deck (tapped from the deck pile). Static —
   *  which specific cards are left is hidden, so no live odds. */
  private renderDeckModal(): string {
    const items = [...CARDS]
      .map((c) => `<li><b>${escapeHtml(c.name)}</b> — ${escapeHtml(cardEffectLabel(c.effect))}</li>`)
      .join("");
    return `
      <div class="pp-modal-backdrop">
        <div class="pp-modal">
          <div class="pp-modal-header">
            <h2>🃏 What's in the deck</h2>
            <button class="pp-icon" data-action="closeDeck" title="Close">✕</button>
          </div>
          <div class="pp-rules-body">
            <p>The deck holds these <b>${CARDS.length} cards</b> (one of each), shuffled. Drawn cards go to the discard pile; the deck reshuffles when it runs out. You only see how many cards are left, not which ones.</p>
            <ul class="pp-deck-list">${items}</ul>
          </div>
        </div>
      </div>`;
  }

  private phaseHeadline(): string {
    const s = this.room!.state;
    if (s.enginePhase === "game-over") return "Game over";
    if (s.enginePhase === "initial-roll") return "Everyone: roll for turn order";
    if (s.enginePhase === "initial-mapping") return "Everyone: pick your resource card";
    const turnSeat = this.seatById(s.currentPlayerId);
    const who = turnSeat?.nickname ?? "…";
    if (s.turnPhase === "duel") return `Duel at #${s.duel?.squareNumber ?? "?"}!`;
    const mine = s.currentTurn === this.ctx?.mySessionId;
    const turnLabel = mine ? "Your turn" : `${who}'s turn`;
    // Endgame: a Palace has been built — everyone gets one last turn to catch up.
    if (s.palaceBuiltBy) {
      const builder = this.seatById(s.palaceBuiltBy)?.nickname ?? "Someone";
      return `🏁 Final turns — ${builder} built a Palace! · ${turnLabel}`;
    }
    return turnLabel;
  }

  // ---- board ---------------------------------------------------------------

  private renderBoard(): string {
    const s = this.room!.state;
    const cells: string[] = [];
    for (const def of BOARD) {
      const { row, col } = squarePos(def.number);
      const here = [...s.seats].filter((seat) => seat.position === def.number && !seat.gone);
      const tokens = here
        .map(
          (seat) =>
            `<span class="pp-token" style="background:${PERFECT_PALACE_COLORS[seat.colorIndex] ?? "#888"}" title="${escapeHtml(seat.nickname)}"></span>`,
        )
        .join("");
      const corner = CORNERS.has(def.number) ? " pp-corner" : "";
      const selected = def.number === this.infoSquare ? " pp-sq-sel" : "";
      const fx = shortEffect(def);
      cells.push(`
        <div class="pp-sq${corner}${selected}" data-sq="${def.number}" style="grid-row:${row};grid-column:${col}" title="${escapeHtml(def.flavor ?? def.label)}">
          <div class="pp-sq-n">${def.number}</div>
          <div class="pp-sq-l">${escapeHtml(def.label)}</div>
          ${fx ? `<div class="pp-sq-fx">${escapeHtml(fx)}</div>` : ""}
          <div class="pp-sq-tokens">${tokens}</div>
        </div>`);
    }
    const bailiff =
      s.bailiffKind === "held"
        ? `Bailiff: ${escapeHtml(this.seatById(s.bailiffBy)?.nickname ?? "?")}`
        : "Bailiff: in the middle";
    cells.push(`
      <div class="pp-crest" style="grid-row:2/7;grid-column:2/10">
        <div class="pp-crest-emoji">🏰</div>
        <div class="pp-crest-bailiff">🎩 ${bailiff}</div>
        <div class="pp-crest-deck" data-action="deckRef" title="What's in the deck?">🃏 Deck: ${s.deckCount} · Discard: ${s.discardCount} ⓘ</div>
      </div>`);
    return `<div class="pp-board">${cells.join("")}</div>`;
  }

  // ---- players -------------------------------------------------------------

  private renderPlayers(): string {
    const s = this.room!.state;
    return [...s.seats]
      .map((seat) => {
        const isTurn = seat.engineId === s.currentPlayerId && s.enginePhase !== "game-over";
        const me = seat.sessionId === this.ctx?.mySessionId;
        const isBot = !seat.gone && s.players.get(seat.sessionId)?.isBot === true;
        const inv = seat.inventory;
        const color = PERFECT_PALACE_COLORS[seat.colorIndex] ?? "#888";
        const nameTag = me ? " (you)" : isBot ? " 🤖" : seat.gone ? " · empty seat" : "";
        const badges = [
          inv.allied ? "🤝" : "",
          inv.queen ? "👑" : "",
          inv.knight ? "🛡️" : "",
          s.bailiffKind === "held" && s.bailiffBy === seat.engineId ? "🎩" : "",
          seat.inDungeon ? `⛓️ ${seat.dungeonTurnsServed}/3` : "",
          inv.pardonCards > 0 ? "📜" : "",
          seat.gone ? "🚪 reclaimable" : "",
        ].filter(Boolean).join(" ");
        return `
          <div class="pp-pcard${isTurn ? " pp-pcard-turn" : ""}${seat.gone ? " pp-pcard-gone" : ""}">
            <div class="pp-pcard-head">
              <span class="pp-dot" style="background:${color}"></span>
              <strong>${escapeHtml(seat.nickname)}${nameTag}</strong>
              <span class="pp-badges">${badges}</span>
              <span class="pp-pts">${totalPoints(inv as any)} pts</span>
            </div>
            <div class="pp-pcard-inv">
              💰$${inv.dollars} · 🧱${inv.bricks} · 🪵${inv.sticks} ·
              🧱walls ${inv.walls} · 🏠roofs ${inv.roofs} · 🚪rooms ${inv.rooms} ·
              🏢${inv.buildings} · 🏯${inv.threeStoryBuildings} · 🏰${inv.palaces}
              ${inv.workers || inv.servers || inv.chefs || inv.cleaners || inv.wholeHouseCleaners
                ? `· staff: 👷${inv.workers} 🍽️${inv.servers} 👨‍🍳${inv.chefs} 🧹${inv.cleaners} 🧼${inv.wholeHouseCleaners}`
                : ""}
            </div>
          </div>`;
      })
      .join("");
  }

  private renderLog(): string {
    const log = [...(this.room!.state.log ?? [])].slice(-14).reverse();
    return `<div class="pp-log-title">Game log</div>${log
      .map((l) => `<div class="pp-log-line">${escapeHtml(l)}</div>`)
      .join("")}`;
  }

  // ---- the phase-driven action area ----------------------------------------

  private renderAction(): string {
    const s = this.room!.state;
    const me = this.mySeat();
    if (!me) return `<div class="pp-act-wait">Spectating…</div>`;
    if (s.enginePhase === "game-over") return `<div class="pp-act-wait">The game is over.</div>`;

    if (s.enginePhase === "initial-roll") return this.renderInitialRoll(me);

    if (s.enginePhase === "initial-mapping") {
      const locked = [...s.seats].filter((seat) => seat.mappingLocked).length;
      return me.mappingLocked
        ? `<div class="pp-act-wait">Card locked in — waiting for the others… (${locked}/${s.seats.length} ready)</div>`
        : `<div class="pp-act-wait">⬅ Pick your resource card in the middle, then lock it in. (${locked}/${s.seats.length} ready)</div>`;
    }

    if (s.turnPhase === "duel") return this.renderDuel();

    const myTurn = s.currentTurn === this.ctx?.mySessionId;
    if (!myTurn) {
      const who = this.seatById(s.currentPlayerId)?.nickname ?? "…";
      return `<div class="pp-act-wait">Waiting for <strong>${escapeHtml(who)}</strong>…</div>`;
    }

    switch (s.turnPhase) {
      case "turn-start":
        return this.renderTurnStart(me);
      case "pre-move-bailiff":
        return this.renderBailiffSteal("pre-move");
      case "post-roll-bailiff":
        return this.renderBailiffSteal("post-roll");
      case "square-effect":
        return this.renderDecision(me);
      case "optional-actions":
        return this.renderOptional(me);
      default:
        return `<div class="pp-act-wait">…</div>`;
    }
  }

  /** The opening turn-order roll: everyone clicks to roll, highest goes first.
   *  Rolls show as they land; a tie clears the tied players to roll again. */
  private renderInitialRoll(me: PPSeat): string {
    const s = this.room!.state;
    const rolled = me.initialRoll > 0;
    const seats = [...s.seats].filter((seat) => !seat.gone);
    const order = seats
      .map((seat) => `${escapeHtml(seat.nickname)}: ${seat.initialRoll > 0 ? `🎲 ${seat.initialRoll}` : "…"}`)
      .join(" · ");
    return `
      <div class="pp-act-title">🎲 Roll for turn order</div>
      <p class="pp-hint">Everyone rolls — highest goes first (ties roll again). ${rolled ? "Waiting for the others…" : "Tap to roll!"}</p>
      ${rolled
        ? `<div class="pp-act-wait">You rolled <strong>${me.initialRoll}</strong> — waiting for the rest.</div>`
        : `<button class="pp-primary" data-action="initRoll">🎲 Roll the die</button>`}
      <div class="pp-duel-rolls">${order}</div>`;
  }

  private renderMappingPicker(): string {
    const slots = this.mappingDraft
      .map((optIdx, slot) => {
        const opts = RESOURCE_OPTIONS.map(
          (o, i) => `<option value="${i}" ${i === optIdx ? "selected" : ""}>${escapeHtml(outcomeLabel(o))}</option>`,
        ).join("");
        return `
          <div class="pp-map-slot">
            <span class="pp-die pp-die-lg">${slot + 1}</span>
            <span class="pp-map-arrow">→</span>
            <select data-map-slot="${slot}">${opts}</select>
          </div>`;
      })
      .join("");
    return `
      <div class="pp-card-pick">
        <div class="pp-act-title">🎴 Pick your resource card</div>
        <p class="pp-hint">Map each die face <b>1–6</b> to a reward. Every reward is used exactly once. Whenever <i>anyone</i> rolls, you collect what your card says for that number — so choose what you want most. Tweak it or keep the default, then lock it in.</p>
        <div class="pp-map-grid">${slots}</div>
        <button class="pp-primary pp-map-lock" data-action="lockMapping">Lock it in ✓</button>
      </div>`;
  }

  private renderTurnStart(me: PPSeat): string {
    const s = this.room!.state;
    if (me.inDungeon) {
      return `
        <div class="pp-act-title">You're in the dungeon ⛓️ (${me.dungeonTurnsServed}/3)</div>
        <p class="pp-hint">Roll a <b>1</b> to break out — or your <b>3rd turn</b> here frees you anyway. You still collect resources from every roll. ${me.inventory.pardonCards > 0 ? "Or use a Royal Pardon to pop out and take a full normal turn." : ""}</p>
        <button class="pp-primary" data-action="roll">🎲 Roll</button>
        ${me.inventory.pardonCards > 0 ? `<button class="pp-secondary" data-action="redeemPardon">📜 Use Royal Pardon</button>` : ""}`;
    }
    const holdsBailiff = s.bailiffKind === "held" && s.bailiffBy === me.engineId && !s.bailiffStealUsed;
    return `
      <div class="pp-act-title">Your move</div>
      ${holdsBailiff ? this.renderStealControls("pre-roll") : ""}
      <button class="pp-primary" data-action="roll">🎲 Roll the die</button>`;
  }

  private renderBailiffSteal(phase: "pre-move" | "post-roll"): string {
    return `
      <div class="pp-act-title">Use the Bailiff 🎩</div>
      ${this.renderStealControls(phase)}
      <button class="pp-secondary" data-action="bailiffSkip" data-phase="${phase}">Skip</button>`;
  }

  /** Does `seat` hold enough of `item` for a Bailiff steal to land? (mirrors the
   *  engine's BAILIFF_STEAL_AMOUNTS thresholds). */
  private stealHas(seat: PPSeat, item: string): boolean {
    const inv = seat.inventory;
    switch (item) {
      case "bricks": return inv.bricks >= 5;
      case "sticks": return inv.sticks >= 5;
      case "wall": return inv.walls >= 1;
      case "roof": return inv.roofs >= 1;
      case "dollars": return inv.dollars >= 5;
      default: return false;
    }
  }

  private renderStealControls(phase: "pre-roll" | "pre-move" | "post-roll"): string {
    const s = this.room!.state;
    const targets = [...s.seats].filter(
      (seat) => seat.engineId !== this.myId() && !seat.removed && !seat.inventory.knight,
    );
    if (targets.length === 0) return `<p class="pp-hint">No one to steal from right now.</p>`;
    // Keep the local selection valid against the current targets/items.
    if (!targets.some((t) => t.engineId === this.stealSel.target)) this.stealSel.target = targets[0]!.engineId;
    if (!BAILIFF_ITEMS.includes(this.stealSel.item as any)) this.stealSel.item = BAILIFF_ITEMS[0];
    const targetOpts = targets
      .map((t) => `<option value="${t.engineId}" ${t.engineId === this.stealSel.target ? "selected" : ""}>${escapeHtml(t.nickname)}</option>`)
      .join("");
    const itemOpts = BAILIFF_ITEMS.map(
      (it) => `<option value="${it}" ${it === this.stealSel.item ? "selected" : ""}>${it}</option>`,
    ).join("");
    const targetSeat = targets.find((t) => t.engineId === this.stealSel.target);
    const canTake = !!targetSeat && this.stealHas(targetSeat, this.stealSel.item);
    return `
      <div class="pp-steal">
        <span class="pp-hint">Steal once this turn:</span>
        <select data-steal="target">${targetOpts}</select>
        <select data-steal="item">${itemOpts}</select>
        <button class="pp-secondary" data-action="bailiffSteal" data-phase="${phase}" ${canTake ? "" : `disabled title="They don't have that to take."`}>Take it 🎩</button>
        ${canTake ? "" : `<span class="pp-reason">Nothing of that to take</span>`}
      </div>`;
  }

  private renderDecision(me: PPSeat): string {
    const s = this.room!.state;
    if (s.finePending) {
      const owed = s.fineAmount;
      const sel = this.fineSel;
      const value = sel.bricks * 1 + sel.sticks * 1 + sel.walls * 5 + sel.roofs * 5;
      const valid = this.fineValid(owed, me);
      const counter = (k: keyof typeof sel, label: string, have: number, unit: number) => {
        // + is blocked once you hold no more, or once one more would overpay — so
        // the selection can never exceed what the engine accepts.
        const plusOff = sel[k] >= have || value + unit > owed;
        return `
          <div class="pp-fine-row">
            <span class="pp-fine-label">${label} <span class="pp-sub">have ${have} · $${unit} ea</span></span>
            <button class="pp-step" data-action="fineAdjust" data-fine="-" data-k="${k}" ${sel[k] <= 0 ? "disabled" : ""}>−</button>
            <span class="pp-fine-n">${sel[k]}</span>
            <button class="pp-step" data-action="fineAdjust" data-fine="+" data-k="${k}" ${plusOff ? "disabled" : ""}>+</button>
          </div>`;
      };
      return `
        <div class="pp-act-title">Pay the fine 💸</div>
        <p class="pp-hint">You owe <strong>$${owed}</strong> in items (your cash is already gone). Forfeit items to cover it — 🧱/🪵 = $1, wall/roof = $5. You can't overpay.</p>
        ${counter("bricks", "🧱 bricks", me.inventory.bricks, 1)}
        ${counter("sticks", "🪵 sticks", me.inventory.sticks, 1)}
        ${counter("walls", "🧱 walls", me.inventory.walls, 5)}
        ${counter("roofs", "🏠 roofs", me.inventory.roofs, 5)}
        <div class="pp-fine-total${valid ? " pp-ok" : ""}">Selected: $${value} / $${owed}${valid ? " ✓" : ""}</div>
        <div class="pp-fine-actions">
          <button class="pp-secondary" data-action="fineAuto">✨ Auto-fill</button>
          <button class="pp-primary" data-action="payFine" ${valid ? "" : "disabled"}>Pay $${value}</button>
        </div>`;
    }
    const sq = getSquare(me.position);
    if (sq.effect.kind === "alliance-offer") {
      // Already allied → the engine auto-grants the resources, no decision pauses;
      // just offer Continue (showing Accept/Decline here would dead-click).
      if (me.inventory.allied) {
        return `<button class="pp-secondary" data-action="advance">Continue</button>`;
      }
      const cost = sq.effect.cost;
      const afford = me.inventory.bricks >= cost.bricks && me.inventory.sticks >= cost.sticks;
      const need = `Need ${cost.bricks}🧱 + ${cost.sticks}🪵`;
      return `
        <div class="pp-act-title">Alliance offered 🤝</div>
        <p class="pp-hint">${escapeHtml(sq.flavor ?? "")}</p>
        <p class="pp-hint">Allying is permanent: it waives the $100 invasion tribute (7 &amp; 28), turns the Ally card into +$50, and makes future alliance squares free.</p>
        <button class="pp-primary" data-action="alliance" data-choice="accept" ${afford ? "" : `disabled title="${need}"`}>Accept</button>
        <button class="pp-secondary" data-action="alliance" data-choice="decline">Decline</button>
        ${afford ? "" : `<span class="pp-reason">${need}</span>`}`;
    }
    if (sq.effect.kind === "bricks-or-wall") {
      return `
        <div class="pp-act-title">A royal gift 🎁</div>
        <button class="pp-primary" data-action="gift" data-choice="bricks">Take 10 🧱 bricks</button>
        <button class="pp-primary" data-action="gift" data-choice="wall">Take 1 🧱 wall</button>`;
    }
    return `<button class="pp-secondary" data-action="advance">Continue</button>`;
  }

  /** Exact mirror of the engine's no-overpay rule (reducer.ts payFine): a
   *  selection is payable when it equals what's owed, or is below it but no held
   *  item can be added without exceeding (the max-feasible "stiff" case). */
  private fineValid(owed: number, me: PPSeat): boolean {
    const sel = this.fineSel;
    const inv = me.inventory;
    const value = sel.bricks + sel.sticks + sel.walls * 5 + sel.roofs * 5;
    if (value > owed) return false;
    if (value === owed) return true;
    const canAdd =
      (sel.bricks < inv.bricks && value + 1 <= owed) ||
      (sel.sticks < inv.sticks && value + 1 <= owed) ||
      (sel.walls < inv.walls && value + 5 <= owed) ||
      (sel.roofs < inv.roofs && value + 5 <= owed);
    return !canAdd;
  }

  /** Fill fineSel with the cheapest engine-valid forfeit (mirrors the bot's
   *  payFineAction: $1 items first to hit the exact amount, then $5 items). */
  private fineAutoFill(owed: number, me: PPSeat): void {
    const inv = me.inventory;
    let need = owed;
    const bricks = Math.min(inv.bricks, need); need -= bricks;
    const sticks = Math.min(inv.sticks, need); need -= sticks;
    let fives = Math.floor(need / 5);
    const walls = Math.min(inv.walls, fives); fives -= walls;
    const roofs = Math.min(inv.roofs, fives);
    this.fineSel = { bricks, sticks, walls, roofs };
  }

  /** Stake resource types, in preference order, with the engine's minimums/steps. */
  private static DUEL_TYPES: ReadonlyArray<{ kind: string; field: keyof PPInv; emoji: string; min: number; step: number; unit: string }> = [
    { kind: "dollars", field: "dollars", emoji: "💰", min: 5, step: 5, unit: "$" },
    { kind: "bricks", field: "bricks", emoji: "🧱", min: 5, step: 5, unit: "bricks" },
    { kind: "sticks", field: "sticks", emoji: "🪵", min: 5, step: 5, unit: "sticks" },
    { kind: "wall", field: "walls", emoji: "🧱", min: 1, step: 1, unit: "wall" },
    { kind: "roof", field: "roofs", emoji: "🏠", min: 1, step: 1, unit: "roof" },
    { kind: "room", field: "rooms", emoji: "🚪", min: 1, step: 1, unit: "room" },
  ];

  private renderDuel(): string {
    const s = this.room!.state;
    const d = s.duel;
    const me = this.mySeat();
    if (!d || !me) return "";
    const contender = [...d.contenders].includes(me.engineId);
    const arriver = s.currentPlayerId === me.engineId;
    const stakeSet =
      d.stake.dollars + d.stake.bricks + d.stake.sticks + d.stake.walls + d.stake.roofs + d.stake.rooms > 0;
    const names = [...d.contenders].map((id) => this.seatById(id)?.nickname ?? id).join(" vs ");
    let inner = `<div class="pp-act-title">⚔️ Duel: ${escapeHtml(names)}</div>`;

    if (!stakeSet) {
      if (arriver) {
        // Max stake everyone can match, per resource type (the engine rejects a
        // stake any participant can't cover).
        const invs = [...d.participants].map((id) => this.seatById(id)?.inventory).filter(Boolean) as PPInv[];
        const minAll = (f: keyof PPInv) => Math.min(...invs.map((inv) => Number(inv[f])));
        const types = PerfectPalaceView.DUEL_TYPES.map((t) => ({ ...t, max: minAll(t.field) })).filter(
          (t) => t.max >= t.min,
        );
        if (types.length === 0) {
          inner += `<p class="pp-hint">Nobody here can cover even the smallest stake.</p>
            <button class="pp-secondary" data-action="duelCancel">Skip duel — no stake</button>`;
          return inner;
        }
        // Keep the draft valid against what's affordable.
        let sel = types.find((t) => t.kind === this.duelStakeDraft.kind);
        if (!sel) { sel = types[0]!; this.duelStakeDraft = { kind: sel.kind, amount: sel.min }; }
        const amount = Math.max(sel.min, Math.min(sel.max, this.duelStakeDraft.amount));
        this.duelStakeDraft.amount = amount;
        const chips = types
          .map((t) => `<button class="pp-chip${t.kind === sel!.kind ? " pp-chip-on" : ""}" data-action="duelKind" data-kind="${t.kind}">${t.emoji} ${t.unit}</button>`)
          .join("");
        inner += `<p class="pp-hint">You arrived — set the stake everyone matches (highest roll takes the pot):</p>
          <div class="pp-duel-types">${chips}</div>
          <div class="pp-duel-stakebar">
            ${this.stepper("duel", amount)}
            <span class="pp-sub">${sel.emoji} ${sel.unit} · max ${sel.max}</span>
            <button class="pp-primary" data-action="duelStake">Set stake</button>
          </div>`;
      } else {
        inner += `<p class="pp-hint">Waiting for the stake…</p>`;
      }
    } else if (contender && !this.hasRolled(me.engineId)) {
      inner += `<p class="pp-hint">Stakes are in. Roll for the pot — no one sees the rolls until everyone has rolled.</p>
        <button class="pp-primary" data-action="duelRoll">🎲 Roll</button>`;
    } else {
      inner += `<p class="pp-hint">Waiting for the other duelists to roll…</p>`;
    }

    // Who has rolled — values stay hidden until the duel resolves (revealed in the log).
    const status = [...d.contenders]
      .map((id) => `${escapeHtml(this.seatById(id)?.nickname ?? id)}: ${this.hasRolled(id) ? "✓ rolled" : "…"}`)
      .join(" · ");
    if (stakeSet) inner += `<div class="pp-duel-rolls">${status}</div>`;
    return inner;
  }

  private renderOptional(me: PPSeat): string {
    const inv = me.inventory;
    const sq = getSquare(me.position);
    const D = inv.dollars;

    // A buy/build button + price chip. `disabled` greys it; `reason` explains why.
    const qtyBtn = (
      action: "buy" | "build",
      item: string,
      dataAttr: string,
      label: string,
      cost: string,
      disabled: boolean,
      reason = "",
    ) =>
      `<button class="pp-qty-btn" data-action="${action}" data-item="${item}" ${dataAttr} ${disabled ? "disabled" : ""}${reason ? ` title="${escapeHtml(reason)}"` : ""}>${label}${cost ? `<span class="pp-price">${cost}</span>` : ""}</button>`;

    // Bricks & sticks: sold ONLY in $5 bundles of 5 (PRICE is $1 each). A +/- stepper
    // picks the amount (in 5s); "Max" jumps to the largest affordable whole-5 bundle.
    const buyStepRow = (item: "brick" | "stick", emoji: string, name: string, hint: string) => {
      const qty = this.buyQty[item]!; // a multiple of 5
      const cost = qty * PRICE[item]; // $1 each
      const max5 = Math.floor(D / 5) * 5; // largest affordable whole-5 bundle
      const can = D >= cost && qty >= 5;
      const maxBtn = max5 > qty ? qtyBtn("buy", item, `data-qty="${max5}"`, "Max", `$${max5}`, false) : "";
      return `<div class="pp-shop-row${D < 5 ? " pp-cant" : ""}">
        <span class="pp-shop-name">${emoji} ${name} <span class="pp-sub">${hint}</span></span>
        <span class="pp-shop-actions">
          ${this.stepper(`buy-${item}`, qty)}
          ${qtyBtn("buy", item, `data-qty="${qty}"`, `+${qty}`, `$${cost}`, !can)}
          ${maxBtn}
          ${D < 5 ? `<span class="pp-reason">Need $5</span>` : ""}
        </span>
      </div>`;
    };

    // Staff (worker/server/chef/cleaner): a +/- stepper (step 1) buys several in one
    // click. The engine's buy loop stops when cash or the Room prereq runs out, so an
    // optimistic qty is a safe no-op past the limit. `desc` says what the staffer does.
    const staffStepRow = (item: string, emoji: string, name: string, desc: string) => {
      const { ok, reason } = ppCanBuy(inv, item);
      const price = PRICE[item as keyof typeof PRICE];
      const qty = this.buyQty[item]!;
      const cost = qty * price;
      const can = ok && D >= cost;
      return `<div class="pp-shop-row${ok ? "" : " pp-cant"}">
        <span class="pp-shop-name">${emoji} ${name} <span class="pp-sub">${desc}</span></span>
        <span class="pp-shop-actions">
          ${this.stepper(`buy-${item}`, qty)}
          ${qtyBtn("buy", item, `data-qty="${qty}"`, `Buy ${qty}`, `$${cost}`, !can, reason)}
          ${ok ? "" : `<span class="pp-reason">${escapeHtml(reason)}</span>`}
        </span>
      </div>`;
    };

    // Knight & Queen: one-per-player specials (booleans) — a single Buy, no stepper.
    const buyRow = (item: string, emoji: string, name: string, desc: string) => {
      const { ok, reason } = ppCanBuy(inv, item);
      const price = PRICE[item as keyof typeof PRICE];
      return `<div class="pp-shop-row${ok ? "" : " pp-cant"}">
        <span class="pp-shop-name">${emoji} ${name} <span class="pp-sub">${desc}</span></span>
        <span class="pp-shop-actions">
          ${qtyBtn("buy", item, `data-qty="1"`, "Buy", `$${price}`, !ok, reason)}
          ${ok ? "" : `<span class="pp-reason">${escapeHtml(reason)}</span>`}
        </span>
      </div>`;
    };

    // Build a Wall/Roof from owned bricks/sticks (players stockpile these). A +/- stepper
    // (step 1) + a "Max" that builds as many as your materials allow. Higher tiers use
    // the one-click "from scratch" button below instead.
    const buildStepRow = (item: string, emoji: string, name: string, recipe: string) => {
      const { ok, reason } = ppCanBuild(inv, item);
      const max = ppBuildMax(inv, item);
      const qty = Math.min(this.buildQty[item]!, Math.max(1, max));
      const maxBtn = ok && max > qty ? qtyBtn("build", item, `data-count="${max}"`, `Max ×${max}`, "", false) : "";
      return `<div class="pp-shop-row${ok ? "" : " pp-cant"}">
        <span class="pp-shop-name">${emoji} ${name} <span class="pp-sub">${recipe}</span></span>
        <span class="pp-shop-actions">
          ${this.stepper(`build-${item}`, qty)}
          ${qtyBtn("build", item, `data-count="${qty}"`, `Build ${qty}`, "", !ok, reason)}
          ${maxBtn}
          ${ok ? "" : `<span class="pp-reason">${escapeHtml(reason)}</span>`}
        </span>
      </div>`;
    };

    // One-click "build from scratch": uses owned parts first, buys the missing
    // bricks/sticks with cash, assembles in one go. Cost shown is the marginal cash
    // (often $0 when you already own the parts).
    const scratchStepRow = (item: string, emoji: string, name: string, recipe: string) => {
      const qty = this.scratchQty[item]!;
      const r = quickBuildCost(inv as any, item as any, qty);
      const affordable = r.ok && inv.dollars >= r.dollars;
      const reason = !r.ok ? r.reason ?? "" : `Need $${r.dollars} (have $${D}).`;
      const cost = r.ok ? (r.dollars === 0 ? "free" : `$${r.dollars}`) : "";
      return `<div class="pp-shop-row${affordable ? "" : " pp-cant"}">
        <span class="pp-shop-name">${emoji} ${name} <span class="pp-sub">${recipe}</span></span>
        <span class="pp-shop-actions">
          ${this.stepper(`scratch-${item}`, qty)}
          <button class="pp-qty-btn" data-action="buildScratch" data-item="${item}" data-count="${qty}" ${affordable ? "" : "disabled"}${affordable ? "" : ` title="${escapeHtml(reason)}"`}>Build ×${qty}${cost ? `<span class="pp-price">${cost}</span>` : ""}</button>
          ${affordable ? "" : `<span class="pp-reason">${escapeHtml(reason)}</span>`}
        </span>
      </div>`;
    };

    // Brick↔stick trade (2:1, in 10s) with a +/- stepper.
    const tradeRow = (from: "bricks" | "sticks", emoji: string, toEmoji: string) => {
      const have = inv[from];
      const amt = this.tradeAmt[from];
      const can = have >= amt && amt >= 10;
      return `<div class="pp-shop-row${can ? "" : " pp-cant"}">
        <span class="pp-shop-name">${emoji} → ${toEmoji} <span class="pp-sub">2 : 1 · in 10s · have ${have}</span></span>
        <span class="pp-shop-actions">
          ${this.stepper(`trade-${from}`, amt)}
          <button class="pp-qty-btn" data-action="trade" data-from="${from}" ${can ? "" : "disabled"}>Trade<span class="pp-price">→ ${Math.floor(amt / 2)}</span></button>
        </span>
      </div>`;
    };

    // Discount-while-here squares (#8/#29 trader, #14 cleaner): one purchase per
    // landing (the engine sets traderUsedThisTurn). Stepper picks the amount.
    const used = this.room!.state.traderUsedThisTurn;
    let trader = "";
    if (sq.effect.kind === "trader-walls") {
      const q = this.traderQty, cost = q * 10, walls = q * 3;
      trader = used
        ? `<div class="pp-trader-used">✓ Already traded here this turn.</div>`
        : `<div class="pp-shop-row"><span class="pp-shop-name">🛒 Trader <span class="pp-sub">$10 → 3 walls each</span></span>
            <span class="pp-shop-actions">${this.stepper("trader", q)}
              <button class="pp-qty-btn" data-action="traderWalls" ${inv.dollars < cost ? "disabled" : ""}>Buy ${walls} 🧱<span class="pp-price">$${cost}</span></button></span></div>`;
    } else if (sq.effect.kind === "trader-bricks") {
      const q = this.traderQty, bricks = q * 10, cash = q * 15;
      trader = used
        ? `<div class="pp-trader-used">✓ Already traded here this turn.</div>`
        : `<div class="pp-shop-row"><span class="pp-shop-name">🛒 Trader <span class="pp-sub">10 bricks → $15 each</span></span>
            <span class="pp-shop-actions">${this.stepper("trader", q)}
              <button class="pp-qty-btn" data-action="traderBricks" ${inv.bricks < bricks ? "disabled" : ""}>Sell ${bricks} 🧱<span class="pp-price">$${cash}</span></button></span></div>`;
    } else if (sq.effect.kind === "half-price-cleaner") {
      const q = this.cleanerQty, cost = q * 10;
      trader = used
        ? `<div class="pp-trader-used">✓ Already bought here this turn.</div>`
        : `<div class="pp-shop-row"><span class="pp-shop-name">🧹 Cleaner (half price) <span class="pp-sub">$10 each · no Room needed</span></span>
            <span class="pp-shop-actions">${this.stepper("cleaner", q)}
              <button class="pp-qty-btn" data-action="halfCleaner" ${inv.dollars < cost ? "disabled" : ""}>Buy ${q} 🧹<span class="pp-price">$${cost}</span></button></span></div>`;
    }

    const youHave = `<div class="pp-have">💰 <strong>$${inv.dollars}</strong> · 🧱 ${inv.bricks} · 🪵 ${inv.sticks} · 🧱${inv.walls}w · 🏠${inv.roofs}r · 🚪${inv.rooms} · 🏢${inv.buildings} · 🏯${inv.threeStoryBuildings}</div>`;

    return `
      <div class="pp-action-head">
        <div class="pp-act-title">Shop · Build · Trade</div>
        ${youHave}
      </div>
      <div class="pp-shop-group">
        <div class="pp-group-h">🛍 Shop</div>
        ${buyStepRow("brick", "🧱", "Bricks", "$1 ea · in 5s · 20 = 4 walls")}
        ${buyStepRow("stick", "🪵", "Sticks", "$1 ea · in 5s · 20 = 4 roofs")}
        ${staffStepRow("worker", "👷", "Worker", "earns walls/roofs each turn")}
        ${staffStepRow("server", "🍽️", "Server", "+5 pts · unlocks Buildings")}
        ${staffStepRow("chef", "👨‍🍳", "Chef", "+10 pts · needed for 3-Story")}
        ${staffStepRow("cleaner", "🧹", "Cleaner", "+5 pts · 5 → Whole-House Cleaner")}
        ${buyRow("knight", "🛡️", "Knight", "blocks the Bailiff")}
        ${buyRow("queen", "👑", "Queen", "+200 pts")}
        ${trader ? `<div class="pp-trader">${trader}</div>` : ""}
      </div>
      <div class="pp-shop-group">
        <div class="pp-group-h">🏗 Build</div>
        ${buildStepRow("wall", "🧱", "Wall", `${RECIPE.wall.bricks} bricks`)}
        ${buildStepRow("roof", "🏠", "Roof", `${RECIPE.roof.sticks} sticks`)}
        ${scratchStepRow("room", "🚪", "Room", `${RECIPE.room.walls} walls + ${RECIPE.room.roofs} roof`)}
        ${scratchStepRow("building", "🏢", "Building", `${RECIPE.building.rooms} rooms + 1 staff`)}
        ${scratchStepRow("threeStoryBuilding", "🏯", "3-Story", `${RECIPE.threeStoryBuilding.buildings} buildings + staff`)}
        ${scratchStepRow("palace", "🏰", "Palace", `${RECIPE.palace.threeStoryBuildings} 3-Story`)}
      </div>
      <div class="pp-shop-group">
        <div class="pp-group-h">🔄 Trade</div>
        ${tradeRow("bricks", "🧱", "🪵")}
        ${tradeRow("sticks", "🪵", "🧱")}
      </div>
      ${this.renderCardEditor(me)}
      <div class="pp-worker">
        Worker output:
        <button class="pp-chip${me.workerPreference === "wall-roof" ? " pp-chip-on" : ""}" data-action="workerPref" data-pref="wall-roof">+1 wall +1 roof / turn</button>
        <button class="pp-chip${me.workerPreference === "wall-wall" ? " pp-chip-on" : ""}" data-action="workerPref" data-pref="wall-wall">+2 walls / turn</button>
      </div>
      <button class="pp-primary pp-endturn" data-action="endTurn">End turn ▶</button>`;
  }

  /** A small −/[n]/+ stepper. `id` keys which draft the +/- buttons adjust. */
  private stepper(id: string, value: number): string {
    return `<span class="pp-stepper">
      <button class="pp-step" data-action="stepAdj" data-stepper="${id}" data-dir="-">−</button>
      <span class="pp-step-n">${value}</span>
      <button class="pp-step" data-action="stepAdj" data-stepper="${id}" data-dir="+">+</button>
    </span>`;
  }

  /** Your resource card, always visible during your turn; editable (one swap per
   *  earned credit) when you've passed Start. */
  private renderCardEditor(me: PPSeat): string {
    const slots = [...me.resourceCard];
    if (slots.length === 0) return "";
    const credits = me.mappingChangesAvailable;
    const editable = credits > 0;
    const optIndexOf = (slot: { kind: string; amount: number }) =>
      RESOURCE_OPTIONS.findIndex((o) => o.kind === slot.kind && (o.kind === "draw-card" || o.amount === slot.amount));
    const rows = slots
      .map((slot, i) => {
        const cur = optIndexOf(slot);
        if (editable) {
          const opts = RESOURCE_OPTIONS.map(
            (o, oi) => `<option value="${oi}" ${oi === cur ? "selected" : ""}>${escapeHtml(outcomeLabel(o))}</option>`,
          ).join("");
          return `<div class="pp-map-slot"><span class="pp-die">${i + 1}</span><span class="pp-map-arrow">→</span><select data-edit-slot="${i}">${opts}</select></div>`;
        }
        const label = cur >= 0 ? outcomeLabel(RESOURCE_OPTIONS[cur]!) : "—";
        return `<span class="pp-card-chip"><b>${i + 1}</b> ${escapeHtml(label)}</span>`;
      })
      .join("");
    return `<div class="pp-shop-group pp-cardedit">
      <div class="pp-group-h">🎴 Your roll card${editable ? ` · ✏️ ${credits} change${credits > 1 ? "s" : ""}` : ""}</div>
      ${editable ? `<p class="pp-hint">Pick a die face's new reward — it swaps with whichever face has it now. Costs 1 change.</p>` : `<div class="pp-card-chips">${rows}</div>`}
      ${editable ? `<div class="pp-map-grid pp-cardedit-grid">${rows}</div>` : ""}
    </div>`;
  }

  // ---- events --------------------------------------------------------------

  private handleChange(e: Event): void {
    const el = e.target as HTMLElement;
    const slotAttr = el.getAttribute("data-map-slot");
    if (slotAttr !== null) {
      const slot = Number(slotAttr);
      const option = Number((el as HTMLSelectElement).value);
      this.setMappingSlot(slot, option);
      this.render();
      return;
    }
    // Mid-game roll-card edit: send a one-slot change (the engine swaps to keep the
    // 1-to-1 mapping and spends a lap credit).
    const editAttr = el.getAttribute("data-edit-slot");
    if (editAttr !== null) {
      this.send({ type: "mapping/changeOneSlot", slotIndex: Number(editAttr), option: Number((el as HTMLSelectElement).value) });
      return;
    }
    // Bailiff steal target/item — keep the local selection so the "Take it" button
    // can grey when the target lacks the item.
    const stealAttr = el.getAttribute("data-steal");
    if (stealAttr === "target" || stealAttr === "item") {
      this.stealSel[stealAttr] = (el as HTMLSelectElement).value;
      this.render();
    }
  }

  /** Swap-to-slot so the draft stays a one-to-one permutation. */
  private setMappingSlot(slot: number, option: number): void {
    const other = this.mappingDraft.indexOf(option);
    if (other === slot) return;
    const displaced = this.mappingDraft[slot]!;
    this.mappingDraft[slot] = option;
    if (other >= 0) this.mappingDraft[other] = displaced;
  }

  private handleClick(e: MouseEvent): void {
    // Click on the modal backdrop (but not its inner panel) closes any open modal.
    if ((e.target as HTMLElement).classList.contains("pp-modal-backdrop")) {
      this.showRules = false;
      this.showDeck = false;
      this.render();
      return;
    }
    // Tapping a board square pins its full explanation in the info callout.
    const sqEl = (e.target as HTMLElement).closest<HTMLElement>("[data-sq]");
    if (sqEl) {
      const n = Number(sqEl.dataset.sq);
      this.infoSquare = this.infoSquare === n ? undefined : n; // tap again to unpin
      this.render();
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn || !this.room) return;
    const action = btn.dataset.action!;
    switch (action) {
      case "rules":
        this.showRules = true;
        this.render();
        return;
      case "closeRules":
        this.showRules = false;
        this.render();
        return;
      case "deckRef":
        this.showDeck = true;
        this.render();
        return;
      case "closeDeck":
        this.showDeck = false;
        this.render();
        return;
      case "mute":
        setMuted(!isMuted());
        this.render();
        return;
      case "save":
        this.room.send(LobbyMsg.SAVE, {});
        return;
      case "lockMapping": {
        const card = this.mappingDraft.map((i) => {
          const o = RESOURCE_OPTIONS[i]!;
          return { kind: o.kind, amount: o.kind === "draw-card" ? 0 : o.amount };
        });
        this.send({ type: "mapping/setInitial", card });
        return;
      }
      case "roll":
        this.send({ type: "turn/rollDie" });
        return;
      case "initRoll":
        this.send({ type: "initialRoll/roll" });
        return;
      case "redeemPardon":
        this.send({ type: "dungeon/redeemPardon" });
        return;
      case "bailiffSteal": {
        const phase = btn.dataset.phase;
        const target = this.stealSel.target;
        const item = this.stealSel.item;
        if (!target || !item) return;
        const type =
          phase === "pre-move" ? "turn/bailiffStealPreMove" : phase === "post-roll" ? "turn/bailiffStealPostRoll" : "turn/bailiffStealPreRoll";
        this.send({ type, targetId: target, item });
        return;
      }
      case "bailiffSkip": {
        const phase = btn.dataset.phase;
        const type = phase === "pre-move" ? "turn/bailiffStealPreMoveSkip" : "turn/bailiffStealPostRollSkip";
        this.send({ type });
        return;
      }
      case "alliance":
        this.send({ type: btn.dataset.choice === "accept" ? "turn/acceptAlliance" : "turn/declineAlliance" });
        return;
      case "gift":
        this.send({ type: btn.dataset.choice === "bricks" ? "turn/gift10Bricks" : "turn/gift1Wall" });
        return;
      case "advance":
        this.send({ type: "turn/advancePhase" });
        return;
      case "payFine":
        this.send({ type: "turn/payFine", ...this.fineSel });
        this.fineSel = { bricks: 0, sticks: 0, walls: 0, roofs: 0 };
        return;
      case "duelKind": {
        const t = PerfectPalaceView.DUEL_TYPES.find((x) => x.kind === btn.dataset.kind);
        if (t) this.duelStakeDraft = { kind: t.kind, amount: t.min };
        this.render();
        return;
      }
      case "duelStake":
        this.send({ type: "turn/duelSetStake", stake: this.stakeFor(this.duelStakeDraft.kind, this.duelStakeDraft.amount) });
        return;
      case "duelCancel":
        this.send({ type: "turn/duelCancel" });
        return;
      case "duelRoll":
        this.send({ type: "turn/duelRollForPlayer" });
        return;
      case "buy": {
        const quantity = Number(btn.dataset.qty) || 1;
        this.send({ type: "turn/buy", item: btn.dataset.item, quantity });
        return;
      }
      case "build": {
        const count = Number(btn.dataset.count) || 1;
        this.send({ type: "turn/build", item: btn.dataset.item, count });
        return;
      }
      case "buildScratch": {
        const count = Number(btn.dataset.count) || 1;
        this.send({ type: "turn/buildFromScratch", item: btn.dataset.item, count });
        return;
      }
      case "trade": {
        const from = btn.dataset.from as "bricks" | "sticks";
        this.send({ type: "turn/trade", from, amount: this.tradeAmt[from] });
        return;
      }
      case "traderWalls":
        this.send({ type: "turn/traderWallsBuy", batches: this.traderQty });
        return;
      case "traderBricks":
        this.send({ type: "turn/traderBricksSell", batches: this.traderQty });
        return;
      case "halfCleaner":
        this.send({ type: "turn/halfPriceCleanerBuy", count: this.cleanerQty });
        return;
      case "stepAdj":
        this.adjustStepper(btn.dataset.stepper!, btn.dataset.dir === "+" ? 1 : -1);
        return;
      case "workerPref":
        this.send({ type: "turn/setWorkerPreference", preference: btn.dataset.pref });
        return;
      case "endTurn":
        this.send({ type: "turn/endTurn" });
        return;
      case "fineAdjust": {
        const me = this.mySeat();
        if (!me) return;
        const k = btn.dataset.k as keyof typeof this.fineSel;
        const have =
          k === "bricks" ? me.inventory.bricks
          : k === "sticks" ? me.inventory.sticks
          : k === "walls" ? me.inventory.walls
          : me.inventory.roofs;
        const next = this.fineSel[k] + (btn.dataset.fine === "+" ? 1 : -1);
        this.fineSel[k] = Math.max(0, Math.min(have, next)); // clamp to what you hold
        this.render();
        return;
      }
      case "fineAuto": {
        const me = this.mySeat();
        if (!me) return;
        this.fineAutoFill(this.room.state.fineAmount, me);
        this.render();
        return;
      }
    }
  }

  private stakeFor(kind: string, amount: number): Record<string, number> {
    const base = { dollars: 0, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 };
    switch (kind) {
      case "dollars": return { ...base, dollars: amount };
      case "bricks": return { ...base, bricks: amount };
      case "sticks": return { ...base, sticks: amount };
      case "wall": return { ...base, walls: amount };
      case "roof": return { ...base, roofs: amount };
      case "room": return { ...base, rooms: amount };
      default: return { ...base, dollars: amount };
    }
  }

  /** Adjust a stepper draft by ±step, clamped to a sensible, engine-affordable range,
   *  then re-render. */
  private adjustStepper(id: string, dir: number): void {
    const me = this.mySeat();
    if (!me) return;
    const inv = me.inventory;
    // Per-row buy/build steppers. Clamp on read so a draft never exceeds what's
    // currently affordable (inventory can shift between taps); the engine re-checks too.
    if (id === "buy-brick" || id === "buy-stick") {
      const item = id === "buy-brick" ? "brick" : "stick";
      const max = Math.max(5, Math.floor(inv.dollars / 5) * 5); // $1 each, sold in 5s
      this.buyQty[item] = Math.max(5, Math.min(max, (this.buyQty[item] ?? 5) + dir * 5));
    } else if (id === "buy-worker" || id === "buy-server" || id === "buy-chef" || id === "buy-cleaner") {
      const item = id.slice(4) as "worker" | "server" | "chef" | "cleaner";
      const price = PRICE[item];
      const roomOk = item === "worker" ? true : ppHasRoom(inv); // staff need a Room first
      const max = roomOk ? Math.max(1, Math.floor(inv.dollars / price)) : 1;
      this.buyQty[item] = Math.max(1, Math.min(max, (this.buyQty[item] ?? 1) + dir));
    } else if (id === "build-wall" || id === "build-roof") {
      const item = id === "build-wall" ? "wall" : "roof";
      const max = Math.max(1, ppBuildMax(inv, item));
      this.buildQty[item] = Math.max(1, Math.min(max, (this.buildQty[item] ?? 1) + dir));
    } else if (id.startsWith("scratch-")) {
      const item = id.slice("scratch-".length);
      let max = 1; // largest N (≤20) we can both afford and have the prereqs for
      for (let n = 1; n <= 20; n++) {
        const r = quickBuildCost(inv as any, item as any, n);
        if (!r.ok || r.dollars > inv.dollars) break;
        max = n;
      }
      this.scratchQty[item] = Math.max(1, Math.min(max, (this.scratchQty[item] ?? 1) + dir));
    } else if (id === "trade-bricks" || id === "trade-sticks") {
      const from = id === "trade-bricks" ? "bricks" : "sticks";
      const max = Math.max(10, Math.floor(inv[from] / 10) * 10);
      this.tradeAmt[from] = Math.max(10, Math.min(max, this.tradeAmt[from] + dir * 10));
    } else if (id === "trader") {
      const eff = getSquare(me.position).effect;
      const max =
        eff.kind === "trader-walls" ? Math.max(1, Math.floor(inv.dollars / 10))
        : eff.kind === "trader-bricks" ? Math.max(1, Math.floor(inv.bricks / 10))
        : 1;
      this.traderQty = Math.max(1, Math.min(max, this.traderQty + dir));
    } else if (id === "cleaner") {
      const max = Math.max(1, Math.floor(inv.dollars / 10));
      this.cleanerQty = Math.max(1, Math.min(max, this.cleanerQty + dir));
    } else if (id === "duel") {
      const d = this.room!.state.duel;
      const t = PerfectPalaceView.DUEL_TYPES.find((x) => x.kind === this.duelStakeDraft.kind);
      if (d && t) {
        const invs = [...d.participants].map((pid) => this.seatById(pid)?.inventory).filter(Boolean) as PPInv[];
        const max = Math.min(...invs.map((i) => Number(i[t.field])));
        this.duelStakeDraft.amount = Math.max(t.min, Math.min(max, this.duelStakeDraft.amount + dir * t.step));
      }
    }
    this.render();
  }
}

// ---- lobby settings + game summary (registry hooks) ------------------------

export function renderPerfectPalaceLobbySettings(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: LobbySettingsContext,
): void {
  const state = room.state as BaseState;
  const seatsLeft = (state.maxPlayers || 6) - state.players.size;
  const addBot = ctx.isHost
    ? `<div class="pp-lobby-row">
        <select id="pp-bot-difficulty" class="pp-mini-select" title="AI difficulty">
          <option value="easy">Easy</option>
          <option value="normal" selected>Normal</option>
          <option value="hard">Hard</option>
        </select>
        <button id="pp-add-bot" class="secondary" ${seatsLeft > 0 ? "" : "disabled"}>➕ Add AI 🤖</button>
      </div>`
    : "";

  // Each player picks their palace colour; colours taken by others are locked out.
  const takenBy = new Map<number, string>();
  let myColor = -1;
  for (const p of state.players.values()) {
    const choice = (p as any).colorChoice as number | undefined;
    if (choice !== undefined && choice >= 0) takenBy.set(choice, p.nickname);
    if (p.sessionId === ctx.mySessionId && choice !== undefined) myColor = choice;
  }
  const swatches = PERFECT_PALACE_COLORS.map((hex, i) => {
    const owner = takenBy.get(i);
    const mine = i === myColor;
    const lockedByOther = owner !== undefined && !mine;
    const title = lockedByOther ? `Taken by ${owner}` : mine ? "Your colour (tap to clear)" : "Pick this colour";
    return `<button class="pp-color-swatch${mine ? " pp-color-selected" : ""}" data-pick-color="${i}" style="background:${hex}" ${lockedByOther ? "disabled" : ""} title="${escapeHtml(title)}"></button>`;
  }).join("");
  const colorRow = `<div class="pp-color-setting"><span class="muted">Your colour</span><div class="pp-color-row">${swatches}</div></div>`;

  // Host-only turn-timer dropdown (Off, then 30s steps to 5 min). When a turn
  // runs out the AI finishes it (handled server-side).
  const curTurn = (room.state as unknown as PerfectPalaceState).turnSeconds ?? 0;
  let timerOpts = `<option value="0" ${curTurn === 0 ? "selected" : ""}>Off</option>`;
  for (let s = 30; s <= 300; s += 30) {
    timerOpts += `<option value="${s}" ${curTurn === s ? "selected" : ""}>${fmtSecs(s)}</option>`;
  }
  const timerRow = ctx.isHost
    ? `<div class="pp-lobby-row"><span class="muted">Turn timer</span><select id="pp-turn-seconds" class="pp-mini-select">${timerOpts}</select></div>`
    : "";

  container.innerHTML = `
    <p class="muted">A regal, Monopoly-style race to build palaces — 2–6 players, one device each.
      Add AI players to fill out the table; if someone leaves mid-game an AI keeps their seat and anyone can take it over.</p>
    ${colorRow}
    ${timerRow}
    ${addBot}
    <div class="pp-saves-block"></div>`;
  container.querySelector<HTMLSelectElement>("#pp-turn-seconds")?.addEventListener("change", (ev) => {
    room.send(PerfectPalaceMsg.CONFIG, { turnSeconds: Number((ev.target as HTMLSelectElement).value) });
  });
  container.querySelector<HTMLButtonElement>("#pp-add-bot")?.addEventListener("click", () => {
    const difficulty = container.querySelector<HTMLSelectElement>("#pp-bot-difficulty")?.value ?? "normal";
    room.send(LobbyMsg.ADD_BOT, { difficulty });
  });
  container.querySelectorAll<HTMLButtonElement>(".pp-color-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const i = Number(btn.dataset.pickColor);
      room.send(PerfectPalaceMsg.PICK_COLOR, { color: i === myColor ? -1 : i });
    });
  });
  renderSaveSlots(container.querySelector<HTMLElement>(".pp-saves-block")!, room, {
    key: PP_SAVES_KEY,
    isHost: ctx.isHost,
    loadedSave: (room.state as BaseState).loadedSave,
  });
}

export function renderPerfectPalaceGameSummary(
  container: HTMLElement,
  room: Room<any, BaseState>,
): void {
  const s = room.state as unknown as PerfectPalaceState;
  const rows = [...s.seats]
    .filter((seat) => !seat.removed)
    .map((seat) => ({
      name: seat.nickname,
      pts: totalPoints(seat.inventory as any),
      staff: staffWeight(seat.inventory as any),
      cash: seat.inventory.dollars,
      win: seat.engineId === s.winnerId,
    }))
    .sort((a, b) => b.pts - a.pts || b.staff - a.staff || b.cash - a.cash);
  container.innerHTML = `
    <table class="pp-summary">
      <thead><tr><th></th><th>Player</th><th>Points</th><th>Staff</th><th>Cash</th></tr></thead>
      <tbody>
        ${rows
          .map(
            (r, i) => `<tr class="${r.win ? "pp-winner" : ""}">
              <td>${r.win ? "👑" : i + 1}</td>
              <td>${escapeHtml(r.name)}</td>
              <td>${r.pts}</td><td>${r.staff}</td><td>$${r.cash}</td></tr>`,
          )
          .join("")}
      </tbody>
    </table>
    <p class="muted center">Tiebreaker: points → staff weight → cash.</p>
    <button id="pp-share" class="secondary">📋 Share results</button>`;

  // Build a tidy text scoreboard for the clipboard / native share sheet.
  const room2 = room as Room<any, any>;
  const code = room2.roomId ?? (room.state as any).roomCode ?? "";
  const lines = [
    `🏰 The Perfect Palace — Final Results${code ? ` (room ${code})` : ""}`,
    ...rows.map((r, i) => `${r.win ? "👑" : `${i + 1}.`} ${r.name} — ${r.pts} pts · ${r.staff} staff · $${r.cash}`),
    `Tiebreak: points → staff → cash`,
  ];
  const text = lines.join("\n");
  const btn = container.querySelector<HTMLButtonElement>("#pp-share");
  btn?.addEventListener("click", async () => {
    let copied = false;
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch {
      // clipboard blocked (e.g. insecure context) — fall back to the share sheet.
    }
    if (!copied && typeof navigator.share === "function") {
      try {
        await navigator.share({ text });
        copied = true;
      } catch {
        /* user dismissed the share sheet */
      }
    }
    if (btn) {
      btn.textContent = copied ? "Copied ✓" : "Copy failed — long-press to copy";
      setTimeout(() => {
        if (btn) btn.textContent = "📋 Share results";
      }, 2000);
    }
  });
}
