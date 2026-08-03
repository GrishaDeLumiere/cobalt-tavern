// ФАЙЛ: server/api/lorebooks.js
const fs = require('fs/promises');
const path = require('path');
const { scanLorebooks } = require('../system/loreEngine');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const ensureDir = async (dirPath) => {
    try { await fs.access(dirPath); }
    catch { await fs.mkdir(dirPath, { recursive: true }); }
};

module.exports = async function (fastify, opts) {
    const loreDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'lorebooks');

    // 1. ПОЛУЧИТЬ СПИСОК ВСЕХ ЛОРБУКОВ
    fastify.get('/lorebooks', async () => {
        await ensureDir(loreDir);
        const files = await fs.readdir(loreDir);
        const books = [];
        for (const file of files) {
            if (file.endsWith('.json')) {
                try {
                    const data = JSON.parse(await fs.readFile(path.join(loreDir, file), 'utf-8'));
                    books.push({ id: data.id, name: data.name });
                } catch (e) {
                    fastify.log.error(`[LOREBOOKS] Ошибка чтения ${file}: ${e.message}`);
                }
            }
        }
        return books.sort((a, b) => b.id.localeCompare(a.id));
    });

    // 2. ЗАГРУЗИТЬ ПОЛНЫЙ ЛОРБУК И АВТО-МИГРИРОВАТЬ СТАРЫЙ ФОРМАТ
    fastify.get('/lorebooks/:id', async (request, reply) => {
        const { id } = request.params;
        const filePath = path.join(loreDir, `${id}.json`);
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            let parsed = JSON.parse(data);
            if (parsed.entries && !parsed.categories) {
                parsed.categories = [{
                    id: `cat_${Date.now()}`,
                    name: 'БАЗОВЫЙ КЛАСТЕР',
                    isExpanded: true,
                    entries: parsed.entries
                }];
                delete parsed.entries;
                await fs.writeFile(filePath, JSON.stringify(parsed, null, 4), 'utf-8');
            }

            return parsed;
        } catch (e) {
            return reply.code(404).send({ error: 'Лорбук не найден на диске' });
        }
    });

    // 3. СИНХРОНИЗАЦИЯ (ПЕРЕЗАПИСЬ ФАЙЛА)
    fastify.post('/lorebooks/sync', async (request) => {
        await ensureDir(loreDir);
        const bookData = request.body;
        const filePath = path.join(loreDir, `${bookData.id}.json`);
        await fs.writeFile(filePath, JSON.stringify(bookData, null, 4), 'utf-8');
        return { success: true };
    });

    // 4. СОЗДАНИЕ ВАТМАНА (ПУСТОГО БУКА)
    fastify.post('/lorebooks/create', async (request) => {
        await ensureDir(loreDir);
        const id = `book_${Date.now()}`;
        const newBook = {
            id,
            name: 'НОВЫЙ ЛОРБУК',
            scanDepth: 100, budget: 2048, recursion: 1,
            strategy: 'even', caseSensitive: false, exactMatch: true, recursiveScan: false,
            categories: []
        };
        await fs.writeFile(path.join(loreDir, `${id}.json`), JSON.stringify(newBook, null, 4), 'utf-8');
        return newBook;
    });

    // 5. УНИЧТОЖЕНИЕ
    fastify.delete('/lorebooks/:id', async (request, reply) => {
        const { id } = request.params;
        const filePath = path.join(loreDir, `${id}.json`);
        try {
            await fs.unlink(filePath);
            return { success: true };
        } catch (e) {
            return reply.code(404).send({ error: 'Файл не найден' });
        }
    });

    fastify.post('/lorebooks/simulate', async (request, reply) => {
        const { messages = [], charLorebookIds = [], globalLorebookIds = [], config = {} } = request.body;

        try {
            const result = await scanLorebooks(messages, charLorebookIds, globalLorebookIds, config);
            return result;
        } catch (err) {
            fastify.log.error('[LORE SIMULATION ERROR]', err);
            reply.code(500).send({ error: 'Lore engine simulation failed' });
        }
    });
};