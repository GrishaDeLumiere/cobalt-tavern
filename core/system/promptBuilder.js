// ФАЙЛ: server/system/promptBuilder.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('./init');
const { resolveTemplateVariables } = require('./syntaxEngine');
const { scanLorebooks } = require('./loreEngine');

// --- ФУНКЦИЯ ПОСТОБРАБОТКИ ФИНАЛЬНОГО МАССИВА (STRICT / MERGE) ---
const applyPostProcessing = (messages, mode) => {
    if (!messages || messages.length === 0) return [];
    if (mode === 'none' || !mode) return messages;

    let processed = [];

    // Шаг 1: Трансформация ролей (semi_strict, strict превращают system в user)
    messages.forEach(msg => {
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
                    const totalMsgs = cleanMessages.length;

                    for (let index = 0; index < totalMsgs; index++) {
                        const m = cleanMessages[index];
                        if (m.is_system) continue;
                        if (m.isHidden) continue;

                        if (m.is_user && m.name) {
                            historicalUserName = m.name;
                        }

                        let rawText = m.mes || '';

                        const resolvedContent = resolveTemplateVariables(rawText, {
                            charName,
                            userName: historicalUserName,
                            chat,
                            character,
                            persona,
                            sysConfig,
                            variables: sharedVariables
                        });

                        let attachmentsBase64 = [];
                        const isRecentNode = (totalMsgs - index) <= VISION_DEPTH_LIMIT;

                        if (isRecentNode && preset?.send_attachments !== false && m.extra && Array.isArray(m.extra.attachments)) {
                            const targetCharId = character?.id || 'unknown';
                            const attachDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters', targetCharId, 'attachments');

                            for (const filename of m.extra.attachments) {
                                try {
                                    const buffer = await fs.readFile(path.join(attachDir, filename));
                                    const ext = path.extname(filename).toLowerCase();
                                    const mime = ext === '.png' ? 'image/png' :
                                        ext === '.webp' ? 'image/webp' :
                                            ext === '.gif' ? 'image/gif' : 'image/jpeg';

                                    attachmentsBase64.push(`data:${mime};base64,${buffer.toString('base64')}`);
                                } catch (err) {
                                    console.warn('[VISION] Ошибка чтения вложения, игнор:', filename);
                                }
                            }
                        }

                        historyMsgs.push({
                            role: m.is_user ? 'user' : 'assistant',
                            content: resolvedContent,
                            name: m.is_user ? historicalUserName : charName,
                            images: attachmentsBase64.length > 0 ? attachmentsBase64 : undefined
                        });
                    }

                    // ВРЕЗАЕМ УЗЛЫ ГЛУБИНЫ (INJECTIONS)
                    let finalHistoryMsgs = [];
                    const totalHist = historyMsgs.length;

                    const maxInjectDepth = depthNodes.length > 0
                        ? Math.max(...depthNodes.map(n => n.injection_depth !== undefined ? n.injection_depth : 0))
                        : 0;

                    const startDepth = Math.max(totalHist > 0 ? totalHist - 1 : 0, maxInjectDepth);

                    for (let currentDepth = startDepth; currentDepth >= 0; currentDepth--) {
                        // 1. Сначала сообщение чата этой глубины
                        const msgIndex = totalHist - 1 - currentDepth;
                        if (msgIndex >= 0 && msgIndex < totalHist) {
                            finalHistoryMsgs.push(historyMsgs[msgIndex]);
                        }

                        // 2. Затем инжекты (ПОСЛЕ сообщения)
                        let currentNodes = depthNodes.filter(n => (n.injection_depth !== undefined ? n.injection_depth : 0) === currentDepth);
                        if (currentNodes.length > 0) {
                            currentNodes.sort((a, b) => {
                                const ordA = a.injection_order !== undefined ? a.injection_order : 100;
                                const ordB = b.injection_order !== undefined ? b.injection_order : 100;
                                return ordA - ordB;
                            });

                            for (const dNode of currentNodes) {
                                let dContent = dNode.text || '';
                                if (dContent) {
                                    finalHistoryMsgs.push({
                                        role: (dNode.role || 'System').toLowerCase(),
                                        content: resolveTemplateVariables(dNode.text || '', {
                                            charName, userName, chat, character, persona, sysConfig, variables: sharedVariables
                                        })
                                    });
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