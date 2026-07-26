// ФАЙЛ: server/api/llm.js
const { buildPrompt } = require('../system/promptBuilder');

const openaiProvider = require('./providers/openai');
const googleProvider = require('./providers/google');
const claudeProvider = require('./providers/claude');

// Карта маршрутизации (какой модуль юзать для какого типа API)
const providers = {
    'custom': openaiProvider,
    'openai': openaiProvider,
    'openrouter': openaiProvider,
    'groq': openaiProvider,
    'google': googleProvider,
    'claude': claudeProvider
};

module.exports = async function (fastify, opts) {

    const getProvider = (apiType) => {
        const provider = providers[apiType] || openaiProvider;
        return provider;
    };

    fastify.post('/llm/ping', async (request, reply) => {
        const { url, key, apiType } = request.body;
        try {
            const provider = getProvider(apiType);
            await provider.ping(url, key);
            return { status: 'ONLINE', success: true };
        } catch (error) {
            fastify.log.error(`[LLM GATEWAY PING] ${apiType} Error: ${error.message}`);
            return reply.code(502).send({ error: 'СЕРВЕР ОТВЕРГ ЗАПРОС', details: error.message });
        }
    });

    fastify.post('/llm/models', async (request, reply) => {
        const { url, key, apiType } = request.body;
        try {
            const provider = getProvider(apiType);
            const models = await provider.getModels(url, key);
            return { success: true, models };
        } catch (error) {
            fastify.log.error(`[LLM GATEWAY MODELS] ${apiType} Error: ${error.message}`);
            return reply.code(502).send({ error: 'СБОЙ ЗАПРОСА МОДЕЛЕЙ', details: error.message });
        }
    });

    fastify.post('/llm/test', async (request, reply) => {
        const { url, key, model, apiType } = request.body;
        try {
            const provider = getProvider(apiType);
            const text = await provider.test(url, key, model, apiType);
            return { success: true, text };
        } catch (error) {
            fastify.log.error(`[LLM GATEWAY TEST] ${apiType} Error: ${error.message}`);
            return reply.code(500).send({ error: 'СБОЙ ИНФЕРЕНСА', details: error.message });
        }
    });

    // === ГЛАВНЫЙ ЭНДПОИНТ ГЕНЕРАЦИИ ЧАТА (STREAMING / NO-STREAMING) ===
    fastify.post('/llm/generate', async (request, reply) => {
        const abortController = new AbortController();
        const safeAbort = () => {
            try {
                if (!abortController.signal.aborted) {
                    abortController.abort();
                }
            } catch (e) { }
        };

        request.raw.on('aborted', () => {
            fastify.log.warn('[LLM GATEWAY] Клиент нажал отмену. Убиваем генерацию...');
            safeAbort();
        });

        reply.raw.on('close', () => {
            safeAbort();
        });

        const {
            chatId, presetId, charId, personaId,
            connectionId, sysConfig, activePreset
        } = request.body;

        // 1. Добываем креды подключения из файла (connections.json)
        const fs = require('fs/promises');
        const path = require('path');
        const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');
        let connection = null;
        try {
            const connRaw = await fs.readFile(path.join(ROOT_DATA_DIR, DEFAULT_USER, 'connections.json'), 'utf-8');
            connection = JSON.parse(connRaw).find(c => c.id === connectionId);
        } catch (e) { }

        if (!connection) {
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.write(`data: {"error": "Узел связи не найден или не выбран"}\n\n`);
            reply.raw.end();
            return;
        }

        try {
            // 2. АКТИВИРУЕМ ЯДРО СБОРКИ ПРОМПТОВ
            const { messages, samplerSettings } = await buildPrompt({
                chatId,
                presetId,
                charId,
                personaId,
                sysConfig,
                postProcessing: connection.postProcessing || 'none'
            });

            const provider = getProvider(connection.apiType);

            // 3. НАСТРАИВАЕМ СТРИМИНГ К КЛИЕНТУ (Server-Sent Events)
            reply.raw.setHeader('Content-Type', 'text/event-stream');
            reply.raw.setHeader('Cache-Control', 'no-cache');
            reply.raw.setHeader('Connection', 'keep-alive');
            reply.raw.flushHeaders();

            const openTag = activePreset?.reasoning_open_tag || '<think>';
            const usePrefill = activePreset?.reasoning_prefill === true;

            if (usePrefill) {
                reply.raw.write(`data: ${JSON.stringify({ chunk: openTag + '\n' })}\n\n`);
            }

            await provider.generateStream({
                url: connection.url,
                key: connection.key,
                model: connection.model,
                messages: messages,
                samplers: {
                    ...samplerSettings,
                    reasoning_effort: activePreset?.reasoning_effort || 'auto'
                },
                replyRaw: reply.raw,
                prefillTag: usePrefill ? openTag : null,
                signal: abortController.signal
            });

            if (!reply.raw.writableEnded) {
                reply.raw.end();
            }

        } catch (error) {
            fastify.log.error(`[LLM GENERATE] Ошибка генерации: ${error.message}`);
            if (!reply.raw.headersSent) {
                reply.raw.setHeader('Content-Type', 'text/event-stream');
                reply.raw.flushHeaders();
            }
            reply.raw.write(`data: {"error": "${error.message}"}\n\n`);
            reply.raw.end();
        }
    });
};