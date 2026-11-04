import { createObservation } from './game/observation.js';
import { createActionRunner, installSkillCompatibility } from './game/runtime.js';
import { createHelpers } from './game/helpers.js';
import { createCore } from './game/core.js';
import { createPerception } from './game/perception.js';
import { createMovement } from './game/movement.js';
import { createGathering } from './game/gathering.js';
import { createPlacement } from './game/placement.js';
import { createBuilding } from './game/building.js';
import { createItems } from './game/items.js';
import { createCombat } from './game/combat.js';
import { createCrafting } from './game/crafting.js';
import { createContainers } from './game/containers.js';
import { createCommunication } from './game/communication.js';

export { failureCode, withFailureCode, withFailureFacts } from './game/failures.js';
export {
    DOORISH,
    KEEP_MOVING_TOOLS,
    NATURAL_TERRAIN,
    SAFE_DROP,
    doorOpen,
    edgeGuardTick,
    fmtDrop,
    installEdgeGuard,
    installSwimGuard,
    interruptsOnHit,
    openDropBelow,
    swimGuardTick,
    tossLandDistance,
    tossPitchFor,
} from './game/guards.js';
export { createObservation } from './game/observation.js';
export {
    CHEST_MS,
    CRAFT_MS,
    GATHER_MS,
    LATE_MUTATION_REFUSED,
    PLACE_LINE_MS,
    PLACE_MS,
    SMELT_MS,
    createActionRunner,
    installSkillCompatibility,
    settleInventory,
    stopBody,
} from './game/runtime.js';

const TOOL_ORDER = [
    'observe_world',
    'inventory',
    'stop_action',
    'go_to',
    'fly_to',
    'move',
    'look',
    'gather',
    'return_to_surface',
    'break_block',
    'break_area',
    'place',
    'place_line',
    'inspect_block',
    'door',
    'go_through_door',
    'interact_block',
    'interact_entity',
    'equip',
    'eat',
    'use_item',
    'select_hotbar',
    'view_window',
    'click_slot',
    'close_window',
    'drop_item',
    'attack',
    'flee',
    'craft',
    'open_container',
    'furnace',
    'smelt',
    'deposit',
    'withdraw',
    'sleep',
    'wake',
    'message_status',
    'send_dm',
    'read_dms',
    'read_chat',
    'post_chat',
    'read_plan',
    'append_plan',
];
const BUILDERS = [
    createHelpers,
    createCore,
    createPerception,
    createMovement,
    createGathering,
    createPlacement,
    createBuilding,
    createItems,
    createCombat,
    createCrafting,
    createContainers,
    createCommunication,
];

export function createGameTools({
    bot,
    mailbox,
    skills = {},
    observe,
    actionRunner,
    perception,
    world,
    captureFrame,
    plan,
    peers = [],
    perStepFrames = false,
    whisperPlayers = false,
    publicStatusUpdates = false,
    extraTools = [],
} = {}) {
    installSkillCompatibility(bot);
    const runner = actionRunner ?? createActionRunner(bot);
    observe ??= createObservation({ bot, perception, world, captureFrame, mailbox });
    const tools = [];
    const ctx = {
        bot,
        mailbox,
        skills,
        observe,
        actionRunner,
        perception,
        world,
        captureFrame,
        plan,
        peers,
        perStepFrames,
        whisperPlayers,
        publicStatusUpdates,
        runner,
        tools,
    };
    for (const build of BUILDERS) Object.assign(ctx, build(ctx));
    for (const spec of extraTools) {
        if (!/^[a-z][a-z0-9_]{1,40}$/.test(spec?.name ?? '') || typeof spec.run !== 'function')
            throw new Error(`Extra tool needs a snake_case name and a run function: ${spec?.name}`);
        if (tools.some(t => t.name === spec.name))
            throw new Error(`Extra tool ${spec.name} clashes with a built-in tool`);
        ctx.add(spec.name, String(spec.description ?? ''), spec.properties ?? {}, spec.run, {
            body: spec.body === true,
            ...(spec.required ? { required: spec.required } : {}),
        });
    }
    const rank = tool => {
        const index = TOOL_ORDER.indexOf(tool.name);
        return index < 0 ? TOOL_ORDER.length : index;
    };
    tools.sort((a, b) => rank(a) - rank(b));
    return tools;
}
