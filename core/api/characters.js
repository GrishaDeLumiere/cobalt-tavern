// ФАЙЛ: server/api/characters.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {
    const avatarsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters');
    const charsDataDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_data');
    const orderFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_order.json');
    const oldDbFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.json');

    let charactersCache = null;

    const sanitizeFilename = (name) => {
        if (!name) return '';
        return path.basename(String(name).trim()).replace(/[<>:"/\\|?*]/g, '_');
    };

    const ensureFoldersAndMigrate = async () => {
        try { await fs.access(avatarsDir); } catch { await fs.mkdir(avatarsDir, { recursive: true }); }
        try { await fs.access(charsDataDir); } catch { await fs.mkdir(charsDataDir, { recursive: true }); }

        try {
            await fs.access(oldDbFile);
            const data = await fs.readFile(oldDbFile, 'utf8');
            const parsed = JSON.parse(data).characters || [];

            if (parsed.length > 0) {
                console.log(`[CHARACTERS] Найдена старая база characters_db.json (${parsed.length} персов). Разрезаем на модули...`);
                let order = [];
                for (const c of parsed) {
                    const cleanId = c.id || `char_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
                    c.id = cleanId;
                    await fs.writeFile(path.join(charsDataDir, `${cleanId}.json`), JSON.stringify(c, null, 4), 'utf8');
                    order.push(cleanId);
                }
                await fs.writeFile(orderFile, JSON.stringify(order, null, 4), 'utf8');
                console.log(`[CHARACTERS] Успешно создано ${parsed.length} индивидуальных файлов!`);
            }
            await fs.rename(oldDbFile, path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.backup.json'));
        } catch (e) { }
    };

    const getCharactersData = async () => {
        if (charactersCache) return charactersCache;
        await ensureFoldersAndMigrate();

        let order = [];
        try {
            const orderData = await fs.readFile(orderFile, 'utf8');
            order = JSON.parse(orderData);
        } catch (e) {
            order = [];
        }

        let files = [];
        try {
            files = await fs.readdir(charsDataDir);
        } catch (e) {
            files = [];
        }

        const loadedChars = [];
        let needsOrderSave = false;

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const raw = await fs.readFile(path.join(charsDataDir, file), 'utf8');
                const c = JSON.parse(raw);
                if (c && c.id) {
                    loadedChars.push(c);
                    if (!order.includes(c.id)) {
                        order.push(c.id);
                        needsOrderSave = true;
                    }
                }
            } catch (err) {
                console.error(`[CHARACTERS] Ошибка парсинга файла ${file}:`, err.message);
            }
        }

        const orderMap = new Map(order.map((id, index) => [id, index]));
        loadedChars.sort((a, b) => {
            const posA = orderMap.has(a.id) ? orderMap.get(a.id) : 99999;
            const posB = orderMap.has(b.id) ? orderMap.get(b.id) : 99999;
            return posA - posB;
        });

        if (needsOrderSave) {
            await fs.writeFile(orderFile, JSON.stringify(loadedChars.map(c => c.id), null, 4), 'utf8');
        }

        charactersCache = loadedChars;
        return charactersCache;
    };

    // ==========================================
    // ЭНДПОИНТЫ
    // ==========================================

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
        if (!charData || !charData.id) return { success: false, error: 'No ID' };

        await ensureFoldersAndMigrate();
        const chars = await getCharactersData();
        const existingIdx = chars.findIndex(c => c.id === charData.id);

        let finalObj = {};
        if (existingIdx > -1) {
            finalObj = { ...chars[existingIdx], ...charData };
            chars[existingIdx] = finalObj;
        } else {
            finalObj = charData;
            chars.unshift(finalObj);
            await fs.writeFile(orderFile, JSON.stringify(chars.map(c => c.id), null, 4), 'utf8');
        }

        const targetFilePath = path.join(charsDataDir, `${finalObj.id}.json`);
        await fs.writeFile(targetFilePath, JSON.stringify(finalObj, null, 4), 'utf8');

        charactersCache = chars;
        return { success: true };
    });

    fastify.post('/characters/reorder', async (request) => {
        const { order } = request.body;
        if (!order || !Array.isArray(order)) return { success: false };

        const chars = await getCharactersData();
        const orderMap = new Map(order.map((id, index) => [id, index]));
        chars.sort((a, b) => {
            const posA = orderMap.has(a.id) ? orderMap.get(a.id) : 99999;
            const posB = orderMap.has(b.id) ? orderMap.get(b.id) : 99999;
            return posA - posB;
        });

        await fs.writeFile(orderFile, JSON.stringify(order, null, 4), 'utf8');
        charactersCache = chars;
        return { success: true };
    });

    fastify.post('/characters/import_mass', async (request) => {
        const { importedData } = request.body;
        if (!importedData || !Array.isArray(importedData)) return { success: false };

        await ensureFoldersAndMigrate();
        const current = await getCharactersData();
        const idMap = new Map(current.map((c, idx) => [c.id, idx]));
        let isOrderChanged = false;

        for (const newItem of importedData) {
            if (!newItem || !newItem.id) continue;
            let targetObj = newItem;
            if (idMap.has(newItem.id)) {
                const idx = idMap.get(newItem.id);
                targetObj = { ...current[idx], ...newItem };
                current[idx] = targetObj;
            } else {
                current.unshift(targetObj);
                isOrderChanged = true;
            }
            await fs.writeFile(path.join(charsDataDir, `${targetObj.id}.json`), JSON.stringify(targetObj, null, 4), 'utf8');
        }

        if (isOrderChanged) {
            await fs.writeFile(orderFile, JSON.stringify(current.map(c => c.id), null, 4), 'utf8');
        }

        charactersCache = current;
        return { success: true };
    });

    fastify.post('/characters/avatar', async (request, reply) => {
        await ensureFoldersAndMigrate();

        const data = await request.file();
        if (!data) {
            return reply.code(400).send({ success: false, error: 'Файл не передан' });
        }

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

        if (target) {
            if (target.filename) {
                const isAvatarShared = chars.some(c => c.id !== targetId && c.filename === target.filename);
                if (!isAvatarShared) {
                    try { await fs.unlink(path.join(avatarsDir, target.filename)); } catch (e) { }
                }
            }
            try { await fs.unlink(path.join(charsDataDir, `${targetId}.json`)); } catch (e) { }
        }

        const filtered = chars.filter(c => c.id !== targetId);
        await fs.writeFile(orderFile, JSON.stringify(filtered.map(c => c.id), null, 4), 'utf8');
        charactersCache = filtered;
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