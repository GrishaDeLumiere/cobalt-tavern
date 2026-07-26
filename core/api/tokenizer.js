// ФАЙЛ: server/api/tokenizer.js
const fs = require('fs');
const path = require('path');
const tiktoken = require('tiktoken');
const { Tokenizer } = require('@agnai/web-tokenizers');
const { SentencePieceProcessor } = require('@agnai/sentencepiece-js');

const cache = {
    spp: {},
    web: {},
    tik: {}
};

const guesstimate = (str) => Math.ceil(Buffer.byteLength(str, 'utf8') / 3.35);

module.exports = async function (fastify, opts) {
    const TOK_DIR = path.join(__dirname, 'tokenizers');

    // === ФАБРИКА СЭМПЛЕРОВ ===
    const loadSPP = async (filename) => {
        if (cache.spp[filename]) return cache.spp[filename];
        const filepath = path.join(TOK_DIR, filename);
        if (!fs.existsSync(filepath)) throw new Error('File unlinked');
        const spp = new SentencePieceProcessor();
        await spp.load(filepath);
        cache.spp[filename] = spp;
        return spp;
    };

    const loadWeb = async (filename) => {
        if (cache.web[filename]) return cache.web[filename];
        const filepath = path.join(TOK_DIR, filename);
        if (!fs.existsSync(filepath)) throw new Error('File unlinked');
        const buffer = fs.readFileSync(filepath);
        const tok = await Tokenizer.fromJSON(buffer);
        cache.web[filename] = tok;
        return tok;
    };

    const loadTiktoken = (model = 'gpt-3.5-turbo') => {
        if (cache.tik[model]) return cache.tik[model];
        const enc = tiktoken.encoding_for_model(model);
        cache.tik[model] = enc;
        return enc;
    };

    fastify.post('/tokenizer/count', async (request, reply) => {
        const { text, type = 'tiktoken', modelFile = '' } = request.body;
        if (!text) return { count: 0 };

        try {
            let count = 0;
            if (type === 'spp') { // Llama, Mistral, Gemma...
                const instance = await loadSPP(modelFile);
                count = instance.encodeIds(text).length;
            } else if (type === 'web') { // Claude, Llama3...
                const instance = await loadWeb(modelFile);
                count = instance.encode(text).length;
            } else { // Fallback, OpenAI GPT
                const enc = loadTiktoken('gpt-3.5-turbo');
                count = enc.encode(text).length;
            }
            return { count };
        } catch (err) {
            fastify.log.warn(`[TOKENIZER] Сбой движка (${modelFile}), переход на Guesstimate: ${err.message}`);
            return { count: guesstimate(text) };
        }
    });
};