// ФАЙЛ: server/system/init.js
const fs = require('fs/promises');
const path = require('path');
const { defaultThemePresets } = require('./defaultPresets');

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

// Дефолтный конфиг приложения (настройки)
const defaultSettings = {
    accountName: 'GHOST',
    language: 'ru-ru',
    theme: {
        accentColor: '#66ccff',
        gradientColors: ['#000000', '#001229'],
        panelOpacity: 80,
        gradientAngle: 135,
        useGradient: true,
        bgDim: 18,
        bgBloom: 10,
        bgFitting: 'cover',
        baseTextColor: '#ced6e0',
        textColor: '#f5f237',
        thoughtColor: '#808080',
        boldColor: '#ffffff',
        thoughtAltColor: '#a0a0a0',
        soundColor: '#ff9900',
        whisperColor: '#cc99ff',
        fontFamily: 'Cinzel',
        fontSize: 15,
        enableSmartTracker: false,
        workspaceWidth: 1400,
        fullWidth: false
    },
    render: {
        soundEnabled: false,
        notifyAiDoneBackground: false
    }
};

const defaultBackgroundsConfig = {
    folders: [
        {
            "id": "f_1784655827215",
            "name": "Стандартные",
            "color": "#1a1a24",
            "isExpanded": true
        }
    ],
    backgrounds: [
        {
            "id": "bg_1784655587512_9phd7",
            "name": "Альпы",
            "filename": "bg_1784655587512_9phd7.jpg",
            "url": `/data/${DEFAULT_USER}/backgrounds/bg_1784655587512_9phd7.jpg`,
            "active": true,
            "folderId": "f_1784655827215",
            "color": "#1a1a24"
        }
    ]
};

const defaultAuthorNotesDb = {
    globalDefault: {
        text: '',
        role: 'system',
        position: 'depth',
        depth: 1,
        interval: 1
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

    await checkAndCreateDir(ROOT_DATA_DIR);

    const userDirPath = path.join(ROOT_DATA_DIR, DEFAULT_USER);
    await checkAndCreateDir(userDirPath);

    for (const dir of USER_DIRS) {
        await checkAndCreateDir(path.join(userDirPath, dir));
    }

    // 1. Профиль (settings.json)
    const settingsPath = path.join(userDirPath, 'settings.json');
    try {
        await fs.access(settingsPath);
    } catch (e) {
        await fs.writeFile(settingsPath, JSON.stringify(defaultSettings, null, 4), 'utf-8');
        console.log('[SYS_INIT] Создан дефолтный системный профиль: settings.json');
    }

    // 2. Пресеты тем (theme_presets.json)
    const presetsPath = path.join(userDirPath, 'theme_presets.json');
    try {
        await fs.access(presetsPath);
    } catch (e) {
        await fs.writeFile(presetsPath, JSON.stringify(defaultThemePresets, null, 4), 'utf-8');
        console.log('[SYS_INIT] Сгенерирован пак ААА-пресетов тем: theme_presets.json');
    }

    // 3. БАЗА ФОНОВ (backgrounds.json) И КОПИРОВАНИЕ КАРТИНКИ
    const bgsPath = path.join(userDirPath, 'backgrounds.json');
    try {
        await fs.access(bgsPath);
        console.log('[SYS_INIT] База фонов найдена. Интеграция успешна.');
    } catch (e) {
        await fs.writeFile(bgsPath, JSON.stringify(defaultBackgroundsConfig, null, 4), 'utf-8');
        console.log('[SYS_INIT] Сгенерирована база фонов: backgrounds.json');

        try {
            const sourceImgPath = path.join(__dirname, 'assets', 'bg_1784655587512_9phd7.jpg');
            const destImgPath = path.join(userDirPath, 'backgrounds', 'bg_1784655587512_9phd7.jpg');
            await fs.copyFile(sourceImgPath, destImgPath);
            console.log('[SYS_INIT] Дефолтный фон "Альпы" успешно загружен в систему.');
        } catch (imgError) {
            console.log('\n[SYS_INIT_WARN] ВНИМАНИЕ: Не удалось найти дефолтную картинку фона!');
        }
    }

    // 4. ИЗОЛИРОВАННАЯ БАЗА ЗАМЕТОК (author_notes.json)
    const notesPath = path.join(userDirPath, 'author_notes.json');
    try {
        await fs.access(notesPath);
    } catch (e) {
        await fs.writeFile(notesPath, JSON.stringify(defaultAuthorNotesDb, null, 4), 'utf-8');
        console.log('[SYS_INIT] Создана изолированная база заметок: author_notes.json');
    }

    console.log('[SYS_INIT] Файловая система готова к работе. Aegis Shield: ON\n');
}

module.exports = { initializeFilesystem, ROOT_DATA_DIR, DEFAULT_USER };