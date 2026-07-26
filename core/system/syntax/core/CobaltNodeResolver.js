// ФАЙЛ: server/syntax/core/CobaltNodeResolver.js
const { CobaltParser } = require('./CobaltParser.js');
const { CobaltRegistry } = require('./CobaltRegistry.js');
const { CobaltFlagType, parseFlags, createEmptyFlags } = require('./CobaltFlags.js');

const isFalseBoolean = (val) => ['false', '0', 'no', 'off', '', 'null', 'undefined'].includes(String(val).toLowerCase().trim());

class Resolver {
    evaluateDocument(options) {
        const { text, ast, contextOffset, env, resolveNode, trimContent } = options;
        if (typeof text !== 'string' || !ast || !ast.children) return text;

        const context = { text, contextOffset, env, resolveNode, trimContent };
        let items = this.#collectDocumentItems(ast);
        items = this.#processScopedNodes(items, text);

        if (items.length === 0) return text;

        let result = '';
        let cursor = 0;

        for (const item of items) {
            if (item.startOffset > cursor) {
                result += text.slice(cursor, item.startOffset);
            }

            if (item.type === 'plaintext' || item.keepRaw) {
                result += text.slice(item.startOffset, item.endOffset + 1);
                cursor = item.endOffset + 1;
            } else {
                result += this.#evaluateTriggerNode(item.node, context, item.scopedContent);
                if (item.scopedContent && item.scopedContent.closingEndOffset !== undefined) {
                    cursor = item.scopedContent.closingEndOffset + 1;
                } else {
                    cursor = item.endOffset + 1;
                }
            }
        }

        if (cursor < text.length) result += text.slice(cursor);
        return result;
    }

    extractNodeInfo(astNode) {
        const children = astNode?.children || {};
        if ((children.variableExpr || [])[0]) return null;

        const startToken = (children['Node.Start'] || [])[0];
        const endToken = (children['Node.End'] || [])[0];
        if (!startToken || !endToken) return null;

        const nodeBodyNode = (children.nodeBody || [])[0];
        const bodyChildren = nodeBodyNode?.children || {};
        const name = (bodyChildren['Node.identifier'] || [])[0]?.image || '';
        if (!name) return null;

        const argumentsNode = (bodyChildren.arguments || [])[0];
        const argCount = (argumentsNode?.children?.argument || []).length;
        const flagTokens = (children.flags || []);
        let isClosing = flagTokens.some(token => token.image === CobaltFlagType.CLOSING_BLOCK);

        if (!isClosing && name === '//') {
            const firstArgNode = (argumentsNode?.children?.argument || [])[0];
            if (firstArgNode) {
                const firstToken = this.#getFirstTokenInNode(firstArgNode);
                if (firstToken?.image?.startsWith('/')) isClosing = true;
            }
        }

        return { name, isClosing, startOffset: startToken.startOffset, endOffset: endToken.endOffset, argCount };
    }

    #collectDocumentItems(ast) {
        const plaintextTokens = (ast.children.plaintext || []);
        const triggerNodes = (ast.children.trigger || []);
        const items = [];

        for (const token of plaintextTokens) {
            if (typeof token.startOffset !== 'number') continue;
            items.push({ type: 'plaintext', startOffset: token.startOffset, endOffset: token.endOffset, token });
        }

        for (const astNode of triggerNodes) {
            const endToken = ((astNode.children || {})['Node.End'] || [])[0];
            if (this.#isRecoveryToken(endToken)) {
                this.#flattenIncompleteNode(astNode, endToken, items);
                continue;
            }
            const range = this.#getNodeRange(astNode);
            items.push({ type: 'trigger', startOffset: range.startOffset, endOffset: range.endOffset, node: astNode });
        }

