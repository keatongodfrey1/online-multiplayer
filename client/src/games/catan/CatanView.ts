/**
 * Catan view - renders the synced schema and sends tagged engine actions on
 * CatanMsg.ACTION. The server validates everything; the legality computed
 * here (shared pure validators over the public board) only chooses which
 * targets to highlight and which buttons to enable.
 *
 * Touch-first: the board is an SVG with generous tap circles on the legal
 * vertices/edges/hexes for the current decision; pickers batch locally and
 * send one message on confirm.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  CATAN_NO_HOLDER,
  CatanEngine,
  CatanMsg,
  type CatanSeat,
  type CatanState,
  LobbyMsg,
} from "@backbone/shared";
import type { GameView, GameViewContext, LobbySettingsContext } from "../../framework/GameView.js";
import { escapeHtml } from "../../lobby/HomeScreen.js";
import { PLAYER_COLOR, renderBoardSvg, resourceIcon, type BoardUi } from "./board.js";

const {
  buildBoardGeometry,
  getValidCities,
  getValidInitialSettlements,
  getValidRoads,
  getValidSettlements,
  portAccess,
  bestTradeRatio,
  COSTS,
} = CatanEngine;

const RESOURCES = ["lumber", "brick", "wool", "grain", "ore"] as const;
type Res = (typeof RESOURCES)[number];
type Bag = Record<Res, number>;

const geo = buildBoardGeometry();

const zeroBag = (): Bag => ({ lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 });
const bagTotal = (b: Bag) => RESOURCES.reduce((t, r) => t + b[r], 0);

/** Bridge the flat synced arrays back into an engine BoardState for the
 *  pure validators (board contents are public). */
function boardFromState(state: CatanState): CatanEngine.BoardState {
  const ports: CatanEngine.Port[] = [];
  for (let p = 0; p < state.portTypes.length; p++) {
    ports.push({
      type: state.portTypes[p] as CatanEngine.PortType,
      vertices: [state.portVertices[p * 2] ?? 0, state.portVertices[p * 2 + 1] ?? 0],
    });
  }
  return {
    hexes: [...state.hexTerrain].map((terrain, i) => ({
      terrain: terrain as CatanEngine.Terrain,
      numberToken: (state.hexToken[i] ?? 0) > 0 ? state.hexToken[i]! : null,
    })),
    vertices: [...state.vertexOwner].map((owner, i) => ({
      building: owner >= 0 ? { owner, type: (state.vertexIsCity[i] ? "city" : "settlement") as CatanEngine.BuildingType } : null,
      portId: null,
    })),
    edges: [...state.edgeOwner].map((owner) => ({ road: owner >= 0 ? { owner } : null })),
    ports,
    robberHex: state.robberHex,
  };
}

/** Lobby settings hook: the host's add-bot button, plus a heads-up (for
 *  everyone) that a 2-player table plays the official CATAN-for-Two rules. */
export function renderCatanLobbySettings(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: LobbySettingsContext,
): void {
  const state = room.state as unknown as CatanState;
  const seatsLeft = state.maxPlayers - state.players.size;
  const note =
    state.players.size === 2
      ? `<p class="catan-lobby-note">With <strong>2 players</strong> you'll play the official
          <strong>CATAN for Two</strong> rules: two <em>neutral</em> piece sets start on the board
          with one settlement each (they never take turns or score), every road or settlement you
          build also places a free piece for a neutral, and trade tokens unlock Forced Trades.
          Seat a third player or an AI for the standard game.</p>`
      : "";
  const addBot = ctx.isHost
    ? `<button id="catan-add-bot" class="secondary" ${seatsLeft > 0 ? "" : "disabled"}>
        ${seatsLeft > 0 ? "+ Add AI opponent" : "Table is full"}
      </button>`
    : "";
  container.innerHTML = note + addBot;
  container.querySelector<HTMLButtonElement>("#catan-add-bot")?.addEventListener("click", () => {
    room.send(LobbyMsg.ADD_BOT, {});
  });
}

/** Game-over summary (GameDefinition.renderGameSummary): the final score
 *  table. By the end of the game seat.publicVP is the FULL total - the server
 *  reveals hidden Victory Point cards once the game is over. */
