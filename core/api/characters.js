// ФАЙЛ: server/api/characters.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {
    const avatarsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters');
    const dbFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.json');

    // Кэш в ОЗУ для мгновенного ответа
    let charactersCache = null;

    // Безопасное имя файла (защита от Path Traversal ../)
    const sanitizeFilename = (name) => {
        if (!name) return '';
        return path.basename(String(name).trim()).replace(/[<>:"/\\|?*]/g, '_');
    };

    const ensureDB = async () => {
        try { await fs.access(avatarsDir); } catch { await fs.mkdir(avatarsDir, { recursive: true }); }
        try {
            await fs.access(dbFile);
        } catch {
            await fs.writeFile(dbFile, JSON.stringify({ characters: [] }, null, 4), 'utf8');
        }
    };

    const getCharactersData = async () => {
        if (charactersCache) return charactersCache;

        await ensureDB();
        try {
            const data = await fs.readFile(dbFile, 'utf8');
            charactersCache = JSON.parse(data).characters || [];
            return charactersCache;
        } catch (e) {
            console.error('[CHARACTERS DB] Сбой чтения базы:', e);
            charactersCache = [];
            return [];
        }
    };

    const saveCharactersData = async (charsArray) => {
        charactersCache = charsArray;
        await fs.writeFile(dbFile, JSON.stringify({ characters: charsArray }, null, 4), 'utf8');
    };

    // ==========================================
    // ЭНДПОИНТЫ
    // ==========================================

    // Быстрая асинхронная отдача списка (без блокирующего existsSync)
    fastify.get('/characters', async () => {
        const chars = await getCharactersData();

        let diskFiles = [];
        try {
            diskFiles = await fs.readdir(avatarsDir);
        } catch (e) {
            diskFiles = [];
        }
        const diskFilesSet = new Set(diskFiles);

        return chars.map(c => {
            const hasAvatar = c.filename && diskFilesSet.has(c.filename);
            const actualUrl = hasAvatar
                ? `/data/${DEFAULT_USER}/characters/${encodeURIComponent(c.filename)}?v=${Date.now()}`
                : '';

            return { ...c, avatarUrl: actualUrl };
        });
    });

    fastify.post('/characters/sync', async (request) => {
        const charData = request.body;
        if (!charData || !charData.id) return { success: false };

        const chars = await getCharactersData();
        const idx = chars.findIndex(c => c.id === charData.id);

        if (idx > -1) {
            chars[idx] = { ...chars[idx], ...charData };
        } else {
            chars.push(charData);
        }

        await saveCharactersData(chars);
        return { success: true };
    });

    fastify.post('/characters/reorder', async (request) => {
        const { order } = request.body;
        if (!order || !Array.isArray(order)) return { success: false };

        const chars = await getCharactersData();

        // Быстрая карта сортировки O(1)
        const orderMap = new Map(order.map((id, index) => [id, index]));

        chars.sort((a, b) => {
            const posA = orderMap.has(a.id) ? orderMap.get(a.id) : 999;
            const posB = orderMap.has(b.id) ? orderMap.get(b.id) : 999;
            return posA - posB;
        });

        await saveCharactersData(chars);
        return { success: true };
    });

    fastify.post('/characters/import_mass', async (request) => {
        const { importedData } = request.body;
        if (!importedData || !Array.isArray(importedData)) return { success: false };

        const chars = await getCharactersData();
        const idMap = new Map(chars.map((c, idx) => [c.id, idx]));

        importedData.forEach(newItem => {
            if (newItem.id && idMap.has(newItem.id)) {
                const idx = idMap.get(newItem.id);
                chars[idx] = { ...chars[idx], ...newItem };
            } else {
                chars.push(newItem);
            }
        });

        await saveCharactersData(chars);
        return { success: true };
    });

    fastify.post('/characters/avatar', async (request, reply) => {
        await ensureDB();

        const data = await request.file();
        if (!data) {
            return reply.code(400).send({ success: false, error: 'Файл не передан' });
        }

        // Безопасное извлечение имени
        let requestFilename = data.fields?.filename?.value || data.filename || '';
        requestFilename = sanitizeFilename(requestFilename);

        if (!requestFilename) {
            requestFilename = `char_avatar_${Date.now()}.png`;
        }

        const imageBuffer = await data.toBuffer();
        await fs.writeFile(path.join(avatarsDir, requestFilename), imageBuffer);

        return {
            success: true,
            filename: requestFilename,
            avatarUrl: `/data/${DEFAULT_USER}/characters/${encodeURIComponent(requestFilename)}?v=${Date.now()}`
        };
    });

    fastify.delete('/characters/:id', async (request) => {
        const targetId = request.params.id;
        const chars = await getCharactersData();
        const target = chars.find(c => c.id === targetId);

        if (target && target.filename) {
            // Удаляем файл ТОЛЬКО если он не используется другими персонажами
            const isAvatarShared = chars.some(c => c.id !== targetId && c.filename === target.filename);
            if (!isAvatarShared) {
                try {
                    await fs.unlink(path.join(avatarsDir, target.filename));
                } catch (e) { }
            }
        }

        const filtered = chars.filter(c => c.id !== targetId);
        await saveCharactersData(filtered);
        return { success: true };
    });

    fastify.get('/characters/attachments/:id', async (request) => {
        const charId = sanitizeFilename(request.params.id);
        const attachDir = path.join(avatarsDir, charId, 'attachments');
        try {
            const files = await fs.readdir(attachDir);
            return { success: true, files };
        } catch (e) {
            return { success: true, files: [] };
        }
    });

    fastify.delete('/characters/attachments/:id/:filename', async (request) => {
        const charId = sanitizeFilename(request.params.id);
        const filename = sanitizeFilename(request.params.filename);

        if (!charId || !filename) return { success: false };

        const attachDir = path.join(avatarsDir, charId, 'attachments');
        try {
            await fs.unlink(path.join(attachDir, filename));
            return { success: true };
        } catch (e) {
            return { success: false };
        }
    });

    fastify.post('/characters/copy_avatar', async (request) => {
        let { source, destination } = request.body || {};
        source = sanitizeFilename(source);
        destination = sanitizeFilename(destination);

        if (!source || !destination) return { success: false, error: 'Некорректные имена файлов' };

        const sourcePath = path.join(avatarsDir, source);
        const destPath = path.join(avatarsDir, destination);

        try {
            await fs.access(sourcePath);
            await fs.copyFile(sourcePath, destPath);
            return {
                success: true,
                avatarUrl: `/data/${DEFAULT_USER}/characters/${encodeURIComponent(destination)}?v=${Date.now()}`
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
};