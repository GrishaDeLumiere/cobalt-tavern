// ФАЙЛ: server/api/syntax.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');
const { resolveTemplateVariables } = require('../system/syntaxEngine');

module.exports = async function (fastify, opts) {
    fastify.post('/syntax/simulate', async (request, reply) => {
        const { textNodes, charId, personaId } = request.body;

        const charsDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.json');
        const personasDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas');
        const personasDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.json');

        let character = {};
        let persona = {};

        if (charId) {
            try {
                const charsDb = JSON.parse(await fs.readFile(charsDbPath, 'utf-8'));
                character = (charsDb.characters || []).find(c => c.id === charId) || {};
            } catch (e) {
                console.error('[SYNTAX SIMULATOR] Ошибка чтения персонажей:', e.message);
            }
        }

        if (personaId) {
            try {
                const personaFilePath = path.join(personasDir, `${personaId}.json`);
                persona = JSON.parse(await fs.readFile(personaFilePath, 'utf-8'));
            } catch (e) {
                try {
                    const personasDb = JSON.parse(await fs.readFile(personasDbPath, 'utf-8'));
                    persona = (personasDb.personas || []).find(p => p.id === personaId) || {};
                } catch (err) { }
            }

            if (persona && Array.isArray(persona.modules)) {
                const activeMods = persona.modules.filter(m =>
                    m.type !== 'category' &&
                    m.isEnabled !== false &&
                    m.content &&
                    m.content.trim() !== ''
                );

                if (activeMods.length > 0) {
                    const modsText = activeMods.map(m => m.content.trim()).join('\n\n');
                    persona.text = persona.text ? `${persona.text}\n\n${modsText}` : modsText;
                    persona.description = persona.text;
                }
            }
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