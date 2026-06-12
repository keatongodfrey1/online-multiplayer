// ── Card Definitions ──

const CARD_DEFS = [
    // Movement Forward
    { id: 1, name: 'The Moon', image: 'space_chase_cards/the_moon.png', desc: 'Go forward 5 spaces (zero gravity)', type: 'moveForward', amount: 5 },
    { id: 2, name: 'Robotic Planet', image: 'space_chase_cards/robotic_planet.png', desc: 'Go forward 5 spaces', type: 'moveForward', amount: 5 },
    { id: 3, name: 'Space Dragon', image: 'space_chase_cards/space_dragon.png', desc: 'Go forward 5 spaces', type: 'moveForward', amount: 5 },
    { id: 4, name: 'Space Credit', image: 'space_chase_cards/space_credit.png', desc: 'Go forward 20 spaces', type: 'moveForward', amount: 20 },
    { id: 5, name: 'Earth', image: 'space_chase_cards/earth.png', desc: 'Go forward 10 spaces', type: 'moveForward', amount: 10 },
    { id: 6, name: 'Cosmic Chaos', image: 'space_chase_cards/cosmic_chaos.png', desc: 'Everyone goes forward 7 spaces', type: 'moveAll', amount: 7 },
    { id: 7, name: 'Tidal Wave of Cosmic Dust', image: 'space_chase_cards/tidal_wave_of_cosmic_dust.png', desc: 'All players go forward 3 spaces', type: 'moveAll', amount: 3 },
    { id: 8, name: 'Rover', image: 'space_chase_cards/rover.png', desc: 'Others go forward 5; you go forward 7', type: 'rover' },

    // Movement Backward
    { id: 9, name: 'Cosmic Thunder', image: 'space_chase_cards/cosmic_thunder.png', desc: 'Go back 3 spaces', type: 'moveBack', amount: 3 },
    { id: 10, name: 'Asteroid', image: 'space_chase_cards/asteroid.png', desc: 'Go back 3 spaces', type: 'moveBack', amount: 3 },
    { id: 11, name: 'Alien Fireball', image: 'space_chase_cards/alien_fireball.png', desc: 'Go back 7 spaces', type: 'moveBack', amount: 7 },
    { id: 12, name: 'Alien Space Craft', image: 'space_chase_cards/alien_space_craft.png', desc: 'You explode! Go back 20 spaces', type: 'moveBack', amount: 20 },
    { id: 13, name: 'Time Bomb', image: 'space_chase_cards/time_bomb.png', desc: 'Back in time! Go back to Start', type: 'teleport', destination: 0 },
    { id: 14, name: 'Meteor Shower', image: 'space_chase_cards/meteor_shower.png', desc: 'Everyone goes back 5 spaces', type: 'moveAllBack', amount: 5 },
    { id: 15, name: 'Solar Flare', image: 'space_chase_cards/solar_flare.png', desc: 'Each person goes back 5 spaces', type: 'moveAllBack', amount: 5 },

    // Attack Cards
    { id: 16, name: 'Nuclear Bomb', image: 'space_chase_cards/nuclear_bomb.png', desc: 'Send someone back to Start', type: 'attack', action: 'sendToStart' },
    { id: 17, name: 'Blaster', image: 'space_chase_cards/blaster.png', desc: 'Make 1 person go back 3 spaces', type: 'attack', action: 'moveBack', amount: 3 },
    { id: 18, name: 'Alien Pirate', image: 'space_chase_cards/alien_pirate.png', desc: 'Choose 1 person to go back 10 spaces', type: 'attack', action: 'moveBack', amount: 10 },
    { id: 19, name: 'Fighter Jet', image: 'space_chase_cards/fighter_jet.png', desc: 'Make one player go back 3 AND you go forward 3', type: 'attack', action: 'fighterJet' },
    { id: 20, name: 'Black Hole', image: 'space_chase_cards/black_hole.png', desc: 'Teleport one player to any space (not you)', type: 'attack', action: 'blackHole' },
    { id: 21, name: 'Ion Space Bomb', image: 'space_chase_cards/ion_space_bomb.png', desc: 'Make one person lose a turn', type: 'attack', action: 'loseTurns', amount: 1 },
    { id: 22, name: 'Space Kraken', image: 'space_chase_cards/space_kraken.png', desc: '3 people lose 1 turn OR 1 person loses 3 turns', type: 'spaceKraken' },

    // Teleport Cards
    { id: 23, name: 'White Hole', image: 'space_chase_cards/white_hole.png', desc: 'Go to Space 52', type: 'teleport', destination: 52 },
    { id: 24, name: 'Cosmic Space Spear', image: 'space_chase_cards/cosmic_space_spear.png', desc: 'Go to The Spear (Space 50)', type: 'teleport', destination: 50 },
    { id: 25, name: 'Space Dice', image: 'space_chase_cards/space_dice.png', desc: 'Go to The Dice (Space 46)', type: 'teleport', destination: 46 },
    { id: 26, name: 'Space Permit', image: 'space_chase_cards/space_permit.png', desc: 'Go to The Space Permit (Space 20)', type: 'teleport', destination: 20 },
    { id: 27, name: 'Apollo 11 Spaceship', image: 'space_chase_cards/apollo_11_spaceship.png', desc: 'Go to The Moon (Space 58)', type: 'teleport', destination: 58 },
    { id: 28, name: 'Time Travel', image: 'space_chase_cards/time_travel.png', desc: 'Confusion! Teleport to 5:20 (Space 64)', type: 'teleport', destination: 64 },
    { id: 29, name: 'Shooting Star', image: 'space_chase_cards/shooting_star.png', desc: 'Send any player to The Star (33) OR go there yourself', type: 'shootingStar' },
    { id: 30, name: '6-7', image: 'space_chase_cards/6_7.png', desc: 'Send someone to Space 6 or 7. 2nd draw: you go to 67!', type: 'sixSeven' },

    // Extra Turn Cards
    { id: 31, name: 'Light Speed', image: 'space_chase_cards/light_speed.png', desc: 'Take 3 turns in a row!', type: 'extraTurns', amount: 3 },
    { id: 32, name: 'Nebula', image: 'space_chase_cards/nebula.png', desc: 'Take 2 more turns!', type: 'extraTurns', amount: 2 },
    { id: 33, name: 'U.F.O.', image: 'space_chase_cards/ufo.png', desc: 'Take 5 turns in a row!', type: 'extraTurns', amount: 5 },
    { id: 34, name: 'Time Loop', image: 'space_chase_cards/time_loop.png', desc: 'Repeat your last turn (same action and result)', type: 'timeLoop' },
    { id: 35, name: 'Rocket', image: 'space_chase_cards/rocket.png', desc: 'Go in front of the nearest person ahead of you', type: 'rocketJump' },

    // Penalty Cards
    { id: 36, name: 'Space Gun', image: 'space_chase_cards/space_gun.png', desc: 'Your ship is down! Lose 2 turns', type: 'loseTurns', amount: 2 },
    { id: 37, name: 'Alien Space Army', image: 'space_chase_cards/alien_space_army.png', desc: 'Taken to jail! Lose 5 turns', type: 'loseTurns', amount: 5 },

    // Special Cards
    { id: 38, name: 'Shield Generator', image: 'space_chase_cards/shield_generator.png', desc: 'Block anything for the next 3 rounds!', type: 'shield' },
    { id: 39, name: 'Space Suit', image: 'space_chase_cards/space_suit.png', desc: 'Double the effect of your next card!', type: 'spaceSuit' },
    { id: 40, name: 'Satellite', image: 'space_chase_cards/satellite.png', desc: 'Peek at next 5 cards and rearrange them', type: 'satellite' },
    { id: 41, name: 'Worm Hole', image: 'space_chase_cards/worm_hole.png', desc: 'Teleport! Swap positions with any opponent', type: 'attack', action: 'wormHole' }
];

