/**
 * Device-side session persistence so a page refresh (or phone returning
 * from the lock screen) can resume the same seat in the same game.
 *
 * Stored after every successful create/join/reconnect; cleared when the
 * player leaves on purpose or the session is no longer valid.
 */

const SESSION_KEY = "backbone:session";
const NICKNAME_KEY = "backbone:nickname";

export interface StoredSession {
  reconnectionToken: string;
  code: string;
  gameType: string;
  nickname: string;
}

export function saveSession(session: StoredSession): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private browsing modes can block storage; resume just won't work.
  }
}

export function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.reconnectionToken || !parsed.code || !parsed.gameType) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Remember the last nickname for convenience (pre-fills the forms). */
export function saveNickname(nickname: string): void {
  try {
    localStorage.setItem(NICKNAME_KEY, nickname);
  } catch {
    /* ignore */
  }
}

export function loadNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? "";
  } catch {
    return "";
  }
}
