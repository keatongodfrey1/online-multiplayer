// ── Board Layout Data ──

const TOTAL_SPACES = 68; // 67 numbered + Finish
const COLS = 10;
const ROWS = 7;

// Landmarks: spaces with special names
const LANDMARKS = {
    20: 'The Space Permit',
    33: 'The Star',
    46: 'The Dice',
    50: 'The Spear',
    52: 'White Hole Dest.',
    58: 'The Moon',
    64: '5:20'
};

// Portals: bidirectional shortcuts with internal traversable spaces
const PORTALS = [
    { a: 4, b: 36, internal: 7, color: '#ff44ff' },
    { a: 28, b: 61, internal: 3, color: '#44ffff' },
    { a: 39, b: 51, internal: 3, color: '#ffaa00' }
];

// Stored bezier path data for each portal (populated by renderPortals)
let portalPaths = [];

// Generate the snake-path grid positions for all 68 spaces
function generateBoardLayout() {
    const spaces = [];
    for (let i = 0; i < TOTAL_SPACES; i++) {
        const spaceNum = i + 1;
        const rowFromBottom = Math.floor(i / COLS);
        const colInRow = i % COLS;
        const col = (rowFromBottom % 2 === 0) ? colInRow : (COLS - 1 - colInRow);
        const row = (ROWS - 1) - rowFromBottom;

        const isFinish = spaceNum === TOTAL_SPACES;
        const landmark = LANDMARKS[spaceNum] || null;
        const portalInfo = getPortalInfo(spaceNum);

        spaces.push({
            num: spaceNum,
            row: row,
            col: col,
            isFinish: isFinish,
            landmark: landmark,
            portal: portalInfo
        });
    }
    return spaces;
}

function getPortalInfo(spaceNum) {
    for (const p of PORTALS) {
        if (spaceNum === p.a || spaceNum === p.b) {
            return {
                otherEnd: spaceNum === p.a ? p.b : p.a,
                internal: p.internal,
                color: p.color,
                portalDef: p
            };
        }
    }
    return null;
}

// Find portal def by space number
function findPortalBySpace(spaceNum) {
    for (const p of PORTALS) {
        if (spaceNum === p.a || spaceNum === p.b) return p;
    }
    return null;
}

// ── Board Rendering ──

const boardSpaces = generateBoardLayout();

function renderBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';

    boardSpaces.forEach(space => {
        const div = document.createElement('div');
        div.className = 'space';
        div.id = 'space-' + space.num;
        div.style.gridColumn = (space.col + 1);
        div.style.gridRow = (space.row + 1);

        if (space.isFinish) {
            div.classList.add('space-finish');
            div.innerHTML = '<span class="space-num">&#127775;</span><span class="space-label">FINISH</span>';
        } else {
            let html = '<span class="space-num">' + space.num + '</span>';
            if (space.landmark) {
                div.classList.add('space-landmark');
                html += '<span class="space-label">' + space.landmark + '</span>';
            }
            div.innerHTML = html;
        }

        if (space.portal) {
            div.classList.add('space-portal');
            div.style.setProperty('--portal-color', space.portal.color);
        }

        board.appendChild(div);
    });

    // Render the START space (outside grid, below space 1)
    renderStartSpace();
    renderPortals();
}

function renderStartSpace() {
    const container = document.getElementById('board-container');
    // Remove old start space if exists
    const old = document.getElementById('start-space');
    if (old) old.remove();

    const startDiv = document.createElement('div');
    startDiv.id = 'start-space';
    startDiv.innerHTML = '<span class="start-icon">🚀</span><span class="start-label">START</span>';
    container.appendChild(startDiv);
}

// ── Portal SVG Rendering ──

