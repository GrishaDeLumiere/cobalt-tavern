// ФАЙЛ: server/api/providers/openai.js

// Вспомогательная функция для красивого вывода ошибок
async function extractError(res) {
    const text = await res.text();
    try {
        const json = JSON.parse(text);
        return json.error?.message || json.message || text;
    } catch (e) {
        return text.slice(0, 150);
    }
}

module.exports = {
    async ping(url, key) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;

        const res = await fetch(`${baseUrl}/models`, { method: 'GET', headers });
        if (!res.ok) {
            const errMsg = await extractError(res);
            throw new Error(errMsg);
        }
        return true;
    },

    async getModels(url, key) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;

        const res = await fetch(`${baseUrl}/models`, { method: 'GET', headers });
        if (!res.ok) {
            const errMsg = await extractError(res);
            throw new Error(errMsg);
        }

        const data = await res.json();
        if (Array.isArray(data.data)) return data.data.map(m => m.id);
        if (Array.isArray(data)) return data.map(m => m.id || m.name);
        return [];
    },

    async test(url, key, model, apiType) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;

        if (apiType === 'openrouter') {
            headers['HTTP-Referer'] = 'http://localhost:8000';
            headers['X-Title'] = 'Cobalt Tavern';
        }

        const payload = {
            model: model,
            messages: [{ role: 'user', content: 'Say exactly: "System Online." and nothing else.' }],
            max_tokens: 15
        };

        const res = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) {
            const errMsg = await extractError(res);
            throw new Error(errMsg);
        }

        const data = await res.json();
        return data.choices?.[0]?.message?.content?.trim() || 'ПУСТОЙ ОТВЕТ';
    },

    async generateStream({ url, key, model, messages, samplers, replyRaw, prefillTag, signal }) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = { 'Content-Type': 'application/json' };
        if (key) headers['Authorization'] = `Bearer ${key}`;

        if (baseUrl.includes('openrouter')) {
            headers['HTTP-Referer'] = 'http://localhost:8000';
            headers['X-Title'] = 'Cobalt Tavern';
        }

        const isStreaming = samplers.stream !== false;
        if (prefillTag) {
            messages.push({
                role: 'assistant',
                content: `${prefillTag}\n`
            });
        }

        const visionMessages = messages.map(msg => {
            if (msg.images && msg.images.length > 0) {
                const contentParts = [{ type: 'text', text: msg.content }];
                msg.images.forEach(imgBase64 => {
                    contentParts.push({
                        type: 'image_url',
                        image_url: { url: imgBase64 }
                    });
                });
                return { role: msg.role, content: contentParts };
            }
            return { role: msg.role, content: msg.content };
        });

        const payload = {
            model: model,
            messages: visionMessages,
            stream: isStreaming,
            max_tokens: samplers.max_tokens,
            temperature: samplers.temperature,
            top_p: samplers.top_p,
            frequency_penalty: samplers.frequency_penalty
        };

        if (samplers.reasoning_effort && samplers.reasoning_effort !== 'auto') {
            let effort = samplers.reasoning_effort;
            if (effort === 'min') effort = 'low';
            if (effort === 'max') effort = 'high';
            payload.reasoning_effort = effort;
        }

        let response;
        try {
            response = await fetch(`${baseUrl}/chat/completions`, {
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
            const errText = await extractError(response);
            if (!replyRaw.writableEnded) {
                replyRaw.write(`data: ${JSON.stringify({ error: errText })}\n\n`);
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
                const fullText = data.choices?.[0]?.message?.content || '';
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ chunk: fullText })}\n\n`);
                }
            } catch (err) {
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Ошибка парсинга ответа: " + err.message })}\n\n`);
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
        // ВЕТКА СО СТРИМИНГОМ
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
                    if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
                        try {
                            const data = JSON.parse(trimmed.slice(6));
                            const chunk = data.choices?.[0]?.delta?.content;
                            if (chunk !== undefined && chunk !== null) {
                                if (!replyRaw.writableEnded) {
                                    replyRaw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                                }
                            }
                        } catch (e) { }
                    }
                }
            }
        } catch (err) {
            if (err.name === 'AbortError' || (err.message && err.message.toLowerCase().includes('aborted'))) {
                console.log('[AI PROVIDER] Генерация успешно прервана юзером.');
                try { reader.cancel().catch(() => { }); } catch (e) { }
                return;
            }
            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: ${JSON.stringify({ error: "Stream Error: " + err.message })}\n\n`);
            }
        } finally {
            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: [DONE]\n\n`);
                replyRaw.end();
            }
        }
    }
};