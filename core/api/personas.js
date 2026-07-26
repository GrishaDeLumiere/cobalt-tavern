// ФАЙЛ: server/api/personas.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {
    const avatarsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'avatars');
    const dbFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.json');

    const ensureDB = async () => {
        try { await fs.access(avatarsDir); } catch { await fs.mkdir(avatarsDir, { recursive: true }); }
        try { await fs.access(dbFile); } catch { await fs.writeFile(dbFile, JSON.stringify({ personas: [] }, null, 4)); }
    };

    const readDB = async () => {
        await ensureDB();
        const data = await fs.readFile(dbFile, 'utf8');
        return JSON.parse(data).personas || [];
    };

    const writeDB = async (personasArray) => {
        await fs.writeFile(dbFile, JSON.stringify({ personas: personasArray }, null, 4));
    };

    // Главный эндпоинт загрузки + ДЕМОН ИСЦЕЛЕНИЯ
    fastify.get('/personas', async (request, reply) => {
        let personas = await readDB();
        let dbChanged = false;

        let diskFiles = [];
        try { diskFiles = await fs.readdir(avatarsDir); } catch (e) { diskFiles = []; }
        const diskFilesSet = new Set(diskFiles);

        for (let i = 0; i < personas.length; i++) {
            let p = personas[i];

            if (!p.filename) continue;

            if (p.filename.includes('-.png') || p.filename === '.png') {
                const saneName = (p.name || 'Unknown').replace(/[^a-zA-Z0-9а-яА-ЯёЁ]/g, '');
                const cleanId = p.id.split('_').pop();
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
            await writeDB(personas);
        }

        const mapped = personas.map(p => ({
            ...p,
            avatarUrl: p.filename && p.filename.trim() !== ''
                ? `/data/${DEFAULT_USER}/avatars/${encodeURIComponent(p.filename)}`
                : ''
        }));

        return mapped;
    });

    fastify.post('/personas/sync', async (request, reply) => {
        const { id, filename, name, tag, text } = request.body;
        const personas = await readDB();

        const existingIdx = personas.findIndex(p => p.id === id);
        if (existingIdx > -1) {
            personas[existingIdx] = { ...personas[existingIdx], filename, name, tag, text };
        } else {
            personas.push({ id, filename, name, tag, text });
        }

        await writeDB(personas);
        return { success: true };
    });

    fastify.post('/personas/reorder', async (request, reply) => {
        const { order } = request.body;
        if (!order || !Array.isArray(order)) return { success: false };
        const personas = await readDB();

        personas.sort((a, b) => {
            let posA = order.indexOf(a.id);
            let posB = order.indexOf(b.id);
            if (posA === -1) posA = 999;
            if (posB === -1) posB = 999;
            return posA - posB;
        });

        await writeDB(personas);
        return { success: true };
    });

    fastify.post('/personas/import_mass', async (request, reply) => {
        const { importedData } = request.body;
        if (!importedData || !Array.isArray(importedData)) return { success: false };
        const current = await readDB();

        importedData.forEach(newItem => {
            const idx = current.findIndex(c => c.filename === newItem.filename && newItem.filename !== '');
            if (idx > -1) current[idx] = { ...current[idx], ...newItem };
            else current.push(newItem);
        });

        await writeDB(current);
        return { success: true };
    });

    fastify.post('/personas/avatar', async (request, reply) => {
        await ensureDB();

        const data = await request.file();
        let requestFilename = data.fields.filename.value;
        const imageBuffer = await data.toBuffer();
        if (requestFilename.includes('-.png') || requestFilename.trim() === '') {
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
        const personas = await readDB();
        const target = personas.find(p => p.id === request.params.id);

        if (target && target.filename) {
            try { await fs.unlink(path.join(avatarsDir, target.filename)); } catch (e) { }
        }

        const filtered = personas.filter(p => p.id !== request.params.id);
        await writeDB(filtered);
        return { success: true };
    });
};