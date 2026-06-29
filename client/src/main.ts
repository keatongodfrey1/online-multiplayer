/**
 * Client entry point.
 * Boot order: try to resume a stored session (page refresh / phone coming
 * back) -> otherwise show the home screen. Once in a room, RoomScreen owns
 * the UI until the player leaves.
 */
import type { Room } from "@colyseus/sdk";
import type { BaseState } from "@backbone/shared";
import { GameClient, friendlyJoinError } from "./framework/GameClient.js";
import { clearSession } from "./framework/session.js";
import { installWakeUpHandler } from "./framework/wakeUp.js";
import { getGame } from "./games/registry.js";
import { HomeScreen } from "./lobby/HomeScreen.js";
import { RoomScreen } from "./lobby/RoomScreen.js";
import "./style.css";

const app = document.getElementById("app")!;
const client = new GameClient();

/** The room currently on screen (for the slept-tablet wake-up check). */
let currentRoom: Room<any, BaseState> | undefined;
installWakeUpHandler(() => currentRoom);

function showHome(notice?: string, prefillCode?: string): void {
  const home = new HomeScreen({
    async onCreate(gameType, nickname) {
      try {
        const room = await client.create(gameType, nickname);
        enterRoom(room, gameType);
      } catch (error) {
        throw new Error(friendlyJoinError(error));
      }
    },
    async onJoin(code, nickname) {
      try {
        const room = await client.join(code, nickname);
        enterRoom(room, room.name);
      } catch (error) {
        throw new Error(friendlyJoinError(error));
      }
    },
  });
  home.mount(app, notice, prefillCode);
}

/**
 * Read a one-tap invite code from the URL (?code=XXXX), normalise it to the
 * 4-letter room-code shape, and strip the param from the address bar so it is
 * consumed exactly once (a later refresh resumes the live session instead).
 * Returns "" when absent or unusable.
 */
function takeInviteCode(): string {
  const params = new URLSearchParams(location.search);
  if (!params.has("code")) return "";
  const code = (params.get("code") ?? "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);
  params.delete("code");
  const qs = params.toString();
  history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
  return code;
}

function enterRoom(room: Room<any, BaseState>, gameType: string): void {
  const game = getGame(gameType);
  if (!game) {
    // Unknown game (e.g. stale client build): bail out gracefully.
    void room.leave(true);
    clearSession();
    showHome("That game type is not available in this client.");
    return;
  }
  currentRoom = room;
  const screen = new RoomScreen(room, game, {
    onExit(notice) {
      currentRoom = undefined;
      clearSession();
      showHome(notice);
    },
  });
  screen.mount(app);
}

async function boot(): Promise<void> {
  app.innerHTML = `<div class="center muted boot">Connecting&hellip;</div>`;
  // Consume + strip any invite ?code= up front: a refresh resumes the live session,
  // so the param must never re-trigger a join. Resume wins over the invite code.
  const inviteCode = takeInviteCode();
  const resumed = await client.tryResume();
  if (resumed) {
    enterRoom(resumed.room, resumed.gameType);
  } else {
    showHome(undefined, inviteCode || undefined);
  }
}

void boot();
