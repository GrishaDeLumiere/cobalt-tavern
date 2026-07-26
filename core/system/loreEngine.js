// ФАЙЛ: server/system/loreEngine.js
const fs = require('fs/promises');
const path = require('path');
const { ROOT_DATA_DIR, DEFAULT_USER } = require('./init');

/**
 * Экранирование спецсимволов для регулярки
 */
const escapeRegExp = (string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Базовая проверка ОДНОГО ключа в тексте (с учетом границ слов и регистра)
 */
const isKeyInText = (text, key, exactMatch, caseSensitive) => {
    try {
        // Поддержка кириллицы в границах слов: \b не всегда корректно работает с UTF-8,
        // поэтому используем продвинутую регулярку
        let regexStr = exactMatch ? `(?:^|[^a-zA-Zа-яА-ЯёЁ0-9_])(${escapeRegExp(key)})(?![a-zA-Zа-яА-ЯёЁ0-9_])` : escapeRegExp(key);
        let flags = caseSensitive ? 'g' : 'gi';
        const regex = new RegExp(regexStr, flags);

        return regex.test(text);
    } catch (e) {
        // Фолбек, если регулярка сломалась на кривом ключе
        const targetText = caseSensitive ? text : text.toLowerCase();
        const targetKey = caseSensitive ? key : key.toLowerCase();
        if (exactMatch) {
            const words = targetText.split(/[^a-zA-Zа-яА-ЯёЁ0-9_]+/);
            return words.includes(targetKey);
        } else {
            return targetText.includes(targetKey);
        }
    }
};

/**
 * Шаг 1: Проверка ОСНОВНЫХ ключей (ИЛИ - хотя бы один должен совпасть)
 */
const checkPrimaryKeys = (text, keysStr, exactMatch, caseSensitive) => {
    if (!keysStr || typeof keysStr !== 'string') return false;
    const keys = keysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
    if (keys.length === 0) return false;

    for (const key of keys) {
        if (isKeyInText(text, key, exactMatch, caseSensitive)) return true;
    }
    return false;
};

/**
 * Шаг 2: Проверка ДОП. ФИЛЬТРА (SECONDARY) с применением ЛОГИКИ (AND/NOT)
 */
const checkSecondaryKeys = (text, keysStr, logic, exactMatch, caseSensitive) => {
    if (!keysStr || typeof keysStr !== 'string') return true; // Пустой доп. фильтр игнорируется (пропускает)
    const keys = keysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
    if (keys.length === 0) return true; // Аналогично

    let matchCount = 0;
    for (const key of keys) {
        if (isKeyInText(text, key, exactMatch, caseSensitive)) {
            matchCount++;
        }
    }

    // 0: AND ANY (Хотя бы один из доп. ключей найден)
    if (logic === 0) return matchCount > 0;
    // 3: AND ALL (Обязательно найдены ВСЕ доп. ключи)
    if (logic === 3) return matchCount === keys.length;
    // 1: NOT ALL (Найдены НЕ ВСЕ доп. ключи)
    if (logic === 1) return matchCount < keys.length;
    // 2: NOT ANY (НЕ НАЙДЕН НИ ОДИН из доп. ключей - жесткое исключение)
    if (logic === 2) return matchCount === 0;

    return true; // Фолбек на случай битой логики
};

/**
 * Главный метод сканирования ЛОРБУКОВ
 */
const scanLorebooks = async (chatMessages, charLorebookIds, globalLorebookIds, config) => {
    const loreDir = path.join(ROOT_DATA_DIR, DEFAULT_USER, 'lorebooks');

    // Дефолтные настройки
    const cfg = {
        scanDepth: 10,
        recursion: 1,
        strategy: 'even',
        caseSensitive: false,
        exactMatch: true,
        recursiveScan: true,
        ...config
    };

    const msgsToScan = chatMessages.slice(-cfg.scanDepth);
    let scanText = msgsToScan.map(m => m.mes).join('\n\n');

    const uniqueIds = new Set([...charLorebookIds, ...globalLorebookIds]);
    const loadedBooks = [];

    for (const id of uniqueIds) {
        try {
            const raw = await fs.readFile(path.join(loreDir, `${id}.json`), 'utf-8');
            const parsed = JSON.parse(raw);
            parsed.isCharBook = charLorebookIds.includes(id);
            parsed.isGlobalBook = globalLorebookIds.includes(id);
            loadedBooks.push(parsed);
        } catch (e) { }
    }

    let allNodes = [];
    loadedBooks.forEach(book => {
        book.categories?.forEach(cat => {
            cat.entries?.forEach(node => {
                if (node.active) {
                    allNodes.push({
                        ...node,
                        _bookId: book.id,
                        _bookBudget: book.budget || 2048,
                        _isCharBook: book.isCharBook,
                        _isGlobalBook: book.isGlobalBook
                    });
                }
            });
        });
    });

    let activatedNodes = [];
    let remainingNodes = [...allNodes];

    // --- ПЕРВЫЙ ПРОХОД: Скан основного текста чата ---
    let firstPassActivated = [];

    remainingNodes = remainingNodes.filter(node => {
        const triggerChance = node.trigger !== undefined ? node.trigger : 100;
        if (triggerChance < 100 && (Math.random() * 100 > triggerChance)) {
            return true;
        }

        let isTriggered = false;

        if (node.type === 'constant') {
            isTriggered = true;
        } else if (node.type === 'normal') {
            if (node.delayUntilRecursion) return true;

            isTriggered = checkPrimaryKeys(scanText, node.keys, cfg.exactMatch, cfg.caseSensitive);
            if (isTriggered) {
                isTriggered = checkSecondaryKeys(scanText, node.keysSecondary, node.logic, cfg.exactMatch, cfg.caseSensitive);
            }
        }

        if (isTriggered) {
            firstPassActivated.push(node);
            return false;
        }
        return true;
    });

    activatedNodes.push(...firstPassActivated);

    // --- РЕКУРСИВНОЕ СКАНИРОВАНИЕ ---
    if (cfg.recursiveScan && cfg.recursion > 0) {
        let currentLevelActivated = [...firstPassActivated];
        let stepsLeft = cfg.recursion;

        while (stepsLeft > 0 && currentLevelActivated.length > 0 && remainingNodes.length > 0) {
            let nextLevelActivated = [];

            const recursionText = currentLevelActivated
                .filter(n => !n.preventRecursion)
                .map(n => n.text)
                .join('\n\n');

            if (!recursionText.trim()) break;

            remainingNodes = remainingNodes.filter(node => {
                if (node.excludeRecursion) return true;

                const triggerChance = node.trigger !== undefined ? node.trigger : 100;
                if (triggerChance < 100 && (Math.random() * 100 > triggerChance)) return true;

                if (node.type === 'normal') {
                    let triggered = checkPrimaryKeys(recursionText, node.keys, cfg.exactMatch, cfg.caseSensitive);
                    if (triggered) {
                        triggered = checkSecondaryKeys(recursionText, node.keysSecondary, node.logic, cfg.exactMatch, cfg.caseSensitive);
                    }

                    if (triggered) {
                        nextLevelActivated.push(node);
                        return false;
                    }
                }
                return true;
            });

            activatedNodes.push(...nextLevelActivated);
            currentLevelActivated = nextLevelActivated;
            stepsLeft--;
        }
    }

    // --- СОРТИРОВКА И ВЫРЕЗАНИЕ ПО БЮДЖЕТУ ---
    const booksUsage = {};
    const finalNodes = [];

    activatedNodes.sort((a, b) => {
        if (a.order !== b.order) return (b.order || 100) - (a.order || 100);

        if (cfg.strategy === 'char_first') {
            if (a._isCharBook && !b._isCharBook) return -1;
            if (!a._isCharBook && b._isCharBook) return 1;
        } else if (cfg.strategy === 'global_first') {
            if (a._isGlobalBook && !b._isGlobalBook) return -1;
            if (!a._isGlobalBook && b._isGlobalBook) return 1;
        }
        return 0;
    });

    for (const node of activatedNodes) {
        if (node.ignoreBudget) {
            finalNodes.push(node);
            continue;
        }

        const bId = node._bookId;
        if (!booksUsage[bId]) booksUsage[bId] = 0;

        const nodeTokens = node.tokens || 0;
        if (booksUsage[bId] + nodeTokens <= node._bookBudget) {
            booksUsage[bId] += nodeTokens;
            finalNodes.push(node);
        }
    }

    // --- РАСПРЕДЕЛЕНИЕ ПО ЗОНАМ И ВЫВОД ---
    finalNodes.sort((a, b) => (a.order || 100) - (b.order || 100));

    const result = {
        before: [],
        after: [],
        injections: []
    };

    for (const node of finalNodes) {
        const pos = node.position || '↑Перс. (До описания)';

        if (pos.includes('На глуб.')) {
            let role = 'System';
            if (pos.includes('Юзер')) role = 'User';
            if (pos.includes('Ассистент')) role = 'Assistant';

            result.injections.push({
                isMarker: false,
                role: role,
                text: node.text,
                injection_position: 1,
                injection_depth: node.depth || 0,
                injection_order: node.order || 100,
                _sourceName: node.name
            });
        } else if (pos.includes('↑')) {
            result.before.push(node.text);
        } else if (pos.includes('↓')) {
            result.after.push(node.text);
        } else {
            result.before.push(node.text);
        }
    }

    return {
        before: result.before.join('\n\n'),
        after: result.after.join('\n\n'),
        injections: result.injections
    };
};

module.exports = { scanLorebooks };