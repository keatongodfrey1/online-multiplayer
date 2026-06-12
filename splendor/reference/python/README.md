# tests/ — validation & reference bundle for the Splendor clone

Stdlib Python (only `jsonschema` is needed, and only for the schema checks):

```bash
pip install jsonschema
```

| File | What it does | CI use |
|---|---|---|
| `validate_data.py` | **Authoritative data gate.** Code-level checks the JSON Schema *cannot* express: unique card ids, 40/30/20 tier split, 8/6/4 per-color counts, exact point distributions, total prestige = 140, the official example card, the exact noble shape (2×4 or 3×3), symmetric noble colors, and a `meta.checksums` cross-check. Also runs the schema if `jsonschema` is installed. | **Run in CI.** Exit 0 = pass. |
| `schema_tests.py` | Regression test for `../splendor_data.schema.json`: asserts the structural rejections it must provide, and prints the documented gaps it cannot catch (which `validate_data.py` covers). | Run in CI. Exit 0 = pass. |
| `reference_engine.py` | A compact, dependency-free **rules oracle** implementing SPEC §1–§12 exactly one way, with full invariant checks (including **non-negativity**). | Imported by `fuzz.py`. |
| `fuzz.py` | Plays thousands of greedy + random games, asserting every invariant on every step and checking termination. Caught a real accounting bug during development. | Run in CI (quick mode). |

```bash
python3 validate_data.py        # data integrity (exit non-zero on failure)
python3 schema_tests.py         # schema guarantees
python3 fuzz.py                 # quick fuzz (1200 greedy / 120 random per player count)
python3 fuzz.py 5000 2000       # heavier fuzz
```

### Notes
- **The schema is structural only.** Always run `validate_data.py` *in addition to*
  JSON Schema validation; several invariants (unique ids, tier split, per-color
  counts, noble shape) are not expressible in JSON Schema.
- **Reference oracle:** `reference_engine.py` is a faithful *rules* reference. To use
  it as a byte-for-byte oracle against the production (TypeScript) engine — replay the
  same `(seed, moves)` and diff states — both engines must pin the **same seeded PRNG
  and shuffle algorithm** (SPEC §9/§12/§13). Otherwise the card order will differ even
  though both are "correct."
- **Why random games sometimes hit the turn cap:** Splendor has no intrinsic progress
  guarantee, so an agent can cycle tokens forever. The turn cap is a *required*
  backstop (SPEC §9), which the fuzz run demonstrates.
