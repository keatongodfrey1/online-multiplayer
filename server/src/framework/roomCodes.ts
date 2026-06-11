/**
 * Short join-code management.
 *
 * The Colyseus roomId IS the join code (official "custom room id" recipe):
 * a room sets `this.roomId` to a generated 4-letter code in onCreate, and
 * clients join with `client.joinById(code)`. The Presence API tracks codes
 * in use so two rooms never share one. Codes are released in onDispose.
 */
import type { Presence } from "colyseus";
import { ServerError } from "colyseus";
import {
  JoinError,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
} from "@backbone/shared";

const CODES_CHANNEL = "backbone:roomcodes";

/**
 * Hard cap on concurrent rooms - prevents anyone from exhausting the
 * server by spamming "create game". 22^4 = ~234k possible codes, so the
 * cap is a resource limit, not a code-space limit.
 */
export const MAX_CONCURRENT_ROOMS = 100;

function randomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Generate a code no other live room is using and claim it.
 *
 * Note: with the default in-process LocalPresence, sismember/sadd resolve
 * synchronously, so there is no real race window. If you later scale to
 * multiple processes with RedisPresence, replace check-then-add with an
 * atomic SADD-return check.
 */
export async function generateUniqueRoomCode(presence: Presence): Promise<string> {
  const taken = await presence.smembers(CODES_CHANNEL);
  if (taken.length >= MAX_CONCURRENT_ROOMS) {
    throw new ServerError(
      JoinError.SERVER_AT_CAPACITY,
      "The server is hosting too many games right now. Try again in a few minutes."
    );
  }
  // 100 attempts is far more than enough below the room cap; the failure
  // branch is effectively unreachable but kept so a bug can't loop forever.
  for (let attempt = 0; attempt < 100; attempt++) {
    const code = randomCode();
    if (!(await presence.sismember(CODES_CHANNEL, code))) {
      await presence.sadd(CODES_CHANNEL, code);
      return code;
    }
  }
  throw new ServerError(JoinError.SERVER_AT_CAPACITY, "Could not allocate a room code.");
}

export async function releaseRoomCode(presence: Presence, code: string): Promise<void> {
  await presence.srem(CODES_CHANNEL, code);
}
