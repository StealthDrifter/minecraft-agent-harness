Warning: truncated output (original token count: 9036)
Total output lines: 857

import { mkdir, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createSessionHistoryTool } from './session-history.js';
import { failureCode } from '../tools/game-tools.js';
import { findModel } from './extra-models.js';
import { sanitizeImages, isImageRejection, redactPayloads } from './image-guard.js';

export async function createMinecraftSession(options, dependencies = {}) {
    const runner = new MinecraftSession(options, dependencies);
    await runner.init();
    return runner;
}

export async function createPiSession(options, modules) {
    const sdk = modules?.sdk ?? (await import('@earendil-works/pi-coding-agent'));
    const directory = join(resolve(options.sessionDir), options.agentId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const settingsManager = sdk.SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: false, provider: { maxRetries: 0 } },
        enableAnalytics: false,
        enableInstallTelemetry: false,
        enableSkillCommands: false,
    });
    const modelRuntime = await sdk.ModelRuntime.create({
        authPath: join(directory, 'auth.json'),
        modelsPath: options.modelsPath ?? null,
        allowModelNetwork: false,
    });
    const m = options.model ?? {};
    const model = m.baseUrl
        ? await registerCompatibleModel(modelRuntime, m, options, modules)
        : await resolveCatalogModel(modelRuntime, m, options);
    const resourceLoader = new sdk.DefaultResourceLoader({
        cwd: options.cwd,
        agentDir: directory,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: options.systemPrompt,
    });
    await resourceLoader.reload();
    const sessionManager = sdk.SessionManager.continueRecent(options.cwd, directory);
    const { session } = await sdk.createAgentSession({
        cwd: options.cwd,
        agentDir: directory,
        modelRuntime,
        model,
        thinkingLevel: options.thinkingLevel ?? 'medium',
        sessionManager,
        settingsManager,
        resourceLoader,
        noTools: 'builtin',
        tools: options.tools.map(tool => tool.name),
        customTools: options.tools,
    });
    return { session, sessionManager, compatible: Boolean(m.baseUrl) };
}

async function resolveCatalogModel(modelRuntime, m, options) {
    if (!m.provider || !m.id)
        throw new Error('Model must be given as <provider>/<model-id>, for example openai/gpt-6.1-terra');
    if (options.apiKey) await modelRuntime.setRuntimeApiKey(m.provider, options.apiKey);
    const model = findModel(modelRuntime, m.provider, m.id);
    if (!model)
        throw new Error(
            `Unknown model ${m.provider}/${m.id}. Use a model from the pi catalog, a models.json entry, or set a base URL for an OpenAI Responses compatible endpoint.`,
        );
    return model;
}

async function registerCompatibleModel(modelRuntime, m, options, modules) {
    const responses = modules?.responses ?? (await import('@earendil-works/pi-ai/api/openai-responses'));
    const provider = m.provider || 'custom';
    modelRuntime.registerProvider(provider, {
        api: 'openai-responses',
        baseUrl: m.baseUrl,
        models: [
            {
                contextWindow: m.contextWindow ?? 128000,
                maxTokens: m.maxTokens ?? 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                ...options.modelConfig,
                thinkingLevelMap: { off: m.offEffort ?? 'low' },
                id: m.id,
                name: m.name ?? m.id,
                reasoning: true,
                input: m.input ?? ['text', 'image'],
                api: 'openai-responses',
            },
        ],
        streamSimple: (model, context, streamOptions) =>
            responses.stream(model, context, {
                ...streamOptions,
                maxTokens: Math.min(streamOptions?.maxTokens ?? model.maxTokens, model.maxTokens),
                ...(m.headers ? { headers: { ...streamOptions?.headers, ...m.headers } } : {}),
                ...(m.serviceTier ? { serviceTier: m.serviceTier } : {}),
                ...(m.requestTimeoutMs
                    ? {
                          signal: streamOptions?.signal
                              ? AbortSignal.any([streamOptions.signal, AbortSignal.timeout(m.requestTimeoutMs)])
                              : AbortSignal.timeout(m.requestTimeoutMs),
                      }
                    : {}),
            }),
    });
    if (options.apiKey) await modelRuntime.setRuntimeApiKey(provider, options.apiKey);
    const model = modelRuntime.getModel(provider, m.id);
    if (!model) throw new Error('Model registration failed');
    return model;
}

