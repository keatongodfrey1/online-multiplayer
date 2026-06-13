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
import { flashToast, isMuted, setMuted, turnChime } from "../../framework/turnAlert.js";

const { BOARD, getSquare, RESOURCE_OPTIONS, PRICE, RECIPE, totalPoints, staffWeight } = PerfectPalaceEngine;
const PP_SAVES_KEY = "perfectpalace-saves";

type Outcome = PerfectPalaceEngine.ResourceOutcome;
const BAILIFF_ITEMS = ["bricks", "sticks", "wall", "roof", "dollars"] as const;

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
  private iWasActing = false;
  /** Dice animation: a portal element (outside the re-rendered DOM) + timers. */
  private diceLayer?: HTMLElement;
  private diceTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastSeenRollSeq = 0;

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
    this.lastSeenRollSeq = this.room.state?.lastRollSeq ?? 0;
    hookSaveData(this.room, PP_SAVES_KEY, (blob) => (blob?.turnCount ?? 0) + 1, () =>
      flashToast(this.root!, "Game saved ✓"),
    );
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
    this.root = undefined;
    this.room = undefined;
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
    if (s.enginePhase === "initial-mapping") return !me.mappingLocked;
    if (s.turnPhase === "duel") {
      return !!s.duel && [...s.duel.contenders].includes(me.engineId) && !this.hasRolled(me.engineId);
    }
    return s.currentTurn === this.ctx?.mySessionId;
  }
  private hasRolled(id: string): boolean {
    const d = this.room?.state.duel;
    if (!d) return false;
    const i = [...d.rollPlayers].indexOf(id);
    return i >= 0 && (d.rollValues[i] ?? 0) > 0;
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

    this.root.innerHTML = `
      <div class="pp-top">
        <div class="pp-title">The Perfect Palace</div>
        <div class="pp-phasebar">${escapeHtml(this.phaseHeadline())}</div>
        <div class="pp-toptools">
          <button class="pp-icon" data-action="mute" title="${isMuted() ? "Sounds off" : "Sounds on"}">${isMuted() ? "🔕" : "🔔"}</button>
          ${me ? `<button class="subtle" data-action="save">Save</button>` : ""}
        </div>
      </div>
      <div class="pp-main">
        <div class="pp-boardwrap">${this.renderBoard()}</div>
        <div class="pp-side">
          <div class="pp-action">${this.renderAction()}</div>
          <div class="pp-players">${this.renderPlayers()}</div>
          <div class="pp-log">${this.renderLog()}</div>
        </div>
      </div>`;
  }

  private phaseHeadline(): string {
    const s = this.room!.state;
    if (s.enginePhase === "game-over") return "Game over";
    if (s.enginePhase === "initial-mapping") return "Everyone: pick your resource card";
    const turnSeat = this.seatById(s.currentPlayerId);
    const who = turnSeat?.nickname ?? "…";
    if (s.turnPhase === "duel") return `Duel at #${s.duel?.squareNumber ?? "?"}!`;
    const mine = s.currentTurn === this.ctx?.mySessionId;
    return mine ? "Your turn" : `${who}'s turn`;
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
      cells.push(`
        <div class="pp-sq${corner}" style="grid-row:${row};grid-column:${col}" title="${escapeHtml(def.flavor ?? def.label)}">
          <div class="pp-sq-n">${def.number}</div>
          <div class="pp-sq-l">${escapeHtml(def.label)}</div>
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
        <div class="pp-crest-deck">🃏 Deck: ${s.deckCount} · Discard: ${s.discardCount}</div>
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

    if (s.enginePhase === "initial-mapping") {
      return me.mappingLocked
        ? `<div class="pp-act-wait">Card locked in — waiting for the others…</div>`
        : this.renderMappingPicker();
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

  private renderMappingPicker(): string {
    const slots = this.mappingDraft
      .map((optIdx, slot) => {
        const opts = RESOURCE_OPTIONS.map(
          (o, i) => `<option value="${i}" ${i === optIdx ? "selected" : ""}>${escapeHtml(outcomeLabel(o))}</option>`,
        ).join("");
        return `<div class="pp-map-slot"><span class="pp-die">${slot + 1}</span><select data-map-slot="${slot}">${opts}</select></div>`;
      })
      .join("");
    return `
      <div class="pp-card-pick">
        <div class="pp-act-title">Pick your resource card</div>
        <p class="pp-hint">Each die face gives a different reward. Every reward is used exactly once. Tweak it or keep the default.</p>
        ${slots}
        <button class="pp-primary" data-action="lockMapping">Lock it in</button>
      </div>`;
  }

  private renderTurnStart(me: PPSeat): string {
    const s = this.room!.state;
    if (me.inDungeon) {
      return `
        <div class="pp-act-title">You're in the dungeon ⛓️ (${me.dungeonTurnsServed}/3)</div>
        <p class="pp-hint">Roll a 1 to break out, or serve your time. ${me.inventory.pardonCards > 0 ? "Or use a Royal Pardon for a full turn." : ""}</p>
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

  private renderStealControls(phase: "pre-roll" | "pre-move" | "post-roll"): string {
    const s = this.room!.state;
    const targets = [...s.seats].filter(
      (seat) => seat.engineId !== this.myId() && !seat.removed && !seat.inventory.knight,
    );
    if (targets.length === 0) return `<p class="pp-hint">No one to steal from right now.</p>`;
    const targetOpts = targets
      .map((t) => `<option value="${t.engineId}">${escapeHtml(t.nickname)}</option>`)
      .join("");
    const itemOpts = BAILIFF_ITEMS.map((it) => `<option value="${it}">${it}</option>`).join("");
    return `
      <div class="pp-steal">
        <span class="pp-hint">Steal once this turn:</span>
        <select data-steal="target">${targetOpts}</select>
        <select data-steal="item">${itemOpts}</select>
        <button class="pp-secondary" data-action="bailiffSteal" data-phase="${phase}">Take it 🎩</button>
      </div>`;
  }

  private renderDecision(me: PPSeat): string {
    const s = this.room!.state;
    if (s.finePending) {
      const sel = this.fineSel;
      const value = sel.bricks * 1 + sel.sticks * 1 + sel.walls * 5 + sel.roofs * 5;
      const counter = (k: keyof typeof sel, label: string, have: number) => `
        <div class="pp-fine-row">
          <span>${label} (have ${have})</span>
          <button class="pp-step" data-fine="-" data-k="${k}">−</button>
          <span class="pp-fine-n">${sel[k]}</span>
          <button class="pp-step" data-fine="+" data-k="${k}">+</button>
        </div>`;
      return `
        <div class="pp-act-title">Pay the fine 💸</div>
        <p class="pp-hint">You owe <strong>$${s.fineAmount}</strong> but have no cash. Forfeit items to cover it (🧱/🪵 = $1, wall/roof = $5).</p>
        ${counter("bricks", "🧱 bricks", me.inventory.bricks)}
        ${counter("sticks", "🪵 sticks", me.inventory.sticks)}
        ${counter("walls", "🧱 walls", me.inventory.walls)}
        ${counter("roofs", "🏠 roofs", me.inventory.roofs)}
        <div class="pp-fine-total">Selected: $${value} / $${s.fineAmount}</div>
        <button class="pp-primary" data-action="payFine">Pay</button>`;
    }
    const sq = getSquare(me.position);
    if (sq.effect.kind === "alliance-offer") {
      return `
        <div class="pp-act-title">Alliance offered 🤝</div>
        <p class="pp-hint">${escapeHtml(sq.flavor ?? "")}</p>
        <button class="pp-primary" data-action="alliance" data-choice="accept">Accept</button>
        <button class="pp-secondary" data-action="alliance" data-choice="decline">Decline</button>`;
    }
    if (sq.effect.kind === "bricks-or-wall") {
      return `
        <div class="pp-act-title">A royal gift 🎁</div>
        <button class="pp-primary" data-action="gift" data-choice="bricks">Take 10 🧱 bricks</button>
        <button class="pp-primary" data-action="gift" data-choice="wall">Take 1 🧱 wall</button>`;
    }
    return `<button class="pp-secondary" data-action="advance">Continue</button>`;
  }

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
        inner += `<p class="pp-hint">You arrived — set the stake everyone matches:</p>
          <div class="pp-stakes">
            <button class="pp-secondary" data-action="duelStake" data-kind="dollars">💰 $5</button>
            <button class="pp-secondary" data-action="duelStake" data-kind="bricks">🧱 5 bricks</button>
            <button class="pp-secondary" data-action="duelStake" data-kind="sticks">🪵 5 sticks</button>
            <button class="pp-secondary" data-action="duelStake" data-kind="wall">🧱 1 wall</button>
            <button class="pp-secondary" data-action="duelStake" data-kind="roof">🏠 1 roof</button>
          </div>`;
      } else {
        inner += `<p class="pp-hint">Waiting for the stake…</p>`;
      }
    } else if (contender && !this.hasRolled(me.engineId)) {
      inner += `<p class="pp-hint">Stakes are in. Roll for the pot!</p>
        <button class="pp-primary" data-action="duelRoll">🎲 Roll</button>`;
    } else {
      inner += `<p class="pp-hint">Waiting for the other duelists to roll…</p>`;
    }
    // show rolls so far
    const rolls = [...d.rollPlayers]
      .map((id, i) => `${escapeHtml(this.seatById(id)?.nickname ?? id)}: ${d.rollValues[i] ?? "—"}`)
      .join(" · ");
    if (rolls) inner += `<div class="pp-duel-rolls">${rolls}</div>`;
    return inner;
  }

  private renderOptional(me: PPSeat): string {
    const inv = me.inventory;
    const sq = getSquare(me.position);
    const shopBtn = (item: string, label: string, price: number) =>
      `<button class="pp-shop-btn" data-action="buy" data-item="${item}" ${inv.dollars < price ? "disabled" : ""}>${label} <span class="pp-price">$${price}</span></button>`;
    const buildBtn = (item: string, label: string, hint: string) =>
      `<button class="pp-build-btn" data-action="build" data-item="${item}">${label}<span class="pp-recipe">${hint}</span></button>`;

    let trader = "";
    if (sq.effect.kind === "trader-walls") {
      trader = `<button class="pp-secondary" data-action="traderWalls" ${inv.dollars < 10 ? "disabled" : ""}>Trader: $10 → 3 🧱 walls</button>`;
    } else if (sq.effect.kind === "trader-bricks") {
      trader = `<button class="pp-secondary" data-action="traderBricks" ${inv.bricks < 10 ? "disabled" : ""}>Trader: 10 🧱 → $15</button>`;
    } else if (sq.effect.kind === "half-price-cleaner") {
      trader = `<button class="pp-secondary" data-action="halfCleaner" ${inv.dollars < 10 ? "disabled" : ""}>Cleaner (half price): $10</button>`;
    }

    return `
      <div class="pp-act-title">Shop · Build · Trade</div>
      <div class="pp-shop">
        ${shopBtn("brick", "🧱 brick", PRICE.brick)}
        ${shopBtn("stick", "🪵 stick", PRICE.stick)}
        ${shopBtn("worker", "👷 Worker", PRICE.worker)}
        ${shopBtn("server", "🍽️ Server", PRICE.server)}
        ${shopBtn("chef", "👨‍🍳 Chef", PRICE.chef)}
        ${shopBtn("cleaner", "🧹 Cleaner", PRICE.cleaner)}
        ${shopBtn("knight", "🛡️ Knight", PRICE.knight)}
        ${shopBtn("queen", "👑 Queen", PRICE.queen)}
      </div>
      ${trader ? `<div class="pp-trader">${trader}</div>` : ""}
      <div class="pp-build">
        ${buildBtn("wall", "🧱 Wall", `${RECIPE.wall.bricks} bricks`)}
        ${buildBtn("roof", "🏠 Roof", `${RECIPE.roof.sticks} sticks`)}
        ${buildBtn("room", "🚪 Room", `${RECIPE.room.walls} walls + ${RECIPE.room.roofs} roof`)}
        ${buildBtn("building", "🏢 Building", `${RECIPE.building.rooms} rooms`)}
        ${buildBtn("threeStoryBuilding", "🏯 3-Story", `${RECIPE.threeStoryBuilding.buildings} buildings`)}
        ${buildBtn("palace", "🏰 Palace", `${RECIPE.palace.threeStoryBuildings} 3-Story`)}
      </div>
      <div class="pp-trade">
        <button class="pp-secondary" data-action="trade" data-from="bricks" ${inv.bricks < 10 ? "disabled" : ""}>Trade 10 🧱 → 5 🪵</button>
        <button class="pp-secondary" data-action="trade" data-from="sticks" ${inv.sticks < 10 ? "disabled" : ""}>Trade 10 🪵 → 5 🧱</button>
      </div>
      <div class="pp-worker">
        Worker output:
        <button class="pp-chip${me.workerPreference === "wall-roof" ? " pp-chip-on" : ""}" data-action="workerPref" data-pref="wall-roof">wall+roof</button>
        <button class="pp-chip${me.workerPreference === "wall-wall" ? " pp-chip-on" : ""}" data-action="workerPref" data-pref="wall-wall">wall+wall</button>
      </div>
      <button class="pp-primary pp-endturn" data-action="endTurn">End turn ▶</button>`;
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
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn || !this.room) return;
    const action = btn.dataset.action!;
    switch (action) {
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
      case "redeemPardon":
        this.send({ type: "dungeon/redeemPardon" });
        return;
      case "bailiffSteal": {
        const phase = btn.dataset.phase;
        const target = this.root!.querySelector<HTMLSelectElement>('[data-steal="target"]')?.value;
        const item = this.root!.querySelector<HTMLSelectElement>('[data-steal="item"]')?.value;
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
      case "duelStake":
        this.send({ type: "turn/duelSetStake", stake: this.stakeFor(btn.dataset.kind!) });
        return;
      case "duelRoll":
        this.send({ type: "turn/duelRollForPlayer" });
        return;
      case "buy":
        this.send({ type: "turn/buy", item: btn.dataset.item });
        return;
      case "build":
        this.send({ type: "turn/build", item: btn.dataset.item, count: 1 });
        return;
      case "trade":
        this.send({ type: "turn/trade", from: btn.dataset.from, amount: 10 });
        return;
      case "traderWalls":
        this.send({ type: "turn/traderWallsBuy", batches: 1 });
        return;
      case "traderBricks":
        this.send({ type: "turn/traderBricksSell", batches: 1 });
        return;
      case "halfCleaner":
        this.send({ type: "turn/halfPriceCleanerBuy", count: 1 });
        return;
      case "workerPref":
        this.send({ type: "turn/setWorkerPreference", preference: btn.dataset.pref });
        return;
      case "endTurn":
        this.send({ type: "turn/endTurn" });
        return;
      case "fine":
        return; // handled below
    }
    // fine +/- counters
    if (btn.dataset.fine) {
      const k = btn.dataset.k as keyof typeof this.fineSel;
      this.fineSel[k] = Math.max(0, this.fineSel[k] + (btn.dataset.fine === "+" ? 1 : -1));
      this.render();
    }
  }

  private stakeFor(kind: string): Record<string, number> {
    const base = { dollars: 0, bricks: 0, sticks: 0, walls: 0, roofs: 0, rooms: 0 };
    switch (kind) {
      case "dollars": return { ...base, dollars: 5 };
      case "bricks": return { ...base, bricks: 5 };
      case "sticks": return { ...base, sticks: 5 };
      case "wall": return { ...base, walls: 1 };
      case "roof": return { ...base, roofs: 1 };
      default: return { ...base, dollars: 5 };
    }
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
    ? `<button id="pp-add-bot" class="secondary" ${seatsLeft > 0 ? "" : "disabled"}>➕ Add an AI player 🤖</button>`
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

  container.innerHTML = `
    <p class="muted">A regal, Monopoly-style race to build palaces — 2–6 players, one device each.
      Add AI players to fill out the table; if someone leaves mid-game an AI keeps their seat and anyone can take it over.</p>
    ${colorRow}
    ${addBot}
    <div class="pp-saves-block"></div>`;
  container.querySelector<HTMLButtonElement>("#pp-add-bot")?.addEventListener("click", () => {
    room.send(LobbyMsg.ADD_BOT, {});
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
    <p class="muted center">Tiebreaker: points → staff weight → cash.</p>`;
}
