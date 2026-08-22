// ФАЙЛ: server/system/promptBuilder.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('./init');
const { resolveTemplateVariables } = require('./syntaxEngine');
const { scanLorebooks } = require('./loreEngine');

// --- ФУНКЦИЯ ПОСТОБРАБОТКИ ФИНАЛЬНОГО МАССИВА (STRICT / MERGE) ---
const applyPostProcessing = (messages, mode) => {
    if (!messages || messages.length === 0) return [];

    // ШАГ 0: Вычищаем призрачные (пустые) сообщения!
    const validMessages = messages.filter(msg =>
        (msg.content && String(msg.content).trim() !== '') ||
        (msg.images && msg.images.length > 0)
    );

    if (mode === 'none' || !mode) return validMessages;

    let processed = [];

    // Шаг 1: Трансформация ролей (semi_strict, strict превращают system в user)
    validMessages.forEach(msg => {
        let role = (msg.role || 'system').toLowerCase();
        if ((mode === 'semi_strict' || mode === 'strict') && role === 'system') {
            role = 'user';
        }
        processed.push({ ...msg, role, images: msg.images || [] });
    });

    // Шаг 2: Слияние соседних одинаковых ролей (Merge)
    let merged = [];
    let currentGroup = null;

    processed.forEach(msg => {
        if (!currentGroup) {
            currentGroup = { ...msg, images: [...(msg.images || [])] };
        } else {
            if (currentGroup.role === msg.role) {
                currentGroup.content += `\n\n${msg.content}`;
                if (msg.images && msg.images.length > 0) {
                    currentGroup.images.push(...msg.images);
                }
            } else {
                merged.push(currentGroup);
                currentGroup = { ...msg, images: [...(msg.images || [])] };
            }
        }
    });
    if (currentGroup) merged.push(currentGroup);

    // Шаг 3: Strict Padding (Если включен strict и первая роль assistant)
    if (mode === 'strict' && merged.length > 0) {
        if (merged[0].role === 'assistant') {
            merged.unshift({
                role: 'user',
                content: '...',
                images: []
            });
        }
    }

    return merged;
};

// --- ИНЖЕКТОР АВТОРСКИХ ЗАМЕТОК (A/N) ---
const injectAuthorNote = (globalNodes, depthNodes, chatMetadata, cleanMessages) => {
    const authorNote = chatMetadata?.author_note;
    if (!authorNote || !authorNote.text) return { globalNodes, depthNodes };

    const notePayload = {
        text: authorNote.text,
        role: authorNote.role || 'system',
        isAuthorNote: true
    };

    if (authorNote.position === 'before') {
        globalNodes.push({ ...notePayload, injection_position: 0, injection_order: -9999 });
    } else if (authorNote.position === 'after') {
        globalNodes.push({ ...notePayload, injection_position: 0, injection_order: 9999 });
    } else { // Режим 'depth'
        if (authorNote.interval > 0) {
            const userMsgsCount = cleanMessages.filter(m => m.is_user && !m.is_system && !m.isHidden).length;
            let shouldInject = (authorNote.interval === 1) || (userMsgsCount > 0 && (userMsgsCount % authorNote.interval) === 0);

            if (shouldInject) {
                depthNodes.push({
                    ...notePayload,
                    injection_depth: authorNote.depth || 1,
                    injection_order: 9999
                });
            }
        }
    }

    return { globalNodes, depthNodes };
};

