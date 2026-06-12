"""
Code-level validator for splendor_data.json.

The JSON Schema (../splendor_data.schema.json) is structural only. This script
performs the checks JSON Schema CANNOT express and is the authoritative data
gate for CI. Run BOTH the schema and this file.

Run:  python3 validate_data.py
Exits 0 if all checks pass, 1 otherwise.
"""
import json, os, sys
from collections import Counter, defaultdict

COLORS = ["white", "blue", "green", "red", "black"]
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_PATH = os.path.join(HERE, "..", "splendor_data.json")
SCHEMA_PATH = os.path.join(HERE, "..", "splendor_data.schema.json")

failures = []
def check(cond, msg):
    print(("  PASS " if cond else "  FAIL ") + msg)
    if not cond:
        failures.append(msg)


def main():
    data = json.load(open(DATA_PATH))
    cards = data["cards"]
    nobles = data["nobles"]

    # Optional: run the JSON Schema too, if jsonschema is installed.
    try:
        import jsonschema
        jsonschema.validate(data, json.load(open(SCHEMA_PATH)))
        print("  PASS JSON Schema (structural) validates")
    except ImportError:
        print("  SKIP jsonschema not installed (pip install jsonschema) — structural check skipped")
    except Exception as e:
        check(False, f"JSON Schema validation: {e}")

    print("\n[cards] structure")
    check(len(cards) == 90, "exactly 90 cards")
    ids = [c["id"] for c in cards]
    check(sorted(ids) == list(range(1, 91)), "card ids are exactly 1..90 (unique, contiguous)")
    per_tier = Counter(c["tier"] for c in cards)
    check(per_tier.get(1) == 40 and per_tier.get(2) == 30 and per_tier.get(3) == 20,
          "tier split is 40 / 30 / 20")
    ptc = defaultdict(Counter)
    for c in cards:
        ptc[c["tier"]][c["bonus"]] += 1
    check(all(ptc[1][c] == 8 for c in COLORS), "tier 1: 8 cards per color")
    check(all(ptc[2][c] == 6 for c in COLORS), "tier 2: 6 cards per color")
    check(all(ptc[3][c] == 4 for c in COLORS), "tier 3: 4 cards per color")

    print("\n[cards] points & costs")
    dist = defaultdict(Counter)
    for c in cards:
        dist[c["tier"]][c["points"]] += 1
    check(dict(dist[1]) == {0: 35, 1: 5}, "tier 1 point distribution {0:35, 1:5}")
    check(dict(dist[2]) == {1: 10, 2: 15, 3: 5}, "tier 2 point distribution {1:10, 2:15, 3:5}")
    check(dict(dist[3]) == {3: 5, 4: 10, 5: 5}, "tier 3 point distribution {3:5, 4:10, 5:5}")
    check(sum(c["points"] for c in cards) == 140, "total prestige across all cards == 140")
    check(all(set(c["cost"].keys()) == set(COLORS) for c in cards), "every cost has exactly the 5 gem colors (no gold)")
    check(all(0 <= v <= 7 for c in cards for v in c["cost"].values()), "all cost values in 0..7")
    check(all(c["bonus"] in COLORS for c in cards), "all bonuses are valid gem colors")
    # official rulebook example card: Tier-3 blue, 4 pts, 6 white + 3 blue + 3 black
    example = [c for c in cards if c["tier"] == 3 and c["bonus"] == "blue" and c["points"] == 4
               and c["cost"] == {"white": 6, "blue": 3, "green": 0, "red": 0, "black": 3}]
    check(len(example) == 1, "official rulebook example card present (T3 blue, 4pt, 6w+3u+3k)")
    # tier-3 average = 4.0 (published)
    t3 = [c for c in cards if c["tier"] == 3]
    check(abs(sum(c["points"] for c in t3) / len(t3) - 4.0) < 1e-9, "tier-3 average points == 4.0")

    print("\n[nobles]")
    check(len(nobles) == 10, "exactly 10 nobles")
    check(sorted(n["id"] for n in nobles) == list(range(1, 11)), "noble ids are exactly 1..10")
    check(all(n["points"] == 3 for n in nobles), "every noble worth 3 points")
    shape_ok = True
    for n in nobles:
        vals = [n["requirement"][c] for c in COLORS]
        nonzero = [v for v in vals if v > 0]
        is_4_4 = (sorted(nonzero) == [4, 4])
        is_3_3_3 = (sorted(nonzero) == [3, 3, 3])
        if not (is_4_4 or is_3_3_3):
            shape_ok = False
    check(shape_ok, "every noble is exactly two colors x4 OR three colors x3")
    appearances = {c: sum(1 for n in nobles if n["requirement"][c] > 0) for c in COLORS}
    check(appearances == {c: 5 for c in COLORS}, f"noble color appearances symmetric (5 each); got {appearances}")

    print("\n[meta.checksums cross-check]")
    cs = data.get("meta", {}).get("checksums", {})
    if cs:
        check(cs.get("totalCards") == 90, "meta.checksums.totalCards == 90")
        check(cs.get("totalPrestigeOnAllCards") == 140, "meta.checksums.totalPrestige == 140")
        check(cs.get("nobleColorAppearances") == {c: 5 for c in COLORS}, "meta.checksums noble appearances == 5 each")
    else:
        print("  SKIP no meta.checksums present")

    print()
    if failures:
        print(f"RESULT: FAIL ({len(failures)} check(s) failed)")
        sys.exit(1)
    print("RESULT: PASS — all code-level data checks passed")
    sys.exit(0)


if __name__ == "__main__":
    main()
