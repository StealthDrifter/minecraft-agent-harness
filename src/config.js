import { validateAnomalies } from './body/anomalies.js';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { dockerAvailable } from './sandbox/docker.js';

export const DEFAULTS = Object.freeze({
    host: 'localhost',
    port: 25565,
    auth: 'offline',
    minecraftVersion: '1.21.6',
    name: 'Agent',
    gameMode: 'survival',
    model: 'openai/gpt-6.1-terra',
    thinking: 'medium',
    tickRate: 20,
    vision: false,
    respawn: true,
    allowFlight: false,
    stateDir: '.agent-state',
});

const ENV = {
    host: 'MC_HOST',
    port: 'MC_PORT',
    auth: 'MC_AUTH',
    minecraftVersion: 'MC_VERSION',
    name: 'AGENT_NAME',
    objective: 'AGENT_OBJECTIVE',
    gameMode: 'AGENT_GAME_MODE',
    model: 'AGENT_MODEL',
    baseUrl: 'MODEL_BASE_URL',
    modelsFile: 'AGENT_MODELS_FILE',
    thinking: 'AGENT_THINKING',
    sandbox: 'AGENT_SANDBOX',
    dockerImage: 'AGENT_DOCKER_IMAGE',
    dockerMemory: 'AGENT_DOCKER_MEMORY',
    dockerCpus: 'AGENT_DOCKER_CPUS',
    vision: 'AGENT_VISION',
    tickRate: 'AGENT_TICK_RATE',
    stateDir: 'AGENT_STATE_DIR',
    durationMinutes: 'AGENT_DURATION_MINUTES',
    respawn: 'AGENT_RESPAWN',
    allowFlight: 'AGENT_ALLOW_FLIGHT',
    quiet: 'AGENT_QUIET',
    reconnect: 'AGENT_RECONNECT',
    personality: 'AGENT_PERSONALITY',
    toolsModule: 'AGENT_TOOLS_MODULE',
};

const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
const SANDBOXES = ['none', 'local', 'docker', 'e2b'];

export function defaultSandbox(env, probeDocker = dockerAvailable) {
    if (env.E2B_API_KEY) return 'e2b';
    return probeDocker() ? 'docker' : 'local';
}

const bool = v => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(String(v)));

export function readConfigFile(file) {
    if (!file) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error(`${file} must contain a JSON object`);
    return parsed;
}

export function fromEnv(env = process.env) {
    const out = {};
    for (const [key, name] of Object.entries(ENV))
        if (env[name] !== undefined && env[name] !== '') out[key] = env[name];
    return out;
}

