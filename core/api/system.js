// ФАЙЛ: server/api/system.js
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const defaultSettings = {
    userName: 'USER',
    theme: {
        bgDim: 85,
        bgBloom: 10,
        bgFitting: 'cover',
        accentColor: '#00ffcc',
        fontFamily: 'monospace'
    }
};

const MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
};

module.exports = async function (fastify, opts) {
    const userDir = path.join(ROOT_DATA_DIR, DEFAULT_USER);
    const settingsPath = path.join(userDir, 'settings.json');
    const presetsPath = path.join(userDir, 'theme_presets.json');
    const regexPath = path.join(userDir, 'regex_rules.json');
    const fontsDir = path.join(userDir, 'fonts');
    const avatarDir = path.join(userDir, 'user_profile');

    // Кэш настроек в памяти
    let settingsCache = null;
    let themePresetsCache = null;
    let regexRulesCache = null;

    const ensureUserDirs = async () => {
        try { await fs.access(userDir); } catch { await fs.mkdir(userDir, { recursive: true }); }
        try { await fs.access(fontsDir); } catch { await fs.mkdir(fontsDir, { recursive: true }); }
        try { await fs.access(avatarDir); } catch { await fs.mkdir(avatarDir, { recursive: true }); }
    };

    // === GET: Чтение профиля (Защита от 500 ошибки краша) ===
    fastify.get('/system/settings', async (request, reply) => {
        if (settingsCache) return settingsCache;
        await ensureUserDirs();
        try {
            const data = await fs.readFile(settingsPath, 'utf-8');
            settingsCache = JSON.parse(data);
            return settingsCache;
        } catch (err) {
            // Если файла нет или он поврежден — возвращаем дефолт, спасая систему от краша
            settingsCache = defaultSettings;
            return defaultSettings;
        }
    });

    // === POST: Сохранение профиля ===
    fastify.post('/system/settings', async (request, reply) => {
        await ensureUserDirs();
        try {
            const newSettings = request.body || defaultSettings;
            settingsCache = newSettings;
            await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 4), 'utf-8');
            return { status: 'Aegis Sync Complete', success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи settings.json:', err);
            return reply.code(500).send({ error: 'System config write failed' });
        }
    });

    // === ПРЕСЕТЫ ТЕМ ===
    fastify.get('/system/theme_presets', async (request, reply) => {
        if (themePresetsCache) return themePresetsCache;
        await ensureUserDirs();
        try {
            const data = await fs.readFile(presetsPath, 'utf-8');
            themePresetsCache = JSON.parse(data);
            return themePresetsCache;
        } catch (err) {
            themePresetsCache = [];
            return [];
        }
    });

    fastify.post('/system/theme_presets', async (request, reply) => {
        await ensureUserDirs();
        try {
            const presets = request.body || [];
            themePresetsCache = presets;
            await fs.writeFile(presetsPath, JSON.stringify(presets, null, 4), 'utf-8');
            return { success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи theme_presets.json:', err);
            return reply.code(500).send({ error: 'Failed to save theme presets' });
        }
    });

    // === АВАТАР ПОЛЬЗОВАТЕЛЯ ===
    fastify.post('/system/avatar', async (request, reply) => {
        try {
            await ensureUserDirs();

            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No file uploaded' });

            // Параллельное удаление старых аватарок
            try {
                const oldFiles = await fs.readdir(avatarDir);
                await Promise.all(oldFiles.map(file => fs.unlink(path.join(avatarDir, file))));
            } catch (e) { }

            let ext = path.extname(data.filename || '').toLowerCase();
            if (!ext || ext.length > 5) ext = '.png';

            const safeName = `avatar_${Date.now()}${ext}`;
            const savePath = path.join(avatarDir, safeName);

            await pipeline(data.file, fsSync.createWriteStream(savePath));

            return { status: 'Avatar Uploaded', url: `/data/${DEFAULT_USER}/user_profile/${safeName}?v=${Date.now()}` };
        } catch (err) {
            fastify.log.error('Ошибка загрузки аватара пользователя:', err);
            return reply.code(500).send({ error: 'Avatar upload failed' });
        }
    });

    // === ИЗОЛИРОВАННАЯ БАЗА REGEX ПРАВИЛ (regex_rules.json) ===
    fastify.get('/system/regex', async (request, reply) => {
        if (regexRulesCache) return regexRulesCache;
        await ensureUserDirs();
        try {
            const data = await fs.readFile(regexPath, 'utf-8');
            regexRulesCache = JSON.parse(data);
            return regexRulesCache;
        } catch (err) {
            regexRulesCache = [];
            return [];
        }
    });

    fastify.post('/system/regex', async (request, reply) => {
        await ensureUserDirs();
        try {
            const rules = request.body || [];
            regexRulesCache = rules;
            await fs.writeFile(regexPath, JSON.stringify(rules, null, 4), 'utf-8');
            return { success: true, count: rules.length };
        } catch (err) {
            fastify.log.error('Ошибка записи regex_rules.json:', err);
            return reply.code(500).send({ error: 'Failed to save regex rules' });
        }
    });

    // === КАСТОМНЫЕ ШРИФТЫ ===
    fastify.get('/system/fonts', async (request, reply) => {
        try {
            await ensureUserDirs();
            const files = await fs.readdir(fontsDir);
            return files.filter(f => /\.(ttf|otf|woff|woff2)$/i.test(f));
        } catch (err) {
            return [];
        }
    });

    fastify.post('/system/fonts', async (request, reply) => {
        try {
            await ensureUserDirs();

            const data = await request.file();
            if (!data) return reply.code(400).send({ error: 'No file' });

            const ext = path.extname(data.filename || '').toLowerCase();
            // Валидация: разрешаем загрузку ТОЛЬКО шрифтов
            if (!['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) {
                return reply.code(400).send({ error: 'Invalid font format. Only TTF, OTF, WOFF, WOFF2 allowed.' });
            }

            const rawBase = path.basename(data.filename, ext).replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const safeName = `${rawBase}${ext}`;
            const savePath = path.join(fontsDir, safeName);

            await pipeline(data.file, fsSync.createWriteStream(savePath));

            return { success: true, filename: safeName };
        } catch (err) {
            fastify.log.error('Ошибка сохранения шрифта:', err);
            return reply.code(500).send({ error: 'Font upload failed' });
        }
    });

    fastify.delete('/system/fonts/:filename', async (request, reply) => {
        try {
            const safeName = path.basename(request.params.filename || '');
            if (!safeName) return reply.code(400).send({ error: 'Invalid font name' });

            const fontPath = path.join(fontsDir, safeName);
            await fs.unlink(fontPath);
            return { success: true };
        } catch (err) {
            if (err.code === 'ENOENT') return { success: true };
            return reply.code(500).send({ error: 'Font delete failed' });
        }
    });

    // === ПЕРЕХВАТЧИК ФАНТОМНЫХ АВАТАРОК ST (С динамическим MIME-типом) ===
    fastify.get('/thumbnail', async (req, reply) => {
        const { file } = req.query;
        if (!file) return reply.code(400).send('');

        const safeFile = path.basename(file);
        const avatarsDir = path.join(userDir, 'avatars');
        const charsDir = path.join(userDir, 'characters');

        try {
            let buffer;
            try {
                buffer = await fs.readFile(path.join(avatarsDir, safeFile));
            } catch {
                buffer = await fs.readFile(path.join(charsDir, safeFile));
            }

            const ext = path.extname(safeFile).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'image/png';

            return reply.type(contentType).send(buffer);
        } catch (e) {
            return reply.code(404).send('');
        }
    });
};