// ── Deck Management ──

let deck = [];
let discardPile = [];

function initDeck() {
    deck = CARD_DEFS.map(c => c.id);
    deck.push(30); // Second copy of 6-7 card (42 cards total)
    shuffleDeck();
    discardPile = [];
}

function shuffleDeck() {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
}

function drawCard() {
    if (deck.length === 0) {
        deck = [...discardPile];
        discardPile = [];
        shuffleDeck();
        addToLog('Deck reshuffled!');
    }
    const cardId = deck.pop();
    discardPile.push(cardId);
    return CARD_DEFS.find(c => c.id === cardId);
}

function getCardById(id) {
    return CARD_DEFS.find(c => c.id === id);
}

// ── Card Effect Resolution ──

function resolveCard(card, player, callback) {
    const suit = player.spaceSuit;
    if (suit) player.spaceSuit = false;
    const mult = suit ? 2 : 1;

    switch (card.type) {
        case 'moveForward':
            movePlayerBy(player, card.amount * mult, callback);
            break;

        case 'moveBack': {
            if (player.shieldTurns > 0) {
                player.shieldTurns--;
                addToLog(player.name + '\'s Shield blocked ' + card.name + '!');
                callback();
            } else {
                movePlayerBy(player, -(card.amount * mult), callback);
            }
            break;
        }

        case 'moveAll':
            moveAllPlayers(card.amount * mult, callback);
            break;

        case 'moveAllBack':
            if (player.shieldTurns > 0) {
                player.shieldTurns--;
                addToLog(player.name + '\'s Shield blocks the backward move!');
                moveAllPlayersExcept(player, -card.amount * mult, () => callback());
            } else {
                moveAllPlayers(-card.amount * mult, callback);
            }
            break;

        case 'rover':
            moveAllPlayersExcept(player, 5, () => {
                movePlayerBy(player, 7 * mult, callback);
            });
            break;

        case 'teleport':
            teleportPlayer(player, card.destination, callback);
            break;

        case 'attack':
            resolveAttack(card, player, mult, callback);
            break;

        case 'spaceKraken':
            showKrakenChoice(player, mult, callback);
            break;

        case 'shootingStar':
            showShootingStarChoice(player, callback);
            break;

        case 'sixSeven':
            resolveSixSeven(player, callback);
            break;

        case 'extraTurns':
            player.extraTurns += card.amount * mult;
            addToLog(player.name + ' gets ' + (card.amount * mult) + ' extra turns!');
            callback();
            break;

        case 'loseTurns':
            if (player.shieldTurns > 0) {
                player.shieldTurns--;
                addToLog(player.name + '\'s Shield blocks lost turns!');
            } else {
                player.lostTurns += card.amount * mult;
                addToLog(player.name + ' loses ' + (card.amount * mult) + ' turns!');
            }
            callback();
            break;

        case 'timeLoop':
            resolveTimeLoop(player, callback);
            break;

        case 'rocketJump':
            resolveRocketJump(player, callback);
            break;

        case 'shield':
            player.shieldTurns = 3; // Always 3 rounds, not affected by Space Suit
            addToLog(player.name + ' activates Shield for 3 rounds!');
            updatePlayerPanel();
            callback();
            break;

        case 'spaceSuit':
            player.spaceSuit = true;
            addToLog(player.name + ' puts on a Space Suit! Next card is doubled!');
            updatePlayerPanel();
            callback();
            break;

        case 'satellite':
            showSatelliteUI(callback);
            break;

        default:
            callback();
    }
}