export function parseModelRef(ref) {
    const value = String(ref ?? '').trim();
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1)
        throw new Error(`Model must look like <provider>/<model-id>, got "${value}"`);
    return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function resolveConfig(
    layers,
    { env = process.env, cwd = process.cwd(), now = Date.now(), probeDocker = dockerAvailable } = {},
) {
    const raw = Object.assign({}, DEFAULTS, ...layers.filter(Boolean));
    const errors = [];
    const port = Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push(`port must be 1-65535, got ${raw.port}`);
    if (!['offline', 'microsoft'].includes(raw.auth)) errors.push(`auth must be offline or microsoft, got ${raw.auth}`);
    if (!/^[A-Za-z0-9_]{1,16}$/.test(raw.name ?? ''))
        errors.push('name must be 1-16 letters, digits or underscores (a valid Minecraft username)');
    if (!String(raw.objective ?? '').trim())
        errors.push('objective is required, for example --objective "Build a cozy oak cabin near spawn"');
    const contextWindow = raw.contextWindow == null ? undefined : Number(raw.contextWindow);
    const maxTokens = raw.maxTokens == null ? undefined : Number(raw.maxTokens);
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1))
        errors.push('contextWindow must be a positive integer');
    if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1))
        errors.push('maxTokens must be a positive integer');
    if (contextWindow !== undefined && maxTokens !== undefined && maxTokens >= contextWindow)
        errors.push('maxTokens must be smaller than contextWindow');
    if (
        raw.thinkingBudgetTokens !== undefined &&
        !(Number.isInteger(Number(raw.thinkingBudgetTokens)) && Number(raw.thinkingBudgetTokens) >= 0)
    )
        errors.push('thinkingBudgetTokens must be a non-negative integer');
    errors.push(...validateAnomalies(raw.anomalies));
    if (!['survival', 'creative'].includes(raw.gameMode))
        errors.push(`gameMode must be survival or creative, got ${raw.gameMode}`);
    if (!THINKING.includes(raw.thinking)) errors.push(`thinking must be one of ${THINKING.join(', ')}`);
    const tickRate = Number(raw.tickRate);
    if (!(tickRate > 0 && tickRate <= 20)) errors.push('tickRate must be between 1 and 20');
    const sandbox = raw.sandbox ?? defaultSandbox(env, probeDocker);
    if (!SANDBOXES.includes(sandbox)) errors.push(`sandbox must be one of ${SANDBOXES.join(', ')}`);
    if (sandbox === 'e2b' && !env.E2B_API_KEY) errors.push('sandbox e2b needs E2B_API_KEY');
    let model;
    try {
        model = parseModelRef(raw.model);
    } catch (e) {
        errors.push(e.message);
    }
    let deadlineAt = raw.deadlineAt ?? null;
    if (raw.durationMinutes !== undefined && raw.durationMinutes !== null) {
        const minutes = Number(raw.durationMinutes);
        if (!(minutes > 0)) errors.push('durationMinutes must be a positive number');
        else deadlineAt = new Date(now + minutes * 60000).toISOString();
    }
    if (errors.length) throw Object.assign(new Error(errors.join('\n')), { code: 'INVALID_CONFIG' });
    const stateDir = path.resolve(cwd, raw.stateDir);
    const soul = raw.soul ?? (raw.soulFile ? readFileSync(path.resolve(cwd, raw.soulFile), 'utf8') : undefined);
    return {
        host: raw.host,
        port,
        auth: raw.auth,
        minecraftVersion: raw.minecraftVersion,
        name: raw.name,
        objective: String(raw.objective).trim(),
        gameMode: raw.gameMode,
        personality: raw.personality,
        soul,
        team: bool(raw.team ?? false),
        publicStatusUpdates: bool(raw.publicStatusUpdates ?? false),
        anomalies: Array.isArray(raw.anomalies) ? raw.anomalies : [],
        peers: Array.isArray(raw.peers) ? raw.peers.filter(n => /^[A-Za-z0-9_]{1,16}$/.test(n) && n !== raw.name) : [],
        model: {
            ...model,
            ...(raw.baseUrl ? { baseUrl: raw.baseUrl, name: raw.modelName ?? model.id } : {}),
            ...(raw.baseUrl && contextWindow !== undefined ? { contextWindow } : {}),
            ...(raw.baseUrl && maxTokens !== undefined ? { maxTokens } : {}),
            ...(raw.serviceTier ? { serviceTier: raw.serviceTier } : {}),
            ...(raw.offEffort ? { offEffort: String(raw.offEffort) } : {}),
            ...(raw.baseUrl && raw.thinkingBudgetTokens !== undefined
                ? { thinkingBudgetTokens: Number(raw.thinkingBudgetTokens) }
                : {}),
            ...(raw.requestTimeoutMs ? { requestTimeoutMs: Number(raw.requestTimeoutMs) } : {}),
            ...(raw.baseUrl && raw.apiKeyHeader && env.MODEL_API_KEY
                ? { headers: { [raw.apiKeyHeader]: env.MODEL_API_KEY } }
                : {}),
        },
        apiKey: raw.baseUrl ? env.MODEL_API_KEY : undefined,
        modelsPath: raw.modelsFile ? path.resolve(cwd, raw.modelsFile) : null,
        thinking: raw.thinking,
        tickRate,
        vision: bool(raw.vision),
        respawn: bool(raw.respawn),
        allowFlight: bool(raw.allowFlight),
        quiet: bool(raw.quiet ?? false),
        reconnect: raw.reconnect === undefined ? true : bool(raw.reconnect),
        sandbox: {
            kind: sandbox,
            apiKey: sandbox === 'e2b' ? env.E2B_API_KEY : undefined,
            template: raw.e2bTemplate ?? env.E2B_TEMPLATE,
            image: raw.dockerImage,
            memory: raw.dockerMemory,
            cpus: raw.dockerCpus,
        },
        sharedMachineSocket: raw.sharedMachineSocket,
        sharedMachinePath: raw.sharedMachinePath,
        sharedMachineVm: raw.sharedMachineVm,
        cohort: raw.cohort,
        toolsModule: raw.toolsModule ? path.resolve(cwd, raw.toolsModule) : null,
        toolOptions: raw.toolOptions && typeof raw.toolOptions === 'object' ? raw.toolOptions : {},
        stateDir,
        deadlineAt,
    };
}

export function toSettings(config) {
    const shared = path.join(config.stateDir, 'shared');
    const mine = path.join(config.stateDir, config.name);
    const comms = config.team ? shared : mine;
    return {
        minecraft_version: config.minecraftVersion,
        host: config.host,
        port: config.port,
        auth: config.auth,
        profile: {
            name: config.name,
            objective: config.objective,
            gameMode: config.gameMode,
            personality: config.personality,
            soul: config.soul,
            peers: config.peers,
            anomalies: config.anomalies,
            team: config.team,
            publicStatusUpdates: config.publicStatusUpdates,
            pi: {
                stateRoot: path.join(config.stateDir, config.name),
                sharedRoot: shared,
                mailboxPath: path.join(comms, 'mailbox.sqlite'),
                planPath: path.join(comms, 'plan.md'),
                deadlineAt: config.deadlineAt,
            },
        },
    };
}

export function toAgentOptions(config) {
    return {
        model: config.model,
        apiKey: config.apiKey,
        modelsPath: config.modelsPath,
        thinkingLevel: config.thinking,
        vision: config.vision,
        tickRate: config.tickRate,
        respawn: config.respawn,
        allowFlight: config.allowFlight,
        sandbox: config.sandbox,
        sharedMachineSocket: config.sharedMachineSocket,
        sharedMachinePath: config.sharedMachinePath,
        sharedMachineVm: config.sharedMachineVm,
        cohort: config.cohort,
        toolsModule: config.toolsModule,
        toolOptions: config.toolOptions,
    };
}
