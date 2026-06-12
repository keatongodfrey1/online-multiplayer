/**
 * Splendor view - renders the synced schema and sends raw engine Move /
 * Resolution JSON. The server validates everything; the legality mirrored
 * here (exact take-3 count, pile >= 4 for take-2, affordability) only
 * exists to grey out buttons.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  EndReason,
  LobbyMsg,
  Phase,
  SPLENDOR_TURN_MAX_SECONDS,
  SPLENDOR_TURN_STEP_SECONDS,
  SplendorEngine,
  SplendorMsg,
  type SplendorCard,
  type SplendorNoble,
  type SplendorSeat,
  type SplendorState,
} from "@backbone/shared";
import type { GameView, GameViewContext, LobbySettingsContext } from "../../framework/GameView.js";
import { escapeHtml } from "../../lobby/HomeScreen.js";
import { clockChime, isMuted, setMuted, turnChime } from "./sounds.js";

const GEMS = ["white", "blue", "green", "red", "black"] as const;
type Gem = (typeof GEMS)[number];
type DiscardColor = Gem | "gold";

function totalTokensOf(seat: SplendorSeat): number {
  return GEMS.reduce((sum, g) => sum + seat.gems[g], seat.gold);
}

/** Bridge a schema card to the engine type for the affordability helper. */
function toEngineCard(c: SplendorCard): SplendorEngine.Card {
  return {
    id: c.id,
    tier: c.tier as SplendorEngine.Tier,
    bonus: c.bonus as SplendorEngine.Color,
    points: c.points,
    cost: { white: c.cost.white, blue: c.cost.blue, green: c.cost.green, red: c.cost.red, black: c.cost.black },
  };
}

/** affordable() only reads gems/gold/bonuses; the rest is shape-filling. */
function toEnginePlayer(s: SplendorSeat): SplendorEngine.PlayerState {
  return {
    seat: 0,
    name: "",
    kind: "human",
    connected: true,
    gems: { white: s.gems.white, blue: s.gems.blue, green: s.gems.green, red: s.gems.red, black: s.gems.black },
    gold: s.gold,
    bonuses: {
      white: s.bonuses.white,
      blue: s.bonuses.blue,
      green: s.bonuses.green,
      red: s.bonuses.red,
      black: s.bonuses.black,
    },
    reserved: [],
    built: [],
    nobles: [],
  };
}

/** The same player as if they had already taken the selected gems. */
function withSelectedGems(p: SplendorEngine.PlayerState, selected: Set<Gem>): SplendorEngine.PlayerState {
  const gems = { ...p.gems };
  for (const g of selected) gems[g] += 1;
  return { ...p, gems };
}

function formatSeconds(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

// ---- save slots (host's browser keeps the box on its shelf) -------------------

const SAVES_KEY = "splendor-saves";
const MAX_SAVE_SLOTS = 12;

interface SaveSlot {
  id: string;
  label: string;
  savedAt: number;
  save: unknown;
}

function loadSaveSlots(): SaveSlot[] {
  try {
    const raw = localStorage.getItem(SAVES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as SaveSlot[]) : [];
  } catch {
    return [];
  }
}

function writeSaveSlots(slots: SaveSlot[]): void {
  try {
    localStorage.setItem(SAVES_KEY, JSON.stringify(slots.slice(0, MAX_SAVE_SLOTS)));
  } catch {
    // storage full/blocked - the in-game button will just not confirm
  }
}

/** Set by the mounted view so the once-per-room message handler can reach it. */
let onSaveStored: (() => void) | undefined;

function storeSaveSlot(save: unknown): void {
  const blob = save as { seats?: { nickname?: string }[]; engine?: { turnCount?: number } } | null;
  const names = (blob?.seats ?? []).map((s) => s?.nickname ?? "?").join(", ");
  const turn = (blob?.engine?.turnCount ?? 0) + 1;
  const slots = loadSaveSlots();
  slots.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    label: `${names} — turn ${turn}`,
    savedAt: Date.now(),
    save,
  });
  writeSaveSlots(slots);
}

/**
 * Lobby settings (GameDefinition.renderLobbySettings): the turn-timer picker.
 * The host gets a live dropdown; everyone else sees the current choice.
 * The server validates (host-only, lobby-only, 15s steps).
 */
