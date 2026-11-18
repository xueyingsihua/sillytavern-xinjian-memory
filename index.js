// ============================================================================
// SillyTavern 扩展：信笺 · 初晴 | 外置向量记忆库 (RAG)
// 架构特性：
//   1. 双存储系统：本地 IndexedDB（默认，免配置） + GitHub 私人仓库（默认 tavern/ 隔离目录）
//   2. 隔间智能绑定：默认跟随当前酒馆聊天分支名，支持手动改名迁移与共用绑定
//   3. 双端面板：酒馆顶部下拉全景页（档案库/隔间总管/配置） + 跟随悬浮球的精简速控窗
//   4. 深度层直注：手动/自动唤醒记忆均直接通过 setExtensionPrompt 挂载至深度层（默认 @D0）
// ============================================================================

const EXT_KEY = 'chuqing_rag';
const PROMPT_KEY = 'chuqing_rag_memory';
const DB_NAME = 'chuqing_st_rag_db_v1';
const DB_VERSION = 1;
const DB_STORE = 'compartments';
const LS_FALLBACK_CFG = 'chuqing_st_rag_config_v1';
const LS_FALLBACK_BRANCHES = 'chuqing_st_rag_branches_fallback_v1';
const LS_PILL_POS = 'chuqing_st_rag_pill_pos_v1';
const SLICE_PAGE_SIZE = 10;
const PLUGIN_VERSION = '1.0.2';
const PLUGIN_REPO = 'xueyingsihua/sillytavern-xinjian-memory';
const PLUGIN_REMOTE_MANIFEST_URL = `https://raw.githubusercontent.com/${PLUGIN_REPO}/main/manifest.json`;

const DEFAULT_TAGS = ['核心设定', '日常点滴', '重要事件', '偏好习惯', '约定待办', '剧情进度', '感情升温'];

const PRESET_MODELS = {
    gemini: {
        chat: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
        embed: ['text-embedding-004', 'gemini-embedding-001'],
        rerank: ['BAAI/bge-reranker-v2-m3']
    },
    siliconflow: {
        chat: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-R1', 'THUDM/glm-4-9b-chat'],
        embed: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5', 'netease-youdao/bce-embedding-base_v1', 'Pro/BAAI/bge-m3'],
        rerank: ['BAAI/bge-reranker-v2-m3', 'netease-youdao/bce-reranker-base_v1', 'Pro/BAAI/bge-reranker-v2-m3']
    },
    openai: {
        chat: ['gpt-4o-mini', 'gpt-4o', 'deepseek-chat', 'gemini-2.5-flash'],
        embed: ['text-embedding-3-small', 'text-embedding-3-large', 'BAAI/bge-m3'],
        rerank: ['BAAI/bge-reranker-v2-m3']
    }
};

const DEFAULT_SCRAPE_PRESETS = [
    {
        id: 'default_content',
        name: '默认：只抓 <content> 正文 + 清洗自检注释',
        extractTags: ['content'],
        fallbackWhenNoTag: true,
        stripTags: ['think', 'thinking', 'thought', 'status', '状态栏', 'small_theater', 'theater', '小剧场', 'options', 'summary'],
        cleanComments: true,
        keepCommentKeywords: ''
    },
    {
        id: 'full_clean',
        name: '全文模式：不限标签 + 仅洗思维链与自检注释',
        extractTags: [],
        fallbackWhenNoTag: true,
        stripTags: ['think', 'thinking', 'thought', 'status', '状态栏', 'small_theater', 'theater', '小剧场', 'options'],
        cleanComments: true,
        keepCommentKeywords: ''
    }
];

function cloneDefaultScrapePresets() {
    return DEFAULT_SCRAPE_PRESETS.map(p => ({
        ...p,
        extractTags: [...p.extractTags],
        stripTags: [...p.stripTags]
    }));
}

const DEFAULT_SUMMARY_PROMPT = `你是一个专业的 RP 长期记忆切片归档助手。你的任务是从对话正文中提炼用于向量检索（RAG）的「独立记忆切片」，而不是笼统的全文梗概。
规则：
1. 切片数量自适应：若对话仅包含单一简短场景（如 1~6 层），提炼 1~2 条切片；若对话跨越多层或包含多个情节/场景/设定细节（如 10~30+ 层），请按事件转折、关键伏笔、人物关系变化、重要约定或核心设定，自主拆分为多条独立切片（通常每 3~6 层或每个独立事件/关键细节拆为 1 条切片，单批可输出 2~8 条），切勿把长对话强行压缩成单条而丢失重要细节。
2. 单条切片长度与质量：每条切片正文（text）控制在 100~220 字，需独立成篇、前因后果清晰，保留具体人名、地点、器物、关键台词或伏笔细节。
3. 独立打标签与标题：每条切片单独拟定 4~12 字的简短事件名（event），并独立从标签池 [{{tags}}] 中挑选 1~3 个最契合该切片的标签（必要时可自拟 1 个 2~4 字简短新标签）。
4. 客观忠实不回避：本工具服务于虚构文学与角色扮演创作。无论对话涉及日常、冲突还是亲密/成人向（NSFW）互动，均须保持客观中立，如实提炼关键情节、亲密互动细节与情感关系进展，绝不回避、不删减、不道德说教或模糊化处理。
严格只输出 JSON（不要 markdown 代码块）：
{"slices":[{"event":"事件简述","text":"100~220字独立切片内容","tags":["标签1","标签2"]}]}`;

const DEFAULT_CONFIG = {
    storageMode: 'local', // 'local' | 'github'
    githubDirMode: 'isolated', // 'isolated' (tavern/) | 'shared' (root branches/)
    apiProvider: 'gemini', // 'gemini' | 'siliconflow' | 'openai' | 'st_current'
    geminiKey: '',
    geminiBase: 'https://generativelanguage.googleapis.com',
    chatModel: 'gemini-2.5-flash',
    embedProvider: 'same', // 'same' | 'siliconflow' | 'gemini' | 'openai' | 'local'
    embedKey: '',
    embedBase: 'https://api.siliconflow.cn/v1',
    embedModel: 'text-embedding-004',
    rerankEnabled: false,
    rerankModel: 'BAAI/bge-reranker-v2-m3',
    topK: 5,
    minScore: 0.38,
    recallScanFloors: 4,
    autoInjectEnabled: true,
    injectPosition: 1, // 0: IN_PROMPT, 1: IN_CHAT (@depth), 2: BEFORE_PROMPT
    injectDepth: 0, // 默认 @D0 注入，保证前缀 KV Cache 稳定
    injectRole: 0, // 0: SYSTEM, 1: USER, 2: ASSISTANT
    showRecallToast: true,
    autoArchiveEnabled: false,
    autoTurns: 10,
    showFloatingPill: true,
    themeMode: 'day', // 'day' (信笺·初晴) | 'night' (信笺·星夜)
    summaryPrompt: DEFAULT_SUMMARY_PROMPT,
    activeScrapePresetId: 'default_content',
    scrapePresets: cloneDefaultScrapePresets(),
    githubPat: '',
    githubRepo: ''
};

const ROLE_LABELS = ['System', 'User', 'Assistant'];

const state = {
    config: { ...DEFAULT_CONFIG },
    globalProfile: {
        persona: '',
        branchPersonas: {},
        customTags: [...DEFAULT_TAGS],
        branchList: ['tavern_default'],
        sha: null
    },
    chatCompartmentMap: {},
    fetchedModels: {},
    currentChatIdentity: { rawChatId: '', characterName: '', isGroup: false },
    currentCompartment: 'tavern_default',
    isCustomBound: false,
    branchCache: {},
    selectedTags: new Set(['日常点滴']),
    drawerFilterTag: '',
    activeTagFilter: '',
    slicePage: 1,
    slicesCollapsed: false,
    toggledSliceIds: new Set(),
    updateInfo: { checked: false, hasUpdate: false, remoteVersion: '', error: '' },
    lastRecalledSlices: [],
    stagedManualRecall: null, // { query, compartment, recalled, formattedBlock, chatLen }
    lastArchivedFloorMap: {}, // { [rawChatId]: lastArchivedFloorIndex }
    lastScrapedRange: null, // { chatId, startFloor, endFloor, floorCount }
    turnCounter: 0,
    lastCountedMesIndex: -1,
    isAutoArchiving: false,
    panelOpen: false,
    topDrawerOpen: false,
    activePanoramaTab: 'archive',
    initialized: false
};

/* ============================================================================
   1. SillyTavern 上下文与基础工具函数
   ============================================================================ */
function getSTContext() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (e) {
        return null;
    }
}

function parseIntInRange(val, min, max, fallback) {
    const n = parseInt(val, 10);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function generateUUID() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

function getTodayDate() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function utf8ToBase64(str) {
    return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(b64) {
    return decodeURIComponent(escape(atob(String(b64 || '').replace(/\s/g, ''))));
}

function sanitizeCompartmentName(name) {
    const cleaned = String(name || '')
        .replace(/\.jsonl$/i, '')
        .replace(/\.json$/i, '')
        .trim()
        .replace(/[\/\\:*?"<>|#%]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 120);
    return cleaned || 'default';
}

function escapeRegex(str = '') {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTagList(input) {
    const arr = Array.isArray(input) ? input : String(input || '').split(/[,，\n]/);
    return Array.from(new Set(
        arr.map(t => String(t || '').trim().replace(/^[<\/\s]+|[>\s]+$/g, ''))
            .filter(Boolean)
    ));
}

function getActiveScrapePreset() {
    const presets = Array.isArray(state.config.scrapePresets) && state.config.scrapePresets.length
        ? state.config.scrapePresets
        : cloneDefaultScrapePresets();
    return presets.find(p => p.id === state.config.activeScrapePresetId) || presets[0];
}

function cleanMessageText(raw = '', customPreset = null) {
    let text = String(raw || '');
    if (!text.trim()) return '';

    const preset = customPreset || getActiveScrapePreset();
    const stripTags = normalizeTagList(preset.stripTags);
    const extractTags = normalizeTagList(preset.extractTags);
    const cleanComments = preset.cleanComments !== false;
    const fallbackWhenNoTag = preset.fallbackWhenNoTag !== false;
    const keepKeywords = String(preset.keepCommentKeywords || '')
        .split(/[,，\n]/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

    // 1. 先剔除思维链、状态栏、小剧场等干扰组件块
    for (const tag of stripTags) {
        const esc = escapeRegex(tag);
        text = text.replace(new RegExp(`<${esc}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${esc}>`, 'gi'), '');
        if (/^(think|thinking|thought)$/i.test(tag)) {
            text = text.replace(new RegExp(`<${esc}(?:\\s[^>]*)?>[\\s\\S]*$`, 'gi'), '');
        }
    }

    // 2. 按正文标签提取（如 <content>...</content>）
    if (extractTags.length > 0) {
        const alt = extractTags.map(escapeRegex).join('|');
        const pairedRe = new RegExp(`<(${alt})(?:\\s[^>]*)?>([\\s\\S]*?)<\\/\\1>`, 'gi');
        const matches = [];
        let m;
        while ((m = pairedRe.exec(text)) !== null) {
            if (m[2] && m[2].trim()) matches.push(m[2].trim());
        }
        if (matches.length > 0) {
            text = matches.join('\n\n');
        } else {
            const unclosedRe = new RegExp(`<(${alt})(?:\\s[^>]*)?>([\\s\\S]*)$`, 'i');
            const um = unclosedRe.exec(text);
            if (um && um[2]) {
                text = um[2];
            } else if (!fallbackWhenNoTag) {
                return '';
            }
        }
    }

    // 3. 清洗 HTML 注释自检块（支持按白名单关键词保留指定注释）
    if (cleanComments) {
        text = text.replace(/<!--[\s\S]*?-->/g, (block) => {
            if (keepKeywords.length > 0) {
                const lower = block.toLowerCase();
                if (keepKeywords.some(kw => lower.includes(kw))) {
                    return block;
                }
            }
            return '';
        });
    }

    return text.replace(/\n{3,}/g, '\n\n').trim();
}

function getInjectDepthLabel() {
    const pos = parseIntInRange(state.config.injectPosition, 0, 2, 1);
    const depth = parseIntInRange(state.config.injectDepth, 0, 99, 0);
    const role = ROLE_LABELS[parseIntInRange(state.config.injectRole, 0, 2, 0)] || 'System';
    if (pos === 1) return `@D${depth} · ${role}`;
    if (pos === 0) return `In-Prompt · ${role}`;
    return `Before-Prompt · ${role}`;
}

/* ============================================================================
   2. 初晴 Toast 与 Loading 动画
   ============================================================================ */
function showToast(title, message = '', type = 'ok', duration = 3200) {
    let wrap = document.getElementById('cqst-toast-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'cqst-toast-wrap';
        document.body.appendChild(wrap);
    }
    const toast = document.createElement('div');
    toast.className = `cqst-toast ${type}`;
    toast.innerHTML = `
        <div class="cqst-toast-title">${escapeHtml(title)}</div>
        ${message ? `<div class="cqst-toast-msg">${escapeHtml(message)}</div>` : ''}
    `;
    toast.addEventListener('click', () => toast.remove());
    wrap.appendChild(toast);
    setTimeout(() => {
        if (toast.parentNode) {
            toast.style.opacity = '0';
            toast.style.transform = 'translateY(-6px)';
            setTimeout(() => toast.remove(), 220);
        }
    }, duration);
}

function showLoading(sceneText = 'LOADING SCENE', subText = '正在同步记忆与向量...') {
    const backdrop = document.getElementById('cqst-loading-backdrop');
    const box = document.getElementById('cqst-loading-box');
    const sub = document.getElementById('cqst-loading-sub');
    if (!backdrop || !box || !sub) return;
    box.setAttribute('data-text', sceneText);
    sub.textContent = subText;
    backdrop.classList.add('open');
}

function hideLoading() {
    const backdrop = document.getElementById('cqst-loading-backdrop');
    if (backdrop) backdrop.classList.remove('open');
}

/* ============================================================================
   3. 本地存储 (IndexedDB) + 配置持久化
   ============================================================================ */
let dbPromise = null;

function openLocalDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB unavailable'));
            return;
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(DB_STORE)) {
                db.createObjectStore(DB_STORE, { keyPath: 'name' });
            }
        };
        req.onsuccess = (e) => resolve(e.target.result);
        req.onerror = (e) => reject(e.target.error || new Error('IndexedDB open failed'));
    });
    return dbPromise;
}

function readLocalFallbackMap() {
    try {
        return JSON.parse(localStorage.getItem(LS_FALLBACK_BRANCHES) || '{}');
    } catch (e) {
        return {};
    }
}

function writeLocalFallbackMap(map) {
    try {
        localStorage.setItem(LS_FALLBACK_BRANCHES, JSON.stringify(map));
    } catch (e) {
        console.warn('[初晴记忆库] localStorage 兜底写入失败:', e);
    }
}

async function idbGetCompartment(name) {
    try {
        const db = await openLocalDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            const req = store.get(name);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        const map = readLocalFallbackMap();
        return map[name] ? { name, slices: map[name], updatedAt: '' } : null;
    }
}

async function idbPutCompartment(name, slices, remoteSha = undefined, remoteKey = undefined) {
    const prev = remoteSha === undefined ? await idbGetCompartment(name).catch(() => null) : null;
    const record = {
        name,
        slices: Array.isArray(slices) ? slices : [],
        remoteSha: remoteSha !== undefined ? remoteSha : (prev?.remoteSha || null),
        remoteKey: remoteKey !== undefined ? remoteKey : (prev?.remoteKey || ''),
        updatedAt: new Date().toISOString()
    };
    try {
        const db = await openLocalDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            const req = store.put(record);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        const map = readLocalFallbackMap();
        map[name] = record.slices;
        writeLocalFallbackMap(map);
    }
}

async function idbDeleteCompartment(name) {
    try {
        const db = await openLocalDB();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            const req = store.delete(name);
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        const map = readLocalFallbackMap();
        delete map[name];
        writeLocalFallbackMap(map);
    }
}

async function idbListCompartments() {
    try {
        const db = await openLocalDB();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(DB_STORE, 'readonly');
            const store = tx.objectStore(DB_STORE);
            const req = store.getAll();
            req.onsuccess = () => resolve((req.result || []).map(r => ({
                name: r.name,
                count: Array.isArray(r.slices) ? r.slices.length : 0,
                updatedAt: r.updatedAt || ''
            })));
            req.onerror = () => reject(req.error);
        });
    } catch (e) {
        const map = readLocalFallbackMap();
        return Object.keys(map).map(name => ({
            name,
            count: Array.isArray(map[name]) ? map[name].length : 0,
            updatedAt: ''
        }));
    }
}

function loadSettings() {
    const ctx = getSTContext();
    let saved = null;
    if (ctx?.extensionSettings && ctx.extensionSettings[EXT_KEY]) {
        saved = ctx.extensionSettings[EXT_KEY];
    } else {
        try {
            saved = JSON.parse(localStorage.getItem(LS_FALLBACK_CFG) || 'null');
        } catch (e) {
            saved = null;
        }
    }

    if (saved && typeof saved === 'object') {
        if (saved.config && typeof saved.config === 'object') {
            Object.assign(state.config, DEFAULT_CONFIG, saved.config);
            state.config.injectDepth = parseIntInRange(state.config.injectDepth, 0, 99, 0);
            state.config.injectPosition = parseIntInRange(state.config.injectPosition, 0, 2, 1);
            state.config.injectRole = parseIntInRange(state.config.injectRole, 0, 2, 0);
            state.config.recallScanFloors = parseIntInRange(state.config.recallScanFloors, 1, 12, 4);
            state.config.autoTurns = parseIntInRange(state.config.autoTurns, 1, 50, 10);
            state.config.themeMode = state.config.themeMode === 'night' ? 'night' : 'day';
            if (!saved.config.autoArchiveEnabled && saved.config.autoTurns === 5) {
                state.config.autoTurns = 10;
            }
            if (!state.config.summaryPrompt || !String(state.config.summaryPrompt).trim()
                || (state.config.summaryPrompt.includes('切片数量自适应') && !state.config.summaryPrompt.includes('客观忠实不回避'))) {
                state.config.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
            }
            const effEmb = state.config.embedProvider === 'same' ? state.config.apiProvider : state.config.embedProvider;
            if (effEmb === 'siliconflow' && (!state.config.embedModel || state.config.embedModel === 'text-embedding-004')) {
                state.config.embedModel = 'BAAI/bge-m3';
            }
            if (!Array.isArray(state.config.scrapePresets) || state.config.scrapePresets.length === 0) {
                state.config.scrapePresets = cloneDefaultScrapePresets();
            } else {
                state.config.scrapePresets = state.config.scrapePresets.map((p, idx) => ({
                    id: String(p?.id || `preset_${idx}`),
                    name: String(p?.name || `抓取预设 ${idx + 1}`),
                    extractTags: normalizeTagList(p?.extractTags),
                    fallbackWhenNoTag: p?.fallbackWhenNoTag !== false,
                    stripTags: normalizeTagList(p?.stripTags),
                    cleanComments: p?.cleanComments !== false,
                    keepCommentKeywords: String(p?.keepCommentKeywords || '')
                }));
            }
            if (!state.config.scrapePresets.some(p => p.id === state.config.activeScrapePresetId)) {
                state.config.activeScrapePresetId = state.config.scrapePresets[0].id;
            }
        }
        if (saved.globalProfile && typeof saved.globalProfile === 'object') {
            state.globalProfile = {
                persona: typeof saved.globalProfile.persona === 'string' ? saved.globalProfile.persona : '',
                branchPersonas: (saved.globalProfile.branchPersonas && typeof saved.globalProfile.branchPersonas === 'object' && !Array.isArray(saved.globalProfile.branchPersonas))
                    ? saved.globalProfile.branchPersonas
                    : {},
                customTags: Array.isArray(saved.globalProfile.customTags) && saved.globalProfile.customTags.length
                    ? saved.globalProfile.customTags
                    : [...DEFAULT_TAGS],
                branchList: Array.isArray(saved.globalProfile.branchList) && saved.globalProfile.branchList.length
                    ? saved.globalProfile.branchList
                    : ['tavern_default'],
                sha: saved.globalProfile.sha || null
            };
        }
        if (saved.chatCompartmentMap && typeof saved.chatCompartmentMap === 'object' && !Array.isArray(saved.chatCompartmentMap)) {
            state.chatCompartmentMap = { ...saved.chatCompartmentMap };
        }
        if (saved.fetchedModels && typeof saved.fetchedModels === 'object') {
            state.fetchedModels = saved.fetchedModels;
        }
        if (Array.isArray(saved.selectedTagsArr)) {
            state.selectedTags = new Set(saved.selectedTagsArr);
        }
        if (saved.lastArchivedFloorMap && typeof saved.lastArchivedFloorMap === 'object' && !Array.isArray(saved.lastArchivedFloorMap)) {
            state.lastArchivedFloorMap = { ...saved.lastArchivedFloorMap };
        }
    }
}

function saveSettings() {
    const payload = {
        config: { ...state.config },
        globalProfile: {
            persona: state.globalProfile.persona || '',
            branchPersonas: state.globalProfile.branchPersonas || {},
            customTags: state.globalProfile.customTags || [...DEFAULT_TAGS],
            branchList: state.globalProfile.branchList || ['tavern_default'],
            sha: state.globalProfile.sha || null
        },
        chatCompartmentMap: state.chatCompartmentMap || {},
        fetchedModels: state.fetchedModels || {},
        selectedTagsArr: Array.from(state.selectedTags),
        lastArchivedFloorMap: state.lastArchivedFloorMap || {}
    };

    try {
        localStorage.setItem(LS_FALLBACK_CFG, JSON.stringify(payload));
    } catch (e) {}

    const ctx = getSTContext();
    if (ctx?.extensionSettings) {
        ctx.extensionSettings[EXT_KEY] = payload;
        if (typeof ctx.saveSettingsDebounced === 'function') {
            ctx.saveSettingsDebounced();
        }
    }
}

/* ============================================================================
   4. GitHub 私人仓库存储层 (默认 tavern/ 隔离目录，防与外部根目录记忆混杂与覆盖)
   ============================================================================ */
function isGithubConfigured() {
    return Boolean((state.config.githubPat || '').trim() && (state.config.githubRepo || '').trim().includes('/'));
}

function isGithubModeActive() {
    return state.config.storageMode === 'github' && isGithubConfigured();
}

function isGithubIsolatedMode() {
    return (state.config.githubDirMode || 'isolated') !== 'shared';
}

function getGithubProfilePath() {
    return isGithubIsolatedMode() ? 'tavern/global_profile.json' : 'global_profile.json';
}

function getGithubBranchDir() {
    return isGithubIsolatedMode() ? 'tavern/branches' : 'branches';
}

function getGithubBranchPath(name) {
    return `${getGithubBranchDir()}/${sanitizeCompartmentName(name)}.json`;
}

function getGithubRemoteKey(path) {
    return `${(state.config.githubRepo || '').trim()}::${path}`;
}

function encodeGithubPath(path) {
    return path.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

function mergeSlicesNonDestructive(remoteSlices = [], localSlices = []) {
    const byId = new Map();
    for (const s of (Array.isArray(remoteSlices) ? remoteSlices : [])) {
        if (s && s.id) byId.set(s.id, s);
    }
    for (const s of (Array.isArray(localSlices) ? localSlices : [])) {
        if (s && s.id) byId.set(s.id, s);
    }
    return Array.from(byId.values());
}

async function githubReadBlobFallback(repo, pat, path, knownSha = null) {
    let sha = knownSha;
    if (!sha) {
        const parts = path.split('/');
        const fileName = parts.pop();
        const dirPath = parts.join('/');
        const dirUrl = dirPath
            ? `https://api.github.com/repos/${repo}/contents/${encodeGithubPath(dirPath)}?t=${Date.now()}`
            : `https://api.github.com/repos/${repo}/contents?t=${Date.now()}`;
        const dirRes = await fetch(dirUrl, {
            headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' }
        });
        if (!dirRes.ok) throw new Error(`GitHub 目录定位失败 (${dirRes.status})`);
        const items = await dirRes.json();
        const match = Array.isArray(items) && items.find(i => i.path === path || i.name === fileName);
        if (!match || !match.sha) return null;
        sha = match.sha;
    }
    const blobRes = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, {
        headers: { 'Authorization': `Bearer ${pat}`, 'Accept': 'application/vnd.github+json' }
    });
    if (!blobRes.ok) throw new Error(`GitHub Blob 读取失败 (${blobRes.status})`);
    const blobData = await blobRes.json();
    return {
        json: JSON.parse(base64ToUtf8(blobData.content || '')),
        sha: blobData.sha || sha
    };
}

async function githubGetFile(path) {
    const repo = state.config.githubRepo.trim();
    const pat = state.config.githubPat.trim();
    const url = `https://api.github.com/repos/${repo}/contents/${encodeGithubPath(path)}?t=${Date.now()}`;
    const res = await fetch(url, {
        headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github+json'
        }
    });
    if (res.status === 404) return null;
    if (res.status === 403) {
        const errText = await res.text();
        if (errText.includes('too_large')) {
            return await githubReadBlobFallback(repo, pat, path, null);
        }
        throw new Error(`GitHub 读取失败 (${res.status}): ${errText.slice(0, 140)}`);
    }
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GitHub 读取失败 (${res.status}): ${errText.slice(0, 140)}`);
    }
    const data = await res.json();
    if (!data.content || data.encoding === 'none') {
        return await githubReadBlobFallback(repo, pat, path, data.sha || null);
    }
    return {
        json: JSON.parse(base64ToUtf8(data.content)),
        sha: data.sha
    };
}

async function githubPutFile(path, jsonData, sha = null, commitMsg = 'Sync from SillyTavern Chuqing RAG') {
    const repo = state.config.githubRepo.trim();
    const pat = state.config.githubPat.trim();
    const url = `https://api.github.com/repos/${repo}/contents/${encodeGithubPath(path)}`;

    let latestSha = sha;
    if (!latestSha) {
        const existing = await githubGetFile(path).catch(() => null);
        if (existing?.sha) latestSha = existing.sha;
    }

    const bodyObj = {
        message: commitMsg,
        content: utf8ToBase64(JSON.stringify(jsonData))
    };
    if (latestSha) bodyObj.sha = latestSha;

    let res = await fetch(url, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyObj)
    });

    if (res.status === 409) {
        const latest = await githubGetFile(path).catch(() => null);
        if (latest?.sha) {
            bodyObj.sha = latest.sha;
            res = await fetch(url, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${pat}`,
                    'Accept': 'application/vnd.github+json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(bodyObj)
            });
        }
    }

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`GitHub 写入失败 (${res.status}): ${errText.slice(0, 140)}`);
    }
    const result = await res.json();
    return result.content?.sha || null;
}

async function githubDeleteFile(path, sha = null, commitMsg = 'Delete compartment via Chuqing ST RAG') {
    if (!isGithubConfigured()) return;
    const repo = state.config.githubRepo.trim();
    const pat = state.config.githubPat.trim();
    let targetSha = sha;
    if (!targetSha) {
        const existing = await githubGetFile(path).catch(() => null);
        if (!existing?.sha) return;
        targetSha = existing.sha;
    }
    const url = `https://api.github.com/repos/${repo}/contents/${encodeGithubPath(path)}`;
    await fetch(url, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${pat}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message: commitMsg, sha: targetSha })
    });
}

