// ФАЙЛ: server/api/providers/google.js

module.exports = {
    _normalize(url, key) {
        let baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

        if (!baseUrl.includes('googleapis.com') && !baseUrl.match(/\/v1(beta)?$/)) {
            baseUrl += '/v1beta';
        }

        const headers = {
            'Content-Type': 'application/json',
            'x-goog-api-key': key,
            'Authorization': `Bearer ${key}`
        };

        return { baseUrl, headers };
    },

    async ping(url, key) {
        const { baseUrl, headers } = this._normalize(url, key);
        const res = await fetch(`${baseUrl}/models`, { method: 'GET', headers });
        if (!res.ok) throw new Error(await res.text());
        return true;
    },

    async getModels(url, key) {
        const { baseUrl, headers } = this._normalize(url, key);

        const res = await fetch(`${baseUrl}/models`, { method: 'GET', headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (data.models && Array.isArray(data.models)) {
            return data.models.map(m => m.name.replace('models/', '').replace('publishers/google/models/', ''));
        }
        return [];
    },

    async test(url, key, model) {
        const { baseUrl, headers } = this._normalize(url, key);

        const modelPath = model.includes('/') ? model : `models/${model}`;
        const endpoint = `${baseUrl}/${modelPath}:generateContent`;

        const payload = {
            contents: [{ role: 'user', parts: [{ text: 'Say exactly: "System Online." and nothing else.' }] }],
            generationConfig: { maxOutputTokens: 15 }
        };

        const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'ПУСТОЙ ОТВЕТ';
    },

    async generateStream({ url, key, model, messages, samplers, replyRaw, prefillTag, signal, onLog }) {
        const { baseUrl, headers } = this._normalize(url, key);
        const isStreaming = samplers.stream !== false;

        const modelPath = model.includes('/') ? model : `models/${model}`;
        const endpoint = isStreaming
            ? `${baseUrl}/${modelPath}:streamGenerateContent?alt=sse`
            : `${baseUrl}/${modelPath}:generateContent`;

        const systemLines = messages
            .filter(m => (m.role || '').toLowerCase() === 'system')
            .map(m => m.content)
            .join('\n\n');

        const geminiContents = [];
        const chatMsgs = messages.filter(m => (m.role || '').toLowerCase() !== 'system');

        chatMsgs.forEach(m => {
            const safeRole = (m.role || '').toLowerCase();
            const mappedRole = safeRole === 'assistant' ? 'model' : 'user';

            const newParts = [{ text: m.content }];
            if (m.images && m.images.length > 0) {
                m.images.forEach(imgDataUrl => {
                    const match = imgDataUrl.match(/^data:(.*?);base64,(.*)$/);
                    if (match) {
                        newParts.push({
                            inlineData: {
                                mimeType: match[1],
                                data: match[2]
                            }
                        });
                    }
                });
            }

            if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === mappedRole) {
                const targetMsg = geminiContents[geminiContents.length - 1];
                if (targetMsg.parts[0].text !== undefined) {
                    targetMsg.parts[0].text += '\n\n' + m.content;
                } else {
                    targetMsg.parts.push({ text: '\n\n' + m.content });
                }

                if (newParts.length > 1) {
                    targetMsg.parts.push(...newParts.slice(1));
                }
            } else {
                geminiContents.push({
                    role: mappedRole,
                    parts: newParts
                });
            }
        });

        if (prefillTag) {
            if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === 'model') {
                geminiContents[geminiContents.length - 1].parts[0].text += `\n\n${prefillTag}\n`;
            } else {
                geminiContents.push({
                    role: 'model',
                    parts: [{ text: `${prefillTag}\n` }]
                });
            }
        }

        const payload = {
            contents: geminiContents,
            generationConfig: {
                maxOutputTokens: samplers.max_tokens,
                temperature: samplers.temperature,
                topP: samplers.top_p
            },
            safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
                { category: "HARM_CATEGORY_JAILBREAK", threshold: "OFF" },
                { category: "HARM_CATEGORY_IMAGE_HATE", threshold: "OFF" },
                { category: "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_IMAGE_HARASSMENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT", threshold: "OFF" }
            ]
        };

        if (systemLines.trim()) {
            payload.systemInstruction = {
                parts: [{ text: systemLines.trim() }]
            };
        }

        if (samplers.reasoning_effort && samplers.reasoning_effort !== 'auto') {
            let effort = samplers.reasoning_effort;
            const isGemini3 = model.includes('gemini-3');

            if (isGemini3) {
                if (effort === 'min') effort = 'minimal';
                if (effort === 'max') effort = 'high';

                payload.generationConfig.thinkingConfig = {
                    thinkingLevel: effort.toUpperCase()
                };
            } else {
                let budget = -1;
                if (effort === 'min' || effort === 'low') budget = 1024;
                else if (effort === 'medium') budget = 8192;
                else if (effort === 'high' || effort === 'max') budget = 24576;

                if (budget !== -1) {
                    payload.generationConfig.thinkingConfig = {
                        thinkingBudget: budget
                    };
                }
            }
        }

        // ==========================================
        // ДАТЧИКИ ДЛЯ КОНСОЛИ ШЛЮЗА
        // ==========================================
        let response;
        let fullGeneratedText = "";
        let errorStatus = null;
        let rawResponseData = null;

        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: signal
            });
        } catch (err) {
            errorStatus = '500 FETCH ERROR';
            rawResponseData = { error: { message: "Google Fetch Error: " + err.message } };
            if (onLog) onLog(payload, rawResponseData, errorStatus);

            if (!replyRaw.headersSent) {
                replyRaw.statusCode = 500;
                replyRaw.setHeader('Content-Type', 'application/json');
                replyRaw.end(JSON.stringify({ error: { message: "Google Fetch Error: " + err.message } }));
            } else if (!replyRaw.writableEnded) {
                replyRaw.write(`data: ${JSON.stringify({ error: "Google Fetch Error: " + err.message })}\n\n`);
                replyRaw.end();
            }
            return;
        }

        // ==========================================
        //  ПАРСИНГ HTTP ОШИБОК (ДО СТРИМА)
        // ==========================================
        if (!response.ok) {
            const errText = await response.text();
            let errMsg = errText.slice(0, 500);
            try {
                const errJson = JSON.parse(errText);
                if (errJson.error && errJson.error.message) {
                    errMsg = errJson.error.message;
                }
            } catch (e) { /* сырой текст */ }

            console.error(`[GEMINI HTTP ERROR] ${response.status}: ${errMsg}`);

            errorStatus = `${response.status} ERROR`;
            rawResponseData = { error: { message: errMsg, raw: errText } };
            if (onLog) onLog(payload, rawResponseData, errorStatus);

            if (!replyRaw.headersSent) {
                replyRaw.statusCode = response.status;
                replyRaw.setHeader('Content-Type', 'application/json');
                replyRaw.end(JSON.stringify({ error: { message: `Gemini API Error (${response.status}): ${errMsg}` } }));
            } else if (!replyRaw.writableEnded) {
                replyRaw.write(`data: ${JSON.stringify({ error: `Ошибка API (${response.status}): ${errMsg}` })}\n\n`);
                replyRaw.end();
            }
            return;
        }

        // ==========================================
        // ВЕТКА БЕЗ СТРИМИНГА
        // ==========================================
        if (!isStreaming) {
            try {
                const data = await response.json();
                rawResponseData = data;
                fullGeneratedText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ chunk: fullGeneratedText })}\n\n`);
                }
            } catch (err) {
                errorStatus = '500 PARSE ERROR';
                rawResponseData = { error: "Gemini Parse Error" };
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Gemini Parse Error" })}\n\n`);
                }
            } finally {
                if (onLog) onLog(payload, rawResponseData, errorStatus);

                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: [DONE]\n\n`);
                    replyRaw.end();
                }
            }
            return;
        }

        // ==========================================
        // ПАРСИНГ СТРИМА (ЛОВИТ ЦЕНЗУРУ И ОБРЫВЫ БЕЗ ДЫР)
        // ==========================================
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        const processChunk = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) return;
            if (trimmed === 'data: [DONE]') return;

            try {
                const data = JSON.parse(trimmed.slice(6));

                if (data.error) {
                    throw new Error(data.error.message || JSON.stringify(data.error));
                }

                const candidate = data.candidates?.[0];
                if (!candidate) return;

                const finishReason = candidate.finishReason;
                if (finishReason && finishReason !== 'STOP') {
                    let reasonAlert = `ОБРЫВ ГЕНЕРАЦИИ - ${finishReason}`;
                    errorStatus = `200 STOPPED (${finishReason})`;

                    if (finishReason === 'SAFETY') {
                        reasonAlert = `Сработал фильтр цензуры Gemini (SAFETY)`;
                        console.warn('[GEMINI] Сработала цензура (SAFETY)');
                    } else if (finishReason === 'MAX_TOKENS') {
                        reasonAlert = `Достигнут лимит токенов (MAX_TOKENS)`;
                    } else if (finishReason === 'RECITATION') {
                        reasonAlert = `Копирайт-блокировка (RECITATION)`;
                    }

                    if (!replyRaw.writableEnded) {
                        replyRaw.write(`data: ${JSON.stringify({ error: reasonAlert })}\n\n`);
                    }
                    return;
                }

                const chunk = candidate.content?.parts?.[0]?.text;
                if (chunk) {
                    fullGeneratedText += chunk; // Накапливаем текст
                    if (!replyRaw.writableEnded) {
                        replyRaw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                    }
                }
            } catch (e) {
                if (e.message && !e.message.includes('JSON')) {
                    throw e;
                }
            }
        };

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    processChunk(line);
                }
            }

            if (buffer.trim()) {
                processChunk(buffer);
            }

        } catch (err) {
            if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('aborted'))) {
                console.log('[GOOGLE PROVIDER] Генерация успешно прервана юзером.');
                errorStatus = '499 ABORTED';
                fullGeneratedText += '\n[ПРЕРВАНО ПОЛЬЗОВАТЕЛЕМ]';
                try { reader.cancel().catch(() => { }); } catch (e) { }
            } else {
                console.error(`[GEMINI STREAM ERROR] ${err.message}`);
                errorStatus = '500 STREAM ERROR';
                rawResponseData = { error: err.message };

                if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Обрыв потока Gemini: " + err.message })}\n\n`);
                }
            }
        } finally {
            if (!rawResponseData) {
                rawResponseData = { candidates: [{ content: { parts: [{ text: fullGeneratedText }] } }] };
            }
            if (onLog) onLog(payload, rawResponseData, errorStatus);

            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: [DONE]\n\n`);
                replyRaw.end();
            }
        }
    }
};