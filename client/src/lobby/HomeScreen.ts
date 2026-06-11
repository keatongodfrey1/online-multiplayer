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

  mount(root: HTMLElement, notice?: string): void {
    this.root = root;
    const lastNickname = loadNickname();
    root.innerHTML = `
      <div class="home">
        <h1 class="title">Game Night</h1>
        ${notice ? `<div class="notice">${escapeHtml(notice)}</div>` : ""}
        <div class="card">
          <h2>Join a game</h2>
          <form id="join-form">
            <input id="join-code" name="code" placeholder="CODE" maxlength="4"
                   autocomplete="off" autocapitalize="characters" spellcheck="false" />
            <input id="join-nickname" name="nickname" placeholder="Your name"
                   maxlength="${NICKNAME_MAX_LENGTH}" autocomplete="off"
                   value="${escapeAttr(lastNickname)}" />
            <button type="submit" class="primary">Join</button>
          </form>
        </div>
        <div class="card">
          <h2>Start a new game</h2>
          <form id="create-form">
            <select id="create-game">
              ${games
                .map(
                  (g) =>
                    `<option value="${escapeAttr(g.gameType)}">${escapeHtml(g.displayName)} - ${escapeHtml(g.description)}</option>`
                )
                .join("")}
            </select>
            <input id="create-nickname" name="nickname" placeholder="Your name"
                   maxlength="${NICKNAME_MAX_LENGTH}" autocomplete="off"
                   value="${escapeAttr(lastNickname)}" />
            <button type="submit" class="primary">Create</button>
          </form>
        </div>
        <div id="home-error" class="error" hidden></div>
      </div>
    `;

    const joinForm = root.querySelector<HTMLFormElement>("#join-form")!;
    const createForm = root.querySelector<HTMLFormElement>("#create-form")!;
    const codeInput = root.querySelector<HTMLInputElement>("#join-code")!;
    codeInput.addEventListener("input", () => {
      codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, "");
    });

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
