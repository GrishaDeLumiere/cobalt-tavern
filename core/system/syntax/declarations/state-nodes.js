// ФАЙЛ: server/syntax/declarations/state-nodes.js
const { CobaltRegistry, CobaltCategory, CobaltValueType } = require('../core/CobaltRegistry.js');

function registerStateNodes() {
    CobaltRegistry.registerNode('lastGenerationType', {
        category: CobaltCategory.STATE,
        handler: ({ env }) => {
            return env.serverLayer?.sysConfig?.lastGenerationType || 'normal';
        },
    });

    CobaltRegistry.registerNode('hasExtension', {
        category: CobaltCategory.STATE,
        unnamedArgs: [{ name: 'extensionName', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [extensionName] }) => {
            const extensions = env.serverLayer?.sysConfig?.extensions || {};
            return extensions[extensionName] ? 'true' : 'false';
        },
    });
}

module.exports = { registerStateNodes };