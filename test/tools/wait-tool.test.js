import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaitTool } from '../../src/tools/wait-tool.js';

test('wait asks the scheduler for idle time and exposes nothing else', async () => {
    const asked = [];
    const wait = createWaitTool({ requestWait: until => (asked.push(until), until), now: () => 1000 });
    assert.equal(wait.name, 'wait');
    assert.deepEqual(Object.keys(wait.parameters.properties), ['seconds']);
    const result = await wait.execute('id', { seconds: 2.5 });
    assert.deepEqual(asked, [3500]);
    assert.deepEqual(JSON.parse(result.content[0].text), { requestedIdleUntil: 3500 });
});

test('wait rejects bad durations and cancelled calls without touching the scheduler', async () => {
    let calls = 0;
    const wait = createWaitTool({ requestWait: () => calls++, maxSeconds: 30 });
    for (const seconds of [0, -1, 31, NaN, '5', undefined]) {
        const r = await wait.execute('id', { seconds });
        assert.equal(r.isError, true, String(seconds));
    }
    const aborted = new AbortController();
    aborted.abort();
    assert.equal((await wait.execute('id', { seconds: 5 }, aborted.signal)).isError, true);
    assert.equal(calls, 0);
});
