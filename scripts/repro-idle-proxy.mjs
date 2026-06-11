/**
 * Deterministic, local reproduction of the production drop bug + proof the fix
 * resolves it. We can't reproduce the real Render path from CI (its proxy is
 * masked here), so we simulate the failure condition: a TCP proxy in front of
 * the local prod server that idle-closes a WebSocket after `idleMs` of silence
 * in a chosen direction - exactly what a hosting proxy does.
 *
 * Run a LOCAL PROD SERVER first:  NODE_ENV=production PORT=2567 npm start
 * Then:                           node scripts/repro-idle-proxy.mjs
 *
 * The decisive scenario is an UPSTREAM-idle proxy (closes when the client
 * sends nothing), which PR #3's server->client-only keepalive could never fix:
 *   - client WITHOUT the heartbeat  -> dropped ~idleMs  (the bug)
 *   - client WITH    the heartbeat  -> survives          (the fix)
 */
import net from "node:net";
import { ColyseusSDK } from "@colyseus/sdk";

// Inlined from shared/src/protocol.ts (this standalone script can't import the
// raw-TS shared package). Keep in sync with ConnectionMsg.HEARTBEAT / KEEPALIVE_INTERVAL_MS.
const ConnectionMsg = { HEARTBEAT: "fw/heartbeat" };
const KEEPALIVE_INTERVAL_MS = 4000;

const TARGET_PORT = 2567;
const PROXY_PORT = 9100;

/**
 * @param resetOn 'up' = reset idle timer only on client->server bytes,
 *                'down' = only on server->client, 'both' = either direction.
 */
function makeIdleProxy({ idleMs, resetOn }) {
  const server = net.createServer((client) => {
    const target = net.connect(TARGET_PORT, "127.0.0.1");
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        client.destroy();
        target.destroy();
      }, idleMs);
    };
    arm();
    client.on("data", (d) => {
      target.write(d);
      if (resetOn === "up" || resetOn === "both") arm(); // upstream activity
    });
    target.on("data", (d) => {
      client.write(d);
      if (resetOn === "down" || resetOn === "both") arm(); // downstream activity
    });
    const close = () => { clearTimeout(timer); client.destroy(); target.destroy(); };
    client.on("close", close); client.on("error", close);
    target.on("close", close); target.on("error", close);
  });
  return new Promise((res) => server.listen(PROXY_PORT, "127.0.0.1", () => res(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runClient({ heartbeat, durationMs }) {
  const sdk = new ColyseusSDK(`http://127.0.0.1:${PROXY_PORT}`);
  const room = await sdk.create("tictactoe", { nickname: "Repro" });
  room.reconnection.enabled = false; // capture the raw first drop cleanly
  const t0 = Date.now();
  let dropped = null;
  let leaving = false; // distinguish our own clean leave from a real drop
  room.onLeave((code) => { if (!leaving && dropped === null) dropped = { at: Date.now() - t0, code }; });
  room.onError(() => {});

  let hb;
  if (heartbeat) {
    hb = setInterval(() => { try { room.send(ConnectionMsg.HEARTBEAT); } catch {} }, KEEPALIVE_INTERVAL_MS);
  }
  const deadline = Date.now() + durationMs;
  while (dropped === null && Date.now() < deadline) await sleep(100);
  clearInterval(hb);
  // Only leave if still connected; leaving an already-dropped room would hang
  // waiting for an onLeave that never fires again.
  if (dropped === null) { leaving = true; try { await room.leave(true); } catch {} }
  return dropped;
}

async function scenario(label, { idleMs, resetOn, heartbeat, durationMs }) {
  const proxy = await makeIdleProxy({ idleMs, resetOn });
  const res = await runClient({ heartbeat, durationMs });
  await new Promise((r) => proxy.close(r));
  const verdict = res === null ? `SURVIVED ${durationMs / 1000}s` : `DROPPED at +${(res.at / 1000).toFixed(1)}s (close ${res.code})`;
  console.log(`  ${label.padEnd(46)} -> ${verdict}`);
  return res === null;
}

console.log(`\nIdle-proxy reproduction (proxy idle timeout = 6s, server keepalive = ${KEEPALIVE_INTERVAL_MS}ms)\n`);

console.log("UPSTREAM-idle proxy (closes when client is quiet) - the bug's shape:");
const a = await scenario("OLD client (no upstream heartbeat)", { idleMs: 6000, resetOn: "up", heartbeat: false, durationMs: 14000 });
const b = await scenario("NEW client (sends heartbeat)", { idleMs: 6000, resetOn: "up", heartbeat: true, durationMs: 14000 });

console.log("\nDOWNSTREAM-idle proxy (closes when server is quiet):");
const c = await scenario("server keepalive only (no client send)", { idleMs: 6000, resetOn: "down", heartbeat: false, durationMs: 14000 });

console.log("\n----- RESULT -----");
const pass = a === false && b === true && c === true;
console.log(`upstream-idle, no heartbeat:  ${a === false ? "DROPS (reproduced the bug)" : "did not drop"}`);
console.log(`upstream-idle, w/ heartbeat:  ${b === true ? "SURVIVES (fix works)" : "STILL DROPS"}`);
console.log(`downstream-idle, server beat: ${c === true ? "SURVIVES (server keepalive covers it)" : "DROPS"}`);
console.log(pass ? "\n✅ Fix validated: the heartbeat prevents the idle-close that drops a quiet client." :
                   "\n❌ Unexpected result - investigate.");
process.exit(pass ? 0 : 1);