async function githubListBranchFiles(dir = getGithubBranchDir()) {
    if (!isGithubConfigured()) return [];
    const repo = state.config.githubRepo.trim();
    const pat = state.config.githubPat.trim();
    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodeGithubPath(dir)}?t=${Date.now()}`, {
            headers: {
                'Authorization': `Bearer ${pat}`,
                'Accept': 'application/vnd.github+json'
            }
        });
        if (!res.ok) return [];
        const items = await res.json();
        if (!Array.isArray(items)) return [];
        return items
            .filter(item => item.type === 'file' && typeof item.name === 'string' && item.name.endsWith('.json'))
            .map(item => item.name.slice(0, -5));
    } catch (e) {
        return [];
    }
}

function buildGlobalProfilePayload() {
    return {
        persona: state.globalProfile.persona || '',
        branchPersonas: state.globalProfile.branchPersonas || {},
        customTags: state.globalProfile.customTags || [...DEFAULT_TAGS],
        branchList: state.globalProfile.branchList || ['tavern_default'],
        updatedAt: new Date().toISOString()
    };
}

async function syncGlobalProfileFromGithub() {
    if (!isGithubConfigured()) return;
    const profilePath = getGithubProfilePath();
    const [remote, discovered] = await Promise.all([
        githubGetFile(profilePath),
        githubListBranchFiles(getGithubBranchDir())
    ]);

    if (remote?.json) {
        const remoteBranches = Array.isArray(remote.json.branchList) ? remote.json.branchList : [];
        const merged = Array.from(new Set([...state.globalProfile.branchList, ...remoteBranches, ...discovered]));
        const hadNewBranches = merged.length > remoteBranches.length;
        const wasAlreadySynced = Boolean(state.globalProfile.sha);

        state.globalProfile = {
            persona: typeof remote.json.persona === 'string'
                ? (wasAlreadySynced ? remote.json.persona : (remote.json.persona || state.globalProfile.persona))
                : state.globalProfile.persona,
            branchPersonas: (remote.json.branchPersonas && typeof remote.json.branchPersonas === 'object' && !Array.isArray(remote.json.branchPersonas))
                ? { ...state.globalProfile.branchPersonas, ...remote.json.branchPersonas }
                : state.globalProfile.branchPersonas,
            customTags: Array.isArray(remote.json.customTags) && remote.json.customTags.length
                ? Array.from(new Set([...remote.json.customTags, ...state.globalProfile.customTags]))
                : state.globalProfile.customTags,
            branchList: merged,
            sha: remote.sha
        };

        if (hadNewBranches) {
            state.globalProfile.sha = await githubPutFile(profilePath, buildGlobalProfilePayload(), remote.sha, 'Merge branchList from SillyTavern');
        }
    } else {
        state.globalProfile.branchList = Array.from(new Set([...state.globalProfile.branchList, ...discovered]));
        state.globalProfile.sha = await githubPutFile(profilePath, buildGlobalProfilePayload(), null, `Init ${profilePath}`);
    }
    saveSettings();
}

async function pushGlobalProfileIfGithub(commitMsg = 'Update global_profile.json') {
    saveSettings();
    if (!isGithubModeActive()) return;
    const profilePath = getGithubProfilePath();
    if (!state.globalProfile.sha) {
        await syncGlobalProfileFromGithub().catch(() => {});
    }
    state.globalProfile.sha = await githubPutFile(profilePath, buildGlobalProfilePayload(), state.globalProfile.sha, commitMsg);
    saveSettings();
}

/* ============================================================================
   5. 统一双存储门面 (Local IndexedDB + GitHub 私有仓库)
   ============================================================================ */
function ensureCompartmentRegistered(name) {
    if (!name) return;
    if (!state.globalProfile.branchList.includes(name)) {
        state.globalProfile.branchList.push(name);
    }
    if (!state.branchCache[name]) {
        state.branchCache[name] = { slices: [], sha: null, loaded: false };
    }
}

function getCachedSlices(name = state.currentCompartment) {
    ensureCompartmentRegistered(name);
    return state.branchCache[name].slices || [];
}

async function loadCompartment(name, { forceRemote = false } = {}) {
    const target = sanitizeCompartmentName(name);
    ensureCompartmentRegistered(target);

    const localRec = await idbGetCompartment(target);
    const localSlices = (localRec && Array.isArray(localRec.slices)) ? localRec.slices : [];
    if (localRec && Array.isArray(localRec.slices)) {
        state.branchCache[target].slices = localSlices;
        state.branchCache[target].loaded = true;
    }

    if (isGithubModeActive() && (forceRemote || !state.branchCache[target].sha)) {
        try {
            const path = getGithubBranchPath(target);
            const remoteKey = getGithubRemoteKey(path);
            const remote = await githubGetFile(path);
            if (remote?.json) {
                const remoteSlices = Array.isArray(remote.json) ? remote.json : (remote.json.slices || []);
                const wasSyncedHere = Boolean(localRec?.remoteSha && localRec?.remoteKey === remoteKey);
                if (!wasSyncedHere && localSlices.length > 0) {
                    const merged = mergeSlicesNonDestructive(remoteSlices, localSlices);
                    let nextSha = remote.sha;
                    if (merged.length > remoteSlices.length) {
                        nextSha = await githubPutFile(path, merged, remote.sha, `Merge local & remote compartment ${target}`);
                    }
                    state.branchCache[target] = { slices: merged, sha: nextSha, loaded: true };
                    await idbPutCompartment(target, merged, nextSha, remoteKey);
                } else {
                    state.branchCache[target] = { slices: remoteSlices, sha: remote.sha, loaded: true };
                    await idbPutCompartment(target, remoteSlices, remote.sha, remoteKey);
                }
            } else {
                if (localSlices.length > 0) {
                    const newSha = await githubPutFile(path, localSlices, null, `Sync local compartment ${target}`);
                    state.branchCache[target].sha = newSha;
                    await idbPutCompartment(target, localSlices, newSha, remoteKey);
                }
                state.branchCache[target].loaded = true;
            }
        } catch (err) {
            console.warn(`[初晴记忆库] 从 GitHub 加载隔间 [${target}] 失败，继续使用本地缓存:`, err);
            if (forceRemote) throw err;
        }
    } else {
        state.branchCache[target].loaded = true;
    }

    return state.branchCache[target].slices || [];
}

async function saveCompartment(name, slices, commitMsg = 'Update memory slice') {
    const target = sanitizeCompartmentName(name);
    ensureCompartmentRegistered(target);
    let finalSlices = Array.isArray(slices) ? slices : [];
    state.branchCache[target].slices = finalSlices;
    state.branchCache[target].loaded = true;

    await idbPutCompartment(target, finalSlices);
    saveSettings();

    if (isGithubModeActive()) {
        const path = getGithubBranchPath(target);
        const remoteKey = getGithubRemoteKey(path);
        let targetSha = state.branchCache[target].sha || null;

        if (!targetSha) {
            const existingRemote = await githubGetFile(path).catch(() => null);
            if (existingRemote?.json) {
                const remoteSlices = Array.isArray(existingRemote.json) ? existingRemote.json : (existingRemote.json.slices || []);
                finalSlices = mergeSlicesNonDestructive(remoteSlices, finalSlices);
                targetSha = existingRemote.sha;
                state.branchCache[target].slices = finalSlices;
            }
        }

        const newSha = await githubPutFile(path, finalSlices, targetSha, commitMsg);
        state.branchCache[target].sha = newSha;
        await idbPutCompartment(target, finalSlices, newSha, remoteKey);
    }
}

async function pushLocalCompartmentMergedToGithub(name, localSlices, commitMsg) {
    const path = getGithubBranchPath(name);
    const remoteKey = getGithubRemoteKey(path);
    const existing = await githubGetFile(path).catch(() => null);
    let finalSlices = Array.isArray(localSlices) ? localSlices : [];
    let existingSha = null;
    if (existing?.json) {
        const remoteSlices = Array.isArray(existing.json) ? existing.json : (existing.json.slices || []);
        finalSlices = mergeSlicesNonDestructive(remoteSlices, finalSlices);
        existingSha = existing.sha;
    }
    const newSha = await githubPutFile(path, finalSlices, existingSha, commitMsg);
    ensureCompartmentRegistered(name);
    state.branchCache[name].slices = finalSlices;
    state.branchCache[name].sha = newSha;
    state.branchCache[name].loaded = true;
    await idbPutCompartment(name, finalSlices, newSha, remoteKey);
    return finalSlices.length;
}

function resetRemoteShaIfTargetChanged(prevRepo, prevDirMode, nextRepo, nextDirMode) {
    if (prevRepo !== nextRepo || prevDirMode !== nextDirMode) {
        state.globalProfile.sha = null;
        Object.values(state.branchCache).forEach(entry => {
            if (entry) entry.sha = null;
        });
    }
}

/* ============================================================================
   6. 聊天分支识别 & 手动隔间绑定 / 改名逻辑
   ============================================================================ */
function getCurrentChatIdentity(ctx = getSTContext()) {
    if (!ctx) return { rawChatId: '', characterName: '', isGroup: false };
    let rawId = '';
    if (typeof ctx.getCurrentChatId === 'function') {
        rawId = ctx.getCurrentChatId() || '';
    }
    if (!rawId && ctx.chatId) rawId = ctx.chatId;
    if (!rawId && ctx.groupId && Array.isArray(ctx.groups)) {
        const grp = ctx.groups.find(g => g.id === ctx.groupId);
        if (grp?.chat_id) rawId = grp.chat_id;
    }
    if (!rawId && ctx.characterId !== undefined && Array.isArray(ctx.characters)) {
        const ch = ctx.characters[ctx.characterId];
        if (ch?.chat) rawId = ch.chat;
    }
    rawId = String(rawId || '').replace(/\.jsonl$/i, '').trim();
    const charName = ctx.groupId
        ? (ctx.groups?.find(g => g.id === ctx.groupId)?.name || '群聊')
        : (ctx.name2 || ctx.characters?.[ctx.characterId]?.name || '');
    return {
        rawChatId: rawId,
        characterName: String(charName || '').trim(),
        isGroup: Boolean(ctx.groupId)
    };
}

function resolveCompartmentForChat(ctx = getSTContext()) {
    const identity = getCurrentChatIdentity(ctx);
    state.currentChatIdentity = identity;

    if (!identity.rawChatId) {
        return {
            name: state.currentCompartment || 'tavern_default',
            isCustom: false,
            rawChatId: ''
        };
    }

    const mapped = state.chatCompartmentMap[identity.rawChatId];
    if (mapped) {
        return {
            name: sanitizeCompartmentName(mapped),
            isCustom: true,
            rawChatId: identity.rawChatId
        };
    }

    const metaBinding = ctx?.chatMetadata?.chuqing_compartment_binding;
    if (metaBinding && metaBinding.name && metaBinding.chatId === identity.rawChatId) {
        const cleanName = sanitizeCompartmentName(metaBinding.name);
        state.chatCompartmentMap[identity.rawChatId] = cleanName;
        return {
            name: cleanName,
            isCustom: true,
            rawChatId: identity.rawChatId
        };
    }

    return {
        name: sanitizeCompartmentName(identity.rawChatId),
        isCustom: false,
        rawChatId: identity.rawChatId
    };
}

async function persistChatBinding(rawChatId, compartmentName) {
    const ctx = getSTContext();
    if (rawChatId) {
        if (compartmentName) {
            state.chatCompartmentMap[rawChatId] = compartmentName;
        } else {
            delete state.chatCompartmentMap[rawChatId];
        }
    }
    if (ctx?.chatMetadata) {
        if (compartmentName && rawChatId) {
            ctx.chatMetadata.chuqing_compartment_binding = { name: compartmentName, chatId: rawChatId };
        } else {
            delete ctx.chatMetadata.chuqing_compartment_binding;
        }
        if (typeof ctx.saveMetadata === 'function') {
            try {
                await ctx.saveMetadata();
            } catch (e) {}
        }
    }
    saveSettings();
}

async function switchChatToCompartment(targetName, { bindCurrentChat = true, forceRemote = false } = {}) {
    const cleanTarget = sanitizeCompartmentName(targetName);
    const { rawChatId } = state.currentChatIdentity;

    if (bindCurrentChat && rawChatId) {
        const defaultName = sanitizeCompartmentName(rawChatId);
        if (cleanTarget === defaultName) {
            await persistChatBinding(rawChatId, null);
            state.isCustomBound = false;
        } else {
            await persistChatBinding(rawChatId, cleanTarget);
            state.isCustomBound = true;
        }
    }

    if (state.stagedManualRecall && state.stagedManualRecall.compartment !== cleanTarget) {
        clearMountedRecall({ clearPreview: true });
    }

    state.currentCompartment = cleanTarget;
    ensureCompartmentRegistered(cleanTarget);
    saveSettings();
    await loadCompartment(cleanTarget, { forceRemote });
    renderAllUI();
}

async function renameCompartmentAndMigrate(oldName, newName, { deleteOld = true } = {}) {
    const src = sanitizeCompartmentName(oldName);
    const dst = sanitizeCompartmentName(newName);
    if (!dst || src === dst) return false;

    await loadCompartment(src, { forceRemote: isGithubModeActive() });
    const srcSlices = [...getCachedSlices(src)];

    await loadCompartment(dst, { forceRemote: isGithubModeActive() });
    const dstSlices = [...getCachedSlices(dst)];

    let mergedSlices = srcSlices;
    if (dstSlices.length > 0 && srcSlices.length > 0) {
        const ok = confirm(`目标隔间「${dst}」已有 ${dstSlices.length} 条记忆。\n是否将「${src}」的 ${srcSlices.length} 条记忆合并到「${dst}」中？`);
        if (!ok) return false;
        mergedSlices = mergeSlicesNonDestructive(dstSlices, srcSlices);
    } else if (dstSlices.length > 0 && srcSlices.length === 0) {
        mergedSlices = dstSlices;
    }

    await saveCompartment(dst, mergedSlices, `Rename compartment ${src} -> ${dst}`);

    if (state.globalProfile.branchPersonas?.[src] !== undefined) {
        if (!state.globalProfile.branchPersonas[dst]) {
            state.globalProfile.branchPersonas[dst] = state.globalProfile.branchPersonas[src];
        }
        if (deleteOld) {
            delete state.globalProfile.branchPersonas[src];
        }
    }

    const idx = state.globalProfile.branchList.indexOf(src);
    if (deleteOld) {
        if (idx !== -1 && !state.globalProfile.branchList.includes(dst)) {
            state.globalProfile.branchList[idx] = dst;
        } else {
            state.globalProfile.branchList = state.globalProfile.branchList.filter(b => b !== src);
            ensureCompartmentRegistered(dst);
        }
    } else {
        ensureCompartmentRegistered(dst);
    }

    Object.keys(state.chatCompartmentMap).forEach(cid => {
        if (state.chatCompartmentMap[cid] === src) {
            state.chatCompartmentMap[cid] = dst;
        }
    });

    const { rawChatId } = state.currentChatIdentity;
    if (state.currentCompartment === src) {
        state.currentCompartment = dst;
        if (rawChatId) {
            const defaultName = sanitizeCompartmentName(rawChatId);
            if (dst === defaultName) {
                await persistChatBinding(rawChatId, null);
                state.isCustomBound = false;
            } else {
                await persistChatBinding(rawChatId, dst);
                state.isCustomBound = true;
            }
        }
        if (state.stagedManualRecall && state.stagedManualRecall.compartment === src) {
            state.stagedManualRecall.compartment = dst;
        }
    }

    if (deleteOld) {
        const oldSha = state.branchCache[src]?.sha || null;
        delete state.branchCache[src];
        await idbDeleteCompartment(src);
        if (isGithubModeActive()) {
            await githubDeleteFile(getGithubBranchPath(src), oldSha, `Remove old compartment ${src}`).catch(() => {});
        }
    }

    await pushGlobalProfileIfGithub(`Rename compartment ${src} to ${dst}`);
    renderAllUI();
    return true;
}

/* ============================================================================
   7. AI 总结、向量计算 (Embedding)、余弦检索与 Rerank 二次精排
   ============================================================================ */
function compactVector(vec) {
    if (!Array.isArray(vec)) return [];
    return vec.map(v => Math.round(Number(v) * 10000) / 10000);
}

function computeLocalFallbackVector(text) {
    const dim = 128;
    const vec = new Array(dim).fill(0);
    const clean = (text || '').toLowerCase();
    for (let i = 0; i < clean.length; i++) {
        const c1 = clean.charCodeAt(i);
        const c2 = i + 1 < clean.length ? clean.charCodeAt(i + 1) : 0;
        vec[c1 % dim] += 1;
        vec[(c1 * 31 + c2) % dim] += 0.7;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return compactVector(vec.map(v => v / norm));
}

function resolveApiEndpoint(provider, rawKey, rawBase) {
    const key = (rawKey || '').trim();
    const baseTrim = (rawBase || '').trim().replace(/\/+$/, '');
    const baseLower = baseTrim.toLowerCase();

    if (provider === 'local' || provider === 'st_current') {
        return { provider, useOpenAI: false, key, base: baseTrim };
    }

    const useOpenAI = provider === 'siliconflow' ||
        provider === 'openai' ||
        (provider !== 'gemini' && (baseLower.includes('siliconflow') || baseLower.endsWith('/v1') || key.startsWith('sk-')));

    if (useOpenAI) {
        let openAiBase = baseTrim;
        if (!openAiBase || openAiBase.includes('generativelanguage.googleapis.com')) {
            openAiBase = 'https://api.siliconflow.cn/v1';
        } else if (!openAiBase.endsWith('/v1') && !openAiBase.includes('/v1/')) {
            openAiBase = `${openAiBase}/v1`;
        }
        return {
            provider: provider === 'openai' ? 'openai' : 'siliconflow',
            useOpenAI: true,
            key,
            base: openAiBase
        };
    }

    const geminiBase = (!baseTrim || baseLower.includes('siliconflow.cn'))
        ? 'https://generativelanguage.googleapis.com'
        : baseTrim.replace(/\/v1$/, '');
    return { provider: 'gemini', useOpenAI: false, key, base: geminiBase };
}

function getChatApiConfig() {
    return resolveApiEndpoint(state.config.apiProvider || 'gemini', state.config.geminiKey, state.config.geminiBase);
}

function getEmbedApiConfig() {
    const ep = state.config.embedProvider || 'same';
    if (ep === 'local') return { provider: 'local', useOpenAI: false, key: '', base: '' };
    if (ep === 'same') {
        if (state.config.apiProvider === 'st_current') {
            return { provider: 'local', useOpenAI: false, key: '', base: '' };
        }
        return getChatApiConfig();
    }
    return resolveApiEndpoint(ep, state.config.embedKey || state.config.geminiKey, state.config.embedBase);
}

async function getEmbeddingVector(text, strict = false) {
    const cfg = getEmbedApiConfig();
    if (cfg.provider === 'local' || !cfg.key) {
        if (strict && cfg.provider !== 'local') throw new Error('未配置向量 API Key');
        return computeLocalFallbackVector(text);
    }

    if (cfg.useOpenAI) {
        const rawModel = (state.config.embedModel || '').trim();
        const embedModel = (!rawModel || rawModel.includes('text-embedding-004') || rawModel.includes('gemini-embedding'))
            ? (cfg.provider === 'openai' ? 'text-embedding-3-small' : 'BAAI/bge-m3')
            : rawModel;
        let lastErr = '向量接口返回空数据';
        try {
            const res = await fetch(`${cfg.base}/embeddings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${cfg.key}`
                },
                body: JSON.stringify({ model: embedModel, input: text, encoding_format: 'float' })
            });
            if (res.ok) {
                const data = await res.json();
                const emb = data.data?.[0]?.embedding;
                if (Array.isArray(emb)) return compactVector(emb);
            } else {
                lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
            }
        } catch (e) {
            lastErr = e.message || String(e);
        }
        if (strict) throw new Error(lastErr);
        return computeLocalFallbackVector(text);
    }

    const models = Array.from(new Set([state.config.embedModel || 'text-embedding-004', 'gemini-embedding-001']));
    let lastGeminiErr = 'Gemini Embedding 调用失败';
    for (const m of models) {
        try {
            const res = await fetch(`${cfg.base}/v1beta/models/${m}:embedContent?key=${encodeURIComponent(cfg.key)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: `models/${m}`, content: { parts: [{ text }] } })
            });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data.embedding?.values)) return compactVector(data.embedding.values);
            } else {
                lastGeminiErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
            }
        } catch (e) {
            lastGeminiErr = e.message || String(e);
        }
    }
    if (strict) throw new Error(lastGeminiErr);
    return computeLocalFallbackVector(text);
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

function lexicalOverlapScore(query, slice) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return 0;
    const target = `${slice.text || ''} ${(slice.tags || []).join(' ')} ${slice.event || ''}`.toLowerCase();
    let hits = 0;
    for (const ch of q) {
        if (ch.trim() && target.includes(ch)) hits++;
    }
    return (hits / Math.max(q.length, 1)) * 0.25;
}

async function rerankCandidates(queryText, coarseItems, topK, threshold) {
    const cfg = getEmbedApiConfig();
    if (!cfg.key || !cfg.useOpenAI || coarseItems.length <= 1) return null;
    const model = (state.config.rerankModel || '').trim() || 'BAAI/bge-reranker-v2-m3';
    try {
        const docs = coarseItems.map(c => {
            const tagsStr = (c.slice.tags || []).map(t => `#${t}`).join(' ');
            return `${c.slice.date ? '[' + c.slice.date + '] ' : ''}${tagsStr ? tagsStr + ' ' : ''}${c.slice.text || ''}`;
        });
        const res = await fetch(`${cfg.base}/rerank`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.key}`
            },
            body: JSON.stringify({
                model,
                query: queryText,
                documents: docs,
                top_n: docs.length,
                return_documents: false
            })
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!Array.isArray(data.results) || !data.results.length) return null;
        const finalItems = data.results
            .map(r => {
                const orig = coarseItems[r.index];
                if (!orig) return null;
                const rScore = Number(r.relevance_score || 0);
                const fused = (rScore * 0.7) + (orig.score * 0.3) + (orig.exactBonus > 0 ? 0.25 : 0);
                const finalScore = Math.min(0.99, Math.max(orig.score, fused));
                return { slice: orig.slice, score: finalScore };
            })
            .filter(item => item && (threshold <= 0 || item.score >= threshold))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);

        return finalItems.length > 0 ? finalItems : null;
    } catch (e) {
        return null;
    }
}

async function retrieveTopKMemories(queryText, filterTag = '', topK = state.config.topK, minScore = state.config.minScore) {
    let candidates = getCachedSlices(state.currentCompartment);
    if (filterTag) {
        candidates = candidates.filter(s => Array.isArray(s.tags) && s.tags.includes(filterTag));
    }
    if (candidates.length === 0) return [];

    const queryVec = await getEmbeddingVector(queryText);
    const cleanQ = (queryText || '').trim().toLowerCase();
    const threshold = typeof minScore === 'number' ? minScore : 0.38;

    const scoredAll = candidates.map(slice => {
        const cos = cosineSimilarity(queryVec, slice.vector || []);
        const textHay = `${slice.text || ''} ${(slice.tags || []).join(' ')} ${slice.event || ''}`.toLowerCase();
        const exactBonus = (cleanQ.length >= 2 && textHay.includes(cleanQ)) ? 0.25 : 0;
        const lex = lexicalOverlapScore(queryText, slice);
        const score = cos + (exactBonus || lex * 0.5);
        return { slice, score, exactBonus };
    }).sort((a, b) => b.score - a.score);

    const embedCfg = getEmbedApiConfig();
    if (state.config.rerankEnabled && embedCfg.useOpenAI && scoredAll.length > 1) {
        const coarsePool = scoredAll.slice(0, Math.max(topK * 3, 15));
        const reranked = await rerankCandidates(queryText, coarsePool, topK, threshold);
        if (reranked !== null) return reranked;
    }

    return scoredAll
        .filter(item => threshold <= 0 || item.score >= threshold)
        .slice(0, topK)
        .map(({ slice, score }) => ({ slice, score }));
}

function normalizeAiSliceItem(item, fallbackTags) {
    const text = String(item?.text || item?.summary || item?.content || '').trim();
    if (!text) return null;
    const rawTags = Array.isArray(item?.tags)
        ? item.tags
        : (typeof item?.tags === 'string' ? item.tags.split(/[,，、\s]+/) : []);
    const cleanTags = Array.from(new Set(
        rawTags.map(t => String(t || '').trim().replace(/^#+/, '')).filter(Boolean)
    ));
    const safeFallback = Array.isArray(fallbackTags) && fallbackTags.length ? [...fallbackTags] : ['日常点滴'];
    return {
        text,
        tags: cleanTags.length ? cleanTags : safeFallback,
        event: String(item?.event || item?.title || '对话归档').trim() || '对话归档'
    };
}

function parseAiSlicesResponse(reply, fallbackText = '', fallbackTags = []) {
    const safeFallback = Array.isArray(fallbackTags) && fallbackTags.length ? [...fallbackTags] : ['日常点滴'];
    const cleaned = String(reply || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
    const fallbackItem = {
        text: cleaned || String(fallbackText || '').slice(0, 220),
        tags: safeFallback,
        event: '对话归档'
    };

    if (!cleaned) return [fallbackItem];

    let candidate = cleaned;
    const objStart = cleaned.indexOf('{');
    const objEnd = cleaned.lastIndexOf('}');
    const arrStart = cleaned.indexOf('[');
    const arrEnd = cleaned.lastIndexOf(']');
    if (arrStart !== -1 && (objStart === -1 || arrStart < objStart) && arrEnd > arrStart) {
        candidate = cleaned.slice(arrStart, arrEnd + 1);
    } else if (objStart !== -1 && objEnd > objStart) {
        candidate = cleaned.slice(objStart, objEnd + 1);
    }

    try {
        const parsed = JSON.parse(candidate);
        const list = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.slices) ? parsed.slices : [parsed]);
        const normalized = list.map(item => normalizeAiSliceItem(item, safeFallback)).filter(Boolean);
        return normalized.length ? normalized : [fallbackItem];
    } catch (e) {
        return [fallbackItem];
    }
}

function splitSummaryChunks(rawText, maxChunkChars = 7500) {
    const text = String(rawText || '').trim();
    if (!text) return [];
    if (text.length <= 8500) return [text];

    const blocks = text.split(/\n{2,}/);
    const chunks = [];
    let current = '';
    for (const block of blocks) {
        if (!block) continue;
        if (current && current.length + block.length + 2 > maxChunkChars) {
            chunks.push(current);
            current = block;
        } else {
            current = current ? `${current}\n\n${block}` : block;
        }
        while (current.length > maxChunkChars + 1000) {
            chunks.push(current.slice(0, maxChunkChars));
            current = current.slice(maxChunkChars);
        }
    }
    if (current) chunks.push(current);
    return chunks.length ? chunks : [text];
}

async function invokeSummaryApi(sys, chunkText) {
    const provider = state.config.apiProvider || 'gemini';

    if (provider === 'st_current') {
        const ctx = getSTContext();
        if (typeof ctx?.generateQuietPrompt !== 'function') {
            throw new Error('当前酒馆版本不支持 generateQuietPrompt，请改用 Gemini 或硅基流动接口');
        }
        const combined = `${sys}\n\n待提取对话：\n${chunkText}`;
        const fnSrc = Function.prototype.toString.call(ctx.generateQuietPrompt);
        const usesOptionsObj = /^\s*(async\s+)?\w*\s*\(\s*\{/.test(fnSrc);
        const reply = usesOptionsObj
            ? await ctx.generateQuietPrompt({ quietPrompt: combined, skipWIAN: true })
            : await ctx.generateQuietPrompt(combined, false, true);
        return String(reply || '');
    }

    const cfg = getChatApiConfig();
    if (cfg.useOpenAI) {
        const rawModel = (state.config.chatModel || '').trim();
        const model = (!rawModel || rawModel.startsWith('gemini-'))
            ? (cfg.provider === 'openai' ? 'gpt-4o-mini' : 'Qwen/Qwen2.5-7B-Instruct')
            : rawModel;
        const res = await fetch(`${cfg.base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${cfg.key}`
            },
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: sys },
                    { role: 'user', content: chunkText }
                ]
            })
        });
        if (!res.ok) throw new Error(`总结接口调用失败 (${res.status})`);
        const data = await res.json();
        return data.choices?.[0]?.message?.content || '';
    }

    const model = (state.config.chatModel || '').trim() || 'gemini-2.5-flash';
    const res = await fetch(`${cfg.base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cfg.key)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: [{ role: 'user', parts: [{ text: chunkText }] }],
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
                { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' }
            ]
        })
    });
    if (!res.ok) throw new Error(`Gemini 总结失败 (${res.status})`);
    const data = await res.json();
    return data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
}

function buildSummarySystemPrompt() {
    const tagPool = (state.globalProfile.customTags || DEFAULT_TAGS).join('、');
    let sys = String(state.config.summaryPrompt || '').trim() || DEFAULT_SUMMARY_PROMPT;
    if (sys.includes('{{tags}}')) {
        sys = sys.replace(/\{\{\s*tags\s*\}\}/g, tagPool);
    } else {
        sys += `\n可选分类标签池：[${tagPool}]`;
    }
    if (!sys.includes('"slices"')) {
        sys += '\n严格只输出 JSON（不要 markdown 代码块）：\n{"slices":[{"event":"事件简述","text":"100~220字独立切片内容","tags":["标签1","标签2"]}]}';
    }
    const effPersona = getEffectivePersona();
    if (effPersona) {
        sys += `\n\n【当前剧情/隔间补充设定与背景参考】：\n${effPersona}`;
    }
    return sys;
}

