/**
 * Space Chase view - the in-game UI (playing phase only; the framework owns
 * the lobby + game-over chrome). Renders from synced state on every patch and
 * animates from the synced event log.
 *
 * Authority: the server/engine is the source of truth. The view never mutates
 * game state - it sends intent messages (roll/draw + prompt answers) and draws
 * what the schema says. Animation is purely cosmetic: a `displayPos` override
 * drives rocket motion while the event queue plays, and every rocket is snapped
 * back to its authoritative position the moment the queue drains. On mount/
 * reconnect we fast-forward past existing events and snap, so a refresh never
 * replays a move.
 *
 * Mirrors the conventions in SplendorView (subscription, [data-action] event
 * delegation, rising-edge turn chime + toast + mute, hookSaveData/renderSaveSlots).
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  EndReason,
  getCard,
  LobbyMsg,
  Phase,
  portalAt,
  SC_CARD_BACK,
  SC_COLS,
  SC_FINISH,
  SC_LANDMARKS,
  SC_PLAYER_COLORS,
  SC_PORTALS,
  SC_ROWS,
  SC_START,
  SC_TURN_MAX_SECONDS,
  SC_TURN_STEP_SECONDS,
  ScAwait,
  ScChoice,
  ScEvent,
  ScPrompt,
  type SpaceChaseSeat,
  type SpaceChaseState,
  SpaceChaseMsg,
} from "@backbone/shared";
import type { GameView, GameViewContext, LobbySettingsContext } from "../../framework/GameView.js";
import { hookSaveData, renderSaveSlots } from "../../framework/saveSlots.js";
import { clockChime, flashToast, isMuted, setMuted, turnChime } from "../../framework/turnAlert.js";
import { escapeHtml } from "../../lobby/HomeScreen.js";

const SAVES_KEY = "spacechase-saves";
const scTurnLabel = (blob: any): number => blob?.engine?.turnCount ?? 1;
const CARD_ART = "/games/spacechase/cards/";
const DICE_FACES = ["⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

// Animation dwell times (ms).
const STEP_MS = 110;
const PORTAL_MS = 260;
const TELEPORT_MS = 420;
const DICE_MS = 1750; // spin (~560ms) + ~1.2s holding the landed face so the roll is readable
const REVEAL_OTHERS_MS = 2600; // a card you did NOT draw auto-closes after a couple seconds
const REVEAL_SAFETY_MS = 12000; // drawer fallback: the local queue can't stall if they walk away
const BURST_SKIP = 8; // > this many new events at once (reconnect catch-up) -> snap, don't animate

interface PortalPath {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  cx: number;
  cy: number;
}
interface DisplayPos {
  position: number;
  portalId: number;
  portalProgress: number;
  portalForward: boolean;
}
interface EventSnap {
  seq: number;
  kind: string;
  seat: number;
  a: number;
  b: number;
  text: string;
}

export class SpaceChaseView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, SpaceChaseState>;
  private ctx?: GameViewContext;
  private readonly onState = () => this.onPatch();
  private readonly onClick = (ev: Event) => this.handleClick(ev);
  private ticker?: ReturnType<typeof setInterval>;
  private resizeObs?: ResizeObserver;
  private rafHandle?: number;

  private wasMyTurn = false;
  private clockChimedFor = 0;
  private saveFlashUntil = 0;

  private portalPaths: (PortalPath | null)[] = [];
  private displayPos = new Map<number, DisplayPos>();
  private animQueue: EventSnap[] = [];
  private animating = false;
  private animTimers = new Set<ReturnType<typeof setTimeout>>();
  private lastSeq = 0;

  // Card-reveal dismissal: the queue's done() callback waits here until the
  // drawer taps OK (or the auto-close timer fires for watchers).
  private revealDone?: () => void;
  private revealTimer?: ReturnType<typeof setTimeout>;

  // prompt scratch (reset whenever the matching prompt isn't open for me)
  private multiPick: number[] = [];
  private satOrder: number[] = [];

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, SpaceChaseState>;
    this.ctx = ctx;

    root.innerHTML = `
      <div class="sc">
        <p id="sc-status" class="sc-status center"></p>
        <div class="sc-main">
          <div id="sc-board-wrap" class="sc-board-wrap">
            <div class="sc-stars"></div>
            <div id="sc-board" class="sc-board"></div>
            <div id="sc-start" class="sc-start-bar"></div>
            <svg id="sc-portals" class="sc-portals"></svg>
            <div id="sc-rockets" class="sc-rockets"></div>
            <div id="sc-dice" class="sc-dice"></div>
          </div>
          <aside class="sc-side">
            <div id="sc-piles" class="sc-piles"></div>
            <div id="sc-actions" class="sc-actions"></div>
            <div id="sc-seats" class="sc-seats"></div>
            <ul id="sc-log" class="sc-log"></ul>
          </aside>
        </div>
        <div id="sc-reveal" class="sc-reveal"></div>
        <div id="sc-modal" class="sc-modal-layer"></div>
      </div>`;

    this.buildBoard();
    this.buildRockets();
    root.addEventListener("click", this.onClick);
    this.room.onStateChange(this.onState);
    hookSaveData(this.room, SAVES_KEY, scTurnLabel, () => {
      this.saveFlashUntil = Date.now() + 2000;
      this.renderStatus();
      this.after(2100, () => this.renderStatus());
    });
    this.ticker = setInterval(() => this.updateTimer(), 500);

    // Geometry needs a laid-out DOM; defer one frame, then prime + snap.
    this.lastSeq = this.maxSeq();
    this.rafHandle = requestAnimationFrame(() => {
      this.layoutPortals();
      this.positionAllRockets();
      this.render();
    });
    this.resizeObs = new ResizeObserver(() => {
      this.layoutPortals();
      this.positionAllRockets();
    });
    this.resizeObs.observe(this.q("sc-board-wrap"));
    this.render();
  }

  unmount(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.resizeObs?.disconnect();
    for (const t of this.animTimers) clearTimeout(t);
    this.animTimers.clear();
    this.revealTimer = undefined;
    this.revealDone = undefined;
    this.animQueue.length = 0;
    this.room?.onStateChange.remove(this.onState);
    this.root?.removeEventListener("click", this.onClick);
    this.root = undefined;
    this.room = undefined;
    this.ctx = undefined;
  }

  // ── state-change handling ──────────────────────────────────────────────

  private onPatch(): void {
    const state = this.room?.state;
    if (!state || !this.ctx) return;

    // Rising edge of "it's my turn to act" -> chime + toast (once).
    const myTurnNow =
      state.phase === Phase.PLAYING &&
      state.awaitingType === ScAwait.ACTION &&
      state.currentTurn === this.ctx.mySessionId;
    if (myTurnNow && !this.wasMyTurn) {
      turnChime();
      if (this.root) flashToast(this.root, "Your turn!");
    }
    this.wasMyTurn = myTurnNow;

    // Decide animate-vs-snap BEFORE rendering panels, so we never snap rockets
    // to their final spot just before the queue would have animated them.
    const fresh: EventSnap[] = [];
    for (const e of [...state.events]) {
      if (e.seq > this.lastSeq) fresh.push({ seq: e.seq, kind: e.kind, seat: e.seat, a: e.a, b: e.b, text: e.text });
    }
    if (fresh.length > 0) {
      this.lastSeq = fresh[fresh.length - 1]!.seq;
      // Snap (don't animate) only for a genuine burst - e.g. a reconnect
      // catch-up. A fresh mount/refresh never replays history because lastSeq
      // is primed to the newest event in mount(); so the FIRST live action
      // after mount still animates (the old `cold` flag wrongly skipped it).
      if (fresh.length > BURST_SKIP) {
        this.displayPos.clear();
        this.animQueue.length = 0;
        this.positionAllRockets();
      } else {
        this.animQueue.push(...fresh);
        this.pump();
      }
    }
    this.render();
  }

  private render(): void {
    if (!this.room?.state || !this.ctx) return;
    this.renderStatus();
    this.renderPiles();
    this.renderActions();
    this.renderSeats();
    this.renderLog();
    this.renderModal();
  }

  // ── board geometry ─────────────────────────────────────────────────────

  private buildBoard(): void {
    const board = this.q("sc-board");
    board.innerHTML = "";
    for (let i = 0; i < SC_COLS * (SC_ROWS - 1) + (SC_FINISH - SC_COLS * (SC_ROWS - 1)); i++) {
      // 68 cells: spaces 1..68.
      if (i >= SC_FINISH) break;
      const spaceNum = i + 1;
      const rowFromBottom = Math.floor(i / SC_COLS);
      const colInRow = i % SC_COLS;
      const col = rowFromBottom % 2 === 0 ? colInRow : SC_COLS - 1 - colInRow;
      const row = SC_ROWS - 1 - rowFromBottom;
      const cell = document.createElement("div");
      cell.className = "sc-cell";
      cell.id = `sc-cell-${spaceNum}`;
      cell.style.gridColumn = String(col + 1);
      cell.style.gridRow = String(row + 1);
      if (spaceNum === SC_FINISH) {
        cell.classList.add("sc-finish");
        cell.innerHTML = `<span class="sc-num">\u{1F31F}</span><span class="sc-label">FINISH</span>`;
      } else {
        let html = `<span class="sc-num">${spaceNum}</span>`;
        const landmark = SC_LANDMARKS[spaceNum];
        if (landmark) {
          cell.classList.add("sc-landmark");
          html += `<span class="sc-label">${escapeHtml(landmark)}</span>`;
        }
        cell.innerHTML = html;
      }
      const portal = portalAt(spaceNum);
      if (portal) {
        cell.classList.add("sc-portal");
        cell.style.setProperty("--portal-color", portal.color);
      }
      board.appendChild(cell);
    }
  }

  private buildRockets(): void {
    const layer = this.q("sc-rockets");
    layer.innerHTML = "";
    const seats = [...(this.room?.state.seats ?? [])];
    seats.forEach((seat, i) => {
      const token = document.createElement("div");
      token.className = "sc-rocket";
      token.id = `sc-rocket-${i}`;
      token.style.setProperty("--color", SC_PLAYER_COLORS[i % SC_PLAYER_COLORS.length]!);
      token.innerHTML = `<span class="sc-rocket-icon">\u{1F680}</span><span class="sc-rocket-initial">${escapeHtml(
        (seat.nickname || "?").charAt(0).toUpperCase()
      )}</span>`;
      layer.appendChild(token);
    });
  }

  private layoutPortals(): void {
    const svg = this.q("sc-portals") as unknown as SVGSVGElement;
    const wrap = this.q("sc-board-wrap");
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    svg.setAttribute("width", String(w));
    svg.setAttribute("height", String(h));
    svg.innerHTML = "";
    this.portalPaths = [];
    const wrapRect = wrap.getBoundingClientRect();
    SC_PORTALS.forEach((portal) => {
      const ea = document.getElementById(`sc-cell-${portal.a}`);
      const eb = document.getElementById(`sc-cell-${portal.b}`);
      if (!ea || !eb) {
        this.portalPaths.push(null);
        return;
      }
      const ra = ea.getBoundingClientRect();
      const rb = eb.getBoundingClientRect();
      const ax = ra.left - wrapRect.left + ra.width / 2;
      const ay = ra.top - wrapRect.top + ra.height / 2;
      const bx = rb.left - wrapRect.left + rb.width / 2;
      const by = rb.top - wrapRect.top + rb.height / 2;
      const mx = (ax + bx) / 2;
      const my = (ay + by) / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      const off = 55;
      const cx = mx - (dy / len) * off;
      const cy = my + (dx / len) * off;
      this.portalPaths.push({ ax, ay, bx, by, cx, cy });

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`);
      path.setAttribute("stroke", portal.color);
      path.setAttribute("class", "sc-portal-path");
      svg.appendChild(path);
      for (let k = 1; k <= portal.internal; k++) {
        const t = k / (portal.internal + 1);
        const p = bezier(this.portalPaths[this.portalPaths.length - 1]!, t);
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", String(p.x));
        dot.setAttribute("cy", String(p.y));
        dot.setAttribute("r", "3.5");
        dot.setAttribute("fill", portal.color);
        dot.setAttribute("opacity", "0.7");
        svg.appendChild(dot);
      }
    });
  }

  private positionAllRockets(): void {
    const state = this.room?.state;
    if (!state) return;
    const wrap = this.q("sc-board-wrap");
    const wrapRect = wrap.getBoundingClientRect();
    if (wrapRect.width === 0) return;
    const seats = [...state.seats];

    // Effective positions (display override while animating, else state truth).
    const eff: (DisplayPos | null)[] = seats.map((s, i) => {
      if (s.gone) return null;
      return this.displayPos.get(i) ?? {
        position: s.position,
        portalId: s.portalId,
        portalProgress: s.portalProgress,
        portalForward: s.portalForward,
      };
    });

    // Cluster: seats on the same visual spot fan out.
    const keyOf = (e: DisplayPos) => (e.portalId > 0 ? `p${e.portalId}.${e.portalProgress}` : `s${e.position}`);
    const groups = new Map<string, number[]>();
    eff.forEach((e, i) => {
      if (!e) return;
      const k = keyOf(e);
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(i);
    });
    const startSeats = eff.map((e, i) => (e && e.portalId === 0 && e.position === SC_START ? i : -1)).filter((i) => i >= 0);

    eff.forEach((e, i) => {
      const token = document.getElementById(`sc-rocket-${i}`);
      if (!token) return;
      if (!e) {
        token.style.display = "none";
        return;
      }
      token.style.display = "";
      let pt: { x: number; y: number } | null = null;
      if (e.portalId > 0) {
        const idx = SC_PORTALS.findIndex((p) => p.id === e.portalId);
        const path = this.portalPaths[idx];
        const def = SC_PORTALS[idx];
        if (path && def) {
          const tRaw = (e.portalProgress + 0.5) / (def.internal + 1);
          const t = e.portalForward ? tRaw : 1 - tRaw;
          pt = bezier(path, t);
        }
      } else if (e.position >= SC_FINISH) {
        pt = this.cellCenter(SC_FINISH, wrapRect);
      } else if (e.position >= 1) {
        pt = this.cellCenter(e.position, wrapRect);
      } else {
        // START bar slot
        const bar = this.q("sc-start").getBoundingClientRect();
        const n = Math.max(1, startSeats.length);
        const slot = startSeats.indexOf(i);
        pt = {
          x: bar.left - wrapRect.left + (bar.width * (slot + 1)) / (n + 1),
          y: bar.top - wrapRect.top + bar.height / 2,
        };
      }
      if (!pt) return;
      // fan out co-located rockets
      const group = groups.get(keyOf(e))!;
      if (group.length > 1) {
        const order = group.indexOf(i);
        const ang = (order / group.length) * Math.PI * 2;
        pt = { x: pt.x + Math.cos(ang) * 9, y: pt.y + Math.sin(ang) * 9 };
      }
      token.style.left = `${pt.x}px`;
      token.style.top = `${pt.y}px`;
    });
  }

  private cellCenter(spaceNum: number, wrapRect: DOMRect): { x: number; y: number } | null {
    const el = document.getElementById(`sc-cell-${spaceNum}`);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left - wrapRect.left + r.width / 2, y: r.top - wrapRect.top + r.height / 2 };
  }

  // ── animation queue ────────────────────────────────────────────────────

  private after(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.animTimers.delete(t);
      fn();
    }, ms);
    this.animTimers.add(t);
  }

  private pump(): void {
    if (this.animating) return;
    const next = this.animQueue.shift();
    if (!next) {
      this.displayPos.clear();
      this.positionAllRockets();
      return;
    }
    this.animating = true;
    this.animateEvent(next, () => {
      this.animating = false;
      this.pump();
    });
  }

  private setDisplay(seat: number, d: DisplayPos): void {
    if (seat < 0) return;
    this.displayPos.set(seat, d);
  }

  private animateEvent(e: EventSnap, done: () => void): void {
    switch (e.kind) {
      case ScEvent.ROLL:
      case ScEvent.TIEBREAK_ROLL:
        this.showDice(e.a);
        this.after(DICE_MS, () => {
          this.hideDice();
          done();
        });
        return;
      case ScEvent.TIEBREAK_START:
        this.after(400, done);
        return;
      case ScEvent.MOVE:
        this.setDisplay(e.seat, { position: e.b, portalId: 0, portalProgress: 0, portalForward: true });
        this.positionAllRockets();
        this.after(STEP_MS * Math.min(Math.abs(e.b - e.a), 8) + 120, done);
        return;
      case ScEvent.ENTER_PORTAL: {
        const def = SC_PORTALS.find((p) => p.id === e.a);
        this.setDisplay(e.seat, { position: e.b, portalId: e.a, portalProgress: 0, portalForward: def ? e.b === def.a : true });
        this.positionAllRockets();
        this.after(PORTAL_MS, done);
        return;
      }
      case ScEvent.PORTAL_MOVE: {
        const d = this.displayPos.get(e.seat);
        if (d) {
          d.portalProgress = e.b;
          this.displayPos.set(e.seat, d);
          this.positionAllRockets();
        }
        this.after(PORTAL_MS, done);
        return;
      }
      case ScEvent.EXIT_PORTAL:
        this.setDisplay(e.seat, { position: e.b, portalId: 0, portalProgress: 0, portalForward: true });
        this.positionAllRockets();
        this.after(PORTAL_MS, done);
        return;
      case ScEvent.TELEPORT:
        this.flashTeleport(e.seat, e.b);
        this.after(TELEPORT_MS, done);
        return;
      case ScEvent.DRAW:
        // The drawer taps OK to continue; everyone else's reveal auto-closes.
        this.showReveal(e.b, e.seat === this.mySeatIndex(), done);
        return;
      case ScEvent.COLLISION:
        this.pulseSeat(-1);
        this.after(450, done);
        return;
      default:
        // shieldBlock / shieldOn / suitOn / loseTurns / skipTurn / extraTurns /
        // swap / satellite / reshuffle / noop / win: brief beat, no movement.
        this.after(180, done);
        return;
    }
  }

  private flashTeleport(seat: number, to: number): void {
    const token = document.getElementById(`sc-rocket-${seat}`);
    if (token) {
      token.classList.add("no-transition", "teleporting");
      this.setDisplay(seat, { position: to, portalId: 0, portalProgress: 0, portalForward: true });
      this.positionAllRockets();
      requestAnimationFrame(() => token.classList.remove("no-transition"));
      this.after(TELEPORT_MS, () => token.classList.remove("teleporting"));
    } else {
      this.setDisplay(seat, { position: to, portalId: 0, portalProgress: 0, portalForward: true });
      this.positionAllRockets();
    }
  }

  private pulseSeat(seat: number): void {
    const tokens = seat < 0 ? Array.from(this.root?.querySelectorAll<HTMLElement>(".sc-rocket") ?? []) : [document.getElementById(`sc-rocket-${seat}`)];
    for (const t of tokens) {
      if (!t) continue;
      t.classList.remove("bump");
      void t.offsetWidth;
      t.classList.add("bump");
    }
  }

  private showDice(die: number): void {
    const el = this.q("sc-dice");
    el.textContent = DICE_FACES[Math.max(0, Math.min(5, die - 1))]!;
    el.classList.add("show");
    el.classList.remove("landed");
    let flips = 0;
    const spin = () => {
      if (flips++ > 6) {
        el.textContent = DICE_FACES[Math.max(0, Math.min(5, die - 1))]!;
        el.classList.add("landed");
        return;
      }
      el.textContent = DICE_FACES[Math.floor(Math.random() * 6)]!;
      this.after(80, spin);
    };
    spin();
  }
  private hideDice(): void {
    this.q("sc-dice").classList.remove("show");
  }

  /**
   * Show the drawn card. `dismissable` = this client drew it: a backdrop + "OK"
   * button gate the animation queue until the player taps it (with a safety
   * auto-close so the queue can never permanently stall). Watchers get a
   * click-through reveal that auto-closes after a couple seconds. Either way
   * `done()` runs exactly once, when the reveal closes.
   */
  private showReveal(cardId: number, dismissable: boolean, done: () => void): void {
    const def = getCard(cardId);
    const el = this.q("sc-reveal");
    if (!def) {
      el.classList.remove("show", "blocking");
      done();
      return;
    }
    el.classList.toggle("blocking", dismissable);
    el.innerHTML = `<div class="sc-reveal-card">
        <img src="${CARD_ART}${def.image}" alt="${escapeHtml(def.name)}" />
        <div class="sc-reveal-name">${escapeHtml(def.name)}</div>
        <div class="sc-reveal-desc">${escapeHtml(def.desc)}</div>
        ${dismissable ? `<button class="sc-reveal-ok" data-action="dismiss-reveal">OK</button>` : ""}
      </div>`;
    el.classList.add("show");
    this.revealDone = done;
    this.revealTimer = setTimeout(() => this.dismissReveal(), dismissable ? REVEAL_SAFETY_MS : REVEAL_OTHERS_MS);
    this.animTimers.add(this.revealTimer);
  }

  private dismissReveal(): void {
    if (!this.revealDone) return; // idempotent (click + auto-close race)
    if (this.revealTimer) {
      clearTimeout(this.revealTimer);
      this.animTimers.delete(this.revealTimer);
      this.revealTimer = undefined;
    }
    this.q("sc-reveal").classList.remove("show", "blocking");
    const done = this.revealDone;
    this.revealDone = undefined;
    done();
  }

  // ── region renderers ───────────────────────────────────────────────────

  private renderStatus(): void {
    const state = this.room!.state;
    const me = this.ctx!.mySessionId;
    const isHost = state.hostSessionId === me;
    const saved = Date.now() < this.saveFlashUntil;
    const mute = `<button class="subtle sc-icon-btn" data-action="toggle-mute" title="${isMuted() ? "Sounds off" : "Sounds on"}">${isMuted() ? "\u{1F515}" : "\u{1F514}"}</button>`;
    const save = isHost
      ? `<button class="subtle sc-icon-btn" data-action="save-game" title="Save this game">${saved ? "Saved ✓" : "\u{1F4BE} Save"}</button>`
      : "";
    const timer = state.turnSeconds > 0 ? `<span id="sc-timer" class="sc-timer"></span>` : "";
    this.q("sc-status").innerHTML = `<span class="sc-banner">${this.bannerText()}</span>${timer} ${save} ${mute}`;
    this.updateTimer();
  }

  private bannerText(): string {
    const state = this.room!.state;
    const me = this.ctx!.mySessionId;
    const cur = [...state.seats].find((s) => s.sessionId === state.currentTurn);
    const curName = escapeHtml(cur?.nickname ?? "...");
    const mine = state.currentTurn === me;
    if (state.awaitingType === ScAwait.ACTION) {
      return mine ? "Your turn — Roll the dice or draw a card" : `${curName} is taking their turn…`;
    }
    if (state.awaitingType === "") return "…";
    if (mine) {
      switch (state.awaitingType) {
        case ScAwait.TARGET:
        case ScAwait.MULTI_TARGET:
          return "Choose your target";
        case ScAwait.CHOICE:
          return "Make your choice";
        case ScAwait.SPACE:
          return "Pick a destination space";
        case ScAwait.SATELLITE:
          return "Rearrange the top of the deck";
      }
    }
    return `${curName} is deciding…`;
  }

  private updateTimer(): void {
    const state = this.room?.state;
    if (!state) return;
    const el = this.root?.querySelector<HTMLElement>("#sc-timer");
    if (!el) return;
    if (state.turnSeconds === 0) {
      el.textContent = "";
      return;
    }
    if (state.turnDeadline === 0) {
      el.textContent = "· timer paused";
      el.classList.remove("warn");
      return;
    }
    const ms = Math.max(0, state.turnDeadline - Date.now());
    const secs = Math.ceil(ms / 1000);
    el.textContent = `· ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    el.classList.toggle("warn", secs <= 15);
    if (secs <= 15 && state.currentTurn === this.ctx!.mySessionId && this.clockChimedFor !== state.turnDeadline) {
      this.clockChimedFor = state.turnDeadline;
      clockChime();
    }
  }

  private renderPiles(): void {
    const state = this.room!.state;
    const last = state.lastCardId > 0 ? getCard(state.lastCardId) : undefined;
    this.q("sc-piles").innerHTML = `
      <div class="sc-deck" title="Draw pile">
        <img class="sc-card-art" src="${CARD_ART}${SC_CARD_BACK}" alt="deck" />
        <span class="sc-deck-count">${state.deckCount}</span>
      </div>
      <div class="sc-discard" title="Last card drawn">
        ${last ? `<img class="sc-card-art" src="${CARD_ART}${last.image}" alt="${escapeHtml(last.name)}" />` : `<div class="sc-card-empty">—</div>`}
        <span class="sc-deck-count">${state.discardCount}</span>
      </div>`;
  }

  private renderActions(): void {
    const state = this.room!.state;
    const mine = state.awaitingType === ScAwait.ACTION && state.currentTurn === this.ctx!.mySessionId;
    const dis = mine ? "" : "disabled";
    this.q("sc-actions").innerHTML = `
      <button class="sc-act" data-action="roll" ${dis}>\u{1F3B2} Roll the Dice</button>
      <button class="sc-act" data-action="draw" ${dis}>\u{1F0CF} Draw a Card</button>`;
  }

  private renderSeats(): void {
    const state = this.room!.state;
    const me = this.ctx!.mySessionId;
    const rows = [...state.seats]
      .map((seat, i) => {
        const color = SC_PLAYER_COLORS[i % SC_PLAYER_COLORS.length]!;
        const active = !seat.gone && state.currentSeat === i && state.awaitingType !== "";
        const tags: string[] = [];
        if (seat.shieldExpiresRound > state.roundNumber) tags.push(`\u{1F6E1}\u{FE0F}${seat.shieldExpiresRound - state.roundNumber}`);
        if (seat.spaceSuit) tags.push("\u{1F9D1}‍\u{1F680}");
        if (seat.lostTurns > 0) tags.push(`⏭\u{FE0F}${seat.lostTurns}`);
        if (seat.extraTurns > 0) tags.push(`➕${seat.extraTurns}`);
        const name = `${escapeHtml(seat.nickname)}${seat.sessionId === me ? " (you)" : ""}`;
        return `<div class="sc-seat-row ${active ? "active" : ""} ${seat.gone ? "gone" : ""}">
            <span class="sc-seat-dot" style="--color:${color}"></span>
            <span class="sc-seat-name">${name}</span>
            <span class="sc-seat-pos">${this.posLabel(seat)}</span>
            <span class="sc-seat-icons">${tags.join(" ")}</span>
          </div>`;
      })
      .join("");
    this.q("sc-seats").innerHTML = rows;
  }

  private posLabel(seat: SpaceChaseSeat): string {
    if (seat.gone) return "left";
    if (seat.portalId > 0) return "in a portal";
    if (seat.position >= SC_FINISH) return "FINISH";
    if (seat.position === SC_START) return "START";
    return `Space ${seat.position}`;
  }

  private renderLog(): void {
    const state = this.room!.state;
    const items = [...state.events]
      .slice(-14)
      .reverse()
      .map((e) => `<li class="sc-log-entry">${escapeHtml(e.text)}</li>`)
      .join("");
    this.q("sc-log").innerHTML = items;
  }

  // ── prompt modal ───────────────────────────────────────────────────────

  private mySeatIndex(): number {
    return [...(this.room?.state.seats ?? [])].findIndex((s) => s.sessionId === this.ctx?.mySessionId);
  }

  private renderModal(): void {
    const state = this.room!.state;
    const modal = this.q("sc-modal");
    const type = state.awaitingType;
    if (type === "" || type === ScAwait.ACTION) {
      modal.innerHTML = "";
      this.multiPick = [];
      this.satOrder = [];
      this.q("sc-board").classList.remove("sc-picking");
      return;
    }
    const owner = [...state.seats][state.promptSeat];
    const isMine = !!owner && owner.sessionId === this.ctx!.mySessionId;
    this.q("sc-board").classList.toggle("sc-picking", isMine && type === ScAwait.SPACE);

    if (!isMine) {
      this.multiPick = [];
      this.satOrder = [];
      modal.innerHTML = `<div class="sc-passive">${escapeHtml(owner?.nickname ?? "Someone")} is deciding…</div>`;
      return;
    }

    switch (type) {
      case ScAwait.TARGET:
        modal.innerHTML = this.targetButtons();
        break;
      case ScAwait.MULTI_TARGET:
        modal.innerHTML = this.multiTargetButtons();
        break;
      case ScAwait.CHOICE:
        modal.innerHTML = this.choiceButtons();
        break;
      case ScAwait.SPACE:
        modal.innerHTML = `<div class="sc-prompt"><div class="sc-prompt-title">Send them to which space? (1–67)</div>
          <div class="sc-space-row"><input id="sc-space-input" class="sc-space-input" type="number" min="1" max="67" />
          <button class="sc-choice-btn" data-action="space-ok">Send</button></div>
          <div class="sc-hint">…or click a space on the board.</div></div>`;
        break;
      case ScAwait.SATELLITE:
        modal.innerHTML = this.satelliteUI();
        break;
    }
  }

  private liveTargetSeats(): { i: number; seat: SpaceChaseSeat }[] {
    const state = this.room!.state;
    const ctxSeat = this.mySeatIndex();
    const cardId = state.promptCardId;
    const ctx = state.promptContext;
    const card = getCard(cardId);
    const selfAllowed = !(ctx === ScPrompt.BLACKHOLE_TARGET || (ctx === ScPrompt.ATTACK_TARGET && card?.action === "wormHole"));
    return [...state.seats]
      .map((seat, i) => ({ i, seat }))
      .filter(({ seat, i }) => !seat.gone && (i !== ctxSeat || selfAllowed));
  }

  private targetButtons(): string {
    const me = this.mySeatIndex();
    const btns = this.liveTargetSeats()
      .map(({ i, seat }) => `<button class="sc-target-btn" data-action="target" data-seat="${i}">
          <span class="sc-seat-dot" style="--color:${SC_PLAYER_COLORS[i % SC_PLAYER_COLORS.length]}"></span>
          ${escapeHtml(seat.nickname)}${i === me ? " (you)" : ""} <span class="muted">${this.posLabel(seat)}</span>
        </button>`)
      .join("");
    return `<div class="sc-prompt"><div class="sc-prompt-title">Choose a target</div><div class="sc-target-grid">${btns}</div></div>`;
  }

  private multiTargetButtons(): string {
    const state = this.room!.state;
    const me = this.mySeatIndex();
    const need = state.promptCount;
    const btns = this.liveTargetSeats()
      .map(({ i, seat }) => {
        const picked = this.multiPick.includes(i);
        return `<button class="sc-target-btn ${picked ? "selected" : ""}" data-action="multi" data-seat="${i}">
            <span class="sc-seat-dot" style="--color:${SC_PLAYER_COLORS[i % SC_PLAYER_COLORS.length]}"></span>
            ${escapeHtml(seat.nickname)}${i === me ? " (you)" : ""}
          </button>`;
      })
      .join("");
    return `<div class="sc-prompt"><div class="sc-prompt-title">Choose ${need} player${need === 1 ? "" : "s"} (${this.multiPick.length}/${need})</div><div class="sc-target-grid">${btns}</div></div>`;
  }

  private choiceButtons(): string {
    const ctx = this.room!.state.promptContext;
    let opts: [string, string][] = [];
    if (ctx === ScPrompt.KRAKEN_CHOICE) {
      opts = [
        [ScChoice.KRAKEN_THREE, "3 players lose 1 turn"],
        [ScChoice.KRAKEN_ONE, "1 player loses 3 turns"],
      ];
    } else if (ctx === ScPrompt.STAR_CHOICE) {
      opts = [
        [ScChoice.STAR_SELF, "Fly to The Star (33) yourself"],
        [ScChoice.STAR_SEND, "Send another player to The Star"],
      ];
    } else if (ctx === ScPrompt.SIXSEVEN_SPACE) {
      opts = [
        [ScChoice.SIX, "Send them to Space 6"],
        [ScChoice.SEVEN, "Send them to Space 7"],
      ];
    }
    const btns = opts.map(([v, label]) => `<button class="sc-choice-btn" data-action="choice" data-choice="${v}">${escapeHtml(label)}</button>`).join("");
    return `<div class="sc-prompt"><div class="sc-prompt-title">Make your choice</div><div class="sc-choice-row">${btns}</div></div>`;
  }

  private satelliteUI(): string {
    const seat = [...this.room!.state.seats][this.mySeatIndex()];
    const peek = [...(seat?.peek ?? [])];
    const cards = peek
      .map((id, k) => {
        const def = getCard(id);
        const order = this.satOrder.indexOf(k);
        return `<button class="sc-sat-card ${order >= 0 ? "picked" : ""}" data-action="sat-pick" data-idx="${k}">
            <img class="sc-card-art" src="${CARD_ART}${def?.image ?? SC_CARD_BACK}" alt="${escapeHtml(def?.name ?? "card")}" />
            ${order >= 0 ? `<span class="sc-sat-badge">${order + 1}</span>` : ""}
          </button>`;
      })
      .join("");
    const ready = this.satOrder.length === peek.length && peek.length > 0;
    return `<div class="sc-prompt"><div class="sc-prompt-title">Tap cards in the order they should be drawn (top first)</div>
      <div class="sc-sat-strip">${cards}</div>
      <div class="sc-choice-row">
        <button class="sc-choice-btn" data-action="sat-reset">Reset</button>
        <button class="sc-choice-btn" data-action="sat-confirm" ${ready ? "" : "disabled"}>Confirm order</button>
      </div></div>`;
  }

  // ── click handling ─────────────────────────────────────────────────────

  private handleClick(ev: Event): void {
    const target = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-action]");
    if (!target || !this.room || target.hasAttribute("disabled")) return;
    const d = target.dataset;
    switch (d.action) {
      case "dismiss-reveal":
        this.dismissReveal();
        return;
      case "toggle-mute":
        setMuted(!isMuted());
        this.renderStatus();
        return;
      case "save-game":
        this.room.send(LobbyMsg.SAVE, {});
        return;
      case "roll":
        this.room.send(SpaceChaseMsg.ROLL, {});
        return;
      case "draw":
        this.room.send(SpaceChaseMsg.DRAW, {});
        return;
      case "target":
        this.room.send(SpaceChaseMsg.TARGET, { seat: Number(d.seat) });
        return;
      case "multi": {
        const seat = Number(d.seat);
        const at = this.multiPick.indexOf(seat);
        if (at >= 0) this.multiPick.splice(at, 1);
        else this.multiPick.push(seat);
        if (this.multiPick.length === this.room.state.promptCount) {
          this.room.send(SpaceChaseMsg.TARGETS, { seats: [...this.multiPick] });
          this.multiPick = [];
        } else {
          this.renderModal();
        }
        return;
      }
      case "choice":
        this.room.send(SpaceChaseMsg.CHOICE, { choice: d.choice });
        return;
      case "pick-space":
        this.room.send(SpaceChaseMsg.SPACE, { space: Number(d.space) });
        return;
      case "space-ok": {
        const input = this.root?.querySelector<HTMLInputElement>("#sc-space-input");
        const space = Number(input?.value);
        if (Number.isInteger(space) && space >= 1 && space <= 67) this.room.send(SpaceChaseMsg.SPACE, { space });
        return;
      }
      case "sat-pick": {
        const idx = Number(d.idx);
        const at = this.satOrder.indexOf(idx);
        if (at >= 0) this.satOrder.splice(at, 1);
        else this.satOrder.push(idx);
        this.renderModal();
        return;
      }
      case "sat-reset":
        this.satOrder = [];
        this.renderModal();
        return;
      case "sat-confirm":
        this.room.send(SpaceChaseMsg.SATELLITE, { order: [...this.satOrder] });
        this.satOrder = [];
        return;
    }
    // Click-a-cell for the SPACE prompt.
    const cell = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".sc-cell");
    if (cell && this.q("sc-board").classList.contains("sc-picking")) {
      const space = Number(cell.id.replace("sc-cell-", ""));
      if (space >= 1 && space <= 67) this.room.send(SpaceChaseMsg.SPACE, { space });
    }
  }

  private maxSeq(): number {
    let m = 0;
    for (const e of [...(this.room?.state.events ?? [])]) m = Math.max(m, e.seq);
    return m;
  }

  private q(id: string): HTMLElement {
    return this.root!.querySelector<HTMLElement>(`#${id}`)!;
  }
}

