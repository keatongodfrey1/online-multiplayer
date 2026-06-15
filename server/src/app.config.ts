import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { defineRoom, defineServer, monitor, playground, WebSocketTransport } from "colyseus";
import { ARENA, CATAN, PAPERIO, PERFECT_PALACE, SPACE_CHASE, SPLENDOR, TICTACTOE } from "@backbone/shared";
import { ArenaRoom } from "./games/arena/ArenaRoom.js";
import { CatanRoom } from "./games/catan/CatanRoom.js";
import { PaperIoRoom } from "./games/paperio/PaperIoRoom.js";
import { PerfectPalaceRoom } from "./games/perfectpalace/PerfectPalaceRoom.js";
import { SpaceChaseRoom } from "./games/spacechase/SpaceChaseRoom.js";
import { SplendorRoom } from "./games/splendor/SplendorRoom.js";
import { TicTacToeRoom } from "./games/tictactoe/TicTacToeRoom.js";

const isProduction = process.env.NODE_ENV === "production";

/** repo-root/client/dist - the built client served in production. */
const clientDist = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../client/dist"
);

const server = defineServer({
  /**
   * WebSocket keepalive. Colyseus's default transport probes liveness with
   * WebSocket-level ping/pong *control frames* (every 3s) and terminates any
   * client that misses two pongs (~9s). Render's proxy does not relay those
   * control frames, so in production the server wrongly decides every client
   * is unresponsive and disconnects it a few seconds after it connects - an
   * instant, unrecoverable "Reconnecting..." for everyone. Disabling the
   * control-frame check (pingInterval: 0) stops the false terminations; the
   * connection is instead kept warm by app-level (data-frame) heartbeats that
   * proxies DO relay, sent in BOTH directions on a short interval - see
   * ConnectionMsg in shared/protocol.ts (client->server) and BaseGameRoom's
   * keepAlive broadcast (server->client).
   */
  transport: new WebSocketTransport({ pingInterval: 0 }),

  /**
   * Game rooms. Every game registers itself here with one line - see
   * ADDING_A_GAME.md.
   */
  rooms: {
    [TICTACTOE]: defineRoom(TicTacToeRoom),
    [ARENA]: defineRoom(ArenaRoom),
    [SPLENDOR]: defineRoom(SplendorRoom),
    [CATAN]: defineRoom(CatanRoom),
    [SPACE_CHASE]: defineRoom(SpaceChaseRoom),
    [PERFECT_PALACE]: defineRoom(PerfectPalaceRoom),
    [PAPERIO]: defineRoom(PaperIoRoom),
  },

  express: (app) => {
    /** Health check used by the hosting provider. */
    app.get("/healthz", (req, res) => {
      res.json({ ok: true });
    });

    if (isProduction) {
      // One service serves both the WebSocket endpoint and the built
      // client, so there is a single URL and no CORS configuration.
      app.use(express.static(clientDist));
      // SPA fallback: any other GET serves the client app.
      app.get("*", (req, res) => {
        res.sendFile(path.join(clientDist, "index.html"));
      });
    } else {
      // Dev-only debug panels. Never exposed in production: the
      // playground allows joining arbitrary rooms and the monitor shows
      // (and can dispose) every live game.
      app.use("/monitor", monitor());
      app.use("/", playground());
    }
  },
});

export default server;