function resolveAttack(card, player, mult, callback) {
    // Most attack cards let you choose any player (including yourself)
    // Exceptions: blackHole ("not you") and wormHole ("opponent") exclude self
    const selfExcluded = (card.action === 'blackHole' || card.action === 'wormHole');
    const targets = selfExcluded
        ? GameState.players.filter(p => p !== player)
        : GameState.players.slice();

    switch (card.action) {
        case 'sendToStart':
            showTargetSelect('Send who back to Start?', targets, target => {
                if (target.shieldTurns > 0) {
                    target.shieldTurns--;
                    addToLog(target.name + '\'s Shield blocks Nuclear Bomb!');
                    callback();
                } else {
                    addToLog(target.name + ' is sent back to Start!');
                    teleportPlayer(target, 0, callback);
                }
            });
            break;

        case 'moveBack':
            showTargetSelect('Who goes back ' + (card.amount * mult) + ' spaces?', targets, target => {
                if (target.shieldTurns > 0) {
                    target.shieldTurns--;
                    addToLog(target.name + '\'s Shield blocks the attack!');
                    callback();
                } else {
                    movePlayerBy(target, -(card.amount * mult), callback);
                }
            });
            break;

        case 'fighterJet':
            showTargetSelect('Who goes back 3 spaces?', targets, target => {
                if (target.shieldTurns > 0) {
                    target.shieldTurns--;
                    addToLog(target.name + '\'s Shield blocks the entire Fighter Jet attack!');
                    callback();
                } else {
                    movePlayerBy(target, -(3 * mult), () => {
                        movePlayerBy(player, 3 * mult, callback);
                    });
                }
            });
            break;

        case 'blackHole':
            showTargetSelect('Teleport who?', targets, target => {
                if (target.shieldTurns > 0) {
                    target.shieldTurns--;
                    addToLog(target.name + '\'s Shield blocks Black Hole!');
                    callback();
                } else {
                    showSpaceSelect('Send ' + target.name + ' to which space? (1-67)', space => {
                        addToLog(target.name + ' is teleported to space ' + space + '!');
                        teleportPlayer(target, space, callback);
                    });
                }
            });
            break;

        case 'loseTurns':
            showTargetSelect('Who loses ' + (card.amount * mult) + ' turn(s)?', targets, target => {
                if (target.shieldTurns > 0) {
                    target.shieldTurns--;
                    addToLog(target.name + '\'s Shield blocks lost turn!');
                } else {
                    target.lostTurns += card.amount * mult;
                    addToLog(target.name + ' loses ' + (card.amount * mult) + ' turn(s)!');
                }
                callback();
            });
            break;

        case 'wormHole':
            showTargetSelect('Swap positions with who?', targets, target => {
                // Exit portals for both players
                if (player.portal) player.portal = null;
                if (target.portal) target.portal = null;
                const tempPos = player.position;
                player.position = target.position;
                target.position = tempPos;
                addToLog(player.name + ' swaps with ' + target.name + '!');
                positionAllRockets();
                callback();
            });
            break;

        default:
            callback();
    }
}

