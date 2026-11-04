Warning: truncated output (original token count: 8043)
Total output lines: 716

import { installRespawn } from './body/respawn.js';
import { once } from 'node:events';
import { installOxygenIsolation } from './body/oxygen.js';
import { installDamageTypes, causeLabel, formatHitAlert } from './body/hurt-cause.js';
import { installDifficulty, currentDifficulty } from './body/difficulty.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { initBot } from './body/bot.js';
import * as skills from './skills/skills.js';
import * as survival from './skills/survival.js';
import * as perception from './skills/perception.js';
import * as world from './skills/world.js';
import { guardPlayerChat } from './body/chat-guard.js';
import { MailboxStore } from './comms/mailbox-store.js';
import { createSharedNotesTools } from './comms/shared-notes.js';
import { renderPlan } from './comms/plan.js';
import {
    createGameTools,
    createObservation,
    createActionRunner,
    installSkillCompatibility,
    KEEP_MOVING_TOOLS,
    interruptsOnHit,
} from './tools/game-tools.js';
import { createWorkspaceTools } from './tools/workspace-tools.js';
import { createDirectoryTools } from './tools/directory-tools.js';
import { createShellTools } from './tools/shell-tools.js';
import { loadToolsModule } from './tools/extra-tools.js';
import { createSharedExecTool } from './tools/shared-exec.js';
import { createE2bBackend, createLocalBackend } from './sandbox/shell-sandbox.js';
import { createDockerBackend } from './sandbox/docker.js';
import { createMinecraftSession } from './model/session.js';
import { paceBot } from './body/tickpace.js';
import { installDamageWake } from './body/damage.js';
import { buildSystemPrompt } from './prompt.js';
import { setSettings } from './skills/settings.js';
import { validateAgentConfig, safeError, runtimeStatus, isRefusedLateMutation } from './lifecycle.js';
import { EXIT, kickText, isFatalKick, connectionMessage, activityLine } from './startup.js';

const EXIT_FOR = {
    startup_error: EXIT.error,
    unsafe_action: EXIT.error,
    uncaught_error: EXIT.error,
    unhandled_error: EXIT.error,
    checkpoint_error: EXIT.error,
    model_error: EXIT.error,
    connection_failed: EXIT.error,
    kicked: EXIT.reconnect,
    disconnected: EXIT.reconnect,
    kicked_fatal: EXIT.fatalKick,
};

const atom = (file, value) => {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, file);
};

