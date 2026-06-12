"""
Reference Splendor rules engine — a Python oracle for the spec in ../SPEC.md.

Purpose:
  * Encode the rules ONE precise way so they can be fuzzed (see fuzz.py).
  * Serve as a behavior reference when implementing the production (TypeScript)
    engine. NOTE: exact state-for-state replay parity between this oracle and a
    TS implementation requires both to pin the SAME seeded PRNG + shuffle
    algorithm (SPEC §9/§12/§13). This file uses Python's random.Random, so use it
    as a *rules* reference, not a byte-for-byte RNG match, unless you port the PRNG.

This is intentionally compact and dependency-free (stdlib only).
"""
import json, os, random, itertools

COLORS = ["white", "blue", "green", "red", "black"]
TOKENS_PER_GEM_BY_PLAYERS = {2: 4, 3: 5, 4: 7}
GOLD_TOKENS = 5
TARGET_PRESTIGE = 15
MAX_TOKENS_HELD = 10
MAX_RESERVED = 3
TAKE_TWO_MIN_PILE = 4


def load_data(path=None):
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "splendor_data.json")
    with open(path) as f:
        return json.load(f)


class Player:
    def __init__(self, seat):
        self.seat = seat
        self.tokens = {c: 0 for c in COLORS}
        self.gold = 0
        self.bonus = {c: 0 for c in COLORS}
        self.reserved = []   # list of card dicts (PRIVATE to this player)
        self.built = []      # list of card dicts
        self.nobles = []     # list of noble dicts

    def points(self):
        return sum(c["points"] for c in self.built) + 3 * len(self.nobles)

    def total_tokens(self):
        return sum(self.tokens.values()) + self.gold


class Game:
    def __init__(self, player_count, seed, data=None, options=None):
        assert player_count in (2, 3, 4)
        self.data = data or load_data()
        self.options = options or {}
        self.pc = player_count
        self.rng = random.Random(seed)
        self.seed = seed
        self.players = [Player(i) for i in range(player_count)]
        gem = TOKENS_PER_GEM_BY_PLAYERS[player_count]
        self.supply = {c: gem for c in COLORS}
        self.supply_gold = GOLD_TOKENS
        decks = {t: [c for c in self.data["cards"] if c["tier"] == t] for t in (1, 2, 3)}
        for t in decks:
            self.rng.shuffle(decks[t])
        self.decks = decks
        self.market = {t: [decks[t].pop() if decks[t] else None for _ in range(4)] for t in (1, 2, 3)}
        nobles = list(self.data["nobles"])
        self.rng.shuffle(nobles)
        self.nobles = nobles[: player_count + 1]   # players + 1 revealed
        self.start_seat = 0
        self.current = 0
        self.last_in_round = (self.start_seat - 1 + player_count) % player_count
        self.end_flag = False
        self.forced_pass_streak = 0
        self.turn_count = 0
        self.reason = None


# ---- pure helpers -----------------------------------------------------------
def required(card, pl):
    return {c: max(0, card["cost"][c] - pl.bonus[c]) for c in COLORS}


def gold_needed(card, pl):
    req = required(card, pl)
    return sum(max(0, req[c] - pl.tokens[c]) for c in COLORS)


def affordable(card, pl):
    return gold_needed(card, pl) <= pl.gold


def legal_moves(g):
    """All legal MOVES for the current player. Empty list => forced pass."""
    pl = g.players[g.current]
    moves = []
    avail = [c for c in COLORS if g.supply[c] > 0]
    # A: take 3 different (or all available if fewer than 3 colors remain)
    if len(avail) >= 3:
        for combo in itertools.combinations(avail, 3):
            moves.append(("TAKE_THREE", combo))
    elif avail:
        moves.append(("TAKE_THREE", tuple(avail)))
    # B: take 2 same (pile must have >= 4 before taking)
    for c in COLORS:
        if g.supply[c] >= TAKE_TWO_MIN_PILE:
            moves.append(("TAKE_TWO", c))
    # C: reserve (market or blind deck top) if holding < 3 reserved
    if len(pl.reserved) < MAX_RESERVED:
        for t in (1, 2, 3):
            for i, card in enumerate(g.market[t]):
                if card is not None:
                    moves.append(("RESERVE_MARKET", t, i))
            if g.decks[t]:
                moves.append(("RESERVE_DECK", t))
    # D: buy (market or own reserved) if affordable
    for t in (1, 2, 3):
        for i, card in enumerate(g.market[t]):
            if card is not None and affordable(card, pl):
                moves.append(("BUY_MARKET", t, i))
    for card in pl.reserved:
        if affordable(card, pl):
            moves.append(("BUY_RESERVED", card["id"]))
    return moves


