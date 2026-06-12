// ── UI Module: DOM manipulation, modals, animations ──

// ── Message / Log ──

function addToLog(msg) {
    const log = document.getElementById('turn-log');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = msg;
    log.prepend(entry);
    while (log.children.length > 50) log.removeChild(log.lastChild);
}

function showMessage(msg) {
    document.getElementById('message-area').textContent = msg;
}

// ── Player Panel ──

function updatePlayerPanel() {
    const panel = document.getElementById('player-status-panel');
    panel.innerHTML = '';
    GameState.players.forEach((p, i) => {
        const div = document.createElement('div');
        div.className = 'player-status' + (i === GameState.currentPlayerIndex ? ' active-player' : '');
        let statusIcons = '';
        if (p.shieldTurns > 0) statusIcons += ' 🛡️' + p.shieldTurns;
        if (p.spaceSuit) statusIcons += ' 🧑‍🚀';
        if (p.lostTurns > 0) statusIcons += ' ⏸️' + p.lostTurns;
        if (p.extraTurns > 0) statusIcons += ' ⚡' + p.extraTurns;

        let posText;
        if (p.portal) {
            posText = 'Portal (' + p.portal.progress + '/' + p.portal.totalInternal + ')';
        } else if (p.position === 0) {
            posText = 'Start';
        } else {
            posText = 'Space ' + p.position;
        }

        div.innerHTML = `
            <span class="player-dot" style="background:${p.color}"></span>
            <span class="player-name">${p.name}</span>
            <span class="player-pos">${posText}</span>
            <span class="player-status-icons">${statusIcons}</span>
        `;
        panel.appendChild(div);
    });
}

function updateDeckCount() {
    const el = document.getElementById('deck-count');
    if (el) el.textContent = '🃏 ' + deck.length + ' cards left';
}

// ── Rocket Rendering ──

function createRockets() {
    const container = document.getElementById('board-container');
    container.querySelectorAll('.rocket').forEach(r => r.remove());

    GameState.players.forEach(p => {
        const rocket = document.createElement('div');
        rocket.className = 'rocket';
        rocket.id = 'rocket-' + p.id;
        rocket.style.setProperty('--color', p.color);
        rocket.style.background = p.color;
        const initial = p.name.charAt(0).toUpperCase();
        rocket.innerHTML = `<span class="rocket-icon">🚀</span><span class="rocket-initial">${initial}</span>`;
        container.appendChild(rocket);
    });
    positionAllRockets();
}

function positionAllRockets() {
    const board = document.getElementById('board');
    const boardRect = board.getBoundingClientRect();
    const containerRect = document.getElementById('board-container').getBoundingClientRect();
    const offX = boardRect.left - containerRect.left;
    const offY = boardRect.top - containerRect.top;

    // Group players by visual key (position or portal state)
    const groups = {};
    GameState.players.forEach(p => {
        let key;
        if (p.portal) {
            key = 'portal-' + PORTALS.indexOf(p.portal.portalDef) + '-' + p.portal.progress;
        } else {
            key = 'pos-' + p.position;
        }
        if (!groups[key]) groups[key] = [];
        groups[key].push(p);
    });

    const offsets = [
        { dx: 0, dy: 0 },
        { dx: 12, dy: -8 },
        { dx: -12, dy: -8 },
        { dx: 12, dy: 8 },
        { dx: -12, dy: 8 }
    ];

    Object.entries(groups).forEach(([key, players]) => {
        players.forEach((p, idx) => {
            const rocket = document.getElementById('rocket-' + p.id);
            if (!rocket) return;

            const off = offsets[idx] || { dx: 0, dy: 0 };

            // Player is inside a portal
            if (p.portal) {
                const portalIdx = PORTALS.indexOf(p.portal.portalDef);
                const t = p.portal.totalInternal > 0 ? p.portal.progress / p.portal.totalInternal : 0;
                const pos = getPortalPixelPosition(portalIdx, t, p.portal.forward);
                rocket.style.left = (offX + pos.x + off.dx - 12) + 'px';
                rocket.style.top = (offY + pos.y + off.dy - 12) + 'px';
                return;
            }

            // Player at START (position 0)
            if (p.position === 0) {
                const startEl = document.getElementById('start-space');
                if (startEl) {
                    const sr = startEl.getBoundingClientRect();
                    const startPlayers = GameState.players.filter(pl => pl.position === 0 && !pl.portal);
                    const myIdx = startPlayers.indexOf(p);
                    const total = startPlayers.length;
                    // Spread rockets evenly across the start box
                    const spacing = sr.width / (total + 1);
                    const cx = sr.left - containerRect.left + spacing * (myIdx + 1);
                    const cy = sr.top - containerRect.top + sr.height / 2;
                    rocket.style.left = (cx - 15) + 'px';
                    rocket.style.top = (cy - 15) + 'px';
                }
                return;
            }

            // Player on a board space
            const spaceEl = document.getElementById('space-' + p.position);
            if (!spaceEl) return;
            const sr = spaceEl.getBoundingClientRect();
            const cx = sr.left - containerRect.left + sr.width / 2;
            const cy = sr.top - containerRect.top + sr.height / 2;
            rocket.style.left = (cx + off.dx - 15) + 'px';
            rocket.style.top = (cy + off.dy - 15) + 'px';
        });
    });
}

