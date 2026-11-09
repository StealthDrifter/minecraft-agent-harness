// Opt-in perception anomalies for experiments. An anomaly rule matches an entity and rewrites how it is
// described to the model (a missing name, an impossible id, a position that does not fit the distance, values
// that change on every look). The real values are reported to onApply so telemetry can keep the ground truth.

const MATCH_KEYS = ['username', 'name', 'type'];
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

export function validateAnomalies(rules) {
    if (rules === undefined) return [];
    if (!Array.isArray(rules)) return ['anomalies must be an array'];
    const errors = [];
    rules.forEach((rule, i) => {
        const where = `anomalies[${i}]`;
        const match = rule?.match;
        if (!match || typeof match !== 'object' || !MATCH_KEYS.some(k => typeof match[k] === 'string'))
            errors.push(`${where}.match needs a string username, name or type`);
        const unknown = Object.keys(match ?? {}).filter(k => !MATCH_KEYS.includes(k));
        if (unknown.length) errors.push(`${where}.match has unknown keys: ${unknown.join(', ')}`);
        for (const key of ['set', 'jitter'])
            if (rule?.[key] !== undefined && (typeof rule[key] !== 'object' || rule[key] === null))
                errors.push(`${where}.${key} must be an object`);
        if (rule?.drop !== undefined && !(Array.isArray(rule.drop) && rule.drop.every(k => typeof k === 'string')))
            errors.push(`${where}.drop must be a list of field names`);
        for (const [k, v] of Object.entries(rule?.jitter ?? {}))
            if (!(typeof v === 'number' && v >= 0)) errors.push(`${where}.jitter.${k} must be a number >= 0`);
        if (!rule?.set && !rule?.jitter && !rule?.drop) errors.push(`${where} needs set, jitter or drop`);
    });
    return errors;
}

export function createAnomalyLayer(rules = [], { onApply = () => {}, random = Math.random } = {}) {
    const find = entity =>
        rules.find(({ match }) =>
            MATCH_KEYS.every(
                key => match[key] === undefined || same(match[key], entity[key === 'type' ? 'type' : key]),
            ),
        );
    const wobble = amount => (random() * 2 - 1) * amount;

    // shown is the plain description the harness would give the model; the result replaces it.
    const apply = (entity, shown) => {
        const rule = rules.length ? find(entity) : undefined;
        if (!rule) return shown;
        const out = { ...shown, ...(rule.set ?? {}) };
        for (const [field, amount] of Object.entries(rule.jitter ?? {})) {
            if (typeof out[field] === 'number') out[field] = Math.round((out[field] + wobble(amount)) * 10) / 10;
            else if (out[field] && typeof out[field] === 'object')
                out[field] = Object.fromEntries(
                    Object.entries(out[field]).map(([axis, v]) =>
                        typeof v === 'number' ? [axis, Math.round((v + wobble(amount)) * 10) / 10] : [axis, v],
                    ),
                );
        }
        for (const field of rule.drop ?? []) delete out[field];
        onApply({ entityId: entity.id, match: rule.match, real: shown, shown: out });
        return out;
    };

    return { apply, active: rules.length > 0 };
}