async function callSummaryModel(rawText) {
    const fallbackTags = Array.from(state.selectedTags);
    const provider = state.config.apiProvider || 'gemini';
    if (provider !== 'st_current' && !getChatApiConfig().key) {
        const single = {
            text: String(rawText || '').slice(0, 220),
            tags: fallbackTags.length ? fallbackTags : ['日常点滴'],
            event: '对话归档'
        };
        return { slices: [single], ...single };
    }

    const sys = buildSummarySystemPrompt();

    const chunks = splitSummaryChunks(rawText, 7500);
    const allSlices = [];
    for (const chunk of chunks) {
        const reply = await invokeSummaryApi(sys, chunk);
        const parsed = parseAiSlicesResponse(reply, chunk, fallbackTags);
        allSlices.push(...parsed);
    }

    const first = allSlices[0] || {
        text: String(rawText || '').slice(0, 220),
        tags: fallbackTags.length ? fallbackTags : ['日常点滴'],
        event: '对话归档'
    };
    return {
        slices: allSlices.length ? allSlices : [first],
        text: first.text,
        tags: first.tags,
        event: first.event
    };
}

/* ============================================================================
   8. 酒馆对话抓取与深度层 Prompt 挂载拦截器 (@D0 默认直注，不污染输入框)
   ============================================================================ */
function scrapeSillyTavernChat({ mode = 'recent', turns = 5, startFloor = 0, endFloor = 9999, preset = null } = {}) {
    const ctx = getSTContext();
    const chatArr = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const activePreset = preset || getActiveScrapePreset();
    const rawChatId = state.currentChatIdentity.rawChatId || getCurrentChatIdentity(ctx).rawChatId || '';

    if (chatArr.length > 0) {
        const indexedMsgs = chatArr
            .map((m, idx) => ({ m, idx }))
            .filter(({ m }) => m && !m.is_system);

        let selected = [];
        if (mode === 'range') {
            const s = Math.max(0, Math.min(chatArr.length - 1, Number(startFloor) || 0));
            const e = Math.max(s, Math.min(chatArr.length - 1, Number(endFloor) || chatArr.length - 1));
            selected = indexedMsgs.filter(({ idx }) => idx >= s && idx <= e);
        } else if (mode === 'unarchived') {
            const lastFloor = rawChatId ? state.lastArchivedFloorMap?.[rawChatId] : undefined;
            if (Number.isFinite(lastFloor)) {
                selected = indexedMsgs.filter(({ idx }) => idx > lastFloor);
            }
            if (selected.length === 0) {
                selected = indexedMsgs.slice(-Math.max(1, turns * 2));
            }
        } else {
            selected = indexedMsgs.slice(-Math.max(1, turns * 2));
        }

        if (selected.length > 0) {
            state.lastScrapedRange = {
                chatId: rawChatId,
                startFloor: selected[0].idx,
                endFloor: selected[selected.length - 1].idx,
                floorCount: selected.length
            };
        } else {
            state.lastScrapedRange = null;
        }

        const lines = selected.map(({ m }) => {
            const role = m.name || (m.is_user ? (ctx.name1 || '我') : (ctx.name2 || '角色'));
            const text = cleanMessageText(m.mes || '', activePreset);
            return text ? `${role}: ${text}` : '';
        }).filter(Boolean);

        if (lines.length > 0) return lines.join('\n\n');
    }

    state.lastScrapedRange = null;
    const domNodes = Array.from(document.querySelectorAll('#chat .mes:not([is_system="true"])'));
    const recentDom = domNodes.slice(-Math.max(1, turns * 2));
    return recentDom.map(el => {
        const name = el.querySelector('.name_text')?.textContent?.trim() || (el.getAttribute('is_user') === 'true' ? '我' : '角色');
        const body = cleanMessageText(el.querySelector('.mes_text')?.innerText || '', activePreset);
        return body ? `${name}: ${body}` : '';
    }).filter(Boolean).join('\n\n');
}

function getEffectivePersona() {
    const g = (state.globalProfile.persona || '').trim();
    const b = (state.globalProfile.branchPersonas?.[state.currentCompartment] || '').trim();
    return [g, b].filter(Boolean).join('\n\n');
}

function formatRecallPromptBlock(compartmentName, recalled, { includePersona = true } = {}) {
    const lines = [];
    lines.push(`【✉️ 信笺 · 长期记忆档案 (${compartmentName})】`);
    const effPersona = includePersona ? getEffectivePersona() : '';
    if (effPersona) {
        lines.push(`▸ 隔间核心设定：\n${effPersona}`);
    }
    if (recalled && recalled.length > 0) {
        lines.push('▸ 唤醒的过往记忆切片（按向量余弦相似度召回）：');
        recalled.forEach((r, i) => {
            const pct = (r.score * 100).toFixed(0) + '%';
            const tagStr = (r.slice.tags || []).map(t => `#${t}`).join(' ');
            lines.push(`${i + 1}. [${r.slice.date || '过往'} | ${r.slice.event || '记忆'} | ${tagStr} | 相关度 ${pct}]: ${r.slice.text}`);
        });
    }
    lines.push('---');
    return lines.join('\n');
}

function getSTInputDraft() {
    const ta = document.getElementById('send_textarea');
    return ta ? (ta.value || '').trim() : '';
}

function clearExtensionPromptSafe(ctx = getSTContext()) {
    if (typeof ctx?.setExtensionPrompt === 'function') {
        const pos = parseIntInRange(state.config.injectPosition, 0, 2, 1);
        const depth = parseIntInRange(state.config.injectDepth, 0, 99, 0);
        const role = parseIntInRange(state.config.injectRole, 0, 2, 0);
        ctx.setExtensionPrompt(PROMPT_KEY, '', pos, depth, false, role);
    }
}

function mountRecallToDepthLayer(recalled, { query = '', isManual = false } = {}) {
    const ctx = getSTContext();
    const effPersona = getEffectivePersona();
    if ((!recalled || !recalled.length) && !effPersona) {
        clearExtensionPromptSafe(ctx);
        return '';
    }
    const block = formatRecallPromptBlock(state.currentCompartment, recalled, { includePersona: true });
    const pos = parseIntInRange(state.config.injectPosition, 0, 2, 1);
    const depth = parseIntInRange(state.config.injectDepth, 0, 99, 0);
    const role = parseIntInRange(state.config.injectRole, 0, 2, 0);

    if (typeof ctx?.setExtensionPrompt === 'function') {
        ctx.setExtensionPrompt(PROMPT_KEY, block, pos, depth, false, role);
    }

    state.lastRecalledSlices = recalled || [];
    if (isManual) {
        state.stagedManualRecall = {
            query,
            compartment: state.currentCompartment,
            recalled: state.lastRecalledSlices,
            formattedBlock: block,
            chatLen: Array.isArray(ctx?.chat) ? ctx.chat.length : 0
        };
    }
    renderRecallPreview();
    return block;
}

function clearMountedRecall({ clearPreview = false } = {}) {
    state.stagedManualRecall = null;
    if (clearPreview) state.lastRecalledSlices = [];
    clearExtensionPromptSafe();
    renderRecallPreview();
}

function buildRecallScanQuery(chatList = null, scanFloors = state.config.recallScanFloors) {
    const ctx = getSTContext();
    const n = parseIntInRange(scanFloors, 1, 12, 4);
    const list = Array.isArray(chatList) && chatList.length
        ? chatList
        : (Array.isArray(ctx?.chat) ? ctx.chat : []);

    let parts = [];
    if (list.length > 0) {
        const recent = list.filter(m => m && !m.is_system).slice(-n);
        parts = recent.map(m => cleanMessageText(m.mes || '')).filter(Boolean);
    } else {
        const domNodes = Array.from(document.querySelectorAll('#chat .mes:not([is_system="true"])')).slice(-n);
        parts = domNodes.map(el => cleanMessageText(el.querySelector('.mes_text')?.innerText || '')).filter(Boolean);
    }

    const draft = getSTInputDraft();
    if (draft) {
        const cleanedDraft = cleanMessageText(draft) || draft;
        const lastPart = parts[parts.length - 1] || '';
        if (cleanedDraft && cleanedDraft !== lastPart) {
            parts.push(cleanedDraft);
        }
    }

    const combined = parts.join('\n').trim();
    return combined.length > 1800 ? combined.slice(-1800) : combined;
}

async function runManualRecallMount(customQuery = '') {
    const slices = getCachedSlices(state.currentCompartment);
    const effPersona = getEffectivePersona();
    if (!slices.length && !effPersona) {
        showToast('当前隔间为空', `[${state.currentCompartment}] 暂无记忆切片`, 'warn');
        return;
    }

    const typedQ = (customQuery || '').trim();
    const scanFloors = parseIntInRange(state.config.recallScanFloors, 1, 12, 4);
    const autoScannedQ = typedQ ? '' : buildRecallScanQuery(null, scanFloors);
    const query = typedQ || autoScannedQ || '近期重要记忆';
    const hasRealQuery = Boolean(typedQ || autoScannedQ);
    const minScore = hasRealQuery ? state.config.minScore : 0;

    const recalled = slices.length
        ? await retrieveTopKMemories(query, state.activeTagFilter, state.config.topK, minScore)
        : [];

    if (!recalled.length && !effPersona) {
        showToast(
            '未命中相关记忆',
            typedQ
                ? `关键词未命中（阈值 ${(minScore * 100).toFixed(0)}%）`
                : `已扫描最近 ${scanFloors} 楼正文，相关度均低于 ${(minScore * 100).toFixed(0)}%`,
            'warn'
        );
        return;
    }

    mountRecallToDepthLayer(recalled, { query, isManual: true });
    const sourceDesc = typedQ
        ? `按关键词匹配到 ${recalled.length} 条记忆`
        : (autoScannedQ
            ? `已自动扫描最近 ${scanFloors} 楼正文，命中 ${recalled.length} 条记忆`
            : `已兜底挂载 ${recalled.length} 条记忆`);
    showToast(
        `📌 已挂载至 ${getInjectDepthLabel()}`,
        `${sourceDesc}，直接发消息即可使用`,
        'info'
    );
}

async function chuqingMemoryInterceptor(chat, _contextSize, _abort, type) {
    if (type === 'quiet') return;
    const ctx = getSTContext();
    if (!ctx || typeof ctx.setExtensionPrompt !== 'function') return;

    await initExtensionCore();

    const pos = parseIntInRange(state.config.injectPosition, 0, 2, 1);
    const depth = parseIntInRange(state.config.injectDepth, 0, 99, 0);
    const role = parseIntInRange(state.config.injectRole, 0, 2, 0);
    const chatList = Array.isArray(chat) && chat.length ? chat : (ctx.chat || []);

    // 若玩家刚刚半自动挂载了记忆到深度层，优先直出该批记忆（重roll/未推进新回合时保持挂载）
    if (state.stagedManualRecall && state.stagedManualRecall.compartment === state.currentCompartment) {
        const sameOrManual = !state.config.autoInjectEnabled || chatList.length <= state.stagedManualRecall.chatLen;
        if (sameOrManual) {
            ctx.setExtensionPrompt(PROMPT_KEY, state.stagedManualRecall.formattedBlock, pos, depth, false, role);
            if (state.config.showRecallToast && state.stagedManualRecall.recalled.length > 0) {
                showToast(
                    `📌 发送挂载记忆 (${state.stagedManualRecall.recalled.length} 条)`,
                    `${state.currentCompartment} · ${getInjectDepthLabel()}`,
                    'info',
                    2200
                );
            }
            return;
        }
        state.stagedManualRecall = null;
    }

    if (!state.config.autoInjectEnabled) {
        clearExtensionPromptSafe(ctx);
        return;
    }

    const slices = getCachedSlices(state.currentCompartment);
    const effPersona = getEffectivePersona();
    if (slices.length === 0 && !effPersona) {
        clearExtensionPromptSafe(ctx);
        return;
    }

    const scanFloors = parseIntInRange(state.config.recallScanFloors, 1, 12, 4);
    const query = buildRecallScanQuery(chatList, scanFloors) || '近期剧情记忆';

    try {
        const recalled = slices.length > 0
            ? await retrieveTopKMemories(query, state.activeTagFilter, state.config.topK, state.config.minScore)
            : [];

        if (recalled.length === 0 && !effPersona) {
            state.lastRecalledSlices = [];
            renderRecallPreview();
            clearExtensionPromptSafe(ctx);
            return;
        }

        mountRecallToDepthLayer(recalled, { query, isManual: false });

        if (state.config.showRecallToast && recalled.length > 0) {
            showToast(
                `🔮 唤醒 ${recalled.length} 条记忆`,
                `[${state.currentCompartment}] → ${getInjectDepthLabel()}`,
                'info',
                2200
            );
        }
    } catch (err) {
        console.warn('[初晴记忆库] 自动注入拦截器出错:', err);
        clearExtensionPromptSafe(ctx);
    }
}

globalThis.chuqingMemoryInterceptor = chuqingMemoryInterceptor;

/* ============================================================================
   9. 记忆归档业务流程
   ============================================================================ */
async function archiveMemorySlice({ rawText, useAiSummary = true, tags = [], eventName = '', defaultEvent = '剧情归档', silent = false }) {
    const cleanRaw = (rawText || '').trim();
    if (!cleanRaw) {
        if (!silent) showToast('内容为空', '请先抓取对话或输入记忆文本', 'warn');
        return null;
    }

    if (!silent) showLoading('VECTORIZING', '正在拆分提炼记忆切片并计算向量...');
    try {
        const manualTags = tags.length ? [...tags] : ['日常点滴'];
        let itemsToSave = [];

        if (useAiSummary) {
            const sum = await callSummaryModel(cleanRaw);
            const sliceList = Array.isArray(sum.slices) && sum.slices.length
                ? sum.slices
                : [{ text: sum.text || cleanRaw, tags: sum.tags || manualTags, event: sum.event || '' }];
            const isMulti = sliceList.length > 1;
            const newTagsToAdd = [];

            itemsToSave = sliceList.map(item => {
                const aiTags = Array.isArray(item.tags) ? item.tags.filter(Boolean) : [];
                const mergedTags = isMulti
                    ? (aiTags.length ? aiTags : manualTags)
                    : Array.from(new Set([...manualTags, ...aiTags]));
                mergedTags.forEach(t => {
                    if (t && !state.globalProfile.customTags.includes(t) && !newTagsToAdd.includes(t)) {
                        newTagsToAdd.push(t);
                    }
                });
                return {
                    text: item.text || cleanRaw,
                    tags: mergedTags.length ? mergedTags : ['日常点滴'],
                    event: (eventName || item.event || defaultEvent || '剧情归档').trim()
                };
            });

            if (newTagsToAdd.length > 0) {
                state.globalProfile.customTags.push(...newTagsToAdd);
                await pushGlobalProfileIfGithub('Add AI generated tags');
            }
        } else {
            itemsToSave = [{
                text: cleanRaw,
                tags: manualTags,
                event: (eventName || defaultEvent || '剧情归档').trim()
            }];
        }

        const today = getTodayDate();
        const createdSlices = [];
        for (const item of itemsToSave) {
            const vec = await getEmbeddingVector(`${item.event} ${item.tags.join(' ')} ${item.text}`);
            createdSlices.push({
                id: generateUUID(),
                text: item.text,
                date: today,
                tags: item.tags,
                event: item.event,
                vector: vec
            });
        }

        const curSlices = [...getCachedSlices(state.currentCompartment), ...createdSlices];
        await saveCompartment(
            state.currentCompartment,
            curSlices,
            `Archive ${createdSlices.length} slice(s) to ${state.currentCompartment}`
        );

        const rawChatId = state.currentChatIdentity.rawChatId;
        if (rawChatId && state.lastScrapedRange && state.lastScrapedRange.chatId === rawChatId) {
            const prev = state.lastArchivedFloorMap[rawChatId];
            state.lastArchivedFloorMap[rawChatId] = Number.isFinite(prev)
                ? Math.max(prev, state.lastScrapedRange.endFloor)
                : state.lastScrapedRange.endFloor;
        }
        state.lastScrapedRange = null;
        state.turnCounter = 0;
        saveSettings();
        renderAllUI();

        const modeText = isGithubModeActive() ? '本地 + GitHub 私有库' : '本地 IndexedDB';
        const countLabel = createdSlices.length > 1
            ? `已自动拆分为 ${createdSlices.length} 条独立切片`
            : '记忆已归档';
        showToast(countLabel, `已存入 [${state.currentCompartment}] (${modeText} · 共 ${curSlices.length} 条)`);
        return createdSlices.length === 1 ? createdSlices[0] : createdSlices;
    } catch (err) {
        showToast('归档失败', err.message || String(err), 'err');
        return null;
    } finally {
        if (!silent) hideLoading();
    }
}

/* ============================================================================
   10. 构建 UI：跟随式精简悬浮窗 + 顶部栏下拉全景页 + 轻量化快捷弹窗
   ============================================================================ */