function renderPortals() {
    const svg = document.getElementById('portal-overlay');
    svg.innerHTML = '';
    portalPaths = [];
    const board = document.getElementById('board');
    const boardRect = board.getBoundingClientRect();

    PORTALS.forEach((portal, idx) => {
        const elA = document.getElementById('space-' + portal.a);
        const elB = document.getElementById('space-' + portal.b);
        if (!elA || !elB) {
            portalPaths.push(null);
            return;
        }

        const rectA = elA.getBoundingClientRect();
        const rectB = elB.getBoundingClientRect();

        const ax = rectA.left - boardRect.left + rectA.width / 2;
        const ay = rectA.top - boardRect.top + rectA.height / 2;
        const bx = rectB.left - boardRect.left + rectB.width / 2;
        const by = rectB.top - boardRect.top + rectB.height / 2;

        // Control point for curved path
        const mx = (ax + bx) / 2;
        const my = (ay + by) / 2;
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.sqrt(dx * dx + dy * dy);
        const offset = 60;
        const cx = mx - (dy / len) * offset;
        const cy = my + (dx / len) * offset;

        // Store path data for rocket positioning
        portalPaths.push({ ax, ay, bx, by, cx, cy });

        // Glow filter
        const filterId = 'glow-' + portal.a;
        const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defs.innerHTML = `
            <filter id="${filterId}" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="4" result="blur"/>
                <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>`;
        svg.appendChild(defs);

        // Draw curved path
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`);
        path.setAttribute('stroke', portal.color);
        path.setAttribute('stroke-width', '3');
        path.setAttribute('fill', 'none');
        path.setAttribute('opacity', '0.6');
        path.setAttribute('filter', `url(#${filterId})`);
        path.setAttribute('stroke-dasharray', '8 4');
        path.classList.add('portal-path');
        svg.appendChild(path);

        // Draw internal portal dots along the curve
        for (let i = 1; i <= portal.internal; i++) {
            const t = i / (portal.internal + 1);
            const px = (1 - t) * (1 - t) * ax + 2 * (1 - t) * t * cx + t * t * bx;
            const py = (1 - t) * (1 - t) * ay + 2 * (1 - t) * t * cy + t * t * by;
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', px);
            dot.setAttribute('cy', py);
            dot.setAttribute('r', '4');
            dot.setAttribute('fill', portal.color);
            dot.setAttribute('opacity', '0.7');
            dot.setAttribute('filter', `url(#${filterId})`);
            svg.appendChild(dot);
        }
    });
}

// Get pixel position along a portal's bezier curve
// t=0 is at side 'a', t=1 is at side 'b'
// If forward=false (b→a), flip t
function getPortalPixelPosition(portalIndex, t, forward) {
    const pd = portalPaths[portalIndex];
    if (!pd) return { x: 0, y: 0 };
    const actualT = forward ? t : (1 - t);
    const x = (1 - actualT) * (1 - actualT) * pd.ax + 2 * (1 - actualT) * actualT * pd.cx + actualT * actualT * pd.bx;
    const y = (1 - actualT) * (1 - actualT) * pd.ay + 2 * (1 - actualT) * actualT * pd.cy + actualT * actualT * pd.by;
    return { x, y };
}

// ── Star Field ──

function generateStars() {
    const container = document.getElementById('stars-bg');
    for (let i = 0; i < 200; i++) {
        const star = document.createElement('div');
        star.className = 'star';
        star.style.left = Math.random() * 100 + '%';
        star.style.top = Math.random() * 100 + '%';
        star.style.width = star.style.height = (Math.random() * 2 + 1) + 'px';
        star.style.animationDelay = (Math.random() * 3) + 's';
        container.appendChild(star);
    }
}

// ── Helpers ──

function getSpaceCenter(spaceNum) {
    const el = document.getElementById('space-' + spaceNum);
    if (!el) return null;
    const board = document.getElementById('board');
    const boardRect = board.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    return {
        x: rect.left - boardRect.left + rect.width / 2,
        y: rect.top - boardRect.top + rect.height / 2
    };
}
