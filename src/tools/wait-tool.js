// A standalone `wait` tool for team mode. It only asks the scheduler for idle time;
// it exposes no filesystem, shell or network access (unlike the workspace tools it
// used to ship with).
export const MAX_TEAM_WAIT_SECONDS = 120;

export function createWaitTool({ requestWait, now = Date.now, maxSeconds = MAX_TEAM_WAIT_SECONDS }) {
    return {
        name: 'wait',
        label: 'wait',
        description: `Stand by in place for up to ${maxSeconds} seconds when you have nothing useful to do or are waiting for someone. A command or direct message from another player wakes you early. Prefer this to inventing busywork.`,
        parameters: {
            type: 'object',
            properties: { seconds: { type: 'number', exclusiveMinimum: 0, maximum: maxSeconds } },
            required: ['seconds'],
            additionalProperties: false,
        },
        async execute(_id, args, signal) {
            const seconds = args?.seconds;
            const fail = message => ({
                content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
                details: { ok: false, error: message },
                isError: true,
            });
            if (signal?.aborted) return fail('Operation cancelled.');
            if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > maxSeconds)
                return fail(`seconds must be a number above 0 and at most ${maxSeconds}.`);
            const deadlineMs = now() + Math.ceil(seconds * 1000);
            const until = requestWait(deadlineMs);
            return {
                content: [{ type: 'text', text: JSON.stringify({ requestedIdleUntil: until ?? deadlineMs }) }],
                details: { ok: true },
            };
        },
    };
}
