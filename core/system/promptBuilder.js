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
        // Сохраняем массив изображений при маппинге
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
                // Если у узлов есть картинки — склеиваем их массивы
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

// --- ГЛАВНАЯ ФУНКЦИЯ СБОРКИ ---
const buildPrompt = async (payload) => {
    // Получаем postProcessing из Payload (приходит из профиля подключения)
    const { chatId, presetId, charId, personaId, sysConfig, postProcessing = 'none' } = payload;

    const chatsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'chats');
    const presetsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'ai_presets');
    const charsDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.json');
    const personasDbPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.json');

    // 1. Читаем всё с диска
    let chat = { messages: [], character_name: 'System', user_name: 'User' };
    if (chatId) {
        try {
            const chatRaw = await fs.readFile(path.join(chatsDir, decodeURIComponent(chatId)), 'utf-8');
            const lines = chatRaw.split('\n').filter(l => l.trim());
            const meta = JSON.parse(lines[0]);
            chat.character_name = meta.character_name;
            chat.user_name = meta.user_name || 'User';
            chat.messages = lines.slice(1).map(l => JSON.parse(l));
        } catch (e) { console.error('[BUILDER] Ошибка чтения чата:', e.message); }
    }

    let preset = null;
    try {
        preset = JSON.parse(await fs.readFile(path.join(presetsDir, `${presetId}.json`), 'utf-8'));
    } catch (e) { throw new Error('Не удалось загрузить AI Preset'); }

    let character = null;
    if (charId) {
        try {
            const charsDb = JSON.parse(await fs.readFile(charsDbPath, 'utf-8'));
            character = charsDb.characters.find(c => c.id === charId);
        } catch (e) { }
    }

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

    // 2. Сканируем ЛОР через Lore Engine
    const lore = await scanLorebooks(
        chat.messages,
        character?.lorebooks || [],
        sysConfig?.activeLorebooks || [],
        sysConfig?.loreConfig || {}
    );

    // 3. Вытаскиваем все активные ноды из пресета
    let allNodes = [];
    preset.categories?.forEach(cat => {
        cat.nodes?.forEach(node => {
            if (node.active) allNodes.push(node);
        });
    });

    const globalNodes = allNodes.filter(n => n.injection_position === 0).sort((a, b) => a.injection_order - b.injection_order);
    let depthNodes = allNodes.filter(n => n.injection_position === 1);
    if (lore.injections && lore.injections.length > 0) {
        depthNodes = depthNodes.concat(lore.injections);
    }
    depthNodes.sort((a, b) => a.injection_order - b.injection_order);

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

                    const openTag = preset?.reasoning_open_tag || '<think>';
                    const closeTag = preset?.reasoning_close_tag || '</think>';
                    const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\@@@CODEBLOCK0@@@amp;');
                    const thinkRegex = new RegExp(`${escapeRegExp(openTag)}[\\s\\S]*?(${escapeRegExp(closeTag)}|$)`, 'gi');

                    // === 1. ИНИЦИАЛИЗИРУЕМ ЛИМИТЫ ОДИН РАЗ ===
                    const VISION_DEPTH_LIMIT = preset?.vision_depth !== undefined ? parseInt(preset.vision_depth, 10) : 5;
                    const totalMsgs = chat.messages.length;

                    // === 2. ЗАПУСКАЕМ АСИНХРОННЫЙ ЦИКЛ ===
                    for (let index = 0; index < totalMsgs; index++) {
                        const m = chat.messages[index];
                        if (m.is_system) continue;

                        if (m.is_user && m.name) {
                            historicalUserName = m.name;
                        }

                        let rawText = m.mes || '';
                        if (!m.is_user && rawText.includes(openTag)) {
                            rawText = rawText.replace(thinkRegex, '').trim();
                        }

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
                    for (const dNode of depthNodes) {
                        const depth = dNode.injection_depth || 0;
                        let insertIndex = historyMsgs.length - depth;
                        if (insertIndex < 0) insertIndex = 0;

                        let dContent = dNode.text || '';

                        if (dContent) {
                            historyMsgs.splice(insertIndex, 0, {
                                role: (dNode.role || 'System').toLowerCase(),
                                content: resolveTemplateVariables(dNode.text || '', {
                                    charName, userName, chat, character, persona, sysConfig, variables: sharedVariables
                                })
                            });
                        }
                    }

                    rawPayload.push(...historyMsgs);
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