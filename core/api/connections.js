// ФАЙЛ: server/api/connections.js
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
    const userDir = path.join(ROOT_DATA_DIR, DEFAULT_USER);
    const filePath = path.join(userDir, 'connections.json');
    const secretsPath = path.join(userDir, 'secrets.json');

    // Кэш для мгновенной отдачи при генерации
    let connectionsCache = null;
    let secretsCache = null;

    const ensureStorage = async () => {
        try { await fs.access(userDir); }
        catch { await fs.mkdir(userDir, { recursive: true }); }
    };

    // --- МАНИФЕСТ ПРОФИЛЕЙ ---
    fastify.get('/connections/manifest', async (request, reply) => {
        if (connectionsCache) return connectionsCache;
        await ensureStorage();
        try {
            const data = await fs.readFile(filePath, 'utf-8');
            connectionsCache = JSON.parse(data);
            return connectionsCache;
        } catch (err) {
            connectionsCache = defaultConnections;
            return defaultConnections;
        }
    });

    fastify.post('/connections/manifest', async (request, reply) => {
        await ensureStorage();
        try {
            const newState = request.body || defaultConnections;
            connectionsCache = newState;
            await fs.writeFile(filePath, JSON.stringify(newState, null, 4), 'utf-8');
            return { status: 'Connections Synced', success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи connections.json:', err);
            return reply.code(500).send({ error: 'Manifest write failed' });
        }
    });

    // --- МЕНЕДЖЕР СЕКРЕТОВ (КЛЮЧЕЙ) ---
    fastify.get('/connections/secrets', async (request, reply) => {
        if (secretsCache) return secretsCache;
        await ensureStorage();
        try {
            const data = await fs.readFile(secretsPath, 'utf-8');
            secretsCache = JSON.parse(data);
            return secretsCache;
        } catch (err) {
            secretsCache = [];
            return [];
        }
    });

    fastify.post('/connections/secrets', async (request, reply) => {
        await ensureStorage();
        try {
            const newSecrets = request.body || [];
            secretsCache = newSecrets;
            await fs.writeFile(secretsPath, JSON.stringify(newSecrets, null, 4), 'utf-8');
            return { status: 'Secrets Synced', success: true };
        } catch (err) {
            fastify.log.error('Ошибка записи secrets.json:', err);
            return reply.code(500).send({ error: 'Secrets write failed' });
        }
    });
};