/**
 * BaseGameRoom - the multiplayer backbone every game room extends.
 *
 * Handles everything that is the same for every game:
 *  - join-by-code (the roomId is the 4-letter code), private rooms
 *  - nickname validation, seat assignment, host role + host migration
 *  - lobby -> playing -> ended lifecycle, host-only start, kick, rematch
 *  - disconnect grace periods and seat-preserving reconnection
 *  - room disposal + code release
 *
 * A game subclass provides:
 *  - `state = new ItsOwnState()` (extending BaseState)
 *  - minPlayers / maxPlayers (+ optional allowLateJoin, grace periods)
 *  - createPlayer(seat)  - returns its BasePlayer subtype
 *  - onGameStart()       - MUST fully (re)initialize the game; it is also
 *                          called again on rematch.
 *  - its own onMessage handlers for game moves (register in onRoomCreate)
 *
 * See ADDING_A_GAME.md for the full recipe.
 */
import { Room, type Client, CloseCode, ServerError } from "colyseus";
import {
  type BasePlayer,
  type BaseState,
  EndReason,
  JoinError,
  LobbyMsg,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  Phase,
  ServerMsg,
} from "@backbone/shared";
import { generateUniqueRoomCode, releaseRoomCode } from "./roomCodes.js";

/**
 * App-level WebSocket keepalive. The transport's built-in ping/pong is
 * disabled (see app.config.ts) because some proxies - notably Render - drop
 * WebSocket control frames, which makes the server falsely terminate healthy
 * clients. This broadcast is an ordinary data-frame message that proxies do
 * relay, so it keeps the connection from idling out. The "__"-prefixed type
 * is recognised by the client SDK as internal and ignored, so no game or view
 * code has to handle it.
 */
const KEEPALIVE_TYPE = "__keepalive";
const KEEPALIVE_INTERVAL_MS = 15_000;

