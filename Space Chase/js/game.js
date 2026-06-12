// ── Game State ──

const PLAYER_COLORS = ['#ff4444', '#4488ff', '#44dd44', '#ffdd00', '#cc44ff'];

const GameState = {
    players: [],
    currentPlayerIndex: 0,
    phase: 'setup'
};

// ── Setup ──

function initSetup() {
    generateStars();
    const countBtns = document.querySelectorAll('.player-count-btn');
    countBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            countBtns.forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            showPlayerNameInputs(parseInt(btn.dataset.count));
        });
    });
    document.getElementById('start-game').addEventListener('click', startGame);
    document.getElementById('play-again').addEventListener('click', resetGame);
    document.getElementById('end-game-btn').addEventListener('click', confirmEndGame);
}

function showPlayerNameInputs(count) {
    const container = document.getElementById('player-names');
    container.innerHTML = '';
    for (let i = 0; i < count; i++) {
        const div = document.createElement('div');
        div.className = 'player-name-input';
        div.innerHTML = `
            <span class="player-dot" style="background:${PLAYER_COLORS[i]}"></span>
            <input type="text" placeholder="Player ${i + 1}" data-player="${i}" maxlength="15">
        `;
        container.appendChild(div);
    }
    document.getElementById('start-game').style.display = 'inline-block';
}

