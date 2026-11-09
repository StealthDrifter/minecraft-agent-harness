import test from 'node:test';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { createViewLog } from '../../src/body/viewlog.js';

function fixture({ exclude } = {}) {
    let clock = 1_000_000;
    const bot = { username: 'Ada', entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0 }, entities: {} };
    bot.entities[1] = bot.entity;
    const hidden = new Set();
    const log = createViewLog({ bot, isVisible: (_bot, e) => !hidden.has(e.id), exclude, now: () => clock });
    const add = (id, patch) => (bot.entities[id] = { id, position: new Vec3(0, 64, -10), ...patch });
    return { bot, log, add, hidden, advance: ms => (clock += ms) };
}

test('something still in view is not listed; something removed from the world is, once', () => {
    const { log, add, advance, bot } = fixture();
    add(7, { type: 'player', username: 'Stranger' });
    log.poll();
    advance(3000);
    log.poll();
    assert.deepEqual(log.drain(), []);
    delete bot.entities[7];
    advance(500);
    log.poll();
    const [entry] = log.drain();
    assert.equal(entry.username, 'Stranger');
    assert.equal(entry.distance, 10);
    assert.deepEqual(entry.position, { x: 0, y: 64, z: -10 });
    assert.equal(entry.inViewSeconds, 3);
    assert.equal(entry.ended, 'removed from the world');
    assert.deepEqual(log.drain(), []);
});

test('going out of line of sight is listed only after a grace period', () => {
    const { log, add, hidden, advance } = fixture();
    add(7, { type: 'hostile', name: 'zombie' });
    log.poll();
    hidden.add(7);
    advance(500);
    log.poll();
    assert.deepEqual(log.drain(), []);
    advance(1500);
    log.poll();
    const [entry] = log.drain();
    assert.equal(entry.name, 'zombie');
    assert.equal(entry.ended, 'out of line of sight');
});

test('the bot itself, excluded entities and non-living objects are never listed', () => {
    const { log, add, bot, advance } = fixture({ exclude: e => e.username === 'Bram' });
    add(2, { type: 'player', username: 'Bram' });
    add(3, { type: 'object', name: 'item' });
    add(4, { type: 'player', username: 'Ada' });
    log.poll();
    for (const id of [2, 3, 4]) delete bot.entities[id];
    advance(2000);
    log.poll();
    assert.deepEqual(log.drain(), []);
});

test('only the most recent few are kept', () => {
    const { log, add, bot, advance } = fixture();
    for (let id = 10; id < 20; id++) add(id, { type: 'mob', name: 'cow' });
    log.poll();
    for (let id = 10; id < 20; id++) delete bot.entities[id];
    advance(100);
    log.poll();
    assert.equal(log.drain().length, 6);
});
