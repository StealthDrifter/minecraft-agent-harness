import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createMinecraftSession,
    createPiSession,
    interruptedTurn,
    reasoningOptions,
    resumePrompt,
} from '../../src/model/session.js';
import { createGameTools } from '../../src/tools/game-tools.js';

const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
class Clock {
    time = 100000;
    tasks = new Map();
    sequence = 0;
    now = () => this.time;
    setTimeout = (fn, delay) => {
        const id = ++this.sequence;
        this.tasks.set(id, { at: this.time + delay, fn });
        return id;
    };
    clearTimeout = id => this.tasks.delete(id);
    async advance(ms = 0) {
        this.time += ms;
        for (let limit = 0; limit < 100; limit++) {
            await flush();
            const next = [...this.tasks.entries()]
                .filter(([, t]) => t.at <= this.time)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) return;
            this.tasks.delete(next[0]);
            next[1].fn();
        }
        throw new Error('Unbounded timer loop');
    }
}
function store() {
    const entries = [];
    return {
        getEntries: () => entries,
        appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
    };
}
async function fixture(overrides = {}, manager = store(), clock = new Clock()) {
    const prompts = [],
        observations = [],
        telemetry = [],
        fullTelemetry = [];
    let listener, installedTools;
    const fake = {
        isIdle: true,
        agent: { transformContext: async messages => messages },
        subscribe: fn => {
            listener = fn;
            return () => {
                listener = undefined;
            };
        },
        emit: event => listener?.(event),
        prompt: async text => {
            prompts.push(text);
            fake.abortController = new AbortController();
            return fake.script();
        },
        context: () => fake.agent.transformContext([{ role: 'user', content: 'history' }], fake.abortController.signal),
        call: async (name, params = {}) => {
            const result = await installedTools
                .find(tool => tool.name === name)
                .execute('call', params, fake.abortController.signal);
            fake.emit({ type: 'tool_execution_end', toolName: name, result });
            return result;
        },
        script: async () => {
            await fake.context();
        },
        abort: async () => {
            fake.abortController?.abort();
            fake.abortCount++;
        },
        abortCount: 0,
        waitForIdle: async () => {},
        dispose: () => {
            fake.disposed = true;
        },
    };
    const runner = await createMinecraftSession(
        {
            agentId: 'test',
            cwd: '/synthetic',
            sessionDir: '/synthetic/sessions',
            systemPrompt: 'Synthetic rules',
            tools: [],
            observe: async input => {
                observations.push(input);
                return {
                    text: `frame ${observations.length}`,
                    images: [{ type: 'image', mimeType: 'image/jpeg', data: 'synthetic' }],
                };
            },
            telemetry: item => {
                const { args, result, ...shape } = item;
                telemetry.push(shape);
                fullTelemetry.push(item);
            },
            ...overrides,
        },
        {
            clock,
            createSession: async options => {
                installedTools = options.tools;
                return { session: fake, sessionManager: manager };
            },
        },
    );
    return { runner, fake, clock, manager, prompts, observations, telemetry, fullTelemetry };
}
const tool = (name, execute) => ({ name, description: name, label: name, parameters: {}, execute });

test('coalesces passive events; final answer waits 10s; latest FPV once per request', async () => {
    const f = await fixture();
    f.runner.enqueue('older', { key: 'chat' });
    f.runner.enqueue('newer', { key: 'chat' });
    const contexts = [];
    f.fake.script = async () => {
        contexts.push(await f.fake.context(), await f.fake.context());
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.prompts.length, 1);
    assert.deepEqual(
        f.observations.map(o => o.events),
        [['newer'], ['newer']],
    );
    assert.equal(contexts[0].length, 2);
    assert.equal(contexts[1].length, 2);
    assert.match(contexts[1][1].content[0].text, /frame 2/);
    assert.equal(
        f.manager.getEntries().some(entry => JSON.stringify(entry).includes('synthetic')),
        false,
    );
    f.runner.enqueue('passive');
    await f.clock.advance(9999);
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(1);
    assert.equal(f.prompts.length, 2);
    await f.runner.close();
});

test('explicit wait stops extra tools, persists timestamp; passive chat does not shorten it', async () => {
    let runner,
        actions = 0;
    const f = await fixture({
        tools: [
            tool('wait', async () => {
                runner.requestWait(160000);
                return { content: [{ type: 'text', text: 'Waiting' }] };
            }),
            tool('act', async () => {
                actions++;
            }),
        ],
    });
    runner = f.runner;
    f.fake.script = async () => {
        await f.fake.context();
        await f.fake.call('wait');
        await assert.rejects(f.fake.call('act'), /stopped/);
    };
    runner.start();
    await f.clock.advance();
    assert.equal(actions, 0);
    assert.equal(f.fake.abortCount, 1);
    assert.equal(f.manager.getEntries().at(-1).data.nextWakeAt, 160000);
    runner.enqueue('ambient');
    await f.clock.advance(59999);
    assert.equal(f.prompts.length, 1);
    await runner.close();
});

test('urgent real external message overrides explicit wait, with fresh observation', async () => {
    const f = await fixture();
    f.fake.script = async () => {
        await f.fake.context();
        f.runner.requestWait(999999);
    };
    f.runner.start();
    await f.clock.advance();
    f.runner.enqueue('human says hello', { urgent: true });
    await f.clock.advance();
    assert.equal(f.prompts.length, 2);
    assert.deepEqual(f.observations.at(-1).events, ['human says hello']);
    await f.runner.close();
});

test('restart restores persisted wake, isolated session does not inherit it', async () => {
    const manager = store(),
        clock = new Clock();
    manager.appendCustomEntry('minecraft-scheduler-v1', { nextWakeAt: clock.now() + 60000 });
    const f = await fixture({}, manager, clock);
    f.runner.start();
    await clock.advance(59999);
    assert.equal(f.prompts.length, 0);
    await clock.advance(1);
    assert.equal(f.prompts.length, 1);
    const other = await fixture({}, store(), clock);
    other.runner.start();
    await clock.advance();
    assert.equal(other.prompts.length, 1);
    await f.runner.close();
    await other.runner.close();
});

