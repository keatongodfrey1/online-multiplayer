# Game Night - online multiplayer game framework

A reusable backbone for browser games where **every player plays on their
own phone or laptop** (like Jackbox): the host creates a game and gets a
4-letter code, friends open the website, type the code and a nickname,
and they're in. No accounts, no installs.

Built on [Colyseus](https://colyseus.io) 0.17. Two complete games are
included as working references:

| Game | Style | Demonstrates |
|---|---|---|
| **Tic-Tac-Toe** | turn-based (like Splendor/Catan) | turn manager, timeouts, win/draw, rematch |
| **Dot Arena** | real-time (like paper.io) | 20Hz server tick loop, continuous input, late join |

New games copy these patterns - see [ADDING_A_GAME.md](ADDING_A_GAME.md).

## What the framework gives every game for free

- **Join by code**: 4-letter room codes, private rooms, friendly errors
  (wrong code, full room, duplicate nickname, game already started)
- **Lobby**: live roster, host controls (start, kick), host migration if
  the host leaves
- **Reconnection**: a player who refreshes, loses signal, or locks their
  phone keeps their seat for a grace period (60s in-game / 30s in lobby)
  and is dropped back exactly where they were
- **Game over + rematch**: result banner, unanimous-vote rematch
- **Server-authoritative play**: all rules run on the server; clients
  only send inputs, so players can't cheat by editing their browser
- **Anti-abuse basics**: concurrent-room cap, per-client message rate
  limit, server-side validation of every message

## Run it locally

Requires [Node.js 22](https://nodejs.org). Then:

```bash
npm install
npm run dev
```

Open http://localhost:5173 in two browser windows and play against
yourself. Phones on the same Wi-Fi can join too - see
[DEPLOYMENT.md](DEPLOYMENT.md#playing-on-your-home-wi-fi) for the
one-step LAN guide.

## Put it on the internet

The repo deploys to [Render](https://render.com)'s free tier (no credit
card) as a single service in a few clicks - the full walkthrough is in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | run server (:2567) + website (:5173) with live reload |
| `npm test` | run the full automated test suite |
| `npm run typecheck` | type-check all packages |
| `npm run build` | typecheck + build the production website |
| `npm start` | run the production server (serves the built website too) |
| `npm run smoke` | drive real game clients through both games against a running server (`npm run smoke -- https://your-app.onrender.com` tests the deployed one) |

## Manual smoke test (after any big change)

1. `npm run dev`, open two browser windows at http://localhost:5173.
2. Window A: create Tic-Tac-Toe as "Ann". Window B: join with the code as "Ben".
3. Start the game, play a few moves; **refresh window B mid-game** - it must
   return to the same game with the same seat within a few seconds.
4. Finish the game; both press "Play again"; the board must reset.
5. Repeat 2-3 with Dot Arena (arrows/WASD to move; phone: drag on the field).

## Honest limitations (by design, for now)

- **Games live in server memory.** A server restart, redeploy, or free-tier
  spin-down ends all active games. Players see "Game not found - the game
  may have ended" and can start a new one. Fine for casual play; persistent
  games would need a database layer.
- **Render free tier sleeps** after ~15 idle minutes and takes up to a
  minute to wake. Open the site yourself before inviting friends.
- **One server process.** The room-code registry and room cap use
  in-process storage. Scaling to multiple processes needs RedisPresence
  (a documented Colyseus upgrade path) - irrelevant until you have
  hundreds of simultaneous players.
- **No accounts.** Identity is per-device (a stored reconnection token).
  Stats/profiles across games would be a future layer.

## Project layout

```
shared/   types, constants, and schema (synced state) for server + client
server/   Colyseus server: framework/ (the backbone) + games/ (one dir per game)
client/   the website: framework/ (connection, session) + lobby/ + games/
```

Read [ARCHITECTURE.md](ARCHITECTURE.md) for how it all fits together, and
[ADDING_A_GAME.md](ADDING_A_GAME.md) to build the next game.