def _refill(g, t, i):
    g.market[t][i] = g.decks[t].pop() if g.decks[t] else None


def _buy(g, pl, card):
    # IMPORTANT (SPEC §7): compute goldNeeded from PRE-SPEND token counts.
    gn = gold_needed(card, pl)
    req = required(card, pl)
    for c in COLORS:
        spend = min(req[c], pl.tokens[c])
        pl.tokens[c] -= spend
        g.supply[c] += spend
    pl.gold -= gn
    g.supply_gold += gn
    pl.built.append(card)
    for c in COLORS:
        pl.bonus[c] = sum(1 for b in pl.built if b["bonus"] == c)


def apply_action(g, move, policy):
    """Apply a MOVE for the current player, then resolve end-of-turn
    (noble visit -> token limit -> win flag). Sub-decisions use `policy`."""
    pl = g.players[g.current]
    kind = move[0]
    if kind == "TAKE_THREE":
        for c in move[1]:
            g.supply[c] -= 1
            pl.tokens[c] += 1
    elif kind == "TAKE_TWO":
        c = move[1]
        g.supply[c] -= 2
        pl.tokens[c] += 2
    elif kind == "RESERVE_MARKET":
        _, t, i = move
        card = g.market[t][i]
        pl.reserved.append(card)
        _refill(g, t, i)
        if g.supply_gold > 0:
            g.supply_gold -= 1
            pl.gold += 1
    elif kind == "RESERVE_DECK":
        _, t = move
        card = g.decks[t].pop()
        pl.reserved.append(card)
        if g.supply_gold > 0:
            g.supply_gold -= 1
            pl.gold += 1
    elif kind == "BUY_MARKET":
        _, t, i = move
        card = g.market[t][i]
        _buy(g, pl, card)
        _refill(g, t, i)
    elif kind == "BUY_RESERVED":
        cid = move[1]
        card = next(c for c in pl.reserved if c["id"] == cid)
        pl.reserved.remove(card)
        _buy(g, pl, card)
    else:
        raise ValueError("unknown move " + str(move))

    # End-of-turn resolution (SPEC §6). Noble and discard are disjoint per turn.
    qualifying = [n for n in g.nobles
                  if all(pl.bonus[c] >= n["requirement"][c] for c in COLORS)]
    if qualifying:
        n = policy.pick_noble(qualifying, g, pl)   # exactly one per turn
        pl.nobles.append(n)
        g.nobles.remove(n)
    while pl.total_tokens() > MAX_TOKENS_HELD:
        policy.discard_one(g, pl)
    if pl.points() >= TARGET_PRESTIGE:
        g.end_flag = True


def invariants(g):
    """Assert every structural invariant (SPEC §19), INCLUDING non-negativity
    (the check that a sum-only conservation test silently misses)."""
    gem = TOKENS_PER_GEM_BY_PLAYERS[g.pc]
    for c in COLORS:
        assert g.supply[c] >= 0, f"negative bank gem {c}"
        total = g.supply[c] + sum(p.tokens[c] for p in g.players)
        assert total == gem, f"token conservation {c}: {total} != {gem}"
    assert 0 <= g.supply_gold <= GOLD_TOKENS, f"bank gold out of range: {g.supply_gold}"
    assert g.supply_gold + sum(p.gold for p in g.players) == GOLD_TOKENS, "gold conservation"
    card_count = (sum(len(g.decks[t]) for t in (1, 2, 3))
                  + sum(1 for t in (1, 2, 3) for x in g.market[t] if x is not None)
                  + sum(len(p.reserved) + len(p.built) for p in g.players))
    assert card_count == 90, f"card conservation: {card_count} != 90"
    assert len(g.nobles) + sum(len(p.nobles) for p in g.players) == g.pc + 1, "noble conservation"
    for p in g.players:
        assert all(v >= 0 for v in p.tokens.values()), f"NEGATIVE TOKEN seat {p.seat}"
        assert p.gold >= 0, f"NEGATIVE GOLD seat {p.seat}"
        assert len(p.reserved) <= MAX_RESERVED, "reserved > 3"
        assert p.total_tokens() <= MAX_TOKENS_HELD, f"tokens > 10 seat {p.seat}"
        assert p.points() == sum(c["points"] for c in p.built) + 3 * len(p.nobles), "points derivation"
    for t in (1, 2, 3):
        assert len(g.market[t]) == 4, "market row not length 4"
        for x in g.market[t]:
            if x is None:
                assert len(g.decks[t]) == 0, "empty market slot but deck not exhausted"


