/**
 * Every game registers itself here with one entry.
 * The home screen's "create a game" menu is generated from this list.
 */
import type { GameDefinition } from "../framework/GameView.js";

export const games: GameDefinition[] = [
  // Game entries are added as games are implemented (see ADDING_A_GAME.md):
  // { gameType: "foo", displayName: "Foo", description: "...", createView: () => new FooView() },
];

export function getGame(gameType: string): GameDefinition | undefined {
  return games.find((g) => g.gameType === gameType);
}
