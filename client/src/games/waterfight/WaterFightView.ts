/**
 * Water Fight view — renders the synced schema and sends raw engine Move /
 * Resolution JSON. The server validates everything; the option-gating mirrored
 * here only exists to show the right buttons. The engine is never on the client,
 * so the view reads only the public projection + this seat's own @view() hand.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  COIN_VALUES,
  LobbyMsg,
  Phase,
  WaterFightMsg,
  WF_SETTINGS,
  WF_STACK_IDS,
  type WaterFightSeat,
  type WaterFightState,
} from "@backbone/shared";
import type { GameView, GameViewContext, LobbySettingsContext } from "../../framework/GameView.js";
import { escapeHtml } from "../../lobby/HomeScreen.js";
import { flashToast, isMuted, setMuted, turnChime } from "../../framework/turnAlert.js";
import { hookSaveData, renderSaveSlots } from "../../framework/saveSlots.js";

const WF_SAVES_KEY = "waterfight-saves";
/** How long the HIT/MISS splash reveal stays on screen. */
const SPLASH_REVEAL_MS = 2600;
const wfTurnLabel = (blob: any): number => (blob?.engine?.turnCount ?? 0) + 1;

// MIRROR of the engine's TARGETED_SUPPORTS / implemented supports (engine.ts) —
// the engine is the authority and is unreachable from the client, so these are a
// hand-copy purely to pick which buttons to show. Keep in sync; the server still
// validates, so drift only mis-renders, never mis-applies.
const TARGETED_SUPPORTS = new Set([
  "needle", "pickpocket", "sabotage", "cardswap", "freezeout", "lemonadespill", "sneakypeek", "switcheroo",
]);
const UNTARGETED_SUPPORTS = ["firstaid", "backpack", "hiddenstash", "goggles"];
const SUPPORT_LABELS: Record<string, string> = {
  firstaid: "First Aid (+1 life)",
  backpack: "Backpack (draw 2)",
  hiddenstash: "Hidden Stash (treasure)",
  goggles: "Goggles (peek deck)",
  needle: "Needle",
  pickpocket: "Pickpocket",
  sabotage: "Sabotage",
  cardswap: "Card Swap",
  freezeout: "Freeze Out",
  lemonadespill: "Lemonade Spill",
  sneakypeek: "Sneaky Peek",
  switcheroo: "Switcheroo",
};
const CARD_LABELS: Record<string, string> = {
  balloon: "💧 Balloon", miss: "🛡 Miss", hit: "💥 Hit", treasure: "💎 Treasure", wild: "🃏 Wild",
  umbrella: "☂️ Umbrella", backpack: "🎒 Backpack", firstaid: "➕ First Aid", towel: "🧻 Towel",
  goggles: "🥽 Goggles", needle: "📌 Needle", lifeguard: "🛟 Lifeguard", pickpocket: "🫳 Pickpocket",
  sabotage: "💣 Sabotage", cardswap: "🔄 Card Swap", freezeout: "❄️ Freeze Out", hiddenstash: "📦 Hidden Stash",
  redirect: "↪️ Redirect", lemonadespill: "🍋 Lemonade Spill", sneakypeek: "👀 Sneaky Peek",
  watertrap: "🪤 Water Trap", switcheroo: "🌀 Switcheroo", mega: "🌊 Mega", launcher: "🔫 Launcher",
  triplesplash: "💦 Triple Splash", golden: "🏆 Golden", rapidfire: "⚡ Rapid Fire", splashzone: "🌐 Splash Zone",
  giant: "🗿 Giant", soaker: "🚿 Soaker", flashflood: "🌧 Flash Flood", event: "🎲 Event",
};