function showKrakenChoice(player, mult, callback) {
    showChoiceModal(
        'Space Kraken',
        'Choose your attack:',
        [
            { label: '3 players lose 1 turn', value: 'three' },
            { label: '1 player loses 3 turns', value: 'one' }
        ],
        choice => {
            const allPlayers = GameState.players.slice();
            if (choice === 'one') {
                showTargetSelect('Who loses ' + (3 * mult) + ' turns?', allPlayers, target => {
                    if (target.shieldTurns > 0) {
                        target.shieldTurns--;
                        addToLog(target.name + '\'s Shield blocks Space Kraken!');
                    } else {
                        target.lostTurns += 3 * mult;
                        addToLog(target.name + ' loses ' + (3 * mult) + ' turns!');
                    }
                    callback();
                });
            } else {
                const krakenCount = Math.min(3, allPlayers.length);
                showMultiTargetSelect('Choose ' + krakenCount + ' player(s) to lose ' + (1 * mult) + ' turn:', allPlayers, krakenCount, targets => {
                    targets.forEach(t => {
                        if (t.shieldTurns > 0) {
                            t.shieldTurns--;
                            addToLog(t.name + '\'s Shield blocks Space Kraken!');
                        } else {
                            t.lostTurns += 1 * mult;
                            addToLog(t.name + ' loses ' + (1 * mult) + ' turn!');
                        }
                    });
                    callback();
                });
            }
        }
    );
}

function showShootingStarChoice(player, callback) {
    const allPlayers = GameState.players.slice();
    showChoiceModal(
        'Shooting Star',
        'Choose:',
        [
            { label: 'Send a player to The Star (33)', value: 'send' },
            { label: 'Go to The Star (33) yourself', value: 'self' }
        ],
        choice => {
            if (choice === 'self') {
                teleportPlayer(player, 33, callback);
            } else {
                showTargetSelect('Send who to The Star?', allPlayers, target => {
                    if (target.shieldTurns > 0) {
                        target.shieldTurns--;
                        addToLog(target.name + '\'s Shield blocks Shooting Star!');
                        callback();
                    } else {
                        teleportPlayer(target, 33, callback);
                    }
                });
            }
        }
    );
}

function resolveSixSeven(player, callback) {
    player.sixSevenCount = (player.sixSevenCount || 0) + 1;
    if (player.sixSevenCount >= 2) {
        addToLog(player.name + '\'s 2nd 6-7 card! Go to Space 67!');
        teleportPlayer(player, 67, callback);
    } else {
        const allPlayers = GameState.players.slice();
        showTargetSelect('Send who to Space 6 or 7?', allPlayers, target => {
            if (target.shieldTurns > 0) {
                target.shieldTurns--;
                addToLog(target.name + '\'s Shield blocks 6-7!');
                callback();
            } else {
                showChoiceModal('6-7', 'Send ' + target.name + ' to:', [
                    { label: 'Space 6', value: 6 },
                    { label: 'Space 7', value: 7 }
                ], space => {
                    teleportPlayer(target, space, callback);
                });
            }
        });
    }
}

function resolveTimeLoop(player, callback) {
    if (player.lastAction) {
        addToLog(player.name + ' repeats their last turn!');
        if (player.lastAction.type === 'dice') {
            movePlayerBy(player, player.lastAction.result, callback);
        } else if (player.lastAction.type === 'card') {
            const card = getCardById(player.lastAction.cardId);
            if (card) {
                addToLog('Replaying: ' + card.name);
                resolveCard(card, player, callback);
            } else {
                callback();
            }
        } else {
            callback();
        }
    } else {
        addToLog('No previous turn to repeat!');
        callback();
    }
}

function resolveRocketJump(player, callback) {
    // Exit portal if in one
    if (player.portal) player.portal = null;
    const aheadPlayers = GameState.players.filter(p => p !== player && p.position > player.position);
    if (aheadPlayers.length === 0) {
        addToLog(player.name + ' is already in the lead! Rocket has no effect.');
        callback();
        return;
    }
    aheadPlayers.sort((a, b) => a.position - b.position);
    const nearest = aheadPlayers[0];
    const dest = Math.min(nearest.position + 1, TOTAL_SPACES);
    addToLog(player.name + ' rockets ahead of ' + nearest.name + '!');
    teleportPlayer(player, dest, callback);
}