function bezier(p: PortalPath, t: number): { x: number; y: number } {
  const u = 1 - t;
  return {
    x: u * u * p.ax + 2 * u * t * p.cx + t * t * p.bx,
    y: u * u * p.ay + 2 * u * t * p.cy + t * t * p.by,
  };
}

// ── lobby settings + game summary (called by the framework chrome) ──────────

function formatSeconds(s: number): string {
  return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function renderSpaceChaseLobbySettings(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: LobbySettingsContext
): void {
  const state = room.state as unknown as SpaceChaseState;
  const current = state.turnSeconds ?? 0;
  const options = [`<option value="0" ${current === 0 ? "selected" : ""}>Off</option>`];
  for (let s = SC_TURN_STEP_SECONDS; s <= SC_TURN_MAX_SECONDS; s += SC_TURN_STEP_SECONDS) {
    options.push(`<option value="${s}" ${current === s ? "selected" : ""}>${formatSeconds(s)}</option>`);
  }
  container.innerHTML = `
    <label class="sc-lobby-setting">Turn timer
      <select id="sc-turn-seconds" ${ctx.isHost ? "" : "disabled"}>${options.join("")}</select>
      ${ctx.isHost ? "" : '<span class="muted">(host chooses)</span>'}
    </label>
    <div class="sc-saves-block"></div>`;
  renderSaveSlots(container.querySelector<HTMLElement>(".sc-saves-block")!, room, {
    key: SAVES_KEY,
    isHost: ctx.isHost,
    loadedSave: state.loadedSave,
  });
  container.querySelector<HTMLSelectElement>("#sc-turn-seconds")?.addEventListener("change", (ev) => {
    room.send(SpaceChaseMsg.CONFIG, { turnSeconds: Number((ev.target as HTMLSelectElement).value) });
  });
}

export function renderSpaceChaseGameSummary(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: GameViewContext
): void {
  const state = room.state as unknown as SpaceChaseState;
  const seats = [...(state.seats ?? [])];
  if (seats.length === 0) return;

  let winners: Set<string> | undefined;
  if (state.endReason.startsWith(EndReason.WIN_PREFIX)) {
    const frameworkSeat = Number(state.endReason.slice(EndReason.WIN_PREFIX.length));
    const winner = [...state.players.values()].find((p) => p.seat === frameworkSeat);
    winners = new Set(winner ? [winner.sessionId] : []);
  }

  const label = (seat: SpaceChaseSeat): string => {
    if (seat.gone) return "left";
    if (seat.position >= SC_FINISH) return "FINISH";
    if (seat.portalId > 0) return "in a portal";
    if (seat.position === SC_START) return "START";
    return `Space ${seat.position}`;
  };

  const rows = seats
    .map((seat, i) => ({
      seat,
      color: SC_PLAYER_COLORS[i % SC_PLAYER_COLORS.length]!,
      rankKey: seat.gone ? -1 : seat.position,
      mine: seat.sessionId !== "" && seat.sessionId === ctx.mySessionId,
      won: winners ? seat.sessionId !== "" && winners.has(seat.sessionId) : false,
    }))
    .sort((a, b) => Number(b.won) - Number(a.won) || b.rankKey - a.rankKey);

  const body = rows
    .map(
      (r) => `<tr class="${r.won ? "winner" : ""} ${r.seat.gone ? "gone" : ""}">
        <td class="sc-sum-name"><span class="sc-seat-dot" style="--color:${r.color}"></span>${r.won ? "\u{1F451} " : ""}${escapeHtml(r.seat.nickname)}${r.mine ? " (you)" : ""}${r.seat.gone ? " · left" : ""}</td>
        <td>${label(r.seat)}</td>
      </tr>`
    )
    .join("");

  container.innerHTML = `<table class="sc-summary">
    <thead><tr><th>Player</th><th>Finished at</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}