// In-game styles only (injected by mount(), present during PLAYING). The lobby
// stepper/settings rules live in the GLOBAL style.css — the lobby renders this
// game's settings while this view is unmounted, so an inline <style> wouldn't apply.
const STYLE = `
.wf { font-family: system-ui, sans-serif; display: flex; flex-direction: column; gap: 12px; color: var(--text); }
.wf-banner { padding: 8px 12px; border-radius: 8px; background: var(--card); color: var(--text); font-weight: 600; }
.wf-banner.act { background: #1d3a2a; }
.wf-banner.sudden { background: #3a1d22; }
.wf-reveal { padding: 8px 12px; border-radius: 8px; background: var(--card); border: 1px solid var(--warn); color: var(--text); font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wf-reveal button { padding: 2px 8px; }
.wf-splash { padding: 10px 12px; border-radius: 8px; font-weight: 700; font-size: 15px; text-align: center; color: var(--text); animation: wf-pop 0.25s ease-out; }
.wf-splash.hit { background: #3a1d22; border: 1px solid var(--danger); }
.wf-splash.miss { background: #1d2740; border: 1px solid var(--accent); }
@keyframes wf-pop { from { transform: scale(0.82); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.wf-seats { display: flex; flex-wrap: wrap; gap: 8px; }
.wf-seat { border: 1px solid #353a4f; border-radius: 8px; padding: 8px 10px; min-width: 120px; background: var(--card); }
.wf-seat.turn { border-color: var(--accent); box-shadow: 0 0 0 2px #5b8cff33; }
.wf-seat.out { opacity: 0.6; }
.wf-seat .nm { font-weight: 700; }
.wf-seat .lives { font-size: 16px; }
.wf-seat .tags { font-size: 12px; color: var(--muted); }
.wf-decks { font-size: 12px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 10px; }
.wf-hand { display: flex; flex-wrap: wrap; gap: 6px; }
.wf-card { border: 1px solid #353a4f; border-radius: 6px; padding: 4px 8px; background: var(--bg); color: var(--text); font-size: 13px; cursor: default; }
.wf-card.sel { background: var(--warn); border-color: var(--warn); color: var(--bg); cursor: pointer; }
.wf-card.pick { cursor: pointer; }
.wf-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.wf-actions button { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; font-size: 13px; }
.wf-actions button.ghost { background: transparent; color: var(--accent); }
.wf-actions button.draw { background: var(--warn); border-color: var(--warn); color: var(--bg); font-weight: 700; font-size: 14px; }
.wf-actions button:disabled { opacity: 0.5; cursor: default; }
.wf-log { font-size: 12px; color: var(--muted); max-height: 110px; overflow-y: auto; border-top: 1px solid #353a4f; padding-top: 6px; }
.wf-mute { align-self: flex-end; background: none; border: none; cursor: pointer; font-size: 18px; }
`;

function countKind(hand: { kind: string }[], kind: string): number {
  return hand.reduce((n, c) => n + (c.kind === kind ? 1 : 0), 0);
}

/** Minimal sell to reach `cost` coins, or null. UI-only MIRROR of the engine's
 *  minimalSell (gates which Shop buttons show); the server recomputes + validates
 *  the actual sale. Coin values come from the shared COIN_VALUES (no drift). */
function minimalSell(hand: { kind: string }[], cost: number): { balloons: number; treasures: number; wild: number } | null {
  const b = countKind(hand, "balloon");
  const t = countKind(hand, "treasure");
  const w = countKind(hand, "wild");
  let coins = 0, sb = 0, st = 0, sw = 0;
  while (coins < cost && st < t) { st++; coins += COIN_VALUES.treasure; }
  while (coins < cost && sb < b) { sb++; coins += COIN_VALUES.balloon; }
  if (coins < cost && w > 0) { sw = 1; coins += COIN_VALUES.wild; }
  return coins >= cost ? { balloons: sb, treasures: st, wild: sw } : null;
}

