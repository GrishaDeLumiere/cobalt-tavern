// ФАЙЛ: server/syntax/declarations/time-nodes.js
const { CobaltRegistry, CobaltCategory, CobaltValueType } = require('../core/CobaltRegistry.js');
const moment = require('moment');

function registerTimeNodes() {
    CobaltRegistry.registerNode('time', {
        category: CobaltCategory.TIME,
        unnamedArgs: [{ name: 'offset', optional: true, defaultValue: 'null', type: CobaltValueType.STRING }],
        handler: ({ unnamedArgs: [offsetSpec] }) => {
            if (!offsetSpec || offsetSpec === 'null') return moment().format('LT');
            const match = /^UTC([+-]\d+)$/.exec(offsetSpec);
            if (!match) return moment().format('LT');
            const offset = Number.parseInt(match[1], 10);
            if (Number.isNaN(offset)) return moment().format('LT');
            return moment().utc().utcOffset(offset).format('LT');
        },
    });

    CobaltRegistry.registerNode('date', {
        category: CobaltCategory.TIME,
        handler: () => moment().format('LL'),
    });

    CobaltRegistry.registerNode('weekday', {
        category: CobaltCategory.TIME,
        handler: () => moment().format('dddd'),
    });

    CobaltRegistry.registerNode('isotime', {
        category: CobaltCategory.TIME,
        handler: () => moment().format('HH:mm'),
    });

    CobaltRegistry.registerNode('isodate', {
        category: CobaltCategory.TIME,
        handler: () => moment().format('YYYY-MM-DD'),
    });

    CobaltRegistry.registerNode('datetimeformat', {
        category: CobaltCategory.TIME,
        unnamedArgs: [{ name: 'format', type: CobaltValueType.STRING }],
        handler: ({ unnamedArgs: [format] }) => moment().format(format),
    });

    CobaltRegistry.registerNode('idleDuration', {
        aliases: [{ alias: 'idle_duration' }],
        category: CobaltCategory.TIME,
        handler: ({ env }) => {
            const chat = env.serverLayer?.chat?.messages || [];
            const now = moment();
            if (chat.length > 0) {
                let lastMessage;
                let takeNext = false;
                for (let i = chat.length - 1; i >= 0; i--) {
                    const message = chat[i];
                    if (message.is_system) continue;
                    if (message.is_user && takeNext) {
                        lastMessage = message;
                        break;
                    }
                    takeNext = true;
                }
                if (lastMessage && lastMessage.send_date) {
                    const lastMessageDate = moment(lastMessage.send_date);
                    return moment.duration(now.diff(lastMessageDate)).humanize();
                }
            }
            return 'just now';
        },
    });

    CobaltRegistry.registerNode('timeDiff', {
        category: CobaltCategory.TIME,
        unnamedArgs: [{ name: 'left', type: CobaltValueType.STRING }, { name: 'right', type: CobaltValueType.STRING }],
        handler: ({ unnamedArgs: [left, right] }) => {
            const diff = moment.duration(moment(left).diff(moment(right)));
            return diff.humanize(true);
        },
    });
}

module.exports = { registerTimeNodes };