// ── Movement Animation ──

function animateMovement(player, from, to, callback) {
    // Handle START (0) boundaries
    const animFrom = Math.max(1, from);
    const animTo = Math.max(1, to);

    if (animFrom === animTo) {
        player.position = to;
        positionAllRockets();
        callback();
        return;
    }

    const step = animFrom < animTo ? 1 : -1;
    let current = animFrom;

    function doStep() {
        if (current === animTo) {
            player.position = to; // Final position (could be 0 for START)
            positionAllRockets();
            callback();
            return;
        }
        current += step;
        player.position = current;
        positionAllRockets();
        setTimeout(doStep, 150);
    }
    doStep();
}

// ── Portal Movement Animation ──

function animatePortalMove(player, fromProgress, toProgress, callback) {
    const step = fromProgress < toProgress ? 1 : -1;
    let current = fromProgress;

    function doStep() {
        if (current === toProgress) {
            player.portal.progress = toProgress;
            positionAllRockets();
            updatePlayerPanel();
            callback();
            return;
        }
        current += step;
        player.portal.progress = current;
        positionAllRockets();
        setTimeout(doStep, 200);
    }
    doStep();
}

// ── Teleport animation (instant jump with flash) ──

function animateTeleport(player, dest, callback) {
    const rocketEl = document.getElementById('rocket-' + player.id);
    if (rocketEl) rocketEl.classList.add('teleporting');
    setTimeout(() => {
        player.position = dest;
        positionAllRockets();
        if (rocketEl) rocketEl.classList.remove('teleporting');
        callback();
    }, 400);
}

// ── Dice Display ──

const DICE_FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

function animateDice(result, callback) {
    const display = document.getElementById('dice-display');
    display.style.display = 'flex';
    display.classList.remove('dice-landed');
    let count = 0;
    const interval = setInterval(() => {
        display.textContent = DICE_FACES[Math.floor(Math.random() * 6)];
        count++;
        if (count > 12) {
            clearInterval(interval);
            display.textContent = DICE_FACES[result - 1];
            display.classList.add('dice-landed');
            setTimeout(() => {
                display.classList.remove('dice-landed');
                callback();
            }, 700);
        }
    }, 80);
}

// ── Card Display Modal ──

function showCardModal(card, callback) {
    document.getElementById('card-image').src = card.image;
    document.getElementById('card-name').textContent = card.name;
    document.getElementById('card-desc').textContent = card.desc;

    const actions = document.getElementById('card-actions');
    actions.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'OK';
    btn.onclick = () => {
        hideModal('card-modal');
        callback();
    };
    actions.appendChild(btn);

    showModal('card-modal');
}

// ── Target Selection ──

function showTargetSelect(prompt, targets, callback) {
    document.getElementById('target-prompt').textContent = prompt;
    const container = document.getElementById('target-buttons');
    container.innerHTML = '';

    targets.forEach(t => {
        let posLabel;
        if (t.portal) posLabel = 'In Portal';
        else if (t.position === 0) posLabel = 'Start';
        else posLabel = 'Space ' + t.position;

        const btn = document.createElement('button');
        btn.className = 'btn target-btn';
        btn.style.borderColor = t.color;
        btn.style.color = t.color;
        btn.innerHTML = `<span class="player-dot" style="background:${t.color}"></span> ${t.name} (${posLabel})`;
        btn.onclick = () => {
            hideModal('target-modal');
            callback(t);
        };
        container.appendChild(btn);
    });

    showModal('target-modal');
}

function showMultiTargetSelect(prompt, targets, maxCount, callback) {
    document.getElementById('target-prompt').textContent = prompt;
    const container = document.getElementById('target-buttons');
    container.innerHTML = '';

    const selected = [];

    targets.forEach(t => {
        const btn = document.createElement('button');
        btn.className = 'btn target-btn';
        btn.style.borderColor = t.color;
        btn.innerHTML = `<span class="player-dot" style="background:${t.color}"></span> ${t.name}`;
        btn.onclick = () => {
            if (selected.includes(t)) return;
            selected.push(t);
            btn.classList.add('selected');
            if (selected.length >= maxCount || selected.length >= targets.length) {
                hideModal('target-modal');
                callback(selected);
            }
        };
        container.appendChild(btn);
    });

    showModal('target-modal');
}

// ── Space Number Input ──

