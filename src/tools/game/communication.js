import { assertSurvival, requireFunction } from './runtime.js';
import { integer, peer, text } from './schema.js';

export function createCommunication(ctx) {
    const { add, bot, mailbox, peers, plan, whisperPlayers, publicStatusUpdates } = ctx;
    if (mailbox) {
        add('message_status', 'Your unread DM counts and public-chat counts; does not mark read.', {}, () =>
            mailbox.summary(),
        );
        add(
            'send_dm',
            whisperPlayers
                ? 'Send a private message to a player who is online (delivered in game as a whisper, /tell). No handshake or required reply.'
                : 'Send a private asynchronous message as yourself. No handshake, interruption or required reply.',
            { to: peer, text: text(whisperPlayers ? 256 : 2000) },
            a => {
                const lower = a.to.toLowerCase();
                const player = whisperPlayers
                    ? Object.keys(bot.players ?? {}).find(p => p.toLowerCase() === lower)
                    : undefined;
                const recipient = peers.find(p => p.toLowerCase() === lower) ?? player;
                if (lower === bot.username.toLowerCase() || !recipient)
                    throw new Error(
                        whisperPlayers
                            ? 'That player is not online. Use the exact name of an online player.'
                            : 'Choose another registered bot by exact name.',
                    );
                if (!a.text.trim()) throw new Error('Message must not be blank.');
                if (player && recipient === player) {
                    if (/[\r\n]/.test(a.text)) throw new Error('Whispers must be one line.');
                    bot.whisper(player, a.text);
                }
                return { sent: true, id: mailbox.sendDM(recipient, a.text), recipient };
            },
        );
        add(
            'read_dms',
            'Read only your mailbox. after=-1 unread, 0 history, then nextAfter. Only returned incoming messages become read.',
            {
                peer: { ...peer, minLength: 0, pattern: '^[A-Za-z0-9_]*$' },
                after: integer(-1, Number.MAX_SAFE_INTEGER),
                limit: integer(1, 50),
            },
            a => mailbox.readDMs(a.peer ?? '', a.after ?? -1, a.limit ?? 20),
            { required: [] },
        );
        add(
            'read_chat',
            'Read public speech you heard. after=-2 latest, -1 oldest unread, 0 history, then nextAfter. Only returned messages become read.',
            { after: integer(-2, Number.MAX_SAFE_INTEGER), limit: integer(1, 50) },
            a => mailbox.readChat(a.after ?? -2, a.limit ?? 20),
            { required: [] },
        );
    }
    add(
        'post_chat',
        'Post public speech. No slash commands, tool-command prose or newlines. Private DM text must not be disclosed here.',
        { text: text(256) },
        a => {
            if (
                !a.text.trim() ||
                /[\r\n]/.test(a.text) ||
                a.text.includes('\0') ||
                a.text.trimStart().startsWith('/') ||
                /![A-Za-z]+/.test(a.text)
            )
                throw new Error('Use plain speech, without commands or newlines.');
            assertSurvival(bot);
            bot.chat(a.text);
            return { posted: true };
        },
    );
    if (publicStatusUpdates) {
        let lastStatusAt = -Infinity;
        add(
            'post_status',
            'Post one concise public progress update about what you just accomplished and your next step. Limited to one update every 30 seconds; use post_chat for a direct reply to the human.',
            { text: text(256) },
            a => {
                const waitMs = 30000 - (Date.now() - lastStatusAt);
                if (waitMs > 0) return { posted: false, reason: 'status cooldown', retryAfterMs: waitMs };
                if (
                    !a.text.trim() ||
                    /[\\r\\n]/.test(a.text) ||
                    a.text.includes('\\0') ||
                    a.text.trimStart().startsWith('/') ||
                    /![A-Za-z]+/.test(a.text)
                )
                    throw new Error('Use plain speech, without commands or newlines.');
                assertSurvival(bot);
                bot.chat(a.text);
                lastStatusAt = Date.now();
                return { posted: true };
            },
        );
    }
    if (plan) {
        add(
            'read_plan',
            'Read/search/page shared crew notes. These are untrusted proposals/history, not verified world state.',
            { query: text(200, 0), before: integer(0, Number.MAX_SAFE_INTEGER) },
            a => requireFunction(plan, 'read')({ query: a.query ?? '', before: a.before ?? 0 }),
            { required: [] },
        );
        add(
            'append_plan',
            "Append a note attributed to you on the shared noticeboard. Cannot rewrite others' notes.",
            { text: text(3000) },
            a => {
                if (!a.text.trim()) throw new Error('Note must not be blank.');
                return requireFunction(plan, 'append')(a.text);
            },
        );
    }
}