export function renderCatanGameSummary(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: GameViewContext,
): void {
  const state = room.state as unknown as CatanState;
  if (!state.seats.length) return;

  // building counts per seat, straight off the public board
  const settlements = new Array<number>(state.seats.length).fill(0);
  const cities = new Array<number>(state.seats.length).fill(0);
  state.vertexOwner.forEach((owner, v) => {
    if (owner < 0) return;
    if (state.vertexIsCity[v]) cities[owner]!++;
    else settlements[owner]!++;
  });

  // endReason carries the FRAMEWORK seat; map it back to an engine seat
  let winnerSeat = -1;
  if (state.endReason.startsWith("win:")) {
    const frameworkSeat = Number(state.endReason.slice(4));
    for (const p of state.players.values()) {
      if (p.seat === frameworkSeat) {
        winnerSeat = [...state.seats].findIndex((s) => s.sessionId === p.sessionId);
        break;
      }
    }
  }

  const rows = [...state.seats]
    .map((seat, i) => ({ seat, i }))
    .filter(({ seat }) => !seat.neutral)
    .sort((a, b) => b.seat.publicVP - a.seat.publicVP || a.i - b.i)
    .map(({ seat, i }) => {
      const devVP = Math.max(
        0,
        seat.publicVP -
          settlements[i]! -
          2 * cities[i]! -
          (seat.hasLongestRoad ? 2 : 0) -
          (seat.hasLargestArmy ? 2 : 0),
      );
      const bits: string[] = [];
      if (settlements[i]) bits.push(`🏠×${settlements[i]}`);
      if (cities[i]) bits.push(`🏛×${cities[i]}`);
      if (seat.hasLongestRoad) bits.push("🛤 Longest Road +2");
      if (seat.hasLargestArmy) bits.push("♞ Largest Army +2");
      if (devVP > 0) bits.push(`⭐ VP cards ×${devVP}`);
      const you = seat.sessionId && seat.sessionId === ctx.mySessionId ? " (you)" : "";
      return `
        <div class="catan-summary-row ${i === winnerSeat ? "catan-summary-winner" : ""}">
          <span class="catan-color" style="background:${PLAYER_COLOR[seat.color] ?? "#999"}"></span>
          <strong>${i === winnerSeat ? "👑 " : ""}${escapeHtml(seat.nickname)}${you}</strong>
          <span class="catan-summary-vp">${seat.publicVP} VP</span>
          <span class="muted">${bits.join(" · ") || "—"}</span>
        </div>`;
    })
    .join("");

  const neutralLR = [...state.seats].find((s) => s.neutral && s.hasLongestRoad);
  container.innerHTML = `
    <div class="catan-summary">
      ${rows}
      ${neutralLR ? `<p class="muted">Longest Road ended with ${escapeHtml(neutralLR.nickname)} — nobody scores it.</p>` : ""}
    </div>`;
}

