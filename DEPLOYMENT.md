# Deployment

Two ways to play with friends:

1. **Same room / same Wi-Fi** - run it on your computer, free, instant.
2. **Over the internet** - host it on Render's free tier (no credit card).

---

## Playing on your home Wi-Fi

1. Run `npm run dev` in the project folder.
2. Find your computer's local address:
   - **Mac**: System Settings -> Wi-Fi -> Details... -> IP Address (looks like `192.168.1.23`)
   - **Windows**: open Command Prompt, type `ipconfig`, look for "IPv4 Address"
3. On each phone/laptop (same Wi-Fi), open `http://<that address>:5173`,
   e.g. `http://192.168.1.23:5173`.
4. If nothing loads, your firewall is probably asking the computer running
   the server for permission - accept the prompt (allow Node), then retry.

The website automatically talks to the game server on the same address;
no configuration needed.

---

## Hosting on the internet (Render free tier)

The repository already contains the full configuration (`render.yaml`).
You only click through Render's setup once; afterwards every push to the
repo redeploys automatically.

### One-time setup (~10 minutes)

1. Make sure the project is pushed to your GitHub repository.
2. Go to **https://render.com** and click **Get Started** -> **Sign in
   with GitHub**. No credit card is required for the free tier.
3. In the Render dashboard click **New +** (top right) -> **Blueprint**.
4. Connect your GitHub account if asked, then pick this repository
   (`online-multiplayer`). Render reads `render.yaml` automatically.
5. Click **Apply** / **Deploy**. The first build takes a few minutes -
   you'll see a log scrolling. Done = a green "Live" badge.
6. Your game is now at `https://game-night.onrender.com` (Render may add
   a random suffix, e.g. `game-night-x3k2.onrender.com` - the exact URL
   is shown at the top of the service page).

Share that URL with friends. That's it - one URL serves both the website
and the game connection.

### Updating the game later

Push to the repository's default branch (or merge a PR into it). Render
rebuilds and redeploys automatically in a few minutes. **Anyone mid-game
during a deploy loses that game** (see limitations in the README), so
deploy when nobody's playing.

### Things to know about the free tier

- **It sleeps.** After ~15 minutes with no visitors the service spins
  down; the next visitor waits up to a minute while it wakes. Tip: open
  the site yourself a minute before telling friends to join.
- **Sleeping ends games.** Spin-down is a restart - active games are
  gone afterwards (in-memory state).
- 750 free hours/month - more than enough for one always-on-ish service.

### If a deploy fails

Open the failed deploy in Render, copy the red error text from the log,
and paste it to your AI assistant with: "This Render deploy failed, here
is the log." The same goes for the GitHub Actions "CI" check on the repo -
a red X means the tests caught something; open the failed job, copy the
log, paste it to your assistant.

### Verifying a fresh deployment (do once)

0. From the project folder, run the automated check against the live
   service (replace the URL with yours):

   ```bash
   npm run smoke -- https://game-night.onrender.com
   ```

   It plays both games end-to-end with simulated players - 16 checks,
   including reconnection - and prints what passed.
1. On your phone **using mobile data (Wi-Fi off)**, open the URL and
   create a Dot Arena game.
2. Join from a laptop with the code, start, move both players.
3. Lock the phone for ~10 seconds, unlock - it should say
   "Reconnecting..." and drop you back into the game.
4. Leave a Tic-Tac-Toe room idle for 10+ minutes mid-game, then make a
   move - it should still work (checks that the host doesn't kill quiet
   connections).