export class WaterFightView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, WaterFightState>;
  private ctx?: GameViewContext;
  private readonly onState = () => this.render();
  private readonly onClick = (ev: Event) => this.handleClick(ev);
  private wasMyMoment = false;
  private discardSel = new Set<number>();
  /** The last private peek (Goggles / Sneaky Peek), shown until dismissed/acted. */
  private reveal?: { kind: string; ofSeat: number; cards: { id: number; kind: string }[] };
  /** Splash-flip reveal: shown briefly when a NEW flip (rising lastSplashSeq) lands.
   *  Rendered into its own DOM node (not the rebuilt .wf) so the pop animation only
   *  fires once per draw, not on every state delta. */
  private splashReveal?: { seq: number; verdict: string; target: number; until: number };
  private splashTimer?: ReturnType<typeof setTimeout>;
  /** Highest splash seq we've already shown — seeded from current state on mount so a
   *  refresh/resume/late-join into a game that already threw never replays a stale flip. */
  private lastSeenSplashSeq = 0;

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, WaterFightState>;
    this.ctx = ctx;
    this.lastSeenSplashSeq = this.room.state.lastSplashSeq ?? 0; // seed BEFORE first render
    root.innerHTML = `<style>${STYLE}</style><div class="wf-splash-host"></div><div class="wf"></div>`;
    root.addEventListener("click", this.onClick);
    this.room.onStateChange(this.onState);
    this.room.onMessage(WaterFightMsg.REVEAL, (payload: { kind: string; ofSeat: number; cards: { id: number; kind: string }[] }) => {
      if (!this.root) return; // ignore if this view has since unmounted
      this.reveal = payload;
      this.render();
    });
    hookSaveData(this.room, WF_SAVES_KEY, wfTurnLabel, () => flashToast(root, "Saved ✓"));
    this.render();
  }

  unmount(): void {
    this.room?.onStateChange.remove(this.onState);
    this.root?.removeEventListener("click", this.onClick);
    if (this.splashTimer) clearTimeout(this.splashTimer);
    this.splashTimer = undefined;
    this.splashReveal = undefined;
    this.root = undefined;
    this.room = undefined;
  }

  private mySeatIndex(state: WaterFightState): number {
    const seats = [...state.seats];
    return seats.findIndex((s) => s.sessionId === this.ctx!.mySessionId);
  }

  private handleClick(ev: Event): void {
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
    if (!el || !this.room) return;
    const room = this.room;
    const d = el.dataset;
    const target = d.target !== undefined ? Number(d.target) : undefined;
    switch (d.act) {
      case "mute":
        setMuted(!isMuted());
        this.render();
        return;
      case "save":
        room.send(LobbyMsg.SAVE, {});
        return;
      case "dismiss-reveal":
        this.reveal = undefined;
        this.render();
        return;
      case "draw":
        room.send(WaterFightMsg.RESOLVE, { kind: "DRAW_SPLASH" });
        return;
      case "end":
        room.send(WaterFightMsg.MOVE, { kind: "END_TURN" });
        return;
      case "flashflood":
        room.send(WaterFightMsg.MOVE, { kind: "FLASH_FLOOD" });
        return;
      case "storm":
        room.send(WaterFightMsg.MOVE, { kind: "STORM_THROW" });
        return;
      case "throw":
        room.send(WaterFightMsg.MOVE, { kind: "THROW", target, ...(d.soaker ? { soaker: true } : {}) });
        return;
      case "spread":
        room.send(WaterFightMsg.MOVE, {
          kind: "THROW",
          target,
          spread: { modifier: d.mod, extraTargets: (d.extra ?? "").split(",").filter(Boolean).map(Number) },
        });
        return;
      case "big":
        room.send(WaterFightMsg.MOVE, { kind: "PLAY_BIG", big: d.big, target });
        return;
      case "support":
        room.send(WaterFightMsg.MOVE, { kind: "PLAY_SUPPORT", support: d.support, ...(target !== undefined ? { target } : {}) });
        return;
      case "shop":
        room.send(WaterFightMsg.MOVE, { kind: "SHOP", sell: JSON.parse(d.sell ?? "{}"), buy: [d.stack] });
        return;
      case "react":
        room.send(WaterFightMsg.RESOLVE, { kind: "REACT", action: d.action, ...(target !== undefined ? { target } : {}) });
        return;
      case "defend":
        room.send(WaterFightMsg.RESOLVE, { kind: "DEFEND", defense: d.defense });
        return;
      case "respond":
        room.send(WaterFightMsg.RESOLVE, { kind: "ATTACKER_RESPOND", respond: d.respond });
        return;
      case "extra":
        room.send(WaterFightMsg.RESOLVE, { kind: "EXTRA", action: d.action, ...(target !== undefined ? { target } : {}) });
        return;
      case "togglecard": {
        const id = Number(d.id);
        if (this.discardSel.has(id)) this.discardSel.delete(id);
        else this.discardSel.add(id);
        this.render();
        return;
      }
      case "discard":
        room.send(WaterFightMsg.RESOLVE, { kind: "DISCARD", cardIds: [...this.discardSel] });
        this.discardSel.clear();
        return;
    }
  }

  private render(): void {
    if (!this.root || !this.room || !this.ctx) return;
    const state = this.room.state;
    const wrap = this.root.querySelector<HTMLElement>(".wf");
    if (!wrap || state.phase !== Phase.PLAYING) {
      if (wrap && state.phase !== Phase.PLAYING) wrap.innerHTML = "";
      this.renderSplash();
      return;
    }
    this.detectSplash(state);
    const seats = [...state.seats];
    const mySeat = this.mySeatIndex(state);
    const awaiting = [...state.awaitingSeats];
    const myMoment = mySeat >= 0 && awaiting.includes(mySeat) && state.awaitingKind !== "";

    // turn alert on the rising edge of "my moment to act"
    if (myMoment && !this.wasMyMoment) {
      turnChime();
      flashToast(this.root, this.momentLabel(state));
    }
    this.wasMyMoment = myMoment;

    const isHost = state.hostSessionId === this.ctx.mySessionId;
    wrap.innerHTML = [
      `<div style="display:flex;gap:6px;align-self:flex-end">${
        isHost ? `<button class="wf-mute" data-act="save" title="Save game">💾</button>` : ""
      }<button class="wf-mute" data-act="mute" title="Sound">${isMuted() ? "🔕" : "🔔"}</button></div>`,
      this.renderBanner(state, mySeat, myMoment),
      this.renderReveal(seats),
      this.renderSeats(state, seats, mySeat),
      this.renderDecks(state),
      this.renderHand(state, seats, mySeat, myMoment),
      myMoment ? `<div class="wf-actions">${this.renderActions(state, seats, mySeat)}</div>` : "",
      this.renderLog(state),
    ].join("");
    this.renderSplash();
  }

  /** Arm a transient HIT/MISS reveal when a NEW Splash flip lands (seq rose). */
  private detectSplash(state: WaterFightState): void {
    if (state.lastSplashSeq > this.lastSeenSplashSeq) {
      this.lastSeenSplashSeq = state.lastSplashSeq;
      this.splashReveal = {
        seq: state.lastSplashSeq,
        verdict: state.lastSplashVerdict,
        target: state.lastSplashTarget,
        until: Date.now() + SPLASH_REVEAL_MS,
      };
      if (this.splashTimer) clearTimeout(this.splashTimer);
      this.splashTimer = setTimeout(() => {
        this.splashReveal = undefined;
        this.render();
      }, SPLASH_REVEAL_MS);
    } else if (this.splashReveal && Date.now() >= this.splashReveal.until) {
      this.splashReveal = undefined; // safety net if the timer was superseded
    }
  }

  /** Paint the splash reveal into its OWN node, only when it changes — so the pop
   *  animation fires once per draw, not on every unrelated state delta. */
  private renderSplash(): void {
    const host = this.root?.querySelector<HTMLElement>(".wf-splash-host");
    if (!host) return;
    const r = this.splashReveal;
    const key = r ? String(r.seq) : "";
    if (host.dataset.seq === key) return; // unchanged — leave the (possibly animating) node
    host.dataset.seq = key;
    if (!r) {
      host.innerHTML = "";
      return;
    }
    const seats = [...(this.room?.state.seats ?? [])];
    const who = escapeHtml(seats.find((s) => s.seat === r.target)?.nickname ?? `Seat ${r.target + 1}`);
    const label = r.verdict === "hit" ? `💥 SPLASH on ${who} — HIT!` : `💦 SPLASH on ${who} — MISS`;
    host.innerHTML = `<div class="wf-splash ${r.verdict === "hit" ? "hit" : "miss"}">${label}</div>`;
  }

  private momentLabel(state: WaterFightState): string {
    switch (state.awaitingKind) {
      case "MOVE": return "Your turn!";
      case "DEFEND": return "Defend!";
      case "ATTACKER_RESPOND": return "Push your attack?";
      case "REACT": return "React!";
      case "EXTRA_THROW": return "Throw again?";
      case "SPLASH_DRAW": return "Draw the Splash card!";
      case "DISCARD": return "Discard down";
      default: return "Your move";
    }
  }

  private renderReveal(seats: WaterFightSeat[]): string {
    if (!this.reveal) return "";
    const cards = this.reveal.cards.map((c) => CARD_LABELS[c.kind] ?? escapeHtml(c.kind)).join(" · ");
    const who =
      this.reveal.kind === "hand"
        ? `${escapeHtml(seats.find((s) => s.seat === this.reveal!.ofSeat)?.nickname ?? "Opponent")}'s hand`
        : "Top of the draw pile";
    return `<div class="wf-reveal">👀 <b>${who}:</b> ${cards || "(empty)"} <button data-act="dismiss-reveal" class="ghost">dismiss</button></div>`;
  }

  private renderBanner(state: WaterFightState, mySeat: number, myMoment: boolean): string {
    const sudden = state.suddenDeath ? `<div class="wf-banner sudden">⚡ SUDDEN-DEATH — single-target hits only</div>` : "";
    let msg: string;
    if (myMoment) msg = this.momentLabel(state);
    else {
      const who = [...state.seats].find((s) => s.seat === (state.awaitingSeats[0] ?? state.turnSeat));
      const verb =
        state.awaitingKind === "MOVE" ? "is choosing"
        : state.awaitingKind === "SPLASH_DRAW" ? "is drawing the splash"
        : "is reacting";
      msg = `${escapeHtml(who?.nickname ?? "Someone")} ${verb}…`;
    }
    const atk = state.attackActive
      ? ` &nbsp;|&nbsp; incoming <b>${escapeHtml(state.attackKind)}</b> balloon (block ${state.attackBlockNumber}${state.attackSoaker ? ", Soaker!" : ""})`
      : "";
    return `<div class="wf-banner ${myMoment ? "act" : ""}">${escapeHtml(msg)}${atk}</div>${sudden}`;
  }

  private renderSeats(state: WaterFightState, seats: WaterFightSeat[], mySeat: number): string {
    return `<div class="wf-seats">${seats
      .map((s) => {
        const cls = ["wf-seat"];
        if (s.seat === state.turnSeat && !state.attackActive) cls.push("turn");
        if (s.out && !s.stormCloud) cls.push("out");
        const hearts = s.out ? (s.stormCloud ? "⛈️ Storm Cloud" : "💀 out") : "❤️".repeat(s.lives) || "—";
        const tags = [
          s.seat === mySeat ? "you" : "",
          s.freezeOut ? "❄️" : "",
          s.noShop ? "🚫shop" : "",
          s.gone ? "🤖" : "",
        ].filter(Boolean).join(" ");
        return `<div class="${cls.join(" ")}">
          <div class="nm">${escapeHtml(s.nickname || `Seat ${s.seat + 1}`)}</div>
          <div class="lives">${hearts}</div>
          <div class="tags">🂠 ${s.handCount}${tags ? " · " + tags : ""}</div>
        </div>`;
      })
      .join("")}</div>`;
  }

  private renderDecks(state: WaterFightState): string {
    return `<div class="wf-decks">
      <span>Deck ${state.mainDeckCount} (discard ${state.mainDiscardCount})</span>
      <span>Splash ${state.splashPileCount}/${state.splashPileCount + state.splashDiscardCount}</span>
      <span>Shop 🛡${state.stackCounts[0] ?? 0} 🃏${state.stackCounts[1] ?? 0} 🌊${state.stackCounts[2] ?? 0} (cost ${state.shopCost})</span>
      <span>Turn ${state.turnCount}</span>
    </div>`;
  }

  private renderHand(state: WaterFightState, seats: WaterFightSeat[], mySeat: number, myMoment: boolean): string {
    if (mySeat < 0) return "";
    const hand = [...(seats[mySeat]?.hand ?? [])];
    if (hand.length === 0) return `<div class="wf-hand"><em>(no cards)</em></div>`;
    const picking = myMoment && state.awaitingKind === "DISCARD";
    return `<div class="wf-hand">${hand
      .map((c) => {
        const sel = this.discardSel.has(c.id);
        const cls = ["wf-card"];
        if (picking) cls.push("pick");
        if (sel) cls.push("sel");
        const attr = picking ? `data-act="togglecard" data-id="${c.id}"` : "";
        // CARD_LABELS values are static/safe; escape the fallback (kind could be
        // an unrecognized string from a tampered save blob).
        return `<span class="${cls.join(" ")}" ${attr}>${CARD_LABELS[c.kind] ?? escapeHtml(c.kind)}</span>`;
      })
      .join("")}</div>`;
  }

  private renderActions(state: WaterFightState, seats: WaterFightSeat[], mySeat: number): string {
    const hand = [...(seats[mySeat]?.hand ?? [])];
    const opp = (extra = mySeat) => seats.filter((s) => !s.out && s.seat !== extra);
    const has = (k: string) => countKind(hand, k) > 0;
    const btn = (act: string, label: string, attrs = "", ghost = false) =>
      `<button data-act="${act}" ${attrs} class="${ghost ? "ghost" : ""}">${label}</button>`;
    const out: string[] = [];

    switch (state.awaitingKind) {
      case "SPLASH_DRAW": {
        // The attacker flips the Splash Pile to see hit/miss for the throw they committed.
        out.push(`<button data-act="draw" class="draw">🎴 Draw from the Splash Pile</button>`);
        break;
      }
      case "MOVE": {
        const me = seats[mySeat]!;
        if (me.stormCloud) {
          if (has("balloon")) out.push(btn("storm", "💦 Splash a random player"));
          out.push(btn("end", "End turn", "", true));
          break;
        }
        const opponents = opp();
        if (has("balloon")) {
          for (const t of opponents) {
            out.push(btn("throw", `💧 Throw → ${escapeHtml(t.nickname)}`, `data-target="${t.seat}"`));
            if (has("soaker")) out.push(btn("throw", `🚿 Soaker → ${escapeHtml(t.nickname)}`, `data-target="${t.seat}" data-soaker="1"`));
          }
          if (opponents.length >= 2 && has("splashzone")) {
            out.push(btn("spread", "🌐 Splash Zone (all)", `data-target="${opponents[0]!.seat}" data-mod="splashzone"`));
          }
          if (opponents.length >= 2 && has("triplesplash")) {
            const extra = opponents.slice(1, 3).map((s) => s.seat).join(",");
            out.push(btn("spread", "💦 Triple Splash", `data-target="${opponents[0]!.seat}" data-mod="triplesplash" data-extra="${extra}"`));
          }
        }
        for (const big of ["mega", "giant", "golden"]) {
          if (has(big)) for (const t of opponents) out.push(btn("big", `${CARD_LABELS[big]} → ${escapeHtml(t.nickname)}`, `data-big="${big}" data-target="${t.seat}"`));
        }
        if (has("flashflood") && opponents.length > 0) out.push(btn("flashflood", "🌧 Flash Flood (all, 2 dmg)"));
        for (const sup of UNTARGETED_SUPPORTS) {
          if (has(sup)) out.push(btn("support", SUPPORT_LABELS[sup] ?? sup, `data-support="${sup}"`, true));
        }
        for (const sup of TARGETED_SUPPORTS) {
          if (has(sup)) for (const t of opponents) out.push(btn("support", `${SUPPORT_LABELS[sup] ?? sup} → ${escapeHtml(t.nickname)}`, `data-support="${sup}" data-target="${t.seat}"`, true));
        }
        if (!me.noShop) {
          const sell = minimalSell(hand, state.shopCost);
          if (sell) {
            WF_STACK_IDS.forEach((name, idx) => {
              if ((state.stackCounts[idx] ?? 0) > 0) {
                out.push(btn("shop", `🛒 Buy ${name}`, `data-stack="${name}" data-sell='${JSON.stringify(sell)}'`, true));
              }
            });
          }
        }
        out.push(btn("end", "End turn", "", true));
        break;
      }
      case "DEFEND": {
        if (has("miss") && !state.attackSoaker) out.push(btn("defend", "🛡 Block (Miss)", `data-defense="miss"`));
        if (has("umbrella")) out.push(btn("defend", "☂️ Umbrella", `data-defense="umbrella"`));
        if (has("wild")) out.push(btn("defend", "🃏 Wild (miss)", `data-defense="wild_miss"`));
        out.push(btn("defend", "Take the hit (pass)", `data-defense="pass"`, true));
        break;
      }
      case "ATTACKER_RESPOND": {
        if (has("hit")) out.push(btn("respond", "💥 Hit (chip a block)", `data-respond="hit"`));
        if (has("wild")) out.push(btn("respond", "🃏 Wild (hit)", `data-respond="wild_hit"`));
        out.push(btn("respond", "Stop (pass)", `data-respond="pass"`, true));
        break;
      }
      case "REACT": {
        if (has("towel")) out.push(btn("react", "🧻 Towel (cancel)", `data-action="towel"`));
        if (state.pendingKind !== "SUPPORT" && has("redirect")) {
          for (const t of opp()) out.push(btn("react", `↪️ Redirect → ${escapeHtml(t.nickname)}`, `data-action="redirect" data-target="${t.seat}"`));
        }
        if (state.pendingKind !== "SUPPORT" && has("watertrap")) out.push(btn("react", "🪤 Water Trap (bounce)", `data-action="watertrap"`));
        out.push(btn("react", "Let it through (pass)", `data-action="pass"`, true));
        break;
      }
      case "EXTRA_THROW": {
        if (has("balloon")) for (const t of opp()) out.push(btn("extra", `💧 Throw again → ${escapeHtml(t.nickname)}`, `data-action="throw" data-target="${t.seat}"`));
        out.push(btn("extra", "Done (pass)", `data-action="pass"`, true));
        break;
      }
      case "DISCARD": {
        const need = state.discardCount;
        const ready = this.discardSel.size === need;
        out.push(btn("discard", `Discard ${this.discardSel.size}/${need}`, ready ? "" : "disabled"));
        break;
      }
    }
    return out.join("");
  }

  private renderLog(state: WaterFightState): string {
    const lines = [...state.log].slice(-8).reverse();
    return `<div class="wf-log">${lines.map((l) => escapeHtml(l)).join("<br>")}</div>`;
  }
}

