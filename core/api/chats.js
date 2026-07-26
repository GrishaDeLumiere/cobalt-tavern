// ФАЙЛ: server/routes/chats.js
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const getChatsDir = () => path.join(ROOT_DATA_DIR, DEFAULT_USER, 'chats');

const getSTDateString = () => {
    const d = new Date();
    const pad = (n, m = 2) => String(n).padStart(m, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}h${pad(d.getMinutes())}m${pad(d.getSeconds())}s${pad(d.getMilliseconds(), 3)}ms`;
};

const parseAnyDate = (dateStr) => {
    if (!dateStr) return null;
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
    const humanMatch = dateStr.match(/(\w+)\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})(am|pm)/i);
    if (humanMatch) {
        const months = { 'january': 0, 'february': 1, 'march': 2, 'april': 3, 'may': 4, 'june': 5, 'july': 6, 'august': 7, 'september': 8, 'october': 9, 'november': 10, 'december': 11 };
        let hours = parseInt(humanMatch[4]);
        if (humanMatch[6].toLowerCase() === 'pm' && hours < 12) hours += 12;
        if (humanMatch[6].toLowerCase() === 'am' && hours === 12) hours = 0;
        const month = months[humanMatch[1].toLowerCase()];
        if (month !== undefined) return new Date(parseInt(humanMatch[3]), month, parseInt(humanMatch[2]), hours, parseInt(humanMatch[5]));
    }
    if (typeof dateStr === 'number') {
        d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
    }
    return null;
};

let serverChatsCache = null;

const buildChatsIndex = async () => {
    console.log('[CACHE] Построение индекса сессий...');
    const chatsDir = getChatsDir();
    let chats = [];

    let customTagsRegExps = [];
    try {
        const aiRaw = await fs.readFile(path.join(ROOT_DATA_DIR, DEFAULT_USER, 'ai_settings.json'), 'utf-8');
        const aiData = JSON.parse(aiRaw);
        if (Array.isArray(aiData?.presets)) {
            aiData.presets.forEach(p => {
                if (p.reasoning_open_tag && p.reasoning_open_tag !== '<think>') {
                    const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\@@@CODEBLOCK1@@@amp;');
                    const O = escapeRegExp(p.reasoning_open_tag);
                    const C = p.reasoning_close_tag ? escapeRegExp(p.reasoning_close_tag) : O.replace('<', '</');
                    customTagsRegExps.push(new RegExp(`${O}[\\s\\S]*?(${C}|$)`, 'g'));
                }
            });
        }
    } catch (e) { }

    try {
        const charDirs = await fs.readdir(chatsDir, { withFileTypes: true });
        for (const dirent of charDirs) {
            if (dirent.isDirectory()) {
                const charPath = path.join(chatsDir, dirent.name);
                const files = await fs.readdir(charPath);
                for (const file of files) {
                    if (file.endsWith('.jsonl')) {
                        try {
                            const filePath = path.join(charPath, file);
                            const stat = await fs.stat(filePath);
                            const content = await fs.readFile(filePath, 'utf-8');
                            const lines = content.split('\n').filter(l => l.trim() !== '');

                            if (lines.length > 0) {
                                const meta = JSON.parse(lines[0]);
                                const msgsCount = lines.length - 1;
                                let preview = 'Сессия пуста...';
                                let totalTokens = 0;
                                let chatTimestamp = stat.mtime.getTime();
                                let chatDate = stat.mtime.toLocaleDateString();
                                let botAvatar = null;

                                if (msgsCount > 0) {
                                    const lastMsg = JSON.parse(lines[lines.length - 1]);

                                    let cleanMes = lastMsg.mes || '';
                                    cleanMes = cleanMes.replace(/<(think|thought|reasoning|details|s)>[\s\S]*?(<\/\1>|$)/gi, '');
                                    customTagsRegExps.forEach(rx => {
                                        cleanMes = cleanMes.replace(rx, '');
                                    });
                                    preview = cleanMes.replace(/<[^>]+>/g, '').trim().substring(0, 200) || preview;

                                    let foundDate = parseAnyDate(lastMsg.send_date) || parseAnyDate(lastMsg.gen_finished);
                                    if (!foundDate && lastMsg.swipe_info?.length > 0) {
                                        const lastSwipe = lastMsg.swipe_info[lastMsg.swipe_info.length - 1];
                                        foundDate = parseAnyDate(lastSwipe.send_date) || parseAnyDate(lastSwipe.gen_finished);
                                    }
                                    if (!foundDate) {
                                        for (let i = lines.length - 2; i >= 1; i--) {
                                            try {
                                                const msg = JSON.parse(lines[i]);
                                                foundDate = parseAnyDate(msg.send_date) || parseAnyDate(msg.gen_finished);
                                                if (foundDate) break;
                                            } catch (e) { }
                                        }
                                    }

                                    if (foundDate) {
                                        chatTimestamp = foundDate.getTime();
                                        const dd = String(foundDate.getDate()).padStart(2, '0');
                                        const mm = String(foundDate.getMonth() + 1).padStart(2, '0');
                                        const yyyy = foundDate.getFullYear();
                                        chatDate = `${dd}.${mm}.${yyyy}`;
                                    }

                                    for (let i = 1; i < lines.length; i++) {
                                        try {
                                            const msgParsed = JSON.parse(lines[i]);
                                            totalTokens += (msgParsed.extra?.token_count ?? msgParsed.tokens ?? 0);
                                            if (!msgParsed.is_user && !msgParsed.is_system && msgParsed.force_avatar && !botAvatar) {
                                                botAvatar = msgParsed.force_avatar;
                                            }
                                        } catch (e) { }
                                    }
                                }

                                chats.push({
                                    id: `${dirent.name}/${file}`,
                                    charName: meta.character_name || dirent.name,
                                    character_id: meta.chat_metadata?.character_id || null,
                                    name: meta.chat_metadata?.custom_name || file.replace('.jsonl', ''),
                                    preview: preview,
                                    isPinned: meta.chat_metadata?.isPinned || false,
                                    date: chatDate,
                                    msgs: msgsCount,
                                    tokens: totalTokens,
                                    size: (stat.size / 1024).toFixed(1) + 'KB',
                                    timestamp: chatTimestamp,
                                    bot_avatar: botAvatar,
                                    chat_bg: meta.chat_bg || null // Индексируем фон для визуала
                                });
                            }
                        } catch (e) { }
                    }
                }
            }
        }

        chats.sort((a, b) => {
            if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
            return b.timestamp - a.timestamp;
        });

        serverChatsCache = chats;
        console.log(`[CACHE] Индекс построен. Сессий в памяти: ${chats.length}`);
    } catch (e) {
        console.error('[CACHE] Ошибка построения индекса:', e);
        serverChatsCache = [];
    }
};

module.exports = async function (fastify, opts) {
    fastify.get('/chats', async (req, reply) => {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;

        if (!serverChatsCache) await buildChatsIndex();

        const total = serverChatsCache.length;
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const chunk = serverChatsCache.slice(startIndex, endIndex);

        return { chats: chunk, total, page, limit, hasMore: endIndex < total };
    });

    fastify.get('/chats/log/*', async (req, reply) => {
        const targetPath = decodeURIComponent(req.params['*']);
        const filePath = path.join(getChatsDir(), targetPath);
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n').filter(l => l.trim() !== '');
            if (lines.length === 0) throw new Error('Пустой файл');

            const meta = JSON.parse(lines[0]);

            const messages = lines.slice(1).map(l => {
                const msg = JSON.parse(l);
                if (msg.is_user && msg.force_avatar && msg.force_avatar.includes('/thumbnail')) {
                    delete msg.force_avatar;
                }
                return msg;
            });

            return {
                id: targetPath,
                name: meta.chat_metadata?.custom_name || path.basename(targetPath, '.jsonl'),
                character_name: meta.character_name,
                chat_bg: meta.chat_bg || null,
                chat_metadata: meta.chat_metadata || {},
                messages: messages
            };
        } catch (e) {
            reply.code(404).send({ error: 'Лог отсутствует' });
        }
    });

    fastify.post('/chats', async (req, reply) => {
        const payload = req.body;
        const charName = payload.character_name || 'БЕЗЛИКИЙ ИНСТАНС';
        const userName = payload.user_name || 'USER';

        let targetFolder = payload.character_id ? `${charName}_${payload.character_id}` : charName;
        targetFolder = targetFolder.replace(/[<>:"/\\|?*]/g, '_');

        const charDir = path.join(getChatsDir(), targetFolder);
        await fs.mkdir(charDir, { recursive: true });

        const isBranch = !!payload.messages;
        const fileName = `${charName} - ${isBranch ? 'ВЕТВЬ_' : ''}${getSTDateString()}.jsonl`;
        const filePath = path.join(charDir, fileName);

        const metaLine = JSON.stringify({
            user_name: userName,
            character_name: charName,
            chat_bg: payload.chat_bg || null,
            chat_metadata: {
                custom_name: fileName.replace('.jsonl', ''),
                isPinned: false,
                character_id: payload.character_id
            }
        });

        let fileContent = metaLine + '\n';

        if (payload.messages && payload.messages.length > 0) {
            fileContent += payload.messages.map(m => JSON.stringify(m)).join('\n') + '\n';
        } else if (payload.first_mes_swipes && payload.first_mes_swipes.length > 0) {
            const firstMsg = {
                name: charName,
                is_user: false,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: payload.first_mes_swipes[0],
                swipes: payload.first_mes_swipes,
                swipe_id: 0,
                extra: {},
                force_avatar: payload.avatar_url || undefined
            };
            fileContent += JSON.stringify(firstMsg) + '\n';
        }

        await fs.writeFile(filePath, fileContent, 'utf-8');
        serverChatsCache = null;
        return { success: true, id: `${targetFolder}/${fileName}` };
    });

    fastify.put('/chats/log/*', async (req, reply) => {
        const targetPath = decodeURIComponent(req.params['*']);
        const filePath = path.join(getChatsDir(), targetPath);
        const payload = req.body;

        try {
            const metaLine = JSON.stringify({
                user_name: payload.user_name || "USER",
                character_name: payload.character_name,
                chat_bg: payload.chat_bg || null,
                chat_metadata: payload.chat_metadata || {}
            });
            const msgLines = payload.messages?.map(m => JSON.stringify(m)).join('\n') || '';
            await fs.writeFile(filePath, msgLines ? `${metaLine}\n${msgLines}\n` : `${metaLine}\n`, 'utf-8');
            serverChatsCache = null;
            return { success: true };
        } catch (e) {
            reply.code(500).send({ error: 'Ошибка записи лога' });
        }
    });

    fastify.patch('/chats/meta/*', async (req, reply) => {
        const targetPath = decodeURIComponent(req.params['*']);
        const oldFilePath = path.join(getChatsDir(), targetPath);
        const { isPinned, custom_name, character_id, character_name, chat_bg } = req.body;

        try {
            const content = await fs.readFile(oldFilePath, 'utf-8');
            const lines = content.split('\n');
            if (lines.length === 0 || !lines[0]) throw new Error('Файл поврежден');

            const meta = JSON.parse(lines[0]);
            if (!meta.chat_metadata) meta.chat_metadata = {};

            if (isPinned !== undefined) meta.chat_metadata.isPinned = isPinned;
            if (custom_name !== undefined) meta.chat_metadata.custom_name = custom_name;
            if (character_name !== undefined) meta.character_name = character_name;

            if (chat_bg !== undefined) meta.chat_bg = chat_bg;

            let needsMove = false;
            let newRelativePath = targetPath;

            if (character_id !== undefined && meta.chat_metadata.character_id !== character_id) {
                meta.chat_metadata.character_id = character_id;
                needsMove = true;
            }

            lines[0] = JSON.stringify(meta);

            if (needsMove) {
                const charName = meta.character_name || 'БЕЗЛИКИЙ ИНСТАНС';
                const cleanFolderName = `${charName}_${character_id}`.replace(/[<>:"/\\|?*]/g, '_');
                const newFolderPath = path.join(getChatsDir(), cleanFolderName);

                await fs.mkdir(newFolderPath, { recursive: true });

                const fileName = path.basename(oldFilePath);
                const newFilePath = path.join(newFolderPath, fileName);

                await fs.writeFile(newFilePath, lines.join('\n'), 'utf-8');
                await fs.unlink(oldFilePath);

                newRelativePath = `${cleanFolderName}/${fileName}`;
                try {
                    const oldDir = path.dirname(oldFilePath);
                    const remainingFiles = await fs.readdir(oldDir);
                    if (remainingFiles.length === 0) await fs.rmdir(oldDir);
                } catch (cleanupError) { }
            } else {
                await fs.writeFile(oldFilePath, lines.join('\n'), 'utf-8');
            }

            serverChatsCache = null;
            return { success: true, newId: newRelativePath };
        } catch (e) {
            console.error('[PATCH META ERROR]:', e);
            reply.code(500).send({ error: 'Ошибка записи метаданных' });
        }
    });

    fastify.delete('/chats/log/*', async (req, reply) => {
        const targetPath = decodeURIComponent(req.params['*']);
        const filePath = path.join(getChatsDir(), targetPath);

        try {
            await fs.unlink(filePath);
            try {
                const dirPath = path.dirname(filePath);
                const remainingFiles = await fs.readdir(dirPath);
                if (remainingFiles.length === 0) await fs.rmdir(dirPath);
            } catch (cleanupError) { }

            serverChatsCache = null;
            return { success: true };
        } catch (e) {
            if (e.code === 'ENOENT') return { success: true };
            reply.code(500).send({ error: 'Файл заблокирован', details: e.message });
        }
    });

    fastify.post('/chats/delete_mass', async (req, reply) => {
        const { ids } = req.body;
        if (!ids || !Array.isArray(ids)) return { success: false };

        let successCount = 0;
        for (const id of ids) {
            const targetPath = decodeURIComponent(id);
            const filePath = path.join(getChatsDir(), targetPath);
            try {
                await fs.unlink(filePath);
                try {
                    const dirPath = path.dirname(filePath);
                    const remainingFiles = await fs.readdir(dirPath);
                    if (remainingFiles.length === 0) await fs.rmdir(dirPath);
                } catch (e) { }
                successCount++;
            } catch (e) { }
        }

        serverChatsCache = null;
        return { success: true, count: successCount };
    });

    fastify.post('/chats/import_st_mass', async (req, reply) => {
        const { chats } = req.body;
        let successCount = 0;

        for (const chat of chats) {
            try {
                const charDir = path.join(getChatsDir(), chat.character_name);
                await fs.mkdir(charDir, { recursive: true });

                const baseName = chat.filename.replace('.jsonl', '');
                const safeName = baseName.replace(/[<>:"/\\|?*]/g, '_');
                const newFileName = `${safeName}_ST_Import_${Math.floor(Math.random() * 10000)}.jsonl`;

                const filePath = path.join(charDir, newFileName);
                await fs.writeFile(filePath, chat.content, 'utf-8');
                successCount++;
            } catch (e) { }
        }

        serverChatsCache = null;
        return { success: true, count: successCount };
    });

    fastify.post('/chats/attachments/:charId', async (request, reply) => {
        const charId = request.params.charId;
        const attachDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters', charId, 'attachments');

        try { await fs.access(attachDir); } catch { await fs.mkdir(attachDir, { recursive: true }); }

        const files = request.files();
        const savedFilenames = [];

        for await (const part of files) {
            const buffer = await part.toBuffer();

            let ext = path.extname(part.filename);
            if (!ext) ext = part.mimetype.startsWith('image/') ? '.png' : '.bin';

            const safeName = crypto.randomBytes(8).toString('hex') + '_' + Date.now() + ext;
            const fullPath = path.join(attachDir, safeName);

            await fs.writeFile(fullPath, buffer);
            savedFilenames.push(safeName);
            console.log(`[ВЛОЖЕНИЕ ПЕРСА ${charId}] -> СОХРАНЕНО: ${safeName}`);
        }

        return { success: true, filenames: savedFilenames };
    });
};