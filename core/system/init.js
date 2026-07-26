const fs = require('fs/promises');
const path = require('path');

// Корневая директория, где будет лежать вся база
const ROOT_DATA_DIR = path.join(__dirname, '../../data');
const DEFAULT_USER = 'default-user';

const USER_DIRS = [
    'characters',
    'chats',
    'backgrounds',
    'lorebooks',
    'avatars',
    'plugins',
    'fonts'
];

const defaultSettings = {
    accountName: 'User',
    language: 'ru-ru',
    theme: {
        accentColor: '#66ccff',
        panelColor: '#000000',
        panelColor2: '#0a0014',
        panelOpacity: 60,
        gradientAngle: 135,
        useGradient: false
    },
    render: {
        soundEnabled: false
    }
};

async function checkAndCreateDir(dirPath) {
    try {
        await fs.access(dirPath);
    } catch (e) {
        await fs.mkdir(dirPath, { recursive: true });
        console.log(`[SYS_INIT] Сгенерирован кластер: ${dirPath}`);
    }
}

async function initializeFilesystem() {
    console.log('[SYS_INIT] Холодный запуск файловой подсистемы...');

    // 1. Поднимаем рут-папку /data
    await checkAndCreateDir(ROOT_DATA_DIR);

    // 2. Создаем контейнер дефолтного юзера
    const userDirPath = path.join(ROOT_DATA_DIR, DEFAULT_USER);
    await checkAndCreateDir(userDirPath);

    // 3. Разворачиваем всю архитектуру папок внутри юзера
    for (const dir of USER_DIRS) {
        await checkAndCreateDir(path.join(userDirPath, dir));
    }

    // 4. Проверяем или создаем дефолтный конфиг пользователя
    const settingsPath = path.join(userDirPath, 'settings.json');
    try {
        await fs.access(settingsPath);
        console.log('[SYS_INIT] Профиль юзера найден. Интеграция успешна.');
    } catch (e) {
        await fs.writeFile(settingsPath, JSON.stringify(defaultSettings, null, 4), 'utf-8');
        console.log('[SYS_INIT] Создан дефолтный системный профиль: settings.json');
    }

    console.log('[SYS_INIT] Файловая система готова к работе. Aegis Shield: ON\n');
}

module.exports = { initializeFilesystem, ROOT_DATA_DIR, DEFAULT_USER };