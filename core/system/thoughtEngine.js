const DEFAULT_TAGS = ['think', 'thought', 'reasoning'];
const DEFAULT_PAIRED_REGEX = new RegExp(
    `\`*<(${DEFAULT_TAGS.join('|')})(?:\\s[^>]*)?>[\\s\\S]*?(?:<\\/\\1>\`*|$)`,
    'gi'
);
const DEFAULT_ORPHAN_CLOSE_REGEX = new RegExp(
    `^[\\s\\S]*?<\\/(${DEFAULT_TAGS.join('|')})>\`*`,
    'i'
);

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const customRegexCache = new Map();

function getCustomRegexes(openTag, closeTag) {
    const key = `${openTag}_${closeTag}`;
    let rxObj = customRegexCache.get(key);
    if (!rxObj) {
        const O = escapeRegExp(openTag);
        const C = escapeRegExp(closeTag);
        rxObj = {
            paired: new RegExp(`\`*${O}[\\s\\S]*?(?:${C}\`*|$)`, 'gi'),
            orphanClose: new RegExp(`^[\\s\\S]*?${C}\`*`, 'i')
        };
        customRegexCache.set(key, rxObj);
    }
    return rxObj;
}

function getReasoningTags(preset) {
    if (!preset || typeof preset !== 'object') {
        return { openTag: '<think>', closeTag: '</think>' };
    }
    const openTag = preset.reasoning_open_tag?.trim() || '<think>';
    let closeTag = preset.reasoning_close_tag?.trim();
    if (!closeTag) {
        closeTag = (openTag.startsWith('<') && !openTag.startsWith('</'))
            ? openTag.replace('<', '</')
            : '</think>';
    }
    return { openTag, closeTag };
}

function stripThoughts(text, presetOrOpenTag = '<think>', closeTag = '</think>') {
    if (!text || typeof text !== 'string') return '';

    let openTag = '<think>';
    let actualCloseTag = '</think>';

    if (presetOrOpenTag && typeof presetOrOpenTag === 'object') {
        const tags = getReasoningTags(presetOrOpenTag);
        openTag = tags.openTag;
        actualCloseTag = tags.closeTag;
    } else if (typeof presetOrOpenTag === 'string') {
        openTag = presetOrOpenTag;
        actualCloseTag = closeTag || (openTag.startsWith('<') ? openTag.replace('<', '</') : '</think>');
    }

    let result = text.replace(DEFAULT_PAIRED_REGEX, '');
    if (DEFAULT_ORPHAN_CLOSE_REGEX.test(result)) {
        result = result.replace(DEFAULT_ORPHAN_CLOSE_REGEX, '');
    }

    if (openTag && openTag !== '<think>') {
        const customRx = getCustomRegexes(openTag, actualCloseTag);
        result = result.replace(customRx.paired, '');
        if (customRx.orphanClose.test(result)) {
            result = result.replace(customRx.orphanClose, '');
        }
    }

    return result.trim();
}

function cleanForPreview(text, presetOrOpenTag, closeTag, maxLength = 200) {
    if (!text) return '';
    let cleaned = stripThoughts(text, presetOrOpenTag, closeTag);
    cleaned = cleaned.replace(/<(details|nodisplay|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    cleaned = cleaned.replace(/<[^>]+>/g, '');
    cleaned = cleaned.replace(/^[`\s\r\n]+/, '');
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned.substring(0, maxLength);
}

module.exports = {
    getReasoningTags,
    stripThoughts,
    cleanForPreview
};