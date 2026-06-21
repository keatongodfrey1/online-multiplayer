/**
 * Water Fight view — renders the synced schema and sends raw engine Move /
 * Resolution JSON. The server validates everything; the option-gating mirrored
 * here only exists to show the right buttons. The engine is never on the client,
 * so the view reads only the public projection + this seat's own @view() hand.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  LobbyMsg,
  Phase,
  WaterFightMsg,
  WF_SETTINGS,
  type WaterFightSeat,
  type WaterFightState,
} from "@backbone/shared";
import type { GameView, GameViewContext, LobbySettingsContext } from "../../framework/GameView.js";
import { escapeHtml } from "../../lobby/HomeScreen.js";
import { flashToast, isMuted, setMuted, turnChime } from "../../framework/turnAlert.js";
import { hookSaveData, renderSaveSlots } from "../../framework/saveSlots.js";

const WF_SAVES_KEY = "waterfight-saves";
const wfTurnLabel = (blob: any): number => (blob?.engine?.turnCount ?? 0) + 1;

const TARGETED_SUPPORTS = new Set([
  "needle", "pickpocket", "sabotage", "cardswap", "freezeout", "lemonadespill", "switcheroo",
]);
const UNTARGETED_SUPPORTS = ["firstaid", "backpack", "hiddenstash"];
const SUPPORT_LABELS: Record<string, string> = {
  firstaid: "First Aid (+1 life)",
  backpack: "Backpack (draw 2)",
  hiddenstash: "Hidden Stash (treasure)",
  needle: "Needle",
  pickpocket: "Pickpocket",
  sabotage: "Sabotage",
  cardswap: "Card Swap",
  freezeout: "Freeze Out",
  lemonadespill: "Lemonade Spill",
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

const STYLE = `
.wf { font-family: system-ui, sans-serif; display: flex; flex-direction: column; gap: 12px; color: var(--text, #1a1a1a); }
.wf-banner { padding: 8px 12px; border-radius: 8px; background: #eef3ff; font-weight: 600; }
.wf-banner.act { background: #d6f5d6; }
.wf-banner.sudden { background: #ffe0e0; }
.wf-seats { display: flex; flex-wrap: wrap; gap: 8px; }
.wf-seat { border: 1px solid #ccd; border-radius: 8px; padding: 8px 10px; min-width: 120px; background: #fafbff; }
.wf-seat.turn { border-color: #4a80ff; box-shadow: 0 0 0 2px #4a80ff33; }
.wf-seat.out { opacity: 0.6; }
.wf-seat .nm { font-weight: 700; }
.wf-seat .lives { font-size: 16px; }
.wf-seat .tags { font-size: 12px; color: #667; }
.wf-decks { font-size: 12px; color: #556; display: flex; flex-wrap: wrap; gap: 10px; }
.wf-hand { display: flex; flex-wrap: wrap; gap: 6px; }
.wf-card { border: 1px solid #bcd; border-radius: 6px; padding: 4px 8px; background: #fff; font-size: 13px; cursor: default; }
.wf-card.sel { background: #ffe9a8; border-color: #e0a800; cursor: pointer; }
.wf-card.pick { cursor: pointer; }
.wf-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.wf-actions button { padding: 6px 10px; border-radius: 6px; border: 1px solid #4a80ff; background: #4a80ff; color: #fff; cursor: pointer; font-size: 13px; }
.wf-actions button.ghost { background: #fff; color: #4a80ff; }
.wf-actions button:disabled { opacity: 0.5; cursor: default; }
.wf-log { font-size: 12px; color: #667; max-height: 110px; overflow-y: auto; border-top: 1px solid #eee; padding-top: 6px; }
.wf-mute { align-self: flex-end; background: none; border: none; cursor: pointer; font-size: 18px; }
.wf-lobby-setting { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; font-size: 14px; }
.wf-lobby-setting input { width: 80px; }
.wf-add-bot { margin-left: 6px; }
`;

function countKind(hand: { kind: string }[], kind: string): number {
  return hand.reduce((n, c) => n + (c.kind === kind ? 1 : 0), 0);
}

/** Minimal sell to reach `cost` coins (Treasure 2, Balloon 1, Wild 5), or null. */
function minimalSell(hand: { kind: string }[], cost: number): { balloons: number; treasures: number; wild: number } | null {
  const b = countKind(hand, "balloon");
  const t = countKind(hand, "treasure");
  const w = countKind(hand, "wild");
  let coins = 0, sb = 0, st = 0, sw = 0;
  while (coins < cost && st < t) { st++; coins += 2; }
  while (coins < cost && sb < b) { sb++; coins += 1; }
  if (coins < cost && w > 0) { sw = 1; coins += 5; }
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

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, WaterFightState>;
    this.ctx = ctx;
    root.innerHTML = `<style>${STYLE}</style><div class="wf"></div>`;
    root.addEventListener("click", this.onClick);
    this.room.onStateChange(this.onState);
    hookSaveData(this.room, WF_SAVES_KEY, wfTurnLabel, () => flashToast(root, "Saved ✓"));
    this.render();
  }

  unmount(): void {
    this.room?.onStateChange.remove(this.onState);
    this.root?.removeEventListener("click", this.onClick);
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
      case "end":
        room.send(WaterFightMsg.MOVE, { kind: "END_TURN" });
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
      return;
    }
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
      this.renderSeats(state, seats, mySeat),
      this.renderDecks(state),
      this.renderHand(state, seats, mySeat, myMoment),
      myMoment ? `<div class="wf-actions">${this.renderActions(state, seats, mySeat)}</div>` : "",
      this.renderLog(state),
    ].join("");
  }

  private momentLabel(state: WaterFightState): string {
    switch (state.awaitingKind) {
      case "MOVE": return "Your turn!";
      case "DEFEND": return "Defend!";
      case "ATTACKER_RESPOND": return "Push your attack?";
      case "REACT": return "React!";
      case "EXTRA_THROW": return "Throw again?";
      case "DISCARD": return "Discard down";
      default: return "Your move";
    }
  }

  private renderBanner(state: WaterFightState, mySeat: number, myMoment: boolean): string {
    const sudden = state.suddenDeath ? `<div class="wf-banner sudden">⚡ SUDDEN-DEATH — single-target hits only</div>` : "";
    let msg: string;
    if (myMoment) msg = this.momentLabel(state);
    else {
      const who = [...state.seats].find((s) => s.seat === (state.awaitingSeats[0] ?? state.turnSeat));
      const verb = state.awaitingKind === "MOVE" ? "is choosing" : "is reacting";
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
        return `<span class="${cls.join(" ")}" ${attr}>${CARD_LABELS[c.kind] ?? c.kind}</span>`;
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
        for (const sup of UNTARGETED_SUPPORTS) {
          if (has(sup)) out.push(btn("support", SUPPORT_LABELS[sup] ?? sup, `data-support="${sup}"`, true));
        }
        for (const sup of TARGETED_SUPPORTS) {
          if (has(sup)) for (const t of opponents) out.push(btn("support", `${SUPPORT_LABELS[sup] ?? sup} → ${escapeHtml(t.nickname)}`, `data-support="${sup}" data-target="${t.seat}"`, true));
        }
        if (!me.noShop) {
          const sell = minimalSell(hand, state.shopCost);
          if (sell) {
            const stacks: [string, number][] = [["defense", 0], ["mischief", 1], ["attack", 2]];
            for (const [name, idx] of stacks) {
              if ((state.stackCounts[idx] ?? 0) > 0) {
                out.push(btn("shop", `🛒 Buy ${name}`, `data-stack="${name}" data-sell='${JSON.stringify(sell)}'`, true));
              }
            }
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
  const rows = WF_SETTINGS.map((s) => {
    const value = (state as Record<string, number>)[s.key] ?? s.default;
    const disabled = ctx.isHost ? "" : "disabled";
    return `<label class="wf-lobby-setting" title="${escapeHtml(s.hint)}">
      <span>${escapeHtml(s.label)}</span>
      <input type="number" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${value}" ${disabled}>
    </label>`;
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
  container.querySelectorAll<HTMLInputElement>("input[data-key]").forEach((input) => {
    input.addEventListener("change", () => {
      room.send(WaterFightMsg.CONFIG, { key: input.dataset.key, value: Number(input.value) });
    });
  });
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
