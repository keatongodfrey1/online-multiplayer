import { ClientMessage, Connection, ServerMessage } from "../src/protocol";
import { GameServer, ServerOptions } from "../src/server";
import { ManualScheduler } from "../src/scheduler";

export class FakeConn implements Connection {
  id: string;
  sent: ServerMessage[] = [];
  open = true;
  constructor(id: string) {
    this.id = id;
  }
  send(msg: ServerMessage): void {
    this.sent.push(msg);
  }
  close(): void {
    this.open = false;
  }
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i].type === type) return this.sent[i] as Extract<ServerMessage, { type: T }>;
    return undefined;
  }
  all<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter((m) => m.type === type) as Extract<ServerMessage, { type: T }>[];
  }
  clear(): void {
    this.sent = [];
  }
}

let counter = 0;

export function makeServer(opts?: Partial<ServerOptions>): { server: GameServer; scheduler: ManualScheduler } {
  const scheduler = new ManualScheduler();
  const server = new GameServer({ scheduler, newSeed: () => 42, turnTimeoutMs: 1000, ...opts });
  return { server, scheduler };
}

export function connect(server: GameServer): FakeConn {
  const c = new FakeConn(`c${++counter}`);
  server.onConnect(c);
  return c;
}

export function send(server: GameServer, c: FakeConn, msg: ClientMessage): void {
  server.onMessage(c.id, msg);
}

export function tokenOf(c: FakeConn): string {
  const s = c.last("SESSION");
  if (!s) throw new Error("connection has no SESSION");
  return s.sessionToken;
}
