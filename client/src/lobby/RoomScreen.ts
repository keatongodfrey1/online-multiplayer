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
import { escapeHtml } from "./HomeScreen.js";

export interface RoomScreenHandlers {
  /** Player chose to leave (or was kicked / room closed). */
  onExit(notice?: string): void;
}

export class RoomScreen {
  private root?: HTMLElement;
  private view?: GameView;
  private mountedPhase = "";
  private kicked = false;

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
      void this.room.leave(true);
    });

    this.room.onStateChange(() => this.render());

    this.room.onDrop(() => this.setOverlay(true));
    this.room.onReconnect(() => {
      this.setOverlay(false);
      this.render();
    });

    this.room.onMessage(ServerMsg.KICKED, () => {
      this.kicked = true;
    });

    this.room.onLeave(() => {
      this.teardownView();
      this.handlers.onExit(
        this.kicked ? "You were removed from the game by the host." : undefined
      );
    });

    this.render();
  }

  /** Full re-render of the phase area; cheap at lobby scale. */
  private render(): void {
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

    phaseRoot.innerHTML = `
      <div class="card">
        <h2>Lobby <span class="muted">(${players.length}/${state.maxPlayers} players)</span></h2>
        <p class="muted">Friends join at this address with code
           <strong>${escapeHtml(state.roomCode)}</strong></p>
        <ul class="roster">
          ${players
            .map(
              (p) => `
            <li class="${p.connected ? "" : "disconnected"}">
              <span class="dot ${p.connected ? "on" : "off"}"></span>
              ${escapeHtml(p.nickname)}
              ${p.isHost ? '<span class="badge">host</span>' : ""}
              ${!p.connected ? '<span class="badge warn">reconnecting</span>' : ""}
              ${
                isHost && p.sessionId !== this.room.sessionId
                  ? `<button class="kick subtle" data-session="${escapeHtml(p.sessionId)}">kick</button>`
                  : ""
              }
            </li>`
            )
            .join("")}
        </ul>
        ${
          isHost
            ? `<button id="start-btn" class="primary" ${enough ? "" : "disabled"}>
                 ${enough ? "Start game" : `Waiting for players (need ${state.minPlayers})`}
               </button>`
            : `<p class="muted">Waiting for the host to start&hellip;</p>`
        }
      </div>
    `;

    phaseRoot.querySelector<HTMLButtonElement>("#start-btn")?.addEventListener("click", () => {
      this.room.send(LobbyMsg.START, {});
    });
    phaseRoot.querySelectorAll<HTMLButtonElement>(".kick").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.room.send(LobbyMsg.KICK, { sessionId: btn.dataset.session });
      });
    });
  }

  private renderEnded(phaseRoot: HTMLElement): void {
    const state = this.room.state;
    const players = this.sortedPlayers();
    const votes = players.filter((p) => p.wantsRematch).length;
    const iVoted = !!state.players.get(this.room.sessionId)?.wantsRematch;

    phaseRoot.innerHTML = `
      <div class="card center">
        <h2>${escapeHtml(this.endReasonText())}</h2>
        <button id="rematch-btn" class="primary" ${iVoted ? "disabled" : ""}>
          ${iVoted ? "Waiting for the others…" : "Play again"}
        </button>
        <p class="muted">${votes}/${players.length} want a rematch</p>
      </div>
    `;
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
    this.view?.unmount();
    this.view = undefined;
  }
}
