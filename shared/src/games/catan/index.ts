/**
 * Catan - shared schema + messages.
 *
 * The rules live in the ported engine (./engine/, server-driven); this schema
 * is the public mirror the server syncs to clients. Engine seats are array
 * indices here: CatanState.seats[i] is engine seat i (humans first; in the
 * 2-player variant seats 2-3 are the neutral players).
 *
 * Board topology is NOT synced: both sides build the identical deterministic
 * geometry via CatanEngine.buildBoardGeometry(), and the flat arrays below are
 * indexed by its hex/vertex/edge ids.
 */
import { ArraySchema, Schema, type, view } from "@colyseus/schema";
import { BasePlayer, BaseState } from "../../state.js";

export * as CatanEngine from "./engine/index.js";

export const CATAN = "catan";

/**
 * Client -> server messages. One message type; the payload is a tagged engine
 * action ({ type: "...", ... }), whitelist-sanitized server-side. Dice are
 * never accepted from clients; `player` fields are forced to the sender.
 */
export const CatanMsg = {
  ACTION: "catan/action",
  /** Host-only, lobby-only. Payload: { useTwoPlayerVariant?: boolean;
   *  robberBounty?: boolean } - the pre-game rule toggles. */
  CONFIG: "catan/config",
  /** Any player, lobby-only. Payload: { color?: string } - pick your piece
   *  color ("" clears). Rejected if another player already chose it. */
  PICK_COLOR: "catan/pickColor",
  /** Host, mid-game. Asks the server for a save snapshot. */
  SAVE: "catan/save",
  /** Server -> host. The save blob to store in the host's browser. */
  SAVE_DATA: "catan/saveData",
  /** Host, lobby-only. Stage a save blob to resume (or null to clear). */
  LOAD: "catan/load",
} as const;

/** The piece colors players may pick (the board palette has exactly these). */
export const CATAN_PLAYABLE_COLORS = ["red", "blue", "white", "orange"] as const;

/** Sentinel for "nobody holds this award" in the holder fields below. */
export const CATAN_NO_HOLDER = 255;

/** Resource bag - reused for the bank, hands, and trade offer sides. */
export class CatanResources extends Schema {
  @type("uint8") lumber = 0;
  @type("uint8") brick = 0;
  @type("uint8") wool = 0;
  @type("uint8") grain = 0;
  @type("uint8") ore = 0;
}

export class CatanDevCard extends Schema {
  /** "knight" | "victoryPoint" | "roadBuilding" | "yearOfPlenty" | "monopoly" */
  @type("string") kind = "";
  /** Unplayable until the owner's next turn. */
  @type("boolean") boughtThisTurn = false;
  @type("boolean") played = false;
}

/** One engine seat; CatanState.seats index === engine seat. */
export class CatanSeat extends Schema {
  /** Owning player's sessionId; "" once they left for good (or a neutral). */
  @type("string") sessionId = "";
  @type("string") nickname = "";
  /** Piece color ("red" | "blue" | "white" | "orange"). */
  @type("string") color = "";
  /** Left for good - the server's ghost plays this seat out. */
  @type("boolean") gone = false;
  /** 2p variant: one of the two neutral piece sets (never acts, never wins). */
  @type("boolean") neutral = false;
  /** Public counts - hand/dev contents stay private. */
  @type("uint8") handCount = 0;
  @type("uint8") devCardCount = 0;
  @type("uint8") knightsPlayed = 0;
  /** Buildings + awards only - hidden VP cards are NOT included. */
  @type("uint8") publicVP = 0;
  @type("boolean") hasLongestRoad = false;
  @type("boolean") hasLargestArmy = false;
  /** Length of this seat's longest road trail (for the HUD). */
  @type("uint8") roadLength = 0;
  @type("uint8") roadsLeft = 15;
  @type("uint8") settlementsLeft = 5;
  @type("uint8") citiesLeft = 4;
  /** 2p variant trade tokens (public, like physical tokens on the table). */
  @type("uint8") tradeTokens = 0;
  /** PRIVATE: synced only to the owner via StateView (grantPrivateView). */
  @view() @type(CatanResources) hand = new CatanResources();
  /** PRIVATE: full dev cards incl. hidden VP cards (owner only). */
  @view() @type([CatanDevCard]) devCards = new ArraySchema<CatanDevCard>();
}

export class CatanPlayer extends BasePlayer {
  /** Lobby color pick ("" = none yet); honored at game start if still free. */
  @type("string") colorChoice = "";
}

export class CatanState extends BaseState {
  @type([CatanSeat]) seats = new ArraySchema<CatanSeat>();

