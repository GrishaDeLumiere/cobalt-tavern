// ФАЙЛ: server/api/syntax.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');
const { resolveTemplateVariables } = require('../system/syntaxEngine');

module.exports = async function (fastify, opts) {
    fastify.post('/syntax/simulate', async (request, reply) => {
        const { textNodes, charId, personaId } = request.body;

        const charsDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.json');
        const personasDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.json');

        let character = {};
        let persona = {};

        try {
            if (charId) {
                const charsDb = JSON.parse(await fs.readFile(charsDbPath, 'utf-8'));
                character = charsDb.characters.find(c => c.id === charId) || {};
            }
            if (personaId) {
                const personasDb = JSON.parse(await fs.readFile(personasDbPath, 'utf-8'));
                persona = personasDb.personas.find(p => p.id === personaId) || {};
            }
        } catch (e) {
            console.error('[SYNTAX SIMULATOR] Ошибка чтения БД:', e.message);
        }

        const charName = character.name || 'System';
        const userName = persona.name || 'User';

        const sharedVariables = { local: new Map(), global: new Map() };
        const resolvedMap = {};

        for (const [nodeId, nodeData] of Object.entries(textNodes || {})) {
            if (!nodeData || !nodeData.text) {
                resolvedMap[nodeId] = '';
                continue;
            }

            const localUser = nodeData.localUserName || userName;
            resolvedMap[nodeId] = resolveTemplateVariables(nodeData.text, {
                charName,
                userName: localUser,
                character,
                persona,
                variables: sharedVariables,
                chat: { messages: [] },
                sysConfig: {}
            });
        }

        return { success: true, resolvedMap };
    });
};