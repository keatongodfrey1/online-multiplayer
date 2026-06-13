/**
 * Save slots, shared by every game that opts into save/resume.
 *
 * The blob lives in the HOST's browser (localStorage), keyed per game. The
 * server validates it on the way back in (see each game's save.ts); nothing
 * here is trusted. A game wires this up with three calls:
 *   - a Save button that does `room.send(LobbyMsg.SAVE, {})`;
 *   - `hookSaveData(room, key, turnLabelOf, onStored)` once in mount();
 *   - `renderSaveSlots(container, room, { key, isHost, loadedSave, turnLabelOf })`
 *     in its lobby settings.
 * `turnLabelOf(blob)` returns the 1-based turn number for the slot label (the
 * one blob-shape difference between games stays in the game).
 */
import type { Room } from "@colyseus/sdk";
import { LobbyMsg, ServerMsg } from "@backbone/shared";
import { escapeHtml } from "./dom.js";

const MAX_SAVE_SLOTS = 12;

export interface SaveSlot {
  id: string;
  label: string;
  savedAt: number;
  save: unknown;
}

export function loadSaveSlots(key: string): SaveSlot[] {
  try {
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as SaveSlot[]) : [];
  } catch {
    return [];
  }
}

export function writeSaveSlots(key: string, slots: SaveSlot[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(slots.slice(0, MAX_SAVE_SLOTS)));
  } catch {
    // storage full/blocked - the Save button just won't confirm
  }
}

function slotLabel(save: unknown, turnLabelOf: (blob: any) => number): string {
  const blob = save as { seats?: { nickname?: string }[] } | null;
  const names = (blob?.seats ?? []).map((s) => s?.nickname ?? "?").join(", ");
  return `${names} — turn ${turnLabelOf(blob)}`;
}

function storeSaveSlot(key: string, save: unknown, turnLabelOf: (blob: any) => number): void {
  const slots = loadSaveSlots(key);
  slots.unshift({
    id: `${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    label: slotLabel(save, turnLabelOf),
    savedAt: Date.now(),
    save,
  });
  writeSaveSlots(key, slots);
}

/**
 * Register the once-per-room SAVE_DATA handler (message handlers can't be
 * removed and a rematch mounts a fresh view on the same room, so guard it).
 * Stores each snapshot the host requests and calls `onStored` (e.g. flash a
 * "Saved" label).
 */
export function hookSaveData(
  room: Room<any, any>,
  key: string,
  turnLabelOf: (blob: any) => number,
  onStored: () => void,
): void {
  const hooked = room as unknown as { __fwSaveHooked?: boolean };
  if (hooked.__fwSaveHooked) return;
  hooked.__fwSaveHooked = true;
  room.onMessage(ServerMsg.SAVE_DATA, (save: unknown) => {
    storeSaveSlot(key, save, turnLabelOf);
    onStored();
  });
}

export interface SaveSlotsOptions {
  key: string;
  isHost: boolean;
  /** The framework's resume banner text (BaseState.loadedSave); "" when none. */
  loadedSave: string;
}

/**
 * Render the lobby saved-games block into `container`: the "resuming…" banner
 * while a save is staged, otherwise (host only) the list of local slots with
 * Resume / Delete. Re-renders itself in place after a delete.
 */
export function renderSaveSlots(container: HTMLElement, room: Room<any, any>, opts: SaveSlotsOptions): void {
  const { key, isHost, loadedSave } = opts;
  if (loadedSave) {
    container.innerHTML = `
      <div class="fw-loaded-save">
        <span class="badge warn">${escapeHtml(loadedSave)}</span>
        ${isHost ? '<button class="subtle fw-load-clear">Cancel</button>' : ""}
      </div>`;
    container.querySelector<HTMLButtonElement>(".fw-load-clear")?.addEventListener("click", () => {
      room.send(LobbyMsg.LOAD, null);
    });
    return;
  }
  if (!isHost) {
    container.innerHTML = "";
    return;
  }
  const slots = loadSaveSlots(key);
  if (slots.length === 0) {
    container.innerHTML = "";
    return;
  }
  const rows = slots
    .map(
      (slot) => `
      <li class="fw-save-slot">
        <span>${escapeHtml(slot.label)} <span class="muted">· ${new Date(slot.savedAt).toLocaleString()}</span></span>
        <span>
          <button class="fw-load-slot" data-save-id="${escapeHtml(slot.id)}">Resume</button>
          <button class="subtle fw-delete-slot" data-save-id="${escapeHtml(slot.id)}">Delete</button>
        </span>
      </li>`,
    )
    .join("");
  container.innerHTML = `<details class="fw-saves"><summary>Saved games (${slots.length})</summary><ul>${rows}</ul></details>`;
  container.querySelectorAll<HTMLButtonElement>(".fw-load-slot").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slot = loadSaveSlots(key).find((s) => s.id === btn.dataset.saveId);
      if (slot) room.send(LobbyMsg.LOAD, slot.save);
    });
  });
  container.querySelectorAll<HTMLButtonElement>(".fw-delete-slot").forEach((btn) => {
    btn.addEventListener("click", () => {
      writeSaveSlots(key, loadSaveSlots(key).filter((s) => s.id !== btn.dataset.saveId));
      renderSaveSlots(container, room, opts); // re-render in place
    });
  });
}