export function renderSplendorLobbySettings(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: LobbySettingsContext
): void {
  const state = room.state as unknown as SplendorState;
  const current = state.turnSeconds ?? 0;
  const options: string[] = [`<option value="0" ${current === 0 ? "selected" : ""}>Off</option>`];
  for (let s = SPLENDOR_TURN_STEP_SECONDS; s <= SPLENDOR_TURN_MAX_SECONDS; s += SPLENDOR_TURN_STEP_SECONDS) {
    options.push(`<option value="${s}" ${current === s ? "selected" : ""}>${formatSeconds(s)}</option>`);
  }
  const seatsLeft = state.maxPlayers - state.players.size;
  const addBots = ctx.isHost
    ? seatsLeft > 0
      ? `<div class="spl-lobby-setting">AI opponent
           <button class="spl-add-bot" data-difficulty="easy">+ Easy AI</button>
           <button class="spl-add-bot" data-difficulty="hard">+ Hard AI</button>
         </div>`
      : `<div class="spl-lobby-setting muted">Table is full</div>`
    : "";
  // Saved games: slots live in this browser; loading stages the save on the
  // server, which then waits for the saved players before Start unlocks.
  let savedGames = "";
  if (state.loadedSave) {
    savedGames = `
      <div class="spl-loaded-save">
        <span class="badge warn">${escapeHtml(state.loadedSave)}</span>
        ${ctx.isHost ? '<button id="spl-load-clear" class="subtle">Cancel</button>' : ""}
      </div>`;
  } else if (ctx.isHost) {
    const slots = loadSaveSlots();
    if (slots.length > 0) {
      const rows = slots
        .map(
          (slot) => `
          <li class="spl-save-slot">
            <span>${escapeHtml(slot.label)}
              <span class="muted">· ${new Date(slot.savedAt).toLocaleString()}</span></span>
            <span>
              <button class="spl-load-slot" data-save-id="${escapeHtml(slot.id)}">Resume</button>
              <button class="subtle spl-delete-slot" data-save-id="${escapeHtml(slot.id)}">Delete</button>
            </span>
          </li>`
        )
        .join("");
      savedGames = `<details class="spl-saves"><summary>Saved games (${slots.length})</summary>
        <ul>${rows}</ul></details>`;
    }
  }

  container.innerHTML = `
    <label class="spl-lobby-setting">
      Turn timer
      <select id="spl-turn-seconds" ${ctx.isHost ? "" : "disabled"}>${options.join("")}</select>
      ${ctx.isHost ? "" : '<span class="muted">(host chooses)</span>'}
    </label>
    ${addBots}
    ${savedGames}`;
  container.querySelector<HTMLSelectElement>("#spl-turn-seconds")?.addEventListener("change", (ev) => {
    const turnSeconds = Number((ev.target as HTMLSelectElement).value);
    room.send(SplendorMsg.CONFIG, { turnSeconds });
  });
  container.querySelectorAll<HTMLButtonElement>(".spl-add-bot").forEach((btn) => {
    btn.addEventListener("click", () => {
      room.send(LobbyMsg.ADD_BOT, { difficulty: btn.dataset.difficulty });
    });
  });
  container.querySelector<HTMLButtonElement>("#spl-load-clear")?.addEventListener("click", () => {
    room.send(SplendorMsg.LOAD, null);
  });
  container.querySelectorAll<HTMLButtonElement>(".spl-load-slot").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slot = loadSaveSlots().find((s) => s.id === btn.dataset.saveId);
      if (slot) room.send(SplendorMsg.LOAD, slot.save);
    });
  });
  container.querySelectorAll<HTMLButtonElement>(".spl-delete-slot").forEach((btn) => {
    btn.addEventListener("click", () => {
      writeSaveSlots(loadSaveSlots().filter((s) => s.id !== btn.dataset.saveId));
      renderSplendorLobbySettings(container, room, ctx); // re-render in place
    });
  });
}

/**
 * Final-score table (GameDefinition.renderGameSummary): everything is
 * derived from the last synced seats, which the server leaves in place
 * when the game ends. Ordered like the engine's ranking: points first,
 * fewer cards bought breaking ties.
 */
