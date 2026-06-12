/**
 * types.ts — Core domain types for the Catan engine.
 *
 * Ported verbatim from catan-clone/catan-engine/src/types.ts (see ./index.ts
 * for the port notes). Plain data only (no classes/methods) so GameState can
 * be deep-cloned cheaply and serialized for networking / save-games / undo.
 * The static board geometry (geometry.ts) is kept OUT of GameState precisely
 * so cloning stays cheap.
 */

export type Resource = "lumber" | "brick" | "wool" | "grain" | "ore";
export const RESOURCES: Resource[] = ["lumber", "brick", "wool", "grain", "ore"];

export type Terrain =
  | "forest" // -> lumber
  | "hills" // -> brick
  | "pasture" // -> wool
  | "fields" // -> grain
  | "mountains" // -> ore
  | "desert"; // -> nothing

export const TERRAIN_RESOURCE: Record<Terrain, Resource | null> = {
  forest: "lumber",
  hills: "brick",
  pasture: "wool",
  fields: "grain",
  mountains: "ore",
  desert: null,
};

export type BuildingType = "settlement" | "city";
export type PlayerId = number; // index into GameState.players
export type ResourceBag = Record<Resource, number>;

export function emptyBag(): ResourceBag {
  return { lumber: 0, brick: 0, wool: 0, grain: 0, ore: 0 };
}

export type DevCardType =
  | "knight"
  | "victoryPoint"
  | "roadBuilding"
  | "yearOfPlenty"
  | "monopoly";

export interface DevCard {
  type: DevCardType;
  /** True until the start of the owner's NEXT turn; blocks playing the card the
   *  same turn it was bought. (victoryPoint cards are never "played", so this
   *  flag does not gate them.) */
  boughtThisTurn: boolean;
  played: boolean;
}

export type PortType = "generic" | Resource; // generic => 3:1, resource => 2:1

export interface Port {
  type: PortType;
  vertices: number[]; // vertex ids that grant access (usually 2)
}

export const COSTS = {
  road: { lumber: 1, brick: 1 },
  settlement: { lumber: 1, brick: 1, wool: 1, grain: 1 },
  city: { ore: 3, grain: 2 },
  devCard: { ore: 1, wool: 1, grain: 1 },
} as const satisfies Record<string, Partial<ResourceBag>>;

export const PIECE_LIMITS = { roads: 15, settlements: 5, cities: 4 } as const;

// ---- Mutable per-game board state (cloneable) ------------------------------

export interface VertexState {
  building: { owner: PlayerId; type: BuildingType } | null;
  portId: number | null;
}
export interface EdgeState {
  road: { owner: PlayerId } | null;
}
export interface HexState {
  terrain: Terrain;
  numberToken: number | null; // null only for the desert
}
export interface BoardState {
  hexes: HexState[]; // 19, indexed to match geometry.hexes
  vertices: VertexState[]; // 54
  edges: EdgeState[]; // 72
  ports: Port[];
  robberHex: number;
}

export interface PlayerState {
  id: PlayerId;
  color: string;
  hand: ResourceBag;
  devCards: DevCard[]; // includes hidden victoryPoint cards
  knightsPlayed: number;
  piecesLeft: { roads: number; settlements: number; cities: number };
}

/** Turn / flow phases. Transition graph lives in stateMachine.ts. */
export type Phase =
  | "setupSettlement"
  | "setupRoad"
  | "preRoll" // may play ONE dev card, then must roll
  | "discard" // a 7 was rolled; over-limit hands discard
  | "moveRobber"
  | "steal"
  | "main"
  | "specialBuild" // 5-6 player extension: build round between turns
  | "gameOver";

/** An open domestic (player-to-player) trade offer. Resource-for-resource
 *  only; dev cards are never tradeable; "no gifts" => both sides give >= 1. */
export interface PendingTrade {
  proposer: PlayerId;
  give: Partial<ResourceBag>; // what the proposer gives (and the partner receives)
  receive: Partial<ResourceBag>; // what the proposer receives (and the partner gives)
  candidates: PlayerId[]; // who may accept
  acceptances: PlayerId[]; // who has accepted so far
}

export interface GameEvent {
  type: string;
  player?: PlayerId;
  detail?: unknown;
}

export interface GameState {
  phase: Phase;
  players: PlayerState[];
  currentPlayer: PlayerId;
  board: BoardState;
  bank: ResourceBag;
  devDeck: DevCardType[]; // shuffled draw pile; NOT reshuffled when empty
  dice: [number, number] | null;
  longestRoadHolder: PlayerId | null;
  largestArmyHolder: PlayerId | null;
  winner: PlayerId | null;

  // setup bookkeeping
  setupSequence: PlayerId[]; // e.g. [0,1,2,3,3,2,1,0]; empty once setup is done
  setupStep: number;
  lastSettlementVertex: number | null;

  // transient turn flags
  freeRoads: number; // >0 while resolving Road Building
  devCardPlayedThisTurn: boolean;
  pendingDiscards: Record<PlayerId, number>;
  robberReturnPhase: Phase; // where to go after the robber resolves
  pendingTrade: PendingTrade | null; // open domestic trade offer, if any
  rngState: number; // seedable PRNG state (deterministic games/tests)

  // 5-6 player extension: the special building phase between turns
  specialBuildEnabled: boolean;
  specialBuildQueue: PlayerId[]; // players still to get a build window this round
  specialBuilder: PlayerId | null; // whose special-build window is active

  log: GameEvent[];
}

export const HAND_LIMIT_BEFORE_DISCARD = 7; // discard when hand > 7
export const LONGEST_ROAD_MIN = 5;
export const LARGEST_ARMY_MIN = 3;
export const WINNING_VP = 10;
