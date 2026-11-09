import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, difficultyRules } from '../../src/prompt.js';

const base = { name: 'Ada', objective: 'Build a house', gameMode: 'survival' };

test('team prompts use the configured shared directory and distinguish private notes', () => {
    const prompt = buildSystemPrompt({
        ...base,
        team: true,
        sandbox: true,
        sharedMachine: true,
        sharedPath: '/tmp/team-workspace',
    });
    assert.match(prompt, /files under \/tmp\/team-workspace/);
    assert.match(prompt, /run_shell is your private sandbox/);
    assert.match(prompt, /Everyone on the team can read and write those files/);
    assert.ok(!prompt.includes('${sharedPath}'));
    const withoutShell = buildSystemPrompt({ ...base, team: true });
    assert.doesNotMatch(withoutShell, /run_shell|shared_exec|memory\.md/);
});

test('survival prompts state the difficulty and its hunger rule', () => {
    const solo = buildSystemPrompt({ ...base, difficulty: 'easy' });
    assert.match(solo, /Easy difficulty/);
    assert.match(solo, /hunger alone cannot kill you/);
    const team = buildSystemPrompt({ ...base, team: true, difficulty: 'hard' });
    assert.match(team, /Hard difficulty/);
    assert.match(team, /starve to death/);
});

test('creative prompts and unknown difficulties add nothing', () => {
    assert.doesNotMatch(buildSystemPrompt({ ...base, gameMode: 'creative', difficulty: 'easy' }), /difficulty/);
    assert.equal(difficultyRules(undefined), '');
    assert.equal(difficultyRules('weird'), '');
    assert.equal(buildSystemPrompt(base), buildSystemPrompt({ ...base, difficulty: null }));
});

test('difficulty is read from the packet whether it arrives as a name or an index', async () => {
    const { EventEmitter } = await import('node:events');
    const { installDifficulty, currentDifficulty } = await import('../../src/body/difficulty.js');
    const client = new EventEmitter();
    const bot = { _client: client, game: {} };
    installDifficulty(bot);
    assert.equal(currentDifficulty(bot), undefined);
    client.emit('difficulty', { difficulty: 'easy', difficultyLocked: false });
    assert.equal(currentDifficulty(bot), 'easy');
    client.emit('difficulty', { difficulty: 3 });
    assert.equal(currentDifficulty(bot), 'hard');
    assert.equal(currentDifficulty({ game: { difficulty: 'normal' } }), 'normal');
});

test('team prompt covers current orders, DM replies, waiting and non-busywork idling', () => {
    const prompt = buildSystemPrompt({
        name: 'Worker01',
        objective: 'Follow the operator.',
        gameMode: 'survival',
        team: true,
        publicStatusUpdates: true,
    });
    assert.match(prompt, /operatorOrders/);
    assert.match(prompt, /recentSightings/);
    assert.match(prompt, /expects a short send_dm reply/);
    assert.match(prompt, /call wait/);
    assert.match(
        prompt,
        /greetings, questions and requests for a response with one short post_chat whether the recipient is all or your name/,
    );
    assert.doesNotMatch(prompt, /may also ignore/);
});
