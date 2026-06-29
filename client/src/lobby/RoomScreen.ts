/**
 * Room screen - the generic chrome around every game:
 *  - header with the share code and a leave button
 *  - lobby: live roster, host start/kick controls
 *  - playing: hands the #game-root element to the game's view
 *  - ended: result banner + rematch votes
 *  - "Reconnecting..." overlay during connection drops
 *
 * All of it renders from BaseState, so it works for every game.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BasePlayer,
  type BaseState,
  EndReason,
  LobbyMsg,
  Phase,
  ServerMsg,
} from "@backbone/shared";
import type { GameDefinition, GameView } from "../framework/GameView.js";
import { closeInfoPopover } from "../framework/infoPopover.js";
import { escapeAttr, escapeHtml } from "./HomeScreen.js";

export interface RoomScreenHandlers {
  /** Player chose to leave (or was kicked / room closed). */
  onExit(notice?: string): void;
}

/** Avatar background colours, picked by seat so a player's colour is stable. */
const AVATAR_PALETTE = ["#5b8cff", "#e3b341", "#41c98a", "#e35d6a", "#a98bff", "#3fb6c9"];

export class RoomScreen {
  private root?: HTMLElement;
  private view?: GameView;
  private mountedPhase = "";
  private leaving = false;

  constructor(
    private room: Room<any, BaseState>,
    private game: GameDefinition,
    private handlers: RoomScreenHandlers
  ) {}

  mount(root: HTMLElement): void {
    this.root = root;
    root.innerHTML = `
      <div class="room">
        <header class="room-header">
          <div>
            <span class="game-name">${escapeHtml(this.game.displayName)}</span>
            <span class="room-code" title="Share this code">${escapeHtml(this.room.roomId)}</span>
          </div>
          <button id="leave-btn" class="subtle">Leave</button>
        </header>
        <div id="phase-root"></div>
        <div id="reconnect-overlay" class="overlay" hidden>
          <div class="overlay-box">Reconnecting&hellip;</div>
        </div>
      </div>
    `;

    root.querySelector<HTMLButtonElement>("#leave-btn")!.addEventListener("click", () => {
      if (this.room.state.phase === Phase.PLAYING) {
        if (!confirm("Leave the game? Your seat will be given up.")) return;
      }
      this.exitToHome();
    });

    this.room.onStateChange(() => this.render());

    // A genuine connection drop shows the overlay - unless we are deliberately
    // leaving, in which case we are already on our way home.
    this.room.onDrop(() => {
      if (!this.leaving) this.setOverlay(true);
    });
    this.room.onReconnect(() => {
      this.setOverlay(false);
      this.render();
    });

    // Kicked by the host. The KICKED message is reliable, but the socket close
    // that follows is not: hosting proxies can turn the server's clean close
    // into an abnormal one, which the SDK would treat as a dropped connection
    // ("Reconnecting..."). So act on the message and head home now.
    this.room.onMessage(ServerMsg.KICKED, () =>
      this.exitToHome("You were removed from the game by the host.")
    );

    this.room.onLeave(() => this.exitToHome());

    this.render();
  }

  /**
   * Leave the room and return to the home screen - from the Leave button, a
   * kick, or the server closing the connection. We go home on the user's
   * INTENT rather than waiting for the socket to close, because hosting proxies
   * can mangle the server's clean "consented" close into an abnormal one; the
   * SDK would then treat a deliberate leave as a dropped connection and show
   * "Reconnecting...". Disabling reconnection also stops the SDK retrying a
   * room we are done with (and lets the eventual close resolve as a clean
   * leave, which tears the connection down). Idempotent.
   */
  private exitToHome(notice?: string): void {
    if (this.leaving) return;
    this.leaving = true;
    this.room.reconnection.enabled = false;
    void this.room.leave(true);
    this.teardownView();
    this.handlers.onExit(notice);
  }