function mountBaseContainers() {
    if (document.getElementById('cqst-root-mounted')) return;
    const marker = document.createElement('div');
    marker.id = 'cqst-root-mounted';
    marker.style.display = 'none';
    document.body.appendChild(marker);

    // Loading 遮罩
    const loadingEl = document.createElement('div');
    loadingEl.id = 'cqst-loading-backdrop';
    loadingEl.innerHTML = `
        <div class="cqst-loading-box" id="cqst-loading-box" data-text="LOADING SCENE"></div>
        <div class="cqst-loading-sub" id="cqst-loading-sub">正在处理记忆向量...</div>
    `;
    document.body.appendChild(loadingEl);

    // 悬浮触发胶囊
    const pill = document.createElement('div');
    pill.id = 'cqst-floating-pill';
    pill.title = '点击展开速控窗（PC 拖动 / 手机长按拖动，贴边半隐避让手势）';
    pill.innerHTML = `
        <span>✉️<span class="cqst-pill-label"> 信笺</span></span>
        <span class="cqst-pill-branch" id="cqst-pill-branch">[tavern_default]</span>
        <span class="cqst-pill-count" id="cqst-pill-count">0</span>
    `;
    document.body.appendChild(pill);
    restorePillPosition(pill);
    requestAnimationFrame(() => clampPillIntoViewport(pill));
    bindPillDragAndClick(pill);

    // 跟随悬浮球定位的精简速控小面板（只留：改名 / 总结存储 / 挂载深度层）
    const panel = document.createElement('div');
    panel.id = 'cqst-panel';
    panel.innerHTML = `
        <div class="cqst-panel-header">
            <div class="cqst-panel-title">✉️ 信笺 · 随行速控</div>
            <div style="display:flex;align-items:center;gap:5px;">
                <button type="button" class="cqst-btn sm icon-only" id="cqst-mini-hide-pill-btn" title="隐藏悬浮球（防误触，可在顶栏✉️全景页→配置中恢复）">🙈</button>
                <button type="button" class="cqst-btn sm icon-only" id="cqst-mini-theme-btn" title="切换初晴(日间) / 星夜(夜间)配色">🌙</button>
                <button type="button" class="cqst-btn sm bot" id="cqst-mini-open-panorama" title="拉开酒馆顶部全景记忆库页面">🏛️ 全景页</button>
                <button type="button" class="cqst-btn sm" id="cqst-btn-close-panel">收起</button>
            </div>
        </div>

        <!-- 隔间 & 存储状态概览 -->
        <div class="cqst-card">
            <div class="cqst-row">
                <span class="cqst-status-pill" id="cqst-mini-storage-badge">💾 本地</span>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span class="cqst-status-pill" id="cqst-mini-bind-badge">自动分支</span>
                    <button type="button" class="cqst-link-btn" id="cqst-mini-sync-btn" title="立即同步当前隔间">↻</button>
                </div>
            </div>
            <div class="cqst-compartment-box">
                <span class="cqst-compartment-name" id="cqst-mini-comp-label" title="">tavern_default</span>
                <button type="button" class="cqst-btn sm" id="cqst-mini-rename-btn" title="修改或切换当前聊天绑定的隔间名">✏️ 改名</button>
            </div>
        </div>

        <!-- 简要抓取总结 & 存储 -->
        <div class="cqst-card">
            <div class="cqst-row">
                <span style="font-size:12px;font-weight:700;">📥 抓取总结并存入</span>
                <div style="display:flex;align-items:center;gap:4px;">
                    <select id="cqst-mini-scrape-turns" class="cqst-select compact-h" style="width:auto;">
                        <option value="unarchived">✨ 未归档新楼层</option>
                        <option value="5">最近 5 轮</option>
                        <option value="10">最近 10 轮</option>
                    </select>
                    <button type="button" class="cqst-btn sm" id="cqst-mini-scrape-btn">🔍 抓取</button>
                </div>
            </div>
            <select id="cqst-mini-scrape-preset" class="cqst-select compact-h" title="切换正文抓取与清洗规则预设"></select>
            <textarea id="cqst-mini-archive-text" class="cqst-textarea" rows="2" placeholder="点击「🔍 抓取」或粘贴内容（可手动微调）..."></textarea>
            <div class="cqst-tag-list" id="cqst-mini-tag-list"></div>
            <div class="cqst-row-wrap">
                <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                    <input type="checkbox" class="cqst-checkbox" id="cqst-mini-chk-aisum" checked>
                    <span>AI 提炼摘要</span>
                </label>
                <button type="button" class="cqst-btn sm primary" id="cqst-mini-archive-btn">⚡ 总结存入</button>
            </div>
        </div>

        <!-- 唤醒直挂深度层（不写对话框） -->
        <div class="cqst-card bot-accent">
            <div class="cqst-row-wrap">
                <label style="font-size:12px;font-weight:700;color:var(--cqst-bot-text);display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" class="cqst-checkbox" id="cqst-mini-chk-autoinject">
                    <span>🔮 自动注入</span>
                </label>
                <span class="cqst-status-pill" id="cqst-mini-depth-pill">@D0 · System</span>
            </div>
            <div class="cqst-row">
                <input type="text" id="cqst-mini-recall-query" class="cqst-input compact-h" placeholder="半自动：填关键词搜，留空自动扫近期楼层">
                <button type="button" class="cqst-btn sm bot" id="cqst-mini-recall-mount" style="flex-shrink:0;" title="填词按词搜，留空则自动扫描最近楼层正文挂载到深度层">🔮 挂载</button>
                <button type="button" class="cqst-btn sm" id="cqst-mini-recall-clear" style="flex-shrink:0;" title="清除已挂载的深度层记忆">✕</button>
            </div>
            <div class="cqst-recall-preview" id="cqst-mini-recall-preview"></div>
        </div>
        <div class="cqst-form-hint" style="text-align:center;">💡 轻点悬浮球可直接打开；想挪动位置时，先点开小窗或长按球体待其弹出后再拖动，可避开手机边缘返回手势。</div>
    `;
    document.body.appendChild(panel);

    // 弹窗 A：悬浮球快捷改隔间名弹窗
    const renameModal = document.createElement('div');
    renameModal.className = 'cqst-modal-overlay';
    renameModal.id = 'cqst-rename-modal';
    renameModal.innerHTML = `
        <div class="cqst-modal-card" style="max-width:460px;">
            <div class="cqst-modal-header">
                <span class="cqst-modal-title">✏️ 修改 / 绑定隔间名</span>
                <button type="button" class="cqst-btn icon-only" data-cqst-close="cqst-rename-modal">✕</button>
            </div>
            <div class="cqst-modal-body">
                <div class="cqst-form-group">
                    <label class="cqst-form-label">当前聊天分支标识</label>
                    <div id="cqst-rename-raw-chat" style="font-family:var(--cqst-font-mono);font-size:12px;padding:6px 9px;background:var(--cqst-bg-input);border:1px dashed var(--cqst-border);border-radius:5px;word-break:break-all;"></div>
                </div>
                <div class="cqst-form-group">
                    <label class="cqst-form-label">目标隔间名</label>
                    <input type="text" id="cqst-rename-input" class="cqst-input" placeholder="例如：初晴_主线">
                </div>
                <div class="cqst-form-group">
                    <label class="cqst-form-label">或选择已有隔间：</label>
                    <select id="cqst-rename-existing-select" class="cqst-select"></select>
                </div>
                <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" class="cqst-checkbox" id="cqst-rename-delete-old" checked>
                    <span>重命名迁移时清理旧隔间（多分支共用时请取消勾选）</span>
                </label>
            </div>
            <div class="cqst-modal-footer" style="justify-content:space-between;">
                <button type="button" class="cqst-btn" id="cqst-btn-reset-default-compartment">↩️ 恢复默认</button>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button type="button" class="cqst-btn" id="cqst-btn-bind-compartment">🔗 仅切换绑定</button>
                    <button type="button" class="cqst-btn primary" id="cqst-btn-rename-migrate">✏️ 重命名并迁移</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(renameModal);

    // 弹窗 B：单条记忆切片 新增 / 编辑弹窗
    const sliceModal = document.createElement('div');
    sliceModal.className = 'cqst-modal-overlay';
    sliceModal.id = 'cqst-slice-modal';
    sliceModal.innerHTML = `
        <div class="cqst-modal-card">
            <div class="cqst-modal-header">
                <span class="cqst-modal-title" id="cqst-slice-modal-title">✏️ 编辑记忆切片</span>
                <button type="button" class="cqst-btn icon-only" data-cqst-close="cqst-slice-modal">✕</button>
            </div>
            <div class="cqst-modal-body">
                <input type="hidden" id="cqst-slice-id">
                <div class="cqst-form-group">
                    <label class="cqst-form-label">记忆内容 (100-200字精简总结为佳)</label>
                    <textarea id="cqst-slice-text" class="cqst-textarea" rows="4"></textarea>
                </div>
                <div class="cqst-form-grid-2">
                    <div class="cqst-form-group">
                        <label class="cqst-form-label">日期 (YYYY-MM-DD)</label>
                        <input type="text" id="cqst-slice-date" class="cqst-input">
                    </div>
                    <div class="cqst-form-group">
                        <label class="cqst-form-label">事件类型 (event)</label>
                        <input type="text" id="cqst-slice-event" class="cqst-input" placeholder="剧情/日常/约定">
                    </div>
                </div>
                <div class="cqst-form-group">
                    <label class="cqst-form-label">标签 (用逗号分隔)</label>
                    <input type="text" id="cqst-slice-tags" class="cqst-input">
                </div>
            </div>
            <div class="cqst-modal-footer">
                <button type="button" class="cqst-btn" data-cqst-close="cqst-slice-modal">取消</button>
                <button type="button" class="cqst-btn primary" id="cqst-btn-save-slice">💾 计算向量并保存</button>
            </div>
        </div>
    `;
    document.body.appendChild(sliceModal);

    // 弹窗 C：隔间专属人设弹窗
    const personaModal = document.createElement('div');
    personaModal.className = 'cqst-modal-overlay';
    personaModal.id = 'cqst-persona-modal';
    personaModal.innerHTML = `
        <div class="cqst-modal-card">
            <div class="cqst-modal-header">
                <span class="cqst-modal-title">🎭 隔间专属补充设定 [<span id="cqst-persona-branch-name">tavern_default</span>]</span>
                <button type="button" class="cqst-btn icon-only" data-cqst-close="cqst-persona-modal">✕</button>
            </div>
            <div class="cqst-modal-body">
                <div class="cqst-form-group">
                    <label class="cqst-form-label">该隔间专属前置提示（注入记忆时会一并带入）</label>
                    <textarea id="cqst-persona-input" class="cqst-textarea" rows="6" placeholder="可填写仅属于这个剧情隔间的世界观补充、角色关系备注或约定..."></textarea>
                </div>
            </div>
            <div class="cqst-modal-footer">
                <button type="button" class="cqst-btn" data-cqst-close="cqst-persona-modal">取消</button>
                <button type="button" class="cqst-btn primary" id="cqst-btn-save-persona">💾 保存设定</button>
            </div>
        </div>
    `;
    document.body.appendChild(personaModal);

    // 弹窗 D：自定义标签池管理弹窗
    const tagModal = document.createElement('div');
    tagModal.className = 'cqst-modal-overlay';
    tagModal.id = 'cqst-tag-modal';
    tagModal.innerHTML = `
        <div class="cqst-modal-card">
            <div class="cqst-modal-header">
                <span class="cqst-modal-title">🏷️ 自定义标签池管理</span>
                <button type="button" class="cqst-btn icon-only" data-cqst-close="cqst-tag-modal">✕</button>
            </div>
            <div class="cqst-modal-body">
                <div class="cqst-form-group">
                    <label class="cqst-form-label">➕ 新增标签</label>
                    <div class="cqst-row">
                        <input type="text" id="cqst-new-tag-input" class="cqst-input" placeholder="输入标签名 (不用带 #)">
                        <button type="button" class="cqst-btn primary" id="cqst-btn-add-tag">➕ 添加</button>
                    </div>
                </div>
                <hr class="cqst-divider">
                <div id="cqst-tag-manager-list" style="display:flex;flex-direction:column;gap:8px;"></div>
            </div>
            <div class="cqst-modal-footer">
                <button type="button" class="cqst-btn primary" data-cqst-close="cqst-tag-modal">完成</button>
            </div>
        </div>
    `;
    document.body.appendChild(tagModal);
}

function buildTopDrawerContentHTML() {
    return `
        <div class="cqst-hero-header">
            <h3 class="cqst-hero-title"><span>记忆档案馆</span></h3>
            <div class="cqst-hero-meta">
                <span class="cqst-status-pill" id="cqst-top-storage-pill">💾 本地存储</span>
                <span class="cqst-status-pill" id="cqst-top-comp-pill">🌿 tavern_default</span>
                <span class="cqst-status-pill" id="cqst-top-depth-pill">🔮 @D0 · System</span>
                <button type="button" class="cqst-btn sm update-ready" id="cqst-top-update-btn" style="display:none;" title="点击立即从 GitHub 拉取最新扩展版本">🆕 立即更新</button>
                <button type="button" class="cqst-btn sm" id="cqst-top-theme-btn" title="切换初晴(日间) / 星夜(夜间)配色">🌙 星夜</button>
                <button type="button" class="cqst-btn sm" id="cqst-top-sync-btn" title="同步最新记忆">↻ 同步</button>
                <button type="button" class="cqst-btn sm" id="cqst-top-close-btn">✕ 收起</button>
            </div>
        </div>

        <div class="cqst-row-wrap">
            <div class="cqst-tabs" id="cqst-top-tabs">
                <button type="button" class="cqst-tab-btn active" data-cqst-tab="archive">📚 记忆档案 (<span id="cqst-top-count-badge">0</span>)</button>
                <button type="button" class="cqst-tab-btn" data-cqst-tab="branches">🌿 隔间总管</button>
                <button type="button" class="cqst-tab-btn" data-cqst-tab="settings">⚙️ 配置与深度</button>
            </div>
            <div style="font-size:11.5px;color:var(--cqst-text-faded);" id="cqst-top-chat-hint">聊天分支：未激活对话</div>
        </div>

        <!-- Tab 1: 记忆档案库 -->
        <div class="cqst-tab-pane active" id="cqst-pane-archive">
            <div class="cqst-panorama-grid">
                <!-- 左列：抓取总结 + 深度层挂载唤醒 -->
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div class="cqst-card">
                        <div class="cqst-row-wrap">
                            <span style="font-size:12.5px;font-weight:700;">📥 对话抓取与 AI 总结归档</span>
                            <div style="display:flex;align-items:center;gap:5px;">
                                <select id="cqst-top-scrape-mode" class="cqst-select compact-h" style="width:auto;">
                                    <option value="unarchived">✨ 未归档新楼层</option>
                                    <option value="recent5">最近 5 轮 (10层)</option>
                                    <option value="recent10">最近 10 轮 (20层)</option>
                                    <option value="range">指定楼层范围</option>
                                </select>
                                <button type="button" class="cqst-btn sm" id="cqst-top-btn-scrape">🔍 抓取</button>
                            </div>
                        </div>
                        <div class="cqst-row" style="gap:6px;">
                            <select id="cqst-scrape-preset-select" class="cqst-select compact-h" style="flex:1;" title="选择当前使用的抓取与正文清洗规则预设"></select>
                            <button type="button" class="cqst-btn sm" id="cqst-btn-toggle-scrape-cfg" style="flex-shrink:0;">✂️ 清洗规则</button>
                        </div>
                        <div id="cqst-scrape-config-box" class="cqst-scrape-config-box">
                            <div class="cqst-row-wrap">
                                <span style="font-size:11.5px;font-weight:700;color:var(--cqst-text-strong);">📐 抓取与清洗预设模板</span>
                                <div style="display:flex;gap:4px;flex-wrap:wrap;">
                                    <button type="button" class="cqst-btn sm primary" id="cqst-btn-save-scrape-preset">💾 保存到当前</button>
                                    <button type="button" class="cqst-btn sm" id="cqst-btn-saveas-scrape-preset">➕ 另存</button>
                                    <button type="button" class="cqst-btn sm" id="cqst-btn-rename-scrape-preset">✏️ 改名</button>
                                    <button type="button" class="cqst-btn sm danger" id="cqst-btn-del-scrape-preset">🗑️</button>
                                </div>
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">正文提取标签（逗号分隔，默认 <code>content</code>；留空则抓全文）</label>
                                <input type="text" id="cqst-scrape-extract-tags" class="cqst-input compact-h" placeholder="例如：content, 正文, story">
                                <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                                    <input type="checkbox" class="cqst-checkbox" id="cqst-scrape-fallback-notag">
                                    <span>消息未含以上标签时保留原文（防止漏抓玩家发言）</span>
                                </label>
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">强制剔除组件/思维链标签（逗号分隔）</label>
                                <input type="text" id="cqst-scrape-strip-tags" class="cqst-input compact-h" placeholder="例如：think, thinking, status, 状态栏, small_theater, 小剧场">
                            </div>
                            <div class="cqst-form-group">
                                <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-weight:700;color:var(--cqst-text-strong);">
                                    <input type="checkbox" class="cqst-checkbox" id="cqst-scrape-clean-comments">
                                    <span>🧹 自动清洗正文内的 HTML 注释自检块 (&lt;!-- ... --&gt;)</span>
                                </label>
                                <input type="text" id="cqst-scrape-keep-comments" class="cqst-input compact-h" placeholder="🛡️ 保留注释关键词白名单（直接填文本即可，无需写 <!-- -->，如：伏笔, 备注）">
                                <span class="cqst-form-hint">示例：直接填注释里的关键词 <code>伏笔, 重要备注</code>（不用加 <code>&lt;!-- --&gt;</code>）；像 <code>&lt;!-- 文中自检... --&gt;</code> 这类自检注释会被洗掉，而含「伏笔」的注释会保留。</span>
                            </div>
                        </div>
                        <div id="cqst-top-floor-box" class="cqst-row" style="display:none;gap:6px;">
                            <input type="number" id="cqst-top-floor-start" class="cqst-input compact-h" min="0" value="0" placeholder="起始楼层">
                            <span style="font-size:11.5px;">~</span>
                            <input type="number" id="cqst-top-floor-end" class="cqst-input compact-h" min="0" value="20" placeholder="结束楼层">
                        </div>
                        <textarea id="cqst-top-archive-preview" class="cqst-textarea" rows="4" placeholder="点击「🔍 抓取」读取酒馆对话，或粘贴文本（可编辑后再归档）..."></textarea>
                        <div class="cqst-row-wrap">
                            <span style="font-size:11.5px;color:var(--cqst-text-light);font-weight:700;">点选 #标签（盖印 𝔖）：</span>
                            <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                                <input type="text" id="cqst-top-quick-tag-input" class="cqst-input compact-h" style="width:118px;" placeholder="+ 快速加标签(回车)">
                                <button type="button" class="cqst-btn sm" id="cqst-top-quick-tag-btn" title="快速添加并选中标签">➕</button>
                                <button type="button" class="cqst-link-btn" id="cqst-top-btn-tags">🏷️ 管理标签池</button>
                            </div>
                        </div>
                        <div class="cqst-tag-list" id="cqst-top-tag-container"></div>
                        <div class="cqst-row-wrap">
                            <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;">
                                <input type="checkbox" class="cqst-checkbox" id="cqst-top-chk-aisum" checked>
                                <span>AI 提炼摘要</span>
                            </label>
                            <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;" title="勾选后才会每满 N 轮自动归档；不勾选则只手动归档、绝不自动存">
                                <input type="checkbox" class="cqst-checkbox" id="cqst-top-chk-autoarchive">
                                <span>开启自动存（每 <strong id="cqst-top-lbl-autoturns">10</strong> 轮）</span>
                            </label>
                            <button type="button" class="cqst-btn primary" id="cqst-top-btn-archive">⚡ 归档记忆</button>
                        </div>
                    </div>

                    <div class="cqst-card bot-accent">
                        <div class="cqst-row-wrap">
                            <label style="font-size:12.5px;font-weight:700;color:var(--cqst-bot-text);display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                                <input type="checkbox" class="cqst-checkbox" id="cqst-top-chk-autoinject">
                                <span>🔮 发消息时自动扫最近 <strong id="cqst-top-lbl-scanfloors">4</strong> 楼正文唤醒并注入深度层</span>
                            </label>
                            <select id="cqst-top-tag-filter" class="cqst-select compact-h" style="width:auto;max-width:140px;"></select>
                        </div>
                        <div class="cqst-row">
                            <input type="text" id="cqst-top-recall-input" class="cqst-input" placeholder="半自动唤醒挂载：填关键词搜指定记忆，留空直接点按钮自动扫近期楼层（不写对话框）...">
                            <button type="button" class="cqst-btn bot" id="cqst-top-btn-recall-mount" style="flex-shrink:0;" title="半自动模式：填写关键词则精准检索，留空则自动扫描最近 N 楼正文匹配并提前挂载到深度层">🔮 唤醒挂载</button>
                            <button type="button" class="cqst-btn" id="cqst-top-btn-recall-clear" style="flex-shrink:0;" title="清除当前挂载的记忆提示词">✕ 清除</button>
                        </div>
                        <div class="cqst-form-hint" id="cqst-top-mount-status">当前状态：发消息自动扫最近 4 楼注入；下方算半自动唤醒挂载，留空也能直接点按钮自动扫楼 pre-mount。</div>
                        <div class="cqst-recall-preview" id="cqst-top-recall-preview"></div>
                    </div>
                </div>

                <!-- 右列：完整切片检索与管理 -->
                <div class="cqst-card">
                    <div class="cqst-row-wrap">
                        <span style="font-size:12.5px;font-weight:700;">🗂️ 当前隔间档案 [<span id="cqst-top-archive-branch-name">tavern_default</span>]</span>
                        <div style="display:flex;gap:5px;flex-wrap:wrap;">
                            <button type="button" class="cqst-btn sm" id="cqst-btn-toggle-collapse-slices" title="一键折叠或展开当前列表中的记忆切片">🗂️ 折叠卡片</button>
                            <button type="button" class="cqst-btn sm" id="cqst-btn-add-manual-slice">➕ 新增</button>
                            <button type="button" class="cqst-btn sm" id="cqst-btn-reembed" title="使用当前向量模型重算本隔间全部向量">🔄 重算向量</button>
                            <button type="button" class="cqst-btn sm" id="cqst-btn-import-json">📥 导入</button>
                            <button type="button" class="cqst-btn sm" id="cqst-btn-export-json">📤 导出</button>
                            <input type="file" id="cqst-import-file-input" accept=".json,application/json" style="display:none;">
                        </div>
                    </div>
                    <input type="text" id="cqst-drawer-search" class="cqst-input" placeholder="🔍 搜索记忆内容、日期或事件...">
                    <div class="cqst-tag-list" id="cqst-drawer-tag-bar"></div>
                    <div class="cqst-archive-scroll" id="cqst-drawer-list"></div>
                    <div class="cqst-pagination" id="cqst-drawer-pagination"></div>
                </div>
            </div>
        </div>

        <!-- Tab 2: 隔间与分支总管 -->
        <div class="cqst-tab-pane" id="cqst-pane-branches">
            <div class="cqst-panorama-grid">
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div class="cqst-card">
                        <div class="cqst-row">
                            <span style="font-size:12.5px;font-weight:700;">✏️ 当前聊天隔间改名 / 绑定</span>
                            <span class="cqst-status-pill" id="cqst-top-bind-badge">自动跟随分支</span>
                        </div>
                        <div class="cqst-form-group">
                            <label class="cqst-form-label">目标隔间名</label>
                            <input type="text" id="cqst-top-rename-input" class="cqst-input" placeholder="输入新隔间名或选择已有隔间">
                        </div>
                        <div class="cqst-form-group">
                            <label class="cqst-form-label">快速选择已有隔间</label>
                            <select id="cqst-top-rename-existing" class="cqst-select"></select>
                        </div>
                        <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                            <input type="checkbox" class="cqst-checkbox" id="cqst-top-rename-delold" checked>
                            <span>执行「重命名迁移」时清理旧隔间文件</span>
                        </label>
                        <div class="cqst-row-wrap" style="margin-top:2px;">
                            <button type="button" class="cqst-btn sm" id="cqst-top-btn-reset-default">↩️ 恢复默认分支名</button>
                            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                                <button type="button" class="cqst-btn sm" id="cqst-top-btn-bind">🔗 仅切换绑定</button>
                                <button type="button" class="cqst-btn sm primary" id="cqst-top-btn-rename">✏️ 重命名并迁移</button>
                            </div>
                        </div>
                    </div>

                    <div class="cqst-card">
                        <label class="cqst-form-label">➕ 新建独立隔间并绑定当前聊天</label>
                        <div class="cqst-row">
                            <input type="text" id="cqst-new-branch-input" class="cqst-input" placeholder="例如：现代日常、古风线">
                            <button type="button" class="cqst-btn primary" id="cqst-btn-create-branch">➕ 新建</button>
                        </div>
                    </div>

                    <div id="cqst-clone-official-wrap" class="cqst-card bot-accent" style="display:none;">
                        <div class="cqst-row">
                            <span style="font-size:12px;font-weight:700;">📥 从仓库根目录 (<code>branches/</code>) 单向克隆到酒馆</span>
                            <button type="button" class="cqst-link-btn" id="cqst-btn-scan-official">🔍 读取根目录隔间</button>
                        </div>
                        <div class="cqst-row">
                            <select id="cqst-official-branch-select" class="cqst-select">
                                <option value="">点击右上角「读取根目录隔间」扫描...</option>
                            </select>
                            <button type="button" class="cqst-btn sm bot" id="cqst-btn-clone-official" style="flex-shrink:0;">📥 克隆到酒馆</button>
                        </div>
                        <span class="cqst-form-hint">若同仓库根目录 <code>branches/</code> 存有其他记忆数据，可仅单向复制到 <code>tavern/branches/</code>，绝不修改或覆盖原文件。</span>
                    </div>
                </div>

                <div class="cqst-card">
                    <div class="cqst-row">
                        <span style="font-size:12.5px;font-weight:700;">📂 全部隔间列表</span>
                        <button type="button" class="cqst-link-btn" id="cqst-btn-refresh-branches">↻ 扫描本地与云端隔间</button>
                    </div>
                    <div id="cqst-branch-list-container" class="cqst-archive-scroll"></div>
                </div>
            </div>
        </div>

        <!-- Tab 3: 存储、模型与深度配置 -->
        <div class="cqst-tab-pane" id="cqst-pane-settings">
            <div class="cqst-panorama-grid">
                <!-- 左列：存储与模型 API -->
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div class="cqst-card">
                        <div class="cqst-form-group">
                            <label class="cqst-form-label">1. 记忆库存储系统</label>
                            <select id="cqst-cfg-storage-mode" class="cqst-select">
                                <option value="local">💾 本地存储模式（IndexedDB · 大众推荐，免配置开箱即用）</option>
                                <option value="github">☁️ GitHub 私人仓库模式（云端跨设备同步）</option>
                            </select>
                        </div>
                        <div id="cqst-cfg-github-box" style="display:none;flex-direction:column;gap:8px;padding:10px;background:var(--cqst-bg-input);border:1px dashed var(--cqst-border);border-radius:6px;">
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">GitHub 仓库目录隔离模式</label>
                                <select id="cqst-cfg-github-dir-mode" class="cqst-select">
                                    <option value="isolated">🛡️ 酒馆独立子目录 (tavern/ · 推荐：同仓库多端隔离不串库)</option>
                                    <option value="shared">🔗 与仓库根目录共用 (branches/ · 仅跨端双向同步时选)</option>
                                </select>
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">GitHub Personal Access Token (PAT)</label>
                                <input type="password" id="cqst-cfg-github-pat" class="cqst-input" placeholder="ghp_... 或 github_pat_...">
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">
                                    <span>GitHub 私有仓库 (Owner/Repo)</span>
                                    <button type="button" class="cqst-link-btn" id="cqst-btn-test-github">🔌 测试并同步目录</button>
                                </label>
                                <input type="text" id="cqst-cfg-github-repo" class="cqst-input" placeholder="例如：yourname/gemini-memory">
                            </div>
                            <div class="cqst-row-wrap">
                                <button type="button" class="cqst-btn sm" id="cqst-btn-push-cur-github">📤 推送/合并当前隔间</button>
                                <button type="button" class="cqst-btn sm" id="cqst-btn-push-all-github">📦 全量本地合并上传</button>
                            </div>
                        </div>
                    </div>

                    <div class="cqst-card">
                        <div class="cqst-form-group">
                            <label class="cqst-form-label">
                                <span>2A. AI 摘要提炼接口 (Summary)</span>
                                <button type="button" class="cqst-link-btn" id="cqst-btn-fetch-chat">🔄 拉取模型</button>
                            </label>
                            <select id="cqst-cfg-api-provider" class="cqst-select">
                                <option value="gemini">✨ Google Gemini (官方 / 反代)</option>
                                <option value="siliconflow">🚀 硅基流动 SiliconFlow (国内直连)</option>
                                <option value="openai">🔌 通用 OpenAI 兼容反代 (/v1)</option>
                                <option value="st_current">🍺 复用酒馆当前主 API (免额外 Key)</option>
                            </select>
                        </div>
                        <div id="cqst-cfg-chat-auth-box" style="display:flex;flex-direction:column;gap:8px;">
                            <input type="password" id="cqst-cfg-chat-key" class="cqst-input" placeholder="总结接口 API Key (AIzaSy... 或 sk-...)">
                            <div class="cqst-form-grid-2">
                                <div class="cqst-form-group">
                                    <label class="cqst-form-label">Base URL</label>
                                    <input type="text" id="cqst-cfg-chat-base" class="cqst-input" placeholder="https://generativelanguage.googleapis.com">
                                </div>
                                <div class="cqst-form-group">
                                    <label class="cqst-form-label">总结模型 (或手填)</label>
                                    <select id="cqst-cfg-chat-model" class="cqst-select"></select>
                                    <input type="text" id="cqst-cfg-chat-model-custom" class="cqst-input" placeholder="可选：手填其他模型名（留空即使用上方下拉模型）">
                                </div>
                            </div>
                        </div>

                        <hr class="cqst-divider">

                        <div class="cqst-form-group">
                            <label class="cqst-form-label">
                                <span>2B. 向量与重排接口 (Embedding &amp; Rerank)</span>
                                <button type="button" class="cqst-link-btn" id="cqst-btn-fetch-embed">🔄 拉取向量模型</button>
                            </label>
                            <select id="cqst-cfg-embed-provider" class="cqst-select">
                                <option value="same">🔗 与上方总结接口共用</option>
                                <option value="siliconflow">🚀 单独用：硅基流动 SiliconFlow (推荐免费 BAAI/bge-m3 + rerank)</option>
                                <option value="gemini">✨ 单独用：Google Gemini (text-embedding-004)</option>
                                <option value="openai">🔌 单独用：OpenAI 兼容 (/v1/embeddings)</option>
                                <option value="local">🧩 纯本地特征向量 (零 Key 离线可用)</option>
                            </select>
                            <span class="cqst-form-hint" id="cqst-cfg-embed-hint"></span>
                        </div>
                        <div id="cqst-cfg-embed-auth-box" class="cqst-form-grid-2" style="display:none;">
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">向量专用 API Key</label>
                                <input type="password" id="cqst-cfg-embed-key" class="cqst-input" placeholder="sk-... 或 AIzaSy...">
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">向量 Base URL</label>
                                <input type="text" id="cqst-cfg-embed-base" class="cqst-input" placeholder="https://api.siliconflow.cn/v1">
                            </div>
                        </div>
                        <div class="cqst-form-grid-2">
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">向量模型 (或手填)</label>
                                <select id="cqst-cfg-embed-model" class="cqst-select"></select>
                                <input type="text" id="cqst-cfg-embed-model-custom" class="cqst-input" placeholder="可选：手填其他向量模型（留空即用上方下拉模型，如免费 BAAI/bge-m3）">
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">重排模型 (Rerank)</label>
                                <select id="cqst-cfg-rerank-model" class="cqst-select"></select>
                                <label style="font-size:11.5px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;margin-top:2px;">
                                    <input type="checkbox" class="cqst-checkbox" id="cqst-cfg-rerank-enabled">
                                    <span>开启 Rerank 二次精排</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 右列：深度层注入参数 + 人设 + 保存 -->
                <div style="display:flex;flex-direction:column;gap:12px;">
                    <div class="cqst-card bot-accent">
                        <div class="cqst-form-grid-2">
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">注入位置 (Prompt Position)</label>
                                <select id="cqst-cfg-inject-pos" class="cqst-select">
                                    <option value="1">💬 聊天上下文指定深度 (@Depth)</option>
                                    <option value="0">📜 系统提示词之后 (In-Prompt)</option>
                                    <option value="2">📌 主提示词之前 (Before Prompt)</option>
                                </select>
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">深度 Depth / 注入角色 Role</label>
                                <div style="display:flex;gap:8px;align-items:center;">
                                    <input type="number" id="cqst-cfg-inject-depth" class="cqst-input" min="0" max="99" value="0" style="width:80px;flex-shrink:0;" title="0 = @D0 最末尾（推荐，保护前序 Prompt 缓存）">
                                    <select id="cqst-cfg-inject-role" class="cqst-select" style="flex:1;">
                                        <option value="0">System</option>
                                        <option value="1">User</option>
                                        <option value="2">Assistant</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                        <span class="cqst-form-hint">💡 推荐保持 <code>@Depth = 0 (D0)</code>：记忆切片会插在最新聊天末尾，不会破坏前面长对话的 KV Cache 缓存前缀。</span>

                        <div class="cqst-form-grid-2">
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">Top-K 条数 / 最低阈值 (0~0.95)</label>
                                <div style="display:flex;gap:6px;align-items:center;">
                                    <input type="number" id="cqst-cfg-topk" class="cqst-input" min="1" max="20" value="5" title="最多召回条数">
                                    <input type="number" id="cqst-cfg-minscore" class="cqst-input" min="0" max="0.95" step="0.02" value="0.38" title="低于此分数不注入">
                                </div>
                            </div>
                            <div class="cqst-form-group">
                                <label class="cqst-form-label">唤醒扫几楼 / 自动存轮数 (<span id="cqst-cfg-auto-status">未开启</span>)</label>
                                <div style="display:flex;gap:6px;align-items:center;">
                                    <input type="number" id="cqst-cfg-scan-floors" class="cqst-input" min="1" max="12" value="4" title="自动唤醒 / 留空挂载时扫描最近几楼正文（默认 4 楼）">
                                    <input type="number" id="cqst-cfg-autoturns" class="cqst-input" min="1" max="50" value="10" title="仅设定触发间隔轮数；未在「记忆档案库」勾选「开启自动存」时不会自动保存">
                                </div>
                            </div>
                        </div>
                        <div class="cqst-row-wrap" style="margin-top:2px;">
                            <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                                <input type="checkbox" class="cqst-checkbox" id="cqst-cfg-recall-toast">
                                <span>注入记忆时弹出记忆提示小票</span>
                            </label>
                            <div style="display:flex;align-items:center;gap:8px;">
                                <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                                    <input type="checkbox" class="cqst-checkbox" id="cqst-cfg-show-pill">
                                    <span>显示随行悬浮球</span>
                                </label>
                                <button type="button" class="cqst-link-btn" id="cqst-btn-reset-pill">重置球位置</button>
                            </div>
                        </div>
                    </div>

                    <div class="cqst-card">
                        <div class="cqst-form-group">
                            <label class="cqst-form-label">
                                <span>📝 AI 记忆切片提炼提示词（全局总结 Prompt）</span>
                                <button type="button" class="cqst-link-btn" id="cqst-btn-reset-summary-prompt" title="恢复内置的默认切片提炼提示词">↩️ 恢复默认提示词</button>
                            </label>
                            <textarea id="cqst-cfg-summary-prompt" class="cqst-textarea" rows="6" placeholder="输入给总结 AI 的系统提示词..."></textarea>
                            <span class="cqst-form-hint">💡 使用独立总结 API 时，AI 仅能看到此提示词与抓取清洗后的正文（完全读不到酒馆主预设/世界书条目）；<code>{{tags}}</code> 会自动替换为当前标签池。</span>
                        </div>
                        <div class="cqst-form-group">
                            <label class="cqst-form-label">跨隔间全局共同设定 (Global Persona · 总结与唤醒均附带)</label>
                            <textarea id="cqst-cfg-global-persona" class="cqst-textarea" rows="2" placeholder="跨分支共享的基础补充设定、人物底色或记忆整理备注（可留空）..."></textarea>
                        </div>
                        <div class="cqst-form-group">
                            <label class="cqst-form-label">当前隔间 [<span id="cqst-cfg-cur-branch-label">tavern_default</span>] 专属补充设定（总结与唤醒均附带）</label>
                            <textarea id="cqst-cfg-branch-persona" class="cqst-textarea" rows="2" placeholder="仅对当前隔间生效的角色关系/剧情补充设定（可留空）..."></textarea>
                        </div>
                        <div class="cqst-row-wrap" style="margin-top:4px;">
                            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                                <span class="cqst-status-pill" id="cqst-cfg-version-badge">v${PLUGIN_VERSION}</span>
                                <button type="button" class="cqst-btn sm" id="cqst-btn-update-plugin" title="检查并一键更新插件">🔄 检查更新</button>
                            </div>
                            <button type="button" class="cqst-btn primary" id="cqst-btn-save-settings">💾 保存全部配置</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function mountSillyTavernHooks() {
    // 1. 酒馆顶部导航栏 (#top-settings-holder) 原生下拉全景页
    const topHolder = document.getElementById('top-settings-holder');
    if (topHolder && !document.getElementById('cqst-top-drawer')) {
        const topDrawer = document.createElement('div');
        topDrawer.id = 'cqst-top-drawer';
        topDrawer.className = 'drawer';
        topDrawer.innerHTML = `
            <div id="cqst-top-drawer-toggle" class="cqst-top-toggle" title="✉️ 信笺 | 外置记忆库全景页">
                <div class="drawer-icon fa-solid fa-envelope-open-text fa-fw closedIcon"></div>
            </div>
            <div id="cqst-top-drawer-content" class="drawer-content closedDrawer">
                ${buildTopDrawerContentHTML()}
            </div>
        `;
        const extBtn = document.getElementById('extensions-settings-button');
        if (extBtn && extBtn.parentElement === topHolder) {
            topHolder.insertBefore(topDrawer, extBtn);
        } else {
            topHolder.appendChild(topDrawer);
        }
        bindTopDrawerEvents();
        populateSettingsUI();
        syncRenameInputsUI();
        renderAllUI();
    }

    // 2. 酒馆「扩展」设置页内嵌控制区 (#extensions_settings2 或 #extensions_settings)
    const settingsContainer = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (settingsContainer && !document.getElementById('cqst-st-extension-drawer')) {
        const drawerWrap = document.createElement('div');
        drawerWrap.id = 'cqst-st-extension-drawer';
        drawerWrap.className = 'inline-drawer';
        drawerWrap.innerHTML = `
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>✉️ 信笺 | 外置向量记忆库</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="cqst-st-settings-box">
                    <div class="cqst-row-wrap">
                        <span style="font-size:12px;">当前隔间：<strong id="cqst-ext-cur-compartment">tavern_default</strong></span>
                        <div style="display:flex;align-items:center;gap:5px;">
                            <span class="cqst-status-pill" id="cqst-ext-version-pill">v${PLUGIN_VERSION}</span>
                            <span class="cqst-status-pill" id="cqst-ext-storage-pill">💾 本地模式</span>
                        </div>
                    </div>
                    <div class="cqst-row-wrap">
                        <button type="button" class="cqst-btn sm primary" id="cqst-ext-open-archive">🏛️ 打开全景档案页</button>
                        <button type="button" class="cqst-btn sm" id="cqst-ext-open-branches">🌿 隔间总管</button>
                        <button type="button" class="cqst-btn sm" id="cqst-ext-open-settings">⚙️ 配置</button>
                        <button type="button" class="cqst-btn sm" id="cqst-ext-open-mini">✉️ 速控球</button>
                        <button type="button" class="cqst-btn sm" id="cqst-ext-update-btn" title="检查并更新扩展">🔄 检查更新</button>
                    </div>
                    <label style="font-size:12px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
                        <input type="checkbox" class="cqst-checkbox" id="cqst-ext-show-pill">
                        <span>在画面右下角显示随行悬浮球</span>
                    </label>
                </div>
            </div>
        `;
        settingsContainer.appendChild(drawerWrap);

        document.getElementById('cqst-ext-open-archive').addEventListener('click', () => openPanoramaAt('archive'));
        document.getElementById('cqst-ext-open-branches').addEventListener('click', () => openPanoramaAt('branches'));
        document.getElementById('cqst-ext-open-settings').addEventListener('click', () => openPanoramaAt('settings'));
        document.getElementById('cqst-ext-open-mini').addEventListener('click', () => {
            if (!state.config.showFloatingPill) {
                state.config.showFloatingPill = true;
                saveSettings();
                renderAllUI();
            }
            togglePanel(true);
        });
        document.getElementById('cqst-ext-show-pill').addEventListener('change', (e) => {
            state.config.showFloatingPill = e.target.checked;
            saveSettings();
            renderAllUI();
        });
        document.getElementById('cqst-ext-update-btn').addEventListener('click', () => {
            if (state.updateInfo.hasUpdate) triggerPluginOneClickUpdate();
            else checkPluginUpdate({ manual: true });
        });
    }

    // 3. 酒馆输入框旁「魔法棒」扩展菜单入口 (#extensionsMenu)
    const extMenu = document.getElementById('extensionsMenu');
    if (extMenu && !document.getElementById('cqst-menu-entry')) {
        const item = document.createElement('div');
        item.id = 'cqst-menu-entry';
        item.className = 'list-group-item flex-container flexGap5 interactable';
        item.tabIndex = 0;
        item.innerHTML = `
            <div class="fa-solid fa-envelope-open-text extensionsMenuExtensionButton"></div>
            <span>信笺记忆全景页</span>
        `;
        item.addEventListener('click', () => openPanoramaAt('archive'));
        extMenu.appendChild(item);
    }
}

/* ============================================================================
   11. 顶部栏抽屉联动 & 悬浮球动态跟随定位
   ============================================================================ */
function closeOtherSTTopDrawers() {
    const holder = document.getElementById('top-settings-holder');
    if (!holder) return;
    holder.querySelectorAll('.drawer-content.openDrawer').forEach(contentEl => {
        if (contentEl.id === 'cqst-top-drawer-content') return;
        const parentDrawer = contentEl.closest('.drawer');
        const toggleBtn = parentDrawer?.querySelector('.drawer-toggle');
        if (toggleBtn) {
            toggleBtn.click();
        } else {
            contentEl.classList.remove('openDrawer');
            contentEl.classList.add('closedDrawer');
            const icon = parentDrawer?.querySelector('.drawer-icon');
            if (icon) {
                icon.classList.remove('openIcon');
                icon.classList.add('closedIcon');
            }
        }
    });
}

function toggleTopDrawer(forceOpen = null) {
    const content = document.getElementById('cqst-top-drawer-content');
    const icon = document.querySelector('#cqst-top-drawer-toggle .drawer-icon');
    if (!content) return;

    const nextOpen = forceOpen === null ? !state.topDrawerOpen : Boolean(forceOpen);

    if (nextOpen) {
        closeOtherSTTopDrawers();
        state.topDrawerOpen = true;
        togglePanel(false);
        content.style.display = '';
        content.style.height = '';
        content.style.overflow = '';
        content.classList.remove('closedDrawer', 'resizing');
        content.classList.add('openDrawer');
        if (icon) {
            icon.classList.remove('closedIcon');
            icon.classList.add('openIcon');
        }
        populateSettingsUI();
        renderBranchManagerList();
        renderAllUI();
    } else {
        state.topDrawerOpen = false;
        content.classList.remove('openDrawer', 'resizing');
        content.classList.add('closedDrawer');
        content.style.display = '';
        content.style.height = '';
        content.style.overflow = '';
        if (icon) {
            icon.classList.remove('openIcon');
            icon.classList.add('closedIcon');
        }
    }
}

function switchPanoramaTab(tabName) {
    state.activePanoramaTab = tabName || 'archive';
    document.querySelectorAll('#cqst-top-tabs .cqst-tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-cqst-tab') === state.activePanoramaTab);
    });
    document.querySelectorAll('#cqst-top-drawer-content .cqst-tab-pane').forEach(pane => {
        pane.classList.toggle('active', pane.id === `cqst-pane-${state.activePanoramaTab}`);
    });
    if (state.activePanoramaTab === 'branches') {
        renderBranchManagerList();
        syncRenameInputsUI();
    } else if (state.activePanoramaTab === 'settings') {
        populateSettingsUI();
    }
}