export abstract class BaseGameRoom<TState extends BaseState = BaseState> extends Room<{
  state: TState;
}> {
  // ---- per-game configuration -------------------------------------------
  abstract readonly minPlayers: number;
  abstract readonly maxPlayers: number;
  /** Allow joining while a game is in progress (e.g. drop-in arena games). */
  allowLateJoin = false;
  /** Seconds a disconnected player's seat is held during a game. */
  reconnectionGraceSeconds = 60;
  /** Seconds a disconnected player's seat is held in the lobby. */
  lobbyGraceSeconds = 30;

  // ---- per-game hooks ----------------------------------------------------
  /** Create this game's player object (a BasePlayer subclass instance). */
  protected abstract createPlayer(seat: number): BasePlayer;
  /**
   * Start (or restart, on rematch) the game. Must fully initialize all
   * game-specific state. Phase is already "playing" when this is called.
   */
  protected abstract onGameStart(): void;
  /** Game-specific room setup (register game message handlers here). */
  protected onRoomCreate(options: unknown): void {}
  /** A player joined while the game is in progress (allowLateJoin only). */
  protected onPlayerJoinedMidGame(player: BasePlayer): void {}
  /** A player disconnected (may still reconnect within the grace period). */
  protected onPlayerDropped(player: BasePlayer): void {}
  /** A dropped player came back. */
  protected onPlayerReconnected(player: BasePlayer): void {}
  /** A player left for good (kicked, quit, or grace period expired). */
  protected onPlayerLeftForGood(player: BasePlayer): void {}
  /**
   * Re-send private data (anything delivered via client.send rather than
   * synced state) to a client that just reconnected. State synced via
   * schema - including StateView-filtered fields - needs no handling here.
   */
  protected syncPrivate(client: Client): void {}

  /** Pending reconnection handles, so a kick can cancel one. */
  private pendingReconnections = new Map<string, { reject: Function }>();

  /** App-level keepalive timer (see KEEPALIVE_TYPE); stopped on dispose. */
  private keepAlive?: ReturnType<typeof setInterval>;

  // ---- lifecycle (final - subclasses use the hooks above) ----------------

  async onCreate(options: unknown) {
    this.roomId = await generateUniqueRoomCode(this.presence);
    this.state.roomCode = this.roomId;
    this.state.minPlayers = this.minPlayers;
    this.state.maxPlayers = this.maxPlayers;
    this.maxClients = this.maxPlayers;
    // Joining is by code only; keep the room out of generic matchmaking.
    await this.setPrivate();
    // A client flooding messages gets disconnected by the transport.
    this.maxMessagesPerSecond = 60;

    this.onMessage(LobbyMsg.START, (client) => this.handleStart(client));
    this.onMessage(LobbyMsg.KICK, (client, payload: { sessionId?: string }) =>
      this.handleKick(client, payload)
    );
    this.onMessage(LobbyMsg.REMATCH, (client) => this.handleRematch(client));

    // Keep clients connected through proxies that drop WS ping/pong frames.
    // unref() so a lingering timer never holds the process open (e.g. tests).
    this.keepAlive = setInterval(
      () => this.broadcast(KEEPALIVE_TYPE),
      KEEPALIVE_INTERVAL_MS
    );
    this.keepAlive.unref?.();

    this.onRoomCreate(options);
  }

  onJoin(client: Client, options?: { nickname?: string }) {
    const nickname = this.validateNickname(options?.nickname);

    if (this.state.phase === Phase.ENDED) {
      throw new ServerError(
        JoinError.GAME_IN_PROGRESS,
        "This game has already finished. Ask the host for a new code."
      );
    }
    const joiningMidGame = this.state.phase === Phase.PLAYING;
    if (joiningMidGame && !this.allowLateJoin) {
      throw new ServerError(
        JoinError.GAME_IN_PROGRESS,
        "This game has already started."
      );
    }
    if (this.state.players.size >= this.maxPlayers) {
      throw new ServerError(JoinError.ROOM_FULL, "This game is full.");
    }
    for (const existing of this.state.players.values()) {
      if (existing.nickname.toLowerCase() === nickname.toLowerCase()) {
        throw new ServerError(
          JoinError.DUPLICATE_NICKNAME,
          `Someone here is already called "${existing.nickname}". Pick another name.`
        );
      }
    }

    const seat = this.lowestFreeSeat();
    const player = this.createPlayer(seat);
    player.sessionId = client.sessionId;
    player.nickname = nickname;
    player.seat = seat;
    player.connected = true;
    player.isHost = this.state.players.size === 0;
    if (player.isHost) {
      this.state.hostSessionId = client.sessionId;
    }
    this.state.players.set(client.sessionId, player);

    if (joiningMidGame) {
      this.onPlayerJoinedMidGame(player);
    }
  }

  async onDrop(client: Client, code?: number) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;

    player.connected = false;
    this.onPlayerDropped(player);

    const grace =
      this.state.phase === Phase.PLAYING
        ? this.reconnectionGraceSeconds
        : this.lobbyGraceSeconds;
    const reconnection = this.allowReconnection(client, grace);
    this.pendingReconnections.set(client.sessionId, reconnection);
    try {
      await reconnection;
      // Success path is handled by onReconnect().
    } catch {
      // Grace period expired, the player was kicked, or the room is
      // disposing. onLeave performs the permanent removal too;
      // removePlayerForGood is idempotent either way.
      this.removePlayerForGood(client.sessionId);
    } finally {
      this.pendingReconnections.delete(client.sessionId);
    }
  }

  onReconnect(client: Client) {
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.connected = true;
    this.onPlayerReconnected(player);
    this.syncPrivate(client);
  }

  onLeave(client: Client, code?: number) {
    this.removePlayerForGood(client.sessionId);
  }

  async onDispose() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    await releaseRoomCode(this.presence, this.roomId);
  }

  // ---- framework actions -------------------------------------------------

  /** End the game. reason: "win:<seat>" | "draw" | "abandoned" (EndReason). */
  protected endGame(reason: string): void {
    if (this.state.phase !== Phase.PLAYING) return;
    this.state.phase = Phase.ENDED;
    this.state.endReason = reason;
    this.onGameEnded();
  }

  /** Optional hook: stop timers/loops when the game ends. */
  protected onGameEnded(): void {}

  protected winBySeat(seat: number): string {
    return `${EndReason.WIN_PREFIX}${seat}`;
  }

  // ---- internals ----------------------------------------------------------

  private startGame(): void {
    this.state.endReason = "";
    for (const player of this.state.players.values()) {
      player.wantsRematch = false;
    }
    this.state.phase = Phase.PLAYING;
    if (!this.allowLateJoin) {
      void this.lock();
    }
    this.onGameStart();
  }

  private handleStart(client: Client): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    if (this.state.players.size < this.minPlayers) return;
    this.startGame();
  }

  private handleKick(client: Client, payload: { sessionId?: string }): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const targetId = payload?.sessionId;
    if (!targetId || targetId === client.sessionId) return;
    if (!this.state.players.has(targetId)) return;

    const target = this.clients.getById(targetId);
    if (target) {
      target.send(ServerMsg.KICKED, {});
      // Consented close: the kicked player may not reconnect into the seat.
      target.leave(CloseCode.CONSENTED);
    } else {
      // Target is currently disconnected (inside its grace period):
      // cancel the pending reconnection so it cannot rejoin the seat.
      const pending = this.pendingReconnections.get(targetId);
      if (pending) {
        pending.reject(new Error("kicked"));
      } else {
        this.removePlayerForGood(targetId);
      }
    }
  }

  private handleRematch(client: Client): void {
    if (this.state.phase !== Phase.ENDED) return;
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    player.wantsRematch = true;

    if (this.state.players.size < this.minPlayers) return;
    for (const p of this.state.players.values()) {
      if (!p.wantsRematch) return;
    }
    this.startGame();
  }

  private removePlayerForGood(sessionId: string): void {
    const player = this.state.players.get(sessionId);
    if (!player) return;
    this.state.players.delete(sessionId);

    if (this.state.hostSessionId === sessionId) {
      this.migrateHost();
    }

    this.onPlayerLeftForGood(player);

    if (
      this.state.phase === Phase.PLAYING &&
      this.state.players.size < this.minPlayers
    ) {
      this.endGame(EndReason.ABANDONED);
    }
    // A pending rematch may now be unanimous among the remaining players.
    if (this.state.phase === Phase.ENDED && this.state.players.size >= this.minPlayers) {
      let all = this.state.players.size > 0;
      for (const p of this.state.players.values()) {
        if (!p.wantsRematch) all = false;
      }
      if (all) this.startGame();
    }
  }

  private migrateHost(): void {
    let next: BasePlayer | undefined;
    for (const p of this.state.players.values()) {
      if (!next || p.seat < next.seat) next = p;
    }
    if (next) {
      next.isHost = true;
      this.state.hostSessionId = next.sessionId;
    } else {
      this.state.hostSessionId = "";
    }
  }

  private lowestFreeSeat(): number {
    const taken = new Set<number>();
    for (const p of this.state.players.values()) taken.add(p.seat);
    let seat = 0;
    while (taken.has(seat)) seat++;
    return seat;
  }

  private validateNickname(raw: unknown): string {
    const nickname = typeof raw === "string" ? raw.trim() : "";
    if (
      nickname.length < NICKNAME_MIN_LENGTH ||
      nickname.length > NICKNAME_MAX_LENGTH
    ) {
      throw new ServerError(
        JoinError.INVALID_NICKNAME,
        `Nicknames must be ${NICKNAME_MIN_LENGTH}-${NICKNAME_MAX_LENGTH} characters.`
      );
    }
    return nickname;
  }
}
