// ФАЙЛ: server/api/backgrounds.js
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const defaultManifest = {
    folders: [],
    backgrounds: []
};

module.exports = async function (fastify, opts) {
    const bgDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'backgrounds');
    const manifestPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'backgrounds.json');

    // Кэш манифеста в оперативной памяти
    let manifestCache = null;

    const ensureStorage = async () => {
        try { await fs.access(bgDir); } catch { await fs.mkdir(bgDir, { recursive: true }); }
        try {
            await fs.access(manifestPath);
        } catch {
            await fs.writeFile(manifestPath, JSON.stringify(defaultManifest, null, 4), 'utf-8');
        }
    };

    const getManifest = async () => {
        if (manifestCache) return manifestCache;
        await ensureStorage();
        try {
            const data = await fs.readFile(manifestPath, 'utf-8');
            manifestCache = JSON.parse(data);
            return manifestCache;
        } catch (err) {
            manifestCache = defaultManifest;
            return defaultManifest;
        }
    };

    // === GET: Получить всю базу фонов (Мгновенно из памяти) ===
    fastify.get('/backgrounds/manifest', async (request, reply) => {
        return await getManifest();
    });

    // === POST: Сохранить новое состояние (Drag&Drop, Переименование) ===
    fastify.post('/backgrounds/manifest', async (request, reply) => {
        try {
            const newState = request.body || defaultManifest;
            manifestCache = newState;
            await fs.writeFile(manifestPath, JSON.stringify(newState, null, 4), 'utf-8');
            return { status: 'Backgrounds Synced', success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи backgrounds.json:', err);
            return reply.code(500).send({ error: 'Manifest write failed' });
        }
    });

    // === POST: Безопасная загрузка файлов фонов со стримингом ===
    fastify.post('/backgrounds/upload', async (request, reply) => {
        await ensureStorage(); // Гарантирует наличие папки backgrounds перед записью

        const parts = request.files();
        const uploadedFiles = [];

        for await (const part of parts) {
            const bgId = `bg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

            // Безопасное извлечение расширения
            let ext = path.extname(part.filename || '').toLowerCase();
            if (!ext || ext.length > 5) ext = '.jpg';

            const safeName = `${bgId}${ext}`;
            const savePath = path.join(bgDir, safeName);

            // Асинхронный пайплайн стрима прямо на диск
            await pipeline(part.file, fsSync.createWriteStream(savePath));

            uploadedFiles.push({
                id: bgId,
                name: path.basename(part.filename || 'Background'),
                filename: safeName,
                url: `/data/${DEFAULT_USER}/backgrounds/${safeName}`,
                active: false,
                folderId: null,
                color: '#1a1a24'
            });
        }

        return { status: 'Upload Complete', files: uploadedFiles };
    });

    // === DELETE: ФИЗИЧЕСКОЕ УНИЧТОЖЕНИЕ ФАЙЛА ===
    fastify.delete('/backgrounds/file/:filename', async (request, reply) => {
        try {
            const cleanName = path.basename(request.params.filename || '');
            if (!cleanName) return reply.code(400).send({ error: 'Invalid filename' });

            const targetFile = path.join(bgDir, cleanName);
            await fs.unlink(targetFile);

            // Синхронизируем кэш в памяти если файл был в манифесте
            if (manifestCache && Array.isArray(manifestCache.backgrounds)) {
                manifestCache.backgrounds = manifestCache.backgrounds.filter(b => b.filename !== cleanName);
            }

            return { status: 'File Nuked', success: true };
        } catch (err) {
            if (err.code === 'ENOENT') {
                return { status: 'File already deleted', success: true };
            }
            fastify.log.error('Ошибка физического удаления файла:', err.message);
            return reply.code(404).send({ error: 'File not found or locked' });
        }
    });
};