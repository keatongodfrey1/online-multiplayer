"""
Fuzz harness for the reference engine.

Plays many games with two policies and asserts every invariant on every step
(reference_engine.invariants), plus termination behavior.

Findings this harness is designed to surface (and did, during spec review):
  * Accounting bugs (e.g. gold going negative) — caught by the non-negativity
    invariants, NOT by sum-only conservation.
  * Whether games terminate. Greedy play ends by reaching 15 ("points").
    Random play has NO intrinsic progress guarantee, so some games only stop at
    the turn cap ("CAP") — which is exactly why SPEC §9 makes the turn cap a
    REQUIRED backstop, not an optional one.

Run:  python3 fuzz.py            (quick)
      python3 fuzz.py 5000 2000  (greedy_n_per_pc, random_n_per_pc)
Exits non-zero if any invariant assertion fails.
"""
import sys, random, statistics
from collections import Counter
import reference_engine as E


def run(greedy_n=1200, random_n=120, greedy_cap=4000, random_cap=1500):
    random.seed(1)
    print(f"=== GREEDY policy: {greedy_n} games per player-count (expect mostly 'points') ===")
    for pc in (2, 3, 4):
        reasons = Counter(); total_turns = 0; pts = []; max_tok = 0
        for k in range(greedy_n):
            r, t, mp, mt = E.play(pc, 1000 * pc + k, E.GreedyPolicy(), turn_cap=greedy_cap)
            reasons[r] += 1; total_turns += t; pts.append(mp); max_tok = max(max_tok, mt)
        print(f"  {pc}p: {dict(reasons)} | avg_turns={total_turns/greedy_n:.1f} "
              f"| winner_pts med/max={int(statistics.median(pts))}/{max(pts)} | max_tokens_held={max_tok}")

    print(f"=== RANDOM policy: {random_n} games per player-count (stress; 'CAP' expected sometimes) ===")
    for pc in (2, 3, 4):
        reasons = Counter()
        for k in range(random_n):
            r, *_ = E.play(pc, 90000 * pc + k, E.RandomPolicy(), turn_cap=random_cap)
            reasons[r] += 1
        print(f"  {pc}p: {dict(reasons)}")

    print("OK: all invariants (conservation, NON-NEGATIVITY, <=10 tokens, <=3 reserved, "
          "card/noble conservation, points derivation, market integrity) held on every step.")


if __name__ == "__main__":
    g = int(sys.argv[1]) if len(sys.argv) > 1 else 1200
    r = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    run(greedy_n=g, random_n=r)
