# Back up the project to a git remote

Right now the project lives only on this Mac. If the disk fails, everything's gone — `DESIGN.md`, the code, the whole history. Setting up a **git remote** (usually GitHub) solves this: every `git push` makes a copy off-machine.

This file is written for someone who has never touched git before. Follow the steps in order.

---

## Option A — GitHub (most common, free for private repos)

### 1. Make a GitHub account (one-time)

If you don't already have one:
1. Open https://github.com/signup in a browser.
2. Use your personal email; pick any username; remember the password.
3. Verify the email GitHub sends you.

### 2. Install the GitHub CLI (one-time, per machine)

The CLI (`gh`) handles auth for you. Open **Terminal** on your Mac and paste:

```bash
# Install Homebrew (skip if you already have it — check with: brew --version)
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install GitHub CLI
brew install gh

# Log in (opens browser — click "Authorize")
gh auth login
```

When `gh auth login` asks you questions, the safe answers are:
- "Where do you use GitHub?" → **GitHub.com**
- "Preferred protocol for Git operations?" → **HTTPS**
- "Authenticate Git with your GitHub credentials?" → **Yes**
- "How would you like to authenticate?" → **Login with a web browser**

### 3. Create the repo and push (one-time)

Copy-paste the whole block:

```bash
cd "/Users/keatongodfrey/The Perfect Palace"

# Create a NEW PRIVATE repo on GitHub named "the-perfect-palace"
# and push the current branch to it.
gh repo create the-perfect-palace \
  --private \
  --source=. \
  --remote=origin \
  --push
```

If you'd rather call it something else, replace `the-perfect-palace` in both places.

When this finishes, open https://github.com/YOUR-USERNAME/the-perfect-palace in a browser to confirm the files are there.

### 4. From now on (every session, whenever you want a backup)

After making changes + committing locally, push them up:

```bash
cd "/Users/keatongodfrey/The Perfect Palace"
git push
```

That's it. `git push` is safe to run anytime — if there's nothing new, it says "Everything up-to-date" and does nothing.

---

## Option B — No GitHub account, still want off-machine backup

### Use iCloud Drive as a poor-man's remote

Not as clean as GitHub, but works without any accounts beyond iCloud:

```bash
# Create a bare-repo backup in your iCloud Drive (one-time).
cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/
mkdir -p git-backups
git clone --bare "/Users/keatongodfrey/The Perfect Palace" git-backups/the-perfect-palace.git

# Point the project at this clone as its remote.
cd "/Users/keatongodfrey/The Perfect Palace"
git remote add icloud ~/Library/Mobile\ Documents/com~apple~CloudDocs/git-backups/the-perfect-palace.git
```

Then from now on:

```bash
cd "/Users/keatongodfrey/The Perfect Palace"
git push icloud main
```

iCloud syncs the `.git` folder to Apple's servers in the background. Not as good as a real git host (no web UI, no collaborators), but better than nothing.

---

## Check your remote is set up

At any time, run:

```bash
cd "/Users/keatongodfrey/The Perfect Palace"
git remote -v
```

Empty output = no remote (disk failure = everything lost).
A line like `origin https://github.com/…` = you're backed up; push with `git push`.

---

## If something goes wrong

- **"gh: command not found"** — Homebrew install didn't run. Re-try step 2.
- **"remote: repository not found"** after setup** — you may have misspelled the repo name or aren't logged in. Run `gh auth status` to check.
- **"Updates were rejected"** on push — someone (maybe you) changed the remote directly. Run `git pull --rebase` then `git push` again.
- **Anything else** — paste the error into a new Claude session with a note "how do I fix this git error on The Perfect Palace?" — it will walk you through.
