const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const defaultConnections = [
    {
        id: 'default_ai_core',
        name: 'AI CORE',
        tag: 'LOCAL / PROXY',
        status: 'OFFLINE',
        apiType: 'custom',
        url: 'http://127.0.0.1:7777/v1',
        key: '',
        model: '',
        postProcessing: 'ОТСУТСТВУЕТ',
        allowFallback: true,
        bypassCheck: false
    }
];

module.exports = async function (fastify, opts) {
    const filePath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'connections.json');
    const secretsPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'secrets.json'); // Путь к ключам

    // --- МАНИФЕСТ ПРОФИЛЕЙ ---
    fastify.get('/connections/manifest', async (request, reply) => {
        try {
            await fs.access(filePath);
            const data = await fs.readFile(filePath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            return defaultConnections;
        }
    });

    fastify.post('/connections/manifest', async (request, reply) => {
        try {
            await fs.writeFile(filePath, JSON.stringify(request.body, null, 4), 'utf-8');
            return { status: 'Connections Synced', success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи connections.json:', err);
            return reply.code(500).send({ error: 'Manifest write failed' });
        }
    });

    // --- МЕНЕДЖЕР СЕКРЕТОВ (КЛЮЧЕЙ) ---
    fastify.get('/connections/secrets', async (request, reply) => {
        try {
            await fs.access(secretsPath);
            const data = await fs.readFile(secretsPath, 'utf-8');
            return JSON.parse(data);
        } catch (err) {
            return []; // Если файла нет, отдаем пустой массив
        }
    });

    fastify.post('/connections/secrets', async (request, reply) => {
        try {
            await fs.writeFile(secretsPath, JSON.stringify(request.body, null, 4), 'utf-8');
            return { status: 'Secrets Synced', success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи secrets.json:', err);
            return reply.code(500).send({ error: 'Secrets write failed' });
        }
    });
};