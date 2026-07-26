// ФАЙЛ: server/syntax/declarations/instruct-nodes.js
const { CobaltRegistry, CobaltCategory } = require('../core/CobaltRegistry.js');

function registerInstructNodes() {
    const getInst = (env) => env.serverLayer?.sysConfig?.instruct || {};
    const getSys = (env) => env.serverLayer?.sysConfig?.sysprompt || {};

    function registerSimple(names, getValueFn, description, category = CobaltCategory.PROMPTS) {
        const [primary, ...aliasNames] = names;
        const aliases = aliasNames.map(alias => ({ alias }));
        CobaltRegistry.registerNode(primary, {
            category,
            description,
            aliases: aliases.length > 0 ? aliases : undefined,
            handler: ({ env }) => getValueFn(env) || '',
        });
    }

    registerSimple(['instructStoryStringPrefix'], env => getInst(env).story_string_prefix, 'Instruct story string prefix.');
    registerSimple(['instructStoryStringSuffix'], env => getInst(env).story_string_suffix, 'Instruct story string suffix.');

    registerSimple(['instructUserPrefix', 'instructInput'], env => getInst(env).input_sequence, 'Instruct input / user prefix sequence.');
    registerSimple(['instructUserSuffix'], env => getInst(env).input_suffix, 'Instruct input / user suffix sequence.');

    registerSimple(['instructAssistantPrefix', 'instructOutput'], env => getInst(env).output_sequence, 'Instruct output / assistant prefix sequence.');
    registerSimple(['instructAssistantSuffix', 'instructSeparator'], env => getInst(env).output_suffix, 'Instruct output / assistant suffix sequence.');

    registerSimple(['instructSystemPrefix'], env => getInst(env).system_sequence, 'Instruct system prefix sequence.');
    registerSimple(['instructSystemSuffix'], env => getInst(env).system_suffix, 'Instruct system suffix sequence.');

    registerSimple(['instructFirstAssistantPrefix', 'instructFirstOutputPrefix'], env => getInst(env).first_output_sequence || getInst(env).output_sequence, 'Instruct first assistant prefix.');
    registerSimple(['instructLastAssistantPrefix', 'instructLastOutputPrefix'], env => getInst(env).last_output_sequence || getInst(env).output_sequence, 'Instruct last assistant prefix.');

    registerSimple(['instructStop'], env => getInst(env).stop_sequence, 'Instruct stop sequence.');
    registerSimple(['instructUserFiller'], env => getInst(env).user_alignment_message, 'Instruct user alignment filler.');
    registerSimple(['instructSystemInstructionPrefix'], env => getInst(env).last_system_sequence, 'Instruct system instruction prefix.');

    registerSimple(['instructFirstUserPrefix', 'instructFirstInput'], env => getInst(env).first_input_sequence || getInst(env).input_sequence, 'Instruct first user prefix.');
    registerSimple(['instructLastUserPrefix', 'instructLastInput'], env => getInst(env).last_input_sequence || getInst(env).input_sequence, 'Instruct last user prefix.');

    registerSimple(['defaultSystemPrompt', 'instructSystem', 'instructSystemPrompt'], env => getSys(env).content, 'Default system prompt.');

    CobaltRegistry.registerNode('systemPrompt', {
        category: CobaltCategory.PROMPTS,
        handler: ({ env }) => {
            const preferCharPrompt = env.serverLayer?.sysConfig?.prefer_character_prompt;
            if (preferCharPrompt && env.character?.charPrompt) {
                return env.character.charPrompt;
            }
            return getSys(env).content || '';
        },
    });

    const getCtx = (env) => env.serverLayer?.sysConfig?.context || {};
    registerSimple(['exampleSeparator', 'chatSeparator'], env => getCtx(env).example_separator, 'Separator between examples.');
    registerSimple(['chatStart'], env => getCtx(env).chat_start, 'Chat start marker.');
}

module.exports = { registerInstructNodes };