function showSpaceSelect(prompt, callback) {
    document.getElementById('space-select-prompt').textContent = prompt;
    const input = document.getElementById('space-select-input');
    input.value = '';

    document.getElementById('space-select-ok').onclick = () => {
        const val = parseInt(input.value);
        if (val >= 1 && val <= 67) {
            hideModal('space-select-modal');
            callback(val);
        }
    };

    showModal('space-select-modal');
    input.focus();
}

// ── Choice Modal ──

function showChoiceModal(title, prompt, options, callback) {
    document.getElementById('choice-title').textContent = title;
    document.getElementById('choice-prompt').textContent = prompt;
    const container = document.getElementById('choice-buttons');
    container.innerHTML = '';

    options.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'btn btn-choice';
        btn.textContent = opt.label;
        btn.onclick = () => {
            hideModal('choice-modal');
            callback(opt.value);
        };
        container.appendChild(btn);
    });

    showModal('choice-modal');
}

// ── Satellite Drag & Drop UI ──

function showSatelliteUI(callback) {
    const container = document.getElementById('satellite-cards');
    container.innerHTML = '';

    const count = Math.min(5, deck.length);
    const topCards = deck.slice(deck.length - count).reverse(); // top of deck first
    const ordinals = ['1st', '2nd', '3rd', '4th', '5th'];
    const pickedOrder = []; // array of cardId in chosen order

    function updateConfirmBtn() {
        document.getElementById('satellite-ok').disabled = pickedOrder.length < count;
    }

    function renderCards() {
        container.innerHTML = '';
        topCards.forEach((cardId) => {
            const card = getCardById(cardId);
            const div = document.createElement('div');
            div.className = 'satellite-card';
            div.dataset.cardId = cardId;

            const pickIndex = pickedOrder.indexOf(cardId);
            if (pickIndex >= 0) {
                div.classList.add('picked');
            }

            div.innerHTML = `
                <img src="${card.image}" alt="${card.name}">
                <span class="satellite-card-name">${card.name}</span>
                ${pickIndex >= 0 ? '<div class="satellite-order-badge">' + ordinals[pickIndex] + '</div>' : ''}
            `;

            div.onclick = () => {
                const idx = pickedOrder.indexOf(cardId);
                if (idx >= 0) {
                    // Un-select: remove from order
                    pickedOrder.splice(idx, 1);
                } else if (pickedOrder.length < count) {
                    // Select: add to order
                    pickedOrder.push(cardId);
                }
                renderCards();
                updateConfirmBtn();
            };

            container.appendChild(div);
        });
    }

    renderCards();
    updateConfirmBtn();

    // Reset button
    document.getElementById('satellite-reset').onclick = () => {
        pickedOrder.length = 0;
        renderCards();
        updateConfirmBtn();
    };

    // View Board button
    document.getElementById('satellite-view-board').onclick = () => {
        hideModal('satellite-modal');
        const returnBtn = document.getElementById('satellite-return-btn');
        returnBtn.style.display = 'block';
        returnBtn.onclick = () => {
            returnBtn.style.display = 'none';
            showModal('satellite-modal');
        };
    };

    // Confirm button
    document.getElementById('satellite-ok').onclick = () => {
        // Apply the chosen order to the deck
        const start = deck.length - count;
        for (let i = 0; i < count; i++) {
            deck[start + i] = pickedOrder[count - 1 - i]; // reverse: last in array = top of deck (popped first)
        }
        hideModal('satellite-modal');
        document.getElementById('satellite-return-btn').style.display = 'none';
        addToLog('Cards rearranged!');
        callback();
    };

    showModal('satellite-modal');
}

// ── Modal Helpers ──

function showModal(id) {
    document.getElementById('modal-overlay').style.display = 'block';
    document.getElementById(id).style.display = 'flex';
}

function hideModal(id) {
    document.getElementById('modal-overlay').style.display = 'none';
    document.getElementById(id).style.display = 'none';
}

// Escape key returns from Satellite "View Board" mode
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const returnBtn = document.getElementById('satellite-return-btn');
        if (returnBtn && returnBtn.style.display !== 'none') {
            returnBtn.click();
        }
    }
});

// ── Win Screen ──

function showWinScreen(player) {
    document.getElementById('win-player-name').textContent = player.name;
    document.getElementById('win-player-name').style.color = player.color;
    document.getElementById('win-screen').style.display = 'flex';
    createConfetti();
}

function createConfetti() {
    const container = document.getElementById('confetti-container');
    container.innerHTML = '';
    const colors = ['#ff4444', '#44aaff', '#44ff44', '#ffff44', '#ff44ff', '#ffaa00'];
    for (let i = 0; i < 60; i++) {
        const particle = document.createElement('div');
        particle.className = 'confetti';
        particle.style.left = Math.random() * 100 + '%';
        particle.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
        particle.style.animationDelay = (Math.random() * 2) + 's';
        particle.style.animationDuration = (2 + Math.random() * 3) + 's';
        container.appendChild(particle);
    }
}
