// ФАЙЛ: server/api/characters.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {
    const avatarsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters');
    const dbFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters_db.json');

    const ensureDB = async () => {
        try { await fs.access(avatarsDir); } catch { await fs.mkdir(avatarsDir, { recursive: true }); }
        try {
            await fs.access(dbFile);
        } catch {
            await fs.writeFile(dbFile, JSON.stringify({ characters: [] }, null, 4));
        }
    };

    const readDB = async () => {
        await ensureDB();
        const data = await fs.readFile(dbFile, 'utf8');
        return JSON.parse(data).characters || [];
    };

    const writeDB = async (chars) => {
        await fs.writeFile(dbFile, JSON.stringify({ characters: chars }, null, 4));
    };

    fastify.get('/characters', async () => {
        const chars = await readDB();
        return chars.map(c => {
            let actualUrl = '';
            if (c.filename && require('fs').existsSync(path.join(avatarsDir, c.filename))) {
                actualUrl = `/data/${DEFAULT_USER}/characters/${encodeURIComponent(c.filename)}?v=${Date.now()}`;
            }
            return { ...c, avatarUrl: actualUrl };
        });
    });

    fastify.post('/characters/sync', async (request) => {
        const charData = request.body;
        const chars = await readDB();
        const idx = chars.findIndex(c => c.id === charData.id);
        if (idx > -1) chars[idx] = { ...chars[idx], ...charData };
        else chars.push(charData);
        await writeDB(chars);
        return { success: true };
    });

    fastify.post('/characters/reorder', async (request) => {
        const { order } = request.body;
        if (!order || !Array.isArray(order)) return { success: false };
        const chars = await readDB();
        chars.sort((a, b) => {
            let posA = order.indexOf(a.id);
            let posB = order.indexOf(b.id);
            if (posA === -1) posA = 999;
            if (posB === -1) posB = 999;
            return posA - posB;
        });
        await writeDB(chars);
        return { success: true };
    });

    fastify.post('/characters/import_mass', async (request) => {
        const { importedData } = request.body;
        const chars = await readDB();
        importedData.forEach(newItem => chars.push(newItem));
        await writeDB(chars);
        return { success: true };
    });

    fastify.post('/characters/avatar', async (request) => {
        await ensureDB();
        const data = await request.file();
        const requestFilename = data.fields.filename.value;
        const imageBuffer = await data.toBuffer();
        await fs.writeFile(path.join(avatarsDir, requestFilename), imageBuffer);
        return {
            success: true,
            filename: requestFilename,
            avatarUrl: `/data/${DEFAULT_USER}/characters/${encodeURIComponent(requestFilename)}?v=${Date.now()}`
        };
    });

    fastify.delete('/characters/:id', async (request) => {
        const chars = await readDB();
        const target = chars.find(c => c.id === request.params.id);
        if (target && target.filename) {
            try { await fs.unlink(path.join(avatarsDir, target.filename)); } catch (e) { }
        }
        const filtered = chars.filter(c => c.id !== request.params.id);
        await writeDB(filtered);
        return { success: true };
    });

    fastify.get('/characters/attachments/:id', async (request, reply) => {
        const attachDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters', request.params.id, 'attachments');
        try {
            const files = await require('fs/promises').readdir(attachDir);
            return { success: true, files };
        } catch (e) {
            return { success: true, files: [] };
        }
    });

    fastify.delete('/characters/attachments/:id/:filename', async (request, reply) => {
        const attachDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters', request.params.id, 'attachments');
        try {
            await require('fs/promises').unlink(path.join(attachDir, request.params.filename));
            return { success: true };
        } catch (e) {
            return { success: false };
        }
    });

    fastify.post('/characters/copy_avatar', async (request) => {
        const { source, destination } = request.body;
        if (!source || !destination) return { success: false };

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