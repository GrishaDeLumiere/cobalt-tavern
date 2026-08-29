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

// === БАЗА ЛОГОВ ШЛЮЗА (В ПАМЯТИ) ===
const apiLogs = [];
const addGatewayLog = (logData) => {
    apiLogs.unshift({
        id: `log_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        timestamp: new Date().toLocaleTimeString(),
        ...logData
    });
    if (apiLogs.length > 15) apiLogs.pop();
};

const llmPlugin = async function (fastify, opts) {

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
        const startTime = Date.now();

        try {
            const provider = getProvider(apiType);
            const result = await provider.test(url, key, model, apiType);

            // Поддержка как старого формата (строка), так и нового (объект)
            const text = typeof result === 'string' ? result : result.text;
            const duration = ((Date.now() - startTime) / 1000).toFixed(2) + 's';

            addGatewayLog({
                model: model || apiType,
                status: '200 OK (TEST)',
                duration,
                request: result.rawRequest || { action: 'test_connection', model },
                response: result.rawResponse || { text }
            });

            return { success: true, text };
        } catch (error) {
            const duration = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
            fastify.log.error(`[LLM GATEWAY TEST] ${apiType} Error: ${error.message}`);

            addGatewayLog({
                model: model || apiType,
                status: '500 ERROR (TEST)',
                duration,
                request: { action: 'test_connection', url, model },
                response: { error: error.message }
            });

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

            const startTime = Date.now();

            await provider.generateStream({
                url: connection.url,
                key: connection.key,
                model: connection.model,
                messages: messages,
                samplers: {
                    ...samplerSettings,
                    reasoning_effort: activePreset?.reasoning_effort || 'auto',
                    send_attachments: activePreset?.send_attachments !== false,
                    google_advanced_safety: activePreset?.google_advanced_safety === true,
                    google_send_safety: activePreset?.google_send_safety !== false,
                    single_turn_mode: activePreset?.single_turn_mode === true,
                    native_system_prompt: activePreset?.native_system_prompt !== false,
                    google_interactions_api: activePreset?.google_interactions_api === true
                },
                replyRaw: reply.raw,
                prefillTag: usePrefill ? openTag : null,
                signal: abortController.signal,

                onLog: (rawRequest, rawResponse, errorStatus) => {
                    const duration = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
                    addGatewayLog({
                        model: connection.model || connection.apiType,
                        status: errorStatus || '200 OK',
                        duration,
                        request: rawRequest,
                        response: rawResponse
                    });
                }
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

    fastify.get('/llm/logs', async (request, reply) => {
        return apiLogs;
    });
};

module.exports = llmPlugin;
module.exports.addGatewayLog = addGatewayLog;