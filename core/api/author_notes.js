// ФАЙЛ: server/api/author_notes.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('../system/init');

const getNotesPath = () => path.join(ROOT_DATA_DIR, DEFAULT_USER, 'author_notes.json');

module.exports = async function (fastify, opts) {
    fastify.get('/author_notes', async (request, reply) => {
        try {
            const data = await fs.readFile(getNotesPath(), 'utf-8');
            return JSON.parse(data);
        } catch (e) {
            reply.code(500).send({ error: 'Ошибка чтения базы заметок' });
        }
    });

    fastify.post('/author_notes', async (request, reply) => {
        try {
            await fs.writeFile(getNotesPath(), JSON.stringify(request.body, null, 4), 'utf-8');
            return { success: true };
        } catch (e) {
            reply.code(500).send({ error: 'Ошибка записи базы заметок' });
        }
    });
};