  // ---- board (indexed by the deterministic geometry's ids) ----
  /** 19 hexes: terrain name per hex. */
  @type(["string"]) hexTerrain = new ArraySchema<string>();
  /** 19 hexes: number token (0 = none/desert). */
  @type(["uint8"]) hexToken = new ArraySchema<number>();
  @type("uint8") robberHex = 0;
  /** 54 vertices: owning seat or -1. */
  @type(["int8"]) vertexOwner = new ArraySchema<number>();
  /** 54 vertices: true = city, false = settlement (when owned). */
  @type(["boolean"]) vertexIsCity = new ArraySchema<boolean>();
  /** 72 edges: owning seat or -1. */
  @type(["int8"]) edgeOwner = new ArraySchema<number>();
  /** 9 ports: "generic" or a resource name. */
  @type(["string"]) portTypes = new ArraySchema<string>();
  /** 18 entries: flat [vertexA, vertexB] pairs per port. */
  @type(["uint8"]) portVertices = new ArraySchema<number>();
  @type(CatanResources) bank = new CatanResources();
  @type("uint8") devDeckCount = 0;

  // ---- flow mirror (the engine is the authority) ----
  /** Engine phase: setupSettlement/setupRoad/preRoll/discard/moveRobber/steal/
   *  main/neutralBuild/forcedTradeGive/gameOver. */
  @type("string") phaseDetail = "";
  /** Engine seat whose turn it is. */
  @type("uint8") currentSeat = 0;
  /** sessionId of the single actor; "" during multi-actor discards. */
  @type("string") currentTurn = "";
  /** Seats that must act right now (all owing seats during a discard). */
  @type(["uint8"]) awaitingSeats = new ArraySchema<number>();
  /** Cards each awaiting seat owes (parallel to awaitingSeats; discard only). */
  @type(["uint8"]) discardOwed = new ArraySchema<number>();
  /** During setupRoad: the settlement just placed (the road must touch it). */
  @type("int8") lastSettlementVertex = -1;
  /** rollForOrder phase: each seat's opening-roll sum (-1 = not rolled /
   *  re-rolling a tie / neutral). Losers' rolls stay visible. */
  @type(["int8"]) orderRolls = new ArraySchema<number>();
  /** Latest roll (0,0 = none yet this turn). */
  @type("uint8") dice1 = 0;
  @type("uint8") dice2 = 0;
  /** 2p variant: roll #1 of the current turn. */
  @type("uint8") firstDice1 = 0;
  @type("uint8") firstDice2 = 0;
  @type("uint8") rollsThisTurn = 0;
  /** Road Building roads still owed. */
  @type("uint8") freeRoads = 0;
  @type("boolean") devCardPlayedThisTurn = false;
  /** 2p variant: free neutral builds the current player owes. */
  @type("uint8") pendingNeutralBuilds = 0;
  @type("boolean") twoPlayerVariant = false;
  /** Lobby toggle: with exactly 2 players, use the official CATAN-for-Two
   *  variant (true, default) or the plain standard rules (false). */
  @type("boolean") useTwoPlayerVariant = true;
  /** Lobby toggle (house rule): the robber's mover may take 1 of the tile's
   *  resource from the bank instead of stealing. */
  @type("boolean") robberBounty = false;
  /** 2p variant: trade tokens left beside the board. */
  @type("uint8") tokenSupply = 0;
  /** 2p variant: the once-per-turn knight discard has been used. */
  @type("boolean") knightDiscardedThisTurn = false;

  // ---- open domestic trade offer ----
  @type("boolean") tradeOpen = false;
  @type("uint8") tradeProposer = 0;
  /** What the proposer gives (and a partner would receive). */
  @type(CatanResources) tradeGive = new CatanResources();
  /** What the proposer wants back. */
  @type(CatanResources) tradeReceive = new CatanResources();
  @type(["uint8"]) tradeCandidates = new ArraySchema<number>();
  @type(["uint8"]) tradeAcceptances = new ArraySchema<number>();
  @type(["uint8"]) tradeDeclines = new ArraySchema<number>();

  // ---- awards & log ----
  /** Holding seat or CATAN_NO_HOLDER (255). */
  @type("uint8") longestRoadHolder = CATAN_NO_HOLDER;
  @type("uint8") largestArmyHolder = CATAN_NO_HOLDER;
  /** Human-readable event feed (capped; survives refresh). */
  @type(["string"]) log = new ArraySchema<string>();
  /** Completed turns (for the HUD). */
  @type("uint16") turnCount = 0;
  // loadedSave now lives on BaseState (framework-owned save/resume).
}
