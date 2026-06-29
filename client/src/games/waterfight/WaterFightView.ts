/**
 * Water Fight view — renders the synced schema and sends raw engine Move /
 * Resolution JSON. The server validates everything; the option-gating mirrored
 * here only exists to show the right buttons. The engine is never on the client,
 * so the view reads only the public projection + this seat's own @view() hand.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  CARD_INFO,
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
import { escapeAttr, escapeHtml } from "../../lobby/HomeScreen.js";
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
// Labels + one-line descriptions both come from the shared CARD_INFO table (single
// source of truth — the hand tiles, tap-to-review modal, and ❓ Help all read it).
const CARD_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(CARD_INFO).map(([k, v]) => [k, v.label]),
);
const cardLabel = (kind: string): string => CARD_INFO[kind as keyof typeof CARD_INFO]?.label ?? kind;
const cardDesc = (kind: string): string => CARD_INFO[kind as keyof typeof CARD_INFO]?.desc ?? "";
const cardEmoji = (kind: string): string => cardLabel(kind).split(" ")[0] ?? "🃏";
const cardName = (kind: string): string => cardLabel(kind).split(" ").slice(1).join(" ") || kind;
/** Which shop stack a card belongs to → drives the card-tile category color band. */
const cardCategory = (kind: string): string => CARD_INFO[kind as keyof typeof CARD_INFO]?.stack ?? "basic";
const NUDGE_KEY = "waterfight-card-hint-seen";

