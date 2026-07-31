const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const util = require('util');
const pipeline = util.promisify(require('stream').pipeline);
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {

    // GET: Чтение профиля
    fastify.get('/system/settings', async (request, reply) => {
        try {
            const settingsPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'settings.json');
            const data = await fs.readFile(settingsPath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            return reply.code(500).send({ error: 'System config read failed' });
        }
    });

    // POST: Сохранение профиля
    fastify.post('/system/settings', async (request, reply) => {
        try {
            const newSettings = request.body;
            const settingsPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'settings.json');
            await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 4), 'utf-8');
            return { status: 'Aegis Sync Complete', success: true };
        } catch (err) {
            return reply.code(500).send({ error: 'System config write failed' });
        }
    });

    fastify.get('/system/theme_presets', async (request, reply) => {
        try {
            const presetsPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'theme_presets.json');
            try {
                const data = await fs.readFile(presetsPath, 'utf-8');
                return JSON.parse(data);
            } catch (err) {
                if (err.code === 'ENOENT') return [];
                throw err;
            }
        } catch (err) {
            return reply.code(500).send({ error: 'Failed to read theme presets' });
        }
    });

    fastify.post('/system/theme_presets', async (request, reply) => {
        try {
            const presets = request.body;
            const presetsPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'theme_presets.json');
            await fs.writeFile(presetsPath, JSON.stringify(presets, null, 4), 'utf-8');
            return { success: true };
        } catch (err) {
            return reply.code(500).send({ error: 'Failed to save theme presets' });
        }
    });

    // АВАТАР
    fastify.post('/system/avatar', async (request, reply) => {
        try {
            const avatarDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'user_profile');
            try { await fs.access(avatarDir); } catch { await fs.mkdir(avatarDir, { recursive: true }); }

            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No file uploaded' });
            try {
                const oldFiles = await fs.readdir(avatarDir);
                for (const file of oldFiles) await fs.unlink(path.join(avatarDir, file));
            } catch (e) { }

            const ext = path.extname(data.filename) || '.png';
            const safeName = `avatar_${Date.now()}${ext}`;
            const savePath = path.join(avatarDir, safeName);
            await pipeline(data.file, fsSync.createWriteStream(savePath));

            return { status: 'Avatar Uploaded', url: `/data/${DEFAULT_USER}/user_profile/${safeName}` };
        } catch (err) {
            return reply.code(500).send({ error: 'Avatar upload failed' });
        }
    });

    // === ААА АПИ: МЕНЕДЖМЕНТ КАСТОМНЫХ ШРИФТОВ ===
    const getFontsDir = () => path.join(ROOT_DATA_DIR, DEFAULT_USER, 'fonts');

    fastify.get('/system/fonts', async (request, reply) => {
        try {
            const fontsDir = getFontsDir();
            try { await fs.access(fontsDir); } catch { await fs.mkdir(fontsDir, { recursive: true }); }
            const files = await fs.readdir(fontsDir);
            return files.filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f));
        } catch (err) {
            return reply.code(500).send({ error: 'Fonts read failed' });
        }
    });

    fastify.post('/system/fonts', async (request, reply) => {
        try {
            const fontsDir = getFontsDir();
            try { await fs.access(fontsDir); } catch { await fs.mkdir(fontsDir, { recursive: true }); }

            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No file' });

            // Безопасное имя без пробелов
            const safeName = data.filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const savePath = path.join(fontsDir, safeName);
            await pipeline(data.file, fsSync.createWriteStream(savePath));

            return { success: true, filename: safeName };
        } catch (err) {
            return reply.code(500).send({ error: 'Font upload failed' });
        }
    });

    fastify.delete('/system/fonts/:filename', async (request, reply) => {
        try {
            const safeName = path.basename(request.params.filename);
            const fontPath = path.join(getFontsDir(), safeName);
            await fs.unlink(fontPath);
            return { success: true };
        } catch (err) {
            return reply.code(500).send({ error: 'Font delete failed' });
        }
    });

    // GET: Перехватчик фантомных аватарок ST
    fastify.get('/thumbnail', async (req, reply) => {
        const { file } = req.query;
        if (!file) return reply.code(400).send('');
        const safeFile = path.basename(file);
        const avatarsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'avatars');
        const charsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'characters');

        try {
            let buffer;
            try { buffer = await fs.readFile(path.join(avatarsDir, safeFile)); }
            catch { buffer = await fs.readFile(path.join(charsDir, safeFile)); }
            return reply.type('image/png').send(buffer);
        } catch (e) {
            return reply.code(404).send('');
        }
    });
};