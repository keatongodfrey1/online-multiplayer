// Crypto-random identifiers (SPEC §13): session tokens must be unguessable and
// NOT derivable from roomCode + seat.

import { randomBytes, randomInt } from "node:crypto";

// Unambiguous alphabet (no 0/O/1/I) for human-typed room codes.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newRoomCode(length = 5): string {
  let s = "";
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** 128-bit unguessable session token. */
export function newSessionToken(): string {
  return randomBytes(16).toString("hex");
}

/** A non-negative 32-bit seed for the engine's PRNG. */
export function newSeed(): number {
  return randomInt(0x7fffffff);
}
