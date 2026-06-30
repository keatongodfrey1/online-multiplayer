import { Encoder } from "@colyseus/schema";

// Games can hold large synced state — Water Fight alone broadcasts a capped event
// log plus every seat's public status — whose FULL encode (a fresh client's initial
// sync, or the game-over sync) can exceed @colyseus/schema's 8 KB default buffer.
// Colyseus then prints a `buffer overflow` warning and auto-grows the buffer (which
// works, but is noisy and a little slower). Raise the ceiling once, process-wide, so
// the warning never fires. Math.max so we never LOWER a future-raised default.
//
// Imported for its side effect by BaseGameRoom, so it runs both for the production
// server (index → app.config → rooms → BaseGameRoom) and the test harness (which
// loads rooms directly).
Encoder.BUFFER_SIZE = Math.max(Encoder.BUFFER_SIZE, 16 * 1024);
