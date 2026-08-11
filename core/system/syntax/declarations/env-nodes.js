// ФАЙЛ: server/syntax/declarations/env-nodes.js
const { CobaltRegistry, CobaltCategory, CobaltValueType } = require('../core/CobaltRegistry.js');

function registerEnvNodes() {

    CobaltRegistry.registerNode('user', {
        category: CobaltCategory.NAMES,
        handler: ({ env }) => env.names.user || '',
    });

    CobaltRegistry.registerNode('char', {
        category: CobaltCategory.NAMES,
        handler: ({ env }) => env.names.char || '',
    });

    CobaltRegistry.registerNode('charPrompt', {
        category: CobaltCategory.CHARACTER,
        handler: ({ env, resolve }) => resolve(env.character?.charPrompt || ''),
    });

    CobaltRegistry.registerNode('charInstruction', {
        category: CobaltCategory.CHARACTER,
        handler: ({ env, resolve }) => resolve(env.character?.charInstruction || ''),
    });

    CobaltRegistry.registerNode('charDescription', {
        aliases: [{ alias: 'description' }],
        category: CobaltCategory.CHARACTER,
        handler: ({ env, resolve }) => resolve(env.character?.description || ''),
    });

    CobaltRegistry.registerNode('charPersonality', {
        aliases: [{ alias: 'personality' }],
        category: CobaltCategory.CHARACTER,
        handler: ({ env, resolve }) => resolve(env.character?.personality || ''),
    });

    CobaltRegistry.registerNode('charScenario', {
        aliases: [{ alias: 'scenario' }],
        category: CobaltCategory.CHARACTER,
        handler: ({ env, resolve }) => resolve(env.character?.scenario || ''),
    });

    CobaltRegistry.registerNode('persona', {
        category: CobaltCategory.CHARACTER,
        handler: ({ env, resolve }) => resolve(env.character?.persona || ''),
    });

    CobaltRegistry.registerNode('mesExamplesRaw', {
        category: CobaltCategory.CHARACTER,
        handler: ({ env, resolve }) => resolve(env.character?.mesExamplesRaw || ''),
    });

    CobaltRegistry.registerNode('charFirstMessage', {
        aliases: [{ alias: 'greeting' }],
        category: CobaltCategory.CHARACTER,
        unnamedArgs: [{ name: 'index', optional: true, defaultValue: '0', type: CobaltValueType.INTEGER }],
        handler: ({ env, unnamedArgs: [index], resolve }) => {
            const i = Number(index ?? 0);
            if (i === 0) return resolve(env.character?.firstMessage || '');
            const alt = env.character?.alternateGreetings;
            if (!Array.isArray(alt)) return '';
            return resolve(alt[i - 1] || '');
        },
    });

    CobaltRegistry.registerNode('model', {
        category: CobaltCategory.STATE,
        handler: ({ env }) => env.system?.model || '',
    });
}

module.exports = { registerEnvNodes };