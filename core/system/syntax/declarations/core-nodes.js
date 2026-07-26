// ФАЙЛ: core/system/syntax/declarations/core-nodes.js
const { CobaltRegistry, CobaltCategory, CobaltValueType } = require('../core/CobaltRegistry.js');
const { CobaltParser } = require('../core/CobaltParser.js'); // <--- ИСПРАВИЛ ТУТ
const { CobaltNodeResolver } = require('../core/CobaltNodeResolver.js');
const { NODE_VARIABLE_SHORTHAND_PATTERN } = require('../core/CobaltTokenizer.js');
const droll = require('droll');
const seedrandom = require('seedrandom');
const crypto = require('crypto');

const ELSE_MARKER = '\u0000\u001FELSE\u001F\u0000';

function getStringHash(str) {
    if (!str) return 0;
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 8);
}

const isFalseBoolean = (val) => ['false', '0', 'no', 'off', '', 'null', 'undefined'].includes(String(val).toLowerCase().trim());

function splitOnTopLevelElse(content) {
    const { ast } = CobaltParser.parseDocument(content);
    const triggerNodes = ast?.children?.trigger || [];
    let depth = 0;
    for (const astNode of triggerNodes) {
        const info = CobaltNodeResolver.extractNodeInfo(astNode);
        if (!info) continue;
        if (info.name === 'if' && !info.isClosing && info.argCount === 1) {
            depth++;
        } else if (info.name === 'if' && info.isClosing) {
            depth--;
        } else if (info.name === 'else' && depth === 0) {
            return {
                thenBranch: content.slice(0, info.startOffset),
                elseBranch: content.slice(info.endOffset + 1),
            };
        }
    }
    return { thenBranch: content, elseBranch: undefined };
}

function registerCoreNodes() {
    CobaltRegistry.registerNode('space', {
        category: CobaltCategory.UTILITY,
        unnamedArgs: [{ name: 'count', optional: true, defaultValue: '1', type: CobaltValueType.INTEGER }],
        handler: ({ unnamedArgs: [count] }) => ' '.repeat(Number(count ?? 1)),
    });

    CobaltRegistry.registerNode('newline', {
        category: CobaltCategory.UTILITY,
        unnamedArgs: [{ name: 'count', optional: true, defaultValue: '1', type: CobaltValueType.INTEGER }],
        handler: ({ unnamedArgs: [count] }) => '\n'.repeat(Number(count ?? 1)),
    });

    CobaltRegistry.registerNode('noop', { category: CobaltCategory.UTILITY, handler: () => '' });

    CobaltRegistry.registerNode('trim', {
        category: CobaltCategory.UTILITY,
        unnamedArgs: [{ name: 'content', optional: true }],
        handler: ({ unnamedArgs: [content], isScoped }) => {
            if (isScoped) return content ?? '';
            return '{{trim}}';
        },
    });

    CobaltRegistry.registerNode('if', {
        category: CobaltCategory.UTILITY,
        unnamedArgs: [{ name: 'condition' }, { name: 'content', optional: true }],
        delayArgResolution: true,
        handler: ({ unnamedArgs: [rawCondition, rawContent], flags, resolve, trimContent }) => {
            let inverted = false;
            let condition = rawCondition || '';
            if (/^\s*!/.test(rawCondition)) {
                inverted = true;
                condition = rawCondition.replace(/^\s*!\s*/, '');
            }

            condition = resolve(condition);

            const varShorthandRegex = new RegExp(`^([.$])(${NODE_VARIABLE_SHORTHAND_PATTERN.source})$`);
            const varShorthandMatch = condition.match(varShorthandRegex);

            if (varShorthandMatch) {
                const [, prefix, varName] = varShorthandMatch;
                const nodeName = prefix === '.' ? 'getvar' : 'getglobalvar';
                condition = resolve(`{{${nodeName}::${varName}}}`);
            } else {
                const nodeDef = CobaltRegistry.getPrimaryNode(condition);
                if (nodeDef && nodeDef.minArgs === 0) {
                    condition = resolve(`{{${condition}}}`);
                }
            }

            let isFalsy = condition === '' || isFalseBoolean(condition);
            if (inverted) isFalsy = !isFalsy;

            const { thenBranch, elseBranch } = splitOnTopLevelElse(rawContent || '');
            const chosenBranch = !isFalsy ? thenBranch : elseBranch;

            if (chosenBranch === undefined) return '';

            let result = resolve(chosenBranch);
            if (!flags.preserveWhitespace) result = trimContent(result);
            return result;
        },
    });

    CobaltRegistry.registerNode('else', { category: CobaltCategory.UTILITY, handler: () => ELSE_MARKER });

    CobaltRegistry.registerNode('reverse', {
        category: CobaltCategory.UTILITY,
        unnamedArgs: [{ name: 'value', type: CobaltValueType.STRING }],
        handler: ({ unnamedArgs: [value] }) => Array.from(value).reverse().join(''),
    });

    CobaltRegistry.registerNode('//', { category: CobaltCategory.UTILITY, handler: () => '' });

    CobaltRegistry.registerNode('roll', {
        category: CobaltCategory.RANDOM,
        unnamedArgs: [{ name: 'formula', type: CobaltValueType.STRING }],
        handler: ({ unnamedArgs: [formula], warn }) => {
            if (/^\d+$/.test(formula)) formula = `1d${formula}`;
            if (!droll.validate(formula)) { warn(`Invalid roll: ${formula}`); return ''; }
            const result = droll.roll(formula);
            return result === false ? '' : String(result.total);
        },
    });

    function readSingleArgsRandomList(listString) {
        if (listString.includes('::')) return listString.split('::').map(item => item.trim());
        return listString.replace(/\\,/g, '##COMMA##').split(',').map(item => item.trim().replace(/##COMMA##/g, ','));
    }

    CobaltRegistry.registerNode('random', {
        category: CobaltCategory.RANDOM,
        list: true,
        handler: ({ list }) => {
            if (list.length === 1) list = readSingleArgsRandomList(list[0]);
            if (list.length === 0) return '';
            return list[Math.floor(seedrandom('added entropy.', { entropy: true })() * list.length)];
        },
    });

    CobaltRegistry.registerNode('pick', {
        category: CobaltCategory.RANDOM,
        list: true,
        handler: ({ list, globalOffset, env }) => {
            if (list.length === 1) list = readSingleArgsRandomList(list[0]);
            if (!list.length) return '';
            const combinedSeedString = [env.contentHash, globalOffset].join('-');
            const finalSeed = getStringHash(combinedSeedString);
            return list[Math.floor(seedrandom(String(finalSeed))() * list.length)];
        },
    });
}

module.exports = { registerCoreNodes };