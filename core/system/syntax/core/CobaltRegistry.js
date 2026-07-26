// ФАЙЛ: server/syntax/core/CobaltRegistry.js
const CobaltCategory = Object.freeze({
    UTILITY: 'utility', RANDOM: 'random', NAMES: 'names', CHARACTER: 'character',
    CHAT: 'chat', TIME: 'time', VARIABLE: 'variable', PROMPTS: 'prompts',
    STATE: 'state', MISC: 'misc', UNCATEGORIZED: 'uncategorized',
});

const CobaltValueType = Object.freeze({ STRING: 'string', INTEGER: 'integer', NUMBER: 'number', BOOLEAN: 'boolean' });

const normalizeNodeResult = (value) => {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object' || Array.isArray(value)) {
        try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
};

const trimScopedContent = (content, { trimIndent = true } = {}) => {
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
    return lines.map(line => {
        const match = line.match(/^[ \t]*/);
        const lineIndent = match ? match[0].length : 0;
        return lineIndent >= baseIndent ? line.slice(baseIndent) : line.trimStart();
    }).join('\n').trim();
};

class Registry {
    constructor() { this.nodes = new Map(); }

    registerNode(name, options) {
        name = typeof name === 'string' ? name.trim() : String(name);
        try {
            const definition = this.buildNodeDefFromOptions(name, options);
            this.#registerNodeEntry(name, definition);
            if (definition.aliases) {
                for (const { alias, visible } of definition.aliases) {
                    this.#registerNodeEntry(alias, definition, { primaryNodeName: name, aliasVisible: visible });
                }
            }
            return definition;
        } catch (error) { return null; }
    }

    #registerNodeEntry(name, definition, { primaryNodeName = null, aliasVisible = null } = {}) {
        const nameKey = name.toLowerCase();
        const entry = primaryNodeName ? { ...definition, name, aliasOf: primaryNodeName, aliasVisible } : definition;
        this.nodes.set(nameKey, entry);
    }

    getNode(name) {
        if (!name || typeof name !== 'string') return undefined;
        return this.nodes.get(name.trim().toLowerCase());
    }

    getPrimaryNode(name) {
        const def = this.getNode(name);
        if (!def) return undefined;
        return def.aliasOf ? this.getNode(def.aliasOf) : def;
    }

    hasNode(name) { return !!this.getNode(name); }

    executeNode(call, { defOverride } = {}) {
        const name = call.name;
        const def = defOverride || this.getNode(name);
        if (!def) throw new Error(`Trigger node "${name}" is not registered`);

        const args = Array.isArray(call.args) ? call.args : [];
        const unnamedArgsValues = args.slice(0, Math.min(args.length, def.maxArgs));
        const listValues = !def.list ? null : args.length > def.maxArgs ? args.slice(def.maxArgs) : [];

        const executionContext = {
            name: def.name, args, unnamedArgs: unnamedArgsValues, list: listValues,
            flags: call.flags, isScoped: call.isScoped, raw: call.rawInner, rawArgs: call.rawArgs,
            env: call.env, globalOffset: call.globalOffset, contentHash: call.env.contentHash,
            normalize: normalizeNodeResult,
            trimContent: trimScopedContent,
            resolve: (text, { offsetDelta = 0 } = {}) => {
                const { CobaltTemplateCore } = require('./CobaltTemplateCore.js');
                return CobaltTemplateCore.evaluate(text, call.env, { contextOffset: call.globalOffset + offsetDelta });
            },
            warn: (msg) => console.warn(`[COBALT WARNING] ${msg}`)
        };

        return normalizeNodeResult(def.handler(executionContext));
    }

    buildNodeDefFromOptions(name, options) {
        return {
            name, aliases: options.aliases || [], category: options.category || CobaltCategory.UNCATEGORIZED,
            minArgs: options.minArgs || 0, maxArgs: options.maxArgs || (options.unnamedArgs?.length || 0),
            unnamedArgDefs: options.unnamedArgs || [], list: options.list || null,
            strictArgs: options.strictArgs !== false, returnType: options.returnType || CobaltValueType.STRING,
            delayArgResolution: options.delayArgResolution || false, handler: options.handler,
        };
    }
}

const CobaltRegistry = new Registry();
module.exports = { CobaltRegistry, CobaltCategory, CobaltValueType };