test('past/zero wait gets nonzero floor, invalid timestamps rejected', async () => {
    const f = await fixture();
    assert.throws(() => f.runner.requestWait(NaN), /finite/);
    f.fake.script = async () => {
        await f.fake.context();
        f.runner.requestWait(0);
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(999);
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(1);
    assert.equal(f.prompts.length, 2);
    await f.runner.close();
});

test('model error (resolved SDK prompt) backs off exponentially, no forced tool retries', async () => {
    const f = await fixture();
    f.fake.script = async () => {
        await f.fake.context();
        f.fake.emit({
            type: 'message_end',
            message: { role: 'assistant', stopReason: 'error', errorMessage: 'PRIVATE' },
        });
    };
    f.runner.start();
    await f.clock.advance();
    await f.clock.advance(10000);
    assert.equal(f.prompts.length, 2);
    await f.clock.advance(19999);
    assert.equal(f.prompts.length, 2);
    await f.clock.advance(1);
    assert.equal(f.prompts.length, 3);
    assert.deepEqual(f.telemetry, []);
    await f.runner.close();
});

test('observation errors fail closed and thrown provider failures back off', async () => {
    const f = await fixture({
        observe: async () => {
            throw new Error('PRIVATE observation');
        },
    });
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(9999);
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(1);
    assert.equal(f.prompts.length, 2);
    await f.runner.close();
});

test('max model calls bounds an otherwise endless tool loop', async () => {
    const f = await fixture({ maxModelCalls: 3 });
    f.fake.script = async () => {
        while (true) await f.fake.context();
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.observations.length, 3);
    assert.equal(f.fake.abortCount, 1);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.runner.active, null);
    await f.runner.close();
});

test('tool cap bounds multiple calls inside one model step', async () => {
    let actions = 0;
    const f = await fixture({
        maxToolCalls: 2,
        tools: [
            tool('act', async () => {
                actions++;
                return { content: [{ type: 'text', text: 'PRIVATE journal' }] };
            }),
        ],
    });
    f.fake.script = async () => {
        await f.fake.context();
        for (let i = 0; i < 10; i++) await f.fake.call('act', { secret: 'PRIVATE args' });
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(actions, 2);
    assert.deepEqual(f.telemetry, [
        { tool: 'act', timeMs: 0, success: true },
        { tool: 'act', timeMs: 0, success: true },
    ]);
    await f.runner.close();
});

test('wall budget aborts a hung observation, does not overlap or immediately retry', async () => {
    let signal;
    const f = await fixture({
        maxWallMs: 50,
        observe: async input => {
            signal = input.signal;
            return new Promise(() => {});
        },
    });
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(50);
    assert.equal(signal.aborted, true);
    assert.equal(f.runner.active, null);
    assert.equal(f.prompts.length, 1);
    await f.runner.close();
});

test('cancel clears timer/queue, aborts observation, stays paused, can explicitly resume', async () => {
    const f = await fixture({ observe: () => new Promise(() => {}) });
    f.runner.start();
    await f.clock.advance();
    f.runner.enqueue('queued');
    await f.runner.cancel();
    assert.equal(f.runner.queue.size, 0);
    assert.equal(f.clock.tasks.size, 0);
    f.runner.enqueue('external', { urgent: true });
    await f.clock.advance(1000000);
    assert.equal(f.prompts.length, 1);
    f.runner.options.observe = async () => ({ text: 'resumed' });
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.prompts.length, 2);
    await f.runner.close();
    assert.equal(f.fake.disposed, true);
    assert.equal(f.runner.enqueue('after close'), false);
    assert.throws(() => f.runner.start(), /closed/);
});

test('urgent interruption waits for native action cleanup before next cycle', async () => {
    let release, actionSignal;
    const f = await fixture({
        tools: [
            tool('slow', async (_id, _params, signal) => {
                actionSignal = signal;
                await new Promise(resolve => {
                    release = resolve;
                });
                return { content: [] };
            }),
        ],
    });
    f.fake.script = async () => {
        await f.fake.context();
        if (f.prompts.length === 1) await f.fake.call('slow');
    };
    f.runner.start();
    await f.clock.advance();
    f.runner.enqueue('urgent', { urgent: true });
    await f.clock.advance();
    assert.equal(actionSignal.aborted, true);
    assert.equal(f.prompts.length, 1);
    release();
    await f.clock.advance();
    assert.equal(f.prompts.length, 2);
    assert.equal(f.telemetry[0].success, false);
    await f.runner.close();
});

