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
        // Гугл возвращает { models: [ { name: "models/gemini-pro" } ] }
        if (data.models && Array.isArray(data.models)) {
            // Очищаем префиксы для красоты списка
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

    async generateStream({ url, key, model, messages, samplers, replyRaw, prefillTag, signal }) {
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

        // Сборка диалога для Gemini
        // Сборка диалога для Gemini (С поддержкой VISION API)
        const geminiContents = [];
        const chatMsgs = messages.filter(m => (m.role || '').toLowerCase() !== 'system');

        chatMsgs.forEach(m => {
            const safeRole = (m.role || '').toLowerCase();
            const mappedRole = safeRole === 'assistant' ? 'model' : 'user';

            // Генерируем массив частей для текущего узла (сначала текст, потом прикрепления)
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

            // Gemini ненавидит, когда идут 2 user или 2 model подряд, мы обязаны их мерджить
            if (geminiContents.length > 0 && geminiContents[geminiContents.length - 1].role === mappedRole) {
                const targetMsg = geminiContents[geminiContents.length - 1];
                // Текст клеим к первому 'text' part
                if (targetMsg.parts[0].text !== undefined) {
                    targetMsg.parts[0].text += '\n\n' + m.content;
                } else {
                    targetMsg.parts.push({ text: '\n\n' + m.content });
                }

                // Картинки перекидываем в конец
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
            }
        };

        if (systemLines.trim()) {
            payload.systemInstruction = {
                parts: [{ text: systemLines.trim() }]
            };
        }

        // ==========================================
        // ЛОГИКА REASONING EFFORT (GOOGLE GEMINI)
        // ==========================================
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

        let response;
        try {
            response = await fetch(endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: signal
            });
        } catch (err) {
            if (!replyRaw.writableEnded) {
                replyRaw.write(`data: ${JSON.stringify({ error: "Google Fetch Error: " + err.message })}\n\n`);
                replyRaw.end();
            }
            return;
        }

        if (!response.ok) {
            const errText = await response.text();
            if (!replyRaw.writableEnded) {
                replyRaw.write(`data: ${JSON.stringify({ error: errText.slice(0, 500) })}\n\n`);
                replyRaw.end();
            }
            return;
        }

        // ==========================================
        // Парсинг без стриминга
        // ==========================================
        if (!isStreaming) {
            try {
                const data = await response.json();
                const fullText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ chunk: fullText })}\n\n`);
                }
            } catch (err) {
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Gemini Parse Error" })}\n\n`);
                }
            } finally {
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: [DONE]\n\n`);
                    replyRaw.end();
                }
            }
            return;
        }

        // ==========================================
        // Парсинг стрима
        // ==========================================
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                let lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(trimmed.slice(6));
                            const chunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (chunk && !replyRaw.writableEnded) {
                                replyRaw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                            }
                        } catch (e) { /* Игнорим битые чанки */ }
                    }
                }
            }
        } catch (err) {
            if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('aborted'))) {
                console.log('[GOOGLE PROVIDER] Генерация успешно прервана юзером.');
                try { reader.cancel().catch(() => { }); } catch (e) { }
                return;
            }
            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: ${JSON.stringify({ error: "Gemini Stream Error: " + err.message })}\n\n`);
            }
        } finally {
            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: [DONE]\n\n`);
                replyRaw.end();
            }
        }
    }
};