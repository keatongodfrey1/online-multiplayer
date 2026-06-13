/**
 * Wake-up recovery for slept tablets.
 *
 * When a tablet locks its screen or backgrounds the browser, the OS kills the
 * WebSocket and often freezes the page's timers - so the SDK's in-page retry
 * can be long dead by the time the player comes back. Without this, the page
 * looks alive but the room is gone until someone thinks to pull-to-refresh.
 *
 * On every "we might just have woken up" signal (tab became visible, page
 * restored from the back/forward cache, network came back), check the active
 * room's socket; if it is closed and the SDK is not already retrying, reload
 * the page - boot() then resumes the seat via the stored reconnection token,
 * exactly like a manual refresh.
 */
import type { Room } from "@colyseus/sdk";

let reloading = false;

export function installWakeUpHandler(getRoom: () => Room<any, any> | undefined): void {
  const check = () => {
    if (reloading || document.visibilityState !== "visible") return;
    const room = getRoom();
    if (!room) return; // not in a game (or deliberately left)
    if (!room.reconnection.enabled) return; // leaving on purpose
    if (room.reconnection.isReconnecting) return; // SDK retry already running
    if (room.connection.isOpen) return; // socket healthy (heartbeats cover half-open)
    reloading = true;
    location.reload();
  };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("pageshow", check);
  window.addEventListener("online", check);
}
