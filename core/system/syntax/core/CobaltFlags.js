// ФАЙЛ: server/syntax/core/CobaltFlags.js
const CobaltFlagType = Object.freeze({
    IMMEDIATE: '!',
    DELAYED: '?',
    REEVALUATE: '~',
    FILTER: '>',
    CLOSING_BLOCK: '/',
    PRESERVE_WHITESPACE: '#',
});

function createEmptyFlags() {
    return {
        immediate: false,
        delayed: false,
        reevaluate: false,
        filter: false,
        closingBlock: false,
        preserveWhitespace: false,
        raw: [],
    };
}

function parseFlags(flagSymbols) {
    const flags = createEmptyFlags();
    for (const symbol of flagSymbols) {
        switch (symbol) {
            case CobaltFlagType.IMMEDIATE: flags.immediate = true; break;
            case CobaltFlagType.DELAYED: flags.delayed = true; break;
            case CobaltFlagType.REEVALUATE: flags.reevaluate = true; break;
            case CobaltFlagType.FILTER: flags.filter = true; break;
            case CobaltFlagType.CLOSING_BLOCK: flags.closingBlock = true; break;
            case CobaltFlagType.PRESERVE_WHITESPACE: flags.preserveWhitespace = true; break;
        }
        flags.raw.push(symbol);
    }
    return flags;
}

module.exports = { CobaltFlagType, createEmptyFlags, parseFlags };