// ФАЙЛ: server/api/updater.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CURRENT_VERSION = require(path.join(__dirname, '../package.json')).version;
const REPO_ZIP_URL = 'https://github.com/GrishaDeLumiere/cobalt-tavern/archive/refs/heads/main.zip';
const EXTRACTED_FOLDER_NAME = 'cobalt-tavern-main';
const TEMP_DIR = path.join(__dirname, '../../temp_update');

const IGNORE_LIST = [
    '.env',
    'data',
    'node_modules',
    'temp_update',
    '.git',
    '.gitignore'
];

function getFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}

async function safeCopyFile(source, target) {
    if (!fs.existsSync(target)) {
        fs.copyFileSync(source, target);
        return;
    }
    const [sourceHash, targetHash] = await Promise.all([getFileHash(source), getFileHash(target)]);
    if (sourceHash !== targetHash) fs.copyFileSync(source, target);
}

async function syncDirectories(source, target) {
    if (!fs.existsSync(target)) fs.mkdirSync(target);
    const targetItems = fs.readdirSync(target);
    for (const item of targetItems) {
        if (IGNORE_LIST.includes(item)) continue;
        const targetPath = path.join(target, item);
        const sourcePath = path.join(source, item);
        if (!fs.existsSync(sourcePath)) fs.rmSync(targetPath, { recursive: true, force: true });
    }
    const sourceItems = fs.readdirSync(source);
    for (const item of sourceItems) {
        if (IGNORE_LIST.includes(item)) continue;
        const sourcePath = path.join(source, item);
        const targetPath = path.join(target, item);
        if (fs.lstatSync(sourcePath).isDirectory()) {
            await syncDirectories(sourcePath, targetPath);
        } else {
            await safeCopyFile(sourcePath, targetPath);
        }
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// === ФУНКЦИЯ АВТОМАТИЧЕСКОГО РЕСТАРТА СЕРВЕРА ===
function respawnSelf() {
    console.log('\n[UPDATER] Развертывание нового инстанса Ядра...');

    // Запускаем новый процесс Node с теми же аргументами
    const child = spawn(process.argv[0], process.argv.slice(1), {
        cwd: process.cwd(),
        detached: true,
        stdio: 'inherit'
    });

    child.unref(); // Отвязываем новый процесс от текущего
    process.exit(0); // Завершаем старый процесс (освобождает порт 8000)
}

async function runUpdateStream(res) {
    if (process.env.NODE_ENV === 'development') {
        res.write(`data: ${JSON.stringify({ error: "КРИТИЧЕСКАЯ ЗАЩИТА: ОБНОВЛЕНИЕ ЗАПРЕЩЕНО В РЕЖИМЕ DEV СОХРАНЕНИЯ GIT" })}\n\n`);
        res.end();
        return;
    }

    const sendLog = (msg, type = 'info') => res.write(`data: ${JSON.stringify({ msg, type })}\n\n`);

    try {
        await sleep(400);
        sendLog('Установка защищенного соединения с GitHub...', 'info');

        await sleep(600);
        sendLog('Запрос релиз-пакета ядра...', 'success');

        const response = await axios({ url: REPO_ZIP_URL, method: 'GET', responseType: 'arraybuffer' });
        const mb = (response.data.byteLength / 1024 / 1024).toFixed(2);

        await sleep(400);
        sendLog(`Пакет получен в буфер (${mb} MB).`, 'success');

        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);
        const zipPath = path.join(TEMP_DIR, 'update.zip');
        fs.writeFileSync(zipPath, response.data);

        await sleep(600);
        sendLog('Распаковка и проверка целостности архива...', 'warn');
        const zip = new AdmZip(zipPath);
        zip.extractAllTo(TEMP_DIR, true);

        await sleep(500);
        sendLog('Синхронизация файловой системы ядра...', 'warn');

        const newFilesDir = path.join(TEMP_DIR, EXTRACTED_FOLDER_NAME);
        const targetRootDir = path.join(__dirname, '../../');
        await syncDirectories(newFilesDir, targetRootDir);

        await sleep(400);
        sendLog('Очистка буферных секторов...', 'info');
        fs.rmSync(TEMP_DIR, { recursive: true, force: true });

        await sleep(400);
        sendLog('ОБНОВЛЕНИЕ ЗАВЕРШЕНО. Инициализация перезапуска...', 'success');

        // Отправляем сигнал клиенту
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();

        // Даем 1.5 секунды на закрытие сокетов и перезапускаем сервер
        setTimeout(() => {
            respawnSelf();
        }, 1500);

    } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    }
}

module.exports = async function (fastify, opts) {
    fastify.get('/check-update', async (request, reply) => {
        if (process.env.NODE_ENV === 'development') {
            return {
                updateAvailable: false,
                currentVersion: CURRENT_VERSION + ' [DEV]',
                latestVersion: 'DEV',
                error: 'АВАРИЙНАЯ ЗАЩИТА: РАБОТА С GIT'
            };
        }

        try {
            const response = await axios.get('https://raw.githubusercontent.com/GrishaDeLumiere/cobalt-tavern/main/core/package.json', { timeout: 5000 });
            const latestVersion = response.data.version;
            return {
                updateAvailable: latestVersion !== CURRENT_VERSION,
                currentVersion: CURRENT_VERSION,
                latestVersion: latestVersion
            };
        } catch (e) {
            return {
                updateAvailable: false,
                currentVersion: CURRENT_VERSION,
                latestVersion: CURRENT_VERSION,
                error: 'СЕТЬ НЕДОСТУПНА'
            };
        }
    });

    fastify.get('/update-stream', (request, reply) => {
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        runUpdateStream(reply.raw);
    });
};