        items.sort((a, b) => a.startOffset === b.startOffset ? a.endOffset - b.endOffset : a.startOffset - b.startOffset);
        return items;
    }

    #evaluateTriggerNode(astNode, context, scopedContent) {
        const { text, contextOffset, env, resolveNode, trimContent } = context;
        const children = astNode.children || {};

        const variableExprNode = (children.variableExpr || [])[0];
        if (variableExprNode) return this.#evaluateVariableExpr(astNode, variableExprNode, context);

        const nodeBodyNode = (children.nodeBody || [])[0];
        const bodyChildren = nodeBodyNode?.children || {};
        const name = (bodyChildren['Node.identifier'] || [])[0]?.image || '';

        const flagTokens = (children.flags || []);
        const flags = flagTokens.length > 0 ? parseFlags(flagTokens.map(t => t.image)) : createEmptyFlags();

        const range = this.#getNodeRange(astNode);
        const startToken = (children['Node.Start'] || [])[0];
        const endToken = (children['Node.End'] || [])[0];
        const innerStart = startToken ? startToken.endOffset + 1 : range.startOffset;
        const innerEnd = endToken ? endToken.startOffset - 1 : range.endOffset;

        const argumentNodes = ((bodyChildren.arguments || [])[0]?.children?.argument || []);
        const def = CobaltRegistry.getNode(name);
        const delayArgResolution = def?.delayArgResolution === true;

        const args = [], evaluatedArguments = [], rawArgs = [];

        for (const argNode of argumentNodes) {
            const location = this.#getArgumentLocation(argNode);
            const rawArgText = location ? text.slice(location.startOffset, location.endOffset + 1) : '';
            rawArgs.push(rawArgText);
            const argValue = delayArgResolution ? rawArgText : this.#evaluateArgumentNode(argNode, context);
            args.push(argValue);
            if (location) evaluatedArguments.push({ value: argValue, ...location });
        }

        if (scopedContent) {
            if (scopedContent.startOffset > scopedContent.endOffset) {
                args.push(''); rawArgs.push('');
            } else {
                const rawScopedText = text.slice(scopedContent.startOffset, scopedContent.endOffset + 1);
                rawArgs.push(rawScopedText);
                let scopedValue = delayArgResolution ? rawScopedText : this.#evaluateRawContent(rawScopedText, contextOffset + scopedContent.startOffset, context);
                if (!delayArgResolution && !flags.preserveWhitespace) scopedValue = trimContent(scopedValue);
                args.push(scopedValue);
                evaluatedArguments.push({ value: scopedValue, startOffset: scopedContent.startOffset, endOffset: scopedContent.endOffset });
            }
        }

        evaluatedArguments.sort((a, b) => a.startOffset - b.startOffset);
        let rawInner = '';
        if (innerStart <= innerEnd) {
            let cursor = innerStart;
            for (const entry of evaluatedArguments) {
                if (entry.startOffset > cursor) rawInner += text.slice(cursor, entry.startOffset);
                rawInner += entry.value;
                cursor = entry.endOffset + 1;
            }
            if (cursor <= innerEnd) rawInner += text.slice(cursor, innerEnd + 1);
        }

        const call = { name, args, flags, isScoped: scopedContent != null, rawInner, rawWithBraces: text.slice(range.startOffset, range.endOffset + 1), rawArgs, range, globalOffset: contextOffset + range.startOffset, astNode, env };
        const value = resolveNode(call);
        return typeof value === 'string' ? value : String(value ?? '');
    }

    #evaluateVariableExpr(astNode, variableExprNode, context) {
        const varChildren = variableExprNode.children || {};
        const isGlobal = !(varChildren['Var.scope'] || []).find(t => t.tokenType?.name === 'Var.LocalPrefix');
        const varName = (varChildren['Var.identifier'] || [])[0]?.image || '';

        const operatorNode = (varChildren.variableOperator || [])[0];
        let operation = 'get', hasValueExpr = false;

        if (operatorNode) {
            const operatorImage = (operatorNode.children['Var.operator'] || [])[0]?.image;
            const opMap = { '++': 'inc', '--': 'dec', '=': 'set', '+=': 'add', '-=': 'sub', '||': 'logicalOr', '??': 'nullishCoalescing', '||=': 'logicalOrAssign', '??=': 'nullishCoalescingAssign', '==': 'equals', '!=': 'notEquals', '>': 'greaterThan', '>=': 'greaterThanOrEqual', '<': 'lessThan', '<=': 'lessThanOrEqual' };
            if (opMap[operatorImage]) { operation = opMap[operatorImage]; hasValueExpr = !['inc', 'dec'].includes(operation); }
        }

        let cached = null;
        let resolved = false;
        const lazyValue = hasValueExpr ? () => {
            if (!resolved) {
                cached = this.#evaluateVariableValue(operatorNode.children, context);
                resolved = true;
            }
            return cached;
        } : () => '';

        return this.#executeVariableOperation(varName, isGlobal, operation, lazyValue, context.env);
    }

    #executeVariableOperation(varName, isGlobal, operation, lazyValue, env) {
        const normalize = (val) => val === null || val === undefined ? '' : String(val);
        const isFalsy = (val) => !val || isFalseBoolean(normalize(val));
        const varsGroup = isGlobal ? env.serverLayer?.variables?.global : env.serverLayer?.variables?.local;
        const vars = varsGroup instanceof Map ? varsGroup : new Map();

        const getVar = () => normalize(vars.get(varName));
        const setVar = (v) => vars.set(varName, v);
        const hasVar = () => vars.has(varName);

        switch (operation) {
            case 'get': return getVar();
            case 'set': setVar(lazyValue()); return '';
            case 'inc': { let v = Number(getVar()) || 0; setVar(v + 1); return normalize(v + 1); }
            case 'dec': { let v = Number(getVar()) || 0; setVar(v - 1); return normalize(v - 1); }
            case 'add': { let cur = vars.get(varName); if (cur === undefined) cur = ''; let addVal = lazyValue(); if (!isNaN(cur) && !isNaN(addVal) && cur !== '') setVar(Number(cur) + Number(addVal)); else setVar(String(cur) + String(addVal)); return ''; }
            case 'sub': { let num = Number(lazyValue()); if (!isNaN(num)) { let cur = Number(getVar()) || 0; setVar(cur - num); } return ''; }
            case 'logicalOr': return isFalsy(getVar()) ? normalize(lazyValue()) : getVar();
            case 'nullishCoalescing': return hasVar() ? getVar() : normalize(lazyValue());
            case 'logicalOrAssign': if (isFalsy(getVar())) { setVar(lazyValue()); return normalize(lazyValue()); } return getVar();
            case 'nullishCoalescingAssign': if (!hasVar()) { setVar(lazyValue()); return normalize(lazyValue()); } return getVar();
            case 'equals': return getVar() === normalize(lazyValue()) ? 'true' : 'false';
            case 'notEquals': return getVar() !== normalize(lazyValue()) ? 'true' : 'false';
            case 'greaterThan': return Number(getVar()) > Number(lazyValue()) ? 'true' : 'false';
            case 'greaterThanOrEqual': return Number(getVar()) >= Number(lazyValue()) ? 'true' : 'false';
            case 'lessThan': return Number(getVar()) < Number(lazyValue()) ? 'true' : 'false';
            case 'lessThanOrEqual': return Number(getVar()) <= Number(lazyValue()) ? 'true' : 'false';
            default: return '';
        }
    }

    #evaluateVariableValue(operatorChildren, context) {
        const { text } = context;
        const valueNode = (operatorChildren['Var.value'] || [])[0];
        if (!valueNode) return '';

        const valueChildren = valueNode.children || {};
        const allTokens = [...(valueChildren.Identifier || []), ...(valueChildren.Unknown || [])];
        const nestedNodes = valueChildren.trigger || [];
        const allRanges = [...allTokens.map(t => ({ startOffset: t.startOffset, endOffset: t.endOffset })), ...nestedNodes.map(m => this.#getNodeRange(m))];

        if (allRanges.length === 0) return '';

        const startOffset = Math.min(...allRanges.map(r => r.startOffset));
        const endOffset = Math.max(...allRanges.map(r => r.endOffset));

        if (nestedNodes.length === 0) return text.slice(startOffset, endOffset + 1).trim();

        const nestedWithRange = nestedNodes.map(node => ({ node, range: this.#getNodeRange(node) })).sort((a, b) => a.range.startOffset - b.range.startOffset);
        let result = '';
        let cursor = startOffset;

        for (const entry of nestedWithRange) {
            if (entry.range.startOffset > cursor) result += text.slice(cursor, entry.range.startOffset);
            result += this.#evaluateTriggerNode(entry.node, context);
            cursor = entry.range.endOffset + 1;
        }

        if (cursor <= endOffset) result += text.slice(cursor, endOffset + 1);
        return result.trim();
    }

    #evaluateArgumentNode(argNode, context) {
        const location = this.#getArgumentLocation(argNode);
        if (!location) return '';
        const rawContent = context.text.slice(location.startOffset, location.endOffset + 1);
        return this.#evaluateRawContent(rawContent, context.contextOffset + location.startOffset, context);
    }

    #evaluateRawContent(rawContent, newContextOffset, context) {
        if (!rawContent) return '';
        const { ast } = CobaltParser.parseDocument(rawContent);
        if (!ast || typeof ast !== 'object' || !ast.children) return rawContent;

        const contentContext = { ...context, text: rawContent, contextOffset: newContextOffset };
        let items = this.#collectDocumentItems(ast);
        items = this.#processScopedNodes(items, rawContent);

        if (items.length === 0) return rawContent;

        let result = '';
        let cursor = 0;

        for (const item of items) {
            if (item.startOffset > cursor) result += rawContent.slice(cursor, item.startOffset);
            if (item.type === 'plaintext' || item.keepRaw) {
                result += rawContent.slice(item.startOffset, item.endOffset + 1);
                cursor = item.endOffset + 1;
            } else {
                result += this.#evaluateTriggerNode(item.node, contentContext, item.scopedContent);
                if (item.scopedContent && item.scopedContent.closingEndOffset !== undefined) {
                    cursor = item.scopedContent.closingEndOffset + 1;
                } else {
                    cursor = item.endOffset + 1;
                }
            }
        }
        if (cursor < rawContent.length) result += rawContent.slice(cursor);
        return result;
    }

    #getNodeRange(astNode) {
        const startToken = ((astNode.children || {})['Node.Start'] || [])[0];
        const endToken = ((astNode.children || {})['Node.End'] || [])[0];
        if (startToken && endToken) return { startOffset: startToken.startOffset, endOffset: endToken.endOffset };
        if (astNode.location) return { startOffset: astNode.location.startOffset, endOffset: astNode.location.endOffset };
        return { startOffset: 0, endOffset: 0 };
    }

    #flattenIncompleteNode(astNode, excludeToken, items) {
        const children = astNode.children || {};
        for (const key of Object.keys(children)) {
            for (const element of children[key] || []) {
                if (element === excludeToken) continue;
                if ('startOffset' in element && typeof element.startOffset === 'number') {
                    items.push({ type: 'plaintext', startOffset: element.startOffset, endOffset: element.endOffset ?? element.startOffset, token: element });
                } else if ('children' in element) {
                    const nestedEnd = (element.children['Node.End'] || [])[0];
                    const nestedStart = (element.children['Node.Start'] || [])[0];
                    if (nestedStart && nestedEnd && !this.#isRecoveryToken(nestedEnd)) {
                        const range = this.#getNodeRange(element);
                        items.push({ type: 'trigger', startOffset: range.startOffset, endOffset: range.endOffset, node: element });
                    } else {
                        this.#flattenIncompleteNode(element, excludeToken, items);
                    }
                }
            }
        }
    }

    #isRecoveryToken(token) { return token?.isInsertedInRecovery === true || typeof token?.startOffset !== 'number' || Number.isNaN(token?.startOffset); }

    #getArgumentLocation(argNode) {
        let startOffset = Number.POSITIVE_INFINITY, endOffset = Number.NEGATIVE_INFINITY;
        const children = argNode.children || {};
        for (const key of Object.keys(children)) {
            for (const element of children[key] || []) {
                const loc = element.location || element;
                if (loc.startOffset < startOffset) startOffset = loc.startOffset;
                if (loc.endOffset > endOffset) endOffset = loc.endOffset;
            }
        }
        if (!Number.isFinite(startOffset)) return null;
        return { startOffset, endOffset };
    }

    #getFirstTokenInNode(node) {
        let first = null;
        const children = node?.children || {};
        for (const key of Object.keys(children)) {
            for (const element of children[key] || []) {
                if (element.name && element.children) continue;
                if (typeof element.startOffset === 'number' && (first === null || element.startOffset < first.startOffset)) first = element;
            }
        }
        return first;
    }

    #processScopedNodes(items, text) {
        const nodeInfos = items.map((item, index) => {
            if (item.type !== 'trigger') return null;
            const info = this.extractNodeInfo(item.node);
            return info ? { index, item, name: info.name, isClosing: info.isClosing, matched: false } : null;
        }).filter(Boolean);

        const pairs = [];
        const insideScope = new Set();

        for (let i = 0; i < nodeInfos.length; i++) {
            const openInfo = nodeInfos[i];
            if (openInfo.isClosing || openInfo.matched || insideScope.has(openInfo.index)) continue;

            const closingIdx = this.#findMatchingClosingNode(nodeInfos, i);
            if (closingIdx === -1) continue;

            if (!this.#canAcceptScopedContent(openInfo.item.node, openInfo.name)) {
                openInfo.item.keepRaw = true; nodeInfos[closingIdx].item.keepRaw = true;
                openInfo.matched = true; nodeInfos[closingIdx].matched = true;
                continue;
            }

            openInfo.matched = true; nodeInfos[closingIdx].matched = true;
            pairs.push({ openingIndex: openInfo.index, closingIndex: nodeInfos[closingIdx].index });
            for (let j = openInfo.index + 1; j < nodeInfos[closingIdx].index; j++) insideScope.add(j);
        }

        for (const info of nodeInfos) if (info.isClosing && !info.matched) info.item.keepRaw = true;

        if (pairs.length === 0) return items;

        const itemsToRemove = new Set();
        for (const pair of pairs) {
            const openingItem = items[pair.openingIndex];
            const closingItem = items[pair.closingIndex];
            openingItem.scopedContent = {
                startOffset: openingItem.endOffset + 1, endOffset: closingItem.startOffset - 1, closingEndOffset: closingItem.endOffset,
            };
            itemsToRemove.add(pair.closingIndex);
            for (let j = pair.openingIndex + 1; j < pair.closingIndex; j++) itemsToRemove.add(j);
        }
        return items.filter((_, index) => !itemsToRemove.has(index));
    }

    #canAcceptScopedContent(astNode, nodeName) {
        const def = CobaltRegistry.getPrimaryNode(nodeName);
        if (!def) return true;
        if (def.list) return false;
        const bodyChildren = (astNode.children.nodeBody || [])[0]?.children || {};
        const currentArgCount = (bodyChildren.arguments || [])[0]?.children?.argument?.length || 0;
        const newArgCount = currentArgCount + 1;
        return newArgCount >= def.minArgs && newArgCount <= def.maxArgs;
    }

    #findMatchingClosingNode(nodeInfos, openingIdx) {
        const targetName = nodeInfos[openingIdx].name.toLowerCase();
        let depth = 1;
        for (let i = openingIdx + 1; i < nodeInfos.length; i++) {
            const info = nodeInfos[i];
            if (info.name.toLowerCase() !== targetName || info.matched) continue;
            if (info.isClosing) { depth--; if (depth === 0) return i; }
            else if (this.#canAcceptScopedContent(info.item.node, info.name)) { depth++; }
        }
        return -1;
    }
}

const CobaltNodeResolver = new Resolver();
module.exports = { CobaltNodeResolver };