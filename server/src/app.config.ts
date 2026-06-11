import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { defineServer, monitor, playground } from "colyseus";

const isProduction = process.env.NODE_ENV === "production";

/** repo-root/client/dist - the built client served in production. */
const clientDist = path.resolve(
  fileURLToPath(import.meta.url),
  "../../../client/dist"
);

const server = defineServer({
  /**
   * Game rooms. Every game registers itself here with one line - see
   * ADDING_A_GAME.md.
   */
  rooms: {},

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
