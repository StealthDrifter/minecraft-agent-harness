import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { bearingTo, createSightingTracker, sightingText } from '../../src/body/sightings.js';

function fixture({ yaw = 0, known = [] } = {}) {
    let clock = 1_000_000;
    const events = [];
    const bot = {
        username: 'Ada',
        entity: { id: 1, position: new Vec3(0, 64, 0), yaw },
        entities: {},
    };
    bot.entities[1] = bot.entity;
    const hidden = new Set();
    const tracker = createSightingTracker({
        bot,
        isVisible: (_bot, e) => !hidden.has(e.id),
        isKnown: name => known.includes(name),
        onEvent: e => events.push(e),
        now: () => clock,
    });
    const add = (id, patch) => {
        bot.entities[id] = { id, position: new Vec3(0, 64, -10), ...patch };
        return bot.entities[id];
    };
    return { bot, tracker, events, add, hidden, advance: ms => (clock += ms) };
}

test('bearing: north target while facing north is ahead, west target is to the left', () => {
    const { bot } = fixture({ yaw: 0 });
    assert.deepEqual(bearingTo(bot, new Vec3(0, 64, -10)), { compass: 'north', relative: 'ahead' });
    assert.deepEqual(bearingTo(bot, new Vec3(-10, 64, 0)), { compass: 'west', relative: 'left' });
    assert.deepEqual(bearingTo(bot, new Vec3(10, 64, 0)), { compass: 'east', relative: 'right' });
    assert.deepEqual(bearingTo(bot, new Vec3(0, 64, 10)), { compass: 'south', relative: 'behind' });
});

test('bearing follows the bot yaw (facing west, a west target is ahead)', () => {
    const { bot } = fixture({ yaw: Math.PI / 2 });
    assert.deepEqual(bearingTo(bot, new Vec3(-10, 64, 0)), { compass: 'west', relative: 'ahead' });
});

test('an unfamiliar player is announced once and reported when it vanishes', () => {
    const { tracker, events, add, advance, bot } = fixture();
    add(7, { type: 'player', username: 'Stranger' });
    tracker.poll();
    tracker.poll();
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'sighting');
    assert.equal(events[0].figure.kind, 'player-like humanoid');
    assert.equal(events[0].figure.distance, 10);
    assert.match(sightingText(events[0]), /Stranger.*10 blocks away to the north, ahead/);
    advance(3000);
    delete bot.entities[7];
    tracker.poll();
    assert.equal(events.length, 2);
    assert.equal(events[1].kind, 'figure_lost');
    assert.equal(events[1].how, 'vanished suddenly');
    assert.equal(events[1].visibleSeconds, 3);
    const recent = tracker.recentSightings();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].outcome, 'vanished suddenly');
});

test('walking behind cover is reported only after a grace period', () => {
    const { tracker, events, add, hidden, advance } = fixture();
    add(7, { type: 'player', username: 'Stranger' });
    tracker.poll();
    hidden.add(7);
    advance(500);
    tracker.poll();
    assert.equal(events.length, 1);
    advance(1500);
    tracker.poll();
    assert.equal(events[1].how, 'moved out of sight');
});

test('teammates, known players and mobs with names are ignored', () => {
    const { tracker, events, add } = fixture({ known: ['Bram', 'Boss'] });
    add(2, { type: 'player', username: 'Bram' });
    add(3, { type: 'player', username: 'Boss' });
    add(4, { type: 'hostile', name: 'zombie' });
    add(5, { type: 'player', username: 'Ada' });
    tracker.poll();
    assert.deepEqual(events, []);
});

test('an entity with no recognised name counts as a vague figure', () => {
    const { tracker, events, add } = fixture();
    add(9, { type: 'other' });
    tracker.poll();
    assert.equal(events[0].figure.kind, 'unrecognised entity');
});
