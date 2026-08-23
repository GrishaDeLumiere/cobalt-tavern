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

    // === API ДЛЯ РАБОТЫ С КОНФИГОМ ПЕРЕСКАЗА ===
    fastify.get('/llm/summarize/config', async (request, reply) => {
        const fs = require('fs/promises');
        const path = require('path');
        const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');
        const configPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'summarize_config.json');
        try {
            const data = await fs.readFile(configPath, 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            return reply.code(500).send({ error: 'Ошибка получения настроек' });
        }
    });

    fastify.post('/llm/summarize/config', async (request, reply) => {
        const fs = require('fs/promises');
        const path = require('path');
        const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');
        const configPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'summarize_config.json');
        const configData = request.body;
        try {
            await fs.writeFile(configPath, JSON.stringify(configData, null, 4), 'utf-8');
            return { success: true };
        } catch (e) {
            return reply.code(500).send({ error: 'Ошибка сохранения настроек' });
        }
    });

    fastify.post('/llm/summarize/generate', async (request, reply) => {
        const { dialogueText, config, connectionId, presetId } = request.body;

        const fs = require('fs/promises');
        const path = require('path');
        const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

        let connection = null;
        try {
            const connRaw = await fs.readFile(path.join(ROOT_DATA_DIR, DEFAULT_USER, 'connections.json'), 'utf-8');
            connection = JSON.parse(connRaw).find(c => c.id === connectionId);
        } catch (e) { }

        if (!connection) {
            return reply.code(400).send({ error: 'Активное подключение не найдено' });
        }

        // 1. Вытаскиваем теги мыслей из пресета
        let openTag = '<think>';
        let closeTag = '</think>';
        if (presetId) {
            try {
                const presetsDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'ai_presets');
                const preset = JSON.parse(await fs.readFile(path.join(presetsDir, `${presetId}.json`), 'utf-8'));
                if (preset.reasoning_open_tag) openTag = preset.reasoning_open_tag;
                if (preset.reasoning_close_tag) closeTag = preset.reasoning_close_tag;
            } catch (e) { }
        }

        const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const thinkRegex = new RegExp(`${escapeRegExp(openTag)}[\\s\\S]*?(${escapeRegExp(closeTag)}|$)`, 'gi');

        const maxTokens = Number(config?.max_tokens) || 1500;
        const temperature = config?.temperature !== undefined ? Number(config.temperature) : 0.5;
        const topP = config?.top_p !== undefined ? Number(config.top_p) : 0.95;
        const template = config?.template || "{{dialogue}}";

        // 2. Очищаем входящий диалог
        const cleanDialogue = dialogueText.includes(openTag)
            ? dialogueText.replace(thinkRegex, '').trim()
            : dialogueText;

        const promptText = template.replace('{{dialogue}}', cleanDialogue);
        const url = connection.url.endsWith('/') ? connection.url.slice(0, -1) : connection.url;
        const key = connection.key || '';
        const model = connection.model;
        const apiType = connection.apiType || 'openai';

        const startTime = Date.now();
        let lastPayload = null;
        let lastRawResponse = null;

        try {
            let resultText = "";

            if (apiType === 'google') {
                let baseUrl = url;
                if (!baseUrl.includes('googleapis.com') && !baseUrl.match(/\/v1(beta)?$/)) {
                    baseUrl += '/v1beta';
                }
                const modelPath = model.includes('/') ? model : `models/${model}`;
                const rawModelName = modelPath.replace('models/', '');

                const isInteractionsModel = model.includes('deep-research') ||
                    model.includes('antigravity') ||
                    model.includes('omni') ||
                    model.includes('thinking') ||
                    model.match(/gemma-4/);

                const callInteractions = async () => {
                    lastPayload = {
                        model: rawModelName,
                        store: false,
                        input: [{ type: 'user_input', content: [{ type: 'text', text: promptText }] }],
                        generation_config: { max_output_tokens: maxTokens, temperature: temperature, top_p: topP }
                    };
                    const res = await fetch(`${baseUrl}/interactions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                        body: JSON.stringify(lastPayload)
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const data = await res.json();
                    lastRawResponse = data;
                    const outStep = data.steps?.find(s => s.type === 'model_output');
                    return outStep?.content?.map(c => c.text || '').join('') || data.output_text || '';
                };

                const callGenerateContent = async () => {
                    lastPayload = {
                        contents: [{ role: 'user', parts: [{ text: promptText }] }],
                        generationConfig: { maxOutputTokens: maxTokens, temperature: temperature, topP: topP }
                    };
                    const res = await fetch(`${baseUrl}/${modelPath}:generateContent`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                        body: JSON.stringify(lastPayload)
                    });
                    if (!res.ok) throw new Error(await res.text());
                    const data = await res.json();
                    lastRawResponse = data;
                    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                };

                try {
                    if (isInteractionsModel) {
                        resultText = await callInteractions();
                    } else {
                        resultText = await callGenerateContent();
                    }
                } catch (firstErr) {
                    const errMsg = firstErr.message || '';
                    if (errMsg.includes('Interactions API') || errMsg.includes('interactions')) {
                        resultText = await callInteractions();
                    } else if (errMsg.includes('generateContent') || errMsg.includes('not supported')) {
                        resultText = await callGenerateContent();
                    } else {
                        throw new Error(`Google API Error: ${errMsg.slice(0, 300)}`);
                    }
                }

            } else if (apiType === 'claude') {
                lastPayload = {
                    model: model || 'claude-3-haiku-20240307',
                    max_tokens: maxTokens,
                    temperature: temperature,
                    top_p: topP,
                    messages: [{ role: 'user', content: promptText }]
                };

                const res = await fetch(`${url}/messages`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'anthropic-version': '2023-06-01',
                        'x-api-key': key
                    },
                    body: JSON.stringify(lastPayload)
                });

                if (!res.ok) {
                    const errText = await res.text();
                    lastRawResponse = { error: errText };
                    throw new Error(`Claude API Error: ${errText.slice(0, 300)}`);
                }
                const data = await res.json();
                lastRawResponse = data;
                resultText = data.content?.[0]?.text || '';

            } else {
                const headers = { 'Content-Type': 'application/json' };
                if (key) headers['Authorization'] = `Bearer ${key}`;
                if (apiType === 'openrouter') {
                    headers['HTTP-Referer'] = 'http://localhost:8000';
                    headers['X-Title'] = 'Cobalt Tavern';
                }

                lastPayload = {
                    model: model,
                    messages: [{ role: 'user', content: promptText }],
                    max_tokens: maxTokens,
                    temperature: temperature,
                    top_p: topP
                };

                const res = await fetch(`${url}/chat/completions`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(lastPayload)
                });

                if (!res.ok) {
                    const errText = await res.text();
                    lastRawResponse = { error: errText };
                    throw new Error(`API Error: ${errText.slice(0, 300)}`);
                }
                const data = await res.json();
                lastRawResponse = data;
                resultText = data.choices?.[0]?.message?.content || '';
            }

            // 3. Очищаем итоговый ответ модели
            if (resultText.includes(openTag)) {
                resultText = resultText.replace(thinkRegex, '').trim();
            }

            if (!resultText.trim()) {
                throw new Error('ИИ вернул пустой ответ (или весь ответ состоял из блока мыслей)');
            }

            // СОХРАНЯЕМ ЛОГ УСПЕШНОГО ПЕРЕСКАЗА
            const duration = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
            addGatewayLog({
                model: (connection.model || connection.apiType) + ' [SUMMARIZE]',
                status: '200 OK',
                duration,
                request: lastPayload,
                response: lastRawResponse || { text: resultText }
            });

            return { success: true, text: resultText.trim() };

        } catch (error) {
            fastify.log.error(`[SUMMARIZE LLM ERROR]: ${error.message}`);

            // СОХРАНЯЕМ ЛОГ ОШИБКИ
            const duration = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
            addGatewayLog({
                model: (connection?.model || connection?.apiType || 'unknown') + ' [SUMMARIZE]',
                status: '500 ERROR',
                duration,
                request: lastPayload,
                response: lastRawResponse || { error: error.message }
            });

            return reply.code(500).send({ error: error.message || 'Сбой генерации пересказа' });
        }
    });

    fastify.get('/llm/logs', async (request, reply) => {
        return apiLogs;
    });
};