  /** Full re-render of the phase area; cheap at lobby scale. */
  private render(): void {
    // The ⓘ hint popover lives on document.body and anchors to a lobby button
    // that this re-render is about to destroy. Close it first so it can't orphan.
    closeInfoPopover();
    if (!this.root) return;
    const state = this.room.state;
    if (!state || !state.players) return; // first state not arrived yet
    const phaseRoot = this.root.querySelector<HTMLElement>("#phase-root")!;

    if (state.phase === Phase.PLAYING) {
      if (this.mountedPhase !== Phase.PLAYING) {
        this.mountedPhase = Phase.PLAYING;
        this.teardownView();
        phaseRoot.innerHTML = `<div id="game-root"></div><div id="status-bar"></div>`;
        this.view = this.game.createView();
        this.view.mount(phaseRoot.querySelector<HTMLElement>("#game-root")!, this.room, {
          mySessionId: this.room.sessionId,
        });
      }
      this.renderStatusBar();
      return;
    }

    this.mountedPhase = state.phase;
    this.teardownView();
    if (state.phase === Phase.LOBBY) {
      this.renderLobby(phaseRoot);
    } else if (state.phase === Phase.ENDED) {
      this.renderEnded(phaseRoot);
    }
  }

  private renderLobby(phaseRoot: HTMLElement): void {
    const state = this.room.state;
    const me = state.players.get(this.room.sessionId);
    const isHost = !!me?.isHost;
    const players = this.sortedPlayers();
    const enough = players.length >= state.minPlayers;
    // Only games that ship a settings renderer get a "Game setup" card; without
    // this guard TicTacToe / Dot Arena would show an empty titled box.
    const hasSettings = typeof this.game.renderLobbySettings === "function";

    phaseRoot.innerHTML = `
      <div class="lobby-screen">
        <div class="lobby-card lobby-invite">
          <div class="lobby-invite-text">
            <div class="lobby-invite-h">Invite your friends 💌</div>
            <div class="lobby-invite-s">They open the same web address and type this code to join.</div>
          </div>
          <div class="codepill">
            <div class="lobby-code">${escapeHtml(state.roomCode)}</div>
            <button id="copy-link" type="button" class="lobby-copy">📋 Copy link</button>
          </div>
        </div>

        <div class="lobby-card">
          <div class="lobby-section-label">
            <span>Players</span><span>${players.length} / ${state.maxPlayers}</span>
          </div>
          <div class="lobby-players">
            ${players.map((p) => this.playerRow(p, isHost)).join("")}
          </div>
        </div>

        ${
          hasSettings
            ? `<div class="lobby-card">
                 <div class="lobby-section-label">
                   <span>Game setup</span><span>${isHost ? "host sets the dials" : ""}</span>
                 </div>
                 <div id="lobby-settings"></div>
               </div>`
            : ""
        }

        ${
          isHost
            ? `<button id="start-btn" class="lobby-start" ${enough ? "" : "disabled"}>
                 ${enough ? "▶  Start game" : `Waiting for players (need ${state.minPlayers})`}
               </button>`
            : `<p class="lobby-wait">Waiting for the host to start&hellip;</p>`
        }
      </div>
    `;

    if (hasSettings) {
      const settingsEl = phaseRoot.querySelector<HTMLElement>("#lobby-settings");
      if (settingsEl) {
        this.game.renderLobbySettings!(settingsEl, this.room, {
          mySessionId: this.room.sessionId,
          isHost,
        });
      }
    }

    phaseRoot.querySelector<HTMLButtonElement>("#copy-link")?.addEventListener("click", (e) => {
      void this.copyInviteLink(e.currentTarget as HTMLButtonElement, state.roomCode);
    });
    phaseRoot.querySelector<HTMLButtonElement>("#start-btn")?.addEventListener("click", () => {
      this.room.send(LobbyMsg.START, {});
    });
    phaseRoot.querySelectorAll<HTMLButtonElement>(".kick").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.room.send(LobbyMsg.KICK, { sessionId: btn.dataset.session });
      });
    });
  }

  /** One roster row: colour avatar + name + YOU/HOST/AI/reconnecting badges + kick. */
  private playerRow(p: BasePlayer, isHost: boolean): string {
    const me = p.sessionId === this.room.sessionId;
    const color = AVATAR_PALETTE[p.seat % AVATAR_PALETTE.length];
    const nm = (p.nickname ?? "").trim();
    const initial = escapeHtml((nm.charAt(0) || "?").toUpperCase());
    const badges =
      (me ? `<span class="lobby-badge lobby-badge-you">YOU</span>` : "") +
      (p.isHost ? `<span class="lobby-badge lobby-badge-host">HOST</span>` : "") +
      (p.isBot ? `<span class="lobby-badge lobby-badge-ai">🤖 AI</span>` : "") +
      (!p.connected ? `<span class="lobby-badge lobby-badge-warn">reconnecting&hellip;</span>` : "");
    const kick =
      isHost && !me
        ? `<button class="kick" data-session="${escapeAttr(p.sessionId)}" aria-label="Remove ${escapeAttr(nm)}">Kick</button>`
        : "";
    return `<div class="lobby-player${p.connected ? "" : " lobby-player--off"}">
      <div class="lobby-avatar" style="background:${color}">${initial}</div>
      <span class="lobby-player-name">${escapeHtml(nm)}</span>
      ${badges}
      ${kick}
    </div>`;
  }

  /**
   * Copy a one-tap join link for this room. The link points at the CLIENT origin
   * (where this app is served) so opening it pre-fills the join code. Clipboard
   * is blocked in insecure contexts (a LAN http dev server), so fall back to the
   * iOS share sheet, then to a read-the-code-aloud prompt (the code is on screen).
   */
  private async copyInviteLink(btn: HTMLButtonElement, code: string): Promise<void> {
    const url = `${location.origin}${location.pathname}?code=${encodeURIComponent(code)}`;
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch {
      /* clipboard unavailable — try the share sheet below */
    }
    if (!ok && typeof navigator.share === "function") {
      try {
        await navigator.share({ text: url });
        ok = true;
      } catch {
        /* user dismissed the share sheet */
      }
    }
    btn.textContent = ok ? "Copied ✓" : "Couldn't copy — read the code aloud";
    setTimeout(() => {
      if (btn.isConnected) btn.textContent = "📋 Copy link";
    }, 2200);
  }

  private renderEnded(phaseRoot: HTMLElement): void {
    const state = this.room.state;
    const players = this.sortedPlayers();
    const votes = players.filter((p) => p.wantsRematch).length;
    const iVoted = !!state.players.get(this.room.sessionId)?.wantsRematch;

    const reason = state.endReason;
    const icon = reason.startsWith(EndReason.WIN_PREFIX)
      ? "🏆"
      : reason === EndReason.DRAW
        ? "🤝"
        : "🏁";

    phaseRoot.innerHTML = `
      <div class="lobby-screen results-screen">
        <div class="lobby-card results-card">
          <div class="results-trophy">${icon}</div>
          <h2 class="results-title">${escapeHtml(this.endReasonText())}</h2>
          <div id="game-summary"></div>
          <button id="rematch-btn" class="lobby-start" ${iVoted ? "disabled" : ""}>
            ${iVoted ? "Waiting for the others&hellip;" : "▶  Play again"}
          </button>
          <p class="results-votes">${votes}/${players.length} want a rematch</p>
        </div>
      </div>
    `;
    this.game.renderGameSummary?.(
      phaseRoot.querySelector<HTMLElement>("#game-summary")!,
      this.room,
      { mySessionId: this.room.sessionId }
    );
    phaseRoot.querySelector<HTMLButtonElement>("#rematch-btn")?.addEventListener("click", () => {
      this.room.send(LobbyMsg.REMATCH, {});
    });
  }

  /** Connection badges shown under the game while playing. */
  private renderStatusBar(): void {
    const bar = this.root?.querySelector<HTMLElement>("#status-bar");
    if (!bar) return;
    const away = this.sortedPlayers().filter((p) => !p.connected);
    bar.innerHTML = away.length
      ? away
          .map(
            (p) => `<span class="badge warn">${escapeHtml(p.nickname)} reconnecting&hellip;</span>`
          )
          .join(" ")
      : "";
  }

  private endReasonText(): string {
    const reason = this.room.state.endReason;
    if (reason.startsWith(EndReason.WIN_PREFIX)) {
      const seat = Number(reason.slice(EndReason.WIN_PREFIX.length));
      const winner = this.sortedPlayers().find((p) => p.seat === seat);
      return winner ? `${winner.nickname} wins!` : "Game over";
    }
    if (reason === EndReason.DRAW) return "It's a draw!";
    if (reason === EndReason.ABANDONED) return "Game over - not enough players left.";
    return "Game over";
  }

  private sortedPlayers(): BasePlayer[] {
    const players: BasePlayer[] = [];
    this.room.state.players.forEach((p: BasePlayer) => players.push(p));
    return players.sort((a, b) => a.seat - b.seat);
  }

  private setOverlay(visible: boolean): void {
    const overlay = this.root?.querySelector<HTMLElement>("#reconnect-overlay");
    if (overlay) overlay.hidden = !visible;
  }

  private teardownView(): void {
    // Covers phase changes (LOBBY→PLAYING) and leaving: drop any open hint popover
    // so it can't linger over the game or the home screen.
    closeInfoPopover();
    this.view?.unmount();
    this.view = undefined;
  }
}
