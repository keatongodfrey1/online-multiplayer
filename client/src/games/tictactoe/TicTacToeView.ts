/**
 * Tic-Tac-Toe view - the reference example for turn-based game UIs.
 * Renders from synced state on every patch; sends one message type.
 */
import type { Room } from "@colyseus/sdk";
import {
  type BaseState,
  TicTacToeMsg,
  type TicTacToeState,
} from "@backbone/shared";
import type { GameView, GameViewContext } from "../../framework/GameView.js";
import { escapeHtml } from "../../lobby/HomeScreen.js";

const MARKS = ["", "X", "O"] as const;

export class TicTacToeView implements GameView {
  private root?: HTMLElement;
  private room?: Room<any, TicTacToeState>;
  private ctx?: GameViewContext;
  private readonly onState = () => this.render();

  mount(root: HTMLElement, room: Room<any, BaseState>, ctx: GameViewContext): void {
    this.root = root;
    this.room = room as unknown as Room<any, TicTacToeState>;
    this.ctx = ctx;

    root.innerHTML = `
      <div class="ttt">
        <p id="ttt-status" class="center"></p>
        <div id="ttt-grid" class="ttt-grid"></div>
      </div>
    `;
    const grid = root.querySelector<HTMLElement>("#ttt-grid")!;
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement("button");
      cell.className = "ttt-cell";
      cell.dataset.cell = String(i);
      cell.addEventListener("click", () => {
        this.room?.send(TicTacToeMsg.MOVE, { cell: i });
      });
      grid.appendChild(cell);
    }

    this.room.onStateChange(this.onState);
    this.render();
  }

  unmount(): void {
    this.room?.onStateChange.remove(this.onState);
    this.root = undefined;
    this.room = undefined;
  }

  private render(): void {
    if (!this.root || !this.room || !this.ctx) return;
    const state = this.room.state;
    if (!state?.board) return;

    const myTurn = state.currentTurn === this.ctx.mySessionId;
    const me = state.players.get(this.ctx.mySessionId);
    const turnPlayer = state.players.get(state.currentTurn);

    const status = this.root.querySelector<HTMLElement>("#ttt-status")!;
    const mySymbol = me ? MARKS[me.seat + 1] : "";
    status.innerHTML = myTurn
      ? `Your turn - you are <strong>${mySymbol}</strong>`
      : `Waiting for <strong>${escapeHtml(turnPlayer?.nickname ?? "...")}</strong>`;

    this.root.querySelectorAll<HTMLButtonElement>(".ttt-cell").forEach((cell) => {
      const value = state.board[Number(cell.dataset.cell)] ?? 0;
      cell.textContent = MARKS[value] ?? "";
      cell.disabled = !myTurn || value !== 0;
      cell.classList.toggle("mine", value !== 0 && me !== undefined && value === me.seat + 1);
    });
  }
}
