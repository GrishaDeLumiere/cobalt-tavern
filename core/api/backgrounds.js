const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const util = require('util');
const pipeline = util.promisify(require('stream').pipeline);
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const defaultManifest = {
    folders: [],
    backgrounds: []
};

module.exports = async function (fastify, opts) {
    const manifestPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'backgrounds.json');

    // === GET: Получить всю базу фонов ===
    fastify.get('/backgrounds/manifest', async (request, reply) => {
        try {
            await fs.access(manifestPath);
            const data = await fs.readFile(manifestPath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            return defaultManifest;
        }
    });

    // === POST: Сохранить новое состояние (Drag&Drop, Переименование) ===
    fastify.post('/backgrounds/manifest', async (request, reply) => {
        try {
            const newState = request.body;
            await fs.writeFile(manifestPath, JSON.stringify(newState, null, 4), 'utf-8');
            return { status: 'Backgrounds Synced', success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи backgrounds.json:', err);
            return reply.code(500).send({ error: 'Manifest write failed' });
        }
    });

    fastify.post('/backgrounds/upload', async (request, reply) => {
        const bgDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'backgrounds');
        const parts = request.files();
        const uploadedFiles = [];

        for await (const part of parts) {
            const bgId = `bg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
            const ext = path.extname(part.filename) || '.jpg';
            const safeName = `${bgId}${ext}`;
            const savePath = path.join(bgDir, safeName);

            await pipeline(part.file, fsSync.createWriteStream(savePath));

            uploadedFiles.push({
                id: bgId,
                name: part.filename,
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
            const bgDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'backgrounds');
            const targetFile = path.join(bgDir, path.basename(request.params.filename));

            await fs.unlink(targetFile);
            return { status: 'File Nuked', success: true };
        } catch (err) {
            fastify.log.error('Ошибка физического удаления файла (возможно уже удален):', err.message);
            return reply.code(404).send({ error: 'File not found or locked' });
        }
    });

};