const BREAKPOINT_TYPES = new Set(['input_text', 'input_image', 'input_file']);
function markParts(parts) {
    if (!Array.isArray(parts) || !parts.length) return null;
    const last = parts.at(-1);
    if (!last || !BREAKPOINT_TYPES.has(last.type)) return null;
    return [...parts.slice(0, -1), { ...last, prompt_cache_breakpoint: { mode: 'explicit' } }];
}
const TOOL_NOTE = '(tool results above)';
export function anthropicPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const strip = parts =>
        Array.isArray(parts)
            ? parts.map(p => {
                  if (!p?.prompt_cache_breakpoint) return p;
                  const { prompt_cache_breakpoint, ...rest } = p;
                  return rest;
              })
            : parts;
    const { prompt_cache_key, ...rest } = payload;
    if (!Array.isArray(rest.input)) return rest;
    const src = rest.input,
        out = [];
    let lastNote = -1;
    for (let i = 0; i < src.length; i++) {
        const it = src[i];
        out.push(
            it?.type === 'function_call_output'
                ? { ...it, output: strip(it.output) }
                : Array.isArray(it?.content)
                  ? { ...it, content: strip(it.content) }
                  : it,
        );
        if (it?.type === 'function_call_output' && src[i + 1]?.type !== 'function_call_output') {
            out.push({ role: 'user', content: [{ type: 'input_text', text: TOOL_NOTE }] });
            if (i + 1 < src.length) lastNote = out.length - 1;
        }
    }
    if (lastNote >= 0)
        out[lastNote] = {
            role: 'user',
            content: [{ type: 'input_text', text: TOOL_NOTE, cache_control: { type: 'ephemeral' } }],
        };
    return { ...rest, input: out };
}
export function markCacheBreakpoint(payload) {
    const input = payload?.input;
    if (!Array.isArray(input) || input.length < 2) return payload;
    for (let i = input.length - 2; i >= 0; i--) {
        const item = input[i];
        let next = null;
        if (item?.type === 'function_call_output') {
            const parts = markParts(
                typeof item.output === 'string' ? [{ type: 'input_text', text: item.output }] : item.output,
            );
            if (parts) next = { ...item, output: parts };
        } else if (item?.role === 'user' || item?.role === 'developer' || item?.role === 'system') {
            const parts = markParts(
                typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : item.content,
            );
            if (parts) next = { ...item, content: parts };
        }
        if (next) {
            const copy = [...input];
            copy[i] = next;
            return { ...payload, input: copy };
        }
    }
    return payload;
}

const STATE_TYPE = 'minecraft-scheduler-v1';
const defaultClock = { now: () => Date.now(), setTimeout, clearTimeout };
const stopError = () => new Error('Minecraft cycle stopped');
function safeErrorMetadata(error) {
    const names = new Set([
        'Error',
        'TypeError',
        'RangeError',
        'AbortError',
        'TimeoutError',
        'APIError',
        'APIConnectionError',
        'APIConnectionTimeoutError',
        'AuthenticationError',
        'PermissionDeniedError',
        'RateLimitError',
        'BadRequestError',
        'InternalServerError',
        'NotFoundError',
    ]);
    const codes = new Set([
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ERR_MODULE_NOT_FOUND',
        'ERR_PACKAGE_PATH_NOT_EXPORTED',
        'ABORT_ERR',
        'invalid_api_key',
        'insufficient_quota',
        'rate_limit_exceeded',
        'model_not_found',
        'context_length_exceeded',
    ]);
    const metadata = { errorName: names.has(error?.name) ? error.name : 'Error' };
    if (codes.has(error?.code)) metadata.errorCode = error.code;
    const status = error?.status ?? error?.statusCode;
    if (Number.isInteger(status) && status >= 400 && status <= 599) metadata.httpStatus = status;
    return metadata;
}
const FATAL_MODEL_ERROR =
    /\b(401|403)\b|invalid.{0,3}(x-)?api.{0,3}key|incorrect api key|authentication|unauthori[sz]ed|permission_denied|no api key|api key not|credit balance|insufficient_quota|billing|model_not_found|not_found_error|model.{0,40}(not found|does not exist)/i;

export function interruptedTurn(entries, max = 1500) {
    const last = entries.filter(entry => entry.type === 'message').at(-1)?.message;
    if (last?.role !== 'assistant' || last.stopReason !== 'aborted') return null;
    const text = (last.content ?? [])
        .map(block => (block.type === 'thinking' ? block.thinking : block.type === 'text' ? block.text : ''))
        .filter(Boolean)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
    return { notes: text.length > max ? `...${text.slice(-max)}` : text };
}