function startGame() {
    const inputs = document.querySelectorAll('#player-names input');
    if (inputs.length === 0) return;

    GameState.players = [];
    inputs.forEach((input, i) => {
        GameState.players.push({
            id: i,
            name: input.value.trim() || ('Player ' + (i + 1)),
            color: PLAYER_COLORS[i],
            position: 0,        // 0 = START
            portal: null,       // null or { portalDef, progress, totalInternal, exitSpace, entrySpace, forward }
            justExitedPortal: false,
            lostTurns: 0,
            shieldTurns: 0,
            spaceSuit: false,
            extraTurns: 0,
            sixSevenCount: 0,
            lastAction: null
        });
    });

    GameState.currentPlayerIndex = 0;
    GameState.phase = 'playing';

    document.getElementById('setup-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'flex';

    initDeck();
    renderBoard();
    createRockets();
    updatePlayerPanel();
    updateDeckCount();

    setTimeout(() => {
        renderPortals();
        positionAllRockets();
    }, 100);

    // Remove old resize listener if exists, then add new one
    if (window._spaceChaseResizeHandler) {
        window.removeEventListener('resize', window._spaceChaseResizeHandler);
    }
    window._spaceChaseResizeHandler = () => {
        renderPortals();
        positionAllRockets();
    };
    window.addEventListener('resize', window._spaceChaseResizeHandler);

    startTurn();
}

// ── Turn System ──

function startTurn() {
    const player = GameState.players[GameState.currentPlayerIndex];
    player.justExitedPortal = false;
    updatePlayerPanel();

    // Check lost turns
    if (player.lostTurns > 0) {
        player.lostTurns--;
        showMessage(player.name + ' loses this turn! (' + player.lostTurns + ' left)');
        addToLog(player.name + ' skips a turn.');
        updatePlayerPanel();
        setTimeout(nextTurn, 1200);
        return;
    }

    const inPortal = player.portal !== null;
    const portalMsg = inPortal
        ? ' (in portal — ' + player.portal.progress + '/' + player.portal.totalInternal + ')'
        : '';

    showMessage(player.name + '\'s turn — Roll or Draw?' + portalMsg);
    document.getElementById('current-player-info').innerHTML =
        `<span class="player-dot" style="background:${player.color}"></span> ${player.name}'s Turn`;
    document.getElementById('dice-display').style.display = 'none';

    enableActions(true);
}

let actionSafetyTimer = null;

function enableActions(enabled) {
    document.getElementById('roll-dice-btn').disabled = !enabled;
    document.getElementById('draw-card-btn').disabled = !enabled;
    document.getElementById('roll-dice-btn').onclick = enabled ? onRollDice : null;
    document.getElementById('draw-card-btn').onclick = enabled ? onDrawCard : null;

    // Safety timeout: if actions are disabled for more than 30 seconds, re-enable them
    if (actionSafetyTimer) clearTimeout(actionSafetyTimer);
    if (!enabled) {
        actionSafetyTimer = setTimeout(() => {
            if (GameState.phase === 'playing' && !GameState.players.some(p => p.position >= TOTAL_SPACES)) {
                enableActions(true);
                showMessage('Actions re-enabled (safety timeout)');
            }
        }, 30000);
    }
}

function onRollDice() {
    enableActions(false);
    const player = GameState.players[GameState.currentPlayerIndex];
    const result = Math.floor(Math.random() * 6) + 1;

    let moveAmount = result;
    let msg = player.name + ' rolled a ' + result;

    if (player.spaceSuit) {
        player.spaceSuit = false;
        moveAmount = result * 2;
        msg += ' x2 (Space Suit) = ' + moveAmount;
    }

    addToLog(msg + '!');
    showMessage(msg + '!');

    player.lastAction = { type: 'dice', result: moveAmount };

    animateDice(result, () => {
        movePlayerBy(player, moveAmount, () => {
            afterAction(player);
        });
    });
}

function onDrawCard() {
    enableActions(false);
    const player = GameState.players[GameState.currentPlayerIndex];
    const card = drawCard();
    updateDeckCount();

    addToLog(player.name + ' drew ' + card.name + '!');

    // Don't overwrite lastAction for Time Loop — it needs the previous one
    if (card.type !== 'timeLoop') {
        player.lastAction = { type: 'card', cardId: card.id };
    }

    showCardModal(card, () => {
        resolveCard(card, player, () => {
            afterAction(player);
        });
    });
}

function afterAction(player) {
    // If player is in a portal, skip portal-entry check (they're already in one)
    if (player.portal) {
        updatePlayerPanel();
        checkWin(player);
        return;
    }

    // Check if player landed on a portal entrance
    // justExitedPortal stores the exit space number (not boolean) to only block that specific space
    if (player.justExitedPortal !== player.position) {
        const portalDef = findPortalBySpace(player.position);
        if (portalDef) {
            enterPortal(player, portalDef, () => {
                updatePlayerPanel();
                checkWin(player);
            });
            return;
        }
    }

    checkCollisions(() => {
        checkWin(player);
    });
}

// ── Collision Detection ──
// If 2+ players share the same board space (not START, not in portal), all go back to START

function checkCollisions(callback) {
    // Group players by position (exclude START=0 and players in portals)
    const byPosition = {};
    GameState.players.forEach(p => {
        if (p.position > 0 && p.position < TOTAL_SPACES && !p.portal) {
            if (!byPosition[p.position]) byPosition[p.position] = [];
            byPosition[p.position].push(p);
        }
    });

    // Find collisions (spaces with 2+ players)
    const collided = [];
    Object.entries(byPosition).forEach(([pos, players]) => {
        if (players.length >= 2) {
            players.forEach(p => collided.push(p));
        }
    });

    if (collided.length === 0) {
        callback();
        return;
    }

    // Send all collided players back to START
    const names = collided.map(p => p.name).join(' & ');
    addToLog('COLLISION! ' + names + ' are on the same space! Everyone involved goes back to Start!');
    showMessage('Collision! ' + names + ' go back to Start!');

    let idx = 0;
    function sendNext() {
        if (idx >= collided.length) {
            updatePlayerPanel();
            positionAllRockets();
            callback();
            return;
        }
        const p = collided[idx];
        idx++;
        p.portal = null;
        animateTeleport(p, 0, sendNext);
    }
    sendNext();
}

function checkWin(player) {
    // Check if multiple players reached finish (tie scenario from "move all" cards)
    const finishers = GameState.players.filter(p => p.position >= TOTAL_SPACES);

    if (finishers.length > 1) {
        // Tie! Multiple players reached finish — dice roll tiebreaker
        finishers.forEach(p => { p.position = TOTAL_SPACES; });
        positionAllRockets();
        GameState.phase = 'tiebreaker';
        enableActions(false); // Disable buttons during tiebreaker
        addToLog('TIE! ' + finishers.map(p => p.name).join(' & ') + ' reached the finish!');
        addToLog('Rolling dice to break the tie...');
        startTiebreaker(finishers);
        return;
    }

    if (finishers.length === 1) {
        finishers[0].position = TOTAL_SPACES;
        positionAllRockets();
        GameState.phase = 'gameover';
        addToLog('🏆 ' + finishers[0].name + ' WINS! 🏆');
        showWinScreen(finishers[0]);
        return;
    }

    nextTurn();
}

function startTiebreaker(finishers) {
    const rolls = {};
    let rollIndex = 0;

    function rollNext() {
        if (rollIndex >= finishers.length) {
            // All rolled — check for winner
            resolveTiebreaker(finishers, rolls);
            return;
        }

        const p = finishers[rollIndex];
        rollIndex++;
        const result = Math.floor(Math.random() * 6) + 1;
        rolls[p.id] = result;

        showMessage(p.name + ' rolls for the tiebreaker...');
        document.getElementById('current-player-info').innerHTML =
            `<span class="player-dot" style="background:${p.color}"></span> ${p.name}'s Tiebreaker Roll`;
        document.getElementById('dice-display').style.display = 'flex';

        animateDice(result, () => {
            addToLog(p.name + ' rolled a ' + result + '!');
            setTimeout(rollNext, 800);
        });
    }

    showMessage('Tiebreaker! Each player rolls a die — highest wins!');
    setTimeout(rollNext, 1000);
}

function resolveTiebreaker(finishers, rolls) {
    const maxRoll = Math.max(...finishers.map(p => rolls[p.id]));
    const winners = finishers.filter(p => rolls[p.id] === maxRoll);

    if (winners.length > 1) {
        // Still tied — roll again among tied players
        addToLog('Still tied! Rolling again...');
        setTimeout(() => startTiebreaker(winners), 800);
    } else {
        // We have a winner
        GameState.phase = 'gameover';
        addToLog('🏆 ' + winners[0].name + ' WINS the tiebreaker with a ' + maxRoll + '! 🏆');
        showWinScreen(winners[0]);
    }
}

function nextTurn() {
    const player = GameState.players[GameState.currentPlayerIndex];
    if (player.extraTurns > 0) {
        player.extraTurns--;
        addToLog(player.name + ' takes an extra turn! (' + player.extraTurns + ' remaining)');
        updatePlayerPanel();
        setTimeout(startTurn, 600);
    } else {
        GameState.currentPlayerIndex = (GameState.currentPlayerIndex + 1) % GameState.players.length;
        setTimeout(startTurn, 400);
    }
}

// ── Portal Logic ──

function enterPortal(player, portalDef, callback) {
    const forward = player.position === portalDef.a;
    const exitSpace = forward ? portalDef.b : portalDef.a;

    player.portal = {
        portalDef: portalDef,
        progress: 0,
        totalInternal: portalDef.internal,
        exitSpace: exitSpace,
        entrySpace: player.position,
        forward: forward
    };

    addToLog(player.name + ' enters a portal! Must travel ' + portalDef.internal + ' spaces to reach Space ' + exitSpace + '.');
    showMessage('Portal entered! ' + portalDef.internal + ' spaces to Space ' + exitSpace);
    positionAllRockets();
    callback();
}

function moveInPortal(player, amount, callback) {
    const portal = player.portal;
    const fromProgress = portal.progress;
    const newProgress = portal.progress + amount;

    if (newProgress > portal.totalInternal) {
        // Exit at the far end — exiting costs 1 move (so subtract totalInternal + 1)
        const overflow = newProgress - portal.totalInternal - 1;
        const exitSpace = portal.exitSpace;

        // Animate to exit
        animatePortalMove(player, fromProgress, portal.totalInternal, () => {
            player.portal = null;
            player.position = exitSpace;
            player.justExitedPortal = exitSpace;
            addToLog(player.name + ' exits the portal at Space ' + exitSpace + '!');
            positionAllRockets();

            if (overflow > 0) {
                movePlayerBy(player, overflow, callback);
            } else {
                callback();
            }
        });
    } else if (newProgress === portal.totalInternal) {
        // Reached last internal space but haven't exited yet (exit costs 1 more move)
        animatePortalMove(player, fromProgress, newProgress, () => {
            addToLog(player.name + ' reaches the portal exit! 1 more move to exit at Space ' + portal.exitSpace);
            callback();
        });
    } else if (newProgress < 0) {
        // Exit back at the entry — exiting costs 1 move
        const overflow = newProgress + 1; // negative (add 1 since exit costs a move)
        const entrySpace = portal.entrySpace;

        animatePortalMove(player, fromProgress, 0, () => {
            player.portal = null;
            player.position = entrySpace;
            player.justExitedPortal = entrySpace;
            addToLog(player.name + ' exits the portal back at Space ' + entrySpace + '!');
            positionAllRockets();

            if (overflow < 0) {
                movePlayerBy(player, overflow, callback);
            } else {
                callback();
            }
        });
    } else {
        // Stay in portal
        animatePortalMove(player, fromProgress, newProgress, () => {
            addToLog(player.name + ' moves to portal space ' + newProgress + '/' + portal.totalInternal);
            callback();
        });
    }
}

// ── Movement Helpers ──

function movePlayerBy(player, amount, callback) {
    // If player is in a portal, move through portal spaces
    if (player.portal) {
        moveInPortal(player, amount, callback);
        return;
    }

    // If a non-active player is sitting on a portal endpoint (e.g., from a "move all" card),
    // enter the portal first then move through it.
    // Don't auto-enter if this is the active player's own turn — afterAction handles that.
    const isActivePlayer = (GameState.players[GameState.currentPlayerIndex] === player);
    if (amount > 0 && !isActivePlayer && player.justExitedPortal !== player.position) {
        const portalDef = findPortalBySpace(player.position);
        if (portalDef) {
            enterPortal(player, portalDef, () => {
                moveInPortal(player, amount, callback);
            });
            return;
        }
    }

    const from = player.position;
    let to = from + amount;
    to = Math.max(0, to); // Can go back to START (0)
    to = Math.min(to, TOTAL_SPACES);

    if (from === 0 && amount > 0) {
        // Starting from START: move onto the board
        player.position = 1;
        positionAllRockets();
        to = Math.min(amount, TOTAL_SPACES);
    }

    const dir = amount >= 0 ? 'moves forward' : 'goes back';
    showMessage(player.name + ' ' + dir + ' ' + Math.abs(amount) + ' spaces');
    animateMovement(player, player.position || 1, to, callback);
}

function teleportPlayer(player, dest, callback) {
    // Exit portal if in one
    if (player.portal) player.portal = null;
    // Teleports always allow portal entry at destination
    player.justExitedPortal = false;

    if (dest === 0) {
        addToLog(player.name + ' is sent back to Start!');
    } else {
        addToLog(player.name + ' teleports to Space ' + dest + '!');
    }
    animateTeleport(player, dest, callback);
}

function moveAllPlayers(amount, callback) {
    let idx = 0;
    function moveNext() {
        if (idx >= GameState.players.length) {
            callback();
            return;
        }
        const p = GameState.players[idx];
        idx++;
        if (p.position === 0 && !p.portal && amount < 0) {
            moveNext();
            return;
        }
        movePlayerBy(p, amount, moveNext);
    }
    moveNext();
}

function moveAllPlayersExcept(excludePlayer, amount, callback) {
    let idx = 0;
    function moveNext() {
        if (idx >= GameState.players.length) {
            callback();
            return;
        }
        const p = GameState.players[idx];
        idx++;
        if (p === excludePlayer || (p.position === 0 && !p.portal && amount < 0)) {
            moveNext();
            return;
        }
        movePlayerBy(p, amount, moveNext);
    }
    moveNext();
}

// ── End Game / Reset ──

function confirmEndGame() {
    if (confirm('End the current game and return to setup?')) {
        resetGame();
    }
}

function resetGame() {
    document.getElementById('win-screen').style.display = 'none';
    document.getElementById('game-screen').style.display = 'none';
    document.getElementById('setup-screen').style.display = 'flex';
    document.getElementById('turn-log').innerHTML = '';
    GameState.phase = 'setup';
    GameState.currentPlayerIndex = 0;
}

// ── Init ──

document.addEventListener('DOMContentLoaded', initSetup);
