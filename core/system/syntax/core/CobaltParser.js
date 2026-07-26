// ФАЙЛ: server/syntax/core/CobaltLexer.js
const { CstParser: AbstractAegisParser } = require('chevrotain');
const { CobaltTokenizer, Tokens } = require('./CobaltTokenizer.js');

class CobaltParser extends AbstractAegisParser {
    constructor() {
        super(Tokens, { traceInitPerf: false, nodeLocationTracking: 'full', recoveryEnabled: true });
        const $ = this;

        $.document = $.RULE('document', () => {
            $.MANY(() => {
                $.OR([
                    { ALT: () => $.CONSUME(Tokens.Plaintext, { LABEL: 'plaintext' }) },
                    { ALT: () => $.CONSUME(Tokens.PlaintextOpenBrace, { LABEL: 'plaintext' }) },
                    { ALT: () => $.SUBRULE($.trigger) },
                    { ALT: () => $.CONSUME(Tokens.Node.Start, { LABEL: 'plaintext' }) },
                ]);
            });
        });

        $.trigger = $.RULE('trigger', () => {
            $.CONSUME(Tokens.Node.Start);
            $.MANY(() => {
                $.OR1([
                    { ALT: () => $.CONSUME(Tokens.Node.Flags, { LABEL: 'flags' }) },
                    { ALT: () => $.CONSUME(Tokens.Node.FilterFlag, { LABEL: 'flags' }) },
                ]);
            });
            $.OR([
                { ALT: () => $.SUBRULE($.variableExpr) },
                { ALT: () => $.SUBRULE($.nodeBody) },
            ]);
            $.CONSUME(Tokens.Node.End);
        });

        $.nodeBody = $.RULE('nodeBody', () => {
            $.OR2([
                { ALT: () => $.CONSUME(Tokens.Node.DoubleSlash, { LABEL: 'Node.identifier' }) },
                { ALT: () => $.CONSUME(Tokens.Node.Identifier, { LABEL: 'Node.identifier' }) },
            ]);
            $.OPTION(() => $.SUBRULE($.arguments));
        });

        $.variableExpr = $.RULE('variableExpr', () => {
            $.OR3([
                { ALT: () => $.CONSUME(Tokens.Var.LocalPrefix, { LABEL: 'Var.scope' }) },
                { ALT: () => $.CONSUME(Tokens.Var.GlobalPrefix, { LABEL: 'Var.scope' }) },
            ]);
            $.CONSUME(Tokens.Var.Identifier, { LABEL: 'Var.identifier' });
            $.OPTION2(() => $.SUBRULE($.variableOperator));
        });

        $.variableOperator = $.RULE('variableOperator', () => {
            $.OR4([
                { ALT: () => $.CONSUME(Tokens.Var.Operators.Increment, { LABEL: 'Var.operator' }) },
                { ALT: () => $.CONSUME(Tokens.Var.Operators.Decrement, { LABEL: 'Var.operator' }) },
                {
                    ALT: () => {
                        $.OR5([
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.NullishCoalescingEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.NullishCoalescing, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LogicalOrEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LogicalOr, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.MinusEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.DoubleEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.NotEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.GreaterThanOrEqual, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.GreaterThan, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LessThanOrEqual, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.LessThan, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.PlusEquals, { LABEL: 'Var.operator' }) },
                            { ALT: () => $.CONSUME(Tokens.Var.Operators.Equals, { LABEL: 'Var.operator' }) },
                        ]);
                        $.SUBRULE($.variableValue, { LABEL: 'Var.value' });
                    },
                },
            ]);
        });

        $.variableValue = $.RULE('variableValue', () => {
            $.MANY2(() => {
                $.OR5([
                    { ALT: () => $.SUBRULE($.trigger) },
                    { ALT: () => $.CONSUME(Tokens.Identifier) },
                    { ALT: () => $.CONSUME(Tokens.Unknown) },
                ]);
            });
        });

        $.arguments = $.RULE('arguments', () => {
            $.OR([
                {
                    ALT: () => {
                        $.CONSUME(Tokens.Args.DoubleColon, { LABEL: 'separator' });
                        $.AT_LEAST_ONE_SEP({ SEP: Tokens.Args.DoubleColon, DEF: () => $.SUBRULE($.argument, { LABEL: 'argument' }) });
                    },
                },
                {
                    ALT: () => {
                        $.OPTION(() => { $.CONSUME(Tokens.Args.Colon, { LABEL: 'separator' }); });
                        $.SUBRULE($.argumentAllowingColons, { LABEL: 'argument' });
                    },
                    IGNORE_AMBIGUITIES: true,
                },
            ]);
        });

        const validArgumentTokens = [
            { ALT: () => $.SUBRULE($.trigger) }, { ALT: () => $.CONSUME(Tokens.Identifier) }, { ALT: () => $.CONSUME(Tokens.Unknown) },
            { ALT: () => $.CONSUME(Tokens.Args.Colon) }, { ALT: () => $.CONSUME(Tokens.Args.Equals) }, { ALT: () => $.CONSUME(Tokens.Args.Quote) },
        ];

        $.argument = $.RULE('argument', () => { $.MANY(() => { $.OR([...validArgumentTokens]); }); });
        $.argumentAllowingColons = $.RULE('argumentAllowingColons', () => {
            $.AT_LEAST_ONE(() => { $.OR([...validArgumentTokens, { ALT: () => $.CONSUME(Tokens.Args.DoubleColon) }]); });
        });

        this.performSelfAnalysis();
    }

    parseDocument(input) {
        if (!input) return { ast: null, errors: [], lexingErrors: [], parserErrors: [] };

        const lexingResult = CobaltTokenizer.tokenize(input);

        this.input = lexingResult.tokens;
        const ast = this.document();
        return { ast, errors: [...lexingResult.errors, ...this.errors], lexingErrors: lexingResult.errors, parserErrors: this.errors };
    }
}

const CobaltParserInstance = new CobaltParser();
module.exports = { CobaltParser: CobaltParserInstance };