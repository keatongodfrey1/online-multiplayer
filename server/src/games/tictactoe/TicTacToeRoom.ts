/**
 * Tic-Tac-Toe room - the reference example for turn-based games.
 * Demonstrates: TurnManager (with timeout + disconnect pausing),
 * server-side move validation, win/draw detection, rematch.
 */
import type { Client } from "colyseus";
import {
  type BasePlayer,
  EndReason,
  Phase,
  TICTACTOE,
  TicTacToeMsg,
  type TicTacToeMovePayload,
  TicTacToePlayer,
  TicTacToeState,
  TTT_LINES,
  TTT_TURN_SECONDS,
} from "@backbone/shared";
import { BaseGameRoom } from "../../framework/BaseGameRoom.js";
import { TurnManager } from "../../framework/TurnManager.js";

export class TicTacToeRoom extends BaseGameRoom<TicTacToeState> {
  state = new TicTacToeState();
  readonly minPlayers = 2;
  readonly maxPlayers = 2;

  private turns = new TurnManager(this, {
    turnSeconds: TTT_TURN_SECONDS,
    onTurnChange: (sessionId) => {
      this.state.currentTurn = sessionId;
    },
    // Taking too long simply skips the turn.
    onTimeout: () => this.turns.next(),
  });

  protected createPlayer(): TicTacToePlayer {
    return new TicTacToePlayer();
  }

  protected override onRoomCreate(): void {
    this.onMessage(TicTacToeMsg.MOVE, (client, payload: TicTacToeMovePayload) =>
      this.handleMove(client, payload)
    );
  }

  protected onGameStart(): void {
    // Full re-init - this also runs on rematch.
    for (let i = 0; i < 9; i++) this.state.board[i] = 0;
    const order = [...this.state.players.values()]
      .sort((a, b) => a.seat - b.seat)
      .map((p) => p.sessionId);
    this.turns.start(order);
  }

  private handleMove(client: Client, payload: TicTacToeMovePayload): void {
    if (this.state.phase !== Phase.PLAYING) return;
    if (!this.turns.isTurn(client.sessionId)) return;
    const cell = payload?.cell;
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) return;
    if (this.state.board[cell] !== 0) return;

    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    this.state.board[cell] = player.seat + 1;

    const mark = player.seat + 1;
    if (TTT_LINES.some((line) => line.every((i) => this.state.board[i] === mark))) {
      this.endGame(this.winBySeat(player.seat));
      return;
    }
    if ([...this.state.board].every((v) => v !== 0)) {
      this.endGame(EndReason.DRAW);
      return;
    }
    this.turns.next();
  }

  // Pause the turn clock while the current player is disconnected.
  protected override onPlayerDropped(player: BasePlayer): void {
    if (this.turns.current() === player.sessionId) this.turns.pause();
  }

  protected override onPlayerReconnected(player: BasePlayer): void {
    if (this.turns.current() === player.sessionId) this.turns.resume();
  }

  protected override onPlayerLeftForGood(player: BasePlayer): void {
    this.turns.remove(player.sessionId);
  }

  protected override onGameEnded(): void {
    this.turns.stop();
    this.state.currentTurn = "";
  }
}

export { TICTACTOE };
