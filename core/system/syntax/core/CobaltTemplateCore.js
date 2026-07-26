// ФАЙЛ: server/syntax/core/CobaltTemplateCore.js
const { CobaltParser } = require('./CobaltParser.js');
const { CobaltNodeResolver } = require('./CobaltNodeResolver.js');
const { CobaltRegistry, CobaltValueType } = require('./CobaltRegistry.js');

const ELSE_MARKER = '\u0000\u001FELSE\u001F\u0000';

class CobaltEngine {
    constructor() {
        this.preProcessors = [];
        this.postProcessors = [];
        this.#registerCorePreProcessors();
        this.#registerCorePostProcessors();
    }

    addPreProcessor(handler, { priority = 100 } = {}) {
        this.preProcessors.push({ handler, priority });
        this.preProcessors.sort((a, b) => a.priority - b.priority);
    }

    addPostProcessor(handler, { priority = 100 } = {}) {
        this.postProcessors.push({ handler, priority });
        this.postProcessors.sort((a, b) => a.priority - b.priority);
    }

    evaluate(input, env, { contextOffset = 0 } = {}) {
        if (!input) return '';
        const safeEnv = Object.freeze({ ...env });

        let preProcessed = input;
        for (const { handler } of this.preProcessors) preProcessed = handler(preProcessed, safeEnv);

        const parseResult = CobaltParser.parseDocument(preProcessed);

        if (parseResult.lexingErrors && parseResult.lexingErrors.length > 0) {
            console.error('\n[COBALT ЛЕКСЕР ОШИБКИ]:', JSON.stringify(parseResult.lexingErrors, null, 2));
        }
        if (parseResult.parserErrors && parseResult.parserErrors.length > 0) {
            console.error('\n[COBALT ПАРСЕР ОШИБКИ]:', parseResult.parserErrors.map(e => e.message).join('\n'));
        }

        const { ast } = parseResult;

        if (!ast || typeof ast !== 'object' || !ast.children) {
            return input;
        }

        let evaluated;
        try {
            evaluated = CobaltNodeResolver.evaluateDocument({
                text: preProcessed,
                contextOffset,
                ast,
                env: safeEnv,
                resolveNode: this.#resolveNode.bind(this),
                trimContent: this.trimScopedContent.bind(this),
            });
        } catch (error) {
            console.error('[COBALT SYNTAX ENGINE] КРАШ ВНУТРИ RESOLVER:', error);
            return input;
        }

        let result = evaluated;
        for (const { handler } of this.postProcessors) result = handler(result, safeEnv);
        return result;
    }

    #resolveNode(call) {
        const { name, env } = call;
        const raw = `{{${call.rawInner}}}`;
        if (!name) return raw;

        let defOverride = null;
        const nameLower = name.toLowerCase();

        if (Object.hasOwn(env.dynamicNodes, nameLower)) {
            const impl = env.dynamicNodes[nameLower];
            defOverride = CobaltRegistry.buildNodeDefFromOptions(name, {
                handler: typeof impl === 'function' ? impl : () => String(impl ?? ''),
                returnType: CobaltValueType.STRING,
            });
        }

        if (!defOverride && !CobaltRegistry.hasNode(name)) {
            return raw;
        }

        try {
            const result = CobaltRegistry.executeNode(call, { defOverride });
            return call.env.functions.postProcess(result);
        } catch (error) {
            return raw;
        }
    }

    #registerCorePreProcessors() {
        this.addPreProcessor(text => text.replace(/{{time_(UTC[+-]\d+)}}/gi, (_match, utcOffset) => `{{time::${utcOffset}}}`), { priority: 10 });
        this.addPreProcessor(text => text.replace(/<user>/gi, '{{user}}'), { priority: 15 });
        this.addPreProcessor(text => text.replace(/<char>/gi, '{{char}}'), { priority: 15 });
    }

    #registerCorePostProcessors() {
        this.addPostProcessor(text => text.replace(/\\([{}])/g, '$1'), { priority: 10 });
        this.addPostProcessor(text => text.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, ''), { priority: 20 });
        this.addPostProcessor(text => text.replaceAll(ELSE_MARKER, ''), { priority: 30 });
    }

    normalizeResult(value) {
        if (value === null || value === undefined) return '';
        if (value instanceof Date) return value.toISOString();
        if (typeof value === 'object' || Array.isArray(value)) {
            try { return JSON.stringify(value); } catch (_) { return String(value); }
        }
        return String(value);
    }

    trimScopedContent(content, { trimIndent = true } = {}) {
        if (!content) return '';
        if (!trimIndent) return content.trim();

        const lines = content.split('\n');
        let baseIndent = 0;
        for (const line of lines) {
            if (line.trim() !== '') {
                const match = line.match(/^[ \t]*/);
                baseIndent = match ? match[0].length : 0;
                break;
            }
        }
        if (baseIndent === 0) return content.trim();

        const dedentedLines = lines.map(line => {
            const match = line.match(/^[ \t]*/);
            const lineIndent = match ? match[0].length : 0;
            return lineIndent >= baseIndent ? line.slice(baseIndent) : line.trimStart();
        });
        return dedentedLines.join('\n').trim();
    }
}

const CobaltTemplateCore = new CobaltEngine();
module.exports = { CobaltTemplateCore };