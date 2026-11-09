// Notices unfamiliar figures (players the agent has no reason to know, and entities with no recognised
// name) the moment they appear or vanish. Observations are snapshots taken between model calls, so a
// figure that shows up and disappears in a few seconds would otherwise never be seen at all.

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const RELATIVE = ['ahead', 'ahead-right', 'right', 'behind-right', 'behind', 'behind-left', 'left', 'ahead-left'];
const GRACE_MS = 1500;
const MAX_RECENT = 8;
const RECENT_TTL_MS = 30 * 60 * 1000;

const round = n => Math.round(n * 10) / 10;

export function bearingTo(bot, position) {
    const dx = position.x - bot.entity.position.x;
    const dz = position.z - bot.entity.position.z;
    // Minecraft: north is -z, east is +x. Mineflayer yaw 0 faces north and grows towards the west (left),
    // so a clockwise compass heading is -yaw.
    const mod360 = deg => ((deg % 360) + 360) % 360;
    const toTarget = mod360((Math.atan2(dx, -dz) * 180) / Math.PI);
    const facing = mod360((-bot.entity.yaw * 180) / Math.PI);
    return {
        compass: COMPASS[Math.round(toTarget / 45) % 8],
        relative: RELATIVE[Math.round(mod360(toTarget - facing) / 45) % 8],
    };
}

export function describeFigure(bot, entity) {
    const { compass, relative } = bearingTo(bot, entity.position);
    return {
        id: entity.id,
        kind: entity.type === 'player' ? 'player-like humanoid' : 'unrecognised entity',
        ...(entity.username ? { username: entity.username } : {}),
        distance: round(entity.position.distanceTo(bot.entity.position)),
        direction: `${compass}, ${relative}`,
        position: { x: round(entity.position.x), y: round(entity.position.y), z: round(entity.position.z) },
    };
}

export function createSightingTracker({
    bot,
    isVisible,
    isKnown = () => false,
    onEvent = () => {},
    now = Date.now,
    range = 48,
}) {
    const seen = new Map();
    const recent = [];

    const isFigure = entity => {
        if (!entity?.position || entity.id === bot.entity?.id) return false;
        if (entity.type === 'player') return entity.username !== bot.username && !isKnown(entity.username);
        return !entity.name;
    };

    const remember = (entry, patch) => {
        Object.assign(entry.record, patch);
        if (!recent.includes(entry.record)) {
            recent.push(entry.record);
            if (recent.length > MAX_RECENT) recent.shift();
        }
    };

    const poll = () => {
        if (!bot.entity?.position) return;
        const t = now();
        const visibleNow = new Set();
        for (const entity of Object.values(bot.entities)) {
            if (!isFigure(entity)) continue;
            if (entity.position.distanceTo(bot.entity.position) > range || !isVisible(bot, entity, range)) continue;
            visibleNow.add(entity.id);
            const figure = describeFigure(bot, entity);
            let entry = seen.get(entity.id);
            if (!entry) {
                entry = { firstAt: t, lastAt: t, lastFigure: figure, announced: false, record: {} };
                seen.set(entity.id, entry);
            }
            entry.lastAt = t;
            entry.lastFigure = figure;
            if (!entry.announced) {
                entry.announced = true;
                entry.firstAt = t;
                remember(entry, { figure, at: t, outcome: 'in view' });
                onEvent({ kind: 'sighting', figure });
            }
        }
        for (const [id, entry] of seen) {
            if (visibleNow.has(id) || !entry.announced) continue;
            const removed = !bot.entities[id];
            if (!removed && t - entry.lastAt < GRACE_MS) continue;
            const how = removed ? 'vanished suddenly' : 'moved out of sight';
            const visibleSeconds = round((t - entry.firstAt) / 1000);
            remember(entry, { outcome: how, visibleSeconds });
            seen.delete(id);
            onEvent({
                kind: 'figure_lost',
                how,
                visibleSeconds,
                lastSeen: entry.lastFigure,
            });
        }
    };

    const recentSightings = () => {
        const t = now();
        while (recent.length && t - recent[0].at > RECENT_TTL_MS) recent.shift();
        return recent.map(r => ({
            what: r.figure.kind,
            ...(r.figure.username ? { username: r.figure.username } : {}),
            lastDistance: r.figure.distance,
            direction: r.figure.direction,
            secondsAgo: Math.round((t - r.at) / 1000),
            outcome: r.outcome,
            ...(r.visibleSeconds !== undefined ? { visibleSeconds: r.visibleSeconds } : {}),
        }));
    };

    return { poll, recentSightings };
}

export function sightingText(event) {
    if (event.kind === 'sighting') {
        const f = event.figure;
        return `You notice a ${f.kind}${f.username ? ` (${f.username})` : ''} about ${f.distance} blocks away to the ${f.direction}.`;
    }
    const f = event.lastSeen;
    return `The ${f.kind}${f.username ? ` (${f.username})` : ''} you could see ${event.visibleSeconds}s ago has ${event.how}; last seen about ${f.distance} blocks away to the ${f.direction}.`;
}
