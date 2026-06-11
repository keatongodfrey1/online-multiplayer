/**
 * Hidden information patterns (for games like Splendor / Catan where each
 * player has a private hand).
 *
 * Two supported patterns - pick per use case:
 *
 * 1. PERSISTENT private state (a hand of cards): schema views.
 *    - Mark the field with `@view() @type(...)` in the schema.
 *    - In the room, grant each client visibility of THEIR entity:
 *        grantPrivateView(client, player.hand)
 *    - Colyseus then syncs that field only to that client. Views survive
 *      reconnection automatically (client.view is preserved).
 *
 * 2. ONE-SHOT secrets ("you drew the Knight card"): targeted messages.
 *        client.send("game/youDrew", { card: "knight" })
 *    - Messages are NOT state: a reconnecting client missed anything sent
 *      while away. Re-send whatever is still relevant from the room's
 *      syncPrivate(client) hook (called automatically on reconnect).
 */
import { StateView } from "@colyseus/schema";
import type { Client } from "colyseus";

/** Add schema entities to a client's private view, creating it if needed. */
export function grantPrivateView(client: Client, ...entities: object[]): void {
  if (!client.view) {
    client.view = new StateView();
  }
  for (const entity of entities) {
    client.view.add(entity as never);
  }
}

/** Remove schema entities from a client's private view. */
export function revokePrivateView(client: Client, ...entities: object[]): void {
  if (!client.view) return;
  for (const entity of entities) {
    client.view.remove(entity as never);
  }
}
