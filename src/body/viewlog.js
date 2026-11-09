// Observations are snapshots taken between model calls, so anything that comes into view and leaves again
// before the next one would leave no trace. This keeps a plain factual list of such entities for the next
// observation. It adds no labels, events or wake-ups; what any of it means is up to the agent.

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const RELATIVE = ['ahead', 'ahead-right', 'right', 'behind-right', 'behind', 'behind-left', 'left', 'ahead-left'];
const GRACE_MS = 1500;
const MAX_PENDING = 6;
const IGNORED_TYPES = new Set(['object', 'orb', 'global']);

const round = n => Math.round(n * 10) / 10;
const mod360 = deg => ((deg % 360) + 360) % 360;

export function bearingTo(bot, position) {
    const dx = position.x - bot.entity.position.x;
    const dz = position.z - bot.entity.position.z;
    // Minecraft: north is -z, east is +x. Mineflayer yaw 0 faces north and grows towards the west (left),
    // so a clockwise compass heading is -yaw.
    const toTarget = mod360((Math.atan2(dx, -dz) * 180) / Math.PI);
    const facing = mod360((-bot.entity.yaw * 180) / Math.PI);
    return {
        compass: COMPASS[Math.round(toTarget / 45) % 8],
        relative: RELATIVE[Math.round(mod360(toTarget - facing) / 45) % 8],
    };
}

export function createViewLog({ bot, isVisible, exclude = () => false, now = Date.now, range = 48 }) {
    const inView = new Map();
    let pending = [];

    const snapshot = entity => {
        const { compass, relative } = bearingTo(bot, entity.position);
        return {
            ...(entity.name ? { name: entity.name } : {}),
            ...(entity.username ? { username: entity.username } : {}),
            distance: round(entity.position.distanceTo(bot.entity.position)),
            direction: `${compass}, ${relative}`,
        };
    };

    const poll = () => {
        if (!bot.entity?.position) return;
        const t = now();
        const seenNow = new Set();
        for (const entity of Object.values(bot.entities)) {
            if (!entity?.position || entity.id === bot.entity.id || IGNORED_TYPES.has(entity.type)) continue;
            if (entity.username === bot.username || exclude(entity)) continue;
            if (entity.position.distanceTo(bot.entity.position) > range || !isVisible(bot, entity, range)) continue;
            seenNow.add(entity.id);
            const entry = inView.get(entity.id) ?? { firstAt: t };
            entry.lastAt = t;
            entry.last = snapshot(entity);
            inView.set(entity.id, entry);
        }
        for (const [id, entry] of inView) {
            if (seenNow.has(id)) continue;
            const removed = !bot.entities[id];
            if (!removed && t - entry.lastAt < GRACE_MS) continue;
            inView.delete(id);
            pending.push({
                ...entry.last,
                inViewSeconds: round((entry.lastAt - entry.firstAt) / 1000),
                ended: removed ? 'removed from the world' : 'out of line of sight',
                at: t,
            });
            if (pending.length > MAX_PENDING) pending.shift();
        }
    };

    // Returns what left view since the last call and clears it; the agent's own history is its memory.
    const drain = () => {
        const t = now();
        const out = pending.map(({ at, ...rest }) => ({ ...rest, secondsAgo: Math.round((t - at) / 1000) }));
        pending = [];
        return out;
    };

    return { poll, drain };
}