test('bounded queue keeps latest keys, bad options rejected, telemetry exception harmless', async () => {
    const f = await fixture({
        maxQueue: 2,
        telemetry: () => {
            throw new Error('unavailable');
        },
        tools: [tool('ok', async () => ({ content: [] }))],
    });
    f.runner.enqueue('a');
    f.runner.enqueue('b');
    f.runner.enqueue('c');
    f.fake.script = async () => {
        await f.fake.context();
        await f.fake.call('ok');
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(f.observations[0].events, ['b', 'c']);
    assert.equal(f.runner.failures, 0);
    await f.runner.close();
    await assert.rejects(fixture({ agentId: '../other' }), /agentId/);
    await assert.rejects(fixture({ maxModelCalls: 0 }), /maxModelCalls/);
    await assert.rejects(fixture({ tools: [tool('same', () => {}), tool('same', () => {})] }), /duplicate/);
});

test('Pi factory uses verified APIs: native-only, compatible Responses endpoint with service tier, session-controlled thinking, persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-contract-'));
    try {
        const calls = {};
        const model = { id: 'test-model', maxTokens: 8192 };
        const sdk = {
            SettingsManager: {
                inMemory: settings => {
                    calls.settings = settings;
                    return settings;
                },
            },
            ModelRuntime: {
                create: async config => {
                    calls.runtime = config;
                    return {
                        registerProvider: (name, config) => {
                            calls.provider = { name, config };
                        },
                        setRuntimeApiKey: async (name, key) => {
                            calls.auth = { name, key };
                        },
                        getModel: () => model,
                    };
                },
            },
            DefaultResourceLoader: class {
                constructor(config) {
                    calls.loader = config;
                }
                async reload() {
                    calls.reload = true;
                }
            },
            SessionManager: {
                continueRecent: (cwd, dir) => {
                    calls.persistence = { cwd, dir };
                    return store();
                },
            },
            createAgentSession: async config => {
                calls.session = config;
                return { session: {} };
            },
        };
        const native = tool('native', async () => ({ content: [] }));
        await createPiSession(
            {
                agentId: 'one',
                cwd: '/synthetic',
                sessionDir: root,
                systemPrompt: 'Only explicit rules',
                tools: [native],
                apiKey: 'SYNTHETIC',
                model: {
                    provider: 'openai',
                    id: 'test-model',
                    baseUrl: 'https://api.openai.com/v1',
                    serviceTier: 'priority',
                },
            },
            {
                sdk,
                responses: {
                    stream: (...args) => {
                        calls.stream = args;
                        return 'synthetic stream';
                    },
                },
            },
        );
        assert.equal(calls.provider.name, 'openai');
        assert.equal(calls.provider.config.api, 'openai-responses');
        assert.equal(
            calls.provider.config.models[0].thinkingLevelMap.off,
            'none',
            'thinking off requests no reasoning',
        );
        calls.provider.config.streamSimple(
            model,
            { messages: [] },
            { apiKey: 'SYNTHETIC', reasoning: 'high', sessionId: 'stable', signal: 'signal' },
        );
        assert.equal(calls.stream[2].serviceTier, 'priority');
        assert.equal(calls.stream[2].maxTokens, 8192);
        assert.equal(calls.stream[2].reasoningEffort, 'high', 'configured thinking reaches the request');
        assert.equal(calls.stream[2].reasoning, 'high');
        assert.equal(calls.stream[2].signal, 'signal');
        assert.equal(calls.stream[2].sessionId, 'stable');
        assert.equal(calls.session.noTools, 'builtin');
        assert.deepEqual(calls.session.tools, ['native']);
        assert.deepEqual(calls.session.customTools, [native]);
        assert.equal(calls.session.thinkingLevel, 'medium');
        assert.equal(calls.loader.noContextFiles, true);
        assert.equal(calls.loader.noExtensions, true);
        assert.equal(calls.loader.systemPrompt, 'Only explicit rules');
        assert.equal(calls.settings.compaction.enabled, true);
        assert.equal(calls.settings.retry.enabled, false);
        assert.equal(calls.runtime.allowModelNetwork, false);
        assert.equal(calls.persistence.dir, join(root, 'one'));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('observation wait ends without exposing stale frame and emits content-free cycle outcome', async () => {
    const outcomes = [];
    const f = await fixture({
        observe: async () => ({ text: 'PRIVATE frame', waitUntil: 200000 }),
        cycleTelemetry: data => outcomes.push(data),
    });
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(outcomes, [
        { status: 'wait', steps: 1, toolCalls: 0, observations: 1, observationMs: 0, timeMs: 0, nextWakeAt: 200000 },
    ]);
    assert.equal(f.manager.getEntries().at(-1).data.nextWakeAt, 200000);
    await f.clock.advance(99999);
    assert.equal(f.prompts.length, 1);
    await f.runner.close();
});

test('persistence failure pauses instead of silently running without durable state', async () => {
    const manager = store();
    manager.appendCustomEntry = () => {
        throw new Error('disk full');
    };
    const f = await fixture({}, manager);
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.runner.paused, true);
    assert.equal(f.clock.tasks.size, 0);
    await f.clock.advance(1000000);
    assert.equal(f.prompts.length, 1);
    await f.runner.close();
});