function openPanoramaAt(tabName = 'archive') {
    if (!document.getElementById('cqst-top-drawer')) {
        mountSillyTavernHooks();
    }
    switchPanoramaTab(tabName);
    toggleTopDrawer(true);
}

function updateMiniPanelPosition() {
    const pill = document.getElementById('cqst-floating-pill');
    const panel = document.getElementById('cqst-panel');
    if (!pill || !panel || !state.panelOpen) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 10;
    const gap = 10;

    if (vw <= 540) {
        const panelW = Math.min(356, vw - margin * 2);
        panel.style.width = `${panelW}px`;
    } else {
        panel.style.width = '356px';
    }

    const pillRect = pill.getBoundingClientRect();
    const spaceAbove = Math.max(140, pillRect.top - margin - gap);
    const spaceBelow = Math.max(140, vh - pillRect.bottom - margin - gap);
    const placeAbove = (pillRect.top > vh * 0.45) || (spaceAbove >= 340) || (spaceAbove >= spaceBelow);

    const maxH = Math.min(540, placeAbove ? spaceAbove : spaceBelow);
    panel.style.maxHeight = `${Math.floor(maxH)}px`;

    const panelRect = panel.getBoundingClientRect();
    const actualW = panelRect.width || 356;
    const actualH = Math.min(panelRect.height || 380, maxH);

    let left = pillRect.right - actualW;
    if (left < margin) left = pillRect.left;
    left = Math.max(margin, Math.min(vw - actualW - margin, left));

    let top = placeAbove ? (pillRect.top - actualH - gap) : (pillRect.bottom + gap);
    top = Math.max(margin, Math.min(vh - actualH - margin, top));

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
}

function getEdgeDockGap() {
    return 0;
}

function updatePillEdgeDock(pill = document.getElementById('cqst-floating-pill'), { snap = false } = {}) {
    if (!pill) return '';
    const vw = window.innerWidth;
    const w = pill.offsetWidth || 44;
    const left = pill.offsetLeft;
    const edgeGap = getEdgeDockGap();
    const dockThreshold = vw <= 680 ? 14 : 24;

    pill.classList.remove('cqst-dock-left', 'cqst-dock-right');
    if (left <= dockThreshold) {
        if (snap) {
            pill.style.left = `${edgeGap}px`;
            pill.style.right = 'auto';
            pill.style.top = `${pill.offsetTop}px`;
            pill.style.bottom = 'auto';
        }
        pill.classList.add('cqst-dock-left');
        return 'left';
    }
    if (vw - (left + w) <= dockThreshold) {
        if (snap) {
            pill.style.left = 'auto';
            pill.style.right = `${edgeGap}px`;
            pill.style.top = `${pill.offsetTop}px`;
            pill.style.bottom = 'auto';
        }
        pill.classList.add('cqst-dock-right');
        return 'right';
    }
    return '';
}

function clampPillIntoViewport(pill = document.getElementById('cqst-floating-pill')) {
    if (!pill || pill.classList.contains('hidden')) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 6;
    const edgeGap = getEdgeDockGap();
    const w = pill.offsetWidth || 44;
    const h = pill.offsetHeight || 44;
    const curLeft = pill.offsetLeft;
    const curTop = pill.offsetTop;
    const maxTop = Math.max(margin, vh - h - margin);
    const clampedTop = Math.max(margin, Math.min(maxTop, curTop));
    const wasDockedRight = pill.classList.contains('cqst-dock-right');
    const wasDockedLeft = pill.classList.contains('cqst-dock-left');

    if (wasDockedRight) {
        pill.style.left = 'auto';
        pill.style.right = `${edgeGap}px`;
        pill.style.top = `${Math.round(clampedTop)}px`;
        pill.style.bottom = 'auto';
        updatePillEdgeDock(pill, { snap: true });
        return;
    }

    if (wasDockedLeft) {
        pill.style.left = `${edgeGap}px`;
        pill.style.right = 'auto';
        pill.style.top = `${Math.round(clampedTop)}px`;
        pill.style.bottom = 'auto';
        updatePillEdgeDock(pill, { snap: true });
        return;
    }

    const minLeft = edgeGap;
    const maxLeft = Math.max(edgeGap, vw - w - edgeGap);
    if (curLeft < minLeft || curLeft > maxLeft || curTop < margin || curTop > maxTop) {
        const nextLeft = Math.max(minLeft, Math.min(maxLeft, curLeft));
        pill.style.left = `${Math.round(nextLeft)}px`;
        pill.style.top = `${Math.round(clampedTop)}px`;
        pill.style.right = 'auto';
        pill.style.bottom = 'auto';
    }
    updatePillEdgeDock(pill, { snap: true });
}

function restorePillPosition(pill) {
    try {
        const raw = localStorage.getItem(LS_PILL_POS);
        if (!raw) {
            updatePillEdgeDock(pill, { snap: false });
            return;
        }
        const pos = JSON.parse(raw);
        const h = pill.offsetHeight || 44;
        const maxY = Math.max(6, window.innerHeight - h - 6);
        const safeTop = typeof pos.top === 'number' ? Math.max(6, Math.min(maxY, pos.top)) : null;
        const edgeGap = getEdgeDockGap();

        if (pos.dock === 'right') {
            pill.style.left = 'auto';
            pill.style.right = `${edgeGap}px`;
            if (safeTop !== null) {
                pill.style.top = `${Math.round(safeTop)}px`;
                pill.style.bottom = 'auto';
            }
            pill.classList.add('cqst-dock-right');
            return;
        }
        if (pos.dock === 'left') {
            pill.style.left = `${edgeGap}px`;
            pill.style.right = 'auto';
            if (safeTop !== null) {
                pill.style.top = `${Math.round(safeTop)}px`;
                pill.style.bottom = 'auto';
            }
            pill.classList.add('cqst-dock-left');
            return;
        }
        if (typeof pos.left === 'number' && safeTop !== null) {
            const w = pill.offsetWidth || 64;
            const maxX = Math.max(edgeGap, window.innerWidth - w - edgeGap);
            pill.style.left = `${Math.max(edgeGap, Math.min(maxX, pos.left))}px`;
            pill.style.top = `${Math.round(safeTop)}px`;
            pill.style.right = 'auto';
            pill.style.bottom = 'auto';
        }
    } catch (e) {}
    updatePillEdgeDock(pill, { snap: true });
}

function resetPillPosition() {
    localStorage.removeItem(LS_PILL_POS);
    const pill = document.getElementById('cqst-floating-pill');
    if (pill) {
        pill.style.left = '';
        pill.style.top = '';
        pill.style.right = `${getEdgeDockGap()}px`;
        pill.style.bottom = '92px';
        updatePillEdgeDock(pill, { snap: false });
    }
    updateMiniPanelPosition();
}

function bindPillDragAndClick(pill) {
    let startX = 0, startY = 0, origLeft = 0, origTop = 0;
    let pointerActive = false, dragArmed = false, moved = false, isTouch = false;
    let activePointerId = null;
    let holdTimer = null;

    const clearHoldTimer = () => {
        if (holdTimer) {
            clearTimeout(holdTimer);
            holdTimer = null;
        }
    };

    pill.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        clearHoldTimer();
        pointerActive = true;
        moved = false;
        isTouch = e.pointerType === 'touch';
        dragArmed = !isTouch;
        activePointerId = e.pointerId;
        startX = e.clientX;
        startY = e.clientY;
        origLeft = pill.offsetLeft;
        origTop = pill.offsetTop;

        if (isTouch) {
            // 手机触屏需长按 180ms 才激活拖拽，防止与边缘返回手势/滑动误触冲突
            holdTimer = setTimeout(() => {
                if (!pointerActive || moved) return;
                dragArmed = true;
                pill.classList.add('drag-armed');
                try {
                    if (activePointerId !== null) pill.setPointerCapture?.(activePointerId);
                } catch (err) {}
            }, 180);
        } else {
            pill.classList.add('dragging');
            pill.setPointerCapture?.(e.pointerId);
        }
    });

    pill.addEventListener('pointermove', (e) => {
        if (!pointerActive) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const dist = Math.hypot(dx, dy);

        if (isTouch && !dragArmed) {
            // 未长按激活前若发生较大幅度滑动，视为误触/系统返回手势，直接取消交互
            if (dist > 8) {
                clearHoldTimer();
                pointerActive = false;
                pill.classList.remove('dragging', 'drag-armed');
            }
            return;
        }

        if (!moved && dist > 6) {
            moved = true;
            pill.classList.add('dragging');
        }
        if (!moved) return;

        const edgeGap = getEdgeDockGap();
        const nextLeft = Math.max(edgeGap, Math.min(window.innerWidth - pill.offsetWidth - edgeGap, origLeft + dx));
        const nextTop = Math.max(6, Math.min(window.innerHeight - pill.offsetHeight - 6, origTop + dy));
        pill.style.left = `${nextLeft}px`;
        pill.style.top = `${nextTop}px`;
        pill.style.right = 'auto';
        pill.style.bottom = 'auto';
        pill.classList.remove('cqst-dock-left', 'cqst-dock-right');
        if (state.panelOpen) updateMiniPanelPosition();
    });

    const endDrag = () => {
        clearHoldTimer();
        if (!pointerActive) return;
        pointerActive = false;
        pill.classList.remove('dragging', 'drag-armed');
        if (moved) {
            const dock = updatePillEdgeDock(pill, { snap: true });
            try {
                localStorage.setItem(LS_PILL_POS, JSON.stringify({ left: pill.offsetLeft, top: pill.offsetTop, dock }));
            } catch (e) {}
            if (state.panelOpen) updateMiniPanelPosition();
        } else {
            togglePanel();
        }
    };

    pill.addEventListener('pointerup', endDrag);
    pill.addEventListener('pointercancel', () => {
        clearHoldTimer();
        pointerActive = false;
        pill.classList.remove('dragging', 'drag-armed');
    });
}

function togglePanel(forceOpen = null) {
    state.panelOpen = forceOpen === null ? !state.panelOpen : Boolean(forceOpen);
    const panel = document.getElementById('cqst-panel');
    const pill = document.getElementById('cqst-floating-pill');
    if (pill) pill.classList.toggle('cqst-pill-awake', state.panelOpen);
    if (!panel) return;
    panel.classList.toggle('open', state.panelOpen);
    if (state.panelOpen) {
        toggleTopDrawer(false);
        requestAnimationFrame(() => updateMiniPanelPosition());
    }
}

/* ============================================================================
   12. 界面状态渲染 (速控窗 + 顶部全景页 + 档案列表)
   ============================================================================ */
function renderRecallPreview() {
    const isManual = Boolean(state.stagedManualRecall && state.stagedManualRecall.compartment === state.currentCompartment);
    const slices = isManual ? state.stagedManualRecall.recalled : state.lastRecalledSlices;
    const depthLabel = getInjectDepthLabel();

    const mountStatus = document.getElementById('cqst-top-mount-status');
    if (mountStatus) {
        const scanFloors = parseIntInRange(state.config.recallScanFloors, 1, 12, 4);
        if (isManual) {
            mountStatus.textContent = `📌 已半自动挂载 ${slices.length} 条记忆到 [${depthLabel}]，发消息时随提示词发送（点「✕ 清除」可取消）。`;
        } else if (slices && slices.length > 0) {
            mountStatus.textContent = `✨ 最近一次已扫描最近 ${scanFloors} 楼正文并注入 ${slices.length} 条记忆到 [${depthLabel}]。`;
        } else {
            mountStatus.textContent = `半自动说明：${state.config.autoInjectEnabled ? `发消息自动扫描最近 ${scanFloors} 楼正文注入 [${depthLabel}]` : '已关闭自动注入'}；下方留空直接点「🔮 唤醒挂载」也会自动扫最近 ${scanFloors} 楼。`;
        }
    }

    const html = (!Array.isArray(slices) || slices.length === 0)
        ? ''
        : slices.map((r, i) => `
            <div class="cqst-recall-item">
                <div style="display:flex;justify-content:space-between;font-weight:700;color:var(--cqst-bot-text);">
                    <span>${isManual ? '📌' : '🔮'} Top-${i + 1} · ${escapeHtml(r.slice.date || '')}</span>
                    <span>${(r.score * 100).toFixed(0)}%</span>
                </div>
                <div>${escapeHtml(r.slice.text)}</div>
            </div>
        `).join('');

    ['cqst-mini-recall-preview', 'cqst-top-recall-preview'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.innerHTML = html;
        el.classList.toggle('visible', Boolean(html));
    });
}

async function quickAddTagByName(rawInput) {
    const names = Array.from(new Set(
        String(rawInput || '')
            .split(/[,，\n]/)
            .map(s => s.trim().replace(/^#+/, ''))
            .filter(Boolean)
    ));
    if (!names.length) return false;

    state.globalProfile.customTags = state.globalProfile.customTags || [];
    const added = [];
    names.forEach(name => {
        if (!state.globalProfile.customTags.includes(name)) {
            state.globalProfile.customTags.push(name);
            added.push(name);
        }
        state.selectedTags.add(name);
    });

    if (!added.length) {
        saveSettings();
        renderAllUI();
        showToast('已选中已有标签', names.map(n => `#${n}`).join(' '), 'info');
        return true;
    }

    await pushGlobalProfileIfGithub(`Add custom tags: ${added.join(', ')}`);
    renderTagManagerList();
    renderAllUI();
    showToast('已添加并选中标签', added.map(n => `#${n}`).join(' '));
    return true;
}

function renderTagPickers() {
    const tags = state.globalProfile.customTags || DEFAULT_TAGS;

    ['cqst-mini-tag-list', 'cqst-top-tag-container'].forEach(containerId => {
        const box = document.getElementById(containerId);
        if (!box) return;
        box.innerHTML = '';
        tags.forEach(t => {
            const span = document.createElement('span');
            span.className = `cqst-tag ${state.selectedTags.has(t) ? 'active' : ''}`;
            span.textContent = `#${t}`;
            span.addEventListener('click', () => {
                if (state.selectedTags.has(t)) state.selectedTags.delete(t);
                else state.selectedTags.add(t);
                saveSettings();
                renderTagPickers();
            });
            box.appendChild(span);
        });

        const addChip = document.createElement('span');
        addChip.className = 'cqst-tag cqst-tag-add';
        addChip.title = '快速新增自定义标签';
        addChip.textContent = '+ 新标签';
        addChip.addEventListener('click', async () => {
            if (containerId === 'cqst-top-tag-container') {
                const topInput = document.getElementById('cqst-top-quick-tag-input');
                if (topInput && topInput.value.trim()) {
                    const ok = await quickAddTagByName(topInput.value);
                    if (ok) topInput.value = '';
                    return;
                }
            }
            const raw = prompt('请输入要新增的标签名（多个可用逗号分隔）：');
            if (raw && raw.trim()) {
                await quickAddTagByName(raw);
            }
        });
        box.appendChild(addChip);
    });

    const topFilter = document.getElementById('cqst-top-tag-filter');
    if (topFilter) {
        topFilter.innerHTML = `<option value="">全部标签 (Top-${state.config.topK})</option>`;
        tags.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t;
            opt.textContent = `#${t}`;
            if (state.activeTagFilter === t) opt.selected = true;
            topFilter.appendChild(opt);
        });
    }

    const drawerBar = document.getElementById('cqst-drawer-tag-bar');
    if (drawerBar) {
        drawerBar.innerHTML = '';
        const allChip = document.createElement('span');
        allChip.className = `cqst-tag ${state.drawerFilterTag === '' ? 'active' : ''}`;
        allChip.textContent = '全部';
        allChip.addEventListener('click', () => {
            state.drawerFilterTag = '';
            state.slicePage = 1;
            renderTagPickers();
            renderDrawerSlices();
        });
        drawerBar.appendChild(allChip);

        tags.forEach(t => {
            const chip = document.createElement('span');
            chip.className = `cqst-tag ${state.drawerFilterTag === t ? 'active' : ''}`;
            chip.textContent = `#${t}`;
            chip.addEventListener('click', () => {
                state.drawerFilterTag = state.drawerFilterTag === t ? '' : t;
                state.slicePage = 1;
                renderTagPickers();
                renderDrawerSlices();
            });
            drawerBar.appendChild(chip);
        });
    }
}

function renderSlicePagination(total, totalPages) {
    const pager = document.getElementById('cqst-drawer-pagination');
    if (!pager) return;
    if (total === 0) {
        pager.innerHTML = '';
        return;
    }

    pager.innerHTML = `
        <span>共 <strong>${total}</strong> 条 · 第 <strong>${state.slicePage}/${totalPages}</strong> 页（每页 ${SLICE_PAGE_SIZE} 条）</span>
        <div style="display:flex;align-items:center;gap:6px;">
            <button type="button" class="cqst-btn sm" id="cqst-btn-page-prev" ${state.slicePage <= 1 ? 'disabled' : ''}>◀ 上页</button>
            <button type="button" class="cqst-btn sm" id="cqst-btn-page-next" ${state.slicePage >= totalPages ? 'disabled' : ''}>下页 ▶</button>
        </div>
    `;

    const scrollToTop = () => {
        const listEl = document.getElementById('cqst-drawer-list');
        if (listEl) listEl.scrollTop = 0;
    };
    pager.querySelector('#cqst-btn-page-prev')?.addEventListener('click', () => {
        if (state.slicePage <= 1) return;
        state.slicePage -= 1;
        renderDrawerSlices();
        scrollToTop();
    });
    pager.querySelector('#cqst-btn-page-next')?.addEventListener('click', () => {
        if (state.slicePage >= totalPages) return;
        state.slicePage += 1;
        renderDrawerSlices();
        scrollToTop();
    });
}

function renderDrawerSlices() {
    const listEl = document.getElementById('cqst-drawer-list');
    if (!listEl) return;

    const collapseBtn = document.getElementById('cqst-btn-toggle-collapse-slices');
    if (collapseBtn) {
        collapseBtn.textContent = state.slicesCollapsed ? '📂 展开全部' : '🗂️ 折叠卡片';
    }

    const searchVal = (document.getElementById('cqst-drawer-search')?.value || '').trim().toLowerCase();
    const slices = [...getCachedSlices(state.currentCompartment)].reverse();

    const filtered = slices.filter(s => {
        if (state.drawerFilterTag && !(s.tags || []).includes(state.drawerFilterTag)) return false;
        if (searchVal) {
            const hay = `${s.text || ''} ${(s.tags || []).join(' ')} ${s.event || ''} ${s.date || ''}`.toLowerCase();
            if (!hay.includes(searchVal)) return false;
        }
        return true;
    });

    const total = filtered.length;
    const totalPages = Math.max(1, Math.ceil(total / SLICE_PAGE_SIZE));
    state.slicePage = Math.max(1, Math.min(totalPages, state.slicePage || 1));

    if (total === 0) {
        listEl.innerHTML = `<div style="text-align:center;padding:34px 12px;color:var(--cqst-text-faded);font-size:13px;">当前隔间筛选下暂无记忆切片 ✉️</div>`;
        renderSlicePagination(0, 1);
        return;
    }

    const startIdx = (state.slicePage - 1) * SLICE_PAGE_SIZE;
    const pageItems = filtered.slice(startIdx, startIdx + SLICE_PAGE_SIZE);

    listEl.innerHTML = '';
    pageItems.forEach(s => {
        const isCollapsed = state.slicesCollapsed
            ? !state.toggledSliceIds.has(s.id)
            : state.toggledSliceIds.has(s.id);
        const card = document.createElement('div');
        card.className = `cqst-slice-card${isCollapsed ? ' collapsed' : ''}`;
        const vecDim = Array.isArray(s.vector) ? s.vector.length : 0;
        card.innerHTML = `
            <div class="cqst-slice-top" title="点击${isCollapsed ? '展开' : '折叠'}此条记忆切片">
                <span>${isCollapsed ? '▸' : '▾'} 📅 ${escapeHtml(s.date || '未知日期')} · ${escapeHtml(s.event || '记忆')}</span>
                <span title="向量维度">◈ VEC-${vecDim}D</span>
            </div>
            <div class="cqst-slice-text">${escapeHtml(s.text)}</div>
            <div class="cqst-slice-footer">
                <div class="cqst-tag-list">
                    ${(s.tags || []).map(t => `<span class="cqst-slice-badge">#${escapeHtml(t)}</span>`).join('')}
                </div>
                <div style="display:flex;gap:6px;">
                    <button type="button" class="cqst-link-btn btn-copy-slice">📋 复制</button>
                    <button type="button" class="cqst-link-btn btn-edit-slice">✏️ 编辑</button>
                    <button type="button" class="cqst-link-btn btn-del-slice" style="color:var(--cqst-red);">🗑️ 删除</button>
                </div>
            </div>
        `;

        card.querySelector('.cqst-slice-top').addEventListener('click', () => {
            if (state.toggledSliceIds.has(s.id)) state.toggledSliceIds.delete(s.id);
            else state.toggledSliceIds.add(s.id);
            renderDrawerSlices();
        });

        card.querySelector('.btn-copy-slice').addEventListener('click', () => {
            navigator.clipboard.writeText(`【记忆 | ${s.date} | #${(s.tags || []).join(' #')}】\n${s.text}`);
            showToast('已复制切片', '内容已复制到剪贴板', 'info');
        });
        card.querySelector('.btn-edit-slice').addEventListener('click', () => openSliceModal(s));
        card.querySelector('.btn-del-slice').addEventListener('click', async () => {
            if (!confirm(`确定删除这条记忆切片吗？\n「${(s.text || '').slice(0, 45)}...」`)) return;
            const next = getCachedSlices(state.currentCompartment).filter(item => item.id !== s.id);
            await saveCompartment(state.currentCompartment, next, 'Delete memory slice');
            renderAllUI();
            showToast('已删除记忆', `隔间 [${state.currentCompartment}] 剩余 ${next.length} 条`, 'info');
        });

        listEl.appendChild(card);
    });

    renderSlicePagination(total, totalPages);
}

function applyThemeMode(mode = state.config.themeMode) {
    const isNight = mode === 'night';
    state.config.themeMode = isNight ? 'night' : 'day';
    if (document?.documentElement) {
        document.documentElement.setAttribute('data-cqst-theme', state.config.themeMode);
    }
    const topThemeBtn = document.getElementById('cqst-top-theme-btn');
    if (topThemeBtn) {
        topThemeBtn.textContent = isNight ? '☀️ 初晴' : '🌙 星夜';
        topThemeBtn.title = isNight ? '当前「信笺 · 星夜」夜间配色，点击切回日间「初晴」' : '当前「信笺 · 初晴」日间配色，点击切为夜间「星夜」';
    }
    const miniThemeBtn = document.getElementById('cqst-mini-theme-btn');
    if (miniThemeBtn) {
        miniThemeBtn.textContent = isNight ? '☀️' : '🌙';
        miniThemeBtn.title = isNight ? '切换为「信笺 · 初晴」日间配色' : '切换为「信笺 · 星夜」夜间配色';
    }
}

