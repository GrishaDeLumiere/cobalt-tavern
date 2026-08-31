const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

module.exports = async function (fastify, opts) {
    const avatarsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'avatars');
    const personasDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas');
    const orderFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_order.json');
    const oldDbFile = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.json');

    // Кэш в оперативной памяти для мгновенного ответа
    let personasCache = null;

    const sanitizeFilename = (name) => {
        if (!name) return '';
        return path.basename(String(name).trim()).replace(/[<>:"/\\|?*]/g, '_');
    };

    // Подготовка директорий и автоматическая миграция
    const ensureFoldersAndMigrate = async () => {
        try { await fs.access(avatarsDir); } catch { await fs.mkdir(avatarsDir, { recursive: true }); }
        try { await fs.access(personasDir); } catch { await fs.mkdir(personasDir, { recursive: true }); }

        // ПРОВЕРКА И РАЗРЕЗКА СТАРОГО МОНОЛИТА
        try {
            await fs.access(oldDbFile);
            const data = await fs.readFile(oldDbFile, 'utf8');
            const parsed = JSON.parse(data).personas || [];

            if (parsed.length > 0) {
                console.log(`[PERSONAS] Найдена старая база personas_db.json (${parsed.length} персон). Начинаю разрезку на файлы...`);
                let order = [];
                for (const p of parsed) {
                    const cleanId = p.id || `user_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
                    p.id = cleanId;
                    p.modules = p.modules || [];
                    const pPath = path.join(personasDir, `${cleanId}.json`);
                    await fs.writeFile(pPath, JSON.stringify(p, null, 4), 'utf8');
                    order.push(cleanId);
                }
                await fs.writeFile(orderFile, JSON.stringify(order, null, 4), 'utf8');
                console.log(`[PERSONAS] Успешно создано ${parsed.length} индивидуальных файлов персон!`);
            }
            
            // Убираем старый файл, чтобы он больше не сбивал систему
            await fs.rename(oldDbFile, path.join(ROOT_DATA_DIR, DEFAULT_USER, 'personas_db.backup.json'));
            console.log('[PERSONAS] Старый personas_db.json переименован в personas_db.backup.json.');
        } catch (e) {
            // Старого файла нет — работаем в штатном модульном режиме
        }
    };

    // Чтение всех файлов персон из папки
    const getPersonasData = async () => {
        if (personasCache) return personasCache;
        await ensureFoldersAndMigrate();

        let order = [];
        try {
            const orderData = await fs.readFile(orderFile, 'utf8');
            order = JSON.parse(orderData);
        } catch (e) {
            order = [];
        }

        let files = [];
        try {
            files = await fs.readdir(personasDir);
        } catch (e) {
            files = [];
        }

        const loadedPersonas = [];
        let needsOrderSave = false;

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const raw = await fs.readFile(path.join(personasDir, file), 'utf8');
                const p = JSON.parse(raw);
                if (p && p.id) {
                    p.modules = p.modules || [];
                    loadedPersonas.push(p);
                    if (!order.includes(p.id)) {
                        order.push(p.id);
                        needsOrderSave = true;
                    }
                }
            } catch (err) {
                console.error(`[PERSONAS] Ошибка парсинга файла ${file}:`, err.message);
            }
        }

        // Сортировка по сохраненному порядку
        const orderMap = new Map(order.map((id, index) => [id, index]));
        loadedPersonas.sort((a, b) => {
            const posA = orderMap.has(a.id) ? orderMap.get(a.id) : 99999;
            const posB = orderMap.has(b.id) ? orderMap.get(b.id) : 99999;
            return posA - posB;
        });

        if (needsOrderSave) {
            await fs.writeFile(orderFile, JSON.stringify(loadedPersonas.map(p => p.id), null, 4), 'utf8');
        }

        personasCache = loadedPersonas;
        return personasCache;
    };

    // ==========================================
    // API ЭНДПОИНТЫ
    // ==========================================

    // Получение списка персон
    fastify.get('/personas', async (request, reply) => {
        const personas = await getPersonasData();
        return personas.map(p => ({
            ...p,
            avatarUrl: p.filename && p.filename.trim() !== ''
                ? `/data/${DEFAULT_USER}/avatars/${encodeURIComponent(p.filename)}`
                : ''
        }));
    });

    // Сохранение конкретной персоны в её личный .json файл
    fastify.post('/personas/sync', async (request, reply) => {
        const personaData = request.body;
        if (!personaData || !personaData.id) return { success: false, error: 'No ID' };

        await ensureFoldersAndMigrate();
        const personas = await getPersonasData();
        const existingIdx = personas.findIndex(p => p.id === personaData.id);

        let finalObj = {};
        if (existingIdx > -1) {
            finalObj = { ...personas[existingIdx], ...personaData };
            personas[existingIdx] = finalObj;
        } else {
            finalObj = personaData;
            personas.unshift(finalObj);
            await fs.writeFile(orderFile, JSON.stringify(personas.map(p => p.id), null, 4), 'utf8');
        }

        // Записываем строго в персональный файл персоны
        const targetFilePath = path.join(personasDir, `${finalObj.id}.json`);
        await fs.writeFile(targetFilePath, JSON.stringify(finalObj, null, 4), 'utf8');

        personasCache = personas;
        return { success: true };
    });

    // Изменение порядка карточек
    fastify.post('/personas/reorder', async (request, reply) => {
        const { order } = request.body;
        if (!order || !Array.isArray(order)) return { success: false };

        const personas = await getPersonasData();
        const orderMap = new Map(order.map((id, index) => [id, index]));
        personas.sort((a, b) => {
            const posA = orderMap.has(a.id) ? orderMap.get(a.id) : 99999;
            const posB = orderMap.has(b.id) ? orderMap.get(b.id) : 99999;
            return posA - posB;
        });

        await fs.writeFile(orderFile, JSON.stringify(order, null, 4), 'utf8');
        personasCache = personas;
        return { success: true };
    });

    // Массовый импорт персон
    fastify.post('/personas/import_mass', async (request, reply) => {
        const { importedData } = request.body;
        if (!importedData || !Array.isArray(importedData)) return { success: false };

        await ensureFoldersAndMigrate();
        const current = await getPersonasData();
        const filenameMap = new Map(current.map((p, idx) => [p.filename, idx]));
        let isOrderChanged = false;

        for (const newItem of importedData) {
            let targetObj = newItem;
            if (newItem.filename && filenameMap.has(newItem.filename)) {
                const idx = filenameMap.get(newItem.filename);
                targetObj = { ...current[idx], ...newItem };
                current[idx] = targetObj;
            } else {
                if (!targetObj.id) targetObj.id = `user_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
                current.unshift(targetObj);
                isOrderChanged = true;
            }
            await fs.writeFile(path.join(personasDir, `${targetObj.id}.json`), JSON.stringify(targetObj, null, 4), 'utf8');
        }

        if (isOrderChanged) {
            await fs.writeFile(orderFile, JSON.stringify(current.map(p => p.id), null, 4), 'utf8');
        }

        personasCache = current;
        return { success: true };
    });

    // Загрузка аватарки
    fastify.post('/personas/avatar', async (request, reply) => {
        await ensureFoldersAndMigrate();
        const data = await request.file();
        if (!data) return reply.code(400).send({ success: false, error: 'Файл не передан' });

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

    // Удаление персоны (удаляется файл [id].json)
    fastify.delete('/personas/:id', async (request, reply) => {
        const targetId = request.params.id;
        const personas = await getPersonasData();
        const target = personas.find(p => p.id === targetId);

        if (target) {
            if (target.filename) {
                const isAvatarShared = personas.some(p => p.id !== targetId && p.filename === target.filename);
                if (!isAvatarShared) {
                    try { await fs.unlink(path.join(avatarsDir, target.filename)); } catch (e) {}
                }
            }
            try { 
                await fs.unlink(path.join(personasDir, `${targetId}.json`)); 
            } catch (e) {}
        }

        const filtered = personas.filter(p => p.id !== targetId);
        await fs.writeFile(orderFile, JSON.stringify(filtered.map(p => p.id), null, 4), 'utf8');
        personasCache = filtered;
        return { success: true };
    });

    // Копирование аватарки
    fastify.post('/personas/copy_avatar', async (request, reply) => {
        let { source, destination } = request.body || {};
        source = sanitizeFilename(source);
        destination = sanitizeFilename(destination);
        if (!source || !destination) return { success: false, error: 'Некорректные имена файлов' };

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