const fs = require('fs');
const path = require('path');

// --- ПРОПРИЕТАРНЫЕ КЛАССЫ COBALT AEGIS ---
const { CobaltTemplateCore } = require('./syntax/core/CobaltTemplateCore.js');
const { CobaltRegistry } = require('./syntax/core/CobaltRegistry.js');
const { CobaltEnvMapper } = require('./syntax/core/CobaltEnvMapper.js');

// --- ДЕКЛАРАЦИИ УЗЛОВ ---
const { registerCoreNodes } = require('./syntax/declarations/core-nodes.js');
const { registerEnvNodes } = require('./syntax/declarations/env-nodes.js');
const { registerStateNodes } = require('./syntax/declarations/state-nodes.js');
const { registerChatNodes } = require('./syntax/declarations/chat-nodes.js');
const { registerTimeNodes } = require('./syntax/declarations/time-nodes.js');
const { registerVariableNodes } = require('./syntax/declarations/variable-nodes.js');
const { registerInstructNodes } = require('./syntax/declarations/instruct-nodes.js');

let isInitialized = false;

function initAegisSyntaxEngine() {
    if (isInitialized) return;
    try {
        registerCoreNodes();
        registerEnvNodes();
        registerStateNodes();
        registerChatNodes();
        registerTimeNodes();
        registerVariableNodes();
        registerInstructNodes();

        isInitialized = true;
        console.log('\n=============================================');
        console.log('[COBALT SYNTAX ENGINE] АБСТРАКТНО-ДЕРЕВООБРАЗНЫЙ ДВИЖОК АКТИВИРОВАН.');
        console.log('=============================================\n');
    } catch (error) {
        console.error('[COBALT SYNTAX ENGINE] КРИТИЧЕСКАЯ ОШИБКА ИНИЦИАЛИЗАЦИИ:', error);
    }
}

const resolveTemplateVariables = (text, contextData = {}) => {
    if (!text || typeof text !== 'string') return '';
    if (!isInitialized) initAegisSyntaxEngine();

    const {
        charName = 'System',
        userName = 'User',
        chat = { messages: [] },
        character = {},
        persona = {},
        sysConfig = {},
        variables = { local: new Map(), global: new Map() }
    } = contextData;

    // Формируем слой среды для парсера (Aegis Env)
    const envCtx = {
        content: text,
        name1Override: userName,
        name2Override: charName,
        replaceCharacterCard: true,
        dynamicNodes: {
            'user': userName,
            'char': charName
        },
        serverLayer: {
            chat,
            character,
            sysConfig,
            variables,
            persona
        }
    };

    try {
        const env = CobaltEnvMapper.buildFromRawEnv(envCtx);
        env.serverLayer = envCtx.serverLayer;
        const resolvedText = CobaltTemplateCore.evaluate(text, env);
        return resolvedText;
    } catch (error) {
        console.error(`\n[COBALT SYNTAX ENGINE: ФАТАЛЬНЫЙ СБОЙ КОМПИЛЯЦИИ]`, error);
        return text;
    }
};

module.exports = { resolveTemplateVariables, initAegisSyntaxEngine };