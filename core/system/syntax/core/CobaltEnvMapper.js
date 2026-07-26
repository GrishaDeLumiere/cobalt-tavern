// ФАЙЛ: server/syntax/core/CobaltEnvMapper.js
const crypto = require('crypto');

function getStringHash(str) {
    if (!str) return 0;
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 8);
}

class CobaltMapper {
    buildFromRawEnv(ctx) {
        const env = {
            content: ctx.content || '',
            contentHash: getStringHash(ctx.content || ''),
            names: { user: '', char: '', group: '', groupNotMuted: '', notChar: '' },
            character: {}, system: { model: '' }, functions: { postProcess: (x) => x },
            dynamicNodes: {}, extra: {}, serverLayer: ctx.serverLayer || {}
        };

        const serverLayer = env.serverLayer;
        env.names.user = ctx.name1Override || serverLayer.userName || 'User';
        env.names.char = ctx.name2Override || serverLayer.charName || 'System';

        if (ctx.replaceCharacterCard && serverLayer.character) {
            const char = serverLayer.character;
            const personaText = serverLayer.persona?.text || serverLayer.persona?.description || '';
            env.character = {
                charPrompt: char.system || '',
                charInstruction: char.jailbreak || '',
                description: char.description || '',
                personality: char.personality || '',
                scenario: char.scenario || '',
                persona: personaText,
                mesExamplesRaw: char.mes_example || '',
                firstMessage: char.first_mes || '',
                alternateGreetings: char.alternate_greetings || []
            };
        }

        if (ctx.dynamicNodes) {
            for (const [key, value] of Object.entries(ctx.dynamicNodes)) {
                env.dynamicNodes[key.toLowerCase()] = value;
            }
        }
        return env;
    }
}

const CobaltEnvMapper = new CobaltMapper();
module.exports = { CobaltEnvMapper };