test('tool exceptions produce false telemetry; asynchronous metric failures are isolated', async () => {
    const f = await fixture({
        cycleTelemetry: async () => {
            throw new Error('telemetry down');
        },
        tools: [
            tool('bad', async () => {
                throw new Error('PRIVATE details');
            }),
        ],
    });
    f.fake.script = async () => {
        await f.fake.context();
        await f.fake.call('bad');
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(f.telemetry, [{ tool: 'bad', timeMs: 0, success: false, failureCode: 'unknown' }]);
    assert.equal(f.runner.failures, 1);
    await f.runner.close();
});

test('large wait is split rather than Node timer overflow waking in one millisecond', async () => {
    const f = await fixture();
    const target = f.clock.now() + 2147483647 + 10000;
    f.fake.script = async () => {
        await f.fake.context();
        f.runner.requestWait(target);
    };
    f.runner.start();
    await f.clock.advance();
    await f.clock.advance(2147483647);
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(9999);
    assert.equal(f.prompts.length, 1);
    await f.clock.advance(1);
    assert.equal(f.prompts.length, 2);
    await f.runner.close();
});

test('cycle error diagnostics keep only allowlisted labels and valid HTTP statuses', async () => {
    for (const [error, expected] of [
        [
            Object.assign(new TypeError('PRIVATE request'), { code: 'ECONNRESET', status: 503 }),
            { errorName: 'TypeError', errorCode: 'ECONNRESET', httpStatus: 503 },
        ],
        [
            Object.assign(new Error('PRIVATE request'), {
                name: 'PRIVATE-name',
                code: 'PRIVATE-code',
                status: 'PRIVATE-status',
            }),
            { errorName: 'Error' },
        ],
    ]) {
        let outcome;
        const f = await fixture({
            observe: async () => {
                throw error;
            },
            cycleTelemetry: data => {
                outcome = data;
            },
        });
        f.runner.start();
        await f.clock.advance();
        assert.equal(outcome.status, 'error');
        assert.deepEqual(
            Object.fromEntries(
                Object.entries(outcome).filter(([key]) => ['errorName', 'errorCode', 'httpStatus'].includes(key)),
            ),
            expected,
        );
        assert.equal(JSON.stringify({ ...outcome, errorMessage: undefined }).includes('PRIVATE'), false);
        assert.match(outcome.errorMessage, /PRIVATE request/);
        await f.runner.close();
    }
});

test('noninterrupting urgent damage wakes both natural idle and explicit wait', async () => {
    for (const explicitWait of [false, true]) {
        const f = await fixture();
        f.fake.script = async () => {
            await f.fake.context();
            if (explicitWait) f.runner.requestWait(999999);
        };
        f.runner.start();
        await f.clock.advance();
        f.runner.enqueue({ type: 'damage', health: 16 }, { key: 'damage', urgent: true, interrupt: false });
        await f.clock.advance();
        assert.equal(f.prompts.length, 2);
        assert.equal(f.fake.abortCount, 0);
        assert.deepEqual(f.observations.at(-1).events, [{ type: 'damage', health: 16 }]);
        await f.runner.close();
    }
});

test('repeated urgent damage does not cancel thinking and survives subsequent wait', async () => {
    let release;
    const f = await fixture();
    f.fake.script = async () => {
        await f.fake.context();
        if (f.prompts.length === 1) {
            await new Promise(resolve => {
                release = resolve;
            });
            f.runner.requestWait(999999);
        }
    };
    f.runner.start();
    await f.clock.advance();
    for (const health of [18, 16, 14]) {
        f.runner.enqueue({ type: 'damage', health }, { key: 'damage', urgent: true, interrupt: false });
        await f.clock.advance(1);
    }
    f.runner.enqueue('passive-chat', { key: 'chat' });
    assert.equal(f.prompts.length, 1);
    assert.equal(f.fake.abortCount, 0);
    assert.equal(f.fake.abortController.signal.aborted, false);
    assert.equal(f.runner.queue.size, 2);
    release();
    await f.clock.advance();
    assert.equal(f.prompts.length, 2);
    assert.deepEqual(f.observations.at(-1).events, [{ type: 'damage', health: 14 }, 'passive-chat']);
    assert.equal(f.runner.queue.size, 0);
    assert.equal(f.fake.abortCount, 0);
    await f.runner.close();
});

test('urgent damage interrupts body action but waits cleanup and retains queued events', async () => {
    let release, actionSignal;
    const f = await fixture({
        tools: [
            tool('body', async (_id, _params, signal) => {
                actionSignal = signal;
                await new Promise(resolve => {
                    release = resolve;
                });
                return { content: [] };
            }),
        ],
    });
    f.fake.script = async () => {
        await f.fake.context();
        if (f.prompts.length === 1) await f.fake.call('body');
    };
    f.runner.start();
    await f.clock.advance();
    f.runner.enqueue('damage', { key: 'damage', urgent: true, interrupt: true });
    f.runner.enqueue('peer-message', { key: 'peer' });
    await f.clock.advance();
    assert.equal(actionSignal.aborted, true);
    assert.equal(f.prompts.length, 1);
    assert.equal(f.fake.abortCount, 1);
    release();
    await f.clock.advance();
    assert.equal(f.prompts.length, 2);
    assert.deepEqual(f.observations.at(-1).events, ['damage', 'peer-message']);
    await f.runner.close();
});

test('history is auto-registered before factory, late-bound to current private manager, collision explicit', async () => {
    const f = await fixture();
    f.manager.getEntries().push({ type: 'message', message: { role: 'user', content: 'own old receipt' } });
    let history;
    f.fake.script = async () => {
        history = await f.fake.call('session_history', { query: 'receipt' });
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(JSON.parse(history.content[0].text).entries[0].text, 'own old receipt');
    assert.equal(f.telemetry[0].tool, 'session_history');
    await f.runner.close();
    await assert.rejects(fixture({ tools: [tool('session_history', () => {})] }), /Reserved native tool name/);
});

test('cycle telemetry reports resolved wake for idle, wait and exponential error backoff', async () => {
    const outcomes = [];
    const f = await fixture({ cycleTelemetry: item => outcomes.push(item) });
    f.runner.start();
    await f.clock.advance();
    assert.equal(outcomes.at(-1).nextWakeAt, 110000);
    f.fake.script = async () => {
        f.runner.requestWait(150000);
    };
    await f.clock.advance(10000);
    assert.equal(outcomes.at(-1).nextWakeAt, 150000);
    f.fake.script = async () => {
        throw new Error('PRIVATE_PROVIDER_BODY');
    };
    await f.clock.advance(40000);
    assert.equal(outcomes.at(-1).nextWakeAt, 160000);
    await f.clock.advance(10000);
    assert.equal(outcomes.at(-1).nextWakeAt, 180000);
    assert.equal(JSON.stringify(outcomes.map(o => ({ ...o, errorMessage: undefined }))).includes('PRIVATE'), false);
    await f.runner.close();
});

test('cycle telemetry reports no scheduled wake after cancel or persistence failure', async () => {
    for (const cancel of [false, true]) {
        const outcomes = [];
        const f = await fixture({ cycleTelemetry: item => outcomes.push(item) });
        let release;
        f.fake.script = () =>
            new Promise(resolve => {
                release = resolve;
            });
        f.runner.start();
        await f.clock.advance();
        if (cancel) {
            const closing = f.runner.cancel();
            release();
            await closing;
        } else {
            f.manager.appendCustomEntry = () => {
                throw new Error('PRIVATE_DISK_FAILURE');
            };
            release();
            await f.runner.idle();
        }
        assert.equal(outcomes.at(-1).nextWakeAt, null);
        assert.equal(f.clock.tasks.size, 0);
        assert.equal(JSON.stringify(outcomes.map(o => ({ ...o, errorMessage: undefined }))).includes('PRIVATE'), false);
        await f.runner.close();
    }
});

test('native inspection failure telemetry retains a safe cause, not private content', async () => {
    const tools = createGameTools({
        bot: {},
        skills: {
            inspect: () => {
                throw new Error('Block at 1, 64, 2 is not visible within 8 blocks. Move or look around first.');
            },
        },
    });
    const f = await fixture({ tools });
    f.fake.script = async () => {
        await f.fake.call('inspect_block', { x: 1, y: 64, z: 2 });
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(f.telemetry, [
        { tool: 'inspect_block', timeMs: 0, success: false, failureCode: 'not_visible_or_range' },
    ]);
    await f.runner.close();
});

test('session telemetry classifies thrown errors, never arbitrary error codes or result fields', async () => {
    const sentinel = 'PRIVATE_SENTINEL';
    for (const [value, thrown, expected] of [
        [
            Object.assign(new Error(sentinel), { name: sentinel, code: sentinel, failureCode: sentinel }),
            true,
            'unknown',
        ],
        [Object.assign(new Error(sentinel), { name: 'AbortError', code: sentinel }), true, 'cancellation'],
        [Object.assign(new Error(sentinel), { name: 'TimeoutError', code: sentinel }), true, 'timeout'],
        [Object.assign(new TypeError(sentinel), { code: 'missing_item' }), true, 'unknown'],
        [
            {
                isError: true,
                failureCode: 'missing_item',
                details: { failureCode: sentinel, error: sentinel },
                content: [{ type: 'text', text: sentinel }],
            },
            false,
            'unknown',
        ],
    ]) {
        const f = await fixture({
            tools: [
                tool('test_tool', async () => {
                    if (thrown) throw value;
                    return value;
                }),
            ],
        });
        f.fake.script = async () => {
            await f.fake.call('test_tool', { text: sentinel });
        };
        f.runner.start();
        await f.clock.advance();
        assert.deepEqual(f.telemetry, [{ tool: 'test_tool', timeMs: 0, success: false, failureCode: expected }]);
        assert.equal(JSON.stringify(f.telemetry).includes(sentinel), false);
        await f.runner.close();
    }
});

test('session cancellation reports cancellation even when tool returns a nominal success', async () => {
    let release;
    const f = await fixture({
        tools: [
            tool(
                'slow',
                () =>
                    new Promise(resolve => {
                        release = resolve;
                    }),
            ),
        ],
    });
    f.fake.script = async () => {
        await f.fake.call('slow');
    };
    f.runner.start();
    await f.clock.advance();
    const cancel = f.runner.cancel();
    release({ content: [], details: { private: 'PRIVATE_SENTINEL' } });
    await cancel;
    assert.deepEqual(f.telemetry, [{ tool: 'slow', timeMs: 0, success: false, failureCode: 'cancellation' }]);
    await f.runner.close();
});

test('native validation code passes through session without sentinel args or error text', async () => {
    const f = await fixture({ tools: createGameTools({ bot: {} }) });
    f.fake.script = async () => {
        await f.fake.call('inspect_block', { PRIVATE_SENTINEL: 'PRIVATE_SENTINEL' });
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(f.telemetry, [{ tool: 'inspect_block', timeMs: 0, success: false, failureCode: 'validation' }]);
    await f.runner.close();
});

test('session wrapping real native body distinguishes local deadline from external cancellation', async () => {
    for (const [timeoutMs, cancel, expected] of [
        [2, false, 'timeout'],
        [1000, true, 'cancellation'],
    ]) {
        const native = createGameTools({
            bot: { entity: { position: {} }, game: { gameMode: 'survival' } },
            skills: {
                equip: async () => {
                    await new Promise(resolve => setTimeout(resolve, 15));
                    return true;
                },
            },
        });
        const f = await fixture({ tools: native });
        f.fake.script = async () => {
            await f.fake.call('equip', { item: 'stone', timeout_ms: timeoutMs });
        };
        f.runner.start();
        await f.clock.advance();
        if (cancel) await f.runner.cancel();
        else await f.runner.idle();
        assert.equal(f.fake.abortController.signal.aborted, cancel);
        assert.deepEqual(f.telemetry, [{ tool: 'equip', timeMs: 0, success: false, failureCode: expected }]);
        await new Promise(resolve => setTimeout(resolve, 20));
        await f.runner.close();
    }
});

test('idle-only gate synchronously disarms timer and urgent wakes; close preserves durable wake', async () => {
    const f = await fixture();
    f.fake.script = async () => f.runner.requestWait(160000);
    f.runner.start();
    await f.clock.advance();
    const dispatched = f.clock.tasks.get(f.runner.timer).fn;
    const selected = f.runner.tryQuiesce();
    assert.equal(selected, 160000);
    assert.equal(f.runner.closed, true);
    assert.equal(f.runner.paused, true);
    assert.equal(f.runner.timer, null);
    dispatched();
    f.runner.enqueue('urgent', { urgent: true });
    await f.clock.advance(61000);
    assert.equal(f.prompts.length, 1);
    await f.runner.close();
    assert.equal(f.manager.getEntries().at(-1).data.nextWakeAt, selected);
    const resumed = await fixture({}, f.manager, f.clock);
    assert.equal(resumed.runner.nextWakeAt, selected);
    await resumed.runner.close();
});

test('timer crossing cached idle makes gate a strict no-op and urgent damage still interrupts', async () => {
    const f = await fixture();
    f.fake.script = async () => f.runner.requestWait(101000);
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.runner.active, null);
    let end;
    f.fake.script = () =>
        new Promise(resolve => {
            end = resolve;
        });
    await f.clock.advance(1000);
    assert.ok(f.runner.active);
    const before = {
        paused: f.runner.paused,
        closed: f.runner.closed,
        active: f.runner.active,
        timer: f.runner.timer,
        nextWakeAt: f.runner.nextWakeAt,
        saves: f.manager.getEntries().length,
    };
    assert.equal(f.runner.tryQuiesce(), null);
    assert.deepEqual(
        {
            paused: f.runner.paused,
            closed: f.runner.closed,
            active: f.runner.active,
            timer: f.runner.timer,
            nextWakeAt: f.runner.nextWakeAt,
            saves: f.manager.getEntries().length,
        },
        before,
    );
    f.runner.enqueue('damage', { urgent: true, interrupt: true });
    assert.equal(f.fake.abortCount, 1);
    assert.equal(f.runner.active.stop, 'interrupt');
    end();
    await flush();
    await f.runner.close();
});

test('not-started, no selected wake, non-idle SDK and closed states reject without mutation', async () => {
    const f = await fixture();
    assert.equal(f.runner.tryQuiesce(), null);
    f.runner.start();
    const timer = f.runner.timer;
    assert.equal(f.runner.tryQuiesce(), null);
    assert.equal(f.runner.timer, timer);
    assert.equal(f.runner.paused, false);
    await f.clock.advance();
    f.fake.isIdle = false;
    const nextTimer = f.runner.timer;
    assert.equal(f.runner.tryQuiesce(), null);
    assert.equal(f.runner.timer, nextTimer);
    assert.equal(f.runner.closed, false);
    await f.runner.close();
    assert.equal(f.runner.tryQuiesce(), null);
});

test('invokeTool routes code-originated calls through the budget/telemetry wrapper and unwraps results', async () => {
    let actions = 0;
    const f = await fixture({
        maxToolCalls: 3,
        tools: [
            tool('act', async (_id, args) => {
                actions++;
                return { content: [{ type: 'text', text: JSON.stringify({ got: args.x }) }], details: { ok: true } };
            }),
            tool('bad', async () => ({ content: [{ type: 'text', text: 'nope' }], isError: true })),
        ],
    });
    let results = [];
    f.fake.script = async () => {
        await f.fake.context();
        results.push(await f.runner.invokeTool('act', { x: 1 }));
        results.push(await f.runner.invokeTool('bad', {}).catch(e => e.message));
        results.push(await f.runner.invokeTool('act', { x: 2 }));
        results.push(await f.runner.invokeTool('act', { x: 3 }).catch(e => 'stopped'));
        results.push(await f.runner.invokeTool('session_history', {}).catch(e => e.message));
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(results.slice(0, 3), [{ got: 1 }, 'bad: nope', { got: 2 }]);
    assert.equal(results[3], 'stopped');
    assert.match(results[4], /cannot be called from code|stopped/);
    assert.equal(actions, 2);
    assert.equal(f.telemetry.filter(t => t.tool === 'act').length, 2);
    assert.equal(f.telemetry.find(t => t.tool === 'bad').success, false);
    await f.runner.close();
});

test('continuous: next turn starts immediately, urgent events neither wake nor interrupt', async () => {
    const f = await fixture({ continuous: true });
    let turns = 0;
    f.fake.script = async () => {
        await f.fake.context();
        turns++;
        if (turns === 1) f.runner.enqueue({ kind: 'damage' }, { key: 'damage', urgent: true, interrupt: true });
        if (turns === 3) f.runner.paused = true;
    };
    f.runner.start();
    await f.clock.advance();
    assert.ok(f.prompts.length >= 3, `turns ${f.prompts.length}`);
    assert.match(f.prompts[0], /^Next turn\.\nUse the current observation\./);
    assert.match(f.prompts[1], /Events since your last turn:.*damage/s);
    assert.equal(f.telemetry.filter?.(t => t.status === 'interrupt').length ?? 0, 0);
    assert.equal(f.clock.time, 100000, 'no idle delay between turns');
    await f.runner.close();
});

test('hit restart: a hit during a model call cancels it and the new turn opens with the hit alert', async () => {
    let unread = null;
    const f = await fixture({
        continuous: true,
        turnHeadline: () => {
            const a = unread;
            unread = null;
            return a;
        },
        hitRestartMs: 2000,
    });
    let turns = 0;
    f.fake.script = async () => {
        await f.fake.context();
        turns++;
        if (turns === 1) {
            unread = 'YOU WERE HIT 1x: by zombie (entity id 7, at 1,2,3)';
            f.runner.enqueue({ kind: 'hit', id: 7 }, { key: 'hit', urgent: true, interrupt: false, restart: true });
            await new Promise(r =>
                f.fake.abortController.signal.aborted
                    ? r()
                    : f.fake.abortController.signal.addEventListener('abort', r),
            );
        }
        if (turns === 2) f.runner.paused = true;
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.fake.abortCount, 1);
    assert.ok(f.prompts.length >= 2);
    assert.match(f.prompts[1], /^YOU WERE HIT 1x: by zombie \(entity id 7, at 1,2,3\)\n\nNext turn\./);
    assert.match(f.prompts[1], /"kind":"hit"/);
    await f.runner.close();
});

test('hit restart: at most one restart per 2 s; hits during a tool do not cancel, the tool result carries the alert', async () => {
    let unread = null;
    const f = await fixture({
        continuous: true,
        toolResultNote: () => {
            const a = unread;
            unread = null;
            return a;
        },
        hitRestartMs: 2000,
        tools: [
            tool('walk', async () => {
                unread = 'YOU WERE HIT 1x: by skeleton';
                f.runner.enqueue({ kind: 'hit' }, { key: 'hit', urgent: true, interrupt: false, restart: true });
                return { content: [{ type: 'text', text: 'walked' }] };
            }),
        ],
    });
    let turns = 0;
    const results = [];
    f.fake.script = async () => {
        await f.fake.context();
        turns++;
        if (turns === 1) {
            results.push(await f.fake.call('walk'));
        }
        if (turns === 2) {
            f.runner.enqueue({ kind: 'hit' }, { key: 'hit', urgent: true, interrupt: false, restart: true });
            await new Promise(r =>
                f.fake.abortController.signal.aborted
                    ? r()
                    : f.fake.abortController.signal.addEventListener('abort', r),
            );
        }
        if (turns === 3) {
            f.runner.enqueue({ kind: 'hit' }, { key: 'hit', urgent: true, interrupt: false, restart: true });
        }
        if (turns === 4) f.runner.paused = true;
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(
        results[0].content.map(c => c.text),
        ['walked', 'YOU WERE HIT 1x: by skeleton'],
    );
    assert.equal(
        f.fake.abortCount,
        1,
        'tool-time hit did not cancel; turn-2 hit cancelled; turn-3 hit inside 2 s did not',
    );
    await f.runner.close();
});

test('hit restart: a call that already knows about the fight is not cancelled; an uninformed one later is, rate-limited', async () => {
    let infoAt = -Infinity,
        unread = null;
    const f = await fixture({
        continuous: true,
        hitRestartMs: 2000,
        hitInfoAt: () => infoAt,
        turnHeadline: () => {
            const a = unread;
            unread = null;
            if (a) infoAt = f.clock.now();
            return a;
        },
    });
    const wait = () =>
        new Promise(r =>
            f.fake.abortController.signal.aborted ? r() : f.fake.abortController.signal.addEventListener('abort', r),
        );
    const hit = () => {
        unread = 'YOU WERE HIT';
        f.runner.enqueue({ kind: 'hit' }, { key: 'hit', urgent: true, interrupt: false, restart: true });
    };
    let turns = 0;
    f.fake.script = async () => {
        await f.fake.context();
        turns++;
        if (turns === 1) {
            hit();
            await wait();
        } else if (turns === 2) {
            hit();
            await f.fake.context();
        } else if (turns === 3) {
            f.clock.time += 15000;
            await f.fake.context();
            hit();
            await wait();
        } else f.runner.paused = true;
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(f.fake.abortCount, 2);
    assert.match(f.prompts[1], /^YOU WERE HIT\n\nNext turn/);
    await f.runner.close();
});

test('tool telemetry carries structured args and the full result for the activity log', async () => {
    const f = await fixture({
        tools: [
            tool('act', async () => ({
                content: [{ type: 'text', text: `done ${'gathered oak logs. '.repeat(20)}` }],
            })),
        ],
    });
    f.fake.script = async () => {
        await f.fake.context();
        await f.fake.call('act', { block: 'oak_log', count: 4 });
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(f.fullTelemetry[0].args, { block: 'oak_log', count: 4 });
    assert.match(f.fullTelemetry[0].result, /^done gathered oak logs\. /);
    assert.ok(f.fullTelemetry[0].result.length > 300, 'results are logged in full, not clipped');
    await f.runner.close();
});

test('assistant text is reported and auth failures are fatal while other model errors are not', async () => {
    const said = [],
        fatal = [],
        soft = [];
    const f = await fixture({
        onText: t => said.push(t),
        onFatal: m => fatal.push(m),
        onModelError: m => soft.push(m),
    });
    f.fake.script = async () => {
        await f.fake.context();
        f.fake.emit({
            type: 'message_end',
            message: { role: 'assistant', content: [{ type: 'text', text: 'Crafting planks next.' }] },
        });
        f.fake.emit({
            type: 'message_end',
            message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 rate_limit_error' },
        });
        f.fake.emit({
            type: 'message_end',
            message: {
                role: 'assistant',
                content: [],
                stopReason: 'error',
                errorMessage: '401 {"type":"authentication_error","message":"invalid x-api-key"}',
            },
        });
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(said, ['Crafting planks next.']);
    assert.equal(soft.length, 1);
    assert.match(fatal[0], /invalid x-api-key/);
    await f.runner.close();
});

test('a thrown provider error reaches diagnostics and the fatal hook', async () => {
    const diagnostics = [],
        fatal = [];
    const f = await fixture({ diagnostics: d => diagnostics.push(d), onFatal: m => fatal.push(m) });
    f.fake.script = async () => {
        throw new Error('No API key found for anthropic');
    };
    f.runner.start();
    await f.clock.advance();
    assert.ok(diagnostics.some(d => d.event === 'cycle_error' && /No API key/.test(d.errorMessage)));
    assert.match(fatal[0], /No API key/);
    await f.runner.close();
});

test('an aborted last turn is found and its reasoning carried into a resume prompt', () => {
    const aborted = {
        type: 'message',
        message: {
            role: 'assistant',
            stopReason: 'aborted',
            content: [{ type: 'thinking', thinking: 'Plan: walls at y=79.\n  Then the roof.' }],
        },
    };
    const done = { type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [] } };
    assert.equal(interruptedTurn([done]), null);
    assert.equal(interruptedTurn([aborted, done]), null);
    assert.deepEqual(interruptedTurn([done, aborted, { type: 'custom' }]), {
        notes: 'Plan: walls at y=79. Then the roof.',
    });
    assert.equal(interruptedTurn([aborted], 10).notes, '... the roof.');
    assert.equal(resumePrompt({}), '');
    const text = resumePrompt({ reconnected: true, interrupted: { notes: 'Plan: walls' } });
    assert.match(text, /just reconnected/);
    assert.match(text, /<<Plan: walls>>/);
    assert.match(text, /next tool call right away/);
});

test('the first turn after a resume gets the resume note and low thinking until it acts', async () => {
    const manager = store();
    manager.getEntries().push({
        type: 'message',
        message: { role: 'assistant', stopReason: 'aborted', content: [{ type: 'thinking', thinking: 'build walls' }] },
    });
    const f = await fixture(
        {
            reconnected: true,
            thinkingLevel: 'medium',
            resumeThinkingLevel: 'minimal',
            tools: [tool('noop', async () => ({ content: [{ type: 'text', text: 'ok' }] }))],
        },
        manager,
    );
    const levels = [];
    f.fake.setThinkingLevel = level => levels.push(level);
    let act = false,
        actedAt = -1;
    f.fake.script = async () => {
        await f.fake.context();
        if (act && actedAt < 0) {
            actedAt = f.prompts.length - 1;
            await f.fake.call('noop');
        }
    };
    f.runner.start();
    await f.clock.advance();
    await f.clock.advance(15000);
    act = true;
    for (let i = 0; i < 4; i++) await f.clock.advance(15000);
    assert.ok(actedAt >= 1 && f.prompts.length > actedAt + 1);
    for (const prompt of f.prompts.slice(0, actedAt + 1))
        assert.match(prompt, /^You were disconnected[\s\S]*<<build walls>>/);
    for (const prompt of f.prompts.slice(actedAt + 1)) assert.doesNotMatch(prompt, /reconnected|build walls/);
    assert.equal(levels.at(-1), 'medium');
    assert.equal(levels.length, actedAt + 2);
    assert.ok(levels.slice(0, -1).every(level => level === 'minimal'));
});

test('reasoning levels convert to a request effort; off sends none', () => {
    assert.deepEqual(reasoningOptions('medium'), { reasoningEffort: 'medium' });
    assert.deepEqual(reasoningOptions('minimal'), { reasoningEffort: 'low' });
    assert.deepEqual(reasoningOptions('xhigh'), { reasoningEffort: 'high' });
    assert.deepEqual(reasoningOptions('off'), {});
    assert.deepEqual(reasoningOptions(undefined), {});
});

test('continuous: two commands from one sender are both delivered, in order', async () => {
    const f = await fixture({ continuous: true });
    const delivered = [];
    f.runner.options.onEventsDelivered = ({ events }) => delivered.push(events.map(e => e.text));
    f.runner.enqueue({ kind: 'human_command', text: 'first' }, { key: 'human_command:1', urgent: true });
    f.runner.enqueue({ kind: 'human_command', text: 'second' }, { key: 'human_command:2', urgent: true });
    f.fake.script = async () => {
        await f.fake.context();
        f.runner.paused = true;
    };
    f.runner.start();
    await f.clock.advance();
    assert.deepEqual(delivered, [['first', 'second']]);
    assert.match(f.prompts[0], /first.*second/s);
    await f.runner.close();
});

test('continuous: an operator command interrupts a running cycle and is delivered next', async () => {
    const f = await fixture({ continuous: true });
    let turns = 0;
    f.fake.script = async () => {
        await f.fake.context();
        turns++;
        if (turns === 1)
            f.runner.enqueue({ kind: 'human_command', text: 'stop that' }, { key: 'human_command:1', urgent: true });
        else f.runner.paused = true;
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(turns, 2);
    assert.doesNotMatch(f.prompts[0], /stop that/);
    assert.match(f.prompts[1], /stop that/);
    await f.runner.close();
});

test('cancel (death/respawn) keeps operator commands but drops other stale events', async () => {
    const f = await fixture({ continuous: true });
    f.runner.enqueue({ kind: 'human_command', text: 'build a door' }, { key: 'human_command:1', urgent: true });
    f.runner.enqueue({ kind: 'hit' }, { key: 'hit', urgent: true });
    f.runner.enqueue({ kind: 'direct', text: 'old dm' }, { key: 'direct:Worker02' });
    await f.runner.cancel();
    assert.deepEqual([...f.runner.queue.keys()], ['human_command:1']);
    f.fake.script = async () => {
        await f.fake.context();
        f.runner.paused = true;
    };
    f.runner.paused = false;
    f.runner.start();
    await f.clock.advance();
    assert.match(f.prompts[0], /build a door/);
    assert.doesNotMatch(f.prompts[0], /old dm/);
    await f.runner.close();
});

test('a full queue evicts ordinary events before operator commands', async () => {
    const f = await fixture({ continuous: true, maxQueue: 2 });
    f.runner.enqueue({ text: 'order' }, { key: 'human_command:1' });
    f.runner.enqueue({ text: 'noise-a' }, { key: 'a' });
    f.runner.enqueue({ text: 'noise-b' }, { key: 'b' });
    assert.deepEqual([...f.runner.queue.keys()], ['human_command:1', 'b']);
    await f.runner.close();
});

test('an urgent DM wakes an idle continuous agent that is waiting', async () => {
    const f = await fixture({ continuous: true });
    let turns = 0;
    f.fake.script = async () => {
        await f.fake.context();
        turns++;
        if (turns === 1) f.runner.requestWait(f.clock.now() + 60000);
        else f.runner.paused = true;
    };
    f.runner.start();
    await f.clock.advance();
    assert.equal(turns, 1);
    f.runner.enqueue({ kind: 'direct', text: 'psst' }, { key: 'direct:Worker02', urgent: true });
    await f.clock.advance(1);
    assert.equal(turns, 2, 'DM woke the waiting agent without waiting 60 s');
    await f.runner.close();
});

test('thinkingBudgetTokens routes through chat completions and sends a hard cap (0 when thinking is off)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-session-budget-'));
    try {
        const calls = {};
        const model = { id: 'test-model', maxTokens: 4096 };
        const sdk = {
            SettingsManager: { inMemory: settings => settings },
            ModelRuntime: {
                create: async () => ({
                    registerProvider: (name, config) => {
                        calls.provider = { name, config };
                    },
                    setRuntimeApiKey: async () => {},
                    getModel: () => model,
                }),
            },
            DefaultResourceLoader: class {
                async reload() {}
            },
            SessionManager: { continueRecent: () => store() },
            createAgentSession: async () => ({ session: {} }),
        };
        await createPiSession(
            {
                agentId: 'one',
                cwd: '/synthetic',
                sessionDir: root,
                systemPrompt: 'rules',
                tools: [tool('noop', async () => ({ content: [] }))],
                apiKey: 'SYNTHETIC',
                model: {
                    provider: 'local',
                    id: 'test-model',
                    baseUrl: 'http://127.0.0.1:1234/v1',
                    thinkingBudgetTokens: 256,
                },
            },
            {
                sdk,
                completions: {
                    stream: (...args) => {
                        calls.stream = args;
                        return 'synthetic stream';
                    },
                },
            },
        );
        assert.equal(calls.provider.config.api, 'openai-completions');
        assert.equal(calls.provider.config.models[0].api, 'openai-completions');
        const send = async reasoning => {
            calls.provider.config.streamSimple(
                model,
                { messages: [] },
                {
                    reasoning,
                    onPayload: p => ({ ...p, marker: true }),
                },
            );
            return calls.stream[2].onPayload({ model: 'x' }, model);
        };
        assert.deepEqual(await send('medium'), { model: 'x', marker: true, thinking_budget_tokens: 256 });
        assert.equal((await send('off')).thinking_budget_tokens, 0);
        assert.equal(calls.stream[2].reasoningEffort, undefined);
        assert.equal(calls.stream[2].maxTokens, 4096);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