// In-game styles only (injected by mount(), present during PLAYING). The lobby
// stepper/settings rules live in the GLOBAL style.css — the lobby renders this
// game's settings while this view is unmounted, so an inline <style> wouldn't apply.
// In-game styles, injected by mount() and present only during PLAYING. Category
// band colors (basic/defense/mischief/attack) are the through-line that teaches new
// players — they repeat on card tiles, the help legend, and the detail modal accent.
const STYLE = `
.wf { font-family: system-ui, sans-serif; display: flex; flex-direction: column; gap: 14px; color: var(--text); }
@media (min-width: 900px) {
  .wf { display: grid; grid-template-columns: 1fr minmax(280px, 340px); gap: 18px; align-items: start; }
}
.wf-main { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.wf-side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.wf-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.wf-banner { flex: 1; padding: 12px 16px; border-radius: 12px; background: var(--card); color: var(--text); font-weight: 600; font-size: 15px; border-left: 4px solid transparent; }
.wf-banner.act { background: #1d3a2a; border-left-color: var(--ok); }
.wf-banner.defend { background: #3a1d22; border-left-color: var(--danger); }
.wf-banner.act.rise { animation: wf-pulse 0.9s ease-out; }
.wf-banner .atk-chip { display: inline-block; margin-top: 6px; font-size: 13px; font-weight: 700; color: #ffd9dd; background: #4a232b; border: 1px solid var(--danger); border-radius: 99px; padding: 2px 10px; }
.wf-banner.sudden { background: #3a1d22; border-left-color: var(--danger); font-weight: 700; }
@keyframes wf-pulse { 0% { box-shadow: 0 0 0 0 #41c98a66; } 100% { box-shadow: 0 0 0 10px #41c98a00; } }
.wf-controls { display: flex; gap: 8px; }
.wf-ic { width: 44px; height: 44px; border-radius: 10px; border: 1px solid #353a4f; background: #191c28; color: var(--text); font-size: 18px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.wf-ic.help { border-color: var(--accent); color: var(--accent); }
.wf-reveal { padding: 10px 12px; border-radius: 10px; background: var(--card); border: 1px solid var(--warn); color: var(--text); font-size: 13px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wf-reveal button { padding: 4px 10px; min-height: 32px; }
.wf-splash { max-width: 560px; margin: 0 auto; padding: 12px 14px; border-radius: 10px; font-weight: 800; font-size: 16px; text-align: center; color: var(--text); animation: wf-pop 0.25s ease-out; }
.wf-splash.hit { background: #3a1d22; border: 1px solid var(--danger); }
.wf-splash.miss { background: #1d2740; border: 1px solid var(--accent); }
@keyframes wf-pop { from { transform: scale(0.82); opacity: 0; } to { transform: scale(1); opacity: 1; } }
.wf-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: var(--muted); margin: 2px 0 -2px; }
.wf-seats { display: flex; flex-wrap: wrap; gap: 10px; }
.wf-seat { flex: 1 1 140px; border: 1px solid #353a4f; border-radius: 12px; padding: 10px 12px; min-width: 130px; background: var(--card); }
.wf-seat.turn { border-color: var(--accent); box-shadow: 0 0 0 2px #5b8cff33; }
.wf-seat.out { opacity: 0.55; }
.wf-seat .nm { font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wf-seat .lives { font-size: 17px; margin: 6px 0 4px; }
.wf-seat .tags { font-size: 12px; color: var(--muted); }
.wf-decks { font-size: 13px; color: var(--muted); background: var(--card); border: 1px solid #353a4f; border-radius: 12px; padding: 12px 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 7px 14px; }
.wf-decks b { color: var(--text); }
.wf-hand { display: flex; flex-wrap: wrap; gap: 10px; }
@media (max-width: 760px) { .wf-hand { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; } }
.wf-card { position: relative; width: 92px; min-height: 112px; flex: 0 0 auto; border: 1px solid #353a4f; border-top: 4px solid #7f8aa8; border-radius: 11px; padding: 12px 8px 10px; background: var(--card); color: var(--text); display: flex; flex-direction: column; align-items: center; gap: 6px; cursor: pointer; transition: transform 0.12s, border-color 0.12s, box-shadow 0.12s; }
.wf-card:hover { transform: translateY(-3px); box-shadow: 0 6px 16px #0006; }
.wf-card .ce { font-size: 28px; line-height: 1; }
.wf-card .cn { font-weight: 700; font-size: 12px; text-align: center; }
.wf-card .ci { position: absolute; top: 4px; right: 4px; width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 13px; opacity: 0.75; }
.wf-card.cat-defense { border-top-color: var(--accent); }
.wf-card.cat-mischief { border-top-color: #b07bff; }
.wf-card.cat-attack { border-top-color: var(--warn); }
.wf-card.sel { background: var(--warn); border-color: var(--warn); color: var(--bg); }
.wf-card.sel .cn { color: var(--bg); }
.wf-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.wf-actions button { min-height: 44px; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; font-size: 14px; font-weight: 600; display: inline-flex; flex-direction: column; align-items: flex-start; gap: 1px; }
.wf-actions button.ghost { background: transparent; color: var(--accent); font-weight: 500; }
.wf-actions button.draw { background: var(--warn); border-color: var(--warn); color: #241c00; font-weight: 800; font-size: 15px; box-shadow: 0 0 0 3px #e3b34122; }
.wf-actions button.primary { font-size: 15px; font-weight: 700; }
.wf-actions button .gloss { font-size: 11px; font-weight: 500; opacity: 0.85; }
.wf-actions button:disabled { opacity: 0.5; cursor: default; }
.wf-log { font-size: 13px; color: #cfd4e4; background: var(--card); border: 1px solid #353a4f; border-radius: 12px; padding: 12px 14px; max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; line-height: 1.35; }
.wf-log .ln b { color: var(--text); }
.wf-nudge { font-size: 13px; color: var(--muted); background: #191c28; border: 1px dashed #3a4470; border-radius: 10px; padding: 9px 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.wf-nudge button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 16px; min-width: 32px; }
/* ---- modal (dark, NOT the light .pp-modal skin) ---- */
.wf-modal-backdrop { position: fixed; inset: 0; z-index: 70; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; padding: 16px; }
.wf-modal { background: var(--card); border: 1px solid #353a4f; border-radius: 16px; max-width: 300px; width: 100%; position: relative; box-shadow: 0 18px 50px #000a; animation: wf-pop 0.2s ease-out; }
.wf-modal.help { max-width: 400px; max-height: 80vh; display: flex; flex-direction: column; }
.wf-modal .x { position: absolute; top: 8px; right: 12px; background: none; border: none; color: var(--muted); font-size: 20px; cursor: pointer; min-width: 32px; min-height: 32px; }
.wf-cd { padding: 22px 20px; text-align: center; }
.wf-cd .ce { font-size: 52px; }
.wf-cd .nm { font-weight: 800; font-size: 20px; margin-top: 8px; }
.wf-cd .stack { display: inline-block; margin: 10px 0; font-size: 11px; font-weight: 700; color: #cdd6ff; background: #26305a; border: 1px solid #3a478a; padding: 3px 11px; border-radius: 99px; }
.wf-cd .desc { font-size: 15px; line-height: 1.5; color: #d4d9e8; }
.wf-mh { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #353a4f; }
.wf-mh h2 { font-size: 17px; margin: 0; }
.wf-mbody { padding: 14px 18px 18px; overflow-y: auto; }
.wf-flow { font-size: 13px; color: #cfd4e4; line-height: 1.5; background: #191c28; border: 1px solid #353a4f; border-radius: 10px; padding: 11px 13px; margin-bottom: 16px; }
.wf-grp { margin-bottom: 14px; }
.wf-grp h4 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px; display: flex; align-items: center; gap: 7px; }
.wf-grp .gd { width: 10px; height: 10px; border-radius: 3px; }
.wf-grp .row { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid #222636; }
.wf-grp .row:last-child { border-bottom: none; }
.wf-grp .row .re { font-size: 19px; width: 26px; text-align: center; flex: 0 0 auto; }
.wf-grp .row .rt { font-weight: 700; font-size: 13px; width: 108px; flex: 0 0 auto; }
.wf-grp .row .rd { font-size: 12.5px; color: var(--muted); line-height: 1.35; }
`;

