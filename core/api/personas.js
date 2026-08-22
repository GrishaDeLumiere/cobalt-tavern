// ФАЙЛ: server/api/personas.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {
    const avatarsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'avatars');
    const dbFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.json');

    // Кэш в ОЗУ для мгновенного ответа
    let personasCache = null;

    // Безопасное получение имени файла (защита от ../ Path Traversal)
    const sanitizeFilename = (name) => {
        if (!name) return '';
        return path.basename(String(name).trim()).replace(/[<>:"/\\|?*]/g, '_');
    };

    const ensureDB = async () => {
        try { await fs.access(avatarsDir); } catch { await fs.mkdir(avatarsDir, { recursive: true }); }
        try {
            await fs.access(dbFile);
        } catch {
            await fs.writeFile(dbFile, JSON.stringify({ personas: [] }, null, 4), 'utf8');
        }
    };

    // Исцеление базы (запускается при первом старте или изменениях)
    const healPersonas = async (personas) => {
        let dbChanged = false;
        let diskFiles = [];
        try { diskFiles = await fs.readdir(avatarsDir); } catch (e) { diskFiles = []; }
        const diskFilesSet = new Set(diskFiles);

        for (let i = 0; i < personas.length; i++) {
            let p = personas[i];
            if (!p.filename) continue;

            if (p.filename.includes('-.png') || p.filename === '.png') {
                const saneName = (p.name || 'Unknown').replace(/[^a-zA-Z0-9а-яА-ЯёЁ]/g, '');
                const cleanId = String(p.id).split('_').pop();
                const newFilename = `avatar_${saneName}_${cleanId}.png`.replace(/\s+/g, '_');

                if (diskFilesSet.has(p.filename)) {
                    const oldPath = path.join(avatarsDir, p.filename);
                    const newPath = path.join(avatarsDir, newFilename);
                    try {
                        await fs.rename(oldPath, newPath);
                        diskFilesSet.delete(p.filename);
                        diskFilesSet.add(newFilename);
                        p.filename = newFilename;
                        dbChanged = true;
                    } catch (err) {
                        console.error('[HEALER] Ошибка переименования файла:', err);
                    }
                } else {
                    p.filename = '';
                    dbChanged = true;
                }
            } else if (!diskFilesSet.has(p.filename)) {
                p.filename = '';
                dbChanged = true;
            }
        }

        if (dbChanged) {
            console.log('[HEALER] База Персон: Обнаружены и исправлены кривые импорты!');
            await fs.writeFile(dbFile, JSON.stringify({ personas }, null, 4), 'utf8');
        }

        return personas;
    };

    const getPersonasData = async () => {
        if (personasCache) return personasCache;

        await ensureDB();
        try {
            const data = await fs.readFile(dbFile, 'utf8');
            let parsed = JSON.parse(data).personas || [];
            personasCache = await healPersonas(parsed);
            return personasCache;
        } catch (e) {
            console.error('[PERSONAS DB] Сбой чтения базы:', e);
            personasCache = [];
            return [];
        }
    };

    const savePersonasData = async (personasArray) => {
        personasCache = personasArray;
        await fs.writeFile(dbFile, JSON.stringify({ personas: personasArray }, null, 4), 'utf8');
    };

    // ==========================================
    // ЭНДПОИНТЫ
    // ==========================================

    // Быстрая раздача из памяти (0 мс)
    fastify.get('/personas', async (request, reply) => {
        const personas = await getPersonasData();

        return personas.map(p => ({
            ...p,
            avatarUrl: p.filename && p.filename.trim() !== ''
                ? `/data/${DEFAULT_USER}/avatars/${encodeURIComponent(p.filename)}`
                : ''
        }));
    });

    fastify.post('/personas/sync', async (request, reply) => {
        const personaData = request.body;
        if (!personaData || !personaData.id) return { success: false };

        const personas = await getPersonasData();
        const existingIdx = personas.findIndex(p => p.id === personaData.id);

        if (existingIdx > -1) {
            personas[existingIdx] = { ...personas[existingIdx], ...personaData };
        } else {
            personas.push(personaData);
        }

        await savePersonasData(personas);
        return { success: true };
    });

    fastify.post('/personas/reorder', async (request, reply) => {
        const { order } = request.body;
        if (!order || !Array.isArray(order)) return { success: false };

        const personas = await getPersonasData();

        // Быстрая карта порядка O(1)
        const orderMap = new Map(order.map((id, index) => [id, index]));

        personas.sort((a, b) => {
            const posA = orderMap.has(a.id) ? orderMap.get(a.id) : 999;
            const posB = orderMap.has(b.id) ? orderMap.get(b.id) : 999;
            return posA - posB;
        });

        await savePersonasData(personas);
        return { success: true };
    });

    fastify.post('/personas/import_mass', async (request, reply) => {
        const { importedData } = request.body;
        if (!importedData || !Array.isArray(importedData)) return { success: false };

        const current = await getPersonasData();
        const filenameMap = new Map(current.map((p, idx) => [p.filename, idx]));

        importedData.forEach(newItem => {
            if (newItem.filename && filenameMap.has(newItem.filename)) {
                const idx = filenameMap.get(newItem.filename);
                current[idx] = { ...current[idx], ...newItem };
            } else {
                current.push(newItem);
            }
        });

        personasCache = await healPersonas(current);
        await savePersonasData(personasCache);
        return { success: true };
    });

    fastify.post('/personas/avatar', async (request, reply) => {
        await ensureDB();

        const data = await request.file();
        if (!data) {
            return reply.code(400).send({ success: false, error: 'Файл не передан' });
        }

        // Безопасное извлечение имени файла без краша
        let requestFilename = data.fields?.filename?.value || data.filename || '';
        requestFilename = sanitizeFilename(requestFilename);

        const imageBuffer = await data.toBuffer();

        if (!requestFilename || requestFilename.includes('-.png') || requestFilename === '.png') {
            requestFilename = `avatar_upload_${Date.now()}.png`;
        }

        await fs.writeFile(path.join(avatarsDir, requestFilename), imageBuffer);

        return {
            success: true,
            filename: requestFilename,
            avatarUrl: `/data/${DEFAULT_USER}/avatars/${encodeURIComponent(requestFilename)}?v=${Date.now()}`
        };
    });

    fastify.delete('/personas/:id', async (request, reply) => {
        const targetId = request.params.id;
        const personas = await getPersonasData();
        const target = personas.find(p => p.id === targetId);

        if (target && target.filename) {
            // ПРОВЕРКА: Удаляем файл с диска ТОЛЬКО если эта аватарка не используется другой персоной
            const isAvatarShared = personas.some(p => p.id !== targetId && p.filename === target.filename);

            if (!isAvatarShared) {
                try {
                    await fs.unlink(path.join(avatarsDir, target.filename));
                } catch (e) { }
            }
        }

        const filtered = personas.filter(p => p.id !== targetId);
        await savePersonasData(filtered);
        return { success: true };
    });

    fastify.post('/personas/copy_avatar', async (request, reply) => {
        let { source, destination } = request.body || {};

        // Санитизация путей
        source = sanitizeFilename(source);
        destination = sanitizeFilename(destination);

        if (!source || !destination) {
            return { success: false, error: 'Некорректные имена файлов' };
        }

        const sourcePath = path.join(avatarsDir, source);
        const destPath = path.join(avatarsDir, destination);

        try {
            await fs.access(sourcePath);
            await fs.copyFile(sourcePath, destPath);
            return {
                success: true,
                avatarUrl: `/data/${DEFAULT_USER}/avatars/${encodeURIComponent(destination)}?v=${Date.now()}`
            };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });
};