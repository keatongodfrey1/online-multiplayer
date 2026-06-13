export function RulesModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rules-modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>📖 The Perfect Palace — Rules</h2>
          <button className="small ghost" onClick={onClose}>
            ✕ Close
          </button>
        </header>
        <div className="rules-body">
          <h3>🎯 Goal</h3>
          <p>
            Build a <strong>Palace</strong> (540 bricks + 135 sticks worth of construction). The
            first palace triggers the end of the game. Every player gets the same number of turns;
            highest points wins.
          </p>

          <h3>🎴 Resource Card</h3>
          <p>
            Each player's card maps each die face (1–6) to exactly one of six outcomes:{' '}
            <em>5 sticks · 5 bricks · 10 bricks · $5 · $10 · Draw a card</em>. Every outcome appears
            <strong> exactly once</strong> — when any player rolls, each player gets the outcome
            their own card assigns to that number. Pass or land on Start to earn a 1-slot swap:
            picking a new outcome for a face swaps it with wherever that outcome currently lives, so
            the one-to-one mapping is always preserved.
          </p>

          <h3>🎲 A Turn</h3>
          <ol>
            <li>
              If you hold the Bailiff from a prior turn, you may steal one item from any player
              (not Knight-holders) <em>before</em> rolling.
            </li>
            <li>Roll the die.</li>
            <li>
              Every player gains what their Resource Card says for that number. "Draw a card"
              makes them draw instead.
            </li>
            <li>You move clockwise by the rolled number, trigger the square's effect.</li>
            <li>If other players share your square, a mandatory duel resolves (stake + rolls).</li>
            <li>If you just acquired the Bailiff, you may steal after rolling.</li>
            <li>Buy / trade / build as much as you want. Then end turn.</li>
          </ol>

          <h3>🏗 Construction Ladder</h3>
          <ul>
            <li>5 bricks → 1 Wall</li>
            <li>5 sticks → 1 Roof</li>
            <li>4 Walls + 1 Roof → 1 Room (5 pts)</li>
            <li>3 Rooms + any Staff → 1 Building (20 pts)</li>
            <li>3 Buildings + Server + Chef + Cleaner (or WHC) → 1 Three-Story Building (75 pts)</li>
            <li>3 Three-Story Buildings → 1 Palace (300 pts) 🏰</li>
          </ul>

          <h3>🛍 Shop (on your turn)</h3>
          <ul>
            <li>Brick / Stick: $1 each</li>
            <li>Worker: $50 — at the start of each of your turns, produces 2 walls OR 1 wall + 1 roof (auto). 5 pts. No benefit on the acquisition turn.</li>
            <li>Server: $15 (needs ≥1 Room, Building, 3-Story, or Palace) — 5 pts</li>
            <li>Chef: $30 (needs ≥1 Room, Building, 3-Story, or Palace) — 10 pts</li>
            <li>Cleaner: $20 (needs ≥1 Room, Building, 3-Story, or Palace) — 5 pts; every 5 Cleaners + Building → 1 Whole House Cleaner (50 pts, +$15 at the start of each of your turns; no benefit on the conversion turn)</li>
            <li>Knight: $75 — protects from the Bailiff forever (max 1, 5 pts)</li>
            <li>Queen: $300 — a regal piece (max 1, 200 pts; tiebreaker weight 10)</li>
          </ul>

          <h3>🤝 The Kingdom Alliance</h3>
          <p>
            At squares #3 or #20 (or Card #14), ally with the Neighboring Kingdom by paying bricks
            + sticks. Alliance is permanent and waives all tribute payments at Invasion squares
            (#7, #28). If you're already allied when you land on an offer square, you receive the
            bricks + sticks for free!
          </p>

          <h3>🪙 The Bailiff (a.k.a. the tax-man)</h3>
          <p>
            Claim the Bailiff by landing on #5, #13, or #27, or drawing Card #18. On each of your
            turns you may take from any opponent (who doesn't own a Knight): 1 wall, 1 roof, 5
            bricks, 5 sticks, or $5. Default timing: before you roll. On the turn you first get
            it, you steal <em>after</em> rolling. If you're sent to the dungeon, the Bailiff
            returns to the middle of the board.
          </p>

          <h3>⛓ The Dungeon</h3>
          <p>
            Landing on #10 (Royal Court) sends you to the dungeon — the only path there now.
            (#7/#28 Invasion squares no longer send insolvent players to the dungeon; they use
            a cash-first, then item-forfeit dialog — see Money fines below.) While imprisoned:
            no moving, trading, buying, building, or Bailiff stealing.
            Worker and Whole House Cleaner abilities are suspended. You still receive resources
            from others' rolls. To escape: roll a 1 on any of your 3 dungeon turns, or wait out
            the 3rd turn. Alternatively, redeem a Royal Pardon card for a full normal turn.
          </p>

          <h3>💸 Money fines (#7, #11, #28)</h3>
          <p>
            Cash is taken first. If you can't cover the fine, you forfeit items to make up the
            rest: 1 brick = 1 stick = $1, 1 wall = 1 roof = $5. Rooms, Buildings, 3-Story
            Buildings, Palaces, Staff, and the Bailiff are never taken. If you have nothing left
            to forfeit, the fine is partially stiffed — no further penalty.
          </p>

          <h3>⚔️ Same-Square Duel</h3>
          <p>
            Landing on a square with others triggers a mandatory duel. The arriver sets a stake
            (minimum: $5, 5 bricks, 5 sticks, or 1 item). Everyone matches, each rolls the die,
            highest roll takes the pot. Queens don't protect from duels.
          </p>

          <h3>🏁 Game End & Tiebreaker</h3>
          <p>
            First palace triggers end-of-game. Every player gets the same number of base turns
            (extras from square #24 don't count). Tiebreaker: total staff count (Queen = 10, WHC
            = 5, others = 1), then most cash.
          </p>
        </div>
      </div>
    </div>
  )
}
