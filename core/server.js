const fastify = require('fastify')({
    logger: {
        transport: {
            target: 'pino-pretty',
            options: { translateTime: 'HH:MM:ss Z', ignore: 'pid,hostname' }
        }
    },
    bodyLimit: 262144000 // 250 MB
});

const path = require('path');
const { exec } = require('child_process');
const { initializeFilesystem } = require('./system/init');

// Тестовый эндпоинт для проверки связи
fastify.get('/ping', async (request, reply) => {
    return {
        status: 'Cobalt Core Online',
        system: 'Aegis Active',
        fps_drop: false
    };
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
        fastify.register(require('./api/tokenizer'), { prefix: '/api' });

        fastify.get('/thumbnail', (req, reply) => {
            reply.redirect(`/api/thumbnail?file=${req.query.file || ''}`);
        });

        // 4. Поднимаем вычислительный узел
        await fastify.listen({ port: 8000, host: '0.0.0.0' });

        console.log('\n[COBALT CORE] Главное ядро запущено. Ожидание сигналов...');
        console.log('[COBALT CORE] REST Gateway: http://localhost:8000\n');

        // 5. ОТКРЫТИЕ БРАУЗЕРА (Только если не дев-режим)
        if (!isDev) {
            console.log('[SYSTEM] Launching terminal in browser...');
            const url = 'http://127.0.0.1:8000/';

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