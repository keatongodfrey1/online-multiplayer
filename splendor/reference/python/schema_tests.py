"""
Schema regression tests for ../splendor_data.schema.json.

Asserts the structural guarantees the schema MUST provide, and documents (as
informational output) the semantic checks it provably cannot express — those
are enforced by validate_data.py instead.

Run:  python3 schema_tests.py     (needs: pip install jsonschema)
Exits non-zero if a guaranteed rejection regresses.
"""
import json, os, copy, sys
try:
    import jsonschema
except ImportError:
    print("jsonschema not installed; run: pip install jsonschema")
    sys.exit(0)

HERE = os.path.dirname(os.path.abspath(__file__))
data = json.load(open(os.path.join(HERE, "..", "splendor_data.json")))
schema = json.load(open(os.path.join(HERE, "..", "splendor_data.schema.json")))


def accepts(mutate):
    d = copy.deepcopy(data)
    mutate(d)
    try:
        jsonschema.validate(d, schema)
        return True
    except jsonschema.ValidationError:
        return False


# (name, mutation, must_be_rejected)
MUST_REJECT = [
    ("baseline (unmodified) is valid", lambda d: None, False),   # must ACCEPT
    ("91 cards", lambda d: d["cards"].append(dict(d["cards"][0])), True),
    ("card points = 9", lambda d: d["cards"][0].__setitem__("points", 9), True),
    ("missing a cost color", lambda d: d["cards"][0]["cost"].pop("green"), True),
    ("extra cost color 'purple'", lambda d: d["cards"][0]["cost"].__setitem__("purple", 1), True),
    ("tier = 4", lambda d: d["cards"][0].__setitem__("tier", 4), True),
    ("bonus = 'gold'", lambda d: d["cards"][0].__setitem__("bonus", "gold"), True),
    ("noble points = 4", lambda d: d["nobles"][0].__setitem__("points", 4), True),
    # tightened-schema wins (these were ACCEPTED by the v2 schema):
    ("tier-1 card worth 5 points", lambda d: (d["cards"][0].__setitem__("tier", 1),
                                              d["cards"][0].__setitem__("points", 5)), True),
    ("noble requirement value of 2", lambda d: d["nobles"][0]["requirement"].__setitem__("white", 2), True),
]

# Documented gaps the schema CANNOT catch -> must be ACCEPTED here, caught by validate_data.py
DOCUMENTED_GAPS = [
    ("duplicate card id", lambda d: d["cards"][1].__setitem__("id", 1)),
    ("noble shape 4+4+4", lambda d: d["nobles"][0].__setitem__("requirement",
        {"white": 4, "blue": 4, "green": 4, "red": 0, "black": 0})),
    ("wrong tier split (39/31/20)", lambda d: d["cards"][0].__setitem__("tier", 2)),
]

failures = []
print("=== guaranteed schema behavior ===")
for name, mut, must_reject in MUST_REJECT:
    got_reject = not accepts(mut)
    ok = (got_reject == must_reject)
    print(f"  [{'ok' if ok else 'REGRESSION'}] {name}: "
          f"{'rejected' if got_reject else 'accepted'} (expected {'reject' if must_reject else 'accept'})")
    if not ok:
        failures.append(name)

print("\n=== documented gaps (schema accepts; validate_data.py catches these) ===")
for name, mut in DOCUMENTED_GAPS:
    print(f"  [info] {name}: {'accepted by schema (as documented)' if accepts(mut) else 'now rejected by schema (bonus!)'}")

print()
if failures:
    print(f"RESULT: FAIL — {len(failures)} schema guarantee(s) regressed")
    sys.exit(1)
print("RESULT: PASS — schema guarantees intact")
sys.exit(0)
