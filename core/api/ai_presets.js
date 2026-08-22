// ФАЙЛ: server/api/ai_presets.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {
    const presetsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'ai_presets');

    let presetsCache = null;

    // Безопасное имя файла (защита от ../ Path Traversal)
    const sanitizeId = (id) => {
        if (!id) return '';
        return path.basename(String(id).trim()).replace(/[<>:"/\\|?*]/g, '_');
    };

    const ensureDir = async () => {
        try { await fs.access(presetsDir); }
        catch { await fs.mkdir(presetsDir, { recursive: true }); }
    };

    const loadPresetsFromDisk = async () => {
        if (presetsCache) return presetsCache;

        await ensureDir();
        try {
            const files = await fs.readdir(presetsDir);
            const jsonFiles = files.filter(f => f.endsWith('.json'));

            // Параллельное асинхронное чтение всех пресетов
            const loaded = await Promise.all(
                jsonFiles.map(async (file) => {
                    try {
                        const data = await fs.readFile(path.join(presetsDir, file), 'utf-8');
                        return JSON.parse(data);
                    } catch (e) {
                        fastify.log.error(`[AI_PRESETS] Ошибка чтения ${file}: ${e.message}`);
                        return null;
                    }
                })
            );

            presetsCache = loaded.filter(Boolean);
            return presetsCache;
        } catch (err) {
            presetsCache = [];
            return [];
        }
    };

    // 1. Читаем все файлы пресетов (Мгновенно из памяти)
    fastify.get('/ai_presets', async (request, reply) => {
        return await loadPresetsFromDisk();
    });

    // 2. Пишем ОДИН единый файл пресета (Сэмплеры + Контекст)
    fastify.post('/ai_presets/:id', async (request, reply) => {
        await ensureDir();
        const safeId = sanitizeId(request.params.id);
        if (!safeId) return reply.code(400).send({ error: 'Invalid preset ID' });

        const filePath = path.join(presetsDir, `${safeId}.json`);
        const presetData = request.body || {};

        try {
            await fs.writeFile(filePath, JSON.stringify(presetData, null, 4), 'utf-8');

            // Обновляем объект прямо в памяти
            if (presetsCache) {
                const idx = presetsCache.findIndex(p => p.id === safeId || p.id === presetData.id);
                if (idx > -1) {
                    presetsCache[idx] = presetData;
                } else {
                    presetsCache.push(presetData);
                }
            }

            return { status: 'Preset Saved', success: true };
        } catch (err) {
            fastify.log.error(`Ошибка записи пресета ${safeId}:`, err);
            return reply.code(500).send({ error: 'Failed to write preset' });
        }
    });

    // 3. Удаляем файл пресета
    fastify.delete('/ai_presets/:id', async (request, reply) => {
        const safeId = sanitizeId(request.params.id);
        if (!safeId) return reply.code(400).send({ error: 'Invalid preset ID' });

        const filePath = path.join(presetsDir, `${safeId}.json`);
        try {
            await fs.unlink(filePath);

            // Удаляем из кэша памяти
            if (presetsCache) {
                presetsCache = presetsCache.filter(p => p.id !== safeId);
            }

            return { status: 'Preset Deleted', success: true };
        } catch (err) {
            if (err.code === 'ENOENT') {
                if (presetsCache) presetsCache = presetsCache.filter(p => p.id !== safeId);
                return { success: true };
            }
            return reply.code(500).send({ error: 'Failed to delete preset' });
        }
    });
};