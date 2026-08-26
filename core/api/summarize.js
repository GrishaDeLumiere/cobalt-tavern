// ФАЙЛ: server/api/summarize.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');
const { addGatewayLog } = require('./llm');

module.exports = async function (fastify, opts) {

    // === 1. ПОЛУЧЕНИЕ ПРЕСЕТОВ ПЕРЕСКАЗА ===
    fastify.get('/summarize/config', async (request, reply) => {
        const configPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'summarize_config.json');
        try {
            const rawData = await fs.readFile(configPath, 'utf-8');
            let data = JSON.parse(rawData);

            if (!data.presets) {
                data = {
                    activePresetId: 'default',
                    presets: [{
                        id: 'default',
                        name: 'Стандартный',
                        template: data.template || '{{dialogue}}',
                        max_tokens: data.max_tokens || 2048,
                        temperature: data.temperature || 0.97,
                        top_p: data.top_p || 0.95,
                        default_role: data.default_role || 'assistant'
                    }]
                };
                await fs.writeFile(configPath, JSON.stringify(data, null, 4), 'utf-8');
            }
            return data;
        } catch (e) {
            return {
                activePresetId: 'default',
                presets: [{
                    id: 'default',
                    name: 'Стандартный',
                    template: "Пожалуйста, сделай подробный пересказ диалога:\n\n{{dialogue}}",
                    max_tokens: 2048,
                    temperature: 0.97,
                    top_p: 0.95,
                    default_role: 'assistant'
                }]
            };
        }
    });

    // === 2. СОХРАНЕНИЕ ПРЕСЕТОВ ПЕРЕСКАЗА ===
    fastify.post('/summarize/config', async (request, reply) => {
        const configPath = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'summarize_config.json');
        try {
            await fs.writeFile(configPath, JSON.stringify(request.body, null, 4), 'utf-8');
            return { success: true };
        } catch (e) {
            return reply.code(500).send({ error: 'Ошибка сохранения пресетов' });
        }
    });

    // === 3. ГЕНЕРАЦИЯ ПЕРЕСКАЗА (INFERENCE C ПОДДЕРЖКОЙ ABORT) ===
    fastify.post('/summarize/generate', async (request, reply) => {
        const { dialogueText, config, connectionId, presetId } = request.body;

        // ПЕРЕХВАТ ОБРЫВА СВЯЗИ ОТ КЛИЕНТА
        const abortController = new AbortController();
        const onClientClose = () => {
            if (!reply.raw.writableEnded) {
                abortController.abort();
            }
        };
        request.raw.on('close', onClientClose);

        let connection = null;
        try {
            const connRaw = await fs.readFile(path.join(ROOT_DATA_DIR, DEFAULT_USER, 'connections.json'), 'utf-8');
            connection = JSON.parse(connRaw).find(c => c.id === connectionId);
        } catch (e) { }

        if (!connection) {
            request.raw.removeListener('close', onClientClose);
            return reply.code(400).send({ error: 'Активное подключение не найдено' });
        }

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
                        body: JSON.stringify(lastPayload),
                        signal: abortController.signal
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
                        body: JSON.stringify(lastPayload),
                        signal: abortController.signal
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
                    if (abortController.signal.aborted || firstErr.name === 'AbortError') {
                        throw firstErr;
                    }

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
                    body: JSON.stringify(lastPayload),
                    signal: abortController.signal
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
                    body: JSON.stringify(lastPayload),
                    signal: abortController.signal
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

            if (resultText.includes(openTag)) {
                resultText = resultText.replace(thinkRegex, '').trim();
            }

            if (!resultText.trim()) {
                throw new Error('ИИ вернул пустой ответ (или весь ответ состоял из блока мыслей)');
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
            if (typeof addGatewayLog === 'function') {
                addGatewayLog({
                    model: (connection.model || connection.apiType) + ' [SUMMARIZE]',
                    status: '200 OK',
                    duration,
                    request: lastPayload,
                    response: lastRawResponse || { text: resultText }
                });
            }

            return { success: true, text: resultText.trim() };

        } catch (error) {
            const isAborted = abortController.signal.aborted ||
                error.name === 'AbortError' ||
                (error.message && error.message.toLowerCase().includes('aborted'));

            const duration = ((Date.now() - startTime) / 1000).toFixed(2) + 's';

            if (isAborted) {
                fastify.log.warn(`[SUMMARIZE] Генерация пересказа прервана пользователем.`);
                if (typeof addGatewayLog === 'function') {
                    addGatewayLog({
                        model: (connection?.model || connection?.apiType || 'unknown') + ' [SUMMARIZE]',
                        status: '499 ABORTED',
                        duration,
                        request: lastPayload,
                        response: { error: 'Request aborted by user' }
                    });
                }
                if (!reply.raw.headersSent && !reply.raw.writableEnded && !reply.raw.destroyed) {
                    return reply.code(499).send({ error: 'Генерация прервана пользователем' });
                }
                return;
            }

            fastify.log.error(`[SUMMARIZE LLM ERROR]: ${error.message}`);
            if (typeof addGatewayLog === 'function') {
                addGatewayLog({
                    model: (connection?.model || connection?.apiType || 'unknown') + ' [SUMMARIZE]',
                    status: '500 ERROR',
                    duration,
                    request: lastPayload,
                    response: lastRawResponse || { error: error.message }
                });
            }
            return reply.code(500).send({ error: error.message || 'Сбой генерации пересказа' });
        } finally {
            request.raw.removeListener('close', onClientClose);
        }
    });
};