export function resumePrompt({ reconnected = false, interrupted = null } = {}) {
    if (!reconnected && !i…4036 tokens truncated…ons.hitRestartMs ?? 2000;
                    const informed =
                        (this.options.hitInfoAt?.() ?? -Infinity) >= (this.active.callStartedAt ?? Infinity) - 10000;
                    if (!informed && now - (this.lastRestartAt ?? -Infinity) >= gap) {
                        this.lastRestartAt = now;
                        this.diagnose({ event: 'hit_restart', step: this.active.steps });
                        this.stopCycle('hit');
                    }
                }
            } else this.arm(this.nextWakeAt);
        }
        return true;
    }

    requestWait(untilMs) {
        if (!Number.isFinite(untilMs)) throw new Error('Wait requires finite epoch milliseconds');
        if (!this.active) throw new Error('Wait requires active cycle');
        this.nextWakeAt = Math.min(
            Math.max(untilMs, this.clock.now() + this.options.minWakeMs),
            this.active.wakeAt ?? Infinity,
        );
        this.save();
        this.active.stop = 'wait';
        return this.nextWakeAt;
    }

    arm(at) {
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        if (this.paused || this.closed || this.active) return;
        const delay = Math.min(2147483647, Math.max(0, at - this.clock.now()));
        this.timer = this.clock.setTimeout(() => {
            this.timer = null;
            if (this.paused || this.closed) return;
            if (at > this.clock.now()) {
                this.arm(at);
                return;
            }
            this.work = this.runCycle();
        }, delay);
    }

    setThinking(level) {
        if (!level) return;
        try {
            this.session.setThinkingLevel?.(level);
        } catch {}
    }

    abortAgent() {
        try {
            void Promise.resolve(this.session.abort()).catch(() => {});
        } catch {}
    }

    stopCycle(reason) {
        if (!this.active) return;
        this.active.stop = reason;
        this.active.controller.abort();
        this.abortAgent();
    }

    async runCycle() {
        if (this.active || this.paused || this.closed) return;
        const cycle = {
            controller: new AbortController(),
            events: [...this.queue.values()],
            steps: 0,
            tools: 0,
            stop: null,
            failed: false,
            startedAt: this.clock.now(),
            observations: 0,
            observationMs: 0,
        };
        this.queue.clear();
        this.active = cycle;
        this.nextWakeAt = null;
        const deadline = this.clock.setTimeout(() => this.stopCycle('budget'), this.options.maxWallMs);
        const resume = this.resume;
        if (resume && this.options.resumeThinkingLevel) this.setThinking(this.options.resumeThinkingLevel);
        try {
            const headline = this.options.turnHeadline?.();
            await this.session.prompt(
                (resume ? `${resume}\n\n` : '') +
                    (headline ? `${headline}\n\n` : '') +
                    (this.options.continuous
                        ? `Next turn.${cycle.events.length ? `\nEvents since your last turn:\n${JSON.stringify(cycle.events)}` : ''}\nUse the current observation.`
                        : `Wake events:\n${JSON.stringify(cycle.events)}\nUse the current observation.`),
                { expandPromptTemplates: false },
            );
            await this.session.waitForIdle();
            const budgetLeftMs = cycle.startedAt + this.options.maxWallMs - this.clock.now();
            if (
                cycle.failed &&
                !cycle.stop &&
                !cycle.imagesDisabled &&
                isImageRejection(cycle.lastErrorMessage) &&
                (cycle.controller.signal.aborted || budgetLeftMs < 10000)
            ) {
                this.diagnose({
                    event: 'image_400_no_retry',
                    reason: cycle.controller.signal.aborted ? 'cycle aborted' : 'under 10 s of cycle budget left',
                    budgetLeftMs,
                });
            } else if (
                cycle.failed &&
                !cycle.stop &&
                !cycle.imagesDisabled &&
                isImageRejection(cycle.lastErrorMessage)
            ) {
                const messages = this.session.agent.state.messages;
                const last = messages.at(-1);
                if (last?.role === 'assistant' && last.stopReason === 'error') {
                    this.session.agent.state.messages = messages.slice(0, -1);
                    cycle.imagesDisabled = true;
                    cycle.failed = false;
                    cycle.firstError = cycle.error;
                    cycle.error = undefined;
                    cycle.imageRetries = 1;
                    this.diagnose({
                        event: 'image_400_retry',
                        step: cycle.steps,
                        action: 'retry same turn once without images',
                    });
                    await this.session.agent.continue();
                    await this.session.waitForIdle();
                }
            }
        } catch (error) {
            if (!cycle.stop) {
                cycle.failed = true;
                cycle.error = safeErrorMetadata(error);
                cycle.errorMessage = redactPayloads(String(error?.message ?? error)).slice(0, 600);
                this.diagnose({ event: 'cycle_error', step: cycle.steps, errorMessage: cycle.errorMessage });
                this.reportModelError(cycle.errorMessage);
            }
        } finally {
            this.clock.clearTimeout(deadline);
            if (resume && cycle.tools > 0) this.resume = '';
            if (resume && this.options.resumeThinkingLevel && !this.resume)
                this.setThinking(this.options.thinkingLevel);
            this.active = null;
            if (cycle.failed) {
                this.failures++;
                this.nextWakeAt =
                    this.clock.now() +
                    Math.max(
                        this.options.minWakeMs,
                        Math.min(this.options.maxBackoffMs, this.options.idleMs * 2 ** Math.min(this.failures - 1, 20)),
                    );
            } else if (cycle.stop === 'budget') {
                this.failures = 0;
                this.nextWakeAt = this.clock.now() + this.options.minWakeMs;
            } else {
                this.failures = 0;
                this.nextWakeAt ??= this.options.continuous
                    ? this.clock.now()
                    : this.clock.now() + Math.max(this.options.idleMs, this.options.minWakeMs);
            }
            const idleOnly =
                cycle.stop === 'wait' &&
                !cycle.failed &&
                !cycle.events.length &&
                (cycle.toolNames ?? []).includes('wait') &&
                cycle.toolNames.every(n => IDLE_TOOLS.has(n));
            if (idleOnly && this.options.idleBackoffMaxMs > 0 && Number.isFinite(this.nextWakeAt)) {
                this.idleStreak = (this.idleStreak ?? 0) + 1;
                const now = this.clock.now();
                const requested = Math.max(0, this.nextWakeAt - now);
                this.idleWaitUntil = this.nextWakeAt;
                if (this.idleStreak > 1)
                    this.nextWakeAt =
                        now +
                        Math.max(
                            requested,
                            Math.min(
                                this.options.idleBackoffMaxMs,
                                Math.max(requested, 15000) * 2 ** Math.min(this.idleStreak - 1, 6),
                            ),
                        );
            } else if (!cycle.failed) {
                this.idleStreak = 0;
                this.idleWaitUntil = null;
            }
            try {
                this.save();
            } catch {
                this.paused = true;
            }
            if (!this.paused && !this.closed) this.arm(this.nextWakeAt);
            metric(this.options.cycleTelemetry, {
                status: cycle.stop ?? (cycle.failed ? 'error' : 'complete'),
                ...(this.idleStreak ? { idleStreak: this.idleStreak } : {}),
                steps: cycle.steps,
                toolCalls: cycle.tools,
                observations: cycle.observations,
                observationMs: cycle.observationMs,
                timeMs: this.clock.now() - cycle.startedAt,
                nextWakeAt: !this.paused && !this.closed && Number.isFinite(this.nextWakeAt) ? this.nextWakeAt : null,
                ...cycle.error,
                ...(cycle.failed
                    ? {
                          errorMessage:
                              cycle.errorMessage ?? redactPayloads(String(cycle.lastErrorMessage ?? '')).slice(0, 600),
                      }
                    : {}),
                ...(cycle.imageRetries
                    ? { imageRetry: cycle.failed ? 'failed' : 'recovered', firstError: cycle.firstError }
                    : {}),
            });
        }
    }

    tryQuiesce() {
        if (
            this.active ||
            this.paused ||
            this.closed ||
            this.session.isIdle !== true ||
            !Number.isFinite(this.nextWakeAt)
        )
            return null;
        this.paused = true;
        this.closed = true;
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        this.save();
        return this.nextWakeAt;
    }

    async idle() {
        await this.work;
    }

    async cancel() {
        this.paused = true;
        if (this.timer !== null) this.clock.clearTimeout(this.timer);
        this.timer = null;
        this.queue.clear();
        this.nextWakeAt = null;
        this.stopCycle('cancel');
        await this.idle();
    }

    async close() {
        this.closed = true;
        await this.cancel();
        this.unsubscribe?.();
        this.session.dispose();
    }
}
