const fastify = require('fastify')({
    logger: {
        transport: {
            target: 'pino-pretty',
            options: {
                translateTime: 'HH:MM:ss Z',
                ignore: 'pid,hostname'
            }
        }
    },
    bodyLimit: 262144000 // 250 MB
});

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { initializeFilesystem } = require('./system/init');

// === МОДУЛЬ КОНФИГУРАЦИИ ===
const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
    port: 8000,
    host: '0.0.0.0',
    autoOpenBrowser: true
};

function loadOrCreateConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 4), 'utf-8');
            console.log(`[CONFIG] Создан файл конфигурации по умолчанию: ${CONFIG_PATH}`);
            return DEFAULT_CONFIG;
        }
        const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    } catch (err) {
        console.error('[CONFIG_ERROR] Ошибка чтения config.json, применены настройки по умолчанию:', err.message);
        return DEFAULT_CONFIG;
    }
}

// Загружаем конфиг
const appConfig = loadOrCreateConfig();
const PORT = Number(process.env.PORT) || Number(appConfig.port) || 8080;
const HOST = process.env.HOST || appConfig.host || '0.0.0.0';

// Тестовый эндпоинт для проверки связи
fastify.get('/ping', async (request, reply) => {
    return { status: 'Cobalt Core Online', system: 'Aegis Active', fps_drop: false };
});

// === ФУНКЦИЯ ХОЛОДНОГО СТАРТА ЯДРА ===
const startSystem = async () => {
    try {
        // 1. Выстраиваем файловую архитектуру
        await initializeFilesystem();

        // 2. Инжектим плагины Fastify для работы с файлами
        fastify.register(require('@fastify/multipart'), {
            limits: { fileSize: 262144000 } // 250 MB
        });

        fastify.register(require('@fastify/static'), {
            root: path.join(__dirname, '../data'),
            prefix: '/data/',
            decorateReply: false
        });

        const isDev = process.env.NODE_ENV === 'development';
        if (!isDev) {
            console.log('[SYS_INIT] Режим РЕЛИЗА. Модуль раздачи интерфейса АКТИВИРОВАН.');
            fastify.register(require('@fastify/static'), {
                root: path.join(__dirname, '../core-ui'),
                prefix: '/'
            });
            fastify.setNotFoundHandler((req, reply) => {
                reply.sendFile('index.html');
            });
        } else {
            console.log('[SYS_INIT] Режим РАЗРАБОТКИ. Раздача статики отключена.');
        }

        // 3. Подключаем API модули
        fastify.register(require('./api/system'), { prefix: '/api' });
        fastify.register(require('./api/backgrounds'), { prefix: '/api' });
        fastify.register(require('./api/connections'), { prefix: '/api' });
        fastify.register(require('./api/ai_presets'), { prefix: '/api' });
        fastify.register(require('./api/personas'), { prefix: '/api' });
        fastify.register(require('./api/characters'), { prefix: '/api' });
        fastify.register(require('./api/lorebooks'), { prefix: '/api' });
        fastify.register(require('./api/chats'), { prefix: '/api' });
        fastify.register(require('./api/syntax'), { prefix: '/api' });
        fastify.register(require('./api/updater'), { prefix: '/api' });
        fastify.register(require('./api/llm'), { prefix: '/api' });
        fastify.register(require('./api/summarize'), { prefix: '/api/llm' });
        fastify.register(require('./api/tokenizer'), { prefix: '/api' });
        fastify.register(require('./api/author_notes'), { prefix: '/api' });

        fastify.get('/thumbnail', (req, reply) => {
            reply.redirect(`/api/thumbnail?file=${req.query.file || ''}`);
        });

        // 4. Поднимаем вычислительный узел с динамическим портом
        await fastify.listen({ port: PORT, host: HOST });

        console.log('\n[COBALT CORE] Главное ядро запущено. Ожидание сигналов...');
        console.log(`[COBALT CORE] REST Gateway: http://localhost:${PORT}\n`);

        // 5. ОТКРЫТИЕ БРАУЗЕРА (Только если не дев-режим и разрешено в конфиге)
        if (!isDev && appConfig.autoOpenBrowser !== false) {
            console.log('[SYSTEM] Launching terminal in browser...');
            const url = `http://127.0.0.1:${PORT}/`;

            if (process.platform === 'win32') {
                exec(`start ${url}`);
            } else if (process.platform === 'darwin') {
                exec(`open ${url}`);
            } else {
                exec(`xdg-open ${url}`);
            }
        }

    } catch (err) {
        fastify.log.error(err);
        process.exit(1);
    }
};

startSystem();