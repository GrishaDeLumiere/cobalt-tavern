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

    async generateStream({ url, key, model, messages, samplers, replyRaw, prefillTag, signal, onLog }) {
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

        let processedMessages = [...messages];

        // 1. НАТИВНЫЙ СИСТЕМНЫЙ ПРОМПТ (Если выключен - клеим к первому сообщению User)
        if (samplers.native_system_prompt === false) {
            const systemMsgs = processedMessages.filter(m => m.role === 'system');
            const chatMsgs = processedMessages.filter(m => m.role !== 'system');

            if (systemMsgs.length > 0) {
                const sysText = "[SYSTEM INSTRUCTIONS]\n" + systemMsgs.map(m => m.content).join('\n\n') + "\n\n";
                const firstUserIdx = chatMsgs.findIndex(m => m.role === 'user');

                if (firstUserIdx !== -1) {
                    chatMsgs[firstUserIdx].content = sysText + chatMsgs[firstUserIdx].content;
                } else {
                    // Если сообщений от юзера вдруг нет, создаем
                    chatMsgs.unshift({ role: 'user', content: sysText.trim() });
                }
            }
            processedMessages = chatMsgs;
        }

        // 2. СЛИЯНИЕ В ОДИН ШАГ (Если включен Flatten)
        if (samplers.single_turn_mode === true) {
            const systemMsgs = processedMessages.filter(m => m.role === 'system');
            const chatMsgs = processedMessages.filter(m => m.role !== 'system');

            let combinedText = "";
            let allImages = [];

            chatMsgs.forEach(m => {
                const safeRole = (m.role || 'user').toUpperCase();
                combinedText += `\n\n--- ${safeRole} ---\n${m.content}`;
                if (m.images && m.images.length > 0) {
                    allImages = allImages.concat(m.images);
                }
            });

            const flattenedUserMsg = { role: 'user', content: combinedText.trim() };
            if (allImages.length > 0) flattenedUserMsg.images = allImages;

            processedMessages = [...systemMsgs, flattenedUserMsg];
        }

        // 3. ОБРАБОТКА КАРТИНОК (VISION) С УЧЕТОМ ГАЛОЧКИ
        const finalMessages = processedMessages.map(msg => {
            if (msg.images && msg.images.length > 0 && samplers.send_attachments !== false) {
                const contentParts = [{ type: 'text', text: msg.content }];
                msg.images.forEach(imgBase64 => {
                    contentParts.push({
                        type: 'image_url',
                        image_url: { url: imgBase64 } // OpenAI / OpenRouter формат
                    });
                });
                return { role: msg.role, content: contentParts };
            }
            return { role: msg.role, content: msg.content };
        });

        const payload = {
            model: model,
            messages: finalMessages,
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

        // ==========================================
        // ДАТЧИКИ ДЛЯ КОНСОЛИ ШЛЮЗА
        // ==========================================
        let response;
        let fullGeneratedText = "";
        let errorStatus = null;
        let rawResponseData = null;

        try {
            response = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: signal
            });
        } catch (err) {
            errorStatus = '500 FETCH ERROR';
            rawResponseData = { error: err.message };
            if (onLog) onLog(payload, rawResponseData, errorStatus);

            if (!replyRaw.writableEnded) {
                replyRaw.write(`data: ${JSON.stringify({ error: "Fetch Error: " + err.message })}\n\n`);
                replyRaw.end();
            }
            return;
        }

        if (!response.ok) {
            const errText = await extractError(response);
            errorStatus = `${response.status} ERROR`;
            rawResponseData = { error: errText };
            if (onLog) onLog(payload, rawResponseData, errorStatus); // Пишем лог при 400/500 от API

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
                rawResponseData = data; // Сохраняем сырой ответ
                fullGeneratedText = data.choices?.[0]?.message?.content || '';

                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ chunk: fullGeneratedText })}\n\n`);
                }
            } catch (err) {
                errorStatus = '500 PARSE ERROR';
                rawResponseData = { error: err.message };
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Ошибка парсинга ответа: " + err.message })}\n\n`);
                }
            } finally {
                if (onLog) onLog(payload, rawResponseData, errorStatus); // Пишем лог не-стриминга

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
                                fullGeneratedText += chunk; // Накапливаем текст стрима
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
                errorStatus = '499 ABORTED';
                fullGeneratedText += '\n[ПРЕРВАНО ПОЛЬЗОВАТЕЛЕМ]';
                try { reader.cancel().catch(() => { }); } catch (e) { }
            } else {
                errorStatus = '500 STREAM ERROR';
                rawResponseData = { error: err.message };
                if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Stream Error: " + err.message })}\n\n`);
                }
            }
        } finally {
            if (!rawResponseData) {
                rawResponseData = { choices: [{ message: { content: fullGeneratedText } }] };
            }
            if (onLog) onLog(payload, rawResponseData, errorStatus);

            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: [DONE]\n\n`);
                replyRaw.end();
            }
        }
    }
};