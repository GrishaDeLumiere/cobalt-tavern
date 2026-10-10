const DEFAULT_TAGS = ['think', 'thought', 'reasoning', 'details', 's'];
const DEFAULT_REGEX = new RegExp(
    `\`*<(${DEFAULT_TAGS.join('|')})[^>]*>[\\s\\S]*?<\\/\\1>\`*|` +
    `\`*<(${DEFAULT_TAGS.join('|')})[^>]*>[\\s\\S]*$|` +
    `^[\\s\\S]*?<\\/(${DEFAULT_TAGS.join('|')})>\`*`,
    'gi'
);

const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const customRegexCache = new Map();

function getCustomRegex(openTag, closeTag) {
    const key = `${openTag}_${closeTag}`;
    let rx = customRegexCache.get(key);
    if (!rx) {
        const O = escapeRegExp(openTag);
        const C = escapeRegExp(closeTag);
        rx = new RegExp(`\`*${O}[\\s\\S]*?(${C}|$)\`*|^[\\s\\S]*?${C}\`*`, 'gi');
        customRegexCache.set(key, rx);
    }
    return rx;
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

    let result = text.replace(DEFAULT_REGEX, '');

    if (openTag && openTag !== '<think>') {
        const customRx = getCustomRegex(openTag, actualCloseTag);
        result = result.replace(customRx, '');
    }

    return result.trim();
}

function cleanForPreview(text, presetOrOpenTag, closeTag, maxLength = 200) {
    if (!text) return '';
    let cleaned = stripThoughts(text, presetOrOpenTag, closeTag);
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