# ---- simple policies for fuzzing -------------------------------------------
class GreedyPolicy:
    """Buys the highest-point affordable card; otherwise gathers tokens.
    Drives games toward 15 so they terminate by points."""
    def _card_of(self, m, g):
        if m[0] == "BUY_MARKET":
            return g.market[m[1]][m[2]]
        return next(c for c in g.players[g.current].reserved if c["id"] == m[1])

    def pick_move(self, moves, g):
        buys = [m for m in moves if m[0] in ("BUY_MARKET", "BUY_RESERVED")]
        takes3 = [m for m in moves if m[0] == "TAKE_THREE"]
        if buys:
            buys.sort(key=lambda m: (self._card_of(m, g)["points"],
                                     sum(self._card_of(m, g)["cost"].values())), reverse=True)
            if self._card_of(buys[0], g)["points"] > 0 or not takes3:
                return buys[0]
        if takes3:
            return g.rng.choice(takes3)
        if buys:
            return buys[0]
        takes2 = [m for m in moves if m[0] == "TAKE_TWO"]
        if takes2:
            return g.rng.choice(takes2)
        reserves = [m for m in moves if m[0] in ("RESERVE_MARKET", "RESERVE_DECK")]
        return g.rng.choice(reserves) if reserves else None

    def pick_noble(self, qualifying, g, pl):
        return min(qualifying, key=lambda n: n["id"])   # deterministic

    def discard_one(self, g, pl):
        most = max(COLORS, key=lambda c: pl.tokens[c])
        if pl.tokens[most] > 0:
            pl.tokens[most] -= 1
            g.supply[most] += 1
        else:
            pl.gold -= 1
            g.supply_gold += 1


class RandomPolicy(GreedyPolicy):
    def pick_move(self, moves, g):
        return g.rng.choice(moves) if moves else None

    def pick_noble(self, qualifying, g, pl):
        return g.rng.choice(qualifying)


def play(player_count, seed, policy, turn_cap=4000, data=None):
    """Play a full game. Returns (reason, turns, max_points, max_tokens_held).
    reason in {"points","stalemate","CAP"}. Asserts invariants every step."""
    g = Game(player_count, seed, data=data)
    while True:
        seat = g.current
        moves = legal_moves(g)
        if not moves:
            g.forced_pass_streak += 1            # forced pass: do nothing
        else:
            apply_action(g, policy.pick_move(moves, g), policy)
            g.forced_pass_streak = 0
        invariants(g)
        # End conditions: points-win first (someone has >=15), then stalemate.
        if g.end_flag and seat == g.last_in_round:
            g.reason = "points"; break
        if g.forced_pass_streak >= g.pc:          # one full round of forced passes
            g.reason = "stalemate"; break
        g.current = (seat + 1) % g.pc
        g.turn_count += 1
        if g.turn_count > turn_cap:               # REQUIRED backstop (SPEC §9):
            g.reason = "CAP"; break               # base game has no progress guarantee
    if g.reason == "points":
        assert any(p.points() >= TARGET_PRESTIGE for p in g.players), "ended on points but nobody >= 15"
    return (g.reason, g.turn_count,
            max(p.points() for p in g.players),
            max(p.total_tokens() for p in g.players))
