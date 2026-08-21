// ФАЙЛ: server/api/providers/claude.js

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

    async generateStream({ url, key, model, messages, samplers, replyRaw, prefillTag, signal, onLog }) {
        const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        const headers = {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': key || ''
        };

        let processedMessages = [...messages];

        // 1. ИЗВЛЕКАЕМ СИСТЕМНЫЙ ПРОМПТ
        let systemPrompt = "";
        const systemMsgs = processedMessages.filter(m => m.role === 'system');
        let chatMsgs = processedMessages.filter(m => m.role !== 'system');

        systemPrompt = systemMsgs.map(m => {
            return Array.isArray(m.content) ? m.content.map(c => c.text || '').join('\n') : m.content;
        }).join('\n\n');

        // 2. НАТИВНЫЙ СИСТЕМНЫЙ ПРОМПТ (Вкл/Выкл)
        if (samplers.native_system_prompt === false && systemPrompt.trim()) {
            const sysText = "[SYSTEM INSTRUCTIONS]\n" + systemPrompt.trim() + "\n\n";
            const firstUserIdx = chatMsgs.findIndex(m => m.role === 'user');

            if (firstUserIdx !== -1) {
                chatMsgs[firstUserIdx].content = sysText + chatMsgs[firstUserIdx].content;
            } else {
                chatMsgs.unshift({ role: 'user', content: sysText.trim() });
            }
            systemPrompt = ""; // Очищаем нативный, так как склеили его с User
        }

        // 3. СЛИЯНИЕ В ОДИН ШАГ (Flatten)
        if (samplers.single_turn_mode === true) {
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

            chatMsgs = [flattenedUserMsg];
        }

        // 4. СБОРКА И ФИЛЬТРАЦИЯ КАРТИНОК ДЛЯ КЛОДА
        const claudeMessages = [];

        for (const msg of chatMsgs) {
            const contentArray = [];

            // Если контент уже массив (из чужого парсера), перебираем его
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part.type === 'text' && part.text) {
                        contentArray.push({ type: 'text', text: part.text });
                    } else if (part.type === 'image_url' && samplers.send_attachments !== false) {
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
                // Если контент строка, проверяем массив images
                if (Array.isArray(msg.images) && samplers.send_attachments !== false) {
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

        // ==========================================
        // ДАТЧИКИ ДЛЯ КОНСОЛИ ШЛЮЗА
        // ==========================================
        let response;
        let fullGeneratedText = "";
        let errorStatus = null;
        let rawResponseData = null;

        try {
            response = await fetch(`${baseUrl}/messages`, {
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

        // ==========================================
        //  ПАРСИНГ HTTP ОШИБОК (ДО СТРИМА)
        // ==========================================
        if (!response.ok) {
            const errText = await response.text();
            errorStatus = `${response.status} ERROR`;
            try {
                rawResponseData = JSON.parse(errText);
            } catch (e) {
                rawResponseData = { error: errText.slice(0, 500) };
            }
            if (onLog) onLog(payload, rawResponseData, errorStatus);

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
                rawResponseData = data;
                fullGeneratedText = data.content?.[0]?.text || '';

                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ chunk: fullGeneratedText })}\n\n`);
                }
            } catch (err) {
                errorStatus = '500 PARSE ERROR';
                rawResponseData = { error: "Parse Error" };
                if (!replyRaw.writableEnded) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Parse Error" })}\n\n`);
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
                                fullGeneratedText += data.delta.text; // Накапливаем текст
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
                errorStatus = '499 ABORTED';
                fullGeneratedText += '\n[ПРЕРВАНО ПОЛЬЗОВАТЕЛЕМ]';
                try { reader.cancel().catch(() => { }); } catch (e) { }
            } else {
                errorStatus = '500 STREAM ERROR';
                rawResponseData = { error: err.message };
                if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                    replyRaw.write(`data: ${JSON.stringify({ error: "Claude Stream Error: " + err.message })}\n\n`);
                }
            }
        } finally {
            if (!rawResponseData) {
                rawResponseData = { content: [{ text: fullGeneratedText }] };
            }
            if (onLog) onLog(payload, rawResponseData, errorStatus);

            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: [DONE]\n\n`);
                replyRaw.end();
            }
        }
    }
};