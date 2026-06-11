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
}
