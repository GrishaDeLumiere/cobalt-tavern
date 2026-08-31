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
    'fonts',
    'personas'
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

const defaultRegexRules = [
    {
        id: 'rx_default_nodisplay',
        name: 'Скрытие тегов <nodisplay>',
        active: true,
        pattern: '<nodisplay>[\\s\\S]*?<\\/nodisplay>',
        replacement: '',
        placement: ['outgoing'],
        flags: 'gi'
    }
];

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

    // 5. КОНФИГ ПЕРЕСКАЗА И ШАБЛОН ПРОМПТА (summarize_config.json)
    const summarizeConfigPath = path.join(userDirPath, 'summarize_config.json');
    const defaultSummarizeConfig = {
        template: `Ты — живой рассказчик, который передаёт события так, чтобы читатель ПОЧУВСТВОВАЛ сцену. Не пиши как вики-конспект. Пиши как пересказ лучшему корешу у костра.

ЗАДАЧА:
Перескажи события диалога, сохранив ВСЕ ключевые моменты, но в живом, образном стиле.

ОБЯЗАТЕЛЬНО:
1. СОХРАНИ ВСЕ ФАКТЫ: события, действия, слова, которые двигают сюжет.
2. ПЕРЕДАЙ ЭМОЦИИ И АТМОСФЕРУ: страх, ярость, похоть, триумф, унижение, безумие. Сцена должна дышать.
3. ПОКАЖИ РЕАКЦИИ ПЕРСОНАЖЕЙ.
4. АКЦЕНТ НА ОСТРЫЕ МОМЕНТЫ: всё, что вызвало сильную реакцию, выпячивай.
5. СОХРАНИ ГРУБОСТЬ И ЖИВОСТЬ ЯЗЫКА: если в тексте есть мат, кровь, пот, страсть — не вылизывай.

СТИЛЬ:
- Короткие, хлёсткие предложения.
- Пиши от третьего лица, но с полным погружением.
- Без канцелярита: "следует отметить", "в ходе событий", "персонаж отреагировал" — всё это ЗАПРЕЩЕНО.

ФОРМАТ:
- Никаких заголовков, списков, оценок.
- Просто живой пересказ.

Диалог:
{{dialogue}}

Пересказ:`,
        max_tokens: 2048,
        temperature: 1,
        top_p: 0.98,
        default_role: 'assistant'
    };
    try {
        await fs.access(summarizeConfigPath);
    } catch (e) {
        await fs.writeFile(summarizeConfigPath, JSON.stringify(defaultSummarizeConfig, null, 4), 'utf-8');
        console.log('[SYS_INIT] Создан конфигурационный файл пересказа: summarize_config.json');
    }

    // 6. ИЗОЛИРОВАННАЯ БАЗА REGEX-ФИЛЬТРОВ (С АВТОМИГРАЦИЕЙ СТАРЫХ ПРАВИЛ)
    const regexPath = path.join(userDirPath, 'regex_rules.json');
    try {
        await fs.access(regexPath);
        console.log('[SYS_INIT] База Regex-правил найдена: regex_rules.json');

        try {
            const rawSettings = await fs.readFile(settingsPath, 'utf-8');
            const parsedSettings = JSON.parse(rawSettings);
            if (parsedSettings.regexRules && Array.isArray(parsedSettings.regexRules) && parsedSettings.regexRules.length > 0) {
                const currentRegexRaw = await fs.readFile(regexPath, 'utf-8');
                const currentRegex = JSON.parse(currentRegexRaw);

                const existingIds = new Set(currentRegex.map(r => r.id));
                const toMigrate = parsedSettings.regexRules.filter(r => !existingIds.has(r.id));

                if (toMigrate.length > 0) {
                    const merged = [...currentRegex, ...toMigrate];
                    await fs.writeFile(regexPath, JSON.stringify(merged, null, 4), 'utf-8');
                    console.log(`[SYS_MIGRATION] Дополнительно перенесено ${toMigrate.length} правил в regex_rules.json`);
                }

                delete parsedSettings.regexRules;
                await fs.writeFile(settingsPath, JSON.stringify(parsedSettings, null, 4), 'utf-8');
            }
        } catch (mErr) { }

    } catch (e) {
        let migratedRules = [...defaultRegexRules];
        let foundOldRules = false;

        try {
            const rawSettings = await fs.readFile(settingsPath, 'utf-8');
            const parsedSettings = JSON.parse(rawSettings);

            if (parsedSettings.regexRules && Array.isArray(parsedSettings.regexRules) && parsedSettings.regexRules.length > 0) {
                const userOldRules = parsedSettings.regexRules;
                const hasNodisplay = userOldRules.some(r => r.id === 'rx_default_nodisplay' || (r.pattern && r.pattern.includes('nodisplay')));

                migratedRules = hasNodisplay ? userOldRules : [...userOldRules, ...defaultRegexRules];
                foundOldRules = true;
                console.log(`[SYS_MIGRATION] ОБНАРУЖЕНО ${userOldRules.length} СТАРЫХ REGEX-ПРАВИЛ! Запуск миграции...`);

                delete parsedSettings.regexRules;
                await fs.writeFile(settingsPath, JSON.stringify(parsedSettings, null, 4), 'utf-8');
                console.log('[SYS_MIGRATION] Файл settings.json успешно очищен от старых правил.');
            }
        } catch (readErr) { }

        await fs.writeFile(regexPath, JSON.stringify(migratedRules, null, 4), 'utf-8');
        if (foundOldRules) {
            console.log(`[SYS_INIT] МИГРАЦИЯ УСПЕШНА: Все ${migratedRules.length} правил сохранены в regex_rules.json`);
        } else {
            console.log('[SYS_INIT] Создана изолированная база регулярных выражений: regex_rules.json');
        }
    }

    // 7. МИГРАЦИЯ ПЕРСОН (Разделение монолита personas_db.json на модули)
    const oldPersonasDbPath = path.join(userDirPath, 'personas_db.json');
    const personasDir = path.join(userDirPath, 'personas');
    const personasOrderPath = path.join(userDirPath, 'personas_order.json');
    try {
        await fs.access(oldPersonasDbPath);
        const rawOldPersonas = await fs.readFile(oldPersonasDbPath, 'utf-8');
        const parsedOld = JSON.parse(rawOldPersonas).personas || [];

        console.log(`[SYS_MIGRATION] ОБНАРУЖЕН МОНОЛИТ ПЕРСОН! Начинаю разрезку ${parsedOld.length} субъектов...`);
        let order = [];
        for (const p of parsedOld) {
            if (!p.id) p.id = `user_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            await fs.writeFile(path.join(personasDir, `${p.id}.json`), JSON.stringify(p, null, 4), 'utf-8');
            order.push(p.id);
        }
        await fs.writeFile(personasOrderPath, JSON.stringify(order), 'utf-8');

        // Бэкапим старый файл, чтобы он больше не мешал
        await fs.rename(oldPersonasDbPath, path.join(userDirPath, 'personas_db.backup.json'));
        console.log('[SYS_MIGRATION] Миграция персон успешно завершена! Архитектура разделена на модули.');
    } catch (e) {
        // Если файла нет, значит база уже разделена или чистая, игнорим
    }

    console.log('[SYS_INIT] Файловая система готова к работе. Aegis Shield: ON\n');
}

module.exports = { initializeFilesystem, ROOT_DATA_DIR, DEFAULT_USER };