// --- ГЛАВНАЯ ФУНКЦИЯ СБОРКИ ---
const buildPrompt = async (payload) => {
    const { chatId, presetId, charId, personaId, sysConfig, postProcessing = 'none' } = payload;

    const chatsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'chats');
    const presetsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'ai_presets');
    const charsDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.json');
    const personasDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.json');

    // 1. Читаем всё с диска (теперь вытаскиваем метадату чата!)
    let chat = { messages: [], character_name: 'System', user_name: 'User', chat_metadata: {} };
    if (chatId) {
        try {
            const chatRaw = await fs.readFile(path.join(chatsDir, decodeURIComponent(chatId)), 'utf-8');
            const lines = chatRaw.split('\n').filter(l => l.trim());
            const meta = JSON.parse(lines[0]);
            chat.character_name = meta.character_name;
            chat.user_name = meta.user_name || 'User';
            chat.chat_metadata = meta.chat_metadata || {};
            chat.messages = lines.slice(1).map(l => JSON.parse(l));
        } catch (e) { console.error('[BUILDER] Ошибка чтения чата:', e.message); }
    }

    let preset = null;
    try {
        preset = JSON.parse(await fs.readFile(path.join(presetsDir, `${presetId}.json`), 'utf-8'));
    } catch (e) { throw new Error('Не удалось загрузить AI Preset'); }

    let character = null;
    try {
        const finalCharId = charId || chat.chat_metadata?.character_id;
        const charsDb = JSON.parse(await fs.readFile(charsDbPath, 'utf-8'));

        if (finalCharId) {
            character = charsDb.characters.find(c => c.id === finalCharId);
        }

        if (!character && chat.character_name) {
            character = charsDb.characters.find(c =>
                (c.name || '').toLowerCase() === chat.character_name.toLowerCase()
            );
        }
    } catch (e) { console.error('[BUILDER] Сбой чтения базы персонажей'); }

    let persona = null;
    if (personaId) {
        try {
            const personasDb = JSON.parse(await fs.readFile(personasDbPath, 'utf-8'));
            persona = personasDb.personas.find(p => p.id === personaId);
        } catch (e) { }
    }

    const charName = character?.name || chat.character_name || 'System';
    const userName = persona?.name || chat.user_name || 'User';
    const sharedVariables = { local: new Map(), global: new Map() };

    const openTag = preset?.reasoning_open_tag || '<think>';
    const closeTag = preset?.reasoning_close_tag || '</think>';
    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const thinkRegex = new RegExp(`${escapeRegExp(openTag)}[\\s\\S]*?(${escapeRegExp(closeTag)}|$)`, 'gi');

    // Очищаем чат (для сообщений ассистента вырезаем теги мыслей)
    const cleanMessages = chat.messages.map(m => {
        let text = m.mes || '';
        if (!m.is_user && text.includes(openTag)) {
            text = text.replace(thinkRegex, '').trim();
        }
        return { ...m, mes: text };
    });

    // 2. Сканируем ЛОР через Lore Engine (ИСПОЛЬЗУЕМ ОЧИЩЕННЫЙ ЧАТ)
    const lore = await scanLorebooks(
        cleanMessages,
        character?.lorebooks || [],
        sysConfig?.activeLorebooks || [],
        sysConfig?.loreConfig || {},
        character
    );

    // 3. Вытаскиваем все активные ноды из пресета
    let allNodes = [];
    preset.categories?.forEach(cat => {
        cat.nodes?.forEach(node => {
            if (node.active) allNodes.push(node);
        });
    });

    let globalNodes = allNodes.filter(n => n.injection_position === 0);
    let depthNodes = allNodes.filter(n => n.injection_position === 1);

    if (lore.injections && lore.injections.length > 0) {
        depthNodes = depthNodes.concat(lore.injections);
    }

    // ИНЖЕКЦИЯ АВТОРСКИХ ЗАМЕТОК
    const injectedData = injectAuthorNote(globalNodes, depthNodes, chat.chat_metadata, cleanMessages);

    // СОРТИРУЕМ УЖЕ ГОТОВЫЙ МАССИВ С УЧЕТОМ ЗАМЕТОК И ЛОРА
    globalNodes = injectedData.globalNodes.sort((a, b) => a.injection_order - b.injection_order);
    depthNodes = injectedData.depthNodes.sort((a, b) => a.injection_order - b.injection_order);

    const rawPayload = [];

    // 4. Проходим по Глобальным Узлам и собираем массив
    for (const node of globalNodes) {
        let content = '';

        if (node.isMarker) {
            switch (node.identifier) {
                case 'main': content = node.text || ''; break;
                case 'worldInfoBefore': content = lore.before; break;
                case 'charDescription': content = character?.description || ''; break;
                case 'charPersonality': content = character?.personality || ''; break;
                case 'scenario': content = character?.scenario || ''; break;
                case 'personaDescription': content = persona?.text || ''; break;
                case 'worldInfoAfter': content = lore.after; break;
                case 'dialogueExamples': content = character?.mes_example || ''; break;

                case 'chatHistory':
                    let historyMsgs = [];
                    let historicalUserName = userName;

                    const VISION_DEPTH_LIMIT = preset?.vision_depth !== undefined ? parseInt(preset.vision_depth, 10) : 5;

                    // 1. Сворачиваем сгруппированные пересказы и отбираем валидные ноды
                    let validMessages = [];
                    const processedGroupIds = new Set();

                    for (let index = 0; index < cleanMessages.length; index++) {
                        const m = cleanMessages[index];
                        if (m.is_system || m.isHidden) continue;

                        // Если сообщение входит в группу пересказа
                        if (m.summary_group?.id) {
                            const groupId = m.summary_group.id;

                            // Если эту группу мы еще не вставляли — ищем её итоговый текст и пушим ОДНУ ноду вместо всей пачки
                            if (!processedGroupIds.has(groupId)) {
                                processedGroupIds.add(groupId);

                                // Находим текст пересказа (он хранится в последнем элементе группы)
                                const groupLeader = cleanMessages.find(item => item.summary_group?.id === groupId && item.summary_group?.isLast);
                                const summaryText = groupLeader?.summary_group?.text || m.summary_group?.text || '';

                                if (summaryText.trim()) {
                                    const summaryRole = groupLeader?.summary_group?.role || m.summary_group?.role || 'assistant';

                                    validMessages.push({
                                        originalIndex: index,
                                        isSummaryNode: true,
                                        message: {
                                            is_user: summaryRole === 'user',
                                            is_system: summaryRole === 'system',
                                            role: summaryRole,
                                            mes: summaryText.trim(),
                                            name: summaryRole === 'user' ? userName : (summaryRole === 'assistant' ? charName : 'System')
                                        }
                                    });
                                }
                            }
                            // Все остальные сообщения этой группы просто пропускаются
                            continue;
                        }

                        validMessages.push({ originalIndex: index, isSummaryNode: false, message: m });
                    }

                    const totalValid = validMessages.length;

                    // 2. Считаем смещение глубины (если последнее сообщение от AI, у юзера depth 0, у бота -1)
                    const lastMsgIsAi = totalValid > 0 && !validMessages[totalValid - 1].message.is_user;
                    const depthOffset = lastMsgIsAi ? 1 : 0;

                    // 3. Формируем историю чата с жестко привязанной глубиной (depth)
                    for (let i = 0; i < totalValid; i++) {
                        const item = validMessages[i];
                        const m = item.message;
                        const msgDepth = totalValid - 1 - i - depthOffset;

                        if (m.is_user && m.name) {
                            historicalUserName = m.name;
                        }

                        const resolvedContent = resolveTemplateVariables(m.mes || '', {
                            charName, userName: historicalUserName, chat, character, persona, sysConfig, variables: sharedVariables
                        });

                        let attachmentsBase64 = [];
                        // Вложения подтягиваем только для обычных сообщений (не для пересказов)
                        const isRecentNode = (totalValid - i) <= VISION_DEPTH_LIMIT;
                        if (!item.isSummaryNode && isRecentNode && preset?.send_attachments !== false && m.extra?.attachments) {
                            const attachDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters', character?.id || 'unknown', 'attachments');
                            for (const filename of m.extra.attachments) {
                                try {
                                    const buffer = await fs.readFile(path.join(attachDir, filename));
                                    const ext = path.extname(filename).toLowerCase();
                                    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
                                    attachmentsBase64.push(`data:${mime};base64,${buffer.toString('base64')}`);
                                } catch (err) { }
                            }
                        }

                        if (resolvedContent.trim() !== '' || attachmentsBase64.length > 0) {
                            historyMsgs.push({
                                depth: msgDepth,
                                role: item.isSummaryNode ? (m.role || 'assistant') : (m.is_user ? 'user' : 'assistant'),
                                content: resolvedContent,
                                name: m.name || (m.is_user ? historicalUserName : charName),
                                images: attachmentsBase64.length > 0 ? attachmentsBase64 : undefined
                            });
                        }
                    }

                    // 4. ВРЕЗАЕМ УЗЛЫ ГЛУБИНЫ (INJECTIONS)
                    let finalHistoryMsgs = [];
                    const minHistoryDepth = historyMsgs.length > 0 ? historyMsgs[historyMsgs.length - 1].depth : 0;
                    const endLoopDepth = Math.min(minHistoryDepth, 0);

                    const maxInjectDepth = depthNodes.length > 0
                        ? Math.max(...depthNodes.map(n => n.injection_depth !== undefined ? n.injection_depth : 0))
                        : 0;

                    const startLoopDepth = Math.max(historyMsgs.length > 0 ? historyMsgs[0].depth : 0, maxInjectDepth);

                    for (let currentDepth = startLoopDepth; currentDepth >= endLoopDepth; currentDepth--) {

                        // А) СНАЧАЛА пушим сообщение чата этой глубины (если есть)
                        const chatMsg = historyMsgs.find(m => m.depth === currentDepth);
                        if (chatMsg) {
                            finalHistoryMsgs.push({ role: chatMsg.role, content: chatMsg.content, name: chatMsg.name, images: chatMsg.images });
                        }

                        // Б) ПОТОМ пушим инжекты (сортируя их между собой по ордеру и роли)
                        let currentNodes = depthNodes.filter(n => (n.injection_depth !== undefined ? n.injection_depth : 0) === currentDepth);
                        if (currentNodes.length > 0) {
                            currentNodes.sort((a, b) => {
                                const ordA = a.injection_order !== undefined ? a.injection_order : 100;
                                const ordB = b.injection_order !== undefined ? b.injection_order : 100;
                                if (ordA !== ordB) return ordA - ordB;

                                const roleWeight = (r) => {
                                    const role = (r || 'system').toLowerCase();
                                    if (role === 'system') return 0;
                                    if (role === 'user') return 1;
                                    return 2;
                                };
                                return roleWeight(a.role) - roleWeight(b.role);
                            });

                            for (const dNode of currentNodes) {
                                let dContent = dNode.text || '';
                                if (dContent) {
                                    const resolvedDContent = resolveTemplateVariables(dContent, {
                                        charName, userName, chat, character, persona, sysConfig, variables: sharedVariables
                                    });
                                    if (resolvedDContent.trim() !== '') {
                                        finalHistoryMsgs.push({ role: (dNode.role || 'System').toLowerCase(), content: resolvedDContent });
                                    }
                                }
                            }
                        }
                    }

                    rawPayload.push(...finalHistoryMsgs);
                    continue;
            }
        } else {
            content = node.text || '';
        }

        content = resolveTemplateVariables(content.trim(), {
            charName,
            userName,
            chat,
            character,
            persona,
            sysConfig,
            variables: sharedVariables
        });


        if (content) {
            rawPayload.push({
                role: (node.role || 'System').toLowerCase(),
                content: content
            });
        }
    }

    const outgoingRules = (sysConfig?.regexRules || []).filter(r => {
        const pArr = Array.isArray(r.placement) ? r.placement : [r.placement];
        return r.active && pArr.includes('outgoing') && r.pattern;
    });
    if (outgoingRules.length > 0) {
        rawPayload.forEach(m => {
            outgoingRules.forEach(r => {
                try {
                    const reg = new RegExp(r.pattern, r.flags || 'g');
                    m.content = m.content.replace(reg, (r.replacement || '').replace(/\\n/g, '\n'));
                } catch (e) { }
            });
        });
    }

    // 5. ПОСТОБРАБОТКА (Слияние ролей, Strict mode, Padding)
    const processedPayload = applyPostProcessing(rawPayload, postProcessing);

    return {
        messages: processedPayload,
        samplerSettings: {
            max_tokens: preset.max_tokens,
            temperature: preset.temp,
            top_p: preset.top_p,
            top_k: preset.top_k,
            frequency_penalty: preset.rep_pen,
            stream: preset.stream !== false
        }
    };
};

module.exports = { buildPrompt };