// ФАЙЛ: server/api/providers/google.js

module.exports = {
    _normalize(url, key) {
        let baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;

        if (!baseUrl.includes('googleapis.com') && !baseUrl.match(/\/v1(beta)?$/)) {
            baseUrl += '/v1beta';
        }

        const headers = {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
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

        const isInteractionsAPI = model.includes('deep-research') ||
            model.includes('antigravity') ||
            model.includes('omni') ||
            model.match(/gemma-4/);

        const endpoint = isInteractionsAPI
            ? `${baseUrl}/interactions`
            : `${baseUrl}/${modelPath}:generateContent`;

        const payload = {};

        if (isInteractionsAPI) {
            payload.model = modelPath.replace('models/', '');
            payload.generation_config = { max_output_tokens: 15 };
            payload.input = [{
                type: 'user_input',
                content: [{ type: 'text', text: 'Say exactly: "System Online." and nothing else.' }]
            }];
        } else {
            payload.generationConfig = { maxOutputTokens: 15 };
            payload.contents = [{
                role: 'user',
                parts: [{ text: 'Say exactly: "System Online." and nothing else.' }]
            }];
        }

        const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error(await res.text());

        const data = await res.json();

        if (isInteractionsAPI) {
            const outStep = data.steps?.find(s => s.type === 'model_output');
            return outStep?.content?.map(c => c.text || '').join('') || data.output_text || 'ПУСТОЙ ОТВЕТ (INTERACTIONS)';
        }

        return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || 'ПУСТОЙ ОТВЕТ';
    },

    async generateStream({ url, key, model, messages, samplers, replyRaw, prefillTag, signal, onLog }) {
        const { baseUrl, headers } = this._normalize(url, key);
        const isStreaming = samplers.stream !== false;
        const modelPath = model.includes('/') ? model : `models/${model}`;

        const isInteractionsAPI = samplers.google_interactions_api === true ||
            model.includes('deep-research') ||
            model.includes('antigravity') ||
            model.includes('omni') ||
            model.match(/gemma-4/);

        // АВТО-ДЕТЕКТ АГЕНТОВ: Форсируем Flatten, чтобы избежать ошибки 400 Multiturn
        const isAgentModel = model.includes('antigravity') || model.includes('deep-research');
        if (isAgentModel) {
            samplers.single_turn_mode = true;
        }

        let endpoint;
        if (isInteractionsAPI) {
            endpoint = `${baseUrl}/interactions`;
        } else {
            endpoint = isStreaming
                ? `${baseUrl}/${modelPath}:streamGenerateContent?alt=sse`
                : `${baseUrl}/${modelPath}:generateContent`;
        }

        const systemLines = messages
            .filter(m => (m.role || '').toLowerCase() === 'system')
            .map(m => m.content)
            .join('\n\n');

        const chatMsgs = messages.filter(m => (m.role || '').toLowerCase() !== 'system');
        const geminiContents = [];

        const buildImagePart = (imgDataUrl) => {
            const match = imgDataUrl.match(/^data:(.*?);base64,(.*)$/);
            if (!match) return null;
            return isInteractionsAPI
                ? { type: 'image', mime_type: match[1], data: match[2] }
                : { inlineData: { mimeType: match[1], data: match[2] } };
        };

        const buildTextPart = (textStr) => {
            return isInteractionsAPI
                ? { type: 'text', text: textStr }
                : { text: textStr };
        };

        // 1. СБОРКА ИСТОРИИ (СЛИЯНИЕ ИЛИ МУЛЬТИТУРН)
        if (samplers.single_turn_mode) {
            const combinedParts = [];
            let combinedText = "";

            chatMsgs.forEach((m) => {
                const safeRole = (m.role || '').toUpperCase();
                combinedText += `\n\n--- ${safeRole} ---\n${m.content}`;

                if (m.images && m.images.length > 0) {
                    m.images.forEach(imgUrl => {
                        const imgPart = buildImagePart(imgUrl);
                        if (imgPart) combinedParts.push(imgPart);
                    });
                }
            });

            combinedParts.unshift(buildTextPart(combinedText.trim()));

            geminiContents.push(isInteractionsAPI
                ? { type: 'user_input', content: combinedParts }
                : { role: 'user', parts: combinedParts }
            );
        } else {
            chatMsgs.forEach(m => {
                const safeRole = (m.role || '').toLowerCase();

                const mappedRole = isInteractionsAPI
                    ? (safeRole === 'assistant' ? 'model_output' : 'user_input')
                    : (safeRole === 'assistant' ? 'model' : 'user');

                const newParts = [buildTextPart(m.content)];
                if (m.images && m.images.length > 0) {
                    m.images.forEach(imgUrl => {
                        const imgPart = buildImagePart(imgUrl);
                        if (imgPart) newParts.push(imgPart);
                    });
                }

                const prevMsg = geminiContents.length > 0 ? geminiContents[geminiContents.length - 1] : null;
                const prevRole = prevMsg ? (isInteractionsAPI ? prevMsg.type : prevMsg.role) : null;

                if (prevRole === mappedRole) {
                    const targetParts = isInteractionsAPI ? prevMsg.content : prevMsg.parts;

                    if (targetParts[0].text !== undefined) {
                        targetParts[0].text += '\n\n' + m.content;
                    } else {
                        targetParts.push(buildTextPart('\n\n' + m.content));
                    }
                    if (newParts.length > 1) {
                        targetParts.push(...newParts.slice(1));
                    }
                } else {
                    geminiContents.push(isInteractionsAPI
                        ? { type: mappedRole, content: newParts }
                        : { role: mappedRole, parts: newParts }
                    );
                }
            });
        }

        // 2. БЕЗОПАСНЫЙ PREFILL (ЗАЩИТА ОТ КРАША АГЕНТОВ)
        if (prefillTag) {
            if (samplers.single_turn_mode) {
                const lastMsg = geminiContents[geminiContents.length - 1];
                const targetParts = isInteractionsAPI ? lastMsg.content : lastMsg.parts;
                const hintText = `\n\n${prefillTag}\n`;

                if (targetParts[0].text !== undefined) {
                    targetParts[0].text += hintText;
                } else {
                    targetParts.push(buildTextPart(hintText));
                }
            } else {
                // Обычный Multiturn Prefill
                const prevMsg = geminiContents.length > 0 ? geminiContents[geminiContents.length - 1] : null;
                const isModelMsg = prevMsg ? (isInteractionsAPI ? prevMsg.type === 'model_output' : prevMsg.role === 'model') : false;

                if (isModelMsg) {
                    const targetParts = isInteractionsAPI ? prevMsg.content : prevMsg.parts;
                    targetParts[0].text += `\n\n${prefillTag}\n`;
                } else {
                    geminiContents.push(isInteractionsAPI
                        ? { type: 'model_output', content: [buildTextPart(`${prefillTag}\n`)] }
                        : { role: 'model', parts: [{ text: `${prefillTag}\n` }] }
                    );
                }
            }
        }

        // 3. НАТИВНАЯ СИСТЕМА (ЕСЛИ ВЫКЛЮЧЕНА, ПРЯЧЕМ В ЮЗЕРА)
        if (systemLines.trim() && !samplers.native_system_prompt) {
            const sysText = `[SYSTEM INSTRUCTIONS]\n${systemLines.trim()}\n\n`;
            const firstUserIndex = geminiContents.findIndex(m => isInteractionsAPI ? m.type === 'user_input' : m.role === 'user');

            if (firstUserIndex !== -1) {
                const targetParts = isInteractionsAPI ? geminiContents[firstUserIndex].content : geminiContents[firstUserIndex].parts;
                if (targetParts[0].text !== undefined) {
                    targetParts[0].text = sysText + targetParts[0].text;
                } else {
                    targetParts.unshift(buildTextPart(sysText));
                }
            } else {
                geminiContents.unshift(isInteractionsAPI
                    ? { type: 'user_input', content: [buildTextPart(sysText.trim())] }
                    : { role: 'user', parts: [{ text: sysText.trim() }] }
                );
            }
        }

        const safetySettingsArr = [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" }
        ];

        if (samplers.google_advanced_safety) {
            safetySettingsArr.push(
                { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "OFF" },
                { category: "HARM_CATEGORY_JAILBREAK", threshold: "OFF" }
            );
        }
        if (samplers.send_attachments) {
            safetySettingsArr.push(
                { category: "HARM_CATEGORY_IMAGE_HATE", threshold: "OFF" },
                { category: "HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_IMAGE_HARASSMENT", threshold: "OFF" },
                { category: "HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT", threshold: "OFF" }
            );
        }

        const payload = {};

        // ==========================================
        // СБОРКА PAYLOAD 
        // ==========================================
        if (isInteractionsAPI) {
            payload.model = modelPath.replace('models/', '');
            if (isStreaming) payload.stream = true;

            payload.store = false;
            payload.input = geminiContents;

            payload.generation_config = {
                temperature: samplers.temperature,
                max_output_tokens: samplers.max_tokens,
                top_p: samplers.top_p
            };

            if (!isAgentModel) {
                payload.generation_config.thinking_summaries = 'auto';
            }

            if (samplers.google_send_safety) {
                payload.safety_settings = safetySettingsArr;
            }

            if (systemLines.trim() && samplers.native_system_prompt) {
                payload.system_instruction = { parts: [{ text: systemLines.trim() }] };
            }

            // Для агентов типа Deep Research и Antigravity мы НЕ ШЛЕМ thinking...
            if (samplers.reasoning_effort && samplers.reasoning_effort !== 'auto' && !isAgentModel) {
                let effort = samplers.reasoning_effort;
                const isGemini3 = model.includes('gemini-3');

                if (isGemini3) {
                    if (effort === 'min') effort = 'minimal';
                    if (effort === 'max') effort = 'high';
                    payload.generation_config.thinking_level = effort.toLowerCase();

                } else {
                    let budget = -1;
                    if (effort === 'min' || effort === 'low') budget = 1024;
                    else if (effort === 'medium') budget = 8192;
                    else if (effort === 'high' || effort === 'max') budget = 24576;

                    if (budget !== -1) {
                        payload.generation_config.thinking_budget = budget;
                    }
                }
            }
        } else {
            payload.contents = geminiContents;
            payload.generationConfig = {
                temperature: samplers.temperature,
                maxOutputTokens: samplers.max_tokens,
                topP: samplers.top_p
            };

            if (samplers.google_send_safety) {
                payload.safetySettings = safetySettingsArr;
            }

            if (systemLines.trim() && samplers.native_system_prompt) {
                payload.systemInstruction = { parts: [{ text: systemLines.trim() }] };
            }

            if (samplers.reasoning_effort && samplers.reasoning_effort !== 'auto') {
                let effort = samplers.reasoning_effort;
                const isGemini3 = model.includes('gemini-3');

                if (isGemini3) {
                    if (effort === 'min') effort = 'minimal';
                    if (effort === 'max') effort = 'high';
                    payload.generationConfig.thinkingConfig = { thinkingLevel: effort.toUpperCase() };
                } else {
                    let budget = -1;
                    if (effort === 'min' || effort === 'low') budget = 1024;
                    else if (effort === 'medium') budget = 8192;
                    else if (effort === 'high' || effort === 'max') budget = 24576;

                    if (budget !== -1) {
                        payload.generationConfig.thinkingConfig = { thinkingBudget: budget };
                    }
                }
            }
        }

        let response;
        let fullGeneratedText = "";
        let errorStatus = null;
        let rawResponseData = null;

        const openTag = prefillTag || '<think>';
        const closeTag = openTag.replace('<', '</');

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

        if (!response.ok) {
            const errText = await response.text();
            let errMsg = errText.slice(0, 500);
            try {
                const errJson = JSON.parse(errText);
                if (errJson.error && errJson.error.message) errMsg = errJson.error.message;
            } catch (e) { }

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

        if (!isStreaming) {
            try {
                const data = await response.json();
                rawResponseData = data;

                if (isInteractionsAPI) {
                    let thoughtText = '';
                    const thoughtStep = data.steps?.find(s => s.type === 'thought');
                    if (thoughtStep?.summary && Array.isArray(thoughtStep.summary)) {
                        thoughtText = thoughtStep.summary.map(c => c.text || '').join('');
                    }

                    const outStep = data.steps?.find(s => s.type === 'model_output');
                    const outputText = outStep?.content?.map(c => c.text || '').join('') || data.output_text || '';

                    if (thoughtText) {
                        fullGeneratedText = `${openTag}\n${thoughtText}\n${closeTag}\n\n${outputText}`;
                    } else {
                        fullGeneratedText = outputText;
                    }
                } else {
                    const parts = data.candidates?.[0]?.content?.parts || [];
                    let thoughtText = '';
                    let outputText = '';
                    for (const p of parts) {
                        if (p.thought) thoughtText += p.text || '';
                        else if (p.text) outputText += p.text;
                    }
                    if (thoughtText) {
                        fullGeneratedText = `${openTag}\n${thoughtText}\n${closeTag}\n\n${outputText}`;
                    } else {
                        fullGeneratedText = outputText;
                    }
                }

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

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        // Флаг и теги для перехвата нативных размышлений агента
        let inThoughtStep = false;

        const processChunk = (line) => {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data: ')) return;
            if (trimmed === 'data: [DONE]') return;

            try {
                const data = JSON.parse(trimmed.slice(6));

                if (data.error) {
                    throw new Error(data.error.message || JSON.stringify(data.error));
                }

                // ==========================================
                // INTERACTIONS API PARSER (С ПЕРЕХВАТОМ МЫСЛЕЙ)
                // ==========================================
                if (data.event_type) {
                    if (data.event_type === 'step.start' && data.step?.type === 'thought') {
                        inThoughtStep = true;
                        let chunk = openTag + '\n';
                        if (data.step.summary && Array.isArray(data.step.summary)) {
                            chunk += data.step.summary.map(c => c.text || '').join('');
                        }
                        fullGeneratedText += chunk;
                        if (!replyRaw.writableEnded) {
                            replyRaw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                        }
                    }
                    else if (data.event_type === 'step.stop' && inThoughtStep) {
                        inThoughtStep = false;
                        let chunk = '\n' + closeTag + '\n\n';
                        fullGeneratedText += chunk;
                        if (!replyRaw.writableEnded) {
                            replyRaw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                        }
                    }
                    else if (data.event_type === 'step.delta') {
                        let chunk = "";

                        if (data.delta?.type === 'thought_summary') {
                            if (Array.isArray(data.delta.content)) {
                                chunk = data.delta.content.map(c => c.text || '').join('');
                            } else {
                                chunk = data.delta.text || data.delta.content?.text || '';
                            }
                        }
                        else if (data.delta?.type === 'text' && data.delta.text) {
                            chunk = data.delta.text;
                        }

                        if (chunk) {
                            fullGeneratedText += chunk;
                            if (!replyRaw.writableEnded) {
                                replyRaw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
                            }
                        }
                    }
                    else if (data.event_type === 'error') {
                        const reasonAlert = data.error?.message || `Сбой генерации (Interactions API)`;
                        errorStatus = `200 STOPPED (ERROR)`;
                        if (!replyRaw.writableEnded) {
                            replyRaw.write(`data: ${JSON.stringify({ error: reasonAlert })}\n\n`);
                        }
                    }
                    return;
                }

                // ==========================================
                // ЛЕГАСИ PARSER
                // ==========================================
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
                    fullGeneratedText += chunk;
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
                rawResponseData = {
                    _format: isInteractionsAPI ? 'interactions' : 'generateContent',
                    text: fullGeneratedText
                };
            }
            if (onLog) onLog(payload, rawResponseData, errorStatus);

            if (!replyRaw.writableEnded && !replyRaw.destroyed) {
                replyRaw.write(`data: [DONE]\n\n`);
                replyRaw.end();
            }
        }
    }
};