function countKind(hand: { kind: string }[], kind: string): number {
  return hand.reduce((n, c) => n + (c.kind === kind ? 1 : 0), 0);
}

/** Bold every player nickname inside a log line, scan-ably. Scans the RAW line and
 *  escapes name vs. non-name segments SEPARATELY, so it never re-scans inserted <b>
 *  tags or HTML entities — a 1-char name like "b" or a name that's a substring of
 *  another can't corrupt the markup (the round-1 split/join approach could). Exported
 *  for testing. */
export function emphasizeNames(line: string, seatNames: readonly string[]): string {
  const names = [...new Set(seatNames.filter((n) => n && n.trim().length > 0))]
    .sort((a, b) => b.length - a.length); // longest-first so "Bob" wins over "b"
  if (names.length === 0) return escapeHtml(line);
  const alnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);
  let out = "";
  let plain = "";
  const flush = () => { if (plain) { out += escapeHtml(plain); plain = ""; } };
  let i = 0;
  outer: while (i < line.length) {
    for (const n of names) {
      // Only bold a whole-word match — a 1-char or word-like nickname ("a", "hit")
      // must not bold the letters inside "spl-a-sh" / "draws Event: ...".
      if (line.startsWith(n, i) && !alnum(line[i - 1]) && !alnum(line[i + n.length])) {
        flush();
        out += `<b>${escapeHtml(n)}</b>`;
        i += n.length;
        continue outer;
      }
    }
    plain += line[i++];
  }
  flush();
  return out;
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
  /** Open modal: a card-detail (by kind) or the ❓ Help legend. Static content, so the
   *  guarded modal-host paints it only when this identity changes (survives opponent deltas). */
  private cardDetail?: { kind: string };
  private showRules = false;
  /** First-run "tap a card" hint, dismissed for good once seen (localStorage). */
  private nudgeSeen = (() => { try { return localStorage.getItem(NUDGE_KEY) === "1"; } catch { return false; } })();

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, WaterFightState>;
    this.ctx = ctx;
    this.lastSeenSplashSeq = this.room.state.lastSplashSeq ?? 0; // seed BEFORE first render
    root.innerHTML = `<style>${STYLE}</style><div class="wf-splash-host"></div><div class="wf-modal-host"></div><div class="wf"></div>`;
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
    this.cardDetail = undefined;
    this.showRules = false;
    this.root = undefined;
    this.room = undefined;
  }

  private mySeatIndex(state: WaterFightState): number {
    const seats = [...state.seats];
    return seats.findIndex((s) => s.sessionId === this.ctx!.mySessionId);
  }

  private handleClick(ev: Event): void {
    // Backdrop click closes any open modal — MUST be first, before the [data-act]
    // lookup (the backdrop has no data-act, so it would otherwise be ignored).
    if ((ev.target as HTMLElement | null)?.classList.contains("wf-modal-backdrop")) {
      this.cardDetail = undefined;
      this.showRules = false;
      this.render();
      return;
    }
    const el = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-act]");
    if (!el || !this.room) return;
    const room = this.room;
    const d = el.dataset;
    const target = d.target !== undefined ? Number(d.target) : undefined;
    switch (d.act) {
      case "review":
        this.cardDetail = { kind: d.kind ?? "" };
        this.render();
        return;
      case "rules":
        this.showRules = true;
        this.render();
        return;
      case "close-modal":
        this.cardDetail = undefined;
        this.showRules = false;
        this.render();
        return;
      case "dismiss-nudge":
        this.nudgeSeen = true;
        try { localStorage.setItem(NUDGE_KEY, "1"); } catch { /* ignore */ }
        this.render();
        return;
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
      this.cardDetail = undefined; // never leave a modal over the game-over screen
      this.showRules = false;
      this.renderSplash();
      this.renderModal();
      return;
    }
    this.detectSplash(state);
    const seats = [...state.seats];
    const mySeat = this.mySeatIndex(state);
    const awaiting = [...state.awaitingSeats];
    const myMoment = mySeat >= 0 && awaiting.includes(mySeat) && state.awaitingKind !== "";

    // turn alert + auto-close any open modal on the rising edge of "my moment to act",
    // so an incoming attack / my turn surfaces the action buttons.
    if (myMoment && !this.wasMyMoment) {
      this.cardDetail = undefined;
      this.showRules = false;
      turnChime();
      flashToast(this.root, this.momentLabel(state));
    }
    this.wasMyMoment = myMoment;

    const isHost = state.hostSessionId === this.ctx.mySessionId;
    const header = `<div class="wf-head">${this.renderBanner(state, myMoment)}<div class="wf-controls">${
      isHost ? `<button class="wf-ic" data-act="save" title="Save game">💾</button>` : ""
    }<button class="wf-ic" data-act="mute" title="Sound">${isMuted() ? "🔕" : "🔔"}</button>` +
      `<button class="wf-ic help" data-act="rules" title="How to play">❓</button></div></div>`;

    const main = [
      header,
      state.suddenDeath ? `<div class="wf-banner sudden">⚡ SUDDEN-DEATH — single-target hits only</div>` : "",
      this.renderReveal(seats),
      `<div class="wf-label">Players</div>`,
      this.renderSeats(state, seats, mySeat),
      myMoment ? `<div class="wf-label">Your move</div><div class="wf-actions">${this.renderActions(state, seats, mySeat)}</div>` : "",
      `<div class="wf-label">Your hand · tap a card to learn it</div>`,
      this.renderHand(state, seats, mySeat, myMoment),
      this.renderNudge(),
    ].join("");

    const side = [
      `<div class="wf-label">Game log</div>`,
      this.renderLog(state),
      this.renderDecks(state),
    ].join("");

    wrap.innerHTML = `<div class="wf-main">${main}</div><div class="wf-side">${side}</div>`;
    this.renderSplash();
    this.renderModal();
  }

  /** Paint the dark card-detail / Help modal into its own host node, only when the
   *  modal identity changes (static content → survives opponents' state deltas). */
  private renderModal(): void {
    const host = this.root?.querySelector<HTMLElement>(".wf-modal-host");
    if (!host) return;
    const key = this.showRules ? "rules" : this.cardDetail ? `card:${this.cardDetail.kind}` : "";
    if (host.dataset.key === key) return;
    host.dataset.key = key;
    if (!key) { host.innerHTML = ""; return; }
    host.innerHTML = `<div class="wf-modal-backdrop">${this.showRules ? this.renderRulesModal() : this.renderCardDetail()}</div>`;
  }

  /** One-time "tap a card" hint for first-timers (push, not pull). */
  private renderNudge(): string {
    if (this.nudgeSeen) return "";
    return `<div class="wf-nudge"><span>👆 Tap any card to see what it does — and ❓ up top explains the whole game.</span><button data-act="dismiss-nudge" title="Got it">✕</button></div>`;
  }

  private renderCardDetail(): string {
    const kind = this.cardDetail?.kind ?? "";
    const stack = cardCategory(kind);
    const stackLabel: Record<string, string> = {
      defense: "🛡 Defense Depot", mischief: "😈 Mischief Market", attack: "🌊 Attack Arsenal", basic: "🎴 Main deck",
    };
    return `<div class="wf-modal"><button class="x" data-act="close-modal" title="Close">✕</button>
      <div class="wf-cd"><div class="ce">${cardEmoji(kind)}</div>
        <div class="nm">${escapeHtml(cardName(kind))}</div>
        <div class="stack">${stackLabel[stack] ?? "🎴 Main deck"}</div>
        <div class="desc">${escapeHtml(cardDesc(kind)) || "—"}</div></div></div>`;
  }

  private renderRulesModal(): string {
    const groups: { id: string; title: string; color: string }[] = [
      { id: "basic", title: "Main deck", color: "#7f8aa8" },
      { id: "defense", title: "🛡 Defense Depot", color: "var(--accent)" },
      { id: "mischief", title: "😈 Mischief Market", color: "#b07bff" },
      { id: "attack", title: "🌊 Attack Arsenal", color: "var(--warn)" },
    ];
    const sections = groups.map((g) => {
      const rows = Object.keys(CARD_INFO)
        .filter((k) => cardCategory(k) === g.id)
        .map((k) => `<div class="row"><span class="re">${cardEmoji(k)}</span><span class="rt">${escapeHtml(cardName(k))}</span><span class="rd">${escapeHtml(cardDesc(k))}</span></div>`)
        .join("");
      return `<div class="wf-grp"><h4><span class="gd" style="background:${g.color}"></span>${g.title}</h4>${rows}</div>`;
    }).join("");
    return `<div class="wf-modal help"><div class="wf-mh"><h2>📖 How to play</h2><button class="x" data-act="close-modal" title="Close">✕</button></div>
      <div class="wf-mbody">
        <div class="wf-flow">Each turn: <b>draw 2</b> → play an optional <b>Support</b> card → take <b>one main action</b> (throw a balloon, play a big attack, shop, or pass) → if you throw, <b>draw the Splash card</b> to see hit or miss → defenders <b>block</b> → discard down to your hand limit. Last player with hearts wins.</div>
        ${sections}
      </div></div>`;
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

  private renderBanner(state: WaterFightState, myMoment: boolean): string {
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
    const danger = myMoment && (state.awaitingKind === "DEFEND" || state.awaitingKind === "REACT");
    const cls = myMoment ? (danger ? "defend rise" : "act rise") : "";
    const atkName = state.attackKind === "basic" ? "balloon" : cardName(state.attackKind);
    const chip = state.attackActive
      ? `<br><span class="atk-chip">💥 incoming ${escapeHtml(atkName)} · block ${state.attackBlockNumber}${state.attackSoaker ? " · Soaker" : ""}</span>`
      : "";
    return `<div class="wf-banner ${cls}">${escapeHtml(msg)}${chip}</div>`;
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
      <span>Draw deck <b>${state.mainDeckCount}</b></span>
      <span>Splash <b>${state.splashPileCount}/${state.splashPileCount + state.splashDiscardCount}</b></span>
      <span>Discard <b>${state.mainDiscardCount}</b></span>
      <span>Turn <b>${state.turnCount}</b></span>
      <span>🛡 Defense <b>${state.stackCounts[0] ?? 0}</b></span>
      <span>😈 Mischief <b>${state.stackCounts[1] ?? 0}</b></span>
      <span>🌊 Attack <b>${state.stackCounts[2] ?? 0}</b></span>
      <span>Shop cost <b>${state.shopCost}</b></span>
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
        const cls = ["wf-card", `cat-${cardCategory(c.kind)}`];
        if (sel) cls.push("sel");
        // During DISCARD the tile toggles selection; the ⓘ child still opens review.
        // Otherwise the whole tile opens the review modal.
        const tileAct = picking ? `data-act="togglecard" data-id="${c.id}"` : `data-act="review" data-kind="${escapeAttr(c.kind)}"`;
        const info = picking ? `<span class="ci" data-act="review" data-kind="${escapeAttr(c.kind)}">ⓘ</span>` : `<span class="ci">ⓘ</span>`;
        return `<div class="${cls.join(" ")}" ${tileAct}>${info}<span class="ce">${cardEmoji(c.kind)}</span><span class="cn">${escapeHtml(cardName(c.kind))}</span></div>`;
      })
      .join("")}</div>`;
  }

  private renderActions(state: WaterFightState, seats: WaterFightSeat[], mySeat: number): string {
    const hand = [...(seats[mySeat]?.hand ?? [])];
    const opp = (extra = mySeat) => seats.filter((s) => !s.out && s.seat !== extra);
    const has = (k: string) => countKind(hand, k) > 0;
    const btn = (act: string, label: string, attrs = "", ghost = false, gloss = "") =>
      `<button data-act="${act}" ${attrs} class="${ghost ? "ghost" : ""}">${label}${gloss ? `<span class="gloss">${escapeHtml(gloss)}</span>` : ""}</button>`;
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
            const SHOP_LABEL: Record<string, string> = { defense: "🛡 Defense Depot", mischief: "😈 Mischief Market", attack: "🌊 Attack Arsenal" };
            const SHOP_GLOSS: Record<string, string> = {
              defense: "blocks & heals (umbrella, towel, goggles…)",
              mischief: "steal, swap, freeze (water trap, redirect…)",
              attack: "big throws (mega, soaker, triple splash…)",
            };
            WF_STACK_IDS.forEach((name, idx) => {
              if ((state.stackCounts[idx] ?? 0) > 0) {
                out.push(btn("shop", `${SHOP_LABEL[name] ?? name}`, `data-stack="${name}" data-sell='${JSON.stringify(sell)}'`, true, SHOP_GLOSS[name] ?? ""));
              }
            });
          }
        }
        out.push(btn("end", "End turn", "", true));
        break;
      }
      case "DEFEND": {
        if (has("miss") && !state.attackSoaker) out.push(btn("defend", "🛡 Block (Miss)", `data-defense="miss"`, false, cardDesc("miss")));
        if (has("umbrella")) out.push(btn("defend", "☂️ Umbrella", `data-defense="umbrella"`, false, cardDesc("umbrella")));
        if (has("wild")) out.push(btn("defend", "🃏 Wild (block)", `data-defense="wild_miss"`, false, cardDesc("wild")));
        out.push(btn("defend", "Take the hit", `data-defense="pass"`, true));
        break;
      }
      case "ATTACKER_RESPOND": {
        if (has("hit")) out.push(btn("respond", "💥 Hit", `data-respond="hit"`, false, cardDesc("hit")));
        if (has("wild")) out.push(btn("respond", "🃏 Wild (hit)", `data-respond="wild_hit"`, false, cardDesc("wild")));
        out.push(btn("respond", "Stop", `data-respond="pass"`, true));
        break;
      }
      case "REACT": {
        if (has("towel")) out.push(btn("react", "🧻 Towel", `data-action="towel"`, false, cardDesc("towel")));
        if (state.pendingKind !== "SUPPORT" && has("redirect")) {
          for (const t of opp()) out.push(btn("react", `↪️ Redirect → ${escapeHtml(t.nickname)}`, `data-action="redirect" data-target="${t.seat}"`, false, cardDesc("redirect")));
        }
        if (state.pendingKind !== "SUPPORT" && has("watertrap")) out.push(btn("react", "🪤 Water Trap", `data-action="watertrap"`, false, cardDesc("watertrap")));
        out.push(btn("react", "Let it through", `data-action="pass"`, true));
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
    const names = [...state.seats].map((s) => s.nickname);
    const lines = [...state.log].slice(-16).reverse();
    return `<div class="wf-log">${lines.map((l) => `<div class="ln">${emphasizeNames(l, names)}</div>`).join("")}</div>`;
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
