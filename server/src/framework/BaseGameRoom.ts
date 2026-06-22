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
  ConnectionMsg,
  EndReason,
  JoinError,
  KEEPALIVE_INTERVAL_MS,
  LobbyMsg,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
  Phase,
  ServerMsg,
} from "@backbone/shared";
import { generateUniqueRoomCode, releaseRoomCode } from "./roomCodes.js";

/**
 * The seat lineup a save carries, used by the framework to gate the resume
 * start and re-seat bots. A game's own SaveSeat is structurally compatible
 * (it may add fields like a bot difficulty, which the game reads itself).
 */
export interface FrameworkSaveSeat {
  nickname: string;
  isBot: boolean;
  /** Had left for good when saved; stays ghost-played on resume. */
  gone: boolean;
}

export abstract class BaseGameRoom<TState extends BaseState = BaseState> extends Room<{
  state: TState;
}> {
  // ---- per-game configuration -------------------------------------------
  abstract readonly minPlayers: number;
  abstract readonly maxPlayers: number;
  /** Allow joining while a game is in progress (e.g. drop-in arena games). */
  allowLateJoin = false;
  /**
   * Allow the host to seat AI players from the lobby (LobbyMsg.ADD_BOT).
   * The framework only manages the roster entry - playing the bot's turns
   * is entirely the game room's job (key its logic off player.isBot).
   */
  supportsBots = false;
  /**
   * Opt in to save/resume: the host can snapshot a game mid-play and resume
   * it from the lobby. The framework owns the orchestration (SAVE/LOAD
   * messages, the lineup-gated start, bot re-seating); the game implements
   * serializeSave/parseSave/isGameOver/loadedSaveTurnLabel (+ optional
   * onSaveStaged/onLoadedBotSeated/onBotRemoved). See ADDING_A_GAME.md.
   */
  protected supportsSaves = false;
  /**
   * Opt in to mid-game seat reclaim: with allowLateJoin, a newcomer with the
   * room code takes over an autopilot seat. The game implements
   * findReclaimableSeat + reclaimSeat; the framework owns the join policy and
   * the clean rejection when no seat is open.
   */
  protected supportsReclaim = false;
  /** A validated save staged in the lobby, consumed by the next startGame(). */
  protected pendingLoad?: { seats: FrameworkSaveSeat[]; payload: unknown };
  /** Names handed to bots in order; override for themed names. */
  protected botNicknames = ["Botty", "Chip", "Gizmo", "Pixel", "Widget", "Sprocket"];
  /**
   * Seconds a disconnected player's seat is held during a game. 3 minutes is
   * forgiving for real tablets that lock their screen mid-game; it only
   * affects abnormal drops (a consented Leave removes the seat immediately).
   */
  reconnectionGraceSeconds = 180;
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
  /**
   * A player joined while the game is in progress (allowLateJoin only). The
   * default implements seat reclaim for games with supportsReclaim: bind the
   * newcomer to a vacated seat, or reject cleanly when none is open. A game
   * can override this for other late-join behavior (e.g. drop-in arenas).
   */
  protected onPlayerJoinedMidGame(player: BasePlayer): void {
    if (!this.supportsReclaim) return;
    const seatIndex = this.findReclaimableSeat();
    if (seatIndex < 0) {
      // onJoin already inserted the player; undo it and reject so the SDK
      // surfaces a friendly home-screen message instead of a half-join.
      this.state.players.delete(player.sessionId);
      throw new ServerError(JoinError.GAME_IN_PROGRESS, "This game is already underway with no open seat.");
    }
    this.reclaimSeat(seatIndex, player);
  }
  /** A player disconnected (may still reconnect within the grace period). */
  protected onPlayerDropped(player: BasePlayer): void {}
  /** A dropped player came back. */
  protected onPlayerReconnected(player: BasePlayer): void {}
  /** A player left for good (kicked, quit, or grace period expired). */
  protected onPlayerLeftForGood(player: BasePlayer): void {}
  /**
   * A bot was just seated (LobbyMsg.ADD_BOT). The game may inspect the
   * message payload (e.g. a difficulty choice) and adjust the bot entry.
   */
  protected onBotAdded(bot: BasePlayer, options: unknown): void {}
  /**
   * Game veto for starting (host pressed Start, player count already
   * satisfied). The default holds the lobby while a saved game is staged
   * until the exact saved lineup is present (matching humans by nickname,
   * the right number of bots). A game rarely needs to override this.
   */
  protected canStartGame(): boolean {
    if (!this.pendingLoad) return true;
    const required = new Set(
      this.pendingLoad.seats.filter((s) => !s.isBot && !s.gone).map((s) => s.nickname.toLowerCase())
    );
    const humans = [...this.state.players.values()].filter((p) => !p.isBot);
    if (humans.length !== required.size) return false;
    if (!humans.every((p) => required.has(p.nickname.toLowerCase()))) return false;
    const requiredBots = this.pendingLoad.seats.filter((s) => s.isBot && !s.gone).length;
    return this.state.players.size - humans.length === requiredBots;
  }

  // ---- save/resume hooks (reached only when supportsSaves) ---------------
  /** Build the save blob for the host to store (null = not saveable now). */
  protected serializeSave(): object | null {
    return null;
  }
  /** Validate an untrusted save blob; return null to reject it silently. */
  protected parseSave(raw: unknown): { seats: FrameworkSaveSeat[] } | null {
    return null;
  }
  /** Is the game finished? (engine.over vs winner !== null, per game.) */
  protected isGameOver(): boolean {
    return false;
  }
  /** The 1-based turn number shown in the "resuming…" banner. */
  protected loadedSaveTurnLabel(parsed: unknown): number {
    return 1;
  }
  /** A save was just staged: restore any lobby-config it carried. */
  protected onSaveStaged(parsed: unknown): void {}
  /** A bot from the save was just re-seated (e.g. restore its difficulty). */
  protected onLoadedBotSeated(bot: BasePlayer, savedSeat: FrameworkSaveSeat): void {}
  /** A bot is being removed in the lobby (e.g. clear per-bot game state). */
  protected onBotRemoved(sessionId: string): void {}

  // ---- seat-reclaim hooks (reached only when supportsReclaim) ------------
  /** Engine-seat index of a seat a newcomer may take over, or -1 if none. */
  protected findReclaimableSeat(): number {
    return -1;
  }
  /** Bind the newcomer to the seat (rebind mappings, re-grant private view). */
  protected reclaimSeat(seatIndex: number, player: BasePlayer): void {}
  /**
   * Re-send private data (anything delivered via client.send rather than
   * synced state) to a client that just reconnected. State synced via
   * schema - including StateView-filtered fields - needs no handling here.
   */
  protected syncPrivate(client: Client): void {}

  /** Pending reconnection handles, so a kick can cancel one. */
  private pendingReconnections = new Map<string, { reject: Function }>();

  /** Server->client keepalive timer (see ConnectionMsg); stopped on dispose. */
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
    this.onMessage(LobbyMsg.ADD_BOT, (client, payload) => this.handleAddBot(client, payload));
    if (this.supportsSaves) {
      this.onMessage(LobbyMsg.SAVE, (client) => this.handleSave(client));
      this.onMessage(LobbyMsg.LOAD, (client, payload) => this.handleLoad(client, payload));
    }

    // Connection keepalive (see ConnectionMsg). A quiet WebSocket can be
    // idle-closed by hosting proxies seconds after connecting, so we keep both
    // halves of the socket warm with tiny app-level messages:
    //  - upstream: the client sends HEARTBEAT on an interval; this handler just
    //    accepts it (receiving the bytes is the whole point - it resets the
    //    proxy's idle timer for the client->server direction).
    //  - downstream: we broadcast KEEPALIVE on the same interval below.
    this.onMessage(ConnectionMsg.HEARTBEAT, () => {});

    // unref() so a lingering timer never holds the process open (e.g. tests).
    this.keepAlive = setInterval(
      () => this.broadcast(ConnectionMsg.KEEPALIVE),
      KEEPALIVE_INTERVAL_MS
    );
    this.keepAlive.unref?.();

    this.onRoomCreate(options);
  }

  /**
   * Platform-wide crash-safety net. Colyseus does NOT wrap room callbacks in
   * try/catch UNLESS this hook is defined (it checks for it in the Room
   * constructor); once defined, every onMessage handler, the simulation tick,
   * and clock timers are auto-wrapped and any uncaught throw is routed here
   * instead of tearing the room down — which would drop every player at the
   * table. We log and swallow: the one offending message/tick is dropped, state
   * stays consistent (engine reducers assign only on success, so a throw leaves
   * the prior state intact), and play continues. Games still validate input up
   * front; this is the backstop for the throw that slips past or an engine bug.
   */
  onUncaughtException(error: Error, methodName: string): void {
    console.error(
      `[room ${this.roomId}] uncaught exception in ${methodName}: ${error?.message ?? String(error)}`,
      error?.stack ?? "",
    );
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
    this.state.loadedSave = ""; // a staged save is consumed by onGameStart
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
    if (!this.canStartGame()) return;
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
      if (!p.wantsRematch && !p.isBot) return; // bots are always up for another
    }
    this.startGame();
  }

  // ---- save/resume orchestration (supportsSaves) -------------------------

  /** Host requests a mid-game snapshot; the blob goes to the host's browser. */
  private handleSave(client: Client): void {
    if (this.state.phase !== Phase.PLAYING || this.isGameOver()) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    const blob = this.serializeSave();
    if (blob) client.send(ServerMsg.SAVE_DATA, blob);
  }

  /**
   * Host stages a saved game in the lobby (null clears it). The blob is
   * validated by the game's parseSave; saved bots are re-seated, and the
   * start is then gated (canStartGame) until the saved humans return.
   */
  private handleLoad(client: Client, payload: unknown): void {
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    if (payload === null || payload === undefined) {
      this.pendingLoad = undefined;
      this.state.loadedSave = "";
      this.removeBots();
      return;
    }
    const parsed = this.parseSave(payload);
    if (!parsed) return; // corrupt or tampered: ignore silently
    this.pendingLoad = { seats: parsed.seats, payload: parsed };
    this.onSaveStaged(parsed); // game restores its lobby config (timer, variant, ...)
    this.removeBots();
    for (const seat of parsed.seats) {
      if (!seat.isBot || seat.gone) continue;
      if (this.state.players.size >= this.maxPlayers) break;
      const bot = this.seatBot(seat.nickname);
      this.onLoadedBotSeated(bot, seat);
    }
    const humans = parsed.seats.filter((s) => !s.isBot && !s.gone).map((s) => s.nickname);
    this.state.loadedSave = `Resuming a saved game (turn ${this.loadedSaveTurnLabel(parsed)}). Players needed: ${humans.join(", ")}`;
  }

  /** Remove every bot from the roster (lobby load path). */
  protected removeBots(): void {
    for (const player of [...this.state.players.values()]) {
      if (!player.isBot) continue;
      this.onBotRemoved(player.sessionId);
      this.state.players.delete(player.sessionId);
    }
  }

  /** Host seats an AI player (lobby only, games with supportsBots). */
  private handleAddBot(client: Client, options: unknown): void {
    if (!this.supportsBots) return;
    if (this.state.phase !== Phase.LOBBY) return;
    if (client.sessionId !== this.state.hostSessionId) return;
    if (this.state.players.size >= this.maxPlayers) return;
    this.onBotAdded(this.seatBot(), options);
  }

  /**
   * Seat a bot player directly (also used by games restoring a saved
   * lineup). The caller is responsible for capacity/phase checks.
   */
  protected seatBot(nickname?: string): BasePlayer {
    const seat = this.lowestFreeSeat();
    const bot = this.createPlayer(seat);
    bot.sessionId = this.nextBotSessionId();
    bot.nickname = nickname ?? this.nextBotNickname();
    bot.seat = seat;
    bot.connected = true; // a bot is never "away"
    bot.isBot = true;
    this.state.players.set(bot.sessionId, bot);
    return bot;
  }

  /** "bot:N" - colons never appear in real Colyseus session ids. */
  private nextBotSessionId(): string {
    let n = 1;
    while (this.state.players.has(`bot:${n}`)) n++;
    return `bot:${n}`;
  }

  private nextBotNickname(): string {
    const taken = new Set<string>();
    for (const p of this.state.players.values()) taken.add(p.nickname.toLowerCase());
    for (const name of this.botNicknames) {
      if (!taken.has(name.toLowerCase())) return name;
    }
    let n = 1;
    while (taken.has(`bot ${n}`)) n++;
    return `Bot ${n}`;
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
      let humans = 0;
      let all = true;
      for (const p of this.state.players.values()) {
        if (p.isBot) continue; // bots are always up for another
        humans++;
        if (!p.wantsRematch) all = false;
      }
      if (all && humans > 0) this.startGame();
    }
  }

  private migrateHost(): void {
    let next: BasePlayer | undefined;
    for (const p of this.state.players.values()) {
      if (p.isBot) continue; // a bot can't run the lobby
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
