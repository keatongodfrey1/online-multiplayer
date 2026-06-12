/**
 * The interface every game's client view implements. The framework
 * (main.ts) owns the lobby and game-over chrome; the view owns only the
 * in-game UI. mount() is called when phase becomes "playing"; unmount()
 * when the game ends or the player leaves. A rematch mounts a FRESH view.
 */
import type { Room } from "@colyseus/sdk";
import type { BaseState } from "@backbone/shared";

export interface GameViewContext {
  mySessionId: string;
}

export interface GameView {
  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void;
  unmount(): void;
}

export interface LobbySettingsContext {
  mySessionId: string;
  /** Whether this client is the host (only the host's controls should be live). */
  isHost: boolean;
}

/** What a game registers so the framework can list and launch it. */
export interface GameDefinition {
  /** Room name registered on the server (app.config.ts key). */
  gameType: string;
  /** Name shown in the "create a game" menu. */
  displayName: string;
  /** Short description for the create menu. */
  description: string;
  /** Factory - a fresh view per mounted game. */
  createView(): GameView;
  /**
   * Optional game-specific settings UI shown in the lobby (e.g. a turn-timer
   * picker). Called on every lobby re-render with an empty container; read
   * current values from room.state and send changes as game messages (the
   * server validates - host-only, lobby-only). Non-hosts should see the
   * settings read-only.
   */
  renderLobbySettings?(
    container: HTMLElement,
    room: Room<any, BaseState>,
    ctx: LobbySettingsContext
  ): void;
  /**
   * Optional game-over summary rendered on the ended screen, above the
   * rematch button (e.g. a final score table). Called on every ended-phase
   * re-render with an empty container; read from room.state.
   */
  renderGameSummary?(container: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void;
}