// ---- lobby settings (drives off the WF_SETTINGS descriptor table — 2A) ----

export function renderWaterFightLobbySettings(
  container: HTMLElement,
  room: Room<any, BaseState>,
  ctx: LobbySettingsContext,
): void {
  const state = room.state as unknown as WaterFightState & Record<string, number>;
  const dis = ctx.isHost ? "" : "disabled";
  // −/value/+ steppers (native number-input arrows don't render on mobile). Mirrors
  // Paper.io's stepper; CSS lives in the global style.css (this runs in the lobby,
  // where this game's in-game <style> is not mounted).
  const rows = WF_SETTINGS.map((s) => {
    const value = (state as Record<string, number>)[s.key] ?? s.default;
    return `<div class="wf-lobby-setting" title="${escapeHtml(s.hint)}">
      <span>${escapeHtml(s.label)}</span>
      <span class="wf-stepper">
        <button class="secondary" data-step data-key="${s.key}" data-dir="-1" ${dis}>−</button>
        <b class="wf-val">${value}</b>
        <button class="secondary" data-step data-key="${s.key}" data-dir="1" ${dis}>+</button>
      </span>
    </div>`;
  }).join("");
  const seatsLeft = state.maxPlayers - state.players.size;
  const addBot = ctx.isHost && seatsLeft > 0 ? `<button class="wf-add-bot" data-addbot>+ Add AI</button>` : "";
  container.innerHTML = `<div class="wf-lobby">${rows}${addBot}${
    ctx.isHost ? "" : '<div class="wf-lobby-setting muted">(host sets the dials)</div>'
  }<div class="wf-saves-block"></div></div>`;

  renderSaveSlots(container.querySelector<HTMLElement>(".wf-saves-block")!, room, {
    key: WF_SAVES_KEY,
    isHost: ctx.isHost,
    loadedSave: state.loadedSave,
  });
  // Per-element listeners (re-attached each render; the lobby has no [data-act]
  // root delegation). Read the value LIVE from room.state to avoid a stale closure.
  if (ctx.isHost) {
    container.querySelectorAll<HTMLButtonElement>("button[data-step]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.dataset.key!;
        const desc = WF_SETTINGS.find((s) => s.key === key);
        if (!desc) return;
        const cur = (room.state as unknown as Record<string, number>)[key] ?? desc.default;
        const next = Math.min(desc.max, Math.max(desc.min, cur + Number(btn.dataset.dir) * desc.step));
        if (next !== cur) room.send(WaterFightMsg.CONFIG, { key, value: next });
      });
    });
  }
  container.querySelector<HTMLButtonElement>("[data-addbot]")?.addEventListener("click", () => {
    room.send(LobbyMsg.ADD_BOT, {});
  });
}

// ---- game-over summary ----

export function renderWaterFightGameSummary(
  container: HTMLElement,
  room: Room<any, BaseState>,
): void {
  const state = room.state as unknown as WaterFightState;
  const seats = [...state.seats];
  if (seats.length === 0) return;
  const winner = seats.find((s) => !s.out);
  const rows = seats
    .slice()
    .sort((a, b) => Number(b.lives) - Number(a.lives))
    .map((s) => {
      const status = !s.out ? `${s.lives} ❤️` : s.stormCloud ? "Storm Cloud" : "soaked";
      const crown = winner && s.seat === winner.seat ? "👑 " : "";
      return `<tr><td>${crown}${escapeHtml(s.nickname || `Seat ${s.seat + 1}`)}</td><td>${status}</td></tr>`;
    })
    .join("");
  container.innerHTML = `<table class="wf-summary"><tbody>${rows}</tbody></table>`;
}
