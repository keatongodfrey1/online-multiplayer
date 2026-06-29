/**
 * Home screen: create a game (pick from the registry) or join one with a
 * 4-letter code. Calls back into main.ts with the connected room.
 */
import { NICKNAME_MAX_LENGTH } from "@backbone/shared";
import { games } from "../games/registry.js";
import { loadNickname } from "../framework/session.js";

export interface HomeScreenHandlers {
  onCreate(gameType: string, nickname: string): Promise<void>;
  onJoin(code: string, nickname: string): Promise<void>;
}

export class HomeScreen {
  private root?: HTMLElement;

  constructor(private handlers: HomeScreenHandlers) {}

  mount(root: HTMLElement, notice?: string, prefillCode?: string): void {
    this.root = root;
    const lastNickname = loadNickname();
    root.innerHTML = `
      <div class="home">
        <div class="home-brand">
          <div class="home-title">🎮 Game Night</div>
          <div class="home-tagline">Play together on any device — phone, tablet, laptop.</div>
        </div>
        ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
        <div class="card home-card">
          <h2>Join a friend's game</h2>
          <form id="join-form">
            <label class="home-label" for="join-code">Game code</label>
            <input id="join-code" name="code" class="home-code" placeholder="CODE" maxlength="4"
                   autocomplete="off" autocapitalize="characters" spellcheck="false" />
            <label class="home-label" for="join-nickname">Your name</label>
            <input id="join-nickname" name="nickname" placeholder="e.g. Keaton"
                   maxlength="${NICKNAME_MAX_LENGTH}" autocomplete="off"
                   value="${escapeAttr(lastNickname)}" />
            <button type="submit" class="primary">Join game</button>
          </form>
        </div>
        <div class="home-or">or</div>
        <div class="card home-card">
          <h2>Start a new game</h2>
          <form id="create-form">
            <label class="home-label" for="create-game">Pick a game</label>
            <select id="create-game">
              ${games
                .map(
                  (g) =>
                    `<option value="${escapeAttr(g.gameType)}">${escapeHtml(g.displayName)} — ${escapeHtml(g.description)}</option>`
                )
                .join("")}
            </select>
            <label class="home-label" for="create-nickname">Your name</label>
            <input id="create-nickname" name="nickname" placeholder="e.g. Keaton"
                   maxlength="${NICKNAME_MAX_LENGTH}" autocomplete="off"
                   value="${escapeAttr(lastNickname)}" />
            <button type="submit" class="primary">Create game</button>
          </form>
        </div>
        <div id="home-error" class="error" hidden></div>
        <div class="home-foot">You'll get a 4-letter code to share with friends.</div>
      </div>
    `;

    const joinForm = root.querySelector<HTMLFormElement>("#join-form")!;
    const createForm = root.querySelector<HTMLFormElement>("#create-form")!;
    const codeInput = root.querySelector<HTMLInputElement>("#join-code")!;
    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, "");
    });

    // Opened via an invite deep link (?code=XXXX): pre-fill the code and focus the
    // name field so a returning player can join in one tap. Never auto-submit.
    if (prefillCode) {
      codeInput.value = prefillCode;
      root.querySelector<HTMLInputElement>("#join-nickname")!.focus();
    }

    joinForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const nickname = root.querySelector<HTMLInputElement>("#join-nickname")!.value.trim();
      await this.busy(joinForm, () => this.handlers.onJoin(codeInput.value, nickname));
    });

    createForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const gameType = root.querySelector<HTMLSelectElement>("#create-game")!.value;
      const nickname = root.querySelector<HTMLInputElement>("#create-nickname")!.value.trim();
      await this.busy(createForm, () => this.handlers.onCreate(gameType, nickname));
    });
  }

  showError(message: string): void {
    const el = this.root?.querySelector<HTMLElement>("#home-error");
    if (el) {
      el.textContent = message;
      el.hidden = false;
    }
  }

  private async busy(form: HTMLFormElement, action: () => Promise<void>): Promise<void> {
    const button = form.querySelector("button")!;
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      this.showError((error as Error).message || "Something went wrong.");
    } finally {
      button.disabled = false;
    }
  }
}

export function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

export function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}
