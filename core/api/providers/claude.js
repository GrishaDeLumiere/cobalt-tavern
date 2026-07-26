module.exports = {
    async ping(url, key) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': key || ''
        };

        const res = await fetch(`${baseUrl}/messages`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'Ping' }], max_tokens: 1 })
        });

        if (res.status === 401 || res.status === 403) {
            const errText = await res.text();
            throw new Error(`ОТКАЗ АВТОРИЗАЦИИ: ${errText.slice(0, 100)}`);
        }
        return true;
    },

    async getModels(url, key) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = { 'Content-Type': 'application/json', 'x-api-key': key || '' };

        try {
            const res = await fetch(`${baseUrl}/models`, { method: 'GET', headers });
            if (!res.ok) return [];

            const data = await res.json();
            if (Array.isArray(data.data)) return data.data.map(m => m.id);
            if (Array.isArray(data)) return data.map(m => m.id || m.name);
            return [];
        } catch (e) {
            return [];
        }
    },

    async test(url, key, model) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': key || ''
        };

        const payload = {
            model: model || 'claude-3-haiku-20240307',
            max_tokens: 15,
            messages: [{ role: 'user', content: 'Say exactly: "System Online." and nothing else.' }]
        };

        const res = await fetch(`${baseUrl}/messages`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText);
        }

        const data = await res.json();
        return data.content?.[0]?.text?.trim() || 'ПУСТОЙ ОТВЕТ ОТ CLAUDE';
    },

    async generateStream({ url, key, model, messages, samplers, replyRaw, prefillTag, signal }) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': key || ''
        };

        let systemPrompt = "";
        const claudeMessages = [];

        for (const msg of messages) {
            // Клод принимает системный промпт отдельно на верхнем уровне JSON, а не в массиве
            if (msg.role === 'system') {
                const text = Array.isArray(msg.content)
                    ? msg.content.map(c => c.text || '').join('\n')
                    : msg.content;
                systemPrompt += (systemPrompt ? "\n\n" : "") + text;
                continue;
            }

            const contentArray = [];

            // Если контент уже массив (из чужого парсера), перебираем его
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) {
                        contentArray.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image_url') {
                        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
                        const match = url?.match(/^data:(.*?);base64,(.*)$/);
                        if (match) {
                            contentArray.push({
                                type: "image",
                                source: { type: "base64", media_type: match[1], data: match[2] }
                            });
                        }
                    }
                }
            } else {
                // Если контент строка (стандарт), мапим картинки
                if (Array.isArray(msg.images)) {
                    msg.images.forEach(imgUrl => {
                        const match = imgUrl.match(/^data:(.*?);base64,(.*)$/);
                        if (match) {
                            contentArray.push({
                                type: "image",
                                source: { type: "base64", media_type: match[1], data: match[2] }
                            });
                        }
                    });
                }
                if (msg.content) {
                    contentArray.push({ type: 'text', text: msg.content });
                }
            }

            const safeRole = msg.role === 'assistant' ? 'assistant' : 'user';

            // ЗАЩИТА ОТ КРАША КЛОДА (он ненавидит пустые строки)
            let finalContent = contentArray.length > 0 ? contentArray : (msg.content || '...');
            if (typeof finalContent === 'string' && finalContent.trim() === '') {
                finalContent = '...';
            }

            claudeMessages.push({
                role: safeRole,
                content: finalContent
            });
        }

        if (prefillTag) {
            claudeMessages.push({
                role: 'assistant',
                content: `${prefillTag}\n`
            });
        }

        const isStreaming = samplers.stream !== false;

        const payload = {
            model: model || 'claude-3-haiku-20240307',
            max_tokens: samplers.max_tokens || 4096,
            temperature: samplers.temperature,
            top_p: samplers.top_p,
            top_k: samplers.top_k,
            system: systemPrompt,
            messages: claudeMessages,
            stream: isStreaming
        };

        if (payload.top_k === undefined || payload.top_k === null) {
            delete payload.top_k;
        }

        let response;
        try {
            response = await fetch(`${baseUrl}/messages`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: signal
            });
        } catch (err) {
            if (!replyRaw.writableEnded) {
                replyRaw.write(`data: ${JSON.stringify({ error: "Fetch Error: " + err.message })}\n\n`);
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

        // === ВЕТКA БЕЗ СТРИМИНГА ===
        if (!isStreaming) {
            try {
                const data = await response.json();
                const fullText = data.content?.[0]?.text || '';
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ chunk: fullText })}\n\n`);
                }
            } catch (err) {
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Parse Error" })}\n\n`);
                }
            } finally {
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: [DONE]\n\n`);
                    replyRaw.end();
                }
            }
            return;
        }

        // === ВЕТКA СО СТРИМИНГОМ ===
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
                    if (trimmed.startsWith('event: ')) continue;

                    if (trimmed.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(trimmed.slice(6));
                            if (data.type === 'content_block_delta' && data.delta?.text) {
                                if (!replyRaw.writableEnded) {
                                    replyRaw.write(`data: ${JSON.stringify({ chunk: data.delta.text })}\n\n`);
                                }
                            }
                        } catch (e) { /* Битый кусок пропускаем */ }
                    }
                }
            }
        } catch (err) {
            if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('aborted'))) {
                console.log('[CLAUDE PROVIDER] Генерация прервана юзером.');
                try { reader.cancel().catch(() => { }); } catch (e) { }
                return;
            }
            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: ${JSON.stringify({ error: "Claude Stream Error: " + err.message })}\n\n`);
            }
        } finally {
            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: [DONE]\n\n`);
                replyRaw.end();
            }
        }
    }
};