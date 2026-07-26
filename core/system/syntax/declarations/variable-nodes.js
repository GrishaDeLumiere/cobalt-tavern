// ФАЙЛ: server/syntax/declarations/variable-nodes.js
const { CobaltRegistry, CobaltCategory, CobaltValueType } = require('../core/CobaltRegistry.js');

class VariableStore {
    constructor(map) { this.map = map; }
    set(name, value, opts) {
        if (opts?.index !== undefined) {
            let current = this.map.get(name);
            let obj = (!current) ? (!isNaN(Number(opts.index)) ? [] : {}) : (typeof current === 'string' ? JSON.parse(current) : current);
            obj[opts.index] = value;
            this.map.set(name, JSON.stringify(obj));
        } else {
            this.map.set(name, value);
        }
    }

    add(name, value) {
        let cur = this.map.get(name) ?? '';
        if (!isNaN(cur) && !isNaN(value) && cur !== '') this.map.set(name, Number(cur) + Number(value));
        else this.map.set(name, String(cur) + String(value));
    }

    inc(name) { let v = Number(this.map.get(name)) || 0; this.map.set(name, v + 1); return v + 1; }
    dec(name) { let v = Number(this.map.get(name)) || 0; this.map.set(name, v - 1); return v - 1; }

    get(name, opts) {
        let val = this.map.get(name);
        if (opts?.index !== undefined) {
            try { let obj = JSON.parse(val); return obj ? obj[opts.index] : undefined; } catch (e) { return undefined; }
        }
        return val;
    }

    has(name) { return this.map.has(name); }
    del(name) { this.map.delete(name); }
}

function registerVariableNodes() {
    const getVars = (env, scope) => {
        let vars = env.serverLayer?.variables?.[scope];
        if (!(vars instanceof Map)) {
            vars = new Map();
            if (env.serverLayer?.variables) env.serverLayer.variables[scope] = vars;
        }
        return new VariableStore(vars);
    };

    // LOCAL VARIABLES
    CobaltRegistry.registerNode('setvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'value', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, value] }) => { getVars(env, 'local').set(name, value); return ''; },
    });

    CobaltRegistry.registerNode('addvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'value', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, value] }) => { getVars(env, 'local').add(name, value); return ''; },
    });

    CobaltRegistry.registerNode('incvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name], normalize }) => normalize(getVars(env, 'local').inc(name)),
    });

    CobaltRegistry.registerNode('decvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name], normalize }) => normalize(getVars(env, 'local').dec(name)),
    });

    CobaltRegistry.registerNode('getvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name], normalize }) => normalize(getVars(env, 'local').get(name)),
    });

    CobaltRegistry.registerNode('hasvar', {
        aliases: [{ alias: 'varexists' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name] }) => getVars(env, 'local').has(name) ? 'true' : 'false',
    });

    CobaltRegistry.registerNode('deletevar', {
        aliases: [{ alias: 'flushvar' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name] }) => { getVars(env, 'local').del(name); return ''; },
    });

    CobaltRegistry.registerNode('setvarkey', {
        aliases: [{ alias: 'setvarindex' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'key', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }, { name: 'value', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, key, value] }) => { getVars(env, 'local').set(name, value, { index: key }); return ''; },
    });

    CobaltRegistry.registerNode('getvarkey', {
        aliases: [{ alias: 'getvarindex' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'key', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, key], normalize }) => normalize(getVars(env, 'local').get(name, { index: key })),
    });

    // GLOBAL VARIABLES
    CobaltRegistry.registerNode('setglobalvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'value', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, value] }) => { getVars(env, 'global').set(name, value); return ''; },
    });

    CobaltRegistry.registerNode('addglobalvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'value', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, value] }) => { getVars(env, 'global').add(name, value); return ''; },
    });

    CobaltRegistry.registerNode('incglobalvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name], normalize }) => normalize(getVars(env, 'global').inc(name)),
    });

    CobaltRegistry.registerNode('decglobalvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name], normalize }) => normalize(getVars(env, 'global').dec(name)),
    });

    CobaltRegistry.registerNode('getglobalvar', {
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name], normalize }) => normalize(getVars(env, 'global').get(name)),
    });

    CobaltRegistry.registerNode('hasglobalvar', {
        aliases: [{ alias: 'globalvarexists' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name] }) => getVars(env, 'global').has(name) ? 'true' : 'false',
    });

    CobaltRegistry.registerNode('deleteglobalvar', {
        aliases: [{ alias: 'flushglobalvar' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }],
        handler: ({ env, unnamedArgs: [name] }) => { getVars(env, 'global').del(name); return ''; },
    });

    CobaltRegistry.registerNode('setglobalvarkey', {
        aliases: [{ alias: 'setglobalvarindex' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'key', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }, { name: 'value', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, key, value] }) => { getVars(env, 'global').set(name, value, { index: key }); return ''; },
    });

    CobaltRegistry.registerNode('getglobalvarkey', {
        aliases: [{ alias: 'getglobalvarindex' }],
        category: CobaltCategory.VARIABLE,
        unnamedArgs: [{ name: 'name', type: CobaltValueType.STRING }, { name: 'key', type: [CobaltValueType.STRING, CobaltValueType.NUMBER] }],
        handler: ({ env, unnamedArgs: [name, key], normalize }) => normalize(getVars(env, 'global').get(name, { index: key })),
    });
}

module.exports = { registerVariableNodes };