function toggleThemeMode() {
    const next = state.config.themeMode === 'night' ? 'day' : 'night';
    applyThemeMode(next);
    saveSettings();
    showToast(
        next === 'night' ? '🌙 已切换为「星夜」夜间配色' : '☀️ 已切换为「初晴」日间配色',
        '配色已保存',
        'info',
        2000
    );
}

function compareSemver(a = '', b = '') {
    const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length, 3);
    for (let i = 0; i < len; i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va > vb) return 1;
        if (va < vb) return -1;
    }
    return 0;
}

function detectInstalledExtensionNames() {
    const names = [];
    const pushUnique = (n) => {
        const clean = String(n || '').replace(/^\/+|\/+$/g, '').trim();
        if (clean && !names.includes(clean)) names.push(clean);
    };

    try {
        const nodes = document.querySelectorAll('script[src*="scripts/extensions/"], link[href*="scripts/extensions/"]');
        nodes.forEach(el => {
            const url = el.getAttribute('src') || el.getAttribute('href') || '';
            const m = /scripts\/extensions\/((?:third-party\/)?[^/?#]+)\/(?:index\.js|style\.css)/i.exec(url);
            if (m && m[1]) pushUnique(decodeURIComponent(m[1]));
        });
    } catch (e) {}

    pushUnique('third-party/sillytavern-xinjian-memory');
    pushUnique('sillytavern-xinjian-memory');
    pushUnique('third-party/sillytavern-chuqing-memory');
    return names;
}

function renderUpdateNoticeUI() {
    const info = state.updateInfo || {};
    const hasUpdate = Boolean(info.hasUpdate);
    const verSuffix = info.remoteVersion ? ` v${info.remoteVersion}` : '';

    const topBtn = document.getElementById('cqst-top-update-btn');
    if (topBtn) {
        topBtn.style.display = hasUpdate ? 'inline-flex' : 'none';
        if (hasUpdate) {
            topBtn.textContent = info.remoteVersion ? `🆕 更新 v${info.remoteVersion}` : '🆕 立即更新';
            topBtn.title = `发现新版本${verSuffix}（当前 v${PLUGIN_VERSION}），点击立即更新`;
        }
    }

    const cfgBadge = document.getElementById('cqst-cfg-version-badge');
    if (cfgBadge) {
        cfgBadge.textContent = hasUpdate ? `v${PLUGIN_VERSION} → v${info.remoteVersion || '新版'}` : `v${PLUGIN_VERSION}`;
        cfgBadge.classList.toggle('custom', hasUpdate);
    }

    const extPill = document.getElementById('cqst-ext-version-pill');
    if (extPill) {
        extPill.textContent = hasUpdate ? `🆕 v${info.remoteVersion || '新版'}` : `v${PLUGIN_VERSION}`;
        extPill.classList.toggle('custom', hasUpdate);
    }

    ['cqst-btn-update-plugin', 'cqst-ext-update-btn'].forEach(id => {
        const btn = document.getElementById(id);
        if (!btn) return;
        btn.classList.toggle('update-ready', hasUpdate);
        btn.textContent = hasUpdate
            ? `🆕 立即更新${info.remoteVersion ? ` (${info.remoteVersion})` : ''}`
            : '🔄 检查更新';
        btn.title = hasUpdate
            ? `当前 v${PLUGIN_VERSION}，点击一键拉取${verSuffix}并刷新`
            : `当前 v${PLUGIN_VERSION}，点击检查 GitHub 是否有新版本`;
    });
}

async function getSTRequestHeadersSafe() {
    const ctx = getSTContext();
    if (typeof ctx?.getRequestHeaders === 'function') {
        try {
            return ctx.getRequestHeaders();
        } catch (e) {}
    }
    if (typeof globalThis.getRequestHeaders === 'function') {
        try {
            return globalThis.getRequestHeaders();
        } catch (e) {}
    }
    const headers = { 'Content-Type': 'application/json' };
    try {
        const tokenRes = await fetch('/csrf-token');
        if (tokenRes.ok) {
            const data = await tokenRes.json();
            if (data?.token) headers['X-CSRF-Token'] = data.token;
        }
    } catch (e) {}
    return headers;
}

async function checkPluginUpdate({ manual = false } = {}) {
    if (manual) {
        showToast('正在检查更新...', `当前版本 v${PLUGIN_VERSION}`, 'info', 2000);
    }

    let remoteVersion = '';
    let hasUpdate = false;
    let errMsg = '';

    try {
        const res = await fetch(`${PLUGIN_REMOTE_MANIFEST_URL}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const remote = await res.json();
        if (remote?.version) {
            remoteVersion = String(remote.version).trim();
            if (compareSemver(remoteVersion, PLUGIN_VERSION) > 0) {
                hasUpdate = true;
            }
        }
    } catch (e) {
        errMsg = e?.message || String(e);
    }

    // 同步尝试用酒馆自带版本接口核对 Git 提交是否落后
    if (!hasUpdate) {
        try {
            const headers = await getSTRequestHeadersSafe();
            for (const extensionName of detectInstalledExtensionNames()) {
                const vRes = await fetch('/api/extensions/version', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ extensionName })
                });
                if (vRes.ok) {
                    const vData = await vRes.json();
                    if (vData && vData.isUpToDate === false) {
                        hasUpdate = true;
                    }
                    break;
                }
            }
        } catch (e) {}
    }

    state.updateInfo = {
        checked: true,
        hasUpdate,
        remoteVersion: remoteVersion || (hasUpdate ? '新版' : PLUGIN_VERSION),
        error: errMsg
    };
    renderUpdateNoticeUI();

    if (hasUpdate) {
        const label = remoteVersion ? `v${remoteVersion}` : '新提交';
        showToast(
            `✨ 发现插件新版本 (${label})`,
            `当前 v${PLUGIN_VERSION}，点击顶栏「🆕 更新」或设置里的按钮即可升级`,
            'info',
            5200
        );
    } else if (manual) {
        if (errMsg && !remoteVersion) {
            showToast('检查更新失败', `无法连接 GitHub：${errMsg}`, 'warn');
        } else {
            showToast(`已是最新版 (v${PLUGIN_VERSION})`, `已与 ${PLUGIN_REPO} 对齐`, 'ok');
        }
    }
    return state.updateInfo;
}

async function triggerPluginOneClickUpdate() {
    const btns = ['cqst-top-update-btn', 'cqst-btn-update-plugin', 'cqst-ext-update-btn']
        .map(id => document.getElementById(id))
        .filter(Boolean);
    btns.forEach(b => { b.disabled = true; });
    showLoading('UPDATING', '正在拉取最新扩展代码...');

    try {
        const headers = await getSTRequestHeadersSafe();
        const candidates = detectInstalledExtensionNames();
        let updated = false;
        let lastErr = '';

        for (const extensionName of candidates) {
            for (const payload of [{ extensionName, global: true }, { extensionName }]) {
                try {
                    const res = await fetch('/api/extensions/update', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(payload)
                    });
                    if (res.ok) {
                        updated = true;
                        break;
                    }
                    lastErr = `HTTP ${res.status}`;
                } catch (err) {
                    lastErr = err?.message || String(err);
                }
            }
            if (updated) break;
        }

        if (updated) {
            state.updateInfo.hasUpdate = false;
            renderUpdateNoticeUI();
            showToast('🎉 插件已更新！', '请刷新页面加载最新代码', 'ok', 4500);
            if (confirm('🎉 信笺记忆库已更新到最新版本！\n是否立即刷新酒馆页面以生效？')) {
                location.reload();
            }
        } else {
            showToast(
                '无法直接热更新',
                `请打开酒馆「扩展 → 管理扩展」点更新，或访问 github.com/${PLUGIN_REPO}（${lastErr || '非 Git 安装'}）`,
                'warn',
                5600
            );
        }
    } finally {
        hideLoading();
        btns.forEach(b => { b.disabled = false; });
    }
}

function renderAllUI() {
    applyThemeMode(state.config.themeMode);
    renderUpdateNoticeUI();
    const slices = getCachedSlices(state.currentCompartment);
    const count = slices.length;
    const isGh = isGithubModeActive();
    const ghScope = isGithubIsolatedMode() ? '独立' : '共用';
    const storageText = isGh
        ? `☁️ GitHub(${ghScope}): ${state.config.githubRepo}`
        : (state.config.storageMode === 'github' ? '☁️ GitHub 未填密钥 (暂用本地)' : '💾 本地存储 (IndexedDB)');
    const miniStorageText = isGh ? `☁️ GitHub(${ghScope})` : '💾 本地';
    const depthLabel = getInjectDepthLabel();

    const pill = document.getElementById('cqst-floating-pill');
    if (pill) {
        pill.classList.toggle('hidden', !state.config.showFloatingPill);
        document.getElementById('cqst-pill-branch').textContent = `[${state.currentCompartment}]`;
        document.getElementById('cqst-pill-count').textContent = String(count);
    }

    // 随行速控小面板
    const miniStorageBadge = document.getElementById('cqst-mini-storage-badge');
    if (miniStorageBadge) {
        miniStorageBadge.textContent = miniStorageText;
        miniStorageBadge.classList.toggle('github', isGh);
    }
    const miniBindBadge = document.getElementById('cqst-mini-bind-badge');
    if (miniBindBadge) {
        miniBindBadge.textContent = state.isCustomBound ? '手动改名' : '自动分支';
        miniBindBadge.classList.toggle('custom', state.isCustomBound);
    }
    const miniCompLabel = document.getElementById('cqst-mini-comp-label');
    if (miniCompLabel) {
        miniCompLabel.textContent = state.currentCompartment;
        miniCompLabel.title = state.currentCompartment;
    }
    const miniAutoInj = document.getElementById('cqst-mini-chk-autoinject');
    if (miniAutoInj) miniAutoInj.checked = Boolean(state.config.autoInjectEnabled);
    const miniDepthPill = document.getElementById('cqst-mini-depth-pill');
    if (miniDepthPill) miniDepthPill.textContent = depthLabel;

    // 顶部下拉全景页
    const topStorage = document.getElementById('cqst-top-storage-pill');
    if (topStorage) {
        topStorage.textContent = storageText;
        topStorage.classList.toggle('github', isGh);
    }
    const topComp = document.getElementById('cqst-top-comp-pill');
    if (topComp) {
        topComp.textContent = `🌿 ${state.currentCompartment}`;
        topComp.classList.toggle('custom', state.isCustomBound);
    }
    const topDepth = document.getElementById('cqst-top-depth-pill');
    if (topDepth) {
        topDepth.textContent = state.config.autoInjectEnabled ? `🔮 ${depthLabel}` : `⏸️ 手动 (${depthLabel})`;
    }
    const topCountBadge = document.getElementById('cqst-top-count-badge');
    if (topCountBadge) topCountBadge.textContent = String(count);

    const topArchiveBranch = document.getElementById('cqst-top-archive-branch-name');
    if (topArchiveBranch) topArchiveBranch.textContent = state.currentCompartment;

    const topChatHint = document.getElementById('cqst-top-chat-hint');
    if (topChatHint) {
        const raw = state.currentChatIdentity.rawChatId;
        topChatHint.textContent = raw ? `当前聊天分支：${raw}` : '当前未激活角色对话（使用默认隔间）';
    }

    const topAutoInj = document.getElementById('cqst-top-chk-autoinject');
    if (topAutoInj) topAutoInj.checked = Boolean(state.config.autoInjectEnabled);
    const topScanFloors = document.getElementById('cqst-top-lbl-scanfloors');
    if (topScanFloors) topScanFloors.textContent = String(parseIntInRange(state.config.recallScanFloors, 1, 12, 4));
    const topAutoArc = document.getElementById('cqst-top-chk-autoarchive');
    if (topAutoArc) topAutoArc.checked = Boolean(state.config.autoArchiveEnabled);
    const topAutoTurns = document.getElementById('cqst-top-lbl-autoturns');
    if (topAutoTurns) topAutoTurns.textContent = String(state.config.autoTurns || 10);
    const cfgAutoStatus = document.getElementById('cqst-cfg-auto-status');
    if (cfgAutoStatus) {
        cfgAutoStatus.textContent = state.config.autoArchiveEnabled ? '已开启' : '未开启·不自动存';
    }

    const topBindBadge = document.getElementById('cqst-top-bind-badge');
    if (topBindBadge) {
        topBindBadge.textContent = state.isCustomBound ? '手动改名/指定' : '自动跟随分支';
        topBindBadge.classList.toggle('custom', state.isCustomBound);
    }
    const cloneWrap = document.getElementById('cqst-clone-official-wrap');
    if (cloneWrap) {
        cloneWrap.style.display = (isGithubConfigured() && isGithubIsolatedMode()) ? 'flex' : 'none';
    }

    // 酒馆扩展抽屉里的快捷状态
    const extCur = document.getElementById('cqst-ext-cur-compartment');
    if (extCur) extCur.textContent = state.currentCompartment;
    const extPill = document.getElementById('cqst-ext-storage-pill');
    if (extPill) {
        extPill.textContent = storageText;
        extPill.classList.toggle('github', isGh);
    }
    const extShowPill = document.getElementById('cqst-ext-show-pill');
    if (extShowPill) extShowPill.checked = Boolean(state.config.showFloatingPill);

    renderScrapePresetsUI(false);
    renderTagPickers();
    renderDrawerSlices();
    renderRecallPreview();
    if (state.panelOpen) updateMiniPanelPosition();
}

function syncScrapeConfigBoxFromPreset(preset) {
    if (!preset) return;
    const extractEl = document.getElementById('cqst-scrape-extract-tags');
    const fallbackEl = document.getElementById('cqst-scrape-fallback-notag');
    const stripEl = document.getElementById('cqst-scrape-strip-tags');
    const cleanChkEl = document.getElementById('cqst-scrape-clean-comments');
    const keepEl = document.getElementById('cqst-scrape-keep-comments');
    if (extractEl) extractEl.value = normalizeTagList(preset.extractTags).join(', ');
    if (fallbackEl) fallbackEl.checked = preset.fallbackWhenNoTag !== false;
    if (stripEl) stripEl.value = normalizeTagList(preset.stripTags).join(', ');
    if (cleanChkEl) cleanChkEl.checked = preset.cleanComments !== false;
    if (keepEl) keepEl.value = String(preset.keepCommentKeywords || '');
}

function readDraftScrapePresetFromUI() {
    const active = getActiveScrapePreset();
    const extractEl = document.getElementById('cqst-scrape-extract-tags');
    if (!extractEl) return active;
    return {
        ...active,
        extractTags: normalizeTagList(extractEl.value),
        fallbackWhenNoTag: Boolean(document.getElementById('cqst-scrape-fallback-notag')?.checked),
        stripTags: normalizeTagList(document.getElementById('cqst-scrape-strip-tags')?.value),
        cleanComments: Boolean(document.getElementById('cqst-scrape-clean-comments')?.checked),
        keepCommentKeywords: String(document.getElementById('cqst-scrape-keep-comments')?.value || '').trim()
    };
}

function renderScrapePresetsUI(syncInputs = false) {
    const presets = Array.isArray(state.config.scrapePresets) && state.config.scrapePresets.length
        ? state.config.scrapePresets
        : cloneDefaultScrapePresets();
    const active = getActiveScrapePreset();
    const optsHtml = presets
        .map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
        .join('');

    const topSel = document.getElementById('cqst-scrape-preset-select');
    if (topSel) {
        topSel.innerHTML = optsHtml;
        topSel.value = active.id;
    }
    const miniSel = document.getElementById('cqst-mini-scrape-preset');
    if (miniSel) {
        miniSel.innerHTML = optsHtml;
        miniSel.value = active.id;
    }

    const box = document.getElementById('cqst-scrape-config-box');
    if (syncInputs || (box && !box.classList.contains('open'))) {
        syncScrapeConfigBoxFromPreset(active);
    }
}

function selectScrapePresetById(presetId) {
    if (!Array.isArray(state.config.scrapePresets) || !state.config.scrapePresets.length) {
        state.config.scrapePresets = cloneDefaultScrapePresets();
    }
    const target = state.config.scrapePresets.find(p => p.id === presetId);
    if (!target) return;
    state.config.activeScrapePresetId = target.id;
    saveSettings();
    renderScrapePresetsUI(true);
    showToast('已切换抓取规则', target.name, 'info');
}

/* ============================================================================
   13. 隔间管理、配置表单填充与快捷弹窗
   ============================================================================ */
async function syncRenameInputsUI() {
    const localList = (await idbListCompartments()).map(i => i.name);
    const allNames = Array.from(new Set([...state.globalProfile.branchList, ...localList, state.currentCompartment]));

    const modalSel = document.getElementById('cqst-rename-existing-select');
    const topSel = document.getElementById('cqst-top-rename-existing');
    [modalSel, topSel].forEach(sel => {
        if (!sel) return;
        sel.innerHTML = '';
        allNames.forEach(n => {
            const opt = document.createElement('option');
            opt.value = n;
            opt.textContent = n === state.currentCompartment ? `${n} (当前)` : n;
            if (n === state.currentCompartment) opt.selected = true;
            sel.appendChild(opt);
        });
    });

    const topInput = document.getElementById('cqst-top-rename-input');
    if (topInput) topInput.value = state.currentCompartment;
}

async function openRenameModal() {
    const modal = document.getElementById('cqst-rename-modal');
    if (!modal) return;
    document.getElementById('cqst-rename-raw-chat').textContent = state.currentChatIdentity.rawChatId || '(未激活对话)';
    document.getElementById('cqst-rename-input').value = state.currentCompartment;
    await syncRenameInputsUI();
    modal.classList.add('open');
}

async function renderBranchManagerList() {
    const container = document.getElementById('cqst-branch-list-container');
    if (!container) return;
    const localItems = await idbListCompartments();
    const localCountMap = Object.fromEntries(localItems.map(i => [i.name, i.count]));
    const allNames = Array.from(new Set([...state.globalProfile.branchList, ...localItems.map(i => i.name), state.currentCompartment]));
    state.globalProfile.branchList = allNames;

    container.innerHTML = '';
    allNames.forEach(bName => {
        const isCurrent = bName === state.currentCompartment;
        const cachedCount = state.branchCache[bName]?.loaded ? state.branchCache[bName].slices.length : null;
        const count = cachedCount !== null ? cachedCount : (localCountMap[bName] ?? 0);

        const row = document.createElement('div');
        row.className = 'cqst-list-row';
        row.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:4px;min-width:0;flex:1;">
                <div style="font-weight:700;font-size:13.5px;color:var(--cqst-text-strong);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(bName)}">🌿 ${escapeHtml(bName)}</div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    ${isCurrent ? '<span class="cqst-status-pill custom">当前使用</span>' : ''}
                    <span class="cqst-status-pill">${count} 条记忆</span>
                </div>
            </div>
            <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
                ${!isCurrent ? '<button type="button" class="cqst-btn sm bot btn-use-branch">切换绑定</button>' : ''}
                <button type="button" class="cqst-btn sm btn-ren-branch">✏️ 改名</button>
                <button type="button" class="cqst-btn sm btn-persona-branch" title="编辑专属补充设定">🎭</button>
                <button type="button" class="cqst-btn sm danger btn-del-branch">🗑️</button>
            </div>
        `;

        row.querySelector('.btn-use-branch')?.addEventListener('click', async () => {
            showLoading('SWITCHING', `正在绑定并加载隔间 [${bName}]...`);
            try {
                await switchChatToCompartment(bName, { bindCurrentChat: true, forceRemote: isGithubModeActive() });
                await renderBranchManagerList();
                await syncRenameInputsUI();
                showToast('已切换隔间', `当前聊天已绑定到 [${bName}]`);
            } finally {
                hideLoading();
            }
        });

        row.querySelector('.btn-ren-branch').addEventListener('click', async () => {
            const rawNew = prompt(`将隔间「${bName}」重命名为：`, bName);
            if (!rawNew || !rawNew.trim()) return;
            const newName = sanitizeCompartmentName(rawNew);
            if (newName === bName) return;
            showLoading('RENAMING', `正在将 [${bName}] 迁移至 [${newName}]...`);
            try {
                const done = await renameCompartmentAndMigrate(bName, newName, { deleteOld: true });
                if (done) {
                    await renderBranchManagerList();
                    await syncRenameInputsUI();
                    showToast('隔间改名成功', `[${bName}] → [${newName}]`);
                }
            } catch (err) {
                showToast('改名失败', err.message, 'err');
            } finally {
                hideLoading();
            }
        });

        row.querySelector('.btn-persona-branch').addEventListener('click', () => openPersonaModal(bName));

        row.querySelector('.btn-del-branch').addEventListener('click', async () => {
            if (allNames.length <= 1) {
                showToast('无法删除', '至少需保留 1 个记忆隔间（可点「改名」修改名字）', 'warn');
                return;
            }
            if (!confirm(`确定彻底删除隔间「${bName}」及其内部记忆吗？此操作不可撤销。`)) return;
            showLoading('DELETING', `正在删除隔间 [${bName}]...`);
            try {
                const oldSha = state.branchCache[bName]?.sha || null;
                delete state.branchCache[bName];
                state.globalProfile.branchList = state.globalProfile.branchList.filter(x => x !== bName);
                if (state.globalProfile.branchPersonas) delete state.globalProfile.branchPersonas[bName];
                Object.keys(state.chatCompartmentMap).forEach(cid => {
                    if (state.chatCompartmentMap[cid] === bName) delete state.chatCompartmentMap[cid];
                });

                await idbDeleteCompartment(bName);
                if (isGithubModeActive()) {
                    await githubDeleteFile(getGithubBranchPath(bName), oldSha, `Delete compartment ${bName}`).catch(() => {});
                }
                if (state.currentCompartment === bName) {
                    const fallback = resolveCompartmentForChat();
                    const nextTarget = (fallback.name !== bName) ? fallback.name : state.globalProfile.branchList[0];
                    await switchChatToCompartment(nextTarget, { bindCurrentChat: false, forceRemote: isGithubModeActive() });
                }
                await pushGlobalProfileIfGithub(`Delete compartment ${bName}`);
                await renderBranchManagerList();
                await syncRenameInputsUI();
                renderAllUI();
                showToast('已删除隔间', `已移除 [${bName}]`, 'info');
            } catch (err) {
                showToast('删除失败', err.message, 'err');
            } finally {
                hideLoading();
            }
        });

        container.appendChild(row);
    });
}

function populateSelect(sel, items, selectedVal) {
    if (!sel) return;
    sel.innerHTML = '';
    items.forEach(item => {
        const opt = document.createElement('option');
        opt.value = item;
        opt.textContent = item;
        sel.appendChild(opt);
    });
    sel.value = (selectedVal && items.includes(selectedVal)) ? selectedVal : (items[0] || '');
}

function populateSettingsModelSelects() {
    const chatProvEl = document.getElementById('cqst-cfg-api-provider');
    const embProvEl = document.getElementById('cqst-cfg-embed-provider');
    if (!chatProvEl || !embProvEl) return;

    const chatProv = chatProvEl.value || 'gemini';
    const embedProvRaw = embProvEl.value || 'same';
    const effEmbedProv = embedProvRaw === 'same' ? chatProv : embedProvRaw;

    const chatPresetKey = PRESET_MODELS[chatProv] ? chatProv : 'gemini';
    const cachedChat = state.fetchedModels?.[chatPresetKey]?.chat || PRESET_MODELS[chatPresetKey].chat;
    const chatList = Array.from(new Set(cachedChat));
    let curChatModel = state.config.chatModel;
    if (chatProv === 'siliconflow' && (!curChatModel || curChatModel.startsWith('gemini-'))) {
        curChatModel = 'Qwen/Qwen2.5-7B-Instruct';
    } else if (chatProv === 'gemini' && (!curChatModel || !curChatModel.startsWith('gemini-'))) {
        curChatModel = 'gemini-2.5-flash';
    } else if (curChatModel && !chatList.includes(curChatModel)) {
        chatList.unshift(curChatModel);
    }
    populateSelect(document.getElementById('cqst-cfg-chat-model'), chatList, curChatModel);
    document.getElementById('cqst-cfg-chat-model-custom').value = '';

    const embPresetKey = PRESET_MODELS[effEmbedProv] ? effEmbedProv : 'siliconflow';
    const cachedEmb = state.fetchedModels?.[embPresetKey]?.embed || PRESET_MODELS[embPresetKey].embed;
    const cachedRerank = state.fetchedModels?.[embPresetKey]?.rerank || PRESET_MODELS[embPresetKey].rerank;
    const embList = Array.from(new Set(cachedEmb));
    const rerankList = Array.from(new Set(cachedRerank));
    let curEmbModel = state.config.embedModel;
    if (effEmbedProv === 'siliconflow' && (!curEmbModel || curEmbModel.includes('text-embedding') || curEmbModel.includes('gemini-embedding'))) {
        curEmbModel = 'BAAI/bge-m3';
    } else if (effEmbedProv === 'gemini' && (!curEmbModel || curEmbModel.includes('bge-') || curEmbModel.includes('bce-'))) {
        curEmbModel = 'text-embedding-004';
    } else if (curEmbModel && !embList.includes(curEmbModel)) {
        embList.unshift(curEmbModel);
    }
    if (state.config.rerankModel && !rerankList.includes(state.config.rerankModel)) rerankList.unshift(state.config.rerankModel);

    populateSelect(document.getElementById('cqst-cfg-embed-model'), embList, curEmbModel);
    populateSelect(document.getElementById('cqst-cfg-rerank-model'), rerankList, state.config.rerankModel);
    document.getElementById('cqst-cfg-embed-model-custom').value = '';
}

function toggleSettingsConditionalBoxes() {
    const storageMode = document.getElementById('cqst-cfg-storage-mode')?.value || 'local';
    const ghBox = document.getElementById('cqst-cfg-github-box');
    if (ghBox) ghBox.style.display = storageMode === 'github' ? 'flex' : 'none';

    const chatProv = document.getElementById('cqst-cfg-api-provider')?.value || 'gemini';
    const chatBox = document.getElementById('cqst-cfg-chat-auth-box');
    if (chatBox) chatBox.style.display = chatProv === 'st_current' ? 'none' : 'flex';

    const embProv = document.getElementById('cqst-cfg-embed-provider')?.value || 'same';
    const showEmbAuth = embProv !== 'same' && embProv !== 'local';
    const embBox = document.getElementById('cqst-cfg-embed-auth-box');
    if (embBox) embBox.style.display = showEmbAuth ? 'grid' : 'none';

    const hint = document.getElementById('cqst-cfg-embed-hint');
    if (hint) {
        if (chatProv === 'st_current' && embProv === 'same') {
            hint.textContent = '当前总结使用「酒馆主 API」且向量设为「共用」，将自动采用 128 维纯本地特征向量（如需高精度语义向量，可单独选硅基流动或 Gemini）。';
        } else if (embProv === 'local') {
            hint.textContent = '已选择纯本地特征向量：无需任何向量 Key，离线可用；未来配置向量模型后可在档案库一键「重算向量」。';
        } else {
            hint.textContent = '拆开配置后，即可实现「总结用 Gemini/酒馆 API，向量与重排用硅基流动 bge-m3」。';
        }
    }
}

function populateSettingsUI() {
    if (!document.getElementById('cqst-cfg-storage-mode')) return;
    document.getElementById('cqst-cfg-storage-mode').value = state.config.storageMode || 'local';
    document.getElementById('cqst-cfg-github-dir-mode').value = state.config.githubDirMode || 'isolated';
    document.getElementById('cqst-cfg-github-pat').value = state.config.githubPat || '';
    document.getElementById('cqst-cfg-github-repo').value = state.config.githubRepo || '';

    document.getElementById('cqst-cfg-api-provider').value = state.config.apiProvider || 'gemini';
    document.getElementById('cqst-cfg-chat-key').value = state.config.geminiKey || '';
    document.getElementById('cqst-cfg-chat-base').value = state.config.geminiBase || 'https://generativelanguage.googleapis.com';

    document.getElementById('cqst-cfg-embed-provider').value = state.config.embedProvider || 'same';
    document.getElementById('cqst-cfg-embed-key').value = state.config.embedKey || '';
    document.getElementById('cqst-cfg-embed-base').value = state.config.embedBase || 'https://api.siliconflow.cn/v1';

    document.getElementById('cqst-cfg-rerank-enabled').checked = Boolean(state.config.rerankEnabled);
    document.getElementById('cqst-cfg-inject-pos').value = String(parseIntInRange(state.config.injectPosition, 0, 2, 1));
    document.getElementById('cqst-cfg-inject-depth').value = String(parseIntInRange(state.config.injectDepth, 0, 99, 0));
    document.getElementById('cqst-cfg-inject-role').value = String(parseIntInRange(state.config.injectRole, 0, 2, 0));
    document.getElementById('cqst-cfg-topk').value = String(state.config.topK ?? 5);
    document.getElementById('cqst-cfg-minscore').value = String(state.config.minScore ?? 0.38);
    document.getElementById('cqst-cfg-scan-floors').value = String(parseIntInRange(state.config.recallScanFloors, 1, 12, 4));
    document.getElementById('cqst-cfg-autoturns').value = String(state.config.autoTurns ?? 10);
    document.getElementById('cqst-cfg-recall-toast').checked = Boolean(state.config.showRecallToast);
    document.getElementById('cqst-cfg-show-pill').checked = Boolean(state.config.showFloatingPill);
    document.getElementById('cqst-cfg-summary-prompt').value = state.config.summaryPrompt || DEFAULT_SUMMARY_PROMPT;
    document.getElementById('cqst-cfg-global-persona').value = state.globalProfile.persona || '';
    document.getElementById('cqst-cfg-cur-branch-label').textContent = state.currentCompartment;
    document.getElementById('cqst-cfg-branch-persona').value = state.globalProfile.branchPersonas?.[state.currentCompartment] || '';

    populateSettingsModelSelects();
    toggleSettingsConditionalBoxes();
}

function openSliceModal(slice = null) {
    document.getElementById('cqst-slice-modal-title').textContent = slice ? '✏️ 编辑记忆切片' : '➕ 手动新增记忆切片';
    document.getElementById('cqst-slice-id').value = slice ? slice.id : '';
    document.getElementById('cqst-slice-text').value = slice ? (slice.text || '') : '';
    document.getElementById('cqst-slice-date').value = slice ? (slice.date || getTodayDate()) : getTodayDate();
    document.getElementById('cqst-slice-event').value = slice ? (slice.event || '手动记录') : '手动记录';
    document.getElementById('cqst-slice-tags').value = slice ? (slice.tags || []).join(', ') : Array.from(state.selectedTags).join(', ');
    document.getElementById('cqst-slice-modal')?.classList.add('open');
}

function openPersonaModal(targetBranch = state.currentCompartment) {
    const cur = targetBranch || state.currentCompartment;
    const modal = document.getElementById('cqst-persona-modal');
    if (!modal) return;
    modal.setAttribute('data-target-branch', cur);
    document.getElementById('cqst-persona-branch-name').textContent = cur;
    document.getElementById('cqst-persona-input').value = state.globalProfile.branchPersonas?.[cur] || '';
    modal.classList.add('open');
}

function renderTagManagerList() {
    const listEl = document.getElementById('cqst-tag-manager-list');
    if (!listEl) return;
    const slices = getCachedSlices(state.currentCompartment);
    const tags = state.globalProfile.customTags || [];
    listEl.innerHTML = '';

    if (tags.length === 0) {
        listEl.innerHTML = `<div style="text-align:center;padding:16px;color:var(--cqst-text-faded);font-size:12px;">暂无标签，请在上方添加</div>`;
        return;
    }

    tags.forEach(tagName => {
        const used = slices.filter(s => Array.isArray(s.tags) && s.tags.includes(tagName)).length;
        const row = document.createElement('div');
        row.className = 'cqst-list-row';
        row.innerHTML = `
            <div style="display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;">
                <strong style="font-size:13px;color:var(--cqst-text-strong);">#${escapeHtml(tagName)}</strong>
                <span style="font-size:11px;color:var(--cqst-text-faded);">当前隔间 ${used} 条引用</span>
            </div>
            <div style="display:flex;gap:5px;">
                <button type="button" class="cqst-btn sm btn-ren-tag">✏️ 改名</button>
                <button type="button" class="cqst-btn sm danger btn-del-tag">🗑️</button>
            </div>
        `;

        row.querySelector('.btn-ren-tag').addEventListener('click', async () => {
            const raw = prompt(`将标签「#${tagName}」重命名为：`, tagName);
            if (!raw || !raw.trim()) return;
            const nextName = raw.trim().replace(/^#+/, '');
            if (!nextName || nextName === tagName) return;
            if (state.globalProfile.customTags.includes(nextName)) {
                showToast('标签已存在', `#${nextName} 已在标签池中`, 'warn');
                return;
            }
            const idx = state.globalProfile.customTags.indexOf(tagName);
            if (idx !== -1) state.globalProfile.customTags[idx] = nextName;
            if (state.selectedTags.has(tagName)) {
                state.selectedTags.delete(tagName);
                state.selectedTags.add(nextName);
            }
            if (state.drawerFilterTag === tagName) state.drawerFilterTag = nextName;
            if (state.activeTagFilter === tagName) state.activeTagFilter = nextName;

            const curSlices = getCachedSlices(state.currentCompartment);
            let changed = false;
            curSlices.forEach(s => {
                if (Array.isArray(s.tags) && s.tags.includes(tagName)) {
                    s.tags = Array.from(new Set(s.tags.map(t => t === tagName ? nextName : t)));
                    changed = true;
                }
            });
            await pushGlobalProfileIfGithub(`Rename tag ${tagName} -> ${nextName}`);
            if (changed) await saveCompartment(state.currentCompartment, curSlices, `Update tag ${tagName} -> ${nextName}`);
            renderTagManagerList();
            renderAllUI();
            showToast('标签已改名', `#${tagName} → #${nextName}`);
        });

        row.querySelector('.btn-del-tag').addEventListener('click', async () => {
            if (!confirm(`确定从标签池移除「#${tagName}」吗？（不会删除已存记忆内容）`)) return;
            state.globalProfile.customTags = state.globalProfile.customTags.filter(t => t !== tagName);
            state.selectedTags.delete(tagName);
            if (state.drawerFilterTag === tagName) state.drawerFilterTag = '';
            if (state.activeTagFilter === tagName) state.activeTagFilter = '';
            await pushGlobalProfileIfGithub(`Delete tag ${tagName}`);
            renderTagManagerList();
            renderAllUI();
        });

        listEl.appendChild(row);
    });
}

function openTagModal() {
    renderTagManagerList();
    document.getElementById('cqst-tag-modal')?.classList.add('open');
}

/* ============================================================================
   14. 在线模型拉取与事件绑定 (速控悬浮窗 + 顶部全景页 + 通用弹窗)
   ============================================================================ */
async function fetchModelsFor(target) {
    const isEmbed = target === 'embed';
    const chatProv = document.getElementById('cqst-cfg-api-provider').value || 'gemini';
    const embProv = document.getElementById('cqst-cfg-embed-provider').value || 'same';
    const effProv = isEmbed ? (embProv === 'same' ? chatProv : embProv) : chatProv;

    if (effProv === 'st_current' || effProv === 'local') {
        showToast('无需拉取', '当前选项直接使用酒馆或本地特征，无需在线拉取模型', 'info');
        return;
    }

    const rawKey = (isEmbed && embProv !== 'same')
        ? document.getElementById('cqst-cfg-embed-key').value.trim()
        : document.getElementById('cqst-cfg-chat-key').value.trim();
    const rawBase = (isEmbed && embProv !== 'same')
        ? document.getElementById('cqst-cfg-embed-base').value.trim()
        : document.getElementById('cqst-cfg-chat-base').value.trim();

    if (!rawKey) {
        showToast('请先填写 API Key', '填入 Key 后再拉取模型列表', 'warn');
        return;
    }

    const resolved = resolveApiEndpoint(effProv, rawKey, rawBase);
    let chatModels = [], embedModels = [], rerankModels = [];

    if (resolved.useOpenAI) {
        if (resolved.base.includes('siliconflow.cn')) {
            const [cRes, eRes, rRes] = await Promise.all([
                fetch(`${resolved.base}/models?sub_type=chat`, { headers: { 'Authorization': `Bearer ${resolved.key}` } }),
                fetch(`${resolved.base}/models?sub_type=embedding`, { headers: { 'Authorization': `Bearer ${resolved.key}` } }),
                fetch(`${resolved.base}/models?sub_type=reranker`, { headers: { 'Authorization': `Bearer ${resolved.key}` } })
            ]);
            if (cRes.ok) chatModels = ((await cRes.json()).data || []).map(m => m.id).filter(Boolean);
            if (eRes.ok) embedModels = ((await eRes.json()).data || []).map(m => m.id).filter(Boolean);
            if (rRes.ok) rerankModels = ((await rRes.json()).data || []).map(m => m.id).filter(Boolean);
        }
        if (!chatModels.length && !embedModels.length) {
            const res = await fetch(`${resolved.base}/models`, { headers: { 'Authorization': `Bearer ${resolved.key}` } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const ids = ((await res.json()).data || []).map(m => m.id).filter(Boolean);
            embedModels = ids.filter(id => /embed|bge-(?!rerank)|bce-embedding|m3e|jina-embeddings/i.test(id));
            rerankModels = ids.filter(id => /rerank/i.test(id));
            chatModels = ids.filter(id => !/embed|rerank|flux|stable-diffusion|whisper|tts|audio|video/i.test(id));
        }
    } else {
        const res = await fetch(`${resolved.base}/v1beta/models?key=${encodeURIComponent(resolved.key)}&pageSize=100`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        (data.models || []).forEach(m => {
            const id = (m.name || '').replace(/^models\//, '');
            if (!id) return;
            const methods = m.supportedGenerationMethods || [];
            if (methods.includes('embedContent') || id.includes('embedding')) embedModels.push(id);
            if (methods.includes('generateContent')) chatModels.push(id);
        });
    }

    const pKey = resolved.provider;
    if (!chatModels.length) chatModels = PRESET_MODELS[pKey]?.chat || PRESET_MODELS.openai.chat;
    if (!embedModels.length) embedModels = PRESET_MODELS[pKey]?.embed || PRESET_MODELS.openai.embed;
    if (!rerankModels.length) rerankModels = PRESET_MODELS[pKey]?.rerank || PRESET_MODELS.siliconflow.rerank;

    state.fetchedModels[pKey] = { chat: chatModels, embed: embedModels, rerank: rerankModels };
    saveSettings();
    populateSettingsModelSelects();
    showToast('模型拉取成功', isEmbed ? `向量 ${embedModels.length} 个 / 重排 ${rerankModels.length} 个` : `总结模型 ${chatModels.length} 个`);
}

async function handleSyncCurrentAction() {
    if (!isGithubModeActive()) {
        openPanoramaAt('settings');
        showToast('当前为本地模式', '可在配置页切换到 GitHub 私人仓库同步', 'info');
        return;
    }
    showLoading('SYNCING GITHUB', '正在同步最新隔间目录与切片...');
    try {
        await syncGlobalProfileFromGithub();
        await loadCompartment(state.currentCompartment, { forceRemote: true });
        renderAllUI();
        showToast('同步完成', `已拉取 [${state.currentCompartment}] 最新数据`);
    } catch (err) {
        showToast('同步失败', err.message, 'err');
    } finally {
        hideLoading();
    }
}

async function handleCompartmentRenameAction(rawNewName, deleteOld) {
    const clean = sanitizeCompartmentName((rawNewName || '').trim());
    if (!rawNewName || !rawNewName.trim()) {
        showToast('请输入新隔间名', '', 'warn');
        return false;
    }
    if (clean === state.currentCompartment) return true;
    showLoading('MIGRATING', `正在将隔间 [${state.currentCompartment}] 改名为 [${clean}]...`);
    try {
        const ok = await renameCompartmentAndMigrate(state.currentCompartment, clean, { deleteOld });
        if (ok) {
            await syncRenameInputsUI();
            await renderBranchManagerList();
            showToast('隔间已改名', `当前聊天已绑定到 [${clean}]`);
        }
        return ok;
    } catch (err) {
        showToast('改名失败', err.message, 'err');
        return false;
    } finally {
        hideLoading();
    }
}

async function handleCompartmentBindAction(rawTargetName) {
    if (!rawTargetName || !rawTargetName.trim()) {
        showToast('请输入或选择目标隔间名', '', 'warn');
        return false;
    }
    const target = sanitizeCompartmentName(rawTargetName);
    showLoading('BINDING', `正在将当前聊天绑定到隔间 [${target}]...`);
    try {
        await switchChatToCompartment(target, { bindCurrentChat: true, forceRemote: isGithubModeActive() });
        await syncRenameInputsUI();
        await renderBranchManagerList();
        showToast('绑定成功', `当前聊天已指向隔间 [${target}]`);
        return true;
    } catch (err) {
        showToast('绑定失败', err.message, 'err');
        return false;
    } finally {
        hideLoading();
    }
}

async function handleCompartmentResetDefaultAction() {
    const { rawChatId } = state.currentChatIdentity;
    if (!rawChatId) {
        showToast('无法恢复', '当前未检测到激活聊天 ID', 'warn');
        return false;
    }
    const defaultName = sanitizeCompartmentName(rawChatId);
    showLoading('RESETTING', `正在恢复跟随默认分支 [${defaultName}]...`);
    try {
        await switchChatToCompartment(defaultName, { bindCurrentChat: true, forceRemote: isGithubModeActive() });
        await syncRenameInputsUI();
        await renderBranchManagerList();
        showToast('已恢复默认分支名', `当前隔间：[${defaultName}]`, 'info');
        return true;
    } finally {
        hideLoading();
    }
}

function bindBaseUIEvents() {
    // 通用关闭弹窗
    document.querySelectorAll('[data-cqst-close]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById(btn.getAttribute('data-cqst-close'))?.classList.remove('open');
        });
    });

    window.addEventListener('resize', () => {
        clampPillIntoViewport();
        if (state.panelOpen) updateMiniPanelPosition();
    });

    // 随行速控小面板事件
    document.getElementById('cqst-btn-close-panel').addEventListener('click', () => togglePanel(false));
    document.getElementById('cqst-mini-hide-pill-btn').addEventListener('click', () => {
        state.config.showFloatingPill = false;
        togglePanel(false);
        saveSettings();
        populateSettingsUI();
        renderAllUI();
        showToast('已隐藏悬浮球', '可点顶栏 ✉️ 打开全景页 → ⚙️ 配置与深度 中重新显示', 'info');
    });
    document.getElementById('cqst-mini-theme-btn').addEventListener('click', toggleThemeMode);
    document.getElementById('cqst-mini-open-panorama').addEventListener('click', () => openPanoramaAt('archive'));
    document.getElementById('cqst-mini-sync-btn').addEventListener('click', handleSyncCurrentAction);
    document.getElementById('cqst-mini-rename-btn').addEventListener('click', openRenameModal);
    document.getElementById('cqst-mini-scrape-preset').addEventListener('change', (e) => {
        selectScrapePresetById(e.target.value);
    });

    const scrapeMiniChatByUI = () => {
        const val = document.getElementById('cqst-mini-scrape-turns').value;
        return val === 'unarchived'
            ? scrapeSillyTavernChat({ mode: 'unarchived', turns: 5 })
            : scrapeSillyTavernChat({ mode: 'recent', turns: parseInt(val, 10) || 5 });
    };

    document.getElementById('cqst-mini-scrape-btn').addEventListener('click', () => {
        const scraped = scrapeMiniChatByUI();
        if (!scraped) {
            showToast('未提取到对话', '请确认当前酒馆已打开对话且存在有效楼层', 'warn');
            return;
        }
        document.getElementById('cqst-mini-archive-text').value = scraped;
        const r = state.lastScrapedRange;
        const rangeInfo = r ? `第 ${r.startFloor}~${r.endFloor} 层 · ` : '';
        showToast('已提取对话', `${rangeInfo}共 ${scraped.length} 字`, 'info');
    });

    document.getElementById('cqst-mini-archive-btn').addEventListener('click', async () => {
        let raw = document.getElementById('cqst-mini-archive-text').value.trim();
        if (!raw) {
            raw = scrapeMiniChatByUI();
            document.getElementById('cqst-mini-archive-text').value = raw;
        }
        const useAi = document.getElementById('cqst-mini-chk-aisum').checked;
        const saved = await archiveMemorySlice({
            rawText: raw,
            useAiSummary: useAi,
            tags: Array.from(state.selectedTags),
            defaultEvent: '酒馆归档'
        });
        if (saved) document.getElementById('cqst-mini-archive-text').value = '';
    });

    document.getElementById('cqst-mini-chk-autoinject').addEventListener('change', (e) => {
        state.config.autoInjectEnabled = e.target.checked;
        saveSettings();
        if (!e.target.checked && !state.stagedManualRecall) clearExtensionPromptSafe();
        renderAllUI();
        showToast(e.target.checked ? '已开启自动注入' : '已关闭自动注入', getInjectDepthLabel(), 'info');
    });

    document.getElementById('cqst-mini-recall-mount').addEventListener('click', () => {
        runManualRecallMount(document.getElementById('cqst-mini-recall-query').value);
    });
    document.getElementById('cqst-mini-recall-clear').addEventListener('click', () => {
        clearMountedRecall({ clearPreview: true });
        showToast('已清除深度层挂载', '', 'info');
    });

    // 快捷改名弹窗事件
    document.getElementById('cqst-rename-existing-select').addEventListener('change', (e) => {
        if (e.target.value) document.getElementById('cqst-rename-input').value = e.target.value;
    });
    document.getElementById('cqst-btn-rename-migrate').addEventListener('click', async () => {
        const ok = await handleCompartmentRenameAction(
            document.getElementById('cqst-rename-input').value,
            document.getElementById('cqst-rename-delete-old').checked
        );
        if (ok) document.getElementById('cqst-rename-modal').classList.remove('open');
    });
    document.getElementById('cqst-btn-bind-compartment').addEventListener('click', async () => {
        const ok = await handleCompartmentBindAction(document.getElementById('cqst-rename-input').value);
        if (ok) document.getElementById('cqst-rename-modal').classList.remove('open');
    });
    document.getElementById('cqst-btn-reset-default-compartment').addEventListener('click', async () => {
        const ok = await handleCompartmentResetDefaultAction();
        if (ok) document.getElementById('cqst-rename-modal').classList.remove('open');
    });

    // 保存切片弹窗
    document.getElementById('cqst-btn-save-slice').addEventListener('click', async () => {
        const id = document.getElementById('cqst-slice-id').value.trim();
        const text = document.getElementById('cqst-slice-text').value.trim();
        if (!text) {
            showToast('记忆内容不能为空', '', 'warn');
            return;
        }
        const date = document.getElementById('cqst-slice-date').value.trim() || getTodayDate();
        const event = document.getElementById('cqst-slice-event').value.trim() || '手动记录';
        const tags = document.getElementById('cqst-slice-tags').value
            .split(/[,，]/)
            .map(t => t.trim().replace(/^#+/, ''))
            .filter(Boolean);
        const finalTags = tags.length ? tags : ['日常点滴'];

        document.getElementById('cqst-slice-modal').classList.remove('open');
        showLoading('VECTORIZING', '正在计算切片向量并保存...');
        try {
            const vec = await getEmbeddingVector(`${event} ${finalTags.join(' ')} ${text}`);
            const slices = [...getCachedSlices(state.currentCompartment)];
            if (id) {
                const idx = slices.findIndex(s => s.id === id);
                if (idx !== -1) slices[idx] = { ...slices[idx], text, date, event, tags: finalTags, vector: vec };
            } else {
                slices.push({ id: generateUUID(), text, date, event, tags: finalTags, vector: vec });
            }
            await saveCompartment(state.currentCompartment, slices, id ? 'Edit memory slice' : 'Add manual slice');
            renderAllUI();
            showToast(id ? '切片已更新' : '已新增记忆切片', `共 ${slices.length} 条记忆`);
        } catch (err) {
            showToast('保存失败', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    // 保存专属人设弹窗
    document.getElementById('cqst-btn-save-persona').addEventListener('click', async () => {
        const modal = document.getElementById('cqst-persona-modal');
        const cur = modal?.getAttribute('data-target-branch') || state.currentCompartment;
        const val = document.getElementById('cqst-persona-input').value.trim();
        state.globalProfile.branchPersonas = state.globalProfile.branchPersonas || {};
        if (val) state.globalProfile.branchPersonas[cur] = val;
        else delete state.globalProfile.branchPersonas[cur];

        modal.classList.remove('open');
        const branchPersonaBox = document.getElementById('cqst-cfg-branch-persona');
        if (branchPersonaBox && cur === state.currentCompartment) branchPersonaBox.value = val;

        try {
            await pushGlobalProfileIfGithub(`Update persona for ${cur}`);
            renderAllUI();
            showToast(val ? '隔间设定已保存' : '已清空隔间设定', `[${cur}] 生效中`);
        } catch (err) {
            showToast('本地已保存', `GitHub 同步失败: ${err.message}`, 'warn');
        }
    });

    // 新增标签
    const handleAddTag = async () => {
        const input = document.getElementById('cqst-new-tag-input');
        const ok = await quickAddTagByName(input.value);
        if (ok) input.value = '';
    };
    document.getElementById('cqst-btn-add-tag').addEventListener('click', handleAddTag);
    document.getElementById('cqst-new-tag-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleAddTag();
    });
}

function bindTopDrawerEvents() {
    // 顶部栏展开/收起按钮与互斥联动
    document.getElementById('cqst-top-drawer-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleTopDrawer();
    });
    document.getElementById('cqst-top-close-btn').addEventListener('click', () => toggleTopDrawer(false));

    const topHolder = document.getElementById('top-settings-holder');
    if (topHolder && !topHolder.dataset.cqstBound) {
        topHolder.dataset.cqstBound = '1';
        topHolder.addEventListener('click', (e) => {
            if (!e.isTrusted) return;
            const otherToggle = e.target.closest?.('.drawer-toggle');
            if (otherToggle && !otherToggle.closest('#cqst-top-drawer') && state.topDrawerOpen) {
                toggleTopDrawer(false);
            }
        }, true);
    }

    document.querySelectorAll('#cqst-top-tabs .cqst-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchPanoramaTab(btn.getAttribute('data-cqst-tab')));
    });

    document.getElementById('cqst-top-update-btn').addEventListener('click', triggerPluginOneClickUpdate);
    document.getElementById('cqst-top-theme-btn').addEventListener('click', toggleThemeMode);
    document.getElementById('cqst-top-sync-btn').addEventListener('click', handleSyncCurrentAction);

    // Tab 1: 档案库操作
    document.getElementById('cqst-top-scrape-mode').addEventListener('change', (e) => {
        document.getElementById('cqst-top-floor-box').style.display = e.target.value === 'range' ? 'flex' : 'none';
    });

    document.getElementById('cqst-scrape-preset-select').addEventListener('change', (e) => {
        selectScrapePresetById(e.target.value);
    });

    document.getElementById('cqst-btn-toggle-scrape-cfg').addEventListener('click', () => {
        const box = document.getElementById('cqst-scrape-config-box');
        if (!box) return;
        const willOpen = !box.classList.contains('open');
        box.classList.toggle('open', willOpen);
        if (willOpen) syncScrapeConfigBoxFromPreset(getActiveScrapePreset());
    });

    document.getElementById('cqst-btn-save-scrape-preset').addEventListener('click', () => {
        if (!Array.isArray(state.config.scrapePresets) || !state.config.scrapePresets.length) {
            state.config.scrapePresets = cloneDefaultScrapePresets();
        }
        const draft = readDraftScrapePresetFromUI();
        const idx = Math.max(0, state.config.scrapePresets.findIndex(p => p.id === state.config.activeScrapePresetId));
        state.config.scrapePresets[idx] = { ...state.config.scrapePresets[idx], ...draft };
        state.config.activeScrapePresetId = state.config.scrapePresets[idx].id;
        saveSettings();
        renderScrapePresetsUI(true);
        showToast('已保存抓取预设', state.config.scrapePresets[idx].name, 'success');
    });

    document.getElementById('cqst-btn-saveas-scrape-preset').addEventListener('click', () => {
        const active = getActiveScrapePreset();
        const rawName = prompt('请输入新抓取预设名称：', `${active.name}（自定义）`);
        if (!rawName || !rawName.trim()) return;
        if (!Array.isArray(state.config.scrapePresets)) state.config.scrapePresets = cloneDefaultScrapePresets();
        const newPreset = {
            ...readDraftScrapePresetFromUI(),
            id: `preset_${Date.now()}`,
            name: rawName.trim()
        };
        state.config.scrapePresets.push(newPreset);
        state.config.activeScrapePresetId = newPreset.id;
        saveSettings();
        renderScrapePresetsUI(true);
        showToast('已另存抓取预设', newPreset.name, 'success');
    });

    document.getElementById('cqst-btn-rename-scrape-preset').addEventListener('click', () => {
        if (!Array.isArray(state.config.scrapePresets) || !state.config.scrapePresets.length) return;
        const active = getActiveScrapePreset();
        const rawName = prompt('请输入新的抓取预设名称：', active.name);
        if (!rawName || !rawName.trim()) return;
        const target = state.config.scrapePresets.find(p => p.id === active.id);
        if (!target) return;
        target.name = rawName.trim();
        saveSettings();
        renderScrapePresetsUI(false);
        showToast('已重命名预设', target.name, 'success');
    });

    document.getElementById('cqst-btn-del-scrape-preset').addEventListener('click', () => {
        if (!Array.isArray(state.config.scrapePresets) || state.config.scrapePresets.length <= 1) {
            showToast('无法删除', '至少需要保留 1 个抓取预设模板', 'warn');
            return;
        }
        const active = getActiveScrapePreset();
        if (!confirm(`确定删除抓取预设「${active.name}」吗？`)) return;
        state.config.scrapePresets = state.config.scrapePresets.filter(p => p.id !== active.id);
        state.config.activeScrapePresetId = state.config.scrapePresets[0].id;
        saveSettings();
        renderScrapePresetsUI(true);
        showToast('已删除抓取预设', active.name, 'info');
    });

    const scrapeTopChatByUI = () => {
        const modeVal = document.getElementById('cqst-top-scrape-mode').value;
        const draftPreset = readDraftScrapePresetFromUI();
        if (modeVal === 'range') {
            return scrapeSillyTavernChat({
                mode: 'range',
                startFloor: parseIntInRange(document.getElementById('cqst-top-floor-start').value, 0, 99999, 0),
                endFloor: parseIntInRange(document.getElementById('cqst-top-floor-end').value, 0, 99999, 9999),
                preset: draftPreset
            });
        }
        if (modeVal === 'unarchived') {
            return scrapeSillyTavernChat({ mode: 'unarchived', turns: 5, preset: draftPreset });
        }
        return scrapeSillyTavernChat({ mode: 'recent', turns: modeVal === 'recent10' ? 10 : 5, preset: draftPreset });
    };

    document.getElementById('cqst-top-btn-scrape').addEventListener('click', () => {
        const scraped = scrapeTopChatByUI();
        if (!scraped) {
            showToast('未提取到对话', '请确认当前酒馆已打开角色对话', 'warn');
            return;
        }
        document.getElementById('cqst-top-archive-preview').value = scraped;
        const r = state.lastScrapedRange;
        const rangeInfo = r ? `第 ${r.startFloor}~${r.endFloor} 层（共 ${r.floorCount} 楼）· ` : '';
        showToast('已提取对话', `${rangeInfo}共 ${scraped.length} 字，可直接点击「⚡ 归档记忆」`, 'info');
    });

    const handleTopQuickTag = async () => {
        const input = document.getElementById('cqst-top-quick-tag-input');
        const ok = await quickAddTagByName(input?.value);
        if (ok && input) input.value = '';
    };
    document.getElementById('cqst-top-quick-tag-btn').addEventListener('click', handleTopQuickTag);
    document.getElementById('cqst-top-quick-tag-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleTopQuickTag();
        }
    });

    document.getElementById('cqst-top-btn-tags').addEventListener('click', openTagModal);

    document.getElementById('cqst-top-btn-archive').addEventListener('click', async () => {
        let raw = document.getElementById('cqst-top-archive-preview').value.trim();
        if (!raw) {
            raw = scrapeTopChatByUI();
            document.getElementById('cqst-top-archive-preview').value = raw;
        }
        const useAi = document.getElementById('cqst-top-chk-aisum').checked;
        const saved = await archiveMemorySlice({
            rawText: raw,
            useAiSummary: useAi,
            tags: Array.from(state.selectedTags),
            defaultEvent: '酒馆归档'
        });
        if (saved) document.getElementById('cqst-top-archive-preview').value = '';
    });

    document.getElementById('cqst-top-chk-autoarchive').addEventListener('change', (e) => {
        state.config.autoArchiveEnabled = e.target.checked;
        saveSettings();
        renderAllUI();
        showToast(
            e.target.checked ? '已开启自动总结归档' : '已关闭自动总结归档',
            e.target.checked ? `每满 ${state.config.autoTurns} 轮新对话将自动提炼存入当前隔间` : '未开启前不会自动存，可随时手动归档',
            'info'
        );
    });

    document.getElementById('cqst-top-chk-autoinject').addEventListener('change', (e) => {
        state.config.autoInjectEnabled = e.target.checked;
        saveSettings();
        if (!e.target.checked && !state.stagedManualRecall) clearExtensionPromptSafe();
        renderAllUI();
        showToast(e.target.checked ? '已开启自动向量注入' : '已关闭自动向量注入', getInjectDepthLabel(), 'info');
    });

    document.getElementById('cqst-top-tag-filter').addEventListener('change', (e) => {
        state.activeTagFilter = e.target.value || '';
    });

    document.getElementById('cqst-top-btn-recall-mount').addEventListener('click', () => {
        runManualRecallMount(document.getElementById('cqst-top-recall-input').value);
    });
    document.getElementById('cqst-top-btn-recall-clear').addEventListener('click', () => {
        clearMountedRecall({ clearPreview: true });
        showToast('已清除深度层挂载', '', 'info');
    });

    document.getElementById('cqst-drawer-search').addEventListener('input', () => {
        state.slicePage = 1;
        renderDrawerSlices();
    });
    document.getElementById('cqst-btn-toggle-collapse-slices').addEventListener('click', () => {
        state.slicesCollapsed = !state.slicesCollapsed;
        state.toggledSliceIds.clear();
        renderDrawerSlices();
    });
    document.getElementById('cqst-btn-add-manual-slice').addEventListener('click', () => openSliceModal(null));

    document.getElementById('cqst-btn-export-json').addEventListener('click', () => {
        const slices = getCachedSlices(state.currentCompartment);
        const blob = new Blob([JSON.stringify(slices, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.currentCompartment}_memories_${getTodayDate()}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast('已导出 JSON', `隔间 [${state.currentCompartment}] 共 ${slices.length} 条记忆`, 'info');
    });

    document.getElementById('cqst-btn-import-json').addEventListener('click', () => {
        document.getElementById('cqst-import-file-input').click();
    });

    document.getElementById('cqst-import-file-input').addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        showLoading('IMPORTING', '正在导入记忆并补全缺失向量...');
        try {
            const raw = JSON.parse(await file.text());
            const items = Array.isArray(raw) ? raw : (Array.isArray(raw?.slices) ? raw.slices : []);
            if (!items.length) throw new Error('JSON 中未包含有效记忆数组');

            const existing = [...getCachedSlices(state.currentCompartment)];
            const seenIds = new Set(existing.map(s => s.id));
            let importedCount = 0;

            for (const item of items) {
                const text = typeof item === 'string' ? item : (item?.text || '');
                if (!text.trim()) continue;
                const id = (item?.id && !seenIds.has(item.id)) ? item.id : generateUUID();
                seenIds.add(id);
                const tags = Array.isArray(item?.tags) && item.tags.length ? item.tags : ['日常点滴'];
                const event = item?.event || '导入记录';
                const vector = Array.isArray(item?.vector) && item.vector.length
                    ? compactVector(item.vector)
                    : await getEmbeddingVector(`${event} ${tags.join(' ')} ${text}`);
                existing.push({ id, text: text.trim(), date: item?.date || getTodayDate(), tags, event, vector });
                importedCount++;
            }

            await saveCompartment(state.currentCompartment, existing, `Import ${importedCount} slices`);
            renderAllUI();
            showToast('导入成功', `已导入 ${importedCount} 条记忆到 [${state.currentCompartment}]`);
        } catch (err) {
            showToast('导入失败', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    document.getElementById('cqst-btn-reembed').addEventListener('click', async () => {
        const slices = [...getCachedSlices(state.currentCompartment)];
        if (!slices.length) {
            showToast('当前隔间为空', '暂无记忆需要重算向量', 'warn');
            return;
        }
        if (!confirm(`确定使用当前向量设置重新计算 [${state.currentCompartment}] 共 ${slices.length} 条记忆的向量吗？`)) return;
        showLoading('RE-EMBEDDING', `正在重算 0 / ${slices.length}...`);
        try {
            const sub = document.getElementById('cqst-loading-sub');
            for (let i = 0; i < slices.length; i++) {
                if (sub) sub.textContent = `正在重算向量 ${i + 1} / ${slices.length}...`;
                const s = slices[i];
                const input = `${s.event || ''} ${(s.tags || []).join(' ')} ${s.text || ''}`.trim();
                s.vector = await getEmbeddingVector(input, getEmbedApiConfig().provider !== 'local');
            }
            await saveCompartment(state.currentCompartment, slices, `Re-embed ${slices.length} slices`);
            renderAllUI();
            showToast('向量重算完成', `已更新 ${slices.length} 条记忆向量`);
        } catch (err) {
            showToast('重算中止', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    // Tab 2: 隔间与分支总管
    document.getElementById('cqst-top-rename-existing').addEventListener('change', (e) => {
        if (e.target.value) document.getElementById('cqst-top-rename-input').value = e.target.value;
    });
    document.getElementById('cqst-top-btn-rename').addEventListener('click', () => {
        handleCompartmentRenameAction(
            document.getElementById('cqst-top-rename-input').value,
            document.getElementById('cqst-top-rename-delold').checked
        );
    });
    document.getElementById('cqst-top-btn-bind').addEventListener('click', () => {
        handleCompartmentBindAction(document.getElementById('cqst-top-rename-input').value);
    });
    document.getElementById('cqst-top-btn-reset-default').addEventListener('click', handleCompartmentResetDefaultAction);

    const handleCreateBranch = async () => {
        const input = document.getElementById('cqst-new-branch-input');
        const raw = (input.value || '').trim();
        if (!raw) {
            showToast('请输入隔间名', '', 'warn');
            return;
        }
        const name = sanitizeCompartmentName(raw);
        input.value = '';
        showLoading('CREATING', `正在创建并切换到 [${name}]...`);
        try {
            ensureCompartmentRegistered(name);
            await pushGlobalProfileIfGithub(`Add compartment ${name}`);
            await switchChatToCompartment(name, { bindCurrentChat: true, forceRemote: isGithubModeActive() });
            await renderBranchManagerList();
            await syncRenameInputsUI();
            showToast('隔间已就绪', `当前聊天已绑定到 [${name}]`);
        } catch (err) {
            showToast('创建失败', err.message, 'err');
        } finally {
            hideLoading();
        }
    };
    document.getElementById('cqst-btn-create-branch').addEventListener('click', handleCreateBranch);
    document.getElementById('cqst-new-branch-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleCreateBranch();
    });

    document.getElementById('cqst-btn-refresh-branches').addEventListener('click', async () => {
        showLoading('SCANNING', '正在扫描本地 IndexedDB 与 GitHub 隔间...');
        try {
            if (isGithubModeActive()) await syncGlobalProfileFromGithub();
            await renderBranchManagerList();
            await syncRenameInputsUI();
            showToast('扫描完成', `共发现 ${state.globalProfile.branchList.length} 个隔间`, 'info');
        } catch (err) {
            showToast('扫描出错', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    document.getElementById('cqst-btn-scan-official').addEventListener('click', async () => {
        if (!isGithubConfigured()) {
            showToast('请先配置 GitHub PAT 与仓库', '', 'warn');
            return;
        }
        showLoading('SCANNING ROOT', '正在读取仓库根目录 branches/ ...');
        try {
            const list = await githubListBranchFiles('branches');
            const sel = document.getElementById('cqst-official-branch-select');
            sel.innerHTML = '';
            if (!list.length) {
                sel.innerHTML = '<option value="">仓库根目录 branches/ 下暂无隔间</option>';
                showToast('未发现隔间', '仓库根目录下 branches/ 为空', 'info');
                return;
            }
            list.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = `branches/${name}.json`;
                sel.appendChild(opt);
            });
            showToast('读取成功', `共发现 ${list.length} 个根目录隔间`, 'info');
        } catch (err) {
            showToast('扫描失败', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    document.getElementById('cqst-btn-clone-official').addEventListener('click', async () => {
        const srcName = document.getElementById('cqst-official-branch-select').value;
        if (!srcName) {
            showToast('请先扫描并选择一个根目录隔间', '', 'warn');
            return;
        }
        const rawTarget = prompt(`将根目录隔间「${srcName}」单向克隆到酒馆，新隔间名为（不影响原 branches/ 文件）：`, `导入_${srcName}`);
        if (!rawTarget || !rawTarget.trim()) return;
        const dstName = sanitizeCompartmentName(rawTarget);

        showLoading('CLONING', `正在从 branches/${srcName}.json 复制到酒馆 [${dstName}]...`);
        try {
            const remote = await githubGetFile(`branches/${srcName}.json`);
            const srcSlices = Array.isArray(remote?.json) ? remote.json : (remote?.json?.slices || []);
            await loadCompartment(dstName, { forceRemote: isGithubModeActive() });
            const merged = mergeSlicesNonDestructive(getCachedSlices(dstName), srcSlices);
            await saveCompartment(dstName, merged, `Clone from official branches/${srcName}.json`);
            await switchChatToCompartment(dstName, { bindCurrentChat: true, forceRemote: false });
            await pushGlobalProfileIfGithub(`Clone official branch ${srcName} -> ${dstName}`);
            await renderBranchManagerList();
            await syncRenameInputsUI();
            showToast('克隆成功', `已导入 ${srcSlices.length} 条记忆到酒馆隔间 [${dstName}]`);
        } catch (err) {
            showToast('克隆失败', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    // Tab 3: 存储、模型与深度配置
    document.getElementById('cqst-cfg-storage-mode').addEventListener('change', toggleSettingsConditionalBoxes);
    document.getElementById('cqst-cfg-api-provider').addEventListener('change', (e) => {
        const val = e.target.value;
        const baseEl = document.getElementById('cqst-cfg-chat-base');
        if (val === 'siliconflow' && (!baseEl.value.trim() || baseEl.value.includes('generativelanguage.googleapis.com'))) {
            baseEl.value = 'https://api.siliconflow.cn/v1';
        } else if (val === 'gemini' && (!baseEl.value.trim() || baseEl.value.includes('siliconflow.cn'))) {
            baseEl.value = 'https://generativelanguage.googleapis.com';
        }
        toggleSettingsConditionalBoxes();
        populateSettingsModelSelects();
    });

    document.getElementById('cqst-cfg-embed-provider').addEventListener('change', (e) => {
        const val = e.target.value;
        const baseEl = document.getElementById('cqst-cfg-embed-base');
        if (val === 'siliconflow' && (!baseEl.value.trim() || baseEl.value.includes('generativelanguage.googleapis.com'))) {
            baseEl.value = 'https://api.siliconflow.cn/v1';
        } else if (val === 'gemini' && (!baseEl.value.trim() || baseEl.value.includes('siliconflow.cn'))) {
            baseEl.value = 'https://generativelanguage.googleapis.com';
        }
        toggleSettingsConditionalBoxes();
        populateSettingsModelSelects();
    });

    document.getElementById('cqst-btn-fetch-chat').addEventListener('click', async () => {
        const btn = document.getElementById('cqst-btn-fetch-chat');
        btn.disabled = true;
        try {
            await fetchModelsFor('chat');
        } catch (err) {
            showToast('拉取失败', err.message, 'err');
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('cqst-btn-fetch-embed').addEventListener('click', async () => {
        const btn = document.getElementById('cqst-btn-fetch-embed');
        btn.disabled = true;
        try {
            await fetchModelsFor('embed');
        } catch (err) {
            showToast('拉取失败', err.message, 'err');
        } finally {
            btn.disabled = false;
        }
    });

    document.getElementById('cqst-btn-reset-pill').addEventListener('click', () => {
        resetPillPosition();
        showToast('已重置悬浮球位置', '', 'info');
    });

    document.getElementById('cqst-btn-test-github').addEventListener('click', async () => {
        const prevRepo = (state.config.githubRepo || '').trim();
        const prevDirMode = state.config.githubDirMode || 'isolated';
        const nextRepo = document.getElementById('cqst-cfg-github-repo').value.trim();
        const nextDirMode = document.getElementById('cqst-cfg-github-dir-mode').value || 'isolated';

        state.config.githubPat = document.getElementById('cqst-cfg-github-pat').value.trim();
        state.config.githubRepo = nextRepo;
        state.config.githubDirMode = nextDirMode;
        resetRemoteShaIfTargetChanged(prevRepo, prevDirMode, nextRepo, nextDirMode);

        if (!isGithubConfigured()) {
            showToast('参数不完整', '请先填写 GitHub PAT 与 Owner/Repo', 'warn');
            return;
        }
        showLoading('CONNECTING', '正在测试 GitHub 仓库并同步目录...');
        try {
            await syncGlobalProfileFromGithub();
            await loadCompartment(state.currentCompartment, { forceRemote: true });
            renderAllUI();
            const scopeLabel = isGithubIsolatedMode() ? 'tavern/ 独立目录' : '根目录共用';
            showToast('GitHub 连接成功', `已同步 ${state.globalProfile.branchList.length} 个隔间 (${scopeLabel})`);
        } catch (err) {
            showToast('连接失败', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    document.getElementById('cqst-btn-push-cur-github').addEventListener('click', async () => {
        const prevRepo = (state.config.githubRepo || '').trim();
        const prevDirMode = state.config.githubDirMode || 'isolated';
        const nextRepo = document.getElementById('cqst-cfg-github-repo').value.trim();
        const nextDirMode = document.getElementById('cqst-cfg-github-dir-mode').value || 'isolated';

        state.config.githubPat = document.getElementById('cqst-cfg-github-pat').value.trim();
        state.config.githubRepo = nextRepo;
        state.config.githubDirMode = nextDirMode;
        resetRemoteShaIfTargetChanged(prevRepo, prevDirMode, nextRepo, nextDirMode);

        if (!isGithubConfigured()) {
            showToast('请先填写 GitHub PAT 与仓库', '', 'warn');
            return;
        }
        showLoading('PUSHING', `正在将 [${state.currentCompartment}] 无损合并上传到 GitHub...`);
        try {
            const slices = getCachedSlices(state.currentCompartment);
            const total = await pushLocalCompartmentMergedToGithub(
                state.currentCompartment,
                slices,
                `Merge & push local compartment ${state.currentCompartment}`
            );
            await syncGlobalProfileFromGithub();
            renderAllUI();
            showToast('推送合并成功', `${getGithubBranchPath(state.currentCompartment)} 共 ${total} 条记忆`);
        } catch (err) {
            showToast('推送失败', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    document.getElementById('cqst-btn-push-all-github').addEventListener('click', async () => {
        const prevRepo = (state.config.githubRepo || '').trim();
        const prevDirMode = state.config.githubDirMode || 'isolated';
        const nextRepo = document.getElementById('cqst-cfg-github-repo').value.trim();
        const nextDirMode = document.getElementById('cqst-cfg-github-dir-mode').value || 'isolated';

        state.config.githubPat = document.getElementById('cqst-cfg-github-pat').value.trim();
        state.config.githubRepo = nextRepo;
        state.config.githubDirMode = nextDirMode;
        resetRemoteShaIfTargetChanged(prevRepo, prevDirMode, nextRepo, nextDirMode);

        if (!isGithubConfigured()) {
            showToast('请先填写 GitHub PAT 与仓库', '', 'warn');
            return;
        }
        const items = (await idbListCompartments()).filter(i => i.count > 0);
        if (!items.length) {
            showToast('本地暂无非空隔间', '', 'warn');
            return;
        }
        const dirTip = isGithubIsolatedMode() ? 'tavern/branches/' : 'branches/';
        if (!confirm(`确定将本地共 ${items.length} 个有数据的隔间合并上传到仓库 ${dirTip} 吗？（同名云端记忆会保留合并，不会直接覆盖丢失）`)) return;
        showLoading('MIGRATING ALL', `准备合并上传 ${items.length} 个隔间...`);
        try {
            const sub = document.getElementById('cqst-loading-sub');
            for (let i = 0; i < items.length; i++) {
                const rec = await idbGetCompartment(items[i].name);
                if (!rec?.slices?.length) continue;
                if (sub) sub.textContent = `正在合并上传 ${i + 1}/${items.length}: ${items[i].name}`;
                await pushLocalCompartmentMergedToGithub(
                    items[i].name,
                    rec.slices,
                    `Merge & migrate local ${items[i].name}`
                );
            }
            await syncGlobalProfileFromGithub();
            renderAllUI();
            showToast('全量合并上传完成', `已同步 ${items.length} 个隔间至 ${dirTip}`);
        } catch (err) {
            showToast('迁移中断', err.message, 'err');
        } finally {
            hideLoading();
        }
    });

    document.getElementById('cqst-btn-reset-summary-prompt').addEventListener('click', () => {
        if (!confirm('确定将 AI 记忆切片提炼提示词恢复为默认模板吗？')) return;
        state.config.summaryPrompt = DEFAULT_SUMMARY_PROMPT;
        const ta = document.getElementById('cqst-cfg-summary-prompt');
        if (ta) ta.value = DEFAULT_SUMMARY_PROMPT;
        saveSettings();
        showToast('已恢复默认提示词', '后续 AI 总结归档将使用默认切片规则', 'info');
    });

    document.getElementById('cqst-btn-update-plugin').addEventListener('click', () => {
        if (state.updateInfo.hasUpdate) triggerPluginOneClickUpdate();
        else checkPluginUpdate({ manual: true });
    });

    document.getElementById('cqst-btn-save-settings').addEventListener('click', async () => {
        const prevRepo = (state.config.githubRepo || '').trim();
        const prevDirMode = state.config.githubDirMode || 'isolated';
        const wasSyncedBefore = Boolean(state.globalProfile.sha);
        const prevPersona = state.globalProfile.persona || '';
        const prevBranchPersona = state.globalProfile.branchPersonas?.[state.currentCompartment] || '';
        const inputPersona = document.getElementById('cqst-cfg-global-persona').value.trim();
        const inputBranchPersona = document.getElementById('cqst-cfg-branch-persona').value.trim();

        const nextRepo = document.getElementById('cqst-cfg-github-repo').value.trim();
        const nextDirMode = document.getElementById('cqst-cfg-github-dir-mode').value || 'isolated';

        state.config.storageMode = document.getElementById('cqst-cfg-storage-mode').value || 'local';
        state.config.githubDirMode = nextDirMode;
        state.config.githubPat = document.getElementById('cqst-cfg-github-pat').value.trim();
        state.config.githubRepo = nextRepo;
        resetRemoteShaIfTargetChanged(prevRepo, prevDirMode, nextRepo, nextDirMode);

        state.config.apiProvider = document.getElementById('cqst-cfg-api-provider').value || 'gemini';
        state.config.geminiKey = document.getElementById('cqst-cfg-chat-key').value.trim();
        state.config.geminiBase = document.getElementById('cqst-cfg-chat-base').value.trim() || 'https://generativelanguage.googleapis.com';
        const customChat = document.getElementById('cqst-cfg-chat-model-custom').value.trim();
        state.config.chatModel = customChat || document.getElementById('cqst-cfg-chat-model').value || 'gemini-2.5-flash';

        state.config.embedProvider = document.getElementById('cqst-cfg-embed-provider').value || 'same';
        state.config.embedKey = document.getElementById('cqst-cfg-embed-key').value.trim();
        state.config.embedBase = document.getElementById('cqst-cfg-embed-base').value.trim() || 'https://api.siliconflow.cn/v1';
        const customEmbed = document.getElementById('cqst-cfg-embed-model-custom').value.trim();
        state.config.embedModel = customEmbed || document.getElementById('cqst-cfg-embed-model').value || 'text-embedding-004';
        state.config.rerankEnabled = document.getElementById('cqst-cfg-rerank-enabled').checked;
        state.config.rerankModel = document.getElementById('cqst-cfg-rerank-model').value || 'BAAI/bge-reranker-v2-m3';

        state.config.injectPosition = parseIntInRange(document.getElementById('cqst-cfg-inject-pos').value, 0, 2, 1);
        state.config.injectDepth = parseIntInRange(document.getElementById('cqst-cfg-inject-depth').value, 0, 99, 0);
        state.config.injectRole = parseIntInRange(document.getElementById('cqst-cfg-inject-role').value, 0, 2, 0);

        state.config.topK = parseIntInRange(document.getElementById('cqst-cfg-topk').value, 1, 20, 5);
        const minS = parseFloat(document.getElementById('cqst-cfg-minscore').value);
        state.config.minScore = Number.isFinite(minS) ? Math.min(0.95, Math.max(0, minS)) : 0.38;
        state.config.recallScanFloors = parseIntInRange(document.getElementById('cqst-cfg-scan-floors').value, 1, 12, 4);
        state.config.autoTurns = parseIntInRange(document.getElementById('cqst-cfg-autoturns').value, 1, 50, 10);
        state.config.showRecallToast = document.getElementById('cqst-cfg-recall-toast').checked;
        state.config.showFloatingPill = document.getElementById('cqst-cfg-show-pill').checked;
        const rawSumPrompt = document.getElementById('cqst-cfg-summary-prompt').value.trim();
        state.config.summaryPrompt = rawSumPrompt || DEFAULT_SUMMARY_PROMPT;

        // 同步刷新若正在手动挂载的深度层位置
        if (state.stagedManualRecall && state.stagedManualRecall.compartment === state.currentCompartment) {
            mountRecallToDepthLayer(state.stagedManualRecall.recalled, { query: state.stagedManualRecall.query, isManual: true });
        }

        const applyLocalPersonas = () => {
            state.globalProfile.persona = inputPersona;
            state.globalProfile.branchPersonas = state.globalProfile.branchPersonas || {};
            if (inputBranchPersona) state.globalProfile.branchPersonas[state.currentCompartment] = inputBranchPersona;
            else delete state.globalProfile.branchPersonas[state.currentCompartment];
        };

        if (!isGithubModeActive()) {
            applyLocalPersonas();
            saveSettings();
            populateSettingsUI();
            renderAllUI();
            showToast('配置已保存', `当前注入层级：${getInjectDepthLabel()} · 本地存储`);
            return;
        }

        saveSettings();
        showLoading('SYNCING', '正在无损同步 GitHub 私人仓库...');
        try {
            await syncGlobalProfileFromGithub();
            const switchedTarget = prevRepo !== nextRepo || prevDirMode !== nextDirMode;
            const remoteBranchPersona = state.globalProfile.branchPersonas?.[state.currentCompartment] || '';
            const shouldPushPersona = (inputPersona && inputPersona !== state.globalProfile.persona)
                || (wasSyncedBefore && !switchedTarget && inputPersona !== prevPersona);
            const shouldPushBranch = (inputBranchPersona && inputBranchPersona !== remoteBranchPersona)
                || (wasSyncedBefore && !switchedTarget && inputBranchPersona !== prevBranchPersona);

            if (shouldPushPersona || shouldPushBranch) {
                if (shouldPushPersona) state.globalProfile.persona = inputPersona;
                if (shouldPushBranch) {
                    state.globalProfile.branchPersonas = state.globalProfile.branchPersonas || {};
                    if (inputBranchPersona) state.globalProfile.branchPersonas[state.currentCompartment] = inputBranchPersona;
                    else delete state.globalProfile.branchPersonas[state.currentCompartment];
                }
                await pushGlobalProfileIfGithub('Update settings & persona from SillyTavern');
            }
            await loadCompartment(state.currentCompartment, { forceRemote: true });
            const scopeTip = isGithubIsolatedMode() ? 'tavern/ 隔离目录' : '根目录共用';
            showToast('配置已保存并同步', `${state.config.githubRepo} (${scopeTip}) · ${getInjectDepthLabel()}`);
        } catch (err) {
            showToast('本地已保存', `GitHub 同步提示: ${err.message}`, 'warn');
        } finally {
            hideLoading();
        }
        populateSettingsUI();
        renderAllUI();
    });
}

/* ============================================================================
   15. SillyTavern 事件监听 (CHAT_CHANGED / CHARACTER_MESSAGE_RENDERED) & 启动
   ============================================================================ */
async function onChatChanged() {
    state.turnCounter = 0;
    state.lastCountedMesIndex = -1;
    state.slicePage = 1;
    state.toggledSliceIds.clear();
    clearMountedRecall({ clearPreview: true });

    const resolved = resolveCompartmentForChat();
    state.currentCompartment = resolved.name;
    state.isCustomBound = resolved.isCustom;

    await loadCompartment(resolved.name, { forceRemote: false });
    await syncRenameInputsUI();
    if (state.activePanoramaTab === 'branches') await renderBranchManagerList();
    if (state.activePanoramaTab === 'settings') populateSettingsUI();
    renderAllUI();

    if (isGithubModeActive()) {
        await loadCompartment(resolved.name, { forceRemote: true }).catch(() => {});
        renderAllUI();
    }
}

async function onCharacterMessageRendered(messageId) {
    if (!state.config.autoArchiveEnabled || state.isAutoArchiving) return;
    const ctx = getSTContext();
    const chatArr = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const curIdx = Number.isFinite(Number(messageId)) ? Number(messageId) : (chatArr.length - 1);
    if (curIdx <= state.lastCountedMesIndex) return;
    const lastMes = chatArr[curIdx];
    if (!lastMes || lastMes.is_user || lastMes.is_system) return;

    state.lastCountedMesIndex = curIdx;
    state.turnCounter += 1;

    const targetTurns = parseIntInRange(state.config.autoTurns, 1, 50, 10);
    if (state.turnCounter < targetTurns) return;

    state.turnCounter = 0;
    state.isAutoArchiving = true;
    try {
        const rawText = scrapeSillyTavernChat({ mode: 'unarchived', turns: targetTurns });
        if (rawText) {
            await archiveMemorySlice({
                rawText,
                useAiSummary: true,
                tags: [],
                eventName: '',
                defaultEvent: '自动回合归档',
                silent: true
            });
        }
    } finally {
        state.isAutoArchiving = false;
    }
}

let initPromise = null;

function initExtensionCore() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        state.initialized = true;
        loadSettings();
        mountBaseContainers();
        mountSillyTavernHooks();
        bindBaseUIEvents();

        const ctx = getSTContext();
        if (isGithubModeActive()) {
            await syncGlobalProfileFromGithub().catch(err => {
                console.warn('[初晴记忆库] 初始化同步 GitHub global_profile 失败:', err);
            });
        }

        const resolved = resolveCompartmentForChat(ctx);
        state.currentCompartment = resolved.name;
        state.isCustomBound = resolved.isCustom;
        await loadCompartment(resolved.name, { forceRemote: isGithubModeActive() });
        await syncRenameInputsUI();
        populateSettingsUI();
        renderAllUI();

        if (ctx?.eventSource && ctx?.event_types) {
            if (ctx.event_types.CHAT_CHANGED) {
                ctx.eventSource.on(ctx.event_types.CHAT_CHANGED, () => {
                    onChatChanged();
                });
            }
            if (ctx.event_types.CHARACTER_MESSAGE_RENDERED) {
                ctx.eventSource.on(ctx.event_types.CHARACTER_MESSAGE_RENDERED, (mesId) => {
                    onCharacterMessageRendered(mesId);
                });
            }
        }

        setInterval(() => {
            if (!document.getElementById('cqst-floating-pill')) mountBaseContainers();
            mountSillyTavernHooks();
        }, 3000);

        setTimeout(() => {
            checkPluginUpdate({ manual: false }).catch(() => {});
        }, 2500);
    })();
    return initPromise;
}

(function bootstrap() {
    const start = () => {
        initExtensionCore().catch(err => console.error('[初晴记忆库] 初始化失败:', err));
    };

    const ctx = getSTContext();
    if (ctx?.eventSource && ctx?.event_types?.APP_READY) {
        ctx.eventSource.on(ctx.event_types.APP_READY, start);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(start, 600));
    } else {
        setTimeout(start, 600);
    }
})();
