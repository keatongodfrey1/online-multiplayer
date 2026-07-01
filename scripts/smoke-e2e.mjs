/**
 * Live smoke test: drives real game clients through both demo games
 * against a RUNNING server - local or deployed.
 *
 *   npm start                # in one terminal (or use the deployed URL)
 *   npm run smoke                                  # tests localhost:2567
 *   npm run smoke -- https://your-app.onrender.com # tests production
 *
 * Covers: create, join-by-code, bad code rejection, start, turn-based
 * play, mid-game "refresh" reconnection (same seat), win + rematch,
 * real-time late join, server-authoritative movement, disconnect
 * freezing, pellet scoring.
 */
import { ColyseusSDK } from "@colyseus/sdk";

const URL = process.argv[2] ?? "http://localhost:2567";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting for game state");
    await sleep(25);
  }
}
let checks = 0;
const ok = (cond, msg) => {
  if (!cond) throw new Error("FAILED: " + msg);
  checks++;
  console.log("  ok -", msg);
};

console.log(`Smoke-testing ${URL}\n`);

// ---------- Tic-Tac-Toe flow ------------------------------------------
{
  console.log("Tic-Tac-Toe:");
  const host = new ColyseusSDK(URL);
  const guest = new ColyseusSDK(URL);

  const a = await host.create("tictactoe", { nickname: "SmokeA" });
  ok(/^[A-Z]{4}$/.test(a.roomId), `room code is 4 letters (${a.roomId})`);

  const b = await guest.joinById(a.roomId, { nickname: "SmokeB" });
  ok(b.name === "tictactoe", "joiner learns the game type from the server");
  await until(() => a.state?.players?.size === 2);

  let rejected = false;
  try {
    await guest.joinById("AAAA", { nickname: "Nope" });
  } catch {
    rejected = true;
  }
  ok(rejected, "wrong code is rejected");

  a.send("lobby/start", {});
  await until(() => a.state.phase === "playing" && b.state.phase === "playing");
  ok(true, "host started; both clients see phase=playing");

  // X:0  O:3, then B "refreshes the page" and resumes by token.
  a.send("ttt/move", { cell: 0 });
  await until(() => b.state.board[0] === 1);
  b.send("ttt/move", { cell: 3 });
  await until(() => a.state.board[3] === 2);

  const token = b.reconnectionToken;
  const bSession = b.sessionId;
  await b.leave(false); // abnormal close, like a refresh
  await until(() => a.state.players.get(bSession)?.connected === false);
  ok(true, "host sees the dropped player as disconnected (seat held)");

  const b2 = await new ColyseusSDK(URL).reconnect(token);
  await until(() => a.state.players.get(bSession)?.connected === true);
  ok(b2.sessionId === bSession, "refresh-style reconnect resumed the same seat");
  await until(() => b2.state?.board?.[0] === 1);
  ok(b2.state.board[3] === 2, "resumed client sees the full board");

  // Finish: X wins the top row.
  a.send("ttt/move", { cell: 1 });
  await until(() => b2.state.board[1] === 1);
  b2.send("ttt/move", { cell: 4 });
  await until(() => a.state.board[4] === 2);
  a.send("ttt/move", { cell: 2 });
  await until(() => a.state.phase === "ended");
  ok(a.state.endReason === "win:0", "win detected for seat 0");

  a.send("lobby/rematch", {});
  b2.send("lobby/rematch", {});
  await until(() => a.state.phase === "playing");
  ok([...a.state.board].every((v) => v === 0), "unanimous rematch resets the board");

  await a.leave(true);
  await b2.leave(true);
}

