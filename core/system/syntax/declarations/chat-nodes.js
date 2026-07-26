// ФАЙЛ: server/syntax/declarations/chat-nodes.js
const { CobaltRegistry, CobaltCategory, CobaltValueType } = require('../core/CobaltRegistry.js');

function registerChatNodes() {
    const getChat = (env) => env.serverLayer?.chat?.messages || [];

    const getLastMessageId = (env, filter = null) => {
        const chat = getChat(env);
        if (!chat || chat.length === 0) return null;

        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (!filter || filter(message)) return i;
        }
        return null;
    };

    CobaltRegistry.registerNode('lastMessage', {
        category: CobaltCategory.CHAT,
        handler: ({ env }) => {
            const mid = getLastMessageId(env);
            return mid !== null ? (getChat(env)[mid]?.mes || '') : '';
        },
    });

    CobaltRegistry.registerNode('lastMessageId', {
        category: CobaltCategory.CHAT,
        returnType: CobaltValueType.INTEGER,
        handler: ({ env }) => {
            const mid = getLastMessageId(env);
            return mid !== null ? String(mid) : '';
        },
    });

    CobaltRegistry.registerNode('lastUserMessage', {
        category: CobaltCategory.CHAT,
        handler: ({ env }) => {
            const mid = getLastMessageId(env, m => m.is_user && !m.is_system);
            return mid !== null ? (getChat(env)[mid]?.mes || '') : '';
        },
    });

    CobaltRegistry.registerNode('lastCharMessage', {
        category: CobaltCategory.CHAT,
        handler: ({ env }) => {
            const mid = getLastMessageId(env, m => !m.is_user && !m.is_system);
            return mid !== null ? (getChat(env)[mid]?.mes || '') : '';
        },
    });

    CobaltRegistry.registerNode('allChatRange', {
        category: CobaltCategory.CHAT,
        handler: ({ env }) => {
            const chat = getChat(env);
            if (!chat || chat.length === 0) return '';
            return `0-${chat.length - 1}`;
        },
    });

    CobaltRegistry.registerNode('firstIncludedMessageId', {
        category: CobaltCategory.CHAT,
        returnType: CobaltValueType.INTEGER,
        handler: () => '0',
    });

    CobaltRegistry.registerNode('firstDisplayedMessageId', {
        category: CobaltCategory.CHAT,
        returnType: CobaltValueType.INTEGER,
        handler: () => '0',
    });

    CobaltRegistry.registerNode('lastSwipeId', {
        category: CobaltCategory.CHAT,
        returnType: CobaltValueType.INTEGER,
        handler: () => '1',
    });

    CobaltRegistry.registerNode('currentSwipeId', {
        category: CobaltCategory.CHAT,
        returnType: CobaltValueType.INTEGER,
        handler: () => '1',
    });
}

module.exports = { registerChatNodes };