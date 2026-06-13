# Resuming The Perfect Palace

Start a new Claude Code session with this exact prompt (copy-paste):

```
I'm resuming work on The Perfect Palace, a React + TypeScript web board game
I'm building with my 11-year-old daughter. Three playtest rounds have shipped
— check `git log --oneline | head -10` and `head -40 CHANGELOG.md` for recent
phase history.

**Read these first, in order, before anything else:**
1. /Users/keatongodfrey/The Perfect Palace/DESIGN.md — every rule and decision.
   Look for `(revised YYYY-MM-DD)` stamps to see what's changed in recent rounds.
2. /Users/keatongodfrey/The Perfect Palace/CHANGELOG.md — phase-by-phase history.
3. /Users/keatongodfrey/The Perfect Palace/RESUME.md — this handoff + gotchas.
4. /Users/keatongodfrey/The Perfect Palace/README.md — codebase map.

Also load the project memory from:
/Users/keatongodfrey/.claude/projects/-Users-keatongodfrey-The-Perfect-Palace/memory/

After reading, confirm with one sentence ("Ready — caught up.") and wait for
my next instruction. Do NOT re-summarize the files.

**Ground rules:**

*Tooling*
- `bun` at /Users/keatongodfrey/.bun/bin/bun — node/npm are NOT installed.
- `bun run check` = typecheck + tests + build; must be green before every commit.
- `bun run dev` → http://localhost:5173 for manual verification of UI changes.

*Palace theming (never break these)*
- Bailiff (not Robber), Dungeon (not Jail), Neighboring Kingdom (not US),
  Invading armies (not War), Royal Pardon (not "get out of jail").

*How we collaborate*
- DESIGN.md is the source of truth. When a rule changes, update DESIGN.md
  surgically (Edit, not rewrite) with a `(revised YYYY-MM-DD)` date stamp.
- When I report a bug or propose a change, **explain it back with edge cases
  walked BEFORE coding.** I often follow up with "review your plan with
  extreme skepticism; what's missing?" — always do a hard self-review pass
  before shipping. Surface gaps you'd be worried about, each with a planned
  handling.
- Use AskUserQuestion to clarify ambiguous choices (forfeit order, which
  squares a rule applies to, etc.).
- Don't cut corners. If something's blocked, tell me — don't silently skip.
- Implement thoroughly: edge cases, empty states, interactions between the
  features I've asked about in the same round.

*Testing*
- All reducer rule changes get tests in src/game/reducer.test.ts.
- UI-only changes are manual-verified in the dev server; there's no UI test
  framework. Say so explicitly rather than claiming UI success from tests
  alone.

*Commit hygiene (at phase boundaries)*
1. `bun run check` — must be green.
2. Docs-sync pass: grep README.md / RESUME.md / memory/*.md / RulesModal.tsx
   for stale rule claims (old insolvency text, old prereq wording, etc.) and
   update in the SAME commit.
3. Commit with a clear multi-line message — bullet per bug/change, each with
   the "why" not just the "what". Match prior commit style via
   `git log --format=full -1`. Always include the Co-Authored-By trailer.
4. One commit per bundled round, not per-file.

*When stuck*
- For quick current-state check: `git log --oneline | head -5` +
  `bun run check` + skim last CHANGELOG entry.
- If you touch the reducer, run tests early and often — the reducer is the
  source of authority and every rule has coverage.
```

---

## Current status

For the always-current picture, run:

```bash
git log --oneline | head -10   # phase history
cat CHANGELOG.md               # human-readable summary
bun run check                  # typecheck + tests + build — must be green
```

The design and rules live in `DESIGN.md` (source of truth). Everything else in this file is a pointer, not an assertion.

---

## Safety net

- **Git remote**: run `cat REMOTE_SETUP.md` for instructions to back up to GitHub / similar. Without a remote, a disk failure loses everything.
- **Local save (playtest progress)**: lives in the browser's `localStorage` under the key `tpp:autosave`. Not portable between machines.
- **Session transcript**: `claude --resume` in this directory restores the last conversation. The transcript file is `~/.claude/projects/-Users-keatongodfrey-The-Perfect-Palace/*.jsonl`.

---

## Known gotchas when editing the reducer

- `state.duel` is `DuelState | undefined` — extract into a local `existing` after the null check or TS narrowing will drop.
- Palace theme terms are already globally applied; do NOT reintroduce Robber / Jail / US / War / Get-out-of-Jail.
- Phase transitions happen in `advanceAfterSquare(state)`; alliance and gift choices call it after dispatch. `pendingDecision(state)` holds phase for alliance-when-not-allied and bricks-or-wall squares.
- Multi-player "draw a card" follows clockwise from the current roller (implemented in `distributeResources`).
- Card #17 (Royal Pardon) has an early return in `applyCardEffect` — it must NOT go to the discard when drawn; only on redemption.
- `imprisonedAndLocked(state)` gates optional actions. Mid-turn dungeon entries (flag `turn.enteredDungeonThisTurn`) still finish their current turn normally.
- The duel uses `contenders: PlayerId[]` — tied players re-roll, non-tied are eliminated. See `reducer.test.ts > Same-square duel > ties`.

---

## File map (quick recall)

```
The Perfect Palace/
├── DESIGN.md              source of truth for game rules
├── CHANGELOG.md           phase history (MVP → audit → tests → docs sync …)
├── RESUME.md              this file
├── README.md              codebase map + how to run
├── REMOTE_SETUP.md        steps to add a git remote
├── package.json           bun + React + Vite + TS + vitest
├── vite.config.ts
├── tsconfig*.json
├── index.html
├── public/crown.svg       favicon
├── src/
│   ├── main.tsx
│   ├── App.tsx            phase router
│   ├── App.css
│   ├── index.css          global palette + typography
│   ├── game/
│   │   ├── types.ts
│   │   ├── board.ts
│   │   ├── cards.ts
│   │   ├── constants.ts
│   │   ├── scoring.ts
│   │   ├── actions.ts
│   │   ├── reducer.ts     source of authority for all gameplay logic
│   │   ├── reducer.test.ts tests for every rule in DESIGN.md
│   │   └── store.tsx      Context + useReducer + localStorage
│   └── components/        UI — see README.md for one-line-per-file map
```

---

## Quick commands

```bash
cd "/Users/keatongodfrey/The Perfect Palace"

# Install (first time after git clone)
/Users/keatongodfrey/.bun/bin/bun install

# Dev (http://localhost:5173/)
/Users/keatongodfrey/.bun/bin/bun run dev

# Pre-commit smoke test
/Users/keatongodfrey/.bun/bin/bun run check
```