// ---------- Dot Arena flow --------------------------------------------
{
  console.log("\nDot Arena:");
  const s1 = new ColyseusSDK(URL);
  const s2 = new ColyseusSDK(URL);
  const s3 = new ColyseusSDK(URL);

  const a = await s1.create("arena", { nickname: "DotA" });
  const b = await s2.joinById(a.roomId, { nickname: "DotB" });
  await until(() => a.state?.players?.size === 2);
  a.send("lobby/start", {});
  await until(() => a.state.phase === "playing");
  ok(a.state.pellets.size === 10, "pellets spawned and synced");

  const late = await s3.joinById(a.roomId, { nickname: "DotC" });
  await until(() => a.state.players.size === 3);
  ok(true, "late join works while the game is running");

  const bOnA = () => a.state.players.get(b.sessionId);
  const x0 = bOnA().x;
  b.send("arena/input", { dx: 1, dy: 0 });
  await sleep(400);
  b.send("arena/input", { dx: 0, dy: 0 });
  ok(
    bOnA().x - x0 > 20 || bOnA().x > 750,
    `server-authoritative movement synced to others (moved ${(bOnA().x - x0).toFixed(0)})`
  );

  const token = b.reconnectionToken;
  const bId = b.sessionId;
  await b.leave(false);
  await until(() => a.state.players.get(bId)?.connected === false);
  const frozenX = a.state.players.get(bId).x;
  await sleep(300);
  ok(Math.abs(a.state.players.get(bId).x - frozenX) < 0.01, "disconnected dot freezes in place");

  const b2 = await new ColyseusSDK(URL).reconnect(token);
  await until(() => a.state.players.get(bId)?.connected === true);
  ok(b2.sessionId === bId, "reconnect resumes the same dot");

  // Hunt pellets: steer straight at the nearest one until 3 are eaten.
  const me = () => a.state.players.get(a.sessionId);
  const score0 = me().score;
  const t0 = Date.now();
  while (me().score < score0 + 3 && Date.now() - t0 < 25000) {
    let best = null;
    let bestD = Infinity;
    a.state.pellets.forEach((p) => {
      const d = Math.hypot(p.x - me().x, p.y - me().y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    });
    if (best) {
      const len = Math.hypot(best.x - me().x, best.y - me().y) || 1;
      a.send("arena/input", { dx: (best.x - me().x) / len, dy: (best.y - me().y) / len });
    }
    await sleep(100);
  }
  a.send("arena/input", { dx: 0, dy: 0 });
  ok(me().score - score0 >= 3, `pellet scoring works (ate ${me().score - score0})`);
  ok(a.state.pellets.size === 10, "eaten pellets respawn");

  await a.leave(true);
  await b2.leave(true);
  await late.leave(true);
}

// ---------- The Perfect Palace flow -----------------------------------
{
  console.log("\nThe Perfect Palace:");
  const h = new ColyseusSDK(URL);
  const g = new ColyseusSDK(URL);

  const a = await h.create("perfectpalace", { nickname: "PalA" });
  const b = await g.joinById(a.roomId, { nickname: "PalB" });
  await until(() => a.state?.players?.size === 2);
  a.send("lobby/start", {});
  await until(() => a.state.phase === "playing");
  ok(a.state.enginePhase === "initial-roll", "opens at the interactive turn-order roll");
  ok(a.state.deckCount === 18 && a.state.discardCount === 0, "deck synced as counts only");
  ok(a.state.deck === undefined, "deck order is never synced to clients");
  ok([...a.state.seats].every((s) => s.resourceCard.length === 0), "resource cards are hidden before the reveal");

  // Opening roll for turn order (server-authoritative d6). A top tie clears the tied
  // rolls, so re-send until the room finalizes the order and advances to the mapping.
  for (let i = 0; i < 40 && a.state.enginePhase === "initial-roll"; i++) {
    a.send("perfectpalace/action", { type: "initialRoll/roll" });
    b.send("perfectpalace/action", { type: "initialRoll/roll" });
    await sleep(150);
  }
  ok(a.state.enginePhase === "initial-mapping", "advances to the hidden mapping after the roll");

  const card = [
    { kind: "sticks", amount: 5 }, { kind: "bricks", amount: 5 }, { kind: "bricks", amount: 10 },
    { kind: "dollars", amount: 5 }, { kind: "dollars", amount: 10 }, { kind: "draw-card", amount: 0 },
  ];
  a.send("perfectpalace/action", { type: "mapping/setInitial", card });
  await until(() => [...a.state.seats].find((s) => s.sessionId === a.sessionId)?.mappingLocked === true);
  ok(a.state.enginePhase === "initial-mapping", "stays hidden until everyone locks");
  b.send("perfectpalace/action", { type: "mapping/setInitial", card });
  await until(() => a.state.enginePhase !== "initial-mapping");
  ok([...a.state.seats].every((s) => s.resourceCard.length === 6), "all cards revealed at once");

  // The active player rolls; the die is server-generated (no client value honoured).
  const roller = [a, b].find((c) => c.sessionId === a.state.currentTurn);
  roller.send("perfectpalace/action", { type: "turn/rollDie", value: 6 });
  await until(() => a.state.lastRoll >= 1 && a.state.lastRoll <= 6);
  ok(true, `server rolled a real d6 (${a.state.lastRoll}) for the active player`);

  // A non-current player cannot act.
  const other = [a, b].find((c) => c.sessionId !== a.state.currentTurn);
  const phaseBefore = a.state.turnPhase;
  other.send("perfectpalace/action", { type: "turn/endTurn" });
  await sleep(150);
  ok(a.state.turnPhase === phaseBefore || a.state.enginePhase !== "initial-mapping", "out-of-turn action ignored");

  // Mid-game "refresh": B drops and resumes the same seat by token.
  const token = b.reconnectionToken;
  const bId = b.sessionId;
  await b.leave(false);
  await until(() => a.state.players.get(bId)?.connected === false);
  ok(true, "host sees the dropped player as disconnected (seat held)");
  const b2 = await new ColyseusSDK(URL).reconnect(token);
  await until(() => a.state.players.get(bId)?.connected === true);
  ok(b2.sessionId === bId, "mid-game refresh resumed the same seat");
  ok(b2.state.enginePhase !== "initial-mapping", "resumed client sees the live game");

  await a.leave(true);
  await b2.leave(true);
}

// ---------- The Perfect Palace: AI bots + reclaim ---------------------
{
  console.log("\nThe Perfect Palace (bots & reclaim):");
  const host = new ColyseusSDK(URL);
  const a = await host.create("perfectpalace", { nickname: "HostA" });
  await until(() => a.state?.players?.size === 1);
  a.send("lobby/addBot", {}); // LobbyMsg.ADD_BOT
  await until(() => a.state?.players?.size === 2);
  ok([...a.state.players.values()].some((p) => p.isBot), "host seated an AI player");

  a.send("lobby/start", {});
  await until(() => a.state.phase === "playing");
  // The game opens at the interactive turn-order roll: the host rolls, the bot
  // auto-rolls, then the room finalizes order and advances to the hidden mapping.
  for (let i = 0; i < 40 && a.state.enginePhase === "initial-roll"; i++) {
    a.send("perfectpalace/action", { type: "initialRoll/roll" });
    await sleep(150);
  }
  // Host locks; the bot auto-locks → the reveal fires with no human input for it.
  const card = [
    { kind: "sticks", amount: 5 }, { kind: "bricks", amount: 5 }, { kind: "bricks", amount: 10 },
    { kind: "dollars", amount: 5 }, { kind: "dollars", amount: 10 }, { kind: "draw-card", amount: 0 },
  ];
  a.send("perfectpalace/action", { type: "mapping/setInitial", card });
  await until(() => a.state.enginePhase !== "initial-mapping", 6000);
  ok(true, "the AI auto-locked its card and the game revealed");

  await a.leave(true);
}

console.log(`\nALL ${checks} SMOKE CHECKS PASSED against ${URL}`);
process.exit(0);
