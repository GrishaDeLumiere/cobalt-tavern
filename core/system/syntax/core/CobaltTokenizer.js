// ФАЙЛ: server/syntax/core/CobaltTokenizer.js
const { createToken, Lexer: AbstractAegisLexer } = require('chevrotain');

const IDENTIFIER_LEXER_PATTERN = /[a-zA-Z][\w-_]*/;
const NODE_IDENTIFIER_PATTERN = /^[a-zA-Z][\w-_]*$/;
const NODE_VARIABLE_SHORTHAND_PATTERN = /[a-zA-Z](?:[\w\-_]*[\w])?/;

const modes = Object.freeze({
    plaintext: 'plaintext_mode',
    node_def: 'node_def_mode',
    node_identifier_end: 'node_identifier_end_mode',
    node_args: 'node_args_mode',
    node_filter_modifier: 'node_filter_modifier_mode',
    node_filter_modifier_end: 'node_filter_modifier_end_mode',
    var_identifier: 'var_identifier_mode',
    var_after_identifier: 'var_after_identifier_mode',
    var_value: 'var_value_mode',
});

const Tokens = Object.freeze({
    Plaintext: createToken({ name: 'Plaintext', pattern: /(?:[^\{]|\{(?!\{))+/u, line_breaks: true }),
    PlaintextOpenBrace: createToken({ name: 'Plaintext.OpenBrace', pattern: /\{(?=\{\{)/ }),
    Node: {
        Start: createToken({ name: 'Node.Start', pattern: /\{\{/ }),
        Flags: createToken({ name: 'Node.Flags', pattern: /[!?~#/]/ }),
        FilterFlag: createToken({ name: 'Node.FilterFlag', pattern: />/ }),
        DoubleSlash: createToken({ name: 'Node.DoubleSlash', pattern: /\/\// }),
        Identifier: createToken({ name: 'Node.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
        EndOfIdentifier: createToken({ name: 'Node.EndOfIdentifier', pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/, group: AbstractAegisLexer.SKIPPED }),
        BeforeEnd: createToken({ name: 'Node.BeforeEnd', pattern: /(?=\}\})/, group: AbstractAegisLexer.SKIPPED }),
        End: createToken({ name: 'Node.End', pattern: /\}\}/ }),
    },
    Args: {
        DoubleColon: createToken({ name: 'Args.DoubleColon', pattern: /::/ }),
        Colon: createToken({ name: 'Args.Colon', pattern: /:/ }),
        Equals: createToken({ name: 'Args.Equals', pattern: /=/ }),
        Quote: createToken({ name: 'Args.Quote', pattern: /"/ }),
    },
    Filter: {
        EscapedPipe: createToken({ name: 'Filter.EscapedPipe', pattern: /\\\|/ }),
        Pipe: createToken({ name: 'Filter.Pipe', pattern: /\|/ }),
        Identifier: createToken({ name: 'Filter.Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
        EndOfIdentifier: createToken({ name: 'Filter.EndOfIdentifier', pattern: /(?:\s+|(?=:{1,2})|(?=[|}]))/, group: AbstractAegisLexer.SKIPPED }),
    },
    Identifier: createToken({ name: 'Identifier', pattern: IDENTIFIER_LEXER_PATTERN }),
    WhiteSpace: createToken({ name: 'WhiteSpace', pattern: /\s+/, group: AbstractAegisLexer.SKIPPED }),
    Var: {
        LocalPrefix: createToken({ name: 'Var.LocalPrefix', pattern: /\./ }),
        GlobalPrefix: createToken({ name: 'Var.GlobalPrefix', pattern: /\$/ }),
        Identifier: createToken({ name: 'Var.Identifier', pattern: NODE_VARIABLE_SHORTHAND_PATTERN }),
        Operators: {
            Increment: createToken({ name: 'Var.Increment', pattern: /\+\+/ }),
            Decrement: createToken({ name: 'Var.Decrement', pattern: /--/ }),
            NullishCoalescingEquals: createToken({ name: 'Var.NullishCoalescingEquals', pattern: /\?\?=/ }),
            NullishCoalescing: createToken({ name: 'Var.NullishCoalescing', pattern: /\?\?/ }),
            LogicalOrEquals: createToken({ name: 'Var.LogicalOrEquals', pattern: /\|\|=/ }),
            LogicalOr: createToken({ name: 'Var.LogicalOr', pattern: /\|\|/ }),
            MinusEquals: createToken({ name: 'Var.MinusEquals', pattern: /-=/ }),
            DoubleEquals: createToken({ name: 'Var.DoubleEquals', pattern: /==/ }),
            NotEquals: createToken({ name: 'Var.NotEquals', pattern: /!=/ }),
            GreaterThanOrEqual: createToken({ name: 'Var.GreaterThanOrEqual', pattern: />=/ }),
            GreaterThan: createToken({ name: 'Var.GreaterThan', pattern: />/ }),
            LessThanOrEqual: createToken({ name: 'Var.LessThanOrEqual', pattern: /<=/ }),
            LessThan: createToken({ name: 'Var.LessThan', pattern: /</ }),
            PlusEquals: createToken({ name: 'Var.PlusEquals', pattern: /\+=/ }),
            Equals: createToken({ name: 'Var.Equals', pattern: /=/ }),
        },
    },
    Unknown: createToken({ name: 'Unknown', pattern: /([^\}]|\}(?!\}))/ }),
});

const enterModesMap = new Map();
function enter(token, mode, { andExits = undefined } = {}) { if (andExits) exits(token, andExits); token.PUSH_MODE = mode; enterModesMap.set(token.name, mode); return token; }
function exits(token, mode) { token.POP_MODE = true; return token; }
function using(token) { return token; }

const Def = {
    modes: {
        [modes.plaintext]: [using(Tokens.Plaintext), using(Tokens.PlaintextOpenBrace), enter(Tokens.Node.Start, modes.node_def)],
        [modes.node_def]: [
            exits(Tokens.Node.End, modes.node_def), enter(Tokens.Node.DoubleSlash, modes.node_args),
            enter(Tokens.Var.LocalPrefix, modes.var_identifier), enter(Tokens.Var.GlobalPrefix, modes.var_identifier),
            using(Tokens.Node.Flags), using(Tokens.Node.FilterFlag), using(Tokens.WhiteSpace),
            enter(Tokens.Node.Identifier, modes.node_identifier_end), using(Tokens.Unknown)
        ],
        [modes.node_identifier_end]: [
            exits(Tokens.Node.BeforeEnd, modes.node_identifier_end), enter(Tokens.Node.EndOfIdentifier, modes.node_args, { andExits: modes.node_identifier_end }),
        ],
        [modes.node_args]: [
            enter(Tokens.Node.Start, modes.node_def), using(Tokens.Args.DoubleColon), using(Tokens.Args.Colon),
            using(Tokens.Args.Equals), using(Tokens.Args.Quote), using(Tokens.Identifier), using(Tokens.WhiteSpace),
            exits(Tokens.Node.BeforeEnd, modes.node_args), using(Tokens.Unknown),
        ],
        [modes.node_filter_modifier]: [
            using(Tokens.WhiteSpace), enter(Tokens.Filter.Identifier, modes.node_filter_modifier_end, { andExits: modes.node_filter_modifier }),
        ],
        [modes.node_filter_modifier_end]: [
            exits(Tokens.Node.BeforeEnd, modes.node_identifier_end), exits(Tokens.Filter.EndOfIdentifier, modes.node_filter_modifier),
        ],
        [modes.var_identifier]: [
            using(Tokens.WhiteSpace), enter(Tokens.Var.Identifier, modes.var_after_identifier, { andExits: modes.var_identifier }),
            exits(Tokens.Node.BeforeEnd, modes.var_identifier), using(Tokens.Unknown),
        ],
        [modes.var_after_identifier]: [
            using(Tokens.WhiteSpace), using(Tokens.Var.Operators.Increment), using(Tokens.Var.Operators.Decrement),
            enter(Tokens.Var.Operators.NullishCoalescingEquals, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.NullishCoalescing, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.LogicalOrEquals, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.LogicalOr, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.MinusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.DoubleEquals, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.NotEquals, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.GreaterThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.GreaterThan, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.LessThanOrEqual, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.LessThan, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.PlusEquals, modes.var_value, { andExits: modes.var_after_identifier }),
            enter(Tokens.Var.Operators.Equals, modes.var_value, { andExits: modes.var_after_identifier }),
            exits(Tokens.Node.BeforeEnd, modes.var_after_identifier), using(Tokens.Unknown),
        ],
        [modes.var_value]: [
            enter(Tokens.Node.Start, modes.node_def), using(Tokens.Identifier), using(Tokens.WhiteSpace),
            exits(Tokens.Node.BeforeEnd, modes.var_value), using(Tokens.Unknown),
        ],
    },
    defaultMode: modes.plaintext,
};

const CobaltTokenizer = new AbstractAegisLexer(Def, { traceInitPerf: false });
module.exports = { CobaltTokenizer, Tokens, NODE_IDENTIFIER_PATTERN, NODE_VARIABLE_SHORTHAND_PATTERN };