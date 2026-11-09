import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnomalyLayer, validateAnomalies } from '../../src/body/anomalies.js';

const shown = { id: 7, name: undefined, username: 'Herobrine', position: { x: 10, y: 64, z: 20 }, distance: 12.5 };

test('entities that match no rule are returned untouched and nothing is reported', () => {
    const seen = [];
    const layer = createAnomalyLayer([{ match: { username: 'Herobrine' }, set: { id: -1 } }], {
        onApply: d => seen.push(d),
    });
    const other = { ...shown, username: 'Steve' };
    assert.equal(layer.apply({ id: 8, username: 'Steve' }, other), other);
    assert.deepEqual(seen, []);
});

test('a matching rule rewrites fields, drops fields, and reports real and shown values', () => {
    const seen = [];
    const layer = createAnomalyLayer(
        [{ match: { username: 'herobrine' }, set: { id: -1, name: '' }, drop: ['username'] }],
        { onApply: d => seen.push(d) },
    );
    const out = layer.apply({ id: 7, username: 'Herobrine' }, shown);
    assert.equal(out.id, -1);
    assert.equal(out.name, '');
    assert.equal('username' in out, false);
    assert.equal(out.distance, 12.5);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].real.id, 7);
    assert.equal(seen[0].shown.id, -1);
    assert.equal(shown.id, 7);
});

test('jitter perturbs numbers and position axes differently on each call', () => {
    let n = 0;
    const layer = createAnomalyLayer([{ match: { username: 'Herobrine' }, jitter: { position: 10, distance: 10 } }], {
        random: () => [1, 0, 1, 1][n++ % 4],
    });
    const out = layer.apply({ id: 7, username: 'Herobrine' }, shown);
    assert.notDeepEqual(out.position, shown.position);
    assert.equal(out.position.y, 54);
    assert.notEqual(out.distance, shown.distance);
});

test('validation rejects malformed rules', () => {
    assert.deepEqual(validateAnomalies(undefined), []);
    assert.ok(validateAnomalies({}).length);
    assert.ok(validateAnomalies([{ set: { id: 1 } }]).length);
    assert.ok(validateAnomalies([{ match: { username: 'X' } }]).length);
    assert.ok(validateAnomalies([{ match: { color: 'x' }, set: {} }]).length);
    assert.deepEqual(validateAnomalies([{ match: { username: 'X' }, set: { id: -1 }, jitter: { distance: 3 } }]), []);
});

test('observe_world applies the layer to visible entities and leaves other agents alone', async () => {
    const { Vec3 } = await import('vec3');
    const { createObservation } = await import('../../src/tools/game/observation.js');
    const self = { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 };
    const bot = {
        username: 'Ada',
        entity: self,
        entities: {
            1: self,
            7: { id: 7, type: 'player', username: 'Herobrine', position: new Vec3(3, 64, 4) },
        },
        inventory: { items: () => [], slots: [] },
        heldItem: null,
        health: 20,
        food: 20,
        game: {},
        time: {},
    };
    const perception = { isBlockVisible: () => true, isEntityVisible: (_bot, e) => e.id !== 1 };
    const world = { getNearestBlocks: () => [] };
    const seen = [];
    const layer = createAnomalyLayer([{ match: { username: 'Herobrine' }, set: { name: '', id: -1, distance: -3 } }], {
        onApply: d => seen.push(d),
    });
    const observe = options => createObservation({ bot, perception, world, ...options })({ image: false });
    const shown = (await observe({ anomalies: layer })).state.entities[0];
    assert.equal(shown.id, -1);
    assert.equal(shown.name, '');
    assert.equal(shown.distance, -3);
    assert.equal(seen[0].real.id, 7);
    assert.equal(seen[0].real.distance, 5);
    const plain = (await observe({})).state.entities[0];
    assert.equal(plain.id, 7);
    assert.equal(plain.distance, 5);
});