export class CatanView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, CatanState>;
  private ctx?: GameViewContext;
  private readonly onState = () => this.render();
  private readonly onClick = (ev: Event) => this.handleClick(ev);

  // ---- ephemeral UI intent (cleared when its prompting condition vanishes) --
  private buildMode: "road" | "settlement" | "city" | null = null;
  private neutralPick: { neutralId: 0 | 1; kind: "road" | "settlement" } | null = null;
  private discardPick: Bag = zeroBag();
  private givebackPick: Bag = zeroBag();
  private devPick: { kind: "yearOfPlenty"; chosen: Res[] } | { kind: "monopoly" } | null = null;
  private tradeComposing = false;
  private tradeGivePick: Bag = zeroBag();
  private tradeReceivePick: Bag = zeroBag();
  private bankGive: Res | null = null;

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, CatanState>;
    this.ctx = ctx;
    root.innerHTML = `
      <div class="catan">
        <div id="catan-status" class="catan-status"></div>
        <div class="catan-board-wrap"><div id="catan-board"></div></div>
        <div id="catan-actions" class="catan-actions"></div>
        <div id="catan-modal"></div>
        <div id="catan-me" class="catan-me"></div>
        <div id="catan-opponents" class="catan-opponents"></div>
        <div id="catan-log" class="catan-log"></div>
      </div>`;
    root.addEventListener("click", this.onClick);
    this.room.onStateChange(this.onState);
    this.render();
  }

  unmount(): void {
    this.room?.onStateChange.remove(this.onState);
    this.root?.removeEventListener("click", this.onClick);
    this.root = undefined;
    this.room = undefined;
    this.ctx = undefined;
  }

  // ---- derived state ---------------------------------------------------------

  private st(): CatanState {
    return this.room!.state;
  }

  private mySeat(): number {
    const sid = this.ctx!.mySessionId;
    return [...this.st().seats].findIndex((s) => s.sessionId === sid);
  }

  private seat(i: number): CatanSeat | undefined {
    return this.st().seats[i];
  }

  private isMyDecision(): boolean {
    const me = this.mySeat();
    return me >= 0 && [...this.st().awaitingSeats].includes(me);
  }

  private myHand(): Bag {
    const seat = this.seat(this.mySeat());
    const h = seat?.hand;
    return {
      lumber: h?.lumber ?? 0,
      brick: h?.brick ?? 0,
      wool: h?.wool ?? 0,
      grain: h?.grain ?? 0,
      ore: h?.ore ?? 0,
    };
  }

  private canAfford(cost: Partial<Bag>): boolean {
    const hand = this.myHand();
    return RESOURCES.every((r) => hand[r] >= (cost[r] ?? 0));
  }

  private nickname(seatIdx: number): string {
    return escapeHtml(this.seat(seatIdx)?.nickname || `Seat ${seatIdx + 1}`);
  }

  /** 2p token action price from public VP (mirrors the server's rule). */
  private tokenCost(): number {
    const s = this.st();
    const me = this.mySeat();
    const opp = [...s.seats].findIndex((seat, i) => i !== me && !seat.neutral);
    if (me < 0 || opp < 0) return 1;
    return (this.seat(me)?.publicVP ?? 0) <= (this.seat(opp)?.publicVP ?? 0) ? 1 : 2;
  }

  private send(action: Record<string, unknown>): void {
    this.room?.send(CatanMsg.ACTION, action);
  }

  // ---- render ------------------------------------------------------------------

  private render(): void {
    if (!this.root || !this.room || !this.ctx) return;
    const s = this.st();
    const me = this.mySeat();
    const mine = this.isMyDecision();

    // drop stale local intent when its phase is gone
    if (s.phaseDetail !== "discard") this.discardPick = zeroBag();
    if (s.phaseDetail !== "forcedTradeGive") this.givebackPick = zeroBag();
    if (s.phaseDetail !== "neutralBuild") this.neutralPick = null;
    if (s.phaseDetail !== "main" || !mine) {
      this.buildMode = null;
      this.devPick = null;
      this.bankGive = null;
      if (!s.tradeOpen) this.tradeComposing = this.tradeComposing && s.phaseDetail === "main" && mine;
    }
    if (s.tradeOpen) this.tradeComposing = false;

    this.renderStatus(s, me);
    this.renderBoard(s, me, mine);
    this.renderActions(s, me, mine);
    this.renderModal(s, me, mine);
    this.renderMe(s, me);
    this.renderOpponents(s, me);
    this.renderLog(s);
  }

  private renderStatus(s: CatanState, me: number): void {
    const el = this.root!.querySelector<HTMLElement>("#catan-status")!;
    const who = (i: number) => (i === me ? "<strong>You</strong>" : `<strong>${this.nickname(i)}</strong>`);
    let line = "";
    switch (s.phaseDetail) {
      case "setupSettlement":
        line = `${who(s.currentSeat)} place${s.currentSeat === me ? "" : "s"} a starting settlement`;
        break;
      case "setupRoad":
        line = `${who(s.currentSeat)} place${s.currentSeat === me ? "" : "s"} the matching road`;
        break;
      case "preRoll":
        line = `${who(s.currentSeat)} to roll${s.twoPlayerVariant ? ` (roll ${s.rollsThisTurn + 1} of 2)` : ""}`;
        break;
      case "discard": {
        const waits = [...s.awaitingSeats]
          .map((seatIdx, i) => `${this.nickname(seatIdx)} (${s.discardOwed[i] ?? 0})`)
          .join(", ");
        line = `Rolled 7 — discarding: ${waits}`;
        break;
      }
      case "moveRobber":
        line = `${who(s.currentSeat)} move${s.currentSeat === me ? "" : "s"} the robber`;
        break;
      case "steal":
        line = `${who(s.currentSeat)} pick${s.currentSeat === me ? "" : "s"} who to rob`;
        break;
      case "neutralBuild":
        line = `${who(s.currentSeat)} place${s.currentSeat === me ? "" : "s"} a free piece for a neutral player`;
        break;
      case "forcedTradeGive":
        line = `${who(s.currentSeat)} give${s.currentSeat === me ? "" : "s"} back 2 cards`;
        break;
      default:
        line = `${who(s.currentSeat)}${s.currentSeat === me ? "r" : "'s"} turn`;
    }
    const dice =
      s.dice1 > 0
        ? `<span class="catan-dice">🎲 ${s.dice1}+${s.dice2} = ${s.dice1 + s.dice2}${
            s.twoPlayerVariant && s.rollsThisTurn === 2 && s.firstDice1 > 0
              ? ` <span class="muted">(1st: ${s.firstDice1 + s.firstDice2})</span>`
              : ""
          }</span>`
        : "";
    const tokens = s.twoPlayerVariant ? `<span class="muted">· supply ${s.tokenSupply} ⬡</span>` : "";
    el.innerHTML = `${line} ${dice} ${tokens}`;
  }

  private renderBoard(s: CatanState, me: number, mine: boolean): void {
    const board = boardFromState(s);
    const ui: BoardUi = {};
    if (mine) {
      switch (s.phaseDetail) {
        case "setupSettlement":
          ui.legalVertices = new Set(getValidInitialSettlements(geo, board));
          break;
        case "setupRoad":
          if (s.lastSettlementVertex >= 0) {
            ui.legalEdges = new Set(getValidRoads(geo, board, me, { setupVertex: s.lastSettlementVertex }));
          }
          break;
        case "moveRobber":
          ui.legalHexes = new Set(geo.hexes.map((h) => h.id).filter((h) => h !== s.robberHex));
          break;
        case "main":
          if (this.buildMode === "road") ui.legalEdges = new Set(getValidRoads(geo, board, me));
          else if (this.buildMode === "settlement") ui.legalVertices = new Set(getValidSettlements(geo, board, me));
          else if (this.buildMode === "city") ui.legalVertices = new Set(getValidCities(board, me));
          else if (s.freeRoads > 0) ui.legalEdges = new Set(getValidRoads(geo, board, me));
          break;
        case "neutralBuild":
          if (this.neutralPick) {
            const neutralSeat = 2 + this.neutralPick.neutralId;
            ui.legalEdges = this.neutralPick.kind === "road" ? new Set(getValidRoads(geo, board, neutralSeat)) : undefined;
            ui.legalVertices =
              this.neutralPick.kind === "settlement" ? new Set(getValidSettlements(geo, board, neutralSeat)) : undefined;
          }
          break;
      }
    }
    this.root!.querySelector<HTMLElement>("#catan-board")!.innerHTML = renderBoardSvg(geo, s, ui);
  }

  private renderActions(s: CatanState, me: number, mine: boolean): void {
    const el = this.root!.querySelector<HTMLElement>("#catan-actions")!;
    if (!mine || s.phaseDetail !== "main" && s.phaseDetail !== "preRoll") {
      el.innerHTML = "";
      return;
    }
    const hand = this.myHand();
    const seat = this.seat(me);
    const buttons: string[] = [];
    if (s.phaseDetail === "preRoll") {
      buttons.push(`<button class="primary" data-action="roll">🎲 Roll dice</button>`);
    } else {
      const mode = (m: string, label: string, enabled: boolean) =>
        buttons.push(
          `<button data-action="mode" data-mode="${m}" class="${this.buildMode === m ? "catan-mode-on" : ""}" ${
            enabled ? "" : "disabled"
          }>${label}</button>`,
        );
      if (s.freeRoads > 0) {
        buttons.push(`<span class="catan-free-roads">Free roads: ${s.freeRoads} — tap an edge</span>`);
      } else {
        mode("road", `🛤 Road`, this.canAfford(COSTS.road) && (seat?.roadsLeft ?? 0) > 0);
        mode("settlement", `🏠 Settlement`, this.canAfford(COSTS.settlement) && (seat?.settlementsLeft ?? 0) > 0);
        mode("city", `🏛 City`, this.canAfford(COSTS.city) && (seat?.citiesLeft ?? 0) > 0);
        buttons.push(
          `<button data-action="buy-dev" ${this.canAfford(COSTS.devCard) && s.devDeckCount > 0 ? "" : "disabled"}>🃏 Buy dev (${s.devDeckCount})</button>`,
          `<button data-action="trade" ${s.tradeOpen ? "disabled" : ""}>⇄ Trade</button>`,
        );
        if (s.twoPlayerVariant) {
          const cost = this.tokenCost();
          const tokens = seat?.tradeTokens ?? 0;
          const oppIdx = [...s.seats].findIndex((x, i) => i !== me && !x.neutral);
          const oppHand = this.seat(oppIdx)?.handCount ?? 0;
          const canForce = tokens >= cost && oppHand >= 1 && bagTotal(hand) + Math.min(2, oppHand) >= 2;
          buttons.push(
            `<button data-action="forced-trade" ${canForce ? "" : "disabled"}>⬡${cost} Forced trade</button>`,
          );
          const desert = [...s.hexTerrain].indexOf("desert");
          const canTokenRobber = tokens >= cost && desert >= 0 && s.robberHex !== desert;
          buttons.push(
            `<button data-action="token-robber" ${canTokenRobber ? "" : "disabled"}>⬡${cost} Robber → desert</button>`,
          );
          const hasFaceUpKnight = [...(seat?.devCards ?? [])].some((c) => c.kind === "knight" && c.played);
          buttons.push(
            `<button data-action="discard-knight" ${!s.knightDiscardedThisTurn && hasFaceUpKnight ? "" : "disabled"}>♞ → 2⬡</button>`,
          );
        }
        buttons.push(`<button class="primary" data-action="end-turn">End turn ➤</button>`);
      }
    }
    el.innerHTML = buttons.join("");
  }

  private renderModal(s: CatanState, me: number, mine: boolean): void {
    const el = this.root!.querySelector<HTMLElement>("#catan-modal")!;
    const meOwes = s.phaseDetail === "discard" && [...s.awaitingSeats].includes(me);

    if (meOwes) {
      const idx = [...s.awaitingSeats].indexOf(me);
      const owed = s.discardOwed[idx] ?? 0;
      el.innerHTML = this.pickerHtml(
        `Discard ${owed} card${owed === 1 ? "" : "s"} (you have ${this.seat(me)?.handCount ?? 0})`,
        this.discardPick,
        this.myHand(),
        "discard",
        bagTotal(this.discardPick) === owed,
        "Discard",
      );
      return;
    }
    if (mine && s.phaseDetail === "steal") {
      const targets = this.stealTargets(s, me);
      el.innerHTML = `
        <div class="catan-panel">
          <h3>Steal one random card from…</h3>
          <div class="catan-row">
            ${targets
              .map(
                (t) =>
                  `<button data-action="steal" data-id="${t}">${this.nickname(t)} (${this.seat(t)?.handCount ?? 0} cards)</button>`,
              )
              .join("")}
          </div>
        </div>`;
      return;
    }
    if (mine && s.phaseDetail === "neutralBuild") {
      const board = boardFromState(s);
      const opts: string[] = [];
      ([0, 1] as const).forEach((nId) => {
        const seatIdx = 2 + nId;
        const roads = getValidRoads(geo, board, seatIdx).length > 0 && (this.seat(seatIdx)?.roadsLeft ?? 0) > 0;
        const setts = getValidSettlements(geo, board, seatIdx).length > 0 && (this.seat(seatIdx)?.settlementsLeft ?? 0) > 0;
        const on = (kind: string) =>
          this.neutralPick?.neutralId === nId && this.neutralPick.kind === kind ? "catan-mode-on" : "";
        if (roads)
          opts.push(
            `<button class="${on("road")}" data-action="neutral-pick" data-n="${nId}" data-kind="road">🛤 Road for ${this.nickname(seatIdx)}</button>`,
          );
        if (setts)
          opts.push(
            `<button class="${on("settlement")}" data-action="neutral-pick" data-n="${nId}" data-kind="settlement">🏠 Settlement for ${this.nickname(seatIdx)}</button>`,
          );
      });
      el.innerHTML = `
        <div class="catan-panel">
          <h3>Free build for a neutral player (${s.pendingNeutralBuilds} owed)</h3>
          <div class="catan-row">${opts.join("")}</div>
          ${this.neutralPick ? `<p class="muted">Now tap a highlighted spot on the board.</p>` : ""}
        </div>`;
      return;
    }
    if (mine && s.phaseDetail === "forcedTradeGive") {
      el.innerHTML = this.pickerHtml(
        "Give 2 cards back to your opponent",
        this.givebackPick,
        this.myHand(),
        "giveback",
        bagTotal(this.givebackPick) === 2,
        "Give back",
      );
      return;
    }
    if (this.devPick) {
      if (this.devPick.kind === "monopoly") {
        el.innerHTML = `
          <div class="catan-panel">
            <h3>Monopoly: name a resource</h3>
            <div class="catan-row">
              ${RESOURCES.map((r) => `<button data-action="monopoly-pick" data-res="${r}">${resourceIcon(r)} ${r}</button>`).join("")}
            </div>
            <button class="subtle" data-action="dev-cancel">Cancel</button>
          </div>`;
      } else {
        const chosen = this.devPick.chosen;
        el.innerHTML = `
          <div class="catan-panel">
            <h3>Year of Plenty: take any 2 from the bank</h3>
            <div class="catan-row">
              ${RESOURCES.map((r) => `<button data-action="yop-pick" data-res="${r}">${resourceIcon(r)} ${r}</button>`).join("")}
            </div>
            <p>${chosen.length ? `Chosen: ${chosen.map(resourceIcon).join(" ")}` : "Pick two."}</p>
            <button class="subtle" data-action="dev-cancel">Cancel</button>
          </div>`;
      }
      return;
    }
    if (s.tradeOpen) {
      el.innerHTML = this.tradePanelHtml(s, me);
      return;
    }
    if (this.tradeComposing && mine && s.phaseDetail === "main") {
      el.innerHTML = this.tradeComposeHtml(s, me);
      return;
    }
    el.innerHTML = "";
  }

  /** Steal candidates the server would accept (public info). */
  private stealTargets(s: CatanState, me: number): number[] {
    const targets = new Set<number>();
    for (const v of geo.hexes[s.robberHex]!.vertices) {
      const owner = s.vertexOwner[v] ?? -1;
      if (owner >= 0 && owner !== me && !this.seat(owner)?.neutral && (this.seat(owner)?.handCount ?? 0) > 0) {
        targets.add(owner);
      }
    }
    return [...targets].sort((a, b) => a - b);
  }

  /** A +/- stepper bag picker with one confirm button. */
  private pickerHtml(title: string, pick: Bag, limitBag: Bag, action: string, ready: boolean, cta: string): string {
    return `
      <div class="catan-panel">
        <h3>${title}</h3>
        <div class="catan-picker">
          ${RESOURCES.map(
            (r) => `
            <div class="catan-picker-row">
              <span>${resourceIcon(r)} ${pick[r]}</span>
              <span class="muted">/ ${limitBag[r]}</span>
              <button data-action="${action}-minus" data-res="${r}" ${pick[r] > 0 ? "" : "disabled"}>−</button>
              <button data-action="${action}-plus" data-res="${r}" ${pick[r] < limitBag[r] ? "" : "disabled"}>+</button>
            </div>`,
          ).join("")}
        </div>
        <button class="primary" data-action="${action}-confirm" ${ready ? "" : "disabled"}>${cta}</button>
      </div>`;
  }

  private tradeComposeHtml(s: CatanState, me: number): string {
    const hand = this.myHand();
    const board = boardFromState(s);
    const access = portAccess(board, me);
    const stepper = (label: string, pick: Bag, limit: (r: Res) => number, prefix: string) => `
      <div class="catan-trade-side">
        <h4>${label}</h4>
        ${RESOURCES.map(
          (r) => `
          <div class="catan-picker-row">
            <span>${resourceIcon(r)} ${pick[r]}</span>
            <button data-action="${prefix}-minus" data-res="${r}" ${pick[r] > 0 ? "" : "disabled"}>−</button>
            <button data-action="${prefix}-plus" data-res="${r}" ${pick[r] < limit(r) ? "" : "disabled"}>+</button>
          </div>`,
        ).join("")}
      </div>`;
    const give = this.tradeGivePick;
    const receive = this.tradeReceivePick;
    const canPropose = bagTotal(give) > 0 && bagTotal(receive) > 0 && RESOURCES.every((r) => give[r] <= hand[r]);
    // bank trade: pick a give resource at your best ratio, then a receive
    const bankRows = RESOURCES.map((r) => {
      const ratio = bestTradeRatio(access, r);
      const armed = this.bankGive === r;
      return `<button data-action="bank-give" data-res="${r}" class="${armed ? "catan-mode-on" : ""}" ${
        hand[r] >= ratio ? "" : "disabled"
      }>${ratio}${resourceIcon(r)} → 1</button>`;
    }).join("");
    const bankReceive = this.bankGive
      ? `<div class="catan-row">${RESOURCES.filter((r) => r !== this.bankGive)
          .map((r) => `<button data-action="bank-receive" data-res="${r}">take ${resourceIcon(r)}</button>`)
          .join("")}</div>`
      : "";
    return `
      <div class="catan-panel">
        <h3>Trade</h3>
        <div class="catan-trade-grid">
          ${stepper("You give", give, (r) => hand[r], "tgive")}
          ${stepper("You want", receive, () => 19, "trecv")}
        </div>
        <button class="primary" data-action="trade-propose" ${canPropose ? "" : "disabled"}>Offer to everyone</button>
        <h4>Bank / ports</h4>
        <div class="catan-row">${bankRows}</div>
        ${bankReceive}
        <button class="subtle" data-action="trade-close">Close</button>
      </div>`;
  }

  private tradePanelHtml(s: CatanState, me: number): string {
    const bagStr = (b: { [K in Res]: number }) =>
      RESOURCES.filter((r) => b[r] > 0)
        .map((r) => `${b[r]}${resourceIcon(r)}`)
        .join(" ") || "nothing";
    const give = bagStr(s.tradeGive as unknown as Bag);
    const receive = bagStr(s.tradeReceive as unknown as Bag);
    const iAmProposer = s.tradeProposer === me;
    const accepted = new Set([...s.tradeAcceptances]);
    if (iAmProposer) {
      const rows = [...s.tradeCandidates]
        .map((c) => {
          const ok = accepted.has(c);
          return `<div class="catan-picker-row"><span>${this.nickname(c)}</span><span>${
            ok ? "✅ accepted" : "…waiting"
          }</span>${ok ? `<button class="primary" data-action="trade-confirm" data-id="${c}">Trade</button>` : ""}</div>`;
        })
        .join("");
      return `
        <div class="catan-panel">
          <h3>Your offer: ${give} ⇄ ${receive}</h3>
          ${rows}
          <button class="subtle" data-action="trade-cancel">Withdraw offer</button>
        </div>`;
    }
    const amCandidate = [...s.tradeCandidates].includes(me);
    const myAnswer = accepted.has(me);
    return `
      <div class="catan-panel">
        <h3>${this.nickname(s.tradeProposer)} offers ${give} for ${receive}</h3>
        ${
          amCandidate
            ? `<div class="catan-row">
                 <button class="primary" data-action="trade-respond" data-accept="1" ${myAnswer ? "disabled" : ""}>Accept</button>
                 <button data-action="trade-respond" data-accept="0" ${myAnswer ? "" : "disabled"}>Decline</button>
               </div>
               ${myAnswer ? '<p class="muted">Accepted — waiting for the proposer to confirm.</p>' : ""}`
            : '<p class="muted">Waiting…</p>'
        }
      </div>`;
  }

  private renderMe(s: CatanState, me: number): void {
    const el = this.root!.querySelector<HTMLElement>("#catan-me")!;
    const seat = this.seat(me);
    if (!seat) {
      el.innerHTML = "";
      return;
    }
    const hand = this.myHand();
    const chips = RESOURCES.map((r) => `<span class="catan-chip">${resourceIcon(r)} ${hand[r]}</span>`).join("");
    const playableNow = (kind: string, c: { boughtThisTurn: boolean; played: boolean }) =>
      !c.played &&
      !c.boughtThisTurn &&
      kind !== "victoryPoint" &&
      !s.devCardPlayedThisTurn &&
      this.isMyDecision() &&
      (s.phaseDetail === "main" || (s.phaseDetail === "preRoll" && kind === "knight"));
    const cards = [...(seat.devCards ?? [])]
      .map((c, i) => {
        if (c.played) return "";
        const label = devLabel(c.kind);
        const canPlay = playableNow(c.kind, c);
        return `<span class="catan-dev ${c.boughtThisTurn ? "catan-dev-new" : ""}">${label}${
          c.kind !== "victoryPoint"
            ? ` <button data-action="play-dev" data-kind="${c.kind}" data-idx="${i}" ${canPlay ? "" : "disabled"}>play</button>`
            : ""
        }</span>`;
      })
      .join("");
    const tokens = s.twoPlayerVariant ? `<span class="catan-chip">⬡ ${seat.tradeTokens}</span>` : "";
    el.innerHTML = `
      <div class="catan-mine">
        <span class="catan-color" style="background:${PLAYER_COLOR[seat.color] ?? "#999"}"></span>
        <strong>You</strong> · ${seat.publicVP} VP
        ${seat.hasLongestRoad ? "🛤🏆" : ""}${seat.hasLargestArmy ? "♞🏆" : ""}
        <span class="muted">pieces: ${seat.roadsLeft}🛤 ${seat.settlementsLeft}🏠 ${seat.citiesLeft}🏛</span>
      </div>
      <div class="catan-hand">${chips}${tokens}</div>
      ${cards ? `<div class="catan-devs">${cards}</div>` : ""}`;
  }

  private renderOpponents(s: CatanState, me: number): void {
    const el = this.root!.querySelector<HTMLElement>("#catan-opponents")!;
    const rows = [...s.seats]
      .map((seat, i) => {
        if (i === me) return "";
        const player = seat.sessionId ? s.players.get(seat.sessionId) : undefined;
        const badges: string[] = [];
        if (seat.neutral) badges.push('<span class="catan-badge">neutral</span>');
        if (player?.isBot) badges.push('<span class="catan-badge">AI</span>');
        if (seat.gone) badges.push('<span class="catan-badge catan-badge-warn">autopilot</span>');
        else if (player && !player.connected) badges.push('<span class="catan-badge catan-badge-warn">reconnecting…</span>');
        if (s.currentSeat === i && s.phaseDetail !== "gameOver") badges.push('<span class="catan-badge catan-badge-turn">turn</span>');
        const stats = seat.neutral
          ? `<span class="muted">roads ${15 - seat.roadsLeft} · settlements ${5 - seat.settlementsLeft}</span>`
          : `<span class="muted">✋${seat.handCount} 🃏${seat.devCardCount} ♞${seat.knightsPlayed}${
              s.twoPlayerVariant ? ` ⬡${seat.tradeTokens}` : ""
            }</span>`;
        return `
          <div class="catan-opp">
            <span class="catan-color" style="background:${PLAYER_COLOR[seat.color] ?? "#999"}"></span>
            <strong>${escapeHtml(seat.nickname)}</strong>
            ${seat.neutral ? "" : `<span class="catan-vp">${seat.publicVP} VP</span>`}
            ${seat.hasLongestRoad ? "🛤🏆" : ""}${seat.hasLargestArmy ? "♞🏆" : ""}
            ${stats}
            ${badges.join("")}
          </div>`;
      })
      .join("");
    el.innerHTML = rows;
  }

  private renderLog(s: CatanState): void {
    const el = this.root!.querySelector<HTMLElement>("#catan-log")!;
    el.innerHTML = [...s.log]
      .slice(-7)
      .map((l) => `<div>${escapeHtml(l)}</div>`)
      .join("");
    el.scrollTop = el.scrollHeight;
  }

  // ---- input -------------------------------------------------------------------

  private handleClick(ev: Event): void {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
    if (!target || !this.room || target.hasAttribute("disabled")) return;
    const s = this.st();
    const me = this.mySeat();
    const data = target.dataset;
    const id = Number(data.id);
    const res = data.res as Res | undefined;

    switch (data.action) {
      // board taps
      case "tap-vertex":
        if (s.phaseDetail === "setupSettlement") this.send({ type: "placeSetupSettlement", vertex: id });
        else if (s.phaseDetail === "neutralBuild" && this.neutralPick?.kind === "settlement") {
          this.send({ type: "buildNeutral", neutralId: this.neutralPick.neutralId, kind: "settlement", vertex: id });
          this.neutralPick = null;
        } else if (this.buildMode === "settlement") {
          this.send({ type: "buildSettlement", vertex: id });
          this.buildMode = null;
        } else if (this.buildMode === "city") {
          this.send({ type: "buildCity", vertex: id });
          this.buildMode = null;
        }
        return;
      case "tap-edge":
        if (s.phaseDetail === "setupRoad") this.send({ type: "placeSetupRoad", edge: id });
        else if (s.phaseDetail === "neutralBuild" && this.neutralPick?.kind === "road") {
          this.send({ type: "buildNeutral", neutralId: this.neutralPick.neutralId, kind: "road", edge: id });
          this.neutralPick = null;
        } else if (this.buildMode === "road" || s.freeRoads > 0) {
          this.send({ type: "buildRoad", edge: id });
          if (this.buildMode === "road" && s.freeRoads === 0) this.buildMode = null;
        }
        return;
      case "tap-hex":
        if (s.phaseDetail === "moveRobber") this.send({ type: "moveRobber", hex: id });
        return;
      // action bar
      case "roll":
        this.send({ type: "rollDice" });
        return;
      case "end-turn":
        this.send({ type: "endTurn" });
        return;
      case "mode":
        this.buildMode = this.buildMode === data.mode ? null : (data.mode as typeof this.buildMode);
        this.render();
        return;
      case "buy-dev":
        this.send({ type: "buyDevCard" });
        return;
      case "trade":
        this.tradeComposing = true;
        this.tradeGivePick = zeroBag();
        this.tradeReceivePick = zeroBag();
        this.bankGive = null;
        this.render();
        return;
      case "forced-trade":
        this.send({ type: "playForcedTrade" });
        return;
      case "token-robber":
        this.send({ type: "playTokenRobber" });
        return;
      case "discard-knight":
        this.send({ type: "discardKnightForTokens" });
        return;
      // dev cards
      case "play-dev":
        if (data.kind === "knight") this.send({ type: "playKnight" });
        else if (data.kind === "roadBuilding") this.send({ type: "playRoadBuilding" });
        else if (data.kind === "yearOfPlenty") {
          this.devPick = { kind: "yearOfPlenty", chosen: [] };
          this.render();
        } else if (data.kind === "monopoly") {
          this.devPick = { kind: "monopoly" };
          this.render();
        }
        return;
      case "dev-cancel":
        this.devPick = null;
        this.render();
        return;
      case "monopoly-pick":
        if (res) this.send({ type: "playMonopoly", resource: res });
        this.devPick = null;
        return;
      case "yop-pick":
        if (this.devPick?.kind === "yearOfPlenty" && res) {
          this.devPick.chosen.push(res);
          if (this.devPick.chosen.length === 2) {
            this.send({ type: "playYearOfPlenty", resources: this.devPick.chosen });
            this.devPick = null;
          }
          this.render();
        }
        return;
      // steal
      case "steal":
        this.send({ type: "steal", target: id });
        return;
      // neutral build picker
      case "neutral-pick":
        this.neutralPick = { neutralId: Number(data.n) as 0 | 1, kind: data.kind as "road" | "settlement" };
        this.render();
        return;
      // discard picker
      case "discard-minus":
      case "discard-plus":
        if (res) {
          this.discardPick[res] += data.action === "discard-plus" ? 1 : -1;
          this.render();
        }
        return;
      case "discard-confirm":
        this.send({ type: "discard", cards: { ...this.discardPick } });
        return;
      // forced-trade give-back picker
      case "giveback-minus":
      case "giveback-plus":
        if (res) {
          this.givebackPick[res] += data.action === "giveback-plus" ? 1 : -1;
          this.render();
        }
        return;
      case "giveback-confirm":
        this.send({ type: "forcedTradeGiveBack", cards: { ...this.givebackPick } });
        return;
      // trade compose
      case "tgive-minus":
      case "tgive-plus":
        if (res) {
          this.tradeGivePick[res] += data.action === "tgive-plus" ? 1 : -1;
          this.render();
        }
        return;
      case "trecv-minus":
      case "trecv-plus":
        if (res) {
          this.tradeReceivePick[res] += data.action === "trecv-plus" ? 1 : -1;
          this.render();
        }
        return;
      case "trade-propose":
        this.send({
          type: "proposeDomesticTrade",
          give: { ...this.tradeGivePick },
          receive: { ...this.tradeReceivePick },
        });
        this.tradeComposing = false;
        return;
      case "trade-close":
        this.tradeComposing = false;
        this.bankGive = null;
        this.render();
        return;
      case "bank-give":
        this.bankGive = this.bankGive === res ? null : (res ?? null);
        this.render();
        return;
      case "bank-receive":
        if (this.bankGive && res) {
          this.send({ type: "maritimeTrade", give: this.bankGive, receive: res });
          this.bankGive = null;
        }
        return;
      // trade respond / confirm / cancel
      case "trade-respond":
        this.send({ type: "respondDomesticTrade", accept: data.accept === "1" });
        return;
      case "trade-confirm":
        this.send({ type: "confirmDomesticTrade", partner: id });
        return;
      case "trade-cancel":
        this.send({ type: "cancelDomesticTrade" });
        return;
    }
  }
}

function devLabel(kind: string): string {
  switch (kind) {
    case "knight": return "♞ Knight";
    case "victoryPoint": return "⭐ Victory Point";
    case "roadBuilding": return "🛤 Road Building";
    case "yearOfPlenty": return "🌽 Year of Plenty";
    case "monopoly": return "💰 Monopoly";
    default: return kind;
  }
}
