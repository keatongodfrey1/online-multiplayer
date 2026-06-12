// Thin WebSocket transport. Wraps `ws` sockets as Connection objects and feeds
// parsed messages to the (transport-agnostic) GameServer.

import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { ClientMessage, Connection, ServerMessage } from "./protocol";
import { GameServer, ServerOptions } from "./server";

export interface RunningServer {
  server: GameServer;
  wss: WebSocketServer;
  close: () => Promise<void>;
}

export function startServer(port: number, opts?: ServerOptions): RunningServer {
  const server = new GameServer(opts);
  const wss = new WebSocketServer({ port });

  wss.on("connection", (ws: WebSocket) => {
    const id = randomUUID();
    const conn: Connection = {
      id,
      send: (msg: ServerMessage) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close: () => ws.close(),
    };
    server.onConnect(conn);

    ws.on("message", (data) => {
      let parsed: ClientMessage;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        conn.send({ type: "ERROR", code: "BAD_JSON", message: "invalid JSON" });
        return;
      }
      if (!parsed || typeof (parsed as { type?: unknown }).type !== "string") {
        conn.send({ type: "ERROR", code: "BAD_MESSAGE", message: "message missing a string 'type'" });
        return;
      }
      try {
        server.onMessage(id, parsed);
      } catch (e) {
        conn.send({ type: "ERROR", code: "INTERNAL", message: (e as Error).message });
      }
    });

    ws.on("close", () => server.onDisconnect(id));
    ws.on("error", () => server.onDisconnect(id));
  });

  return {
    server,
    wss,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => resolve());
      }),
  };
}