export async function startAgent(settings, options = {}) {
    setSettings({ ...settings });
    const c = validateAgentConfig(settings),
        profile = settings.profile,
        name = profile.name;
    let shellTools = [],
        runShell = null;
    const root = c.stateRoot;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (existsSync(path.join(root, 'retired.json')))
        throw new Error(
            `Agent ${name} died with respawn disabled; delete ${path.join(root, 'retired.json')} to bring it back`,
        );
    const model = options.model ?? {};
    const apiKey = options.apiKey;
    const withImages = options.vision === true;
    const tickRate = Number(options.tickRate ?? 20);
    const telemetryPath = path.join(root, 'telemetry.jsonl');
    const record = (event, fields = {}) =>
        appendFileSync(
            telemetryPath,
            JSON.stringify({ time: new Date().toISOString(), agent: name, event, ...fields }) + '\n',
            { mode: 0o600 },
        );
    let runner,
        camera,
        mailbox,
        closing = false,
        status = 'starting';
    const timers = [],
        peers = [...(Array.isArray(profile.peers) ? profile.peers : [])];
    const team = profile.team === true;
    checkpoint();
    const bot = initBot(name);
    bot.pi_no_flight = options.allowFlight !== true;
    const pacer = paceBot(bot, { tickRate, emit: (e, f) => record(e, f) });
    installOxygenIsolation(bot);
    installDamageTypes(bot);
    installDifficulty(bot);
    {
        const INTERACTIVE =
            /bed$|chest|door|gate|button|lever|furnace|crafting_table|anvil|barrel|shulker|hopper|dispenser|dropper|enchanting|smoker|loom|stonecutter|grindstone|cartography|smithing|note_block|repeater|comparator|bell|lectern|cake|beacon|brewing/;
        const wrap = () => {
            if (typeof bot.placeBlock !== 'function' || bot.placeBlock.sneakWrapped) return;
            const origPlace = bot.placeBlock.bind(bot);
            const wrapped = async (ref, face, ...rest) => {
                if (!INTERACTIVE.test(ref?.name ?? '')) return origPlace(ref, face, ...rest);
                const was = bot.getControlState('sneak');
                bot.setControlState('sneak', true);
                await new Promise(r => setTimeout(r, 120));
                try {
                    return await origPlace(ref, face, ...rest);
                } finally {
                    if (!was) bot.setControlState('sneak', false);
                }
            };
            wrapped.sneakWrapped = true;
            bot.placeBlock = wrapped;
        };
        wrap();
        bot.once('login', wrap);
        bot.once('spawn', wrap);
    }
    guardPlayerChat(bot._client);
    const actionRunner = createActionRunner(bot, {
        settleTimeoutMs: 8000,
        onFatal: () => void finish('unsafe_action'),
    });
    function checkpoint() {
        atom(path.join(root, 'status.json'), {
            agent: name,
            status,
            objective: profile.objective,
            updatedAt: new Date().toISOString(),
        });
    }
    async function finish(reason, { retired = false, message, exitCode } = {}) {
        if (closing) return;
        closing = true;
        status = reason;
        if (retired) atom(path.join(root, 'retired.json'), { at: new Date().toISOString(), reason });
        record('stopping', { reason, ...(message ? { message: String(message).slice(0, 500) } : {}) });
        options.onStop?.(reason, message);
        timers.forEach(clearTimeout);
        const hardStop = setTimeout(() => process.exit(0), 10000);
        try {
            await actionRunner.stop();
            await runner?.close();
            await camera?.close();
            pacer.close();
            for (const t of shellTools) await t.close?.();
        } catch {
            record('cleanup_error');
        }
        try {
            checkpoint();
            mailbox?.close();
            bot.quit('Agent stopped');
        } finally {
            clearTimeout(hardStop);
            process.exit(exitCode ?? EXIT_FOR[reason] ?? EXIT.ok);
        }
    }
    const receive = (source, text, kind = 'chat') => {
        if (closing || String(source).toLowerCase() === name.toLowerCase() || typeof text !== 'string' || !text.trim())
            return;
        const bounded = text.slice(0, 2000);
        if (kind === 'chat') mailbox?.receiveChat(source, bounded);
        if (kind === 'direct') {
            const id = mailbox?.receiveDM(source, bounded);
            if (id) seenDmId = Math.max(seenDmId, id);
            notifyMessage(source, bounded);
        }
        runner?.enqueue({ source, kind, text: bounded }, { key: `${kind}:${source}`, urgent: kind === 'direct' });
    };
    let seenDmId = 0;
    const pendingMessages = [];
    const lastInterruptBy = new Map();
    const notifyMessage = (from, text) => {
        pendingMessages.push({ from, text: text.length > 200 ? `${text.slice(0, 200)}...` : text });
        if (pendingMessages.length > 10) pendingMessages.shift();
        record('message_received', { from, text });
        const active = actionRunner.status.active;
        const now = Date.now();
        if (active && now - (lastInterruptBy.get(from) ?? 0) > 15000) {
            lastInterruptBy.set(from, now);
            actionRunner.interrupt(`Interrupted: private message from ${from}`);
        }
    };
    const messageAlert = () => {
        if (!pendingMessages.length) return null;
        const lines = pendingMessages.splice(0).map(m => `${m.from}: "${m.text}"`);
        return `NEW PRIVATE MESSAGE${lines.length > 1 ? 'S' : ''} (also in read_dms): ${lines.join(' | ')}. Reply with send_dm if useful; you may also ignore it and continue your work.`;
    };
    process.once('SIGINT', () => void finish('operator_stop'));
    process.once('SIGTERM', () => void finish('operator_stop'));
    process.once('uncaughtException', error => {
        record('uncaught_error', safeError(error));
        void finish('uncaught_error');
    });
    process.on('unhandledRejection', error => {
        if (isRefusedLateMutation(error)) {
            record('late_mutation_refused', safeError(error));
            return;
        }
        record('unhandled_error', safeError(error));
        void finish('unhandled_error');
    });
    const respawn = options.respawn !== false;
    let deathInfo = null,
        lastDeathMsg = '';
    bot.on('messagestr', m => {
        if (typeof m === 'string' && m.includes(name)) lastDeathMsg = m.slice(0, 200);
    });
    bot.on('death', () => {
        const p = bot.entity?.position;
        deathInfo = {
            at: new Date().toISOString(),
            pos: p ? `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}` : '?',
            food: bot.food,
            action: String(actionRunner?.status?.active?.name ?? actionRunner?.status?.active ?? '').slice(0, 80),
            msg: lastDeathMsg,
        };
    });
    const appendDeathLog = async () => {
        const d = deathInfo ?? { at: new Date().toISOString(), pos: '?', msg: '' };
        const line = `- ${d.at}: died at ${d.pos}${d.msg ? ` ("${d.msg}")` : ''}${d.action ? `; was doing ${d.action}` : ''}${d.food !== undefined ? `; hunger ${d.food}/20` : ''}. Respawned at world spawn.`;
        record('death_log', { line });
        try {
            if (runShell)
                await runShell.execut…3043 tokens truncated…rve,
            actionRunner,
            perception,
            world,
            plan: team ? undefined : plan,
            peers,
            perStepFrames: withImages,
            whisperPlayers: !team,
        }).filter(t => !team || !['post_chat', 'read_chat', 'read_plan', 'append_plan'].includes(t.name));
        let workspaceTools = team
            ? []
            : await createWorkspaceTools({
                  privateRoot: path.join(root, 'workspace'),
                  sharedRoot: c.sharedRoot,
                  onWait: until => runner.requestWait(until),
              });
        if (team)
            workspaceTools = workspaceTools.map(t => {
                if (!t.parameters?.properties?.scope) return t;
                const parameters = {
                    ...t.parameters,
                    properties: { ...t.parameters.properties, scope: { type: 'string', enum: ['private'] } },
                };
                return {
                    ...t,
                    parameters,
                    description: t.description
                        .replace('your private or explicitly shared workspace', 'your private workspace')
                        .replace(/ or (the )?explicitly shared (artifacts|workspace)/, ''),
                    execute: (id, args, signal) =>
                        args?.scope === 'private'
                            ? t.execute(id, args, signal)
                            : Promise.reject(
                                  new Error('Only scope private exists; use shared_exec for the shared machine.'),
                              ),
                };
            });
        if (team)
            for (const t of gameTools)
                if (t.name === 'message_status') {
                    const run = t.execute;
                    t.description = 'Your unread DM counts; does not mark read.';
                    t.execute = async (...args) => {
                        const r = await run(...args);
                        const c = r?.content?.[0];
                        if (c?.type === 'text') c.text = c.text.replace(/; public chat: \d+ \(mentions: \d+\)/, '');
                        return r;
                    };
                }
        const tools = [...gameTools, ...workspaceTools];
        if (team) {
            tools.push(...createDirectoryTools({ bot, peers, self: name }));
            tools.push(
                ...createSharedNotesTools({
                    file: path.join(path.dirname(c.mailboxPath), 'shared-notes.jsonl'),
                    agent: name,
                }),
            );
        }
        if (team && options.sharedMachineSocket)
            tools.push(
                createSharedExecTool({
                    socketPath: options.sharedMachineSocket,
                    agentName: name,
                    record,
                    sharedPath: options.sharedMachinePath ?? '/shared',
                    vm: options.sharedMachineVm !== false,
                }),
            );
        const sandbox = options.sandbox ?? { kind: 'none' };
        if (sandbox.kind !== 'none') {
            const backend =
                sandbox.kind === 'e2b'
                    ? createE2bBackend({
                          apiKey: sandbox.apiKey,
                          template: sandbox.template || undefined,
                          agentName: name,
                          cohort: options.cohort,
                          sharedDir: c.sharedRoot,
                          privateDir: path.join(root, 'workspace', 'shell-bin'),
                          statePath: path.join(root, 'e2b-sandbox.json'),
                          sandboxTimeoutMs: 3 * 3600000,
                      })
                    : sandbox.kind === 'docker'
                      ? createDockerBackend({
                            agentName: name,
                            workdir: path.join(root, 'workspace', 'shell-home'),
                            sharedDir: c.sharedRoot,
                            image: sandbox.image || undefined,
                            memory: sandbox.memory || undefined,
                            cpus: sandbox.cpus || undefined,
                        })
                      : createLocalBackend({
                            workdir: path.join(root, 'workspace', 'shell-home'),
                            sharedDir: c.sharedRoot,
                        });
            shellTools = createShellTools({
                backend,
                invoke: (n, a) => runner.invokeTool(n, a),
                toolList: () => tools,
                log: m => record('shell_log', { message: String(m).slice(0, 500) }),
            });
            tools.push(...shellTools);
            runShell = shellTools.find(t => t.name === 'run_shell') ?? null;
            if (runShell)
                void runShell
                    .execute('memory', {
                        cmd: 'test -e ~/memory.md || printf "# memory\\n" > ~/memory.md; wc -c ~/memory.md',
                        timeoutSec: 60,
                    })
                    .then(r => record('memory_md_ready', { text: String(r?.content?.[0]?.text ?? '').slice(0, 120) }))
                    .catch(err => record('memory_md_failed', { e: String(err?.message ?? err).slice(0, 200) }));
            if (typeof profile.soul === 'string' && profile.soul && runShell)
                void runShell
                    .execute('soul', {
                        cmd: `printf %s ${Buffer.from(profile.soul + '\n').toString('base64')} | base64 -d > ~/soul.md && cat ~/soul.md`,
                        timeoutSec: 60,
                    })
                    .then(r =>
                        record(r?.isError || r?.details?.ok === false ? 'soul_write_failed' : 'soul_written', {
                            text: String(r?.content?.[0]?.text ?? '').slice(0, 200),
                        }),
                    )
                    .catch(err => record('soul_write_failed', { e: String(err?.message ?? err).slice(0, 200) }));
        }
        const prompt = buildSystemPrompt({
            name,
            objective: profile.objective,
            gameMode: wantMode,
            difficulty: currentDifficulty(bot),
            team,
            personality: profile.personality,
            soul: profile.soul,
            tickRate,
            vision: withImages,
            respawn,
            sandbox: Boolean(runShell),
            sharedMachine: tools.some(t => t.name === 'shared_exec'),
            sharedPath: options.sharedMachinePath ?? '/shared',
            canFly: !bot.pi_no_flight,
        });
        runner = await createMinecraftSession({
            agentId: name,
            cwd: process.cwd(),
            sessionDir: path.join(root, 'pi-sessions'),
            systemPrompt: prompt,
            apiKey,
            model,
            modelsPath: options.modelsPath,
            thinkingLevel: options.thinkingLevel,
            resumeThinkingLevel: 'minimal',
            reconnected: reconnecting,
            tools,
            maxModelCalls: Number.MAX_SAFE_INTEGER,
            maxToolCalls: Number.MAX_SAFE_INTEGER,
            continuous: true,
            turnHeadline: alerts,
            toolResultNote: alerts,
            hitInfoAt: () => hitInfoAt,
            hitRestartMs: 2000,
            observe: async ({ signal, events, step }) => {
                const current = await observe({ signal });
                if (withImages && !current.frame) throw new Error('Fresh first-person image required');
                record('observation', {
                    step,
                    events,
                    text: JSON.stringify(current.state),
                    image: withImages ? current.frame?.metadata ?? true : false,
                });
                return {
                    text: JSON.stringify({ ...current.state }),
                    images: withImages
                        ? [{ type: 'image', data: current.frame.data, mimeType: current.frame.mimeType }]
                        : [],
                };
            },
            telemetry: event => {
                record('tool', event);
                options.onActivity?.(activityLine(event));
            },
            onModelMessage: message => record('model_message', { message }),
            onText: text => options.onActivity?.(`"${text.replace(/\s+/g, ' ').slice(0, 300)}"`),
            onModelError: message => options.onActivity?.(`model error, will retry: ${message.slice(0, 300)}`),
            onFatal: message => void finish('model_error', { message: `Model request failed: ${message}` }),
            cycleTelemetry: event => record('cycle', event),
            diagnostics: event =>
                appendFileSync(path.join(root, 'diagnostics.jsonl'), JSON.stringify({ agent: name, ...event }) + '\n', {
                    mode: 0o600,
                }),
        });
        timers.push(
            setInterval(() => {
                if (closing) return;
                try {
                    checkpoint();
                    atom(path.join(root, 'runtime-status.json'), runtimeStatus(runner, actionRunner, bot));
                } catch {
                    void finish('checkpoint_error');
                }
            }, 3000),
        );
        options.onSession?.(runner.sessionInfo ?? {});
        status = 'running';
        checkpoint();
        record('ready', { tools: tools.map(t => t.name), nextWakeAt: runner.nextWakeAt });
        const at = bot.entity?.position;
        options.onReady?.({
            tools: tools.map(t => t.name),
            position: at ? `${Math.round(at.x)},${Math.round(at.y)},${Math.round(at.z)}` : null,
        });
        runner.start();
    } catch (error) {
        record('startup_error', { ...safeError(error), message: String(error?.message ?? error).slice(0, 500) });
        await finish('startup_error', { message: String(error?.message ?? error) });
    }
}
