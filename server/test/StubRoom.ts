/**
 * Minimal game room used only by the framework tests.
 * Also serves as the schema-inheritance smoke test: StubState/StubPlayer
 * extend the base classes and add fields of their own.
 */
import { type } from "@colyseus/schema";
import { defineRoom, defineServer } from "colyseus";
import { BasePlayer, BaseState } from "@backbone/shared";
import { BaseGameRoom } from "../src/framework/BaseGameRoom.js";

export class StubPlayer extends BasePlayer {
  @type("uint16") score = 0;
}

export class StubState extends BaseState {
  @type("uint8") startCount = 0;
}

export class StubRoom extends BaseGameRoom<StubState> {
  state = new StubState();
  minPlayers = 2;
  maxPlayers = 3;
  // Short grace periods so reconnection-expiry tests run fast.
  override reconnectionGraceSeconds = 1;
  override lobbyGraceSeconds = 1;

  protected createPlayer(seat: number): StubPlayer {
    return new StubPlayer();
  }

  protected onGameStart(): void {
    this.state.startCount += 1;
  }
}

/**
 * Factory rather than a shared instance: defineServer() holds internal
 * router state, so booting one instance from two test files breaks the
 * second boot. Each suite boots its own config.
 */
export function makeTestAppConfig() {
  return defineServer({
    rooms: {
      stub: defineRoom(StubRoom),
    },
  });
}

/** Wait until a condition holds (polling), failing after ~2s. */
export async function until(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("until(): condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
