// ФАЙЛ: server/api/ai_presets.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const ensureDir = async (dirPath) => {
    try { await fs.access(dirPath); }
    catch { await fs.mkdir(dirPath, { recursive: true }); }
};

module.exports = async function (fastify, opts) {
    const presetsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'ai_presets');

    // 1. Читаем все файлы пресетов
    fastify.get('/ai_presets', async (request, reply) => {
        await ensureDir(presetsDir);
        const files = await fs.readdir(presetsDir);
        const presets = [];

        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const data = await fs.readFile(path.join(presetsDir, file), 'utf-8');
                    presets.push(JSON.parse(data));
                } catch (e) {
                    fastify.log.error(`[AI_PRESETS] Ошибка чтения ${file}: ${e.message}`);
                }
            }
        }
        return presets;
    });

    // 2. Пишем ОДИН единый файл пресета (Сэмплеры + Контекст)
    fastify.post('/ai_presets/:id', async (request, reply) => {
        await ensureDir(presetsDir);
        const { id } = request.params;
        const filePath = path.join(presetsDir, `${id}.json`);
        try {
            await fs.writeFile(filePath, JSON.stringify(request.body, null, 4), 'utf-8');
            return { status: 'Preset Saved', success: true };
        } catch (err) {
            return reply.code(500).send({ error: 'Failed to write preset' });
        }
    });

    // 3. Удаляем файл пресета
    fastify.delete('/ai_presets/:id', async (request, reply) => {
        const { id } = request.params;
        const filePath = path.join(presetsDir, `${id}.json`);
        try {
            await fs.unlink(filePath);
            return { status: 'Preset Deleted', success: true };
        } catch (err) {
            if (err.code === 'ENOENT') return { success: true };
            return reply.code(500).send({ error: 'Failed to delete preset' });
        }
    });
};