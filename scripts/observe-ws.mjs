/**
 * WebSocket liveness probe for diagnosing the production drop bug.
 *
 * Creates ONE tictactoe room against a running server and sits in the lobby,
 * logging every connection event with a timestamp relative to join. It can
 * optionally send a tiny client->server message on an interval, to test
 * whether UPSTREAM traffic is what keeps the proxy from idle-closing the
 * socket.
 *
 *   node scripts/observe-ws.mjs <url> [options]
 *
 * Env options:
 *   SEND_INTERVAL=ms   send a client->server message every ms (0 = send nothing; default 0)
 *   SEND_TYPE=str      message type to send (default "__probe")
 *   DURATION=ms        how long to observe before giving up (default 90000)
 *   RECONNECT=on|off   leave the SDK's auto-reconnect on, to watch the real
 *                      client's flap/recover behaviour (default off, so the
 *                      FIRST raw close code/reason is captured cleanly)
 *
 * Close codes (decisive): 1006 abnormal/proxy hard-close, 1001 going away,
 * 1005 no status, 4010 may-try-reconnect, 4000 consented(clean), 1000 normal.
 */
// WS_IMPL=ws forces the Node `ws` library instead of Node 22's built-in
// (undici) global WebSocket. Must run BEFORE the SDK is imported, because the
// transport binds `globalThis.WebSocket || ws` at module-load time.
if (process.env.WS_IMPL === "ws") {
  globalThis.WebSocket = undefined;
}
const { ColyseusSDK } = await import("@colyseus/sdk");

const URL = process.argv[2] ?? "http://localhost:2567";
const SEND_INTERVAL = Number(process.env.SEND_INTERVAL ?? 0);
const SEND_TYPE = process.env.SEND_TYPE ?? "__probe";
const DURATION = Number(process.env.DURATION ?? 90_000);
const RECONNECT = (process.env.RECONNECT ?? "off") === "on";

const CLOSE = {
  1000: "NORMAL", 1001: "GOING_AWAY", 1005: "NO_STATUS", 1006: "ABNORMAL_CLOSURE",
  4000: "CONSENTED", 4003: "FAILED_TO_RECONNECT", 4010: "MAY_TRY_RECONNECT",
};
const name = (c) => `${c}${CLOSE[c] ? " " + CLOSE[c] : ""}`;

let t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;
const log = (...a) => console.log(el().padStart(8), ...a);

console.log(
  `\nObserving ${URL}\n` +
    `  send: ${SEND_INTERVAL ? `"${SEND_TYPE}" every ${SEND_INTERVAL}ms` : "nothing (idle)"}` +
    `  | auto-reconnect: ${RECONNECT ? "ON" : "OFF"}  | duration: ${DURATION}ms\n`
);

const sdk = new ColyseusSDK(URL);
const room = await sdk.create("tictactoe", { nickname: "Obs" });
t0 = Date.now(); // reset clock to the moment we joined
log(`JOINED room ${room.roomId} sessionId=${room.sessionId}`);

if (!RECONNECT) room.reconnection.enabled = false;

let stateChanges = 0;
let keepalives = 0;
let firstDropAt = null;
let firstKeepaliveAt = null;
let ended = false;

room.onStateChange(() => {
  stateChanges++;
  if (stateChanges <= 2) log(`STATE_CHANGE #${stateChanges} (phase=${room.state?.phase})`);
});

room.onMessage("__keepalive", () => {
  keepalives++;
  if (firstKeepaliveAt === null) firstKeepaliveAt = Date.now() - t0;
  log(`<<< __keepalive #${keepalives} (server->client app heartbeat)`);
});

room.onMessage("*", (type) => log(`<<< message "${String(type)}"`));

room.onDrop((code, reason) => {
  if (firstDropAt === null) firstDropAt = Date.now() - t0;
  log(`DROP code=${name(code)} reason=${JSON.stringify(reason ?? "")} ` +
      `(auto-reconnect ${RECONNECT ? "will retry" : "disabled"})`);
});

room.onReconnect(() => log(`RECONNECTED (overlay would clear here)`));

room.onError((code, message) => log(`ERROR code=${code} message=${JSON.stringify(message ?? "")}`));

room.onLeave((code, reason) => {
  log(`LEAVE code=${name(code)} reason=${JSON.stringify(reason ?? "")} <- room session over`);
  ended = true;
});

if (SEND_INTERVAL > 0) {
  const timer = setInterval(() => {
    try {
      room.send(SEND_TYPE, { t: Date.now() });
      log(`>>> sent "${SEND_TYPE}" (client->server)`);
    } catch (e) {
      log(`>>> send failed: ${e?.message}`);
    }
  }, SEND_INTERVAL);
  timer.unref?.();
}

// Wait until we leave for good, or the duration elapses.
const deadline = Date.now() + DURATION;
while (!ended && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}

console.log("\n----- SUMMARY -----");
console.log(`survived:           ${firstDropAt === null ? `YES (no drop in ${DURATION}ms)` : "NO"}`);
console.log(`first drop at:      ${firstDropAt === null ? "-" : `+${(firstDropAt / 1000).toFixed(2)}s`}`);
console.log(`first keepalive at: ${firstKeepaliveAt === null ? "never arrived" : `+${(firstKeepaliveAt / 1000).toFixed(2)}s`}`);
console.log(`keepalives seen:    ${keepalives}`);
console.log(`state changes:      ${stateChanges}`);
console.log(`keepalive-before-drop: ${
  firstDropAt === null ? "n/a (no drop)" :
  firstKeepaliveAt === null ? "NO - dropped before any keepalive" :
  firstKeepaliveAt < firstDropAt ? "yes" : "no"
}`);
process.exit(0);