export function renderSplendorGameSummary(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: GameViewContext
): void {
  const state = room.state as unknown as SplendorState;
  const seats = [...(state.seats ?? [])];
  if (seats.length === 0) return;

  // Crowns follow the actual result: the "win:<seat>" framework seat, or
  // the tied top of the ranking on a draw. An abandoned game crowns nobody.
  let winnerSessionIds: Set<string> | "draw" | undefined;
  if (state.endReason.startsWith(EndReason.WIN_PREFIX)) {
    const frameworkSeat = Number(state.endReason.slice(EndReason.WIN_PREFIX.length));
    const winner = [...state.players.values()].find((p) => p.seat === frameworkSeat);
    winnerSessionIds = new Set(winner ? [winner.sessionId] : []);
  } else if (state.endReason === EndReason.DRAW) {
    winnerSessionIds = "draw";
  }

  const rows = seats.map((seat) => {
    const tierPoints = [0, 0, 0];
    for (const card of seat.built) {
      if (card.tier >= 1 && card.tier <= 3) tierPoints[card.tier - 1]! += card.points;
    }
    const noblePoints = [...seat.nobles].reduce((sum, n) => sum + n.points, 0);
    return {
      seat,
      tierPoints,
      noblePoints,
      total: seat.points,
      cards: seat.built.length,
      mine: seat.sessionId !== "" && seat.sessionId === ctx.mySessionId,
      // A seat is departed if it was ghost-played OR its player is no
      // longer in the room (e.g. the leaver of an abandoned game).
      gone: seat.gone || (seat.sessionId !== "" && !state.players.has(seat.sessionId)),
    };
  });
  rows.sort((a, b) => b.total - a.total || a.cards - b.cards);
  const best = rows[0]!;
  const isWinner = (r: (typeof rows)[number]) => {
    if (winnerSessionIds === undefined) return false;
    if (winnerSessionIds === "draw") return r.total === best.total && r.cards === best.cards;
    return r.seat.sessionId !== "" && winnerSessionIds.has(r.seat.sessionId);
  };

  const body = rows
    .map((r) => {
      const name = `${isWinner(r) ? "👑 " : ""}${escapeHtml(r.seat.nickname)}${r.mine ? " (you)" : ""}${
        r.gone ? " · left" : ""
      }`;
      return `
        <tr class="${isWinner(r) ? "winner" : ""} ${r.gone ? "gone" : ""}">
          <td class="spl-sum-name">${name}</td>
          <td>${r.tierPoints[0]}</td>
          <td>${r.tierPoints[1]}</td>
          <td>${r.tierPoints[2]}</td>
          <td>${r.noblePoints}${r.seat.nobles.length > 0 ? ` <span class="muted">(${r.seat.nobles.length})</span>` : ""}</td>
          <td class="spl-sum-total">${r.total}</td>
          <td class="muted">${r.cards}</td>
        </tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="spl-summary">
      <thead>
        <tr>
          <th></th>
          <th title="Points from tier 1 cards">Tier 1</th>
          <th title="Points from tier 2 cards">Tier 2</th>
          <th title="Points from tier 3 cards">Tier 3</th>
          <th title="Points from nobles (count in parentheses)">Nobles</th>
          <th>Total</th>
          <th title="Cards bought - fewer wins a points tie">Cards</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
    <p class="muted spl-sum-note">Ties go to whoever bought fewer cards.</p>`;
}

function costPips(cost: { [K in Gem]: number }): string {
  return GEMS.filter((g) => cost[g] > 0)
    .map((g) => `<span class="spl-pip spl-${g}">${cost[g]}</span>`)
    .join("");
}

function cardHtml(card: SplendorCard, buttons: string, highlight = ""): string {
  return `
    <div class="spl-card spl-bonus-${card.bonus} ${highlight}">
      <div class="spl-card-top">
        <span class="spl-card-points">${card.points > 0 ? card.points : ""}</span>
        <span class="spl-pip spl-${card.bonus}"></span>
      </div>
      <div class="spl-card-cost">${costPips(card.cost)}</div>
      <div class="spl-card-actions">${buttons}</div>
    </div>`;
}

function nobleHtml(noble: SplendorNoble, button = ""): string {
  return `
    <div class="spl-noble">
      <span class="spl-card-points">${noble.points}</span>
      <span class="spl-card-cost">${costPips(noble.requirement)}</span>
      ${button}
    </div>`;
}

export class SplendorView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, SplendorState>;
  private ctx?: GameViewContext;
  private readonly onState = () => this.render();
  private readonly onClick = (ev: Event) => this.handleClick(ev);
  /** Ticks the countdown between patches (the deadline itself is synced). */
  private ticker?: ReturnType<typeof setInterval>;

  /** Take-3 pile selection; survives re-renders, cleared after sending. */
  private selectedColors = new Set<Gem>();
  /** Discard picker counts; reset whenever the discard prompt goes away. */
  private discardPick: Record<DiscardColor, number> = {
    white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0,
  };
  /** Chime bookkeeping: fire once per transition, not per render. */
  private wasMyTurn = false;
  private clockChimedFor = 0;
  /** Show "Saved ✓" on the save button until this timestamp. */
  private saveFlashUntil = 0;

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, SplendorState>;
    this.ctx = ctx;

    root.innerHTML = `
      <div class="spl">
        <p id="spl-status" class="center"></p>
        <div id="spl-nobles" class="spl-nobles"></div>
        <div id="spl-market"></div>
        <div id="spl-bank"></div>
        <div id="spl-modal"></div>
        <div id="spl-players">
          <div id="spl-me"></div>
          <div id="spl-opponents"></div>
        </div>
        <div id="spl-toast" aria-live="polite"></div>
      </div>
    `;
    root.addEventListener("click", this.onClick);
    this.room.onStateChange(this.onState);
    // SAVE_DATA arrives in response to the Save button. Message handlers on
    // the SDK room cannot be removed, and a rematch mounts a fresh view on
    // the SAME room - so register once per room and route through a
    // module-level hook that always points at the live view.
    const hooked = this.room as unknown as { __splSaveHooked?: boolean };
    if (!hooked.__splSaveHooked) {
      hooked.__splSaveHooked = true;
      this.room.onMessage(SplendorMsg.SAVE_DATA, (save: unknown) => {
        storeSaveSlot(save);
        onSaveStored?.();
      });
    }
    onSaveStored = () => {
      this.saveFlashUntil = Date.now() + 2000;
      this.render();
      setTimeout(() => this.render(), 2100); // drop the "Saved ✓" label again
    };
    this.ticker = setInterval(() => this.updateTimer(), 500);
    this.render();
  }

  unmount(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    onSaveStored = undefined;
    this.room?.onStateChange.remove(this.onState);
    this.root?.removeEventListener("click", this.onClick);
    this.root = undefined;
    this.room = undefined;
  }

  // ---- input -----------------------------------------------------------------

  private handleClick(ev: Event): void {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
    if (!target || !this.room || target.hasAttribute("disabled")) return;
    const data = target.dataset;
    switch (data.action) {
      case "toggle-take": {
        const color = data.color as Gem;
        if (this.selectedColors.has(color)) this.selectedColors.delete(color);
        else if (this.selectedColors.size < 3) this.selectedColors.add(color);
        this.render();
        return;
      }
      case "confirm-take":
        this.room.send(SplendorMsg.MOVE, { kind: "TAKE_THREE", colors: [...this.selectedColors] });
        this.selectedColors.clear();
        return;
      case "take-two":
        this.room.send(SplendorMsg.MOVE, { kind: "TAKE_TWO", color: data.color });
        this.selectedColors.clear();
        return;
      case "buy-market":
        this.room.send(SplendorMsg.MOVE, {
          kind: "BUY",
          from: { market: { tier: Number(data.tier), index: Number(data.index) } },
        });
        return;
      case "reserve-market":
        this.room.send(SplendorMsg.MOVE, {
          kind: "RESERVE",
          from: { market: { tier: Number(data.tier), index: Number(data.index) } },
        });
        return;
      case "reserve-deck":
        this.room.send(SplendorMsg.MOVE, { kind: "RESERVE", from: { deck: { tier: Number(data.tier) } } });
        return;
      case "buy-reserve":
        this.room.send(SplendorMsg.MOVE, { kind: "BUY", from: { reserve: { cardId: Number(data.cardId) } } });
        return;
      case "discard-step": {
        const color = data.color as DiscardColor;
        this.discardPick[color] = Math.max(0, this.discardPick[color] + Number(data.step));
        this.render();
        return;
      }
      case "confirm-discard": {
        const { gold, ...gems } = this.discardPick;
        const picked: Record<string, number> = {};
        for (const g of GEMS) if (gems[g] > 0) picked[g] = gems[g];
        this.room.send(SplendorMsg.RESOLVE, { kind: "DISCARD", gems: picked, gold });
        return;
      }
      case "pick-noble":
        this.room.send(SplendorMsg.RESOLVE, { kind: "PICK_NOBLE", nobleId: Number(data.nobleId) });
        return;
      case "toggle-pause":
        this.room.send(SplendorMsg.PAUSE, { paused: !this.room.state.paused });
        return;
      case "save-game":
        this.room.send(SplendorMsg.SAVE, {});
        return;
      case "toggle-mute":
        setMuted(!isMuted());
        this.render();
        return;
    }
  }

  // ---- rendering ---------------------------------------------------------------

  private render(): void {
    if (!this.root || !this.room || !this.ctx) return;
    const state = this.room.state;
    if (!state?.seats) return;

    const seats = [...state.seats];
    const mySeatIndex = seats.findIndex((s) => s.sessionId === this.ctx!.mySessionId);
    const me = mySeatIndex >= 0 ? seats[mySeatIndex] : undefined;
    const actorSeat = seats[state.awaitingSeat];
    const isMyDecision = state.awaitingSeat === mySeatIndex && mySeatIndex >= 0 && !state.paused;
    const myMove = isMyDecision && state.awaitingType === "MOVE";

    if (state.awaitingType !== "DISCARD" || !isMyDecision) {
      this.discardPick = { white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 };
    }
    if (!myMove) this.selectedColors.clear();

    // Audio + visual nudge the moment the turn becomes mine (timer or not).
    const myTurnNow =
      state.phase === Phase.PLAYING && !state.paused && state.currentTurn === this.ctx.mySessionId;
    if (myTurnNow && !this.wasMyTurn) {
      turnChime();
      this.flashToast("Your turn!");
    }
    this.wasMyTurn = myTurnNow;

    this.renderStatus(state, actorSeat, isMyDecision);
    this.renderNobles(state);
    this.renderMarket(state, me, myMove);
    this.renderBank(state, me, myMove);
    this.renderModal(state, me, isMyDecision);
    this.renderMe(state, me, myMove);
    this.renderOpponents(state, seats, mySeatIndex);
  }

  private q(id: string): HTMLElement {
    return this.root!.querySelector<HTMLElement>(`#${id}`)!;
  }

  /**
   * Center-screen flash that dismisses itself (a "toast"). It is
   * click-through (pointer-events: none in CSS), so a player can start
   * acting underneath it before it has even faded - it never gates input.
   * Re-adding the class restarts the CSS animation for back-to-back turns.
   */
  private flashToast(text: string): void {
    const toast = this.root?.querySelector<HTMLElement>("#spl-toast");
    if (!toast) return;
    toast.textContent = text;
    toast.classList.remove("show");
    void toast.offsetWidth; // force a reflow so the animation restarts
    toast.classList.add("show");
  }

  private renderStatus(state: SplendorState, actor: SplendorSeat | undefined, mine: boolean): void {
    const banner = state.lastRound ? `<span class="spl-final badge warn">Final round!</span> ` : "";
    const muteButton = ` <button class="subtle spl-pause" data-action="toggle-mute"
        title="${isMuted() ? "Sounds off" : "Sounds on"}">${isMuted() ? "🔕" : "🔔"}</button>`;
    const pauseButton =
      state.turnSeconds > 0
        ? ` <button class="subtle spl-pause" data-action="toggle-pause">${state.paused ? "Resume" : "Pause"}</button>`
        : "";
    const saveButton =
      state.hostSessionId === this.ctx?.mySessionId
        ? ` <button class="subtle spl-pause" data-action="save-game">${
            Date.now() < this.saveFlashUntil ? "Saved ✓" : "Save"
          }</button>`
        : "";
    if (state.paused) {
      this.q("spl-status").innerHTML =
        `<span class="badge warn">Game paused by ${escapeHtml(state.pausedBy || "...")}</span>` +
        `${pauseButton}${saveButton}${muteButton}`;
      return;
    }
    let text: string;
    if (mine) {
      text =
        state.awaitingType === "DISCARD"
          ? `Too many tokens - discard <strong>${state.discardCount}</strong>`
          : state.awaitingType === "PICK_NOBLE"
            ? "Choose a noble to visit you"
            : "<strong>Your turn</strong>";
    } else {
      const name = escapeHtml(actor?.nickname ?? "...");
      const doing =
        state.awaitingType === "DISCARD"
          ? " (discarding)"
          : state.awaitingType === "PICK_NOBLE"
            ? " (choosing a noble)"
            : "";
      text = `Waiting for <strong>${name}</strong>${doing}`;
    }
    this.q("spl-status").innerHTML =
      `${banner}${text} <span id="spl-timer" class="spl-timer"></span>${pauseButton}${saveButton}${muteButton}`;
    this.updateTimer();
  }

  /** Refresh just the countdown span; cheap enough to run twice a second. */
  private updateTimer(): void {
    const el = this.root?.querySelector<HTMLElement>("#spl-timer");
    const state = this.room?.state;
    if (!el || !state) return;
    if (!state.turnSeconds) {
      el.textContent = "";
      return;
    }
    if (state.turnDeadline === 0) {
      el.textContent = "· timer paused";
      el.classList.remove("warn");
      return;
    }
    const left = Math.max(0, Math.ceil((state.turnDeadline - Date.now()) / 1000));
    el.textContent = `· ${formatSeconds(left)}`;
    el.classList.toggle("warn", left <= 15);
    // Audio nudge at 15s, once per deadline, only for the player on the clock.
    if (
      left <= 15 &&
      left > 0 &&
      state.currentTurn === this.ctx?.mySessionId &&
      this.clockChimedFor !== state.turnDeadline
    ) {
      this.clockChimedFor = state.turnDeadline;
      clockChime();
    }
  }

  private renderNobles(state: SplendorState): void {
    this.q("spl-nobles").innerHTML = [...state.nobles].map((n) => nobleHtml(n)).join("");
  }

  private renderMarket(state: SplendorState, me: SplendorSeat | undefined, myMove: boolean): void {
    const canReserve = myMove && me !== undefined && me.reservedCount < 3;
    const pseudo = me ? toEnginePlayer(me) : undefined;
    // What I could afford after taking the gems I have selected right now -
    // drives the blue "buyable next turn" highlight while picking tokens.
    const pseudoAfterTake =
      pseudo && this.selectedColors.size > 0 ? withSelectedGems(pseudo, this.selectedColors) : undefined;
    const rows: string[] = [];
    for (const tier of [3, 2, 1] as const) {
      const cells: string[] = [];
      const deckCount = state.deckCounts.at(tier - 1) ?? 0;
      cells.push(`
        <div class="spl-card spl-deck">
          <div class="spl-deck-count">Tier ${tier}<br>${deckCount} left</div>
          <div class="spl-card-actions">
            <button class="secondary" data-action="reserve-deck" data-tier="${tier}"
              ${canReserve && deckCount > 0 ? "" : "disabled"}>Reserve</button>
          </div>
        </div>`);
      for (let index = 0; index < 4; index++) {
        const card = state.market.at((tier - 1) * 4 + index);
        if (!card || card.id === 0) {
          cells.push(`<div class="spl-card spl-empty"></div>`);
          continue;
        }
        const engineCard = toEngineCard(card);
        // Green: in reach right now (shown whoever's turn it is).
        const affordableNow = pseudo !== undefined && SplendorEngine.affordable(engineCard, pseudo);
        // Blue: would come into reach with the selected gems.
        const affordableAfterTake =
          !affordableNow &&
          pseudoAfterTake !== undefined &&
          SplendorEngine.affordable(engineCard, pseudoAfterTake);
        const highlight = affordableNow ? "spl-can-buy" : affordableAfterTake ? "spl-could-buy" : "";
        cells.push(
          cardHtml(
            card,
            `<button data-action="buy-market" data-tier="${tier}" data-index="${index}"
               ${myMove && affordableNow ? "" : "disabled"}>Buy</button>
             <button class="secondary" data-action="reserve-market" data-tier="${tier}" data-index="${index}"
               ${canReserve ? "" : "disabled"}>Res.</button>`,
            highlight
          )
        );
      }
      rows.push(`<div class="spl-market-row">${cells.join("")}</div>`);
    }
    this.q("spl-market").innerHTML = rows.join("");
  }

  private renderBank(state: SplendorState, me: SplendorSeat | undefined, myMove: boolean): void {
    const piles = GEMS.map((g) => ({ gem: g, count: state.bank[g] }));
    const availColors = piles.filter((p) => p.count > 0).length;
    const need = Math.min(3, availColors);
    const canConfirm = myMove && need > 0 && this.selectedColors.size === need;

    const chips = piles
      .map(({ gem, count }) => {
        const selected = this.selectedColors.has(gem);
        const selectable = myMove && count > 0;
        return `
          <div class="spl-pile">
            <button class="spl-gem spl-${gem} ${selected ? "selected" : ""}"
              data-action="toggle-take" data-color="${gem}" ${selectable ? "" : "disabled"}>${count}</button>
            <button class="spl-take2" data-action="take-two" data-color="${gem}"
              ${myMove && count >= 4 ? "" : "disabled"}>Take 2</button>
          </div>`;
      })
      .join("");
    const gold = `
      <div class="spl-pile">
        <span class="spl-gem spl-gold">${state.bankGold}</span>
        <span class="spl-gold-label muted">gold</span>
      </div>`;
    let hint = "";
    if (myMove) {
      if (need === 0) {
        hint = "No tokens to take";
      } else {
        hint = `Pick ${need} different gem${need > 1 ? "s" : ""}, or Take 2 from a pile of 4+`;
        if (me && this.selectedColors.size > 0) {
          const after = totalTokensOf(me) + this.selectedColors.size;
          hint += ` — you'd hold ${after}/10 tokens${after > 10 ? " (you'll have to discard)" : ""}`;
        }
      }
    }
    this.q("spl-bank").innerHTML = `
      <div class="spl-bank-row">${chips}${gold}
        <button id="spl-take-confirm" data-action="confirm-take" ${canConfirm ? "" : "disabled"}>
          Take ${need > 0 ? need : 3}
        </button>
      </div>
      <p class="center muted spl-hint">${hint}</p>`;
  }

  private renderModal(state: SplendorState, me: SplendorSeat | undefined, mine: boolean): void {
    const modal = this.q("spl-modal");
    if (!mine || !me || state.awaitingType === "MOVE" || state.awaitingType === "") {
      modal.innerHTML = "";
      return;
    }
    if (state.awaitingType === "PICK_NOBLE") {
      const byId = new Map([...state.nobles].map((n) => [n.id, n]));
      const options = [...state.nobleChoices]
        .map((id) => {
          const noble = byId.get(id);
          return noble
            ? nobleHtml(noble, `<button data-action="pick-noble" data-noble-id="${id}">Choose</button>`)
            : "";
        })
        .join("");
      modal.innerHTML = `<div class="spl-prompt"><h3>A noble visits - choose one</h3>
        <div class="spl-nobles">${options}</div></div>`;
      return;
    }
    // DISCARD
    const held: Record<DiscardColor, number> = {
      white: me.gems.white, blue: me.gems.blue, green: me.gems.green,
      red: me.gems.red, black: me.gems.black, gold: me.gold,
    };
    for (const c of Object.keys(held) as DiscardColor[]) {
      this.discardPick[c] = Math.min(this.discardPick[c], held[c]);
    }
    const total = (Object.values(this.discardPick) as number[]).reduce((a, b) => a + b, 0);
    const steppers = (Object.keys(held) as DiscardColor[])
      .filter((c) => held[c] > 0)
      .map(
        (c) => `
        <div class="spl-stepper">
          <span class="spl-gem spl-${c}">${held[c] - this.discardPick[c]}</span>
          <button class="secondary" data-action="discard-step" data-color="${c}" data-step="-1"
            ${this.discardPick[c] > 0 ? "" : "disabled"}>-</button>
          <strong>${this.discardPick[c]}</strong>
          <button class="secondary" data-action="discard-step" data-color="${c}" data-step="1"
            ${this.discardPick[c] < held[c] && total < state.discardCount ? "" : "disabled"}>+</button>
        </div>`
      )
      .join("");
    modal.innerHTML = `<div class="spl-prompt">
      <h3>Over 10 tokens - discard ${state.discardCount}</h3>
      <div class="spl-steppers">${steppers}</div>
      <button data-action="confirm-discard" ${total === state.discardCount ? "" : "disabled"}>
        Discard ${total}/${state.discardCount}
      </button></div>`;
  }

  private renderMe(state: SplendorState, me: SplendorSeat | undefined, myMove: boolean): void {
    const panel = this.q("spl-me");
    if (!me) {
      panel.innerHTML = "";
      return;
    }
    const pseudo = toEnginePlayer(me);
    const pseudoAfterTake =
      this.selectedColors.size > 0 ? withSelectedGems(pseudo, this.selectedColors) : undefined;
    const reserved = [...me.reserved]
      .map((card) => {
        const engineCard = toEngineCard(card);
        const affordableNow = SplendorEngine.affordable(engineCard, pseudo);
        const highlight = affordableNow
          ? "spl-can-buy"
          : pseudoAfterTake && SplendorEngine.affordable(engineCard, pseudoAfterTake)
            ? "spl-could-buy"
            : "";
        return cardHtml(
          card,
          `<button data-action="buy-reserve" data-card-id="${card.id}"
            ${myMove && affordableNow ? "" : "disabled"}>Buy</button>`,
          highlight
        );
      })
      .join("");
    const tokens = totalTokensOf(me);
    panel.innerHTML = `
      <div class="spl-seat mine">
        <div class="spl-seat-head"><strong>You</strong>
          <span class="spl-token-count ${tokens >= 9 ? "warn" : ""}" title="Tokens held (10 max)">${tokens}/10 tokens</span>
          <span class="spl-points">${me.points} pts</span></div>
        ${this.holdingsHtml(me)}
        ${me.reserved.length > 0 ? `<div class="spl-reserved"><span class="muted">Reserved:</span>${reserved}</div>` : ""}
      </div>`;
  }

  private renderOpponents(state: SplendorState, seats: SplendorSeat[], mySeatIndex: number): void {
    const panels = seats
      .map((seat, i) => {
        if (i === mySeatIndex) return "";
        const player = seat.sessionId === "" ? undefined : state.players.get(seat.sessionId);
        const badge = seat.gone
          ? `<span class="badge warn">left - auto-play</span>`
          : player?.isBot
            ? `<span class="badge">AI</span>`
            : player?.connected === false
              ? `<span class="badge warn">reconnecting</span>`
              : "";
        const turn = state.awaitingSeat === i && state.awaitingType !== "" ? "active" : "";
        const backs = seat.reservedCount > 0
          ? `<div class="spl-reserved"><span class="muted">Reserved:</span>${
              `<span class="spl-card spl-back"></span>`.repeat(seat.reservedCount)
            }</div>`
          : "";
        return `
          <div class="spl-seat ${turn}">
            <div class="spl-seat-head"><strong>${escapeHtml(seat.nickname)}</strong>${badge}
              <span class="spl-token-count" title="Tokens held (10 max)">${totalTokensOf(seat)}/10 tokens</span>
              <span class="spl-points">${seat.points} pts</span></div>
            ${this.holdingsHtml(seat)}
            ${backs}
          </div>`;
      })
      .join("");
    this.q("spl-opponents").innerHTML = panels;
  }

  /**
   * One seat's purchasing power, grouped per color: the big number is what
   * the player can actually spend of that color (tokens + card bonuses),
   * with the token/card split underneath. Gold is tokens only.
   */
  private holdingsHtml(seat: SplendorSeat): string {
    const cells = GEMS.map((g) => {
      const tokens = seat.gems[g];
      const cards = seat.bonuses[g];
      const total = tokens + cards;
      return `
        <div class="spl-power ${total === 0 ? "empty" : ""}"
             title="${tokens} token${tokens === 1 ? "" : "s"} + ${cards} card${cards === 1 ? "" : "s"}">
          <span class="spl-power-total spl-${g}">${total}</span>
          <span class="spl-power-split"><i class="spl-i-tok"></i>${tokens}<i class="spl-i-card"></i>${cards}</span>
        </div>`;
    }).join("");
    const gold = `
      <div class="spl-power ${seat.gold === 0 ? "empty" : ""}" title="${seat.gold} gold (wild) tokens">
        <span class="spl-power-total spl-gold">${seat.gold}</span>
        <span class="spl-power-split"><i class="spl-i-tok"></i>${seat.gold}</span>
      </div>`;
    const nobles =
      seat.nobles.length > 0 ? `<span class="badge spl-noble-badge">nobles: ${seat.nobles.length}</span>` : "";
    return `<div class="spl-holdings">${cells}${gold}${nobles}</div>`;
  }
}
