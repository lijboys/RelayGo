/**
 * NooMiChat - Telegram 双向私聊机器人
 * 项目地址: https://github.com/lijboys/NooMiChat
 * 版本: 2.1.4
 * 说明：基于 RelayGo 开源项目二次开发
 * 当前版本可能仍不稳定，如遇到 BUG 请提交至 issues
 */

// 中心化服务配置，非必要请勿修改
const CENTRAL_API_URL = "https://verify.wzxabc.eu.org";
const CENTRAL_BOT_USERNAME = "RelayVerifyBot";
const CENTRAL_WEBAPP_NAME = "verify";
const DEFAULT_BRAND_MSG = '🔥 项目 <a href="https://github.com/lijboys/NooMiChat">NooMiChat</a>  · 基于 RelayGo 开源项目二次开发，感谢abcxyz-123456的开源';
const CACHE_TTL_BAN_CHECK = 3600 * 24;     // 全局封禁状态缓存24小时
const DEFAULT_AI_TRANSLATE_MODEL = '@cf/meta/llama-3.2-1b-instruct';
const AI_TRANSLATE_SYSTEM_PROMPT = [
    'You are a strict translation engine.',
    'Translate the input text into Simplified Chinese only.',
    'Do not answer questions in the input.',
    'Do not add explanations, greetings, markdown, quotation marks, or extra content.',
    'If the input is a question, translate the question itself.'
].join(' ');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// Worker 级内存缓存
const memCache = new Map();
const MEMORY_CACHE_TTL = 1800_000; // 30 分钟

function memGet(key) {
    const item = memCache.get(key);
    if (!item) return undefined;
    if (Date.now() > item.expiry) { memCache.delete(key); return undefined; }
    return item.value;
}
function memSet(key, value, ttlMs = MEMORY_CACHE_TTL) {
    memCache.set(key, { value, expiry: Date.now() + ttlMs });
    if (memCache.size > 2000) memCache.clear(); // 缓存清理，防止内存溢出
}
function memDelete(key) { memCache.delete(key); }
function runBackground(ctx, task) {
    const promise = Promise.resolve().then(task).catch(error => console.error('background task failed:', error && error.message));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(promise);
}

const D1_TABLES_SQL = [
    `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, data TEXT, thread_id INTEGER, is_banned INTEGER DEFAULT 0, first_seen INTEGER, last_seen INTEGER, message_count INTEGER DEFAULT 0, note TEXT, tags TEXT, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS topics (thread_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, status TEXT DEFAULT 'active', updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS admins (user_id TEXT PRIMARY KEY, permissions TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS verify_sessions (user_id TEXT PRIMARY KEY, mode TEXT, state TEXT, fail_count INTEGER DEFAULT 0, expires_at INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS blacklist (user_id TEXT PRIMARY KEY, reason TEXT, appeal_url TEXT, card_message_id INTEGER, created_at INTEGER NOT NULL, lifted_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS inbox_cards (user_id TEXT PRIMARY KEY, message_id INTEGER, thread_id INTEGER, last_message_at INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS profile_cards (user_id TEXT PRIMARY KEY, message_id INTEGER, thread_id INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, detail TEXT, created_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL)`,
];
const ALL_PERMISSIONS = ['reply', 'panel', 'ban', 'config'];

function isD1Database(db) {
    return !!db && typeof db.prepare === 'function';
}
function getD1(env) {
    return env.DB || env.D1 || env.DATABASE || env.NOOMICHAT_DB || env.RELAYGO_DB || (isD1Database(env.KV) ? env.KV : null) || null;
}
function createD1KVCompat(db) {
    let ready = false;
    async function ensureStore() {
        if (ready) return;
        await db.prepare('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL)').run();
        ready = true;
    }
    async function cleanupExpired(key) {
        const now = Date.now();
        if (key) await db.prepare('DELETE FROM kv_store WHERE key = ? AND expires_at IS NOT NULL AND expires_at <= ?').bind(String(key), now).run();
        else await db.prepare('DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at <= ?').bind(now).run();
    }
    return {
        async get(key, options = {}) {
            await ensureStore();
            await cleanupExpired(key);
            const row = await db.prepare('SELECT value FROM kv_store WHERE key = ?').bind(String(key)).first();
            if (!row) return null;
            if (options && options.type === 'json') {
                try { return JSON.parse(row.value); } catch (e) { return null; }
            }
            return row.value;
        },
        async put(key, value, options = {}) {
            await ensureStore();
            const now = Date.now();
            let expiresAt = null;
            if (options && options.expirationTtl) expiresAt = now + Number(options.expirationTtl) * 1000;
            if (options && options.expiration) expiresAt = Number(options.expiration) * 1000;
            const storedValue = typeof value === 'string' ? value : JSON.stringify(value);
            await db.prepare('INSERT INTO kv_store (key, value, expires_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, updated_at = excluded.updated_at')
                .bind(String(key), storedValue, expiresAt, now).run();
        },
        async delete(key) {
            await ensureStore();
            await db.prepare('DELETE FROM kv_store WHERE key = ?').bind(String(key)).run();
        },
        async list(options = {}) {
            await ensureStore();
            await cleanupExpired();
            const prefix = String((options && options.prefix) || '');
            const limit = Math.min(Math.max(Number(options && options.limit) || 1000, 1), 1000);
            const offset = Math.max(parseInt((options && options.cursor) || '0', 10) || 0, 0);
            const result = await db.prepare('SELECT key FROM kv_store WHERE key LIKE ? ORDER BY key LIMIT ? OFFSET ?').bind(`${prefix}%`, limit + 1, offset).all();
            const rows = result.results || [];
            const hasMore = rows.length > limit;
            return {
                keys: rows.slice(0, limit).map(row => ({ name: row.key })),
                list_complete: !hasMore,
                cursor: hasMore ? String(offset + limit) : undefined
            };
        }
    };
}
async function ensureD1Schema(env) {
    const db = getD1(env);
    if (!db || memGet('__d1_schema_ready')) return !!db;
    for (const sql of D1_TABLES_SQL) await db.prepare(sql).run();
    memSet('__d1_schema_ready', true, 24 * 3600_000);
    return true;
}
function configKey(key) { return key.startsWith('config:') ? key.slice(7) : key; }
function kvConfigKey(key) { return key.startsWith('config:') ? key : `config:${key}`; }
async function getConfig(env, key, fallback = null) {
    const normalized = configKey(key);
    const cacheKey = `config:${normalized}`;
    const cached = memGet(cacheKey);
    if (cached !== undefined) return cached;
    const db = getD1(env);
    if (db) {
        await ensureD1Schema(env);
        const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(normalized).first();
        if (row && row.value !== null && row.value !== undefined) { memSet(cacheKey, row.value); return row.value; }
    }
    const kvValue = env.KV ? await env.KV.get(kvConfigKey(key)) : null;
    const value = kvValue === null || kvValue === undefined ? fallback : kvValue;
    memSet(cacheKey, value);
    return value;
}
async function setConfig(env, key, value) {
    const normalized = configKey(key);
    const stringValue = value === null || value === undefined ? '' : String(value);
    const db = getD1(env);
    if (db) {
        await ensureD1Schema(env);
        await db.prepare('INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').bind(normalized, stringValue, Date.now()).run();
    }
    if (env.KV) await env.KV.put(kvConfigKey(key), stringValue);
    memDelete(`config:${normalized}`);
    return stringValue;
}

async function deleteConfig(env, key) {
    const normalized = configKey(key);
    const db = getD1(env);
    if (db) {
        await ensureD1Schema(env);
        await db.prepare('DELETE FROM config WHERE key = ?').bind(normalized).run();
    }
    if (env.KV) await env.KV.delete(kvConfigKey(key));
    memDelete(`config:${normalized}`);
}

function getAdminPermissions(value) {
    return String(value || '').split(',').map(x => x.trim()).filter(x => ALL_PERMISSIONS.includes(x));
}
async function getUser(env, userId) {
    const key = `user:${userId}`;
    const cached = memGet(key);
    if (cached !== undefined) return cached;
    const db = getD1(env);
    if (db) {
        await ensureD1Schema(env);
        const row = await db.prepare('SELECT * FROM users WHERE user_id = ?').bind(String(userId)).first();
        if (row) {
            const data = row.data ? JSON.parse(row.data) : {};
            const user = { ...data, thread_id: data.thread_id ?? row.thread_id, is_banned: !!row.is_banned, note: row.note ?? data.note, tags: row.tags ? JSON.parse(row.tags) : (data.tags || []) };
            memSet(key, user);
            return user;
        }
    }
    const kvUser = env.KV ? await env.KV.get(key, { type: 'json' }) : null;
    if (kvUser) memSet(key, kvUser);
    else memSet(key, null, 60_000);
    return kvUser;
}
async function upsertUser(env, user) {
    const userId = String(user.user_id || user.id || (user.user_info && user.user_info.id));
    if (!userId || userId === 'undefined') throw new Error('upsertUser requires user_id');
    const now = Date.now();
    const current = await getUser(env, userId) || {};
    const next = { ...current, ...user, user_id: userId, updated_at: now };
    const db = getD1(env);
    if (db) {
        await ensureD1Schema(env);
        await db.prepare(`INSERT INTO users (user_id, data, thread_id, is_banned, first_seen, last_seen, message_count, note, tags, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, thread_id = excluded.thread_id, is_banned = excluded.is_banned, last_seen = excluded.last_seen, message_count = excluded.message_count, note = excluded.note, tags = excluded.tags, updated_at = excluded.updated_at`)
            .bind(userId, JSON.stringify(next), next.thread_id || null, next.is_banned ? 1 : 0, next.first_seen || now, next.last_seen || now, next.message_count || 0, next.note || null, JSON.stringify(next.tags || []), now).run();
        if (next.thread_id) await db.prepare('INSERT INTO topics (thread_id, user_id, title, status, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET user_id = excluded.user_id, title = excluded.title, status = excluded.status, updated_at = excluded.updated_at').bind(next.thread_id, userId, next.topic_title || null, next.is_banned ? 'banned' : 'active', now).run();
    }
    if (env.KV) await env.KV.put(`user:${userId}`, JSON.stringify(next));
    memSet(`user:${userId}`, next);
    return next;
}
async function getUserIdByThread(env, threadId) {
    let mappedUserId = env.KV ? await env.KV.get(`thread:${threadId}`) : null;
    if (mappedUserId) return String(mappedUserId);
    const db = getD1(env);
    if (!db) return null;
    await ensureD1Schema(env);
    const row = await db.prepare('SELECT user_id FROM topics WHERE thread_id = ?').bind(Number(threadId)).first();
    return row && row.user_id ? String(row.user_id) : null;
}
async function getAdmin(env, userId) {
    if (String(userId) === String(env.OWNER_ID)) return { user_id: String(userId), permissions: ALL_PERMISSIONS, is_owner: true };
    const cacheKey = `admin:${userId}`;
    const cached = memGet(cacheKey);
    if (cached !== undefined) return cached;
    const db = getD1(env);
    if (!db) return null;
    await ensureD1Schema(env);
    const row = await db.prepare('SELECT permissions FROM admins WHERE user_id = ?').bind(String(userId)).first();
    if (!row) { memSet(cacheKey, null, 60_000); return null; }
    const admin = { user_id: String(userId), permissions: JSON.parse(row.permissions || '[]'), is_owner: false };
    memSet(cacheKey, admin, 60_000);
    return admin;
}
async function isAdmin(env, userId) { return !!(await getAdmin(env, userId)); }
async function hasPermission(env, userId, permission) {
    const admin = await getAdmin(env, userId);
    return !!admin && (admin.is_owner || admin.permissions.includes(permission));
}
async function listAdmins(env) {
    const rows = [];
    if (env.OWNER_ID) rows.push({ user_id: String(env.OWNER_ID), permissions: ALL_PERMISSIONS, is_owner: true });
    const db = getD1(env);
    if (db) {
        await ensureD1Schema(env);
        const result = await db.prepare('SELECT user_id, permissions, created_at FROM admins ORDER BY created_at DESC').all();
        for (const row of (result.results || [])) rows.push({ user_id: String(row.user_id), permissions: JSON.parse(row.permissions || '[]'), is_owner: false });
    }
    return rows;
}
async function addAdmin(env, userId, permissions = ALL_PERMISSIONS) {
    const db = getD1(env);
    if (!db) throw new Error('D1 binding is required to store co-admins');
    await ensureD1Schema(env);
    const allowed = permissions.filter(p => ALL_PERMISSIONS.includes(p));
    const finalPerms = allowed.length ? allowed : ['reply', 'panel'];
    const now = Date.now();
    await db.prepare('INSERT INTO admins (user_id, permissions, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET permissions = excluded.permissions, updated_at = excluded.updated_at').bind(String(userId), JSON.stringify(finalPerms), now, now).run();
    memDelete(`admin:${userId}`);
    return finalPerms;
}
async function removeAdmin(env, userId) {
    if (String(userId) === String(env.OWNER_ID)) throw new Error('OWNER_ID cannot be removed');
    const db = getD1(env);
    if (!db) throw new Error('D1 binding is required to store co-admins');
    await ensureD1Schema(env);
    await db.prepare('DELETE FROM admins WHERE user_id = ?').bind(String(userId)).run();
    memDelete(`admin:${userId}`);
}
async function writeAuditLog(env, actorId, action, targetId = '', detail = {}) {
    const db = getD1(env);
    if (!db) return;
    try {
        await ensureD1Schema(env);
        const detailText = typeof detail === 'string' ? detail : JSON.stringify(detail || {});
        await db.prepare('INSERT INTO audit_logs (actor_id, action, target_id, detail, created_at) VALUES (?, ?, ?, ?, ?)')
            .bind(actorId ? String(actorId) : null, String(action), targetId ? String(targetId) : null, detailText, Date.now()).run();
    } catch (e) {
        console.error('writeAuditLog failed:', e && e.message);
    }
}
async function upsertVerifySession(env, userId, mode, state, failCount = 0, ttlSeconds = 600) {
    const db = getD1(env);
    if (!db) return;
    try {
        await ensureD1Schema(env);
        const now = Date.now();
        const expiresAt = ttlSeconds ? now + ttlSeconds * 1000 : null;
        await db.prepare('INSERT INTO verify_sessions (user_id, mode, state, fail_count, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, state = excluded.state, fail_count = excluded.fail_count, expires_at = excluded.expires_at, updated_at = excluded.updated_at')
            .bind(String(userId), mode || null, state || null, Number(failCount) || 0, expiresAt, now).run();
    } catch (e) {
        console.error('upsertVerifySession failed:', e && e.message);
    }
}
async function deleteVerifySession(env, userId) {
    const db = getD1(env);
    if (!db) return;
    try {
        await ensureD1Schema(env);
        await db.prepare('DELETE FROM verify_sessions WHERE user_id = ?').bind(String(userId)).run();
    } catch (e) {
        console.error('deleteVerifySession failed:', e && e.message);
    }
}
// 工具函数
function escapeHtml(unsafe) {
    if (typeof unsafe !== 'string') return String(unsafe || '');
    return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
const errorResponse = (msg, status = 500) => jsonResponse({ error: msg }, status);

function isKVNamespace(kv) {
    return !!kv && typeof kv.get === 'function' && typeof kv.put === 'function' && typeof kv.delete === 'function';
}
function describeKVBinding(env) {
    const kv = env && env.KV;
    const type = kv === null ? 'null' : Array.isArray(kv) ? 'array' : typeof kv;
    let keys = [];
    try { if (kv && (type === 'object' || type === 'function')) keys = Object.keys(kv).slice(0, 20); } catch (e) { keys = ['<uninspectable>']; }
    return {
        present: !!kv,
        valid: isKVNamespace(kv),
        invalid: !!(env && env.__KV_BINDING_INVALID),
        type,
        keys,
        methods: {
            get: typeof (kv && kv.get),
            put: typeof (kv && kv.put),
            delete: typeof (kv && kv.delete),
            list: typeof (kv && kv.list)
        },
        d1_compat: !!(env && env.__KV_D1_COMPAT)
    };
}

function normalizeEnv(env) {
    if (!env) return env;
    if (isKVNamespace(env.KV)) return env;
    const db = getD1(env);
    if (db) {
        return { ...env, DB: env.DB || db, KV: createD1KVCompat(db), __KV_D1_COMPAT: true, __KV_BINDING_INVALID: !!env.KV && !isD1Database(env.KV) };
    }
    if (env.KV && !isKVNamespace(env.KV)) {
        return { ...env, KV: null, __KV_BINDING_INVALID: true };
    }
    return env;
}

function getRuntimeProblems(env) {
    const problems = [];
    if (!env.BOT_TOKEN) problems.push('Missing BOT_TOKEN secret');
    if (!env.OWNER_ID) problems.push('Missing OWNER_ID variable');
    if (!getD1(env) && !isKVNamespace(env.KV)) problems.push('Missing D1 binding DB or KV binding KV');
    if (env.__KV_BINDING_INVALID && !env.__KV_D1_COMPAT) problems.push('Binding named KV is not a KV Namespace');
    return problems;
}

function assertWebhookReady(env) {
    const problems = getRuntimeProblems(env);
    if (problems.length) {
        throw new Error(`Worker is not ready: ${problems.join('; ')}`);
    }
}

async function tgRequest(token, method, payload) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    try {
        const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const result = await resp.json();
        if (!result.ok) {
            console.error(`[TG API Error] Method: ${method}, Error: ${result.description}, Payload:`, JSON.stringify(payload));
        }
        return result;
    } catch (e) {
        console.error(`[Network Error] Method: ${method}, Error:`, e);
        return { ok: false, description: e.message };
    }
}

// 中心化 API 调用
async function callCentralApi(endpoint, payload) {
    try {
        const baseUrl = CENTRAL_API_URL.endsWith('/') ? CENTRAL_API_URL.slice(0, -1) : CENTRAL_API_URL;
        const headers = { 'Content-Type': 'application/json' };

        const resp = await fetch(`${baseUrl}${endpoint}`, {
            method: 'POST', headers: headers,
            body: JSON.stringify(payload)
        });
        if (!resp.ok) {
            console.error(`Central API Error [${endpoint}]: HTTP ${resp.status}`);
            return null;
        }
        return await resp.json();
    } catch (e) {
        console.error(`Central API Network Error [${endpoint}]:`, e);
        return null;
    }
}

// 错误上报
async function reportError(env, error, context = "") {
    if (env.OWNER_ID && env.BOT_TOKEN) {
        await tgRequest(env.BOT_TOKEN, 'sendMessage', {
            chat_id: env.OWNER_ID,
            text: `🚨 Error: ${context}\n${error.message}`
        });
    }
}

// 按钮解析器
function parseButtons(input) {
    if (!input) return null;
    const rows = [];
    let totalCount = 0;

    const lines = input.split(',');
    for (const line of lines) {
        if (!line.trim()) continue;
        const row = [];
        const items = line.split('|');
        for (const item of items) {
            if (totalCount >= 3) break;

            const separatorMatch = item.match(/\s-\s/);
            let text, url;
            if (separatorMatch) {
                const idx = separatorMatch.index;
                text = item.substring(0, idx).trim();
                url = item.substring(idx + separatorMatch[0].length).trim();
            } else {
                const parts = item.split('-');
                if (parts.length >= 2) {
                    url = parts.pop().trim();
                    text = parts.join('-').trim();
                }
            }

            if (text && url) {
                row.push({ text, url });
                totalCount++;
            }
        }
        if (row.length > 0) rows.push(row);
        if (totalCount >= 3) break;
    }
    return rows.length > 0 ? rows : null;
}

// 发送欢迎消息
async function sendWelcomeMessage(env, userId, options = {}) {
    const welcomeMsg = await getConfig(env, 'welcome_msg', "👋 欢迎使用本机器人！");
    const brandMsg = options.includeBrand ? await getConfig(env, 'brand_msg', DEFAULT_BRAND_MSG) : '';
    let welcomeText = welcomeMsg;
    if (brandMsg) welcomeText += `\n\n${brandMsg}`;

    const payload = { chat_id: userId, text: welcomeText, parse_mode: 'HTML', disable_web_page_preview: true };
    const buttonsJson = await getConfig(env, 'welcome_buttons');
    if (buttonsJson) {
        try { payload.reply_markup = { inline_keyboard: JSON.parse(buttonsJson) }; } catch (e) { }
    }
    const sent = await tgRequest(env.BOT_TOKEN, 'sendMessage', payload);
    if (!sent.ok && String(sent.description || '').includes("can't parse")) {
        delete payload.parse_mode;
        payload.text = welcomeText.replace(/<[^>]+>/g, '');
        await tgRequest(env.BOT_TOKEN, 'sendMessage', payload);
    }
}
async function sendAlreadyVerifiedMessage(env, userId) {
    return tgRequest(env.BOT_TOKEN, 'sendMessage', {
        chat_id: userId,
        text: '✅ 您已通过验证，请直接发送要咨询的消息。'
    });
}

function htmlResponse(html, status = 200) {
    return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS } });
}

function getWebAdminKey(env) {
    return String(env.ADMIN_KEY || env.ADMIN_PASSWORD || env.OWNER_ID || '');
}

function requireWebAdmin(request, env) {
    const expected = getWebAdminKey(env);
    if (!expected) return false;
    const url = new URL(request.url);
    const provided = request.headers.get('x-admin-key') || url.searchParams.get('key') || '';
    return provided && provided === expected;
}

function getBaseUrl(request) {
    const url = new URL(request.url);
    return `${url.protocol}//${url.host}`;
}

async function setupBotCommands(env) {
    const commands = [
        { command: 'start', description: '启动机器人' },
        { command: 'menu', description: '打开管理面板' },
        { command: 'panel', description: '打开管理面板' },
        { command: 'bind', description: '绑定当前群组' },
        { command: 'admins', description: '查看协管列表' },
        { command: 'export', description: '导出业务配置' }
    ];
    return tgRequest(env.BOT_TOKEN, 'setMyCommands', { commands });
}

async function setWebhookToCurrentWorker(env, request) {
    const webhookUrl = `${getBaseUrl(request)}/webhook`;
    await setupBotCommands(env);
    const result = await tgRequest(env.BOT_TOKEN, 'setWebhook', {
        url: webhookUrl,
        allowed_updates: ['message', 'callback_query', 'my_chat_member']
    });
    if (result.ok) await setConfig(env, 'webhook_url', webhookUrl);
    return { webhook_url: webhookUrl, telegram: result };
}

async function getWebAdminState(env, request) {
    const admins = await listAdmins(env);
    const verifyQuestionMode = await getConfig(env, 'verify_question_mode', await getConfig(env, 'verify_mode', 'off'));
    const settings = {
        worker_url: getBaseUrl(request),
        webhook_url: `${getBaseUrl(request)}/webhook`,
        group_id: await getConfig(env, 'group_id', ''),
        business_status: await getConfig(env, 'business_status', 'open'),
        ai_translate: await getConfig(env, 'ai_translate', '0'),
        union_ban: await getConfig(env, 'union_ban', '0'),
        antispam: await getConfig(env, 'antispam', '1'),
        antispam_link: await getConfig(env, 'antispam_link', '1'),
        antispam_media: await getConfig(env, 'antispam_media', '1'),
        antispam_keyword: await getConfig(env, 'antispam_keyword', '1'),
        antispam_autoban: await getConfig(env, 'antispam_autoban', '0'),
        blocked_keywords: await getConfig(env, 'blocked_keywords', ''),
        verify_captcha_mode: await getConfig(env, 'verify_captcha_mode', 'off'),
        verify_question_mode: verifyQuestionMode,
        verify_combo_mode: await getConfig(env, 'verify_combo_mode', 'question_only'),
        verify_fail_limit: await getConfig(env, 'verify_fail_limit', '2'),
        verify_inactive_hours: await getConfig(env, 'verify_inactive_hours', ''),
        verify_inactive_days: await getConfig(env, 'verify_inactive_days', '0'),
        verify_image_api_url: await getConfig(env, 'verify_image_api_url', ''),
        appeal_url: await getLocalAppealUrl(env),
        local_appeal_url: await getLocalAppealUrl(env),
        union_appeal_url: await getUnionAppealUrl(env),
        welcome_msg: await getConfig(env, 'welcome_msg', ''),
        brand_msg: await getConfig(env, 'brand_msg', DEFAULT_BRAND_MSG),
        welcome_buttons_text: await getConfig(env, 'welcome_buttons_text', ''),
        auto_reply_msg: await getConfig(env, 'auto_reply_msg', ''),
        business_rest_message: await getConfig(env, 'business_rest_message', '⏸ 当前为休息中，管理员稍后会回复您。'),
        business_rest_cooldown: await getConfig(env, 'business_rest_cooldown', '600')
    };
    const problems = getRuntimeProblems(env);
    return { ok: true, status: problems.length ? 'not_ready' : 'running', version: '2.1.4', settings, admins, runtime: { problems, kv: describeKVBinding(env), d1: !!getD1(env), bot_token: !!env.BOT_TOKEN, owner_id: !!env.OWNER_ID } };
}

async function handleWebAdminApi(request, env) {
    if (!requireWebAdmin(request, env)) return errorResponse('Unauthorized', 401);
    const url = new URL(request.url);
    if (url.pathname === '/api/status') return jsonResponse(await getWebAdminState(env, request));
    if (url.pathname === '/api/diagnostics') return jsonResponse(await getDiagnostics(env, request));
    if (url.pathname === '/api/webhook/set' && request.method === 'POST') return jsonResponse(await setWebhookToCurrentWorker(env, request));
    if (url.pathname === '/api/commands/set' && request.method === 'POST') return jsonResponse(await setupBotCommands(env));
    if (url.pathname === '/api/blacklist' && request.method === 'GET') {
        return jsonResponse({ ok: true, items: await listBlacklist(env, url.searchParams.get('user_id') || '') });
    }
    if (url.pathname === '/api/blacklist/ban' && request.method === 'POST') {
        const body = await request.json();
        const userId = String(body.user_id || '').trim();
        const reason = String(body.reason || '后台手动封禁').trim();
        if (!userId) return errorResponse('Missing user_id', 400);
        await banUserWithNotice(env, userId, reason);
        await writeAuditLog(env, 'web_admin', 'user.ban', userId, { source: 'web_blacklist', reason });
        return jsonResponse({ ok: true, items: await listBlacklist(env, userId) });
    }
    if (url.pathname === '/api/blacklist/unban' && request.method === 'POST') {
        const body = await request.json();
        const userId = String(body.user_id || '').trim();
        if (!userId) return errorResponse('Missing user_id', 400);
        await unbanUser(env, userId);
        await writeAuditLog(env, 'web_admin', 'user.unban', userId, { source: 'web_blacklist' });
        return jsonResponse({ ok: true, items: await listBlacklist(env, userId) });
    }
    if (url.pathname === '/api/admins' && request.method === 'POST') {
        const body = await request.json();
        const userId = String(body.user_id || '').trim();
        if (!userId) return errorResponse('Missing user_id', 400);
        const rawPerms = Array.isArray(body.permissions) ? body.permissions : String(body.permissions || 'reply,panel').split(/[\s,，]+/);
        const permissions = rawPerms.map(p => String(p).trim()).filter(Boolean);
        await addAdmin(env, userId, permissions);
        await writeAuditLog(env, 'web_admin', 'admin.upsert', userId, { permissions });
        return jsonResponse({ ok: true, state: await getWebAdminState(env, request) });
    }
    if (url.pathname === '/api/admins/delete' && request.method === 'POST') {
        const body = await request.json();
        const userId = String(body.user_id || '').trim();
        if (!userId) return errorResponse('Missing user_id', 400);
        await removeAdmin(env, userId);
        await writeAuditLog(env, 'web_admin', 'admin.delete', userId);
        return jsonResponse({ ok: true, state: await getWebAdminState(env, request) });
    }
    if (url.pathname === '/api/config' && request.method === 'POST') {
        const body = await request.json();
        const allowed = new Set(['business_status', 'business_rest_message', 'business_rest_cooldown', 'ai_translate', 'union_ban', 'antispam', 'antispam_link', 'antispam_media', 'antispam_keyword', 'antispam_autoban', 'blocked_keywords', 'verify_captcha_mode', 'verify_question_mode', 'verify_combo_mode', 'verify_fail_limit', 'verify_inactive_hours', 'verify_inactive_days', 'verify_image_api_url', 'appeal_url', 'local_appeal_url', 'union_appeal_url', 'welcome_msg', 'brand_msg', 'welcome_buttons_text', 'auto_reply_msg']);
        const keys = [];
        for (const [key, value] of Object.entries(body || {})) {
            if (allowed.has(key)) {
                await setConfig(env, key, value);
                if (key === 'welcome_buttons_text') {
                    const buttons = parseButtons(value);
                    if (buttons) await setConfig(env, 'welcome_buttons', JSON.stringify(buttons));
                    else await deleteConfig(env, 'welcome_buttons');
                }
                keys.push(key);
            }
        }
        if (body.local_appeal_url !== undefined && body.appeal_url === undefined) await setConfig(env, 'appeal_url', body.local_appeal_url);
        await writeAuditLog(env, 'web_admin', 'config.update', '', { keys });
        return jsonResponse({ ok: true, keys });
    }
    return errorResponse('Not found', 404);
}

async function getDiagnostics(env, request) {
    const problems = getRuntimeProblems(env);
    const verifySettings = await getVerifySettings(env);
    const unionBanEnabled = await getUnionBanEnabled(env);
    const checks = {
        worker_url: getBaseUrl(request),
        webhook_url: `${getBaseUrl(request)}/webhook`,
        ready: problems.length === 0,
        problems,
        has_bot_token: !!env.BOT_TOKEN,
        has_owner_id: !!env.OWNER_ID,
        has_admin_key: !!(env.ADMIN_KEY || env.ADMIN_PASSWORD),
        has_kv: isKVNamespace(env.KV),
        kv_binding_invalid: !!env.__KV_BINDING_INVALID,
        kv_detail: describeKVBinding(env),
        has_d1: !!getD1(env),
        has_ai: !!env.AI,
        verify_effective: {
            union_ban: unionBanEnabled,
            captcha_mode: verifySettings.captchaMode,
            question_mode: verifySettings.questionMode,
            combo_mode: verifySettings.comboMode,
            should_run_captcha: shouldRunCaptcha(verifySettings, unionBanEnabled),
            should_run_question: shouldRunQuestion(verifySettings),
            trigger_reason: getVerifyTriggerReason(verifySettings, unionBanEnabled)
        },
        d1_schema_ok: false,
        kv_ok: false,
        bot_ok: false,
        bot_username: '',
        webhook: null
    };
    try { checks.d1_schema_ok = await ensureD1Schema(env); } catch (e) { checks.d1_error = e.message; }
    try { if (isKVNamespace(env.KV)) { await env.KV.put('__noomichat_diag', String(Date.now()), { expirationTtl: 60 }); checks.kv_ok = true; } } catch (e) { checks.kv_error = e.message; }
    try {
        if (env.BOT_TOKEN) {
            const me = await tgRequest(env.BOT_TOKEN, 'getMe', {});
            checks.bot_ok = !!me.ok;
            checks.bot_username = me.ok && me.result ? me.result.username : '';
            checks.bot_error = me.ok ? '' : me.description;
            checks.webhook = await tgRequest(env.BOT_TOKEN, 'getWebhookInfo', {});
        }
    } catch (e) { checks.bot_error = e.message; }
    return { ok: true, checks };
}

function renderWebAdminPage() {
    return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NooMiChat Admin</title>
<style>
:root{
  color-scheme:light;
  --bg:#f5f7fb;
  --mica:rgba(255,255,255,.72);
  --card:#ffffff;
  --card-soft:rgba(255,255,255,.84);
  --line:#e1e1e1;
  --line-strong:#c8c6c4;
  --text:#1f2937;
  --muted:#667085;
  --blue:#0078d4;
  --blue-dark:#005a9e;
  --green:#107c10;
  --red:#c50f1f;
  --amber:#ffaa44;
  --shadow-sm:0 1.6px 3.6px rgba(0,0,0,.13),0 .3px .9px rgba(0,0,0,.10);
  --shadow-md:0 3.2px 7.2px rgba(0,0,0,.13),0 .6px 1.8px rgba(0,0,0,.10);
  --shadow-lg:0 6.4px 14.4px rgba(0,0,0,.13),0 1.2px 3.6px rgba(0,0,0,.10);
  --radius:12px;
  font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{
  margin:0;
  min-height:100vh;
  color:var(--text);
  background:
    radial-gradient(circle at 10% -10%,rgba(0,120,212,.18),transparent 34rem),
    radial-gradient(circle at 92% 4%,rgba(16,124,16,.12),transparent 28rem),
    linear-gradient(180deg,#fbfdff 0,#f3f6fb 42%,#eef3f9 100%);
  background-attachment:fixed
}
body:before{
  content:"";
  position:fixed;
  inset:0;
  pointer-events:none;
  background-image:linear-gradient(rgba(255,255,255,.45) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.45) 1px,transparent 1px);
  background-size:42px 42px;
  mask-image:linear-gradient(to bottom,rgba(0,0,0,.38),transparent 62%)
}
.shell{position:relative;max-width:1240px;margin:0 auto;padding:24px 18px 56px}
.nav{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:16px;
  margin-bottom:18px;
  padding:14px;
  border:1px solid rgba(255,255,255,.82);
  border-bottom-color:var(--line);
  border-radius:18px;
  background:var(--mica);
  box-shadow:var(--shadow-sm);
  backdrop-filter:blur(18px) saturate(1.35);
  -webkit-backdrop-filter:blur(18px) saturate(1.35)
}
.brand{display:flex;align-items:center;gap:13px;min-width:0}
.logo{
  width:46px;
  height:46px;
  border-radius:12px;
  display:grid;
  place-items:center;
  background:linear-gradient(135deg,#eff6ff,#dbeafe);
  border:1px solid rgba(0,120,212,.18);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.9),var(--shadow-sm);
  font-size:22px
}
h1{font-size:25px;line-height:1.1;margin:0;letter-spacing:-.03em;font-weight:700}
.sub{margin-top:5px;color:var(--muted);font-size:13px}
.badge{
  border:1px solid var(--line);
  background:rgba(255,255,255,.72);
  border-radius:999px;
  padding:8px 12px;
  color:#475467;
  font-size:12px;
  white-space:nowrap;
  box-shadow:var(--shadow-sm)
}
.glass{
  background:var(--card-soft);
  border:1px solid rgba(255,255,255,.86);
  border-bottom-color:var(--line);
  box-shadow:var(--shadow-sm);
  backdrop-filter:blur(16px) saturate(1.25);
  -webkit-backdrop-filter:blur(16px) saturate(1.25)
}
.login{max-width:460px;margin:54px auto 0;border-radius:18px;padding:28px}
.login:before{
  content:"NooMiChat";
  display:inline-flex;
  margin-bottom:18px;
  padding:5px 10px;
  border-radius:999px;
  color:var(--blue-dark);
  background:#eff6ff;
  border:1px solid #dbeafe;
  font-size:12px;
  font-weight:700
}
.login h2,.card h2{margin:0 0 8px;font-size:18px;letter-spacing:-.02em;font-weight:700}
.muted{color:var(--muted)}
label{display:block;margin:14px 0 7px;font-size:13px;color:#344054;font-weight:650}
input,select,textarea{
  width:100%;
  border:1px solid #8a8886;
  background:rgba(255,255,255,.94);
  color:var(--text);
  border-radius:8px;
  padding:11px 12px;
  font:inherit;
  outline:0;
  box-shadow:inset 0 1px 2px rgba(0,0,0,.04);
  transition:border-color .15s ease,box-shadow .15s ease,background .15s ease
}
textarea{min-height:92px;resize:vertical;line-height:1.55}
input::placeholder,textarea::placeholder{color:#98a2b3}
input:focus,select:focus,textarea:focus{
  border-color:var(--blue);
  background:#fff;
  box-shadow:0 0 0 3px rgba(0,120,212,.15),inset 0 1px 2px rgba(0,0,0,.04)
}
button{
  border:1px solid rgba(0,0,0,.04);
  border-radius:8px;
  padding:10px 14px;
  background:var(--blue);
  color:#fff;
  font-weight:700;
  cursor:pointer;
  box-shadow:var(--shadow-sm);
  transition:transform .15s ease,box-shadow .15s ease,background .15s ease,opacity .15s ease
}
button:hover{background:var(--blue-dark);box-shadow:var(--shadow-md)}
button:active{transform:scale(.99)}
button:focus-visible{outline:3px solid rgba(0,120,212,.22);outline-offset:2px}
button:disabled{opacity:.58;cursor:not-allowed;transform:none}
.secondary{background:#fff;color:#344054;border-color:var(--line-strong)}
.secondary:hover{background:#f8fafc;color:#1d2939}
.green{background:var(--green)}
.green:hover{background:#0e6f0e}
.red{background:var(--red)}
.red:hover{background:#a80000}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(340px,.95fr);gap:16px;align-items:start}
.settings-layout{display:flex;gap:22px;align-items:flex-start;margin-top:16px}
.side-tabs{width:230px;flex:0 0 230px;position:sticky;top:18px}
.side-tabs-inner{display:flex;flex-direction:column;gap:6px;padding:6px}
.tab-btn{
  display:flex;
  width:100%;
  align-items:center;
  justify-content:flex-start;
  gap:10px;
  border:0;
  background:transparent;
  color:#667085;
  box-shadow:none;
  padding:11px 12px;
  border-radius:10px;
  font-size:14px;
  font-weight:650;
  text-align:left
}
.tab-btn:hover{background:rgba(255,255,255,.72);color:#344054;box-shadow:none}
.tab-btn.active{background:#fff;color:#111827;box-shadow:var(--shadow-sm)}
.tab-btn .ico{width:22px;height:22px;display:grid;place-items:center;border-radius:7px;background:#f2f4f7;font-size:13px}
.tab-btn.active .ico{background:#eff6ff;color:var(--blue-dark)}
.tab-content{flex:1;min-width:0}
.tab-panel{display:none}
.tab-panel.active{display:block}
.panel-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.92fr);gap:16px;align-items:start}
.panel-head{margin-bottom:14px}
.panel-head h2{font-size:22px;margin:0 0 4px;letter-spacing:-.03em}
.panel-head p{margin:0;color:var(--muted);font-size:14px;line-height:1.6}
.hero{
  display:flex;
  justify-content:space-between;
  align-items:flex-end;
  gap:18px;
  margin-bottom:16px;
  padding:22px;
  border-radius:18px;
  overflow:hidden
}
.hero h2{margin:6px 0 0;font-size:26px;letter-spacing:-.04em}
.hero p{margin:8px 0 0;color:var(--muted);line-height:1.65;max-width:680px}
.eyebrow{
  display:inline-flex;
  align-items:center;
  gap:6px;
  padding:5px 10px;
  border:1px solid #bfdbfe;
  border-radius:999px;
  color:var(--blue-dark);
  background:#eff6ff;
  font-size:12px;
  font-weight:800
}
.hero-metrics{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.hero-metrics span{
  display:inline-flex;
  align-items:center;
  border:1px solid var(--line);
  border-radius:999px;
  padding:7px 10px;
  background:#fff;
  color:#475467;
  font-size:12px;
  font-weight:700;
  box-shadow:var(--shadow-sm)
}
.card{position:relative;border-radius:14px;padding:18px}
.card:after{
  content:"";
  position:absolute;
  left:18px;
  top:0;
  width:52px;
  height:3px;
  border-radius:999px;
  background:linear-gradient(90deg,var(--blue),rgba(0,120,212,0))
}
.full{grid-column:1/-1}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}
.stat{border-radius:14px;padding:15px 16px;position:relative;overflow:hidden}
.stat:before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:linear-gradient(90deg,var(--blue),transparent)}
.stat b{display:block;font-size:22px;letter-spacing:-.03em;margin-top:4px}
.stat span{color:var(--muted);font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.04em}
.pill{
  display:inline-flex;
  align-items:center;
  gap:6px;
  border-radius:999px;
  padding:5px 10px;
  border:1px solid var(--line);
  background:#fff;
  font-size:12px;
  font-weight:700;
  box-shadow:var(--shadow-sm)
}
.ok{color:var(--green)}
.bad{color:var(--red)}
.warn{color:#b45309}
pre{
  margin:12px 0 0;
  white-space:pre-wrap;
  word-break:break-word;
  background:#f8fafc;
  border:1px solid var(--line);
  border-radius:10px;
  padding:12px;
  max-height:300px;
  overflow:auto;
  font-size:12px;
  line-height:1.55;
  color:#344054
}
.hidden{display:none!important}
.has-admin-cache #loginCard{display:none!important}
.has-admin-cache #bootCard{display:block!important}
.hint{margin-top:12px;font-size:13px;line-height:1.65;color:var(--muted)}
.hint.bad{color:var(--red)}
.toast{
  position:fixed;
  right:22px;
  bottom:22px;
  display:none;
  max-width:420px;
  border-radius:12px;
  padding:14px 16px;
  background:#f0fdf4;
  border:1px solid #bbf7d0;
  box-shadow:var(--shadow-lg);
  color:#166534;
  font-weight:800;
  z-index:9999
}
.toast.bad{background:#fef2f2;border-color:#fecaca;color:#991b1b}
.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.admin-list{display:grid;gap:8px}
.admin-item{
  display:flex;
  justify-content:space-between;
  align-items:center;
  gap:10px;
  border:1px solid var(--line);
  background:#fff;
  padding:11px;
  border-radius:10px;
  box-shadow:0 .8px 1.8px rgba(0,0,0,.06)
}
.admin-item code{color:var(--blue-dark);font-weight:700}
.footer-note{
  margin-top:18px;
  color:#667085;
  font-size:12px;
  text-align:center
}
@media(max-width:900px){
  .shell{padding:14px 12px 40px}
  .grid,.split,.stats{grid-template-columns:1fr}
  .settings-layout{display:block}
  .side-tabs{position:static;width:auto;flex:auto;margin-bottom:14px;overflow:auto}
  .side-tabs-inner{flex-direction:row;min-width:max-content}
  .tab-btn{white-space:nowrap}
  .panel-grid{grid-template-columns:1fr}
  .hero{display:block}
  .hero-metrics{justify-content:flex-start;margin-top:14px}
  .nav{align-items:flex-start}
  .badge{display:none}
  .login{margin-top:24px}
}
@media(prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  button,input,select,textarea{transition:none}
}
</style>
<script>
(function(){
  try {
    var ttl = 30 * 24 * 60 * 60 * 1000;
    var key = localStorage.getItem('noomichat_admin_key') || localStorage.getItem('relaygo_admin_key') || '';
    var ts = Number(localStorage.getItem('noomichat_admin_key_saved_at') || 0);
    if (key && (!ts || Date.now() - ts < ttl)) {
      document.documentElement.className += ' has-admin-cache';
    } else {
      localStorage.removeItem('noomichat_admin_key');
      localStorage.removeItem('relaygo_admin_key');
      localStorage.removeItem('noomichat_admin_key_saved_at');
    }
  } catch (e) {}
})();
</script>
</head>
<body>
<div class="shell">
  <div class="nav">
    <div class="brand"><div class="logo">✈️</div><div><h1>NooMiChat Admin</h1><div class="sub">SaaS 控制台 · 验证网关 · Telegram 双向私聊 bot</div></div></div>
    <div class="badge">v2.1.4</div>
  </div>

  <section id="bootCard" class="login glass hidden">
    <h2>正在进入后台</h2>
    <div class="muted">已检测到本机缓存的后台密钥，正在验证有效性。</div>
    <div id="bootMsg" class="hint">如果密钥过期或已修改，会自动回到登录页。</div>
  </section>

  <section id="loginCard" class="login glass">
    <h2>进入管理后台</h2>
    <div class="muted">输入 Cloudflare 环境变量中的 ADMIN_KEY；登录成功后会在当前浏览器缓存 30 天。</div>
    <label for="adminKey">后台密码</label>
    <input id="adminKey" type="password" autocomplete="current-password" placeholder="ADMIN_KEY / OWNER_ID">
    <div class="row" style="margin-top:14px"><button id="loginBtn" type="button">进入后台</button><button id="checkBtn" class="secondary" type="button">检查部署</button></div>
    <div id="loginMsg" class="hint">登录前不会请求管理数据。</div>
  </section>

  <main id="app" class="hidden">
    <section class="hero glass">
      <div>
        <div class="eyebrow">Fluent Control Center</div>
        <h2>中继、验证、黑名单和协管，都在一个清爽面板里。</h2>
        <p>优先展示运行状态，保存只提交变更项；Webhook、菜单、诊断都保持手动触发，避免后台空转吃性能。</p>
      </div>
      <div class="hero-metrics"><span>低动画</span><span>D1 Ready</span><span>Bot Safe</span></div>
    </section>
    <section class="stats">
      <div class="stat glass"><span>Worker</span><b id="statWorker">--</b></div>
      <div class="stat glass"><span>KV</span><b id="statKv">--</b></div>
      <div class="stat glass"><span>D1</span><b id="statD1">--</b></div>
      <div class="stat glass"><span>Group</span><b id="statGroup">--</b></div>
    </section>
    <section class="settings-layout">
      <nav class="side-tabs glass" aria-label="后台设置分类">
        <div class="side-tabs-inner">
          <button class="tab-btn active" type="button" data-tab="overview"><span class="ico">⌂</span>部署</button>
          <button class="tab-btn" type="button" data-tab="runtime"><span class="ico">◐</span>运营</button>
          <button class="tab-btn" type="button" data-tab="verify"><span class="ico">◆</span>安全</button>
          <button class="tab-btn" type="button" data-tab="messages"><span class="ico">✎</span>内容</button>
          <button class="tab-btn" type="button" data-tab="access"><span class="ico">⚿</span>用户</button>
        </div>
      </nav>
      <div class="tab-content">
        <section class="tab-panel active" data-panel="overview">
          <div class="panel-head"><h2>部署总览</h2><p>检查 Worker、Webhook、菜单和绑定状态。这里的请求只在点击时触发。</p></div>
          <div class="panel-grid">
            <div class="card glass"><h2>部署控制</h2><div id="status" class="muted">等待加载</div><div class="row" style="margin-top:12px"><button id="webhookBtn" class="green" type="button">设置 Webhook + 菜单</button><button id="commandsBtn" class="secondary" type="button">仅设置菜单</button><button id="diagBtn" class="secondary" type="button">运行诊断</button><button id="refreshBtn" class="secondary" type="button">刷新</button></div><pre id="diagBox">点击“运行诊断”查看 Telegram Webhook 状态。</pre></div>
            <div class="card glass"><h2>运行信息</h2><pre id="workerInfo"></pre><a id="openWebhook" target="_blank" rel="noreferrer"><button class="secondary" type="button">打开 Webhook 地址</button></a></div>
          </div>
        </section>
        <section class="tab-panel" data-panel="runtime">
          <div class="panel-head"><h2>运营与中继</h2><p>控制营业状态、休息自动回复和 AI 翻译。安全拦截已移动到“安全”。</p></div>
          <div class="card glass"><h2>营业与中继</h2><div class="split"><div><label>营业状态</label><select id="business_status"><option value="open">营业中</option><option value="rest">休息中</option></select></div><div><label>休息提示冷却秒数</label><input id="business_rest_cooldown" type="number" min="60"></div></div><label>休息提示</label><textarea id="business_rest_message"></textarea><label>AI 翻译</label><select id="ai_translate"><option value="0">关闭</option><option value="1">开启</option></select><button id="saveRuntimeBtn" type="button">保存运营设置</button></div>
        </section>
        <section class="tab-panel" data-panel="verify">
          <div class="panel-head"><h2>安全与验证</h2><p>集中管理新用户验证、联合封禁、防骚扰规则和关键词拦截。</p></div>
          <div class="panel-grid">
            <div class="card glass"><h2>新用户验证</h2><div class="split"><div><label>云端验证码</label><select id="verify_captcha_mode"><option value="off">关闭</option><option value="cloudflare_turnstile">Cloudflare Turnstile</option><option value="google_recaptcha">Google reCAPTCHA</option></select></div><div><label>本地问答</label><select id="verify_question_mode"><option value="off">关闭</option><option value="math">数学题</option><option value="button_math">算术按钮</option><option value="sticker">发送贴纸/表情</option><option value="emoji_choice">表情选择</option><option value="word_button">文字按钮</option><option value="image_digit">图片数字</option><option value="custom_question">自定义问答</option></select></div></div><div class="split"><div><label>组合模式</label><select id="verify_combo_mode"><option value="captcha_only">只验证码</option><option value="question_only">只问答</option><option value="captcha_question">验证码 + 问答</option></select></div><div><label>失败封禁次数</label><input id="verify_fail_limit" type="number" min="1" max="9"></div></div><label>验证过期/超时周期（小时，0关闭）</label><input id="verify_inactive_hours" type="number" min="0" max="8760" placeholder="例如 1、2、6、12、24"><label>图片数字第三方 API（可空，失败自动本地生成）</label><input id="verify_image_api_url" placeholder="https://example.com/verify-image"><label>联合封禁</label><select id="union_ban"><option value="0">关闭</option><option value="1">开启</option></select><button id="saveVerifyBtn" type="button">保存安全设置</button><div class="hint">表情选择和文字按钮都是纯聊天内验证，不跳转网页。</div></div>
            <div class="card glass"><h2>防骚扰与关键词</h2><div class="split"><div><label>防骚扰总开关</label><select id="antispam"><option value="1">开启</option><option value="0">关闭</option></select></div><div><label>命中后自动封禁</label><select id="antispam_autoban"><option value="0">关闭</option><option value="1">开启</option></select></div></div><div class="split"><div><label>链接拦截</label><select id="antispam_link"><option value="1">开启</option><option value="0">关闭</option></select></div><div><label>媒体限制</label><select id="antispam_media"><option value="1">开启</option><option value="0">关闭</option></select></div></div><label>关键词拦截</label><select id="antispam_keyword"><option value="1">开启</option><option value="0">关闭</option></select><label>拦截关键词（每行或逗号分隔）</label><textarea id="blocked_keywords" placeholder="广告&#10;推广&#10;spam"></textarea><button id="saveSecurityBtn" type="button">保存防骚扰设置</button></div>
          </div>
        </section>
        <section class="tab-panel" data-panel="messages">
          <div class="panel-head"><h2>内容与文案</h2><p>修改验证通过欢迎语、自动回复、品牌说明和欢迎按钮。</p></div>
          <div class="card glass"><h2>内容与文案</h2><div class="split"><div><label>欢迎语（支持 HTML 链接）</label><textarea id="welcome_msg" placeholder='例如：欢迎，点击 <a href="https://t.me/xxx">联系客服</a>'></textarea></div><div><label>自动回复</label><textarea id="auto_reply_msg"></textarea></div></div><div class="split"><div><label>底部品牌文案（支持 HTML 链接，留空关闭）</label><textarea id="brand_msg"></textarea></div><div><label>欢迎按钮</label><textarea id="welcome_buttons_text" placeholder="按钮文字 - https://t.me/xxx, 官网 - https://example.com"></textarea></div></div><button id="saveMsgBtn" type="button">保存内容设置</button><div class="hint">Telegram 文字链接写法：<code>&lt;a href=&quot;https://t.me/xxx&quot;&gt;点击这里&lt;/a&gt;</code>。按钮格式：按钮名 - 链接，多个用英文逗号分隔。</div></div>
        </section>
        <section class="tab-panel" data-panel="access">
          <div class="panel-head"><h2>用户与权限</h2><p>管理本地黑名单、申诉入口和协管员权限。</p></div>
          <div class="panel-grid">
            <div class="card glass"><h2>本地黑名单</h2><div class="split"><div><label>搜索 / 操作 Telegram ID</label><input id="blackUserId" placeholder="输入用户数字 ID"></div><div><label>封禁原因</label><input id="blackReason" placeholder="后台手动封禁"></div></div><div class="row"><button id="searchBlackBtn" class="secondary" type="button">搜索</button><button id="banBlackBtn" class="red" type="button">加入黑名单</button><button id="unbanBlackBtn" class="green" type="button">解除封禁</button><button id="refreshBlackBtn" class="secondary" type="button">刷新列表</button></div><div id="blacklist" class="admin-list" style="margin-top:12px"></div></div>
            <div class="card glass"><h2>申诉入口</h2><label>本地申诉链接（可空，Bot 内申诉仍可用）</label><input id="local_appeal_url"><label>联合封禁申诉链接</label><input id="union_appeal_url"><button id="saveAccessBtn" type="button">保存申诉设置</button><div class="hint">本地黑名单和联合封禁分开管理，避免误把联合申诉当成本地申诉。</div></div>
            <div class="card glass"><h2>协管管理</h2><div class="split"><div><label>Telegram ID</label><input id="adminUserId" placeholder="例如 123456789"></div><div><label>权限</label><input id="adminPerms" placeholder="reply,panel,ban,config"></div></div><div class="row"><button id="addAdminBtn" type="button">添加/更新协管</button><span class="hint">OWNER_ID 默认全权限，不可删除。</span></div><div id="admins" class="admin-list" style="margin-top:12px"></div></div>
          </div>
        </section>
      </div>
    </section>
    <div class="footer-note">Fluent / Mica 轻量界面：低动画、低阴影、轻量 JS；诊断和 Telegram API 只在点击时请求。</div>
  </main>
</div>
<div id="toast" class="toast"></div>
<script>
(function(){
  var $ = function(id){ return document.getElementById(id); };
  var NL = String.fromCharCode(10);
  var ADMIN_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;
  var configKeys = ['business_status','business_rest_message','business_rest_cooldown','ai_translate','union_ban','antispam','antispam_link','antispam_media','antispam_keyword','antispam_autoban','blocked_keywords','verify_captcha_mode','verify_question_mode','verify_combo_mode','verify_fail_limit','verify_inactive_hours','verify_image_api_url','local_appeal_url','union_appeal_url','welcome_msg','brand_msg','welcome_buttons_text','auto_reply_msg'];
  var lastConfig = {};
  function clearAdminCache(){ localStorage.removeItem('noomichat_admin_key'); localStorage.removeItem('relaygo_admin_key'); localStorage.removeItem('noomichat_admin_key_saved_at'); document.documentElement.classList.remove('has-admin-cache'); }
  function getCachedAdminKey(){ var key=localStorage.getItem('noomichat_admin_key') || localStorage.getItem('relaygo_admin_key') || ''; var ts=Number(localStorage.getItem('noomichat_admin_key_saved_at') || 0); if(!key) return ''; if(ts && Date.now()-ts>ADMIN_CACHE_TTL){ clearAdminCache(); return ''; } if(!ts) localStorage.setItem('noomichat_admin_key_saved_at',String(Date.now())); return key; }
  function saveAdminCache(key){ localStorage.setItem('noomichat_admin_key',key); localStorage.setItem('noomichat_admin_key_saved_at',String(Date.now())); localStorage.removeItem('relaygo_admin_key'); }
  $('adminKey').value = getCachedAdminKey();
  function toast(msg,isBad){ var el=$('toast'); el.textContent=(isBad?'⚠️ ':'✅ ')+msg; el.className='toast '+(isBad?'bad':''); el.style.display='block'; clearTimeout(window.__toastTimer); window.__toastTimer=setTimeout(function(){el.style.display='none';},3600); }
  function h(v){ return String(v==null?'':v).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  function setBusy(btn,busy){ if(!btn)return; btn.disabled=!!busy; if(busy){btn.dataset.old=btn.textContent; btn.textContent='处理中...';} else if(btn.dataset.old){btn.textContent=btn.dataset.old; delete btn.dataset.old;} }
  async function parseResponse(res){ var text=await res.text(); try{return text?JSON.parse(text):{};}catch(e){return {error:text||('HTTP '+res.status),raw:text};} }
  async function api(path,opt){ opt=opt||{}; var key=$('adminKey').value.trim(); var headers=Object.assign({'content-type':'application/json','x-admin-key':key},opt.headers||{}); var res=await fetch(path,Object.assign({},opt,{headers:headers})); var data=await parseResponse(res); if(!res.ok) throw new Error(data.error||data.raw||res.statusText); return data; }
  function showLogin(msg,isBad){ document.documentElement.classList.remove('has-admin-cache'); $('bootCard').classList.add('hidden'); $('loginCard').classList.remove('hidden'); $('app').classList.add('hidden'); if(msg){ $('loginMsg').innerHTML=msg; $('loginMsg').className='hint '+(isBad?'bad':''); } }
  function showApp(){ document.documentElement.classList.remove('has-admin-cache'); $('bootCard').classList.add('hidden'); $('loginCard').classList.add('hidden'); $('app').classList.remove('hidden'); }
  function activateTab(name){ if(!document.querySelector('.tab-btn[data-tab="'+name+'"]')) name='overview'; document.querySelectorAll('.tab-btn').forEach(function(btn){ btn.classList.toggle('active',btn.dataset.tab===name); }); document.querySelectorAll('.tab-panel').forEach(function(panel){ panel.classList.toggle('active',panel.dataset.panel===name); }); localStorage.setItem('noomichat_admin_tab',name); }
  function fillAdmins(admins){ var box=$('admins'); box.innerHTML=''; if(!admins||!admins.length){ box.innerHTML='<div class="muted">暂无协管</div>'; return; } admins.forEach(function(a){ var item=document.createElement('div'); item.className='admin-item'; var left=document.createElement('div'); left.innerHTML='<code>'+a.user_id+'</code><div class="muted">'+(a.is_owner?'OWNER':'ADMIN')+' · '+(a.permissions||[]).join(',')+'</div>'; var right=document.createElement('button'); right.type='button'; right.className='red'; right.textContent='删除'; right.disabled=!!a.is_owner; right.addEventListener('click',function(){ delAdmin(a.user_id); }); item.appendChild(left); item.appendChild(right); box.appendChild(item); }); }
  function fillBlacklist(items){ var box=$('blacklist'); box.innerHTML=''; if(!items||!items.length){ box.innerHTML='<div class="muted">暂无本地黑名单记录</div>'; return; } items.forEach(function(x){ var u=x.user||{}; var name=((u.first_name||'')+' '+(u.last_name||'')).trim()||'Unknown'; var item=document.createElement('div'); item.className='admin-item'; var left=document.createElement('div'); left.innerHTML='<code>'+h(x.user_id)+'</code><div class="muted">'+h(name)+(u.username?' @'+h(u.username):'')+' · '+(x.lifted_at?'已解封':'封禁中')+'</div><div class="hint">原因：'+h(x.reason||'-')+'</div>'; var right=document.createElement('button'); right.type='button'; right.className=x.lifted_at?'secondary':'green'; right.textContent=x.lifted_at?'已解封':'解封'; right.disabled=!!x.lifted_at; right.addEventListener('click',function(){ unbanBlack(x.user_id); }); item.appendChild(left); item.appendChild(right); box.appendChild(item); }); }
  function fill(s){ showApp(); var cfg=s.settings||{}; lastConfig=Object.assign({},cfg); var runtime=s.runtime||{}; var kv=runtime.kv||{}; var ready=s.status==='running'; $('status').innerHTML='<span class="pill '+(ready?'ok':'warn')+'">'+(ready?'运行中':'配置未就绪')+'</span> '+(s.version||''); $('statWorker').textContent=ready?'OK':'WARN'; $('statKv').textContent=kv.valid?'OK':'NO'; $('statD1').textContent=runtime.d1?'OK':'NO'; $('statGroup').textContent=cfg.group_id?'已绑定':'未绑定'; $('workerInfo').textContent='Worker: '+(cfg.worker_url||'')+NL+'Webhook: '+(cfg.webhook_url||'')+NL+'Group ID: '+(cfg.group_id||'未绑定')+NL+'Runtime: '+JSON.stringify(runtime,null,2); $('openWebhook').href=cfg.webhook_url||'#'; configKeys.forEach(function(k){ if($(k)) $(k).value = cfg[k] == null ? '' : cfg[k]; }); fillAdmins(s.admins||[]); }
  async function loadState(silent){ var btn=$('loginBtn'); try{ setBusy(btn,true); var key=$('adminKey').value.trim(); if(!key){ showLogin('请输入后台密码。',true); return; } fill(await api('/api/status')); saveAdminCache(key); loadBlacklist(); if(!silent) toast('已进入后台'); } catch(e){ clearAdminCache(); showLogin('<b>登录失败：</b>'+e.message+'<br>请检查 ADMIN_KEY / OWNER_ID。',true); toast(e.message,true); } finally { setBusy(btn,false); } }
  async function runPublicCheck(){ try{ var r=await (await fetch('/')).json(); $('loginMsg').innerHTML='<pre>'+JSON.stringify(r,null,2)+'</pre>'; $('loginMsg').className='hint'; }catch(e){ showLogin('检查失败：'+e.message,true); } }
  async function setWebhook(){ var b=$('webhookBtn'); try{ setBusy(b,true); var r=await api('/api/webhook/set',{method:'POST',body:'{}'}); $('diagBox').textContent=JSON.stringify(r,null,2); toast(r.telegram&&r.telegram.ok?'Webhook 已设置':'设置失败'); await loadState(); }catch(e){toast(e.message,true);}finally{setBusy(b,false);} }
  async function setCommands(){ var b=$('commandsBtn'); try{ setBusy(b,true); var r=await api('/api/commands/set',{method:'POST',body:'{}'}); $('diagBox').textContent=JSON.stringify(r,null,2); toast(r.ok?'菜单已设置':'设置失败'); }catch(e){toast(e.message,true);}finally{setBusy(b,false);} }
  async function runDiagnostics(){ var b=$('diagBtn'); try{ setBusy(b,true); var r=await api('/api/diagnostics'); $('diagBox').textContent=JSON.stringify(r.checks||r,null,2); toast('诊断完成'); }catch(e){toast(e.message,true);}finally{setBusy(b,false);} }
  async function saveConfig(){ var btn=document.activeElement&&document.activeElement.tagName==='BUTTON'?document.activeElement:null; var originalText=btn?btn.textContent:''; var saved=false; var body={}; configKeys.forEach(function(k){ if($(k)){ var v=$(k).value; if(String(lastConfig[k] == null ? '' : lastConfig[k])!==String(v)) body[k]=v; } }); if(!Object.keys(body).length){toast('没有变更');return;} try{ setBusy(btn,true); var started=Date.now(); await api('/api/config',{method:'POST',body:JSON.stringify(body)}); Object.assign(lastConfig,body); saved=true; toast('已保存 '+Object.keys(body).length+' 项 · '+(Date.now()-started)+'ms'); }catch(e){toast(e.message,true);}finally{setBusy(btn,false); if(btn&&saved){btn.textContent='已保存'; setTimeout(function(){ if(btn) btn.textContent=originalText; },1200);} } }
  async function addAdmin(){ var userId=$('adminUserId').value.trim(); var perms=$('adminPerms').value.trim()||'reply,panel'; if(!userId){toast('请输入 Telegram ID',true);return;} try{ var r=await api('/api/admins',{method:'POST',body:JSON.stringify({user_id:userId,permissions:perms})}); fill(r.state); $('adminUserId').value=''; toast('协管已保存'); }catch(e){toast(e.message,true);} }
  async function delAdmin(userId){ if(!confirm('删除协管 '+userId+' ?')) return; try{ var r=await api('/api/admins/delete',{method:'POST',body:JSON.stringify({user_id:userId})}); fill(r.state); toast('协管已删除'); }catch(e){toast(e.message,true);} }
  async function loadBlacklist(){ try{ var uid=$('blackUserId').value.trim(); var r=await api('/api/blacklist'+(uid?'?user_id='+encodeURIComponent(uid):'')); fillBlacklist(r.items||[]); }catch(e){toast(e.message,true);} }
  async function banBlack(){ var uid=$('blackUserId').value.trim(); if(!uid){toast('请输入 Telegram ID',true);return;} try{ var r=await api('/api/blacklist/ban',{method:'POST',body:JSON.stringify({user_id:uid,reason:$('blackReason').value.trim()||'后台手动封禁'})}); fillBlacklist(r.items||[]); toast('已加入本地黑名单'); }catch(e){toast(e.message,true);} }
  async function unbanBlack(uid){ uid=uid||$('blackUserId').value.trim(); if(!uid){toast('请输入 Telegram ID',true);return;} try{ var r=await api('/api/blacklist/unban',{method:'POST',body:JSON.stringify({user_id:uid})}); fillBlacklist(r.items||[]); toast('已解除封禁'); }catch(e){toast(e.message,true);} }
  document.querySelectorAll('.tab-btn').forEach(function(btn){ btn.addEventListener('click',function(){ activateTab(btn.dataset.tab); }); });
  activateTab(localStorage.getItem('noomichat_admin_tab') || 'overview');
  $('loginBtn').addEventListener('click',function(){ loadState(false); }); $('checkBtn').addEventListener('click',runPublicCheck); $('adminKey').addEventListener('keydown',function(e){ if(e.key==='Enter') loadState(false); }); $('webhookBtn').addEventListener('click',setWebhook); $('commandsBtn').addEventListener('click',setCommands); $('diagBtn').addEventListener('click',runDiagnostics); $('refreshBtn').addEventListener('click',function(){ loadState(false); }); $('saveRuntimeBtn').addEventListener('click',saveConfig); $('saveVerifyBtn').addEventListener('click',saveConfig); $('saveSecurityBtn').addEventListener('click',saveConfig); $('saveMsgBtn').addEventListener('click',saveConfig); $('saveAccessBtn').addEventListener('click',saveConfig); $('addAdminBtn').addEventListener('click',addAdmin); $('searchBlackBtn').addEventListener('click',loadBlacklist); $('refreshBlackBtn').addEventListener('click',function(){ $('blackUserId').value=''; loadBlacklist(); }); $('banBlackBtn').addEventListener('click',banBlack); $('unbanBlackBtn').addEventListener('click',function(){ unbanBlack(); }); if($('adminKey').value) loadState(true);
})();
</script>
</body>
</html>`;
}

export default {
    async fetch(request, env, ctx) {
        env = normalizeEnv(env);
        if (request.method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

        try {
            // Webhook 路径验证
            const url = new URL(request.url);
            if (url.pathname === '/admin' || url.pathname === '/admin/') {
                return htmlResponse(renderWebAdminPage());
            }
            if (url.pathname.startsWith('/api/')) {
                return handleWebAdminApi(request, env);
            }
            if (request.method === 'POST' && (url.pathname === '/webhook' || url.pathname.startsWith('/webhook'))) {
                assertWebhookReady(env);
                const update = await request.json();
                await handleUpdate(env, update, ctx);
                return jsonResponse({ ok: true });
            }
            const problems = getRuntimeProblems(env);
            const verifySettings = await getVerifySettings(env);
            const unionBanEnabled = await getUnionBanEnabled(env);
            return jsonResponse({
                status: problems.length ? 'not_ready' : 'running',
                version: '2.1.4',
                admin: `${url.origin}/admin`,
                webhook: `${url.origin}/webhook`,
                bindings: { bot_token: !!env.BOT_TOKEN, owner_id: !!env.OWNER_ID, kv: isKVNamespace(env.KV), kv_binding_invalid: !!env.__KV_BINDING_INVALID, d1: !!getD1(env), admin_key: !!(env.ADMIN_KEY || env.ADMIN_PASSWORD) },
                kv_detail: describeKVBinding(env),
                verify_effective: {
                    union_ban: unionBanEnabled,
                    captcha_mode: verifySettings.captchaMode,
                    question_mode: verifySettings.questionMode,
                    combo_mode: verifySettings.comboMode,
                    should_run_captcha: shouldRunCaptcha(verifySettings, unionBanEnabled),
                    should_run_question: shouldRunQuestion(verifySettings),
                    trigger_reason: getVerifyTriggerReason(verifySettings, unionBanEnabled)
                },
                problems
            });
        } catch (e) {
            if (!String(e.message || '').startsWith('Worker is not ready:')) ctx.waitUntil(reportError(env, e, "Main Fetch Loop"));
            return errorResponse(e.message);
        }
    }
};

// 核心逻辑
async function handleUpdate(env, update, ctx) {
    const token = env.BOT_TOKEN;
    runBackground(ctx, () => ensureD1Schema(env));

    // 1. 处理回调查询
    if (update.callback_query) {
        
        if (update.callback_query.data && update.callback_query.data.startsWith('appeal:')) {
            return handleLocalAppealCallback(env, update.callback_query);
        }
if (update.callback_query.data && update.callback_query.data.startsWith('reverify:')) {
            return handleReverifyCallback(env, update.callback_query);
        }
        if (update.callback_query.data && update.callback_query.data.startsWith('verify:')) {
            return handleVerifyCallback(env, update.callback_query);
        }
        if (await hasPermission(env, update.callback_query.from.id, 'panel')) {
            return handleOwnerCallback(env, update.callback_query);
        } else {
            return tgRequest(token, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: "🚫", show_alert: true });
        }
    }

    // 2. 自动绑定群组
    if (update.my_chat_member) {
        const chat = update.my_chat_member.chat;
        const newMember = update.my_chat_member.new_chat_member;

        // 只有当机器人被提升为管理员，且所在群组不是私聊时触发
        if (newMember.status === 'administrator' && chat.type !== 'private') {
            if (!newMember.can_manage_topics) {
                return tgRequest(token, 'sendMessage', {
                    chat_id: chat.id,
                    text: "⚠️ <b>自动绑定失败：权限不足</b>\n\n请修改机器人管理员权限，开启 <b>管理话题 (Manage Topics)</b>，否则无法转发消息。",
                    parse_mode: 'HTML'
                });
            }

            try {
                const chatInfo = await tgRequest(token, 'getChat', { chat_id: chat.id });
                if (!chatInfo.ok || !chatInfo.result.is_forum) {
                    return tgRequest(token, 'sendMessage', {
                        chat_id: chat.id,
                        text: "⚠️ <b>自动绑定失败：未开启话题</b>\n\n本群组未开启话题功能。请在群组设置中开启 <b>话题（Topics）</b> 后重试。",
                        parse_mode: 'HTML'
                    });
                }
                await setConfig(env, 'group_id', String(chat.id));

                // 缓存 Bot Username
                const getMe = await tgRequest(token, 'getMe', {});
                if (getMe.ok) await setConfig(env, 'bot_username', getMe.result.username);

                await tgRequest(token, 'sendMessage', {
                    chat_id: chat.id,
                    text: "✅ <b>机器人已绑定此群组！</b>\n\n权限检查通过，私聊转发功能已就绪。",
                    parse_mode: 'HTML'
                });

            } catch (e) {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: `❌ 绑定检查出错: ${e.message}` });
            }
        }
        return;
    }

    // 手动绑定逻辑 (/bind)
    if (update.message && update.message.chat.type !== 'private' && update.message.text === '/bind') {
        const chat = update.message.chat;
        const userId = String(update.message.from.id);

        if (!(await hasPermission(env, userId, 'config'))) {
            return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "🚫 只有机器人所有者可以使用此命令。" });
        }

        try {
            const chatInfo = await tgRequest(token, 'getChat', { chat_id: chat.id });
            if (!chatInfo.ok || !chatInfo.result.is_forum) {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "❌ <b>绑定失败</b>\n\n本群组未开启话题功能 (Topics)。\n请在群组设置中开启“话题”后重试。", parse_mode: 'HTML' });
            }

            // 检查自身权限
            const getMe = await tgRequest(token, 'getMe', {});
            const botUserId = getMe.result.id;
            const memberInfo = await tgRequest(token, 'getChatMember', { chat_id: chat.id, user_id: botUserId });

            if (!memberInfo.ok || memberInfo.result.status !== 'administrator') {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "❌ <b>绑定失败</b>\n\n请先将机器人提升为管理员。", parse_mode: 'HTML' });
            }

            if (!memberInfo.result.can_manage_topics) {
                return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: "❌ <b>权限不足</b>\n\n机器人管理员权限缺失：<b>管理话题 (Manage Topics)</b>。\n请修改权限后重试。", parse_mode: 'HTML' });
            }

            await setConfig(env, 'group_id', String(chat.id));
            if (getMe.ok) await setConfig(env, 'bot_username', getMe.result.username);

            return tgRequest(token, 'sendMessage', {
                chat_id: chat.id,
                text: `✅ <b>绑定成功！</b>\n\n群组 ID：<code>${chat.id}</code>\n群组名称：${escapeHtml(chat.title)}\n\n现在所有私聊消息将转发至此。`,
                parse_mode: 'HTML'
            });

        } catch (e) {
            return tgRequest(token, 'sendMessage', { chat_id: chat.id, text: `❌ 系统错误: ${e.message}` });
        }
    }

    const groupId = await getConfig(env, 'group_id');

    // 处理已绑定群组的消息
    if (update.message && String(update.message.chat.id) === groupId) {
        return handleGroupMessage(env, update.message);
    }

    // 私聊消息
    if (update.message && update.message.chat.type === 'private') {
        const currentUserId = String(update.message.from.id);
        if (!env.KV) {
            return tgRequest(token, 'sendMessage', {
                chat_id: currentUserId,
                text: '⚠️ Worker 缺少 KV 绑定。请在 Cloudflare Worker Bindings 中添加 KV Namespace，变量名必须是 KV，然后重新部署。'
            });
        }
        if (await hasPermission(env, currentUserId, 'panel')) {
            return handleOwnerMenu(env, update.message, ctx);
        }
        return handleUserPrivateMessage(env, groupId, update.message, ctx);
    }
}

// 转发消息（支持媒体组相册）
const mediaGroupBuffers = new Map();

function getPlainUserName(userInfo = {}) {
    const firstName = String(userInfo.first_name || '').trim();
    const lastName = String(userInfo.last_name || '').trim();
    return `${firstName} ${lastName}`.trim() || 'No Name';
}
function getUserLinkButton(userId, userInfo = {}) {
    const labelName = userInfo.username ? `@${userInfo.username}` : `${getPlainUserName(userInfo)} / ${userId}`;
    const text = `👤 ${labelName}`.slice(0, 64);
    if (userInfo.username) return { text, url: `https://t.me/${userInfo.username}` };
    return { text, callback_data: `identity:${userId}` };
}
function formatUserBrief(userId, userData = {}) {
    const info = userData.user_info || userData || {};
    const name = formatUserName(info);
    const username = info.username ? ` @${escapeHtml(info.username)}` : '';
    return `${name}${username} (${userId})`;
}
function formatUserReplyTarget(userId, userData = {}) {
    const info = userData.user_info || userData || {};
    return `<a href="tg://user?id=${userId}">${formatUserName(info)}</a> / <code>${userId}</code>`;
}
function buildUserIdentityText(userId, userInfo = {}, title = '📩 用户消息') {
    const username = userInfo.username ? `@${escapeHtml(userInfo.username)}` : 'None';
    return `${title}\n\n用户：<a href="tg://user?id=${userId}">${formatUserName(userInfo)}</a>\nUID：<code>${userId}</code>\n用户名：${username}`;
}
async function sendUserIdentityCard(env, targetChatId, threadId, userId, userInfo = {}, title = '📩 用户消息') {
    const payload = {
        chat_id: targetChatId,
        text: buildUserIdentityText(userId, userInfo, title),
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[getUserLinkButton(userId, userInfo)]] }
    };
    if (threadId) payload.message_thread_id = threadId;
    const result = await tgRequest(env.BOT_TOKEN, 'sendMessage', payload);
    if (result.ok && !threadId && String(targetChatId) === String(env.OWNER_ID) && String(userId) !== String(env.OWNER_ID) && env.KV) {
        await env.KV.put(`owner_reply_map:${result.result.message_id}`, String(userId), { expirationTtl: 86400 * 7 });
    }
    return result;
}
function isUserCommandMessage(msg) {
    return !!(msg && typeof msg.text === 'string' && /^\/[A-Za-z0-9_]+(?:@\w+)?(?:\s|$)/.test(msg.text.trim()));
}
async function sendUserForwardFeedback(env, userId, text = '✅ 消息已发送。') {
    const key = `forward_feedback:${userId}`;
    if (memGet(key)) return;
    memSet(key, '1', 60_000);
    await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: userId, text });
}

async function forwardMessage(env, token, targetChatId, fromChatId, msg, threadId = null, options = {}) {
    if (!msg.media_group_id) {
        const payload = { chat_id: targetChatId, from_chat_id: fromChatId, message_id: msg.message_id };
        if (threadId) payload.message_thread_id = threadId;
        if (options.reply_markup) payload.reply_markup = options.reply_markup;
        let result = await tgRequest(token, 'copyMessage', payload);
        if (!result.ok && payload.reply_markup && String(result.description || '').includes('BUTTON_USER_PRIVACY_RESTRICTED')) {
            delete payload.reply_markup;
            result = await tgRequest(token, 'copyMessage', payload);
        }
        if (result.ok && !threadId && String(targetChatId) === String(env.OWNER_ID) && String(fromChatId) !== String(env.OWNER_ID) && env.KV) {
            await env.KV.put(`owner_reply_map:${result.result.message_id}`, String(fromChatId), { expirationTtl: 86400 * 7 });
        }
        return result;
    }

    const groupKey = msg.media_group_id;
    let buffer = mediaGroupBuffers.get(groupKey);
    const isFirst = !buffer;

    if (isFirst) {
        buffer = { messageIds: [], targetChatId, fromChatId, threadId, token, lastUpdate: 0 };
        mediaGroupBuffers.set(groupKey, buffer);
    }

    // 将当前消息加入缓冲并更新时间戳
    if (!buffer.messageIds.includes(msg.message_id)) {
        buffer.messageIds.push(msg.message_id);
    }
    buffer.lastUpdate = Date.now();

    // 仅首条消息负责等待并批量转发（防抖：300ms 无新消息则刷新，最长等待 3s）
    if (isFirst) {
        const maxWait = Date.now() + 3000;
        while (Date.now() < maxWait) {
            await new Promise(r => setTimeout(r, 300));
            if (Date.now() - buffer.lastUpdate >= 300) break;
        }
        mediaGroupBuffers.delete(groupKey);

        buffer.messageIds.sort((a, b) => a - b);
        const payload = { chat_id: buffer.targetChatId, from_chat_id: buffer.fromChatId, message_ids: buffer.messageIds };
        if (buffer.threadId) payload.message_thread_id = buffer.threadId;
        const result = await tgRequest(buffer.token, 'copyMessages', payload);
        if (result.ok && !buffer.threadId && String(buffer.targetChatId) === String(env.OWNER_ID) && String(buffer.fromChatId) !== String(env.OWNER_ID) && env.KV) {
            const ids = Array.isArray(result.result) ? result.result : [];
            await Promise.all(ids.map(id => env.KV.put(`owner_reply_map:${id}`, String(buffer.fromChatId), { expirationTtl: 86400 * 7 })));
        }
        return result;
    }
}

// 设置菜单
// 多语言与防骚扰增强
const I18N = {
    zh: {
        banned: "🚫 您已被本机器人封禁，如有疑问请联系管理员。",
        union_banned: "🚫 <b>您已被联合封禁。</b>\n申请解封请 <a href=\"https://t.me/RelayGo/24\">查看此处</a> 。",
        rate_limited: "⚠️ 发送过快，请稍后再试。",
        blocked_link: "⚠️ 为了防骚扰，新用户暂不能直接发送链接，请等待管理员审核。",
        blocked_keyword: "⚠️ 消息触发防骚扰规则，已提交管理员审核。",
        blocked_media: "⚠️ 为了防骚扰，请不要连续发送大量媒体或文件。",
        not_bound: "⚠️ 机器人未绑定群组"
    },
    en: {
        banned: "🚫 You are banned by this bot. Please contact the administrator if needed.",
        union_banned: "🚫 <b>You are globally banned.</b>\nPlease check <a href=\"https://t.me/RelayGo/24\">this guide</a> to appeal.",
        rate_limited: "⚠️ You are sending messages too fast. Please try again later.",
        blocked_link: "⚠️ To prevent spam, new users cannot send links directly. Please wait for admin review.",
        blocked_keyword: "⚠️ Your message triggered anti-spam rules and was sent for admin review.",
        blocked_media: "⚠️ To prevent spam, please do not send too many media files at once.",
        not_bound: "⚠️ Bot is not bound to a group."
    }
};
function detectLang(msg, mode = 'auto') { if (mode === 'zh' || mode === 'en') return mode; const code = (msg && msg.from && msg.from.language_code || '').toLowerCase(); return code.startsWith('zh') ? 'zh' : 'en'; }
async function getLang(env, msg) { const mode = await getConfig(env, 'language', 'auto'); return detectLang(msg, mode); }
function t(lang, key) { return (I18N[lang] && I18N[lang][key]) || I18N.zh[key] || key; }
function isEnabled(value, defaultValue = false) { if (value === null || value === undefined) return defaultValue; return value === '1' || value === 'true'; }
async function getAntiSpamConfig(env) {
    const keys = ['antispam', 'antispam_link', 'antispam_media', 'antispam_keyword', 'antispam_autoban'];
    const values = await Promise.all(keys.map(key => getConfig(env, key)));
    return { enabled: isEnabled(values[0], true), blockLinks: isEnabled(values[1], true), blockMedia: isEnabled(values[2], true), blockKeywords: isEnabled(values[3], true), autoBan: isEnabled(values[4], false), windowShort: 10, limitShort: 5, windowLong: 60, limitLong: 15, cooldown: 300, newUserMaxMedia: 3 };
}

async function tgFormRequest(token, method, formData) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    try {
        let body = formData;
        if (!(formData instanceof FormData)) {
            const form = new FormData();
            const filename = formData && formData.filename ? String(formData.filename) : 'noomichat.png';
            for (const [key, value] of Object.entries(formData || {})) {
                if (key === 'filename' || value === undefined || value === null) continue;
                if (value instanceof Blob) form.append(key, value, filename);
                else if (typeof value === 'object') form.append(key, JSON.stringify(value));
                else form.append(key, String(value));
            }
            body = form;
        }
        const resp = await fetch(url, { method: 'POST', body });
        const result = await resp.json();
        if (!result.ok) console.error(`[TG API Error] Method: ${method}, Error: ${result.description}`);
        return result;
    } catch (e) {
        console.error(`[Network Error] Method: ${method}, Error:`, e);
        return { ok: false, description: e.message };
    }
}

async function sendJsonDocument(env, chatId, filename, data) {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), filename);
    form.append('caption', '📤 业务配置导出 JSON');
    return tgFormRequest(env.BOT_TOKEN, 'sendDocument', form);
}

async function readTelegramJsonDocument(env, document) {
    if (!document || !document.file_id) return null;
    if (document.file_name && !document.file_name.toLowerCase().endsWith('.json')) return null;
    const file = await tgRequest(env.BOT_TOKEN, 'getFile', { file_id: document.file_id });
    if (!file.ok || !file.result || !file.result.file_path) throw new Error(file.description || '无法获取文件路径');
    const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.result.file_path}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`下载失败：HTTP ${resp.status}`);
    return await resp.text();
}
function getMessageText(msg) { return [msg.text, msg.caption].filter(Boolean).join('\n'); }
function containsLink(text) { return /(https?:\/\/|t\.me\/|telegram\.me\/|@[a-zA-Z0-9_]{5,})/i.test(text || ''); }
function isMediaMessage(msg) { return !!(msg.photo || msg.video || msg.animation || msg.document || msg.audio || msg.voice || msg.video_note || msg.sticker); }
async function matchesBlockedKeyword(env, text) { if (!text) return null; const raw = await getConfig(env, 'blocked_keywords'); if (!raw) return null; const keywords = raw.split(/[\n,，]/).map(x => x.trim()).filter(Boolean); const lower = text.toLowerCase(); return keywords.find(k => lower.includes(k.toLowerCase())) || null; }
async function banUser(env, targetId) { const userTopic = await getUser(env, targetId) || {}; userTopic.is_banned = true; await upsertUser(env, { ...userTopic, user_id: String(targetId) }); memDelete(`user:${targetId}`); }
async function notifySpamReview(env, groupId, msg, userData, reason) {
    const token = env.BOT_TOKEN; const userId = String(msg.from.id); const targetChatId = (userData && userData.thread_id && groupId) ? groupId : env.OWNER_ID; if (!targetChatId) return;
    const name = escapeHtml(`${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'Unknown');
    const username = msg.from.username ? `@${escapeHtml(msg.from.username)}` : 'None';
    const preview = escapeHtml(getMessageText(msg).slice(0, 500) || '[非文本消息]');
    const payload = { chat_id: targetChatId, text: `🛡 <b>防骚扰拦截</b>\n\n原因：${escapeHtml(reason)}\n用户：<a href="tg://user?id=${userId}">${name}</a>\nUID：<code>${userId}</code>\n用户名：${username}\n\n内容预览：\n<pre>${preview}</pre>\n\n<i>为避免存储消息正文，已不缓存原消息；如需继续沟通，请让用户重新发送。</i>`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🚫 封禁', callback_data: `spam_ban:${userId}` }, { text: '⭐ 加白名单', callback_data: `spam_trust:${userId}` }]] } };
    if (userData && userData.thread_id && groupId) payload.message_thread_id = userData.thread_id;
    return tgRequest(token, 'sendMessage', payload);
}
async function checkAntiSpam(env, groupId, msg, userData) {
    const config = await getAntiSpamConfig(env); if (!config.enabled) return { ok: true };
    const userId = String(msg.from.id); if (await env.KV.get(`trusted:${userId}`)) return { ok: true }; if (await env.KV.get(`cooldown:${userId}`)) return { ok: false, messageKey: 'rate_limited' };
    const now = Math.floor(Date.now() / 1000); const rateKey = `rate:${userId}`; const rate = await env.KV.get(rateKey, { type: 'json' }) || { short: [], long: [] };
    rate.short = (rate.short || []).filter(ts => now - ts < config.windowShort); rate.long = (rate.long || []).filter(ts => now - ts < config.windowLong); rate.short.push(now); rate.long.push(now); await env.KV.put(rateKey, JSON.stringify(rate), { expirationTtl: config.windowLong + 30 });
    if (rate.short.length > config.limitShort || rate.long.length > config.limitLong) { await env.KV.put(`cooldown:${userId}`, '1', { expirationTtl: config.cooldown }); await notifySpamReview(env, groupId, msg, userData, '发送频率过高'); return { ok: false, messageKey: 'rate_limited' }; }
    const isNewUser = !(userData && userData.thread_id); const text = getMessageText(msg);
    if (config.blockKeywords) { const keyword = await matchesBlockedKeyword(env, text); if (keyword) { if (config.autoBan) await banUserWithNotice(env, userId, `命中关键词：${keyword}`); await notifySpamReview(env, groupId, msg, userData, `命中关键词：${keyword}`); return { ok: false, messageKey: 'blocked_keyword' }; } }
    if (isNewUser && config.blockLinks && containsLink(text)) { await notifySpamReview(env, groupId, msg, userData, '新用户发送链接'); return { ok: false, messageKey: 'blocked_link' }; }
    if (isNewUser && config.blockMedia && isMediaMessage(msg)) { const mediaKey = `media:${userId}`; const count = parseInt(await env.KV.get(mediaKey) || '0', 10) + 1; await env.KV.put(mediaKey, String(count), { expirationTtl: 300 }); if (count > config.newUserMaxMedia) { await notifySpamReview(env, groupId, msg, userData, '新用户连续发送媒体/文件'); return { ok: false, messageKey: 'blocked_media' }; } }
    return { ok: true };
}
async function setToggle(env, key) { const current = await getConfig(env, key); const next = isEnabled(current, false) ? '0' : '1'; await setConfig(env, key, next); return next; }


function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function shuffleArray(items) { const arr = [...items]; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
function makeChoiceButtons(userId, choices) { return { inline_keyboard: [shuffleArray(choices).map(v => ({ text: String(v), callback_data: `verify:${userId}:${v}` }))] }; }
function isEmojiOnlyText(text) {
    const value = String(text || '').trim();
    return !!value && /^(\p{Extended_Pictographic}|\uFE0F|\u200D|\s)+$/u.test(value);
}
function makeDigitSvg(digit) {
    const noise = Array.from({ length: 8 }, () => `<line x1="${randomInt(0, 160)}" y1="${randomInt(0, 80)}" x2="${randomInt(0, 160)}" y2="${randomInt(0, 80)}" stroke="rgba(80,80,80,.35)" stroke-width="1"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#f5f7fb"/><g transform="translate(80 48) rotate(${randomInt(-15, 15)})"><text text-anchor="middle" font-size="48" font-family="Arial, sans-serif" font-weight="700" fill="#1f2937">${digit}</text></g>${noise}<circle cx="${randomInt(15,145)}" cy="${randomInt(10,70)}" r="3" fill="#60a5fa" opacity=".5"/></svg>`;
}
function svgDataUrl(svg) { return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); }
const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();
function u32be(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { out.set(part, offset); offset += part.length; }
    return out;
}
function crc32(bytes) {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC32_TABLE[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function adler32(bytes) {
    let a = 1, b = 0;
    for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
}
function pngChunk(type, data) {
    const typeBytes = new TextEncoder().encode(type);
    return concatBytes([u32be(data.length), typeBytes, data, u32be(crc32(concatBytes([typeBytes, data])))]);
}
function zlibStore(bytes) {
    const parts = [new Uint8Array([0x78, 0x01])];
    for (let offset = 0; offset < bytes.length; offset += 65535) {
        const block = bytes.slice(offset, Math.min(offset + 65535, bytes.length));
        const final = offset + 65535 >= bytes.length ? 1 : 0;
        const len = block.length;
        parts.push(new Uint8Array([final, len & 255, (len >>> 8) & 255, (~len) & 255, ((~len) >>> 8) & 255]), block);
    }
    parts.push(u32be(adler32(bytes)));
    return concatBytes(parts);
}
function makeDigitPngBlob(digit) {
    const width = 160, height = 80;
    const raw = new Uint8Array((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
        const row = y * (width * 4 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x++) {
            const i = row + 1 + x * 4;
            raw[i] = 245; raw[i + 1] = 247; raw[i + 2] = 251; raw[i + 3] = 255;
        }
    }
    function rect(x, y, w, h, r, g, b) {
        for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
            const row = yy * (width * 4 + 1);
            for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) {
                const i = row + 1 + xx * 4;
                raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = 255;
            }
        }
    }
    for (let i = 0; i < 18; i++) rect(randomInt(4, 154), randomInt(4, 74), randomInt(1, 5), randomInt(1, 4), 147, 197, 253);
    const segments = {
        a: [55, 12, 50, 8], b: [104, 18, 8, 22], c: [104, 43, 8, 22],
        d: [55, 65, 50, 8], e: [48, 43, 8, 22], f: [48, 18, 8, 22], g: [55, 38, 50, 8]
    };
    const map = {
        0: 'abcdef', 1: 'bc', 2: 'abged', 3: 'abgcd', 4: 'fgbc', 5: 'afgcd',
        6: 'afgecd', 7: 'abc', 8: 'abcdefg', 9: 'abfgcd'
    };
    for (const segment of map[Number(digit)] || map[0]) {
        const [x, y, w, h] = segments[segment];
        rect(x, y, w, h, 31, 41, 55);
    }
    const ihdr = new Uint8Array(13);
    ihdr.set(u32be(width), 0); ihdr.set(u32be(height), 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const png = concatBytes([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlibStore(raw)), pngChunk('IEND', new Uint8Array())]);
    return new Blob([png], { type: 'image/png' });
}
function base64ToBlob(base64, type = 'image/png') {
    const clean = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
}
async function getVerifyFailLimit(env) { return Math.max(1, Math.min(9, parseInt(await getConfig(env, 'verify_fail_limit', '2'), 10) || 2)); }
async function getLocalAppealUrl(env) { return await getConfig(env, 'local_appeal_url', ''); }
async function getUnionAppealUrl(env) { return await getConfig(env, 'union_appeal_url', 'https://t.me/RelayGo/24'); }
async function getAppealUrl(env) { return getLocalAppealUrl(env); }
async function getVerifySettings(env) {
    const [legacyMode, captchaMode] = await Promise.all([
        getConfig(env, 'verify_mode', 'off'),
        getConfig(env, 'verify_captcha_mode', 'off')
    ]);
    const questionMode = await getConfig(env, 'verify_question_mode', legacyMode === 'off' ? 'off' : legacyMode);
    let comboMode = await getConfig(env, 'verify_combo_mode', captchaMode !== 'off' && questionMode !== 'off' ? 'captcha_question' : (captchaMode !== 'off' ? 'captcha_only' : 'question_only'));
    if (captchaMode === 'off' && questionMode !== 'off' && comboMode === 'captcha_only') comboMode = 'question_only';
    if (captchaMode !== 'off' && questionMode === 'off' && comboMode === 'question_only') comboMode = 'captcha_only';
    if (captchaMode === 'off' && questionMode === 'off') comboMode = 'off';
    return { captchaMode, questionMode, comboMode, legacyMode };
}
function shouldRunCaptcha(settings, unionBanEnabled = false) { return !!unionBanEnabled || ['cloudflare_turnstile', 'google_recaptcha'].includes(settings.captchaMode); }
function shouldRunQuestion(settings) { return settings.questionMode && settings.questionMode !== 'off' && settings.comboMode !== 'captcha_only'; }
function hasVerificationEnabled(settings, unionBanEnabled) { return shouldRunCaptcha(settings, unionBanEnabled) || shouldRunQuestion(settings); }
async function getUnionBanEnabled(env) {
    const raw = await getConfig(env, 'union_ban', '0');
    return raw === '1' || raw === 'true' || raw === true;
}
function getVerifyTriggerReason(settings, unionBanEnabled) {
    if (unionBanEnabled) return 'union_ban_enabled';
    if (['cloudflare_turnstile', 'google_recaptcha'].includes(settings.captchaMode)) return `captcha_mode_${settings.captchaMode}`;
    if (shouldRunQuestion(settings)) return `question_mode_${settings.questionMode}`;
    return 'verification_off';
}
async function getVerifyInactiveHours(env) {
    const hoursRaw = await getConfig(env, 'verify_inactive_hours', '');
    if (hoursRaw !== '' && hoursRaw !== null && hoursRaw !== undefined) {
        return Math.max(0, Math.min(8760, parseFloat(hoursRaw) || 0));
    }
    const legacyDays = Math.max(0, Math.min(365, parseFloat(await getConfig(env, 'verify_inactive_days', '0')) || 0));
    return legacyDays * 24;
}
function formatInactiveHours(hours) {
    if (!hours) return '关闭';
    if (hours < 24) return `${hours} 小时`;
    if (hours === 24) return '1 天';
    if (hours % 24 === 0) return `${hours / 24} 天`;
    return `${hours} 小时`;
}
async function shouldReverifyInactive(env, userData, settings, unionBanEnabled) {
    if (!userData || !userData.last_seen || !hasVerificationEnabled(settings, unionBanEnabled)) return false;
    const hours = await getVerifyInactiveHours(env);
    if (!hours) return false;
    return Date.now() - Number(userData.last_seen) > hours * 3600_000;
}
async function banUserWithNotice(env, userId, reason = '验证失败') {
    await banUser(env, userId);
    const appealUrl = await getLocalAppealUrl(env);
    await createBlacklistCard(env, userId, reason, appealUrl);
    const groupId = await getConfig(env, 'group_id');
    const userData = await getUser(env, userId);
    if (groupId && userData) await upsertProfileCard(env, groupId, userId, userData);
    const keyboard = [[{ text: '📨 本地申诉（填写理由）', callback_data: `appeal:${userId}` }], [{ text: '🔁 重新验证', callback_data: `reverify:${userId}` }]];
    if (appealUrl) keyboard.push([{ text: '🔗 本地申诉链接', url: appealUrl }]);
    await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: userId, text: `❌ 您已被本机器人本地封禁。\n原因：${reason}\n\n你可以点击“本地申诉”并填写理由，管理员会在后台处理。`, disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } });
    if (env.OWNER_ID) await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: env.OWNER_ID, text: `🚫 用户被封禁\nUID：${userId}\n原因：${reason}` });
}
async function submitLocalAppeal(env, userId, from, reason = '') {
    const token = env.BOT_TOKEN;
    const userData = await getUser(env, userId);
    if (!userData || !userData.is_banned) {
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: '你当前未被本地封禁，不需要申诉。' });
    }
    const cooldownKey = `appeal_cooldown:${userId}`;
    if (await env.KV.get(cooldownKey)) {
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: '📨 申诉已提交，请等待管理员处理。' });
    }
    const finalReason = String(reason || '').trim().slice(0, 1000) || '用户未填写理由';
    await env.KV.put(cooldownKey, '1', { expirationTtl: 600 });
    await env.KV.delete(`appeal_reason_pending:${userId}`);
    await env.KV.put(`appeal_pending:${userId}`, JSON.stringify({ user_id: userId, created_at: Date.now(), from, reason: finalReason }), { expirationTtl: 86400 });
    const name = escapeHtml(formatUserName(userData.user_info || from));
    const username = (userData.user_info && userData.user_info.username) || (from && from.username);
    const text = `📨 <b>本地封禁申诉</b>\n\n用户：<a href="tg://user?id=${userId}">${name}</a>\nUID：<code>${userId}</code>\n用户名：${username ? '@' + escapeHtml(username) : 'None'}\n\n理由：\n<pre>${escapeHtml(finalReason)}</pre>\n\n请选择处理方式：`;
    if (env.OWNER_ID) {
        await tgRequest(token, 'sendMessage', {
            chat_id: env.OWNER_ID,
            text,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[
                { text: '✅ 解封', callback_data: `appeal_unban:${userId}` },
                { text: '🔁 要求重验', callback_data: `appeal_reverify:${userId}` },
                { text: '❌ 驳回', callback_data: `appeal_reject:${userId}` }
            ]] }
        });
    }
    return tgRequest(token, 'sendMessage', { chat_id: userId, text: '📨 你的本地封禁申诉已提交，管理员处理后会通知你。' });
}
async function handleLocalAppealCallback(env, query) {
    const token = env.BOT_TOKEN;
    const userId = String(query.from.id);
    const parts = String(query.data || '').split(':');
    const targetId = String(parts[1] || '');
    if (!targetId || targetId !== userId) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '这不是你的申诉入口', show_alert: true });
    const userData = await getUser(env, userId);
    if (!userData || !userData.is_banned) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '你当前未被本地封禁', show_alert: true });
    const cooldownKey = `appeal_cooldown:${userId}`;
    if (await env.KV.get(cooldownKey)) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '申诉已提交，请等待管理员处理', show_alert: true });
    await env.KV.put(`appeal_reason_pending:${userId}`, JSON.stringify({ from: query.from, created_at: Date.now() }), { expirationTtl: 600 });
    await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '请发送申诉理由' });
    return tgRequest(token, 'sendMessage', { chat_id: userId, text: '📨 请直接发送你的申诉理由。\n\n建议写清：为什么被误封、希望管理员如何处理。' });
}

async function ensureSystemTopic(env, groupId, configName, title) {
    let threadId = await getConfig(env, configName);
    if (threadId) return Number(threadId);
    if (!groupId) return null;
    const topic = await tgRequest(env.BOT_TOKEN, 'createForumTopic', { chat_id: groupId, name: title });
    if (!topic.ok) return null;
    threadId = topic.result.message_thread_id;
    await setConfig(env, configName, String(threadId));
    if (env.KV) await env.KV.put(`thread:${threadId}`, `system:${configName}`);
    return threadId;
}
function formatUserName(userInfo = {}) {
    const firstName = escapeHtml(userInfo.first_name || '');
    const lastName = escapeHtml(userInfo.last_name || '');
    return (firstName + ' ' + lastName).trim() || 'No Name';
}
function detectPhoneRegion(text) {
    const match = String(text || '').match(/(?:\+?86[-\s]?)?1[3-9]\d{9}|\+\d{7,15}/);
    if (!match) return '';
    const phone = match[0].replace(/[\s-]/g, '');
    if (/^(\+?86)?1[3-9]\d{9}$/.test(phone)) return '中国大陆手机号';
    const prefixes = { '+852': '香港', '+853': '澳门', '+886': '台湾', '+1': '北美', '+44': '英国', '+81': '日本', '+82': '韩国', '+65': '新加坡', '+60': '马来西亚', '+66': '泰国', '+84': '越南', '+63': '菲律宾', '+62': '印尼' };
    for (const [prefix, region] of Object.entries(prefixes)) if (phone.startsWith(prefix)) return region;
    return '未知地区';
}
function buildProfileText(userId, userData = {}) {
    const info = userData.user_info || {};
    const username = info.username ? `@${escapeHtml(info.username)}` : 'None';
    const tags = Array.isArray(userData.tags) ? userData.tags.join(', ') : (userData.tags || '');
    const firstSeen = userData.first_seen ? new Date(userData.first_seen).toISOString() : '-';
    return `👤 <b>用户资料卡</b>\n\n` +
        `🆔 UID：<code>${userId}</code>\n` +
        `姓名：<a href="tg://user?id=${userId}">${formatUserName(info)}</a>\n` +
        `用户名：${username}\n` +
        `语言：${escapeHtml(info.language_code || '-')}\n` +
        `首次接入：${firstSeen}\n` +
        `消息数：${userData.message_count || 0}\n` +
        `可能手机号归属地：${escapeHtml(userData.phone_region || '-')}\n` +
        `状态：${userData.is_banned ? '🚫 已封禁' : '✅ 正常'}\n` +
        `备注：${escapeHtml(userData.note || '-')}\n` +
        `标签：${escapeHtml(tags || '-')}`;
}
async function upsertProfileCard(env, groupId, userId, userData) {
    if (!groupId || !userData || !userData.thread_id) return;
    const text = buildProfileText(userId, userData);
    const db = getD1(env);
    let messageId = null;
    if (db) {
        await ensureD1Schema(env);
        const row = await db.prepare('SELECT message_id FROM profile_cards WHERE user_id = ?').bind(String(userId)).first();
        messageId = row && row.message_id;
    } else if (env.KV) {
        messageId = await env.KV.get(`profile_card:${userId}`);
    }
    if (messageId) {
        const edited = await tgRequest(env.BOT_TOKEN, 'editMessageText', { chat_id: groupId, message_id: Number(messageId), text, parse_mode: 'HTML' });
        if (edited.ok) return;
    }
    const sent = await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: groupId, message_thread_id: userData.thread_id, text, parse_mode: 'HTML' });
    if (!sent.ok) return;
    try { await tgRequest(env.BOT_TOKEN, 'pinChatMessage', { chat_id: groupId, message_id: sent.result.message_id, disable_notification: true }); } catch (e) { }
    if (db) await db.prepare('INSERT INTO profile_cards (user_id, message_id, thread_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET message_id = excluded.message_id, thread_id = excluded.thread_id, updated_at = excluded.updated_at').bind(String(userId), sent.result.message_id, userData.thread_id, Date.now()).run();
    else if (env.KV) await env.KV.put(`profile_card:${userId}`, String(sent.result.message_id));
}
async function upsertInboxCard(env, groupId, userId, userData, msg) {
    const inboxThreadId = await ensureSystemTopic(env, groupId, 'inbox_thread_id', '🔔 未读消息');
    if (!groupId || !inboxThreadId || !userData || !userData.thread_id) return;
    const preview = escapeHtml(getMessageText(msg).slice(0, 160) || '[非文本消息]');
    const text = `🔔 <b>未读消息</b>\n\n用户：<a href="tg://user?id=${userId}">${formatUserName(userData.user_info)}</a>\nUID：<code>${userId}</code>\n消息数：${userData.message_count || 0}\n\n<pre>${preview}</pre>`;
    const reply_markup = { inline_keyboard: [[{ text: '✅ 已阅', callback_data: `inbox_read:${userId}` }, { text: '🚫 封禁', callback_data: `inbox_ban:${userId}` }], [{ text: '➡️ 跳转话题', url: `https://t.me/c/${String(groupId).replace('-100', '')}/${userData.thread_id}` }]] };
    const db = getD1(env);
    let messageId = null;
    if (db) {
        await ensureD1Schema(env);
        const row = await db.prepare('SELECT message_id FROM inbox_cards WHERE user_id = ?').bind(String(userId)).first();
        messageId = row && row.message_id;
    } else if (env.KV) messageId = await env.KV.get(`inbox_card:${userId}`);
    if (messageId) {
        const edited = await tgRequest(env.BOT_TOKEN, 'editMessageText', { chat_id: groupId, message_id: Number(messageId), text, parse_mode: 'HTML', reply_markup });
        if (edited.ok) return;
    }
    const sent = await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: groupId, message_thread_id: inboxThreadId, text, parse_mode: 'HTML', reply_markup });
    if (!sent.ok) return;
    if (db) await db.prepare('INSERT INTO inbox_cards (user_id, message_id, thread_id, last_message_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET message_id = excluded.message_id, thread_id = excluded.thread_id, last_message_at = excluded.last_message_at, updated_at = excluded.updated_at').bind(String(userId), sent.result.message_id, userData.thread_id, Date.now(), Date.now()).run();
    else if (env.KV) await env.KV.put(`inbox_card:${userId}`, String(sent.result.message_id));
}
async function createBlacklistCard(env, userId, reason, appealUrl) {
    const groupId = await getConfig(env, 'group_id');
    const threadId = groupId ? await ensureSystemTopic(env, groupId, 'blacklist_thread_id', '🚫 黑名单') : null;
    const userData = await getUser(env, userId) || {};
    const appealLine = appealUrl ? `\n申诉链接：${escapeHtml(appealUrl)}` : '\n申诉方式：Bot 内本地申诉';
    const text = `🚫 <b>黑名单用户</b>\n\n用户：<a href="tg://user?id=${userId}">${formatUserName(userData.user_info)}</a>\nUID：<code>${userId}</code>\n原因：${escapeHtml(reason)}${appealLine}`;
    const sent = groupId && threadId ? await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: groupId, message_thread_id: threadId, text, parse_mode: 'HTML' }) : { ok: false };
    const messageId = sent.ok ? sent.result.message_id : null;
    const db = getD1(env);
    if (db) { await ensureD1Schema(env); await db.prepare('INSERT INTO blacklist (user_id, reason, appeal_url, card_message_id, created_at, lifted_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, appeal_url = excluded.appeal_url, card_message_id = excluded.card_message_id, lifted_at = NULL').bind(String(userId), reason, appealUrl, messageId, Date.now()).run(); }
    else if (env.KV) await env.KV.put(`blacklist:${userId}`, JSON.stringify({ reason, appeal_url: appealUrl, card_message_id: messageId, created_at: Date.now() }));
}
async function unbanUser(env, userId) {
    const userData = await getUser(env, userId) || { user_id: String(userId) };
    userData.is_banned = false;
    await upsertUser(env, userData);
    const db = getD1(env);
    const groupId = await getConfig(env, 'group_id');
    let cardMessageId = null;
    if (db) {
        await ensureD1Schema(env);
        const row = await db.prepare('SELECT card_message_id FROM blacklist WHERE user_id = ?').bind(String(userId)).first();
        cardMessageId = row && row.card_message_id;
        await db.prepare('UPDATE blacklist SET lifted_at = ? WHERE user_id = ?').bind(Date.now(), String(userId)).run();
    } else if (env.KV) {
        const raw = await env.KV.get(`blacklist:${userId}`, { type: 'json' });
        cardMessageId = raw && raw.card_message_id;
        await env.KV.delete(`blacklist:${userId}`);
    }
    if (groupId && cardMessageId) await tgRequest(env.BOT_TOKEN, 'deleteMessage', { chat_id: groupId, message_id: Number(cardMessageId) });
    if (groupId) await upsertProfileCard(env, groupId, userId, userData);
}
async function listBlacklist(env, userId = '') {
    const db = getD1(env);
    const items = [];
    if (db) {
        await ensureD1Schema(env);
        const result = userId
            ? await db.prepare('SELECT * FROM blacklist WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(String(userId)).all()
            : await db.prepare('SELECT * FROM blacklist WHERE lifted_at IS NULL ORDER BY created_at DESC LIMIT 50').all();
        for (const row of (result.results || [])) {
            const userData = await getUser(env, row.user_id) || {};
            items.push({
                user_id: String(row.user_id),
                reason: row.reason || '',
                appeal_url: row.appeal_url || '',
                created_at: row.created_at || 0,
                lifted_at: row.lifted_at || null,
                user: userData.user_info || {}
            });
        }
        return items;
    }
    if (userId && env.KV) {
        const raw = await env.KV.get(`blacklist:${userId}`, { type: 'json' });
        if (raw) items.push({ user_id: String(userId), ...raw, user: ((await getUser(env, userId)) || {}).user_info || {} });
    }
    return items;
}
async function clearInboxCard(env, groupId, userId) {
    const db = getD1(env);
    let messageId = null;
    if (db) {
        await ensureD1Schema(env);
        const row = await db.prepare('SELECT message_id FROM inbox_cards WHERE user_id = ?').bind(String(userId)).first();
        messageId = row && row.message_id;
        await db.prepare('DELETE FROM inbox_cards WHERE user_id = ?').bind(String(userId)).run();
    } else if (env.KV) {
        messageId = await env.KV.get(`inbox_card:${userId}`);
        await env.KV.delete(`inbox_card:${userId}`);
    }
    if (groupId && messageId) await tgRequest(env.BOT_TOKEN, 'deleteMessage', { chat_id: groupId, message_id: Number(messageId) });
}
async function syncUserActivity(env, groupId, userId, msg, userData) {
    const now = Date.now();
    const next = {
        ...(userData || {}),
        user_id: String(userId),
        user_info: msg.from,
        first_seen: (userData && userData.first_seen) || now,
        last_seen: now,
        message_count: ((userData && Number(userData.message_count)) || 0) + 1,
        phone_region: (userData && userData.phone_region) || detectPhoneRegion(getMessageText(msg))
    };
    await upsertUser(env, next);
    if (env.KV) await env.KV.put(`user:${userId}`, JSON.stringify(next));
    memSet(`user:${userId}`, next);
    if (groupId && next.thread_id) {
        await upsertProfileCard(env, groupId, userId, next);
        await upsertInboxCard(env, groupId, userId, next, msg);
    }
    return next;
}
async function maybeSendRestNotice(env, userId) {
    const status = await getConfig(env, 'business_status', 'open');
    if (status !== 'rest') return false;
    const cooldown = Math.max(60, parseInt(await getConfig(env, 'business_rest_cooldown', '600'), 10) || 600);
    const key = `business_rest_notice:${userId}`;
    if (env.KV && await env.KV.get(key)) return true;
    const text = await getConfig(env, 'business_rest_message', '⏸ 当前为休息中，管理员稍后会回复您。');
    await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: userId, text });
    if (env.KV) await env.KV.put(key, '1', { expirationTtl: cooldown });
    return true;
}
function isProbablyChinese(text) { return /[\u3400-\u9fff]/.test(text || ''); }
function getAiBinding(env) {
    return env.AI || env.ai || env.WORKERS_AI || null;
}
function extractAiTranslation(response) {
    if (!response) return '';
    if (typeof response === 'string') return response;
    const candidates = [
        response.response,
        response.text,
        response.translation,
        response.result && response.result.response,
        response.result && response.result.text,
        response.result && response.result.translation,
        response.result
    ];
    for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate;
    }
    return '';
}
function isLikelyChatAnswer(text) {
    return /language model|I can('|’)t feel|I do not have feelings|I don't have feelings|How can I help|我是(一个)?(人工智能|语言模型)|我没有感情|我可以帮/i.test(text || '');
}
async function notifyAiTranslateIssue(env, reason) {
    if (!env.OWNER_ID) return;
    const key = `ai_translate_notice:${reason}`;
    if (env.KV && await env.KV.get(key)) return;
    await tgRequest(env.BOT_TOKEN, 'sendMessage', {
        chat_id: env.OWNER_ID,
        text: `⚠️ AI 翻译未生效：${reason}\n\n请检查 Workers AI 绑定名是否为 <code>AI</code>，以及后台 AI 翻译是否开启。`,
        parse_mode: 'HTML'
    });
    if (env.KV) await env.KV.put(key, '1', { expirationTtl: 3600 });
}
async function maybeTranslateToChinese(env, targetChatId, threadId, msg) {
    if ((await getConfig(env, 'ai_translate', '0')) !== '1') return;
    const text = getMessageText(msg).trim();
    if (!text || isProbablyChinese(text)) return;
    const ai = getAiBinding(env);
    if (!ai || typeof ai.run !== 'function') {
        await notifyAiTranslateIssue(env, '缺少 Workers AI 绑定');
        return;
    }
    const configuredModel = await getConfig(env, 'ai_translate_model', DEFAULT_AI_TRANSLATE_MODEL);
    const models = [...new Set([configuredModel, DEFAULT_AI_TRANSLATE_MODEL, '@cf/meta/llama-3.2-3b-instruct'])];
    let lastError = '';
    for (const model of models) {
        try {
            const response = await ai.run(model, {
                messages: [
                    { role: 'system', content: AI_TRANSLATE_SYSTEM_PROMPT },
                    { role: 'user', content: `Translate this exact text to Simplified Chinese. Do not answer it.\n\n${text.slice(0, 3000)}` }
                ],
                temperature: 0,
                max_tokens: 512
            });
            const translated = extractAiTranslation(response);
            const clean = translated.trim();
            if (clean && !isLikelyChatAnswer(clean)) {
                const payload = { chat_id: targetChatId, text: `🌐 <b>中文翻译</b>\n\n${escapeHtml(clean)}`, parse_mode: 'HTML' };
                if (threadId) payload.message_thread_id = threadId;
                await tgRequest(env.BOT_TOKEN, 'sendMessage', payload);
                return;
            }
            lastError = `${model}: ${clean ? '模型返回了聊天回答，已拦截' : '模型返回为空'}`;
        } catch (error) {
            lastError = `${model}: ${(error && error.message) || '未知错误'}`;
            console.error('AI translate failed:', lastError);
        }
    }
    await notifyAiTranslateIssue(env, escapeHtml(lastError || '模型返回为空').slice(0, 160));
}
function buildBusinessExport(configs) {
    const excluded = new Set(['bot_token', 'owner_id', 'd1', 'db', 'database', 'noomichat_db', 'relaygo_db', 'kv', 'group_id']);
    const data = {};
    for (const [key, value] of Object.entries(configs || {})) {
        const normalized = configKey(key).toLowerCase();
        if (!excluded.has(normalized) && !normalized.includes('token') && !normalized.includes('secret')) data[configKey(key)] = value;
    }
    return { version: 1, exported_at: new Date().toISOString(), config: data };
}
async function exportBusinessConfig(env) {
    const db = getD1(env);
    const configs = {};
    if (db) {
        await ensureD1Schema(env);
        const rows = await db.prepare('SELECT key, value FROM config').all();
        for (const row of (rows.results || [])) configs[row.key] = row.value;
    }
    const kvKeys = ['union_ban', 'verify_mode', 'verify_captcha_mode', 'verify_question_mode', 'verify_combo_mode', 'verify_custom_question', 'verify_custom_answer', 'verify_word_button_answer', 'verify_word_button_choices', 'verify_fail_limit', 'verify_inactive_hours', 'verify_inactive_days', 'verify_image_api_url', 'appeal_url', 'local_appeal_url', 'union_appeal_url', 'antispam', 'antispam_link', 'antispam_media', 'antispam_keyword', 'antispam_autoban', 'blocked_keywords', 'language', 'auto_reply_msg', 'welcome_msg', 'brand_msg', 'welcome_button_text', 'welcome_button_url', 'welcome_buttons', 'welcome_buttons_text', 'business_status', 'business_rest_message', 'business_rest_cooldown', 'ai_translate', 'inbox_thread_id', 'blacklist_thread_id'];
    for (const key of kvKeys) {
        if (configs[key] === undefined) configs[key] = await getConfig(env, key, '');
    }
    return buildBusinessExport(configs);
}
async function importBusinessConfig(env, raw) {
    const parsed = JSON.parse(raw);
    const config = parsed.config && typeof parsed.config === 'object' ? parsed.config : parsed;
    let count = 0;
    for (const [key, value] of Object.entries(config)) {
        const normalized = configKey(key);
        const lowerKey = normalized.toLowerCase();
        if (['bot_token', 'owner_id', 'd1', 'db', 'database', 'noomichat_db', 'relaygo_db', 'kv'].includes(lowerKey) || lowerKey.includes('token') || lowerKey.includes('secret')) continue;
        await setConfig(env, normalized, value);
        count++;
    }
    return count;
}
async function recordVerifyFail(env, userId, mode = 'verification') {
    const key = `verify_fail:${userId}`;
    const count = parseInt(await env.KV.get(key) || '0', 10) + 1;
    await env.KV.put(key, String(count), { expirationTtl: 3600 });
    await upsertVerifySession(env, userId, mode, 'failed', count, 3600);
    return count;
}
async function clearVerifyFail(env, userId) {
    await env.KV.delete(`verify_fail:${userId}`);
    await deleteVerifySession(env, userId);
}
async function buildButtonMathChallenge(env, userId) {
    const a = randomInt(1, 9), b = randomInt(1, 9), ans = a + b;
    const choices = new Set([ans]);
    while (choices.size < 4) choices.add(randomInt(Math.max(1, ans - 6), ans + 6));
    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'button_math', ans }), { expirationTtl: 180 });
    await upsertVerifySession(env, userId, 'button_math', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
    return { text: `🔒 <b>安全验证</b>\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。\n\n请选择正确答案：${a} + ${b} = ?`, reply_markup: makeChoiceButtons(userId, [...choices]) };
}
async function buildEmojiChoiceChallenge(env, userId) {
    const emojis = ['🐱', '🐶', '🐼', '🦊', '🐸', '🐵', '🐰', '🦁', '🐯', '🐮'];
    const ans = emojis[randomInt(0, emojis.length - 1)];
    const choices = new Set([ans]);
    while (choices.size < 4) choices.add(emojis[randomInt(0, emojis.length - 1)]);
    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'emoji_choice', ans }), { expirationTtl: 180 });
    await upsertVerifySession(env, userId, 'emoji_choice', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
    return {
        text: `🔒 <b>安全验证</b>\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。\n\n请点击这个表情：<b>${ans}</b>`,
        reply_markup: { inline_keyboard: [shuffleArray([...choices]).map(v => ({ text: v, callback_data: `verify:${userId}:${encodeURIComponent(v)}` }))] }
    };
}
async function buildWordButtonChallenge(env, userId) {
    const ans = await getConfig(env, 'verify_word_button_answer', '不是机器人');
    const wordsRaw = await getConfig(env, 'verify_word_button_choices', '不是机器人,我是机器人,稍后再说,跳过验证');
    const choices = new Set(String(wordsRaw).split(/[,，\n]/).map(x => x.trim()).filter(Boolean));
    choices.add(ans);
    while (choices.size < 4) choices.add(['继续', '通过', '取消', '验证'][choices.size % 4]);
    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'word_button', ans }), { expirationTtl: 180 });
    await upsertVerifySession(env, userId, 'word_button', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
    return {
        text: `🔒 <b>安全验证</b>\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。\n\n请点击正确按钮：<b>${escapeHtml(ans)}</b>`,
        reply_markup: { inline_keyboard: [shuffleArray([...choices]).slice(0, 6).map(v => ({ text: v, callback_data: `verify:${userId}:${encodeURIComponent(v)}` }))] }
    };
}
async function buildImageDigitChallenge(env, userId) {
    const apiUrl = await getConfig(env, 'verify_image_api_url', '');
    if (apiUrl) {
        try {
            const resp = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: String(userId), type: 'digit', ts: Date.now() })
            });
            if (resp.ok) {
                const data = await resp.json();
                const ans = parseInt(data.answer ?? data.ans ?? data.digit, 10);
                if (Number.isInteger(ans) && ans >= 0 && ans <= 9 && (data.image_url || data.image || data.image_base64)) {
                    const choices = new Set(Array.isArray(data.choices) ? data.choices.map(x => parseInt(x, 10)).filter(x => Number.isInteger(x) && x >= 0 && x <= 9) : [ans]);
                    choices.add(ans);
                    while (choices.size < 4) choices.add(randomInt(0, 9));
                    let photo = data.image_url || data.image;
                    if (data.image_base64) photo = base64ToBlob(data.image_base64, data.mime || 'image/png');
                    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'image_digit', ans }), { expirationTtl: 180 });
                    await upsertVerifySession(env, userId, 'image_digit_api', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
                    const caption = `${data.caption || '🔒 安全验证：请选择图片中的数字'}\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。`;
                    return { photo, filename: `noomichat-verify-api-${userId}.png`, caption, reply_markup: makeChoiceButtons(userId, [...choices].slice(0, 6)) };
                }
            }
        } catch (e) {
            console.error('verify image api failed:', e && e.message);
        }
    }
    const ans = randomInt(0, 9);
    const choices = new Set([ans]);
    while (choices.size < 4) choices.add(randomInt(0, 9));
    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'image_digit', ans }), { expirationTtl: 180 });
    await upsertVerifySession(env, userId, 'image_digit', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
    return { photo: makeDigitPngBlob(ans), filename: `noomichat-verify-${userId}.png`, caption: '🔒 安全验证：请选择图片中的数字\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。', reply_markup: makeChoiceButtons(userId, [...choices]) };
}
async function buildCustomQuestionChallenge(env, userId) {
    const question = await getConfig(env, 'verify_custom_question', '请回复：我不是机器人');
    const answer = await getConfig(env, 'verify_custom_answer', '我不是机器人');
    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'custom_question', ans: String(answer).trim().toLowerCase() }), { expirationTtl: 180 });
    await upsertVerifySession(env, userId, 'custom_question', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
    return { text: `🔒 <b>安全验证</b>\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。\n\n${escapeHtml(question)}\n\n请在 2 分钟内完成验证。` };
}
async function markUserVerificationPassed(env, userId, msg = null) {
    const now = Date.now();
    const userData = await getUser(env, userId);
    const info = (msg && msg.from) || (userData && userData.user_info) || {};
    const next = {
        ...(userData || {}),
        user_id: String(userId),
        user_info: info,
        first_seen: (userData && userData.first_seen) || now,
        last_seen: now,
        message_count: (userData && Number(userData.message_count)) || 0,
        is_verified: true,
        is_banned: false
    };
    await upsertUser(env, next);
    if (env.KV) await env.KV.put(`user:${userId}`, JSON.stringify(next));
    memSet(`user:${userId}`, next);
    return next;
}
async function finishInitialVerification(env, userId, msg, token) {
    await markUserVerificationPassed(env, userId, msg);
    if (env.KV) await env.KV.delete(`verify_original:${userId}`);
    await sendWelcomeMessage(env, userId, { includeBrand: true });
    return tgRequest(token, 'sendMessage', {
        chat_id: userId,
        text: '✅ 验证通过。为了安全，验证前发送的消息已丢弃，请重新发送。'
    });
}
async function discardVerificationMessage(env, userId) {
    if (!env.KV) return;
    await env.KV.delete(`verify_original:${userId}`);
}
async function startQuestionVerification(env, groupId, msg, userId, token, mode) {
    if (mode === 'sticker') {
        await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'sticker' }), { expirationTtl: 180 });
        await upsertVerifySession(env, userId, 'sticker', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
        return tgRequest(token, 'sendMessage', {
            chat_id: userId,
            text: "🔒 <b>安全验证</b>\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。\n\n⚫️⚫️⚫️ <b>请发送一张 Telegram 贴纸或表情</b> ⚫️⚫️⚫️\n\n<b>注意：贴纸 / Sticker 或纯表情都可以，不是图片、文件或普通文字。</b>\n\n✅ 发送任意贴纸或表情即可通过验证。\n⏳ 请在 <b>2 分钟</b> 内完成。",
            parse_mode: 'HTML'
        });
    } else if (mode === 'math') {
        const a = Math.floor(Math.random() * 10), b = Math.floor(Math.random() * 10);
        await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'math', ans: a + b }), { expirationTtl: 180 });
        await upsertVerifySession(env, userId, 'math', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: `🔒 <b>安全验证</b>\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。\n\n请计算结果（直接发送数字）: ${a} + ${b} = ?\n\n请在 2 分钟内完成验证。`, parse_mode: 'HTML' });
    } else if (mode === 'button_math') {
        const challenge = await buildButtonMathChallenge(env, userId);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: challenge.text, parse_mode: 'HTML', reply_markup: challenge.reply_markup });
    } else if (mode === 'emoji_choice') {
        const challenge = await buildEmojiChoiceChallenge(env, userId);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: challenge.text, parse_mode: 'HTML', reply_markup: challenge.reply_markup });
    } else if (mode === 'word_button') {
        const challenge = await buildWordButtonChallenge(env, userId);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: challenge.text, parse_mode: 'HTML', reply_markup: challenge.reply_markup });
    } else if (mode === 'image_digit') {
        const challenge = await buildImageDigitChallenge(env, userId);
        return tgFormRequest(token, 'sendPhoto', { chat_id: userId, photo: challenge.photo, filename: challenge.filename || `noomichat-verify-${userId}.png`, caption: challenge.caption, reply_markup: challenge.reply_markup });
    } else if (mode === 'custom_question') {
        const challenge = await buildCustomQuestionChallenge(env, userId);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: challenge.text, parse_mode: 'HTML' });
    }
    return initializeUser(env, groupId, msg, userId, token);
}
async function completeQuestionVerification(env, groupId, msg, userId, token, pendingState) {
    const chain = pendingState && pendingState.chain;
    await env.KV.delete(`verify_pending:${userId}`);
    await upsertVerifySession(env, userId, pendingState && pendingState.type, 'passed', 0, 60);
    await clearVerifyFail(env, userId);
    const reverifyPending = await env.KV.get(`reverify_pending:${userId}`, { type: 'json' });
    if (reverifyPending) {
        await env.KV.delete(`reverify_pending:${userId}`);
        if (reverifyPending.reason === 'inactive') {
            await markUserVerificationPassed(env, userId, msg);
            if (env.KV) await env.KV.delete(`verify_original:${userId}`);
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: '✅ 验证已恢复。刚才那条消息不会保存或转发，请重新发送。' });
        } else {
            await unbanUser(env, userId);
            await tgRequest(token, 'sendMessage', { chat_id: userId, text: '✅ 重新验证通过，您可以继续聊天。' });
            return;
        }
    }
    return finishInitialVerification(env, userId, msg, token);
}
async function handleReverifyCallback(env, query) {
    const token = env.BOT_TOKEN;
    const userId = String(query.from.id);
    const parts = query.data.split(':');
    if (parts[1] !== userId) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '这不是你的验证', show_alert: true });
    const groupId = await getConfig(env, 'group_id');
    const userData = await getUser(env, userId) || { user_id: userId };
    await env.KV.put(`reverify_pending:${userId}`, JSON.stringify({ thread_id: userData.thread_id || null }), { expirationTtl: 1800 });
    await clearVerifyFail(env, userId);
    await upsertVerifySession(env, userId, 'reverify', 'started', 0, 600);
    try { await tgRequest(token, 'editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (e) { }
    await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '请开始重新验证' });
    const settings = await getVerifySettings(env);
    const unionEnabled = await getUnionBanEnabled(env);
    const verifyMsg = { chat: query.message.chat, from: query.from, message_id: query.message.message_id, text: '/start' };
    if (shouldRunCaptcha(settings, unionEnabled)) return startCaptchaVerification(env, groupId, verifyMsg, userId, token, settings, unionEnabled);
    if (shouldRunQuestion(settings)) return handleLocalVerification(env, groupId, verifyMsg, userId, token, settings.questionMode);
    await unbanUser(env, userId);
    await env.KV.delete(`reverify_pending:${userId}`);
    await tgRequest(token, 'sendMessage', { chat_id: userId, text: '✅ 已解除封禁，您可以继续聊天。' });
}
async function handleVerifyCallback(env, query) {
    const token = env.BOT_TOKEN;
    const userId = String(query.from.id);
    const parts = query.data.split(':');
    if (parts[1] !== userId) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '这不是你的验证', show_alert: true });
    const pending = await env.KV.get(`verify_pending:${userId}`, { type: 'json' });
    if (!pending) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '验证已过期，请发送 /start 重试', show_alert: true });
    const rawSelected = decodeURIComponent(parts.slice(2).join(':') || '');
    const selected = parseInt(rawSelected, 10);
    const groupId = await getConfig(env, 'group_id');
    const passed = ['emoji_choice', 'word_button'].includes(pending.type)
        ? rawSelected === String(pending.ans)
        : selected === pending.ans;
    if (passed) {
        await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '验证通过' });
        try { await tgRequest(token, 'editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (e) { }
        return completeQuestionVerification(env, groupId, { chat: query.message.chat, from: query.from, message_id: query.message.message_id, text: '/start' }, userId, token, pending);
    }
    const failCount = await recordVerifyFail(env, userId);
    const limit = await getVerifyFailLimit(env);
    await env.KV.delete(`verify_pending:${userId}`);
    await env.KV.delete(`verify_original:${userId}`);
    if (failCount >= limit) {
        await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '验证失败，已封禁', show_alert: true });
        return banUserWithNotice(env, userId, `验证失败 ${failCount}/${limit}`);
    }
    await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: `验证错误，还剩 ${limit - failCount} 次机会`, show_alert: true });
    return tgRequest(token, 'sendMessage', { chat_id: userId, text: '❌ 验证错误，请发送 /start 重新验证。' });
}

async function generateSettingsMenu(env, page = 'main') {
    const unionBan = await getUnionBanEnabled(env);
    const verifyMode = await getConfig(env, 'verify_mode', 'off');
    const autoReplyMsg = await getConfig(env, 'auto_reply_msg');
    const botUsername = await getConfig(env, 'bot_username', 'My Bot');
    const language = await getConfig(env, 'language', 'auto');
    const anti = await getAntiSpamConfig(env);
    const keywordRaw = await getConfig(env, 'blocked_keywords');
    const keywordCount = keywordRaw ? keywordRaw.split(/[\n,，]/).map(x => x.trim()).filter(Boolean).length : 0;
    const failLimit = await getVerifyFailLimit(env);
    const inactiveHours = await getVerifyInactiveHours(env);
    const inactiveDisplay = formatInactiveHours(inactiveHours);
    const appealUrl = await getAppealUrl(env);
    const unionAppealUrl = await getUnionAppealUrl(env);
    const businessStatus = await getConfig(env, 'business_status', 'open');
    const aiTranslate = await getConfig(env, 'ai_translate', '0');
    const unionStatus = unionBan ? '🟢 开启' : '🔴 关闭';
    const verifySettings = await getVerifySettings(env);
    const verifyLabels = { off: '🔴 关闭', math: '🔢 数学题', button_math: '🔘 算数按钮', sticker: '🎨 贴纸/表情', emoji_choice: '😺 表情选择', word_button: '🔤 文字按钮', image_digit: '🖼 图片数字', custom_question: '❓ 自定义问答' };
    const captchaLabels = { off: '🔴 无验证码', cloudflare_turnstile: '🛡 Turnstile', google_recaptcha: '🧩 reCAPTCHA' };
    const comboLabels = { captcha_only: '只验证码', question_only: '只问答', captcha_question: '验证码+问答' };
    const verifyDisplay = `${comboLabels[verifySettings.comboMode] || '只问答'} / ${captchaLabels[verifySettings.captchaMode] || '🔴 无验证码'} / ${verifyLabels[verifySettings.questionMode] || '🔴 关闭'}`;
    const replyStatus = autoReplyMsg ? '🟢 已启用' : '⚪️ 已关闭';
    const antiStatus = anti.enabled ? '🟢 开启' : '🔴 关闭';
    const businessDisplay = businessStatus === 'rest' ? '😴 休息中' : '🟢 营业中';
    const aiDisplay = aiTranslate === '1' ? '🟢 开' : '🔴 关';
    const langDisplay = ({ auto: '🌐 自动', zh: '🇨🇳 中文', en: '🇬🇧 English' })[language] || '🌐 自动';
    if (page === 'antispam') {
        return {
            text: `🛡 <b>安全 / 防骚扰</b>\n\n状态：${antiStatus}\n链接拦截：${anti.blockLinks ? '🟢 开启' : '🔴 关闭'}\n媒体限制：${anti.blockMedia ? '🟢 开启' : '🔴 关闭'}\n关键词：${anti.blockKeywords ? '🟢 开启' : '🔴 关闭'}（${keywordCount} 个）\n命中自封：${anti.autoBan ? '🟢 开启' : '🔴 关闭'}`,
            reply_markup: { inline_keyboard: [
                [{ text: `🛡 总开关：${antiStatus}`, callback_data: 'toggle_antispam' }],
                [{ text: `🔗 链接拦截：${anti.blockLinks ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_link' }, { text: `🖼 媒体限制：${anti.blockMedia ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_media' }],
                [{ text: `🚫 关键词：${anti.blockKeywords ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_keyword' }, { text: `⚡ 命中自封：${anti.autoBan ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_autoban' }],
                [{ text: '📝 关键词管理', callback_data: 'guide_keywords' }],
                [{ text: '🔙 返回安全目录', callback_data: 'menu_security' }]
            ] }
        };
    }
    if (page === 'verify') {
        return {
            text: `🧩 <b>安全 / 人机验证</b>\n\n当前：${verifyDisplay}\n失败封禁：${failLimit} 次\n验证过期周期：${inactiveDisplay}`,
            reply_markup: { inline_keyboard: [
                [{ text: `🔗 组合：${comboLabels[verifySettings.comboMode] || '只问答'}`, callback_data: 'cycle_verify_combo' }],
                [{ text: `🧩 云端验证码：${captchaLabels[verifySettings.captchaMode] || '🔴'}`, callback_data: 'cycle_verify_captcha' }],
                [{ text: `❓ 本地问答：${verifyLabels[verifySettings.questionMode] || '🔴'}`, callback_data: 'cycle_verify_local' }],
                [{ text: `❌ 失败封禁：${failLimit}次`, callback_data: 'cycle_verify_fail_limit' }],
                [{ text: `⏳ 验证过期：${inactiveDisplay}`, callback_data: 'cycle_verify_inactive' }],
                [{ text: '🔙 返回安全目录', callback_data: 'menu_security' }]
            ] }
        };
    }
    if (page === 'runtime') {
        return {
            text: `🏪 <b>运营 / 中继</b>\n\n营业状态：${businessDisplay}\nAI 翻译：${aiDisplay}\n\n休息模式会拦截普通用户消息并按冷却时间回复忙碌提示；管理员仍可正常回复。`,
            reply_markup: { inline_keyboard: [
                [{ text: `🏪 营业状态：${businessDisplay}`, callback_data: 'toggle_business' }],
                [{ text: `🤖 AI 翻译：${aiDisplay}`, callback_data: 'toggle_ai_translate' }],
                [{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]
            ] }
        };
    }
    if (page === 'security') {
        return {
            text: `🛡 <b>安全目录</b>\n\n人机验证：${verifyDisplay}\n防骚扰：${antiStatus}\n关键词：${anti.blockKeywords ? '🟢 开启' : '🔴 关闭'}（${keywordCount} 个）\n联合封禁：${unionStatus}\n失败封禁：${failLimit} 次`,
            reply_markup: { inline_keyboard: [
                [{ text: '🧩 人机验证', callback_data: 'menu_verify' }, { text: '🛡 防骚扰', callback_data: 'menu_antispam' }],
                [{ text: `🌐 联合封禁：${unionStatus}`, callback_data: 'toggle_union' }],
                [{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]
            ] }
        };
    }
    if (page === 'users') {
        return {
            text: `👥 <b>用户 / 权限</b>\n\n本地申诉：${appealUrl ? escapeHtml(appealUrl) : 'Bot 内填写理由'}\n联合申诉：${escapeHtml(unionAppealUrl || '未设置')}\n\n协管、黑名单和申诉建议优先在网页后台管理。`,
            reply_markup: { inline_keyboard: [
                [{ text: '👮 协管列表', callback_data: 'admin_list' }],
                [{ text: '🔗 申诉设置说明', callback_data: 'guide_appeal' }],
                [{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]
            ] }
        };
    }
    if (page === 'system') {
        return {
            text: `⚙️ <b>系统 / 工具</b>\n\n语言：${langDisplay}\n导入导出只处理业务配置，不包含 BOT_TOKEN、OWNER_ID 或 D1 绑定名。`,
            reply_markup: { inline_keyboard: [
                [{ text: `🌐 语言：${langDisplay}`, callback_data: 'cycle_language' }],
                [{ text: '📤 导出配置', callback_data: 'export_config' }, { text: '📥 导入说明', callback_data: 'guide_import' }],
                [{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]
            ] }
        };
    }
    if (page === 'messages') {
        return {
            text: `📝 <b>内容 / 文案</b>\n\n自动回复：${replyStatus}\n\n欢迎语、品牌文案、按钮支持在网页后台修改；也可用 /welcome、/brand、/welbtn、/reply 命令。`,
            reply_markup: { inline_keyboard: [
                [{ text: '👋 欢迎消息说明', callback_data: 'guide_welcome' }],
                [{ text: '🤖 自动回复说明', callback_data: 'guide_reply' }],
                [{ text: '📢 群发广播', callback_data: 'guide_broadcast' }],
                [{ text: '🔙 返回主菜单', callback_data: 'menu_main' }]
            ] }
        };
    }
    const info = `🛠 <b>${escapeHtml(botUsername)} 管理面板</b>\n\n📊 <b>当前配置:</b>\n🔸 营业状态：${businessDisplay}\n🔸 AI 翻译：${aiDisplay}\n🔸 人机验证：${verifyDisplay}\n🔸 防骚扰：${antiStatus}\n🔸 关键词：${anti.blockKeywords ? '🟢 开启' : '🔴 关闭'}（${keywordCount} 个）\n🔸 联合封禁：${unionStatus}\n🔸 自动回复：${replyStatus}\n🔸 本地申诉：${appealUrl ? escapeHtml(appealUrl) : 'Bot 内填写理由'}\n\n👇 按目录进入设置`;
    const keyboard = { inline_keyboard: [
        [{ text: '🏪 运营中继 ➡️', callback_data: 'menu_runtime' }, { text: '🛡 安全验证 ➡️', callback_data: 'menu_security' }],
        [{ text: '📝 内容文案 ➡️', callback_data: 'menu_messages' }, { text: '👥 用户权限 ➡️', callback_data: 'menu_users' }],
        [{ text: '⚙️ 系统工具 ➡️', callback_data: 'menu_system' }],
        [{ text: '🔄 刷新', callback_data: 'refresh_menu' }]
    ] };
    return { text: info, reply_markup: keyboard };
}

async function handleOwnerCallback(env, query) {
    const token = env.BOT_TOKEN;
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('identity:')) {
        const targetId = data.split(':')[1];
        const userData = await getUser(env, targetId) || {};
        const info = userData.user_info || {};
        const username = info.username ? `@${info.username}` : 'None';
        return tgRequest(token, 'answerCallbackQuery', {
            callback_query_id: query.id,
            text: `用户：${getPlainUserName(info)}\nUID：${targetId}\n用户名：${username}`,
            show_alert: true
        });
    }

    if (data.startsWith('menu_') || data === 'refresh_menu') {
        const page = data === 'refresh_menu' ? 'main' : data.replace('menu_', '');
        const menu = await generateSettingsMenu(env, page);
        try { await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup }); } catch (e) { }
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }

    if (data.startsWith('appeal_')) {
        const [action, targetId] = data.split(':');
        if (!(await hasPermission(env, query.from.id, 'ban'))) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '需要 ban 权限', show_alert: true });
        if (action === 'appeal_unban') {
            await unbanUser(env, targetId);
            await env.KV.delete(`appeal_pending:${targetId}`);
            await writeAuditLog(env, query.from.id, 'appeal.unban', targetId);
            await tgRequest(token, 'sendMessage', { chat_id: targetId, text: '✅ 你的本地封禁申诉已通过，已为你解除封禁。' });
            await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已解封' });
        } else if (action === 'appeal_reverify') {
            const userData = await getUser(env, targetId) || { user_id: targetId };
            await env.KV.put(`reverify_pending:${targetId}`, JSON.stringify({ thread_id: userData.thread_id || null }), { expirationTtl: 1800 });
            await env.KV.delete(`appeal_pending:${targetId}`);
            await clearVerifyFail(env, targetId);
            await writeAuditLog(env, query.from.id, 'appeal.reverify', targetId);
            await tgRequest(token, 'sendMessage', { chat_id: targetId, text: '🔁 管理员已允许你重新验证。请点击下方按钮开始。', reply_markup: { inline_keyboard: [[{ text: '开始重新验证', callback_data: `reverify:${targetId}` }]] } });
            await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已通知用户重验' });
        } else if (action === 'appeal_reject') {
            await env.KV.delete(`appeal_pending:${targetId}`);
            await writeAuditLog(env, query.from.id, 'appeal.reject', targetId);
            await tgRequest(token, 'sendMessage', { chat_id: targetId, text: '❌ 你的本地封禁申诉已被驳回。' });
            await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已驳回' });
        }
        try { await tgRequest(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); } catch (e) { }
        return;
    }

    if (data.startsWith('spam_')) {
        const [action, targetId] = data.split(':');
        if (action === 'spam_ban') {
            if (!(await hasPermission(env, query.from.id, 'ban'))) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '权限不足', show_alert: true });
            await banUserWithNotice(env, targetId, '管理员手动封禁');
            await writeAuditLog(env, query.from.id, 'user.ban', targetId, { source: 'spam_review' });
            await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已封禁用户' });
        }
        else if (action === 'spam_trust') { await env.KV.put(`trusted:${targetId}`, '1'); await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已加入白名单' }); }
        else if (action === 'spam_allow') { await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '当前版本不缓存原消息，请让用户重新发送', show_alert: true }); }
        try { await tgRequest(token, 'editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }); } catch (e) { }
        return;
    }

    if (data.startsWith('inbox_')) {
        const [action, targetId] = data.split(':');
        const groupId = await getConfig(env, 'group_id');
        if (action === 'inbox_read') {
            await clearInboxCard(env, groupId, targetId);
            return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已标记已阅' });
        }
        if (action === 'inbox_ban') {
            if (!(await hasPermission(env, query.from.id, 'ban'))) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '权限不足', show_alert: true });
            await banUserWithNotice(env, targetId, '管理员从收件箱封禁');
            await clearInboxCard(env, groupId, targetId);
            return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已封禁' });
        }
    }

    const configActions = new Set(['toggle_union', 'toggle_business', 'toggle_ai_translate', 'toggle_antispam', 'toggle_antispam_link', 'toggle_antispam_media', 'toggle_antispam_keyword', 'toggle_antispam_autoban', 'cycle_language', 'cycle_verify_fail_limit', 'cycle_verify_captcha', 'cycle_verify_combo', 'cycle_verify_local', 'cycle_verify_inactive', 'export_config']);
    if (configActions.has(data) && !(await hasPermission(env, query.from.id, 'config'))) {
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '权限不足', show_alert: true });
    }

    if (data === 'admin_list') {
        if (!(await hasPermission(env, query.from.id, 'panel'))) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '权限不足', show_alert: true });
        const admins = await listAdmins(env);
        const lines = admins.map(admin => {
            const role = admin.is_owner ? 'OWNER' : 'ADMIN';
            return `• <a href="tg://user?id=${admin.user_id}">${admin.user_id}</a> (${role})\n  权限：${admin.permissions.join(', ')}`;
        });
        const text = `👮 <b>协管列表</b>\n\n${lines.join('\n') || '暂无协管'}\n\n添加：<code>/addadmin TelegramID reply,panel</code>\n删除：<code>/deladmin TelegramID</code>`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }

    if (data === 'toggle_union') {
        const currentVal = await getConfig(env, 'union_ban');
        const isEnabled = currentVal === '1' || currentVal === 'true';
        const newVal = isEnabled ? '0' : '1';
        await setConfig(env, 'union_ban', newVal);
        await writeAuditLog(env, query.from.id, 'config.toggle', 'union_ban', { value: newVal });
    }
    else if (data === 'toggle_business') {
        const current = await getConfig(env, 'business_status', 'open');
        await setConfig(env, 'business_status', current === 'rest' ? 'open' : 'rest');
        await writeAuditLog(env, query.from.id, 'config.toggle', 'business_status', { value: current === 'rest' ? 'open' : 'rest' });
    }
    else if (data === 'toggle_ai_translate') {
        const current = await getConfig(env, 'ai_translate', '0');
        await setConfig(env, 'ai_translate', current === '1' ? '0' : '1');
        await writeAuditLog(env, query.from.id, 'config.toggle', 'ai_translate', { value: current === '1' ? '0' : '1' });
    }
    else if (data === 'export_config') {
        if (!(await hasPermission(env, query.from.id, 'config'))) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '权限不足', show_alert: true });
        const exported = await exportBusinessConfig(env);
        await sendJsonDocument(env, query.from.id, `noomichat-config-${Date.now()}.json`, exported);
        await writeAuditLog(env, query.from.id, 'config.export');
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已发送导出 JSON' });
    }
    else if (data === 'toggle_antispam') await setToggle(env, 'config:antispam');
    else if (data === 'toggle_antispam_link') await setToggle(env, 'config:antispam_link');
    else if (data === 'toggle_antispam_media') await setToggle(env, 'config:antispam_media');
    else if (data === 'toggle_antispam_keyword') await setToggle(env, 'config:antispam_keyword');
    else if (data === 'toggle_antispam_autoban') await setToggle(env, 'config:antispam_autoban');
    else if (data === 'cycle_language') { const modes = ['auto', 'zh', 'en']; const current = await getConfig(env, 'language', 'auto'); await setConfig(env, 'language', modes[(modes.indexOf(current) + 1) % modes.length]); }
    else if (data === 'cycle_verify_fail_limit') { const current = await getVerifyFailLimit(env); const next = current >= 5 ? 1 : current + 1; await setConfig(env, 'verify_fail_limit', String(next)); }
    else if (data === 'cycle_verify_inactive') { const modes = [0, 1, 2, 6, 12, 24, 72, 168]; const current = await getVerifyInactiveHours(env); const idx = modes.indexOf(current); await setConfig(env, 'verify_inactive_hours', String(modes[(idx + 1) % modes.length])); }
    else if (data === 'cycle_verify_captcha') {
        const modes = ['off', 'cloudflare_turnstile', 'google_recaptcha'];
        const currentMode = await getConfig(env, 'verify_captcha_mode', 'off');
        await setConfig(env, 'verify_captcha_mode', modes[(modes.indexOf(currentMode) + 1) % modes.length]);
    }
    else if (data === 'cycle_verify_combo') {
        const modes = ['question_only', 'captcha_only', 'captcha_question'];
        const currentMode = await getConfig(env, 'verify_combo_mode', 'question_only');
        await setConfig(env, 'verify_combo_mode', modes[(modes.indexOf(currentMode) + 1) % modes.length]);
    }
    else if (data === 'cycle_verify_local') {
        const modes = ['off', 'math', 'button_math', 'sticker', 'emoji_choice', 'word_button', 'image_digit', 'custom_question'];
        const currentMode = await getConfig(env, 'verify_question_mode', await getConfig(env, 'verify_mode', 'off'));
        const nextMode = modes[(modes.indexOf(currentMode) + 1) % modes.length];
        await setConfig(env, 'verify_question_mode', nextMode);
        await setConfig(env, 'verify_mode', nextMode);
    }
    // guide_* 只是提示信息，不涉及 KV 修改
    else if (data === 'guide_keywords') {
        const current = await getConfig(env, 'blocked_keywords');
        const currentText = current ? escapeHtml(current) : '(无)';
        const text = `📝 <b>关键词防骚扰</b>\n\n当前关键词：\n<pre>${currentText}</pre>\n\n👉 <b>设置关键词:</b>\n发送 <code>/keywords</code> 广告,博彩,引流\n\n👉 <b>清空关键词:</b>\n发送 <code>/keywords</code>\n\n多个关键词可用逗号或换行分隔。`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }
    else if (data === 'guide_appeal') {
        const current = await getAppealUrl(env);
        const text = `🔗 <b>申诉链接设置</b>\n\n当前链接：\n<pre>${escapeHtml(current)}</pre>\n\n发送 <code>/appeal</code> 申诉链接\n例如：<code>/appeal https://t.me/yourname</code>`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }
    else if (data === 'guide_welcome') {
        const current = await getConfig(env, 'welcome_msg');
        const btns = await getConfig(env, 'welcome_buttons');
        const brand = await getConfig(env, 'brand_msg', DEFAULT_BRAND_MSG);
        const currentText = current ? escapeHtml(current) : "(无)";
        const brandText = brand ? escapeHtml(brand) : "(已关闭)";
        const btnInfo = btns ? "已设置按钮" : "(无)";
        const text = `📝 <b>欢迎消息设置</b>\n\n当前文本:\n<pre>${currentText}</pre>\n\n底部品牌:\n<pre>${brandText}</pre>\n\n当前按钮: ${btnInfo}\n\n👉 <b>修改文本:</b>\n发送 <code>/welcome</code> {消息内容}\n支持 HTML 链接：<code>&lt;a href="https://t.me/xxx"&gt;点击这里&lt;/a&gt;</code>\n\n👉 <b>修改品牌:</b>\n发送 <code>/brand</code> {HTML文案}\n发送 <code>/brand off</code> 关闭\n\n👉 <b>修改按钮:</b>\n发送 <code>/welbtn</code> {按钮内容}\n格式：按钮1 - 链接1 | 按钮2 - 链接2 , 按钮3 - 链接3\n(逗号换行，竖线同行，最多设置3个)\n\n发送 /cancel 返回`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }
    else if (data === 'guide_reply') {
        const current = await getConfig(env, 'auto_reply_msg');
        const currentText = current ? escapeHtml(current) : "(已关闭)";
        const text = `🤖 <b>自动回复设置</b>\n\n当前内容:\n<pre>${currentText}</pre>\n\n👉 <b>修改:</b>\n发送 <code>/reply</code> {消息内容}\n\n👉 <b>关闭:</b>\n发送 <code>/reply</code> (不带内容)\n\n发送 /cancel 返回`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }
    else if (data === 'guide_broadcast') {
        const text = `📢 <b>消息广播</b>\n\n👉 <b>发送:</b>\n发送 <code>/broadcast</code> {广播内容}\n\n发送 /cancel 返回`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }
    else if (data === 'guide_import') {
        const text = `📥 <b>导入/导出配置</b>\n\n导出：发送 <code>/export</code> 或点击导出按钮，会发送 JSON 文件。\n导入 JSON 文本：发送 <code>/import</code> 后换行粘贴 JSON。\n导入 .json 文件：把文件发给管理员私聊。\n\n验证问答：<code>/verifyqa 问题 | 答案</code>\n\n不会导入/导出 BOT_TOKEN、OWNER_ID、D1 绑定名等环境变量。`;
        await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' });
        return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
    }

    let returnPage = 'main';
    if (data.startsWith('toggle_antispam') || data === 'guide_keywords') returnPage = 'antispam';
    else if (data.startsWith('cycle_verify') || data === 'guide_appeal') returnPage = 'verify';
    else if (data === 'toggle_union' || data === 'cycle_language' || data === 'toggle_ai_translate' || data === 'guide_import') returnPage = 'system';
    else if (data === 'guide_welcome' || data === 'guide_reply' || data === 'guide_broadcast') returnPage = 'messages';
    const menu = await generateSettingsMenu(env, returnPage);
    try { await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup }); } catch (e) { }
    return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
}

async function handleOwnerMenu(env, msg, ctx) {
    const token = env.BOT_TOKEN;
    const chatId = msg.chat.id;
    let text = msg.text || '';

    if (text === '/start') {
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `👋 您好，NooMiChat 管理员！\n\n您看到此消息说明机器人已成功启动。\n\n当前版本：2.1.4\n项目地址：https://github.com/lijboys/NooMiChat\n发送 /menu 显示管理菜单`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '查看项目文档', url: 'https://github.com/lijboys/NooMiChat' }]] } });
    }

    if (['/menu', '/cancel'].includes(text)) {
        const menu = await generateSettingsMenu(env);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup });
    }

    if (msg.reply_to_message && !text.startsWith('/')) {
        if (!(await hasPermission(env, msg.from.id, 'reply'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 reply 权限。' });
        const targetId = await env.KV.get(`owner_reply_map:${msg.reply_to_message.message_id}`);
        if (targetId) {
            const result = await forwardMessage(env, token, targetId, chatId, msg);
            const userData = await getUser(env, targetId) || {};
            const who = formatUserReplyTarget(targetId, userData);
            await writeAuditLog(env, msg.from.id, 'message.reply', targetId, { source: 'owner_private' });
            return tgRequest(token, 'sendMessage', {
                chat_id: chatId,
                text: result && result.ok ? `✅ 已回复给：${who}` : `⚠️ 回复可能失败：${who}\n${escapeHtml((result && result.description) || '')}`,
                parse_mode: 'HTML'
            });
        }
    }

    if (text === '/admins') {
        if (!(await hasPermission(env, msg.from.id, 'panel'))) return;
        const admins = await listAdmins(env);
        const lines = admins.map(admin => {
            const role = admin.is_owner ? 'OWNER' : 'ADMIN';
            return `• <a href="tg://user?id=${admin.user_id}">${admin.user_id}</a> (${role})\n  权限：${admin.permissions.join(', ')}`;
        });
        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `👮 <b>协管列表</b>\n\n${lines.join('\n') || '暂无协管'}\n\n添加：<code>/addadmin TelegramID reply,panel</code>\n删除：<code>/deladmin TelegramID</code>`,
            parse_mode: 'HTML'
        });
    }

    if (msg.document) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        try {
            const raw = await readTelegramJsonDocument(env, msg.document);
            if (!raw) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '❌ 请发送 .json 文件。' });
            const count = await importBusinessConfig(env, raw);
            await writeAuditLog(env, msg.from.id, 'config.import_file', '', { count });
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `✅ 已从文件导入 ${count} 项配置。` });
        } catch (e) {
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `❌ 导入失败：${escapeHtml(e.message)}`, parse_mode: 'HTML' });
        }
    }

    if (text.startsWith('/addadmin ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const parts = text.trim().split(/\s+/);
        const targetId = parts[1];
        const permissions = (parts[2] || 'reply,panel').split(',').map(x => x.trim()).filter(Boolean);
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '用法：/addadmin TelegramID reply,panel,ban,config' });
        try {
            const saved = await addAdmin(env, targetId, permissions);
            await writeAuditLog(env, msg.from.id, 'admin.add', targetId, { permissions: saved });
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `✅ 已添加协管 <code>${targetId}</code>\n权限：${saved.join(', ')}`, parse_mode: 'HTML' });
        } catch (e) {
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `❌ 添加失败：${escapeHtml(e.message)}`, parse_mode: 'HTML' });
        }
    }

    if (text.startsWith('/deladmin ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const targetId = text.trim().split(/\s+/)[1];
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '用法：/deladmin TelegramID' });
        try {
            await removeAdmin(env, targetId);
            await writeAuditLog(env, msg.from.id, 'admin.remove', targetId);
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `✅ 已删除协管 <code>${targetId}</code>`, parse_mode: 'HTML' });
        } catch (e) {
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `❌ 删除失败：${escapeHtml(e.message)}`, parse_mode: 'HTML' });
        }
    }

    // 手动封禁/解封
    if (text.startsWith('/ban ')) {
        if (!(await hasPermission(env, msg.from.id, 'ban'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 ban 权限。' });
        const targetId = text.split(' ')[1];
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 命令错误。用法: <code>/ban</code> <uid>", parse_mode: 'HTML' });

        await banUserWithNotice(env, targetId, '管理员手动封禁');
        await writeAuditLog(env, msg.from.id, 'user.ban', targetId, { source: 'private_command' });

        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `🚫 用户 <a href="tg://user?id=${targetId}">${targetId}</a> 已在本地封禁。`,
            parse_mode: 'HTML'
        });
    }
    if (text.startsWith('/unban ')) {
        if (!(await hasPermission(env, msg.from.id, 'ban'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 ban 权限。' });
        const targetId = text.split(' ')[1];
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 命令错误。用法: <code>/unban</code> <uid>", parse_mode: 'HTML' });

        await unbanUser(env, targetId);
        await writeAuditLog(env, msg.from.id, 'user.unban', targetId, { source: 'private_command' });

        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `✅ 用户 <a href="tg://user?id=${targetId}">${targetId}</a> 已解封。`,
            parse_mode: 'HTML'
        });
    }

    if (text.startsWith('/note ')) {
        if (!(await hasPermission(env, msg.from.id, 'reply'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 reply 权限。' });
        const parts = text.match(/^\/note\s+(\d+)\s+([\s\S]+)$/);
        if (!parts) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '用法：/note UID 备注内容' });
        const userData = await getUser(env, parts[1]) || { user_id: parts[1] };
        userData.note = parts[2].trim();
        await upsertUser(env, userData);
        if (userData.thread_id) await upsertProfileCard(env, await getConfig(env, 'group_id'), parts[1], userData);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '✅ 备注已更新。' });
    }
    if (text.startsWith('/tag ')) {
        if (!(await hasPermission(env, msg.from.id, 'reply'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 reply 权限。' });
        const parts = text.match(/^\/tag\s+(\d+)\s+([\s\S]+)$/);
        if (!parts) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '用法：/tag UID 标签1,标签2' });
        const userData = await getUser(env, parts[1]) || { user_id: parts[1] };
        userData.tags = parts[2].split(/[,，\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 20);
        await upsertUser(env, userData);
        if (userData.thread_id) await upsertProfileCard(env, await getConfig(env, 'group_id'), parts[1], userData);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '✅ 标签已更新。' });
    }
    if (text.startsWith('/clear ')) {
        if (!(await hasPermission(env, msg.from.id, 'reply'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 reply 权限。' });
        const targetId = text.trim().split(/\s+/)[1];
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '用法：/clear UID' });
        const userData = await getUser(env, targetId) || { user_id: targetId };
        userData.note = '';
        await upsertUser(env, userData);
        if (userData.thread_id) await upsertProfileCard(env, await getConfig(env, 'group_id'), targetId, userData);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '✅ 备注已删除。' });
    }

    if (text === '/export') {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const exported = await exportBusinessConfig(env);
        await writeAuditLog(env, msg.from.id, 'config.export');
        return sendJsonDocument(env, chatId, `noomichat-config-${Date.now()}.json`, exported);
    }
    if (text.startsWith('/import')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const raw = text.replace(/^\/import\s*/, '').trim();
        if (!raw) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '用法：/import 后换行粘贴 JSON' });
        try {
            const count = await importBusinessConfig(env, raw);
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `✅ 已导入 ${count} 项配置。` });
        } catch (e) {
            return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `❌ 导入失败：${escapeHtml(e.message)}`, parse_mode: 'HTML' });
        }
    }

    if (text.startsWith('/welcome ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const val = text.replace('/welcome ', '').trim();
        await setConfig(env, 'welcome_msg', val);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 欢迎消息已更新。" });
    }
    if (text.startsWith('/brand ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const val = text.replace('/brand ', '').trim();
        await setConfig(env, 'brand_msg', /^off$/i.test(val) ? '' : val);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: /^off$/i.test(val) ? "✅ 底部品牌文案已关闭。" : "✅ 底部品牌文案已更新。" });
    }
    if (text.startsWith('/verifyqa ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const raw = text.replace('/verifyqa ', '').trim();
        const parts = raw.split(/\s*\|\s*/);
        if (parts.length < 2 || !parts[0] || !parts[1]) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '用法：/verifyqa 问题 | 答案' });
        await setConfig(env, 'verify_custom_question', parts[0]);
        await setConfig(env, 'verify_custom_answer', parts.slice(1).join('|'));
        await setConfig(env, 'verify_question_mode', 'custom_question');
        await setConfig(env, 'verify_mode', 'custom_question');
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '✅ 自定义问答已更新。' });
    }
    if (text.startsWith('/welbtn ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const raw = text.replace('/welbtn ', '').trim();
        const btns = parseButtons(raw);
        if (!btns) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 欢迎按钮格式错误。" });
        await setConfig(env, 'welcome_buttons', JSON.stringify(btns));
        await setConfig(env, 'welcome_buttons_text', raw);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 欢迎按钮已更新。" });
    }
    if (text === '/reply') {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        await deleteConfig(env, 'auto_reply_msg');
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 自动回复已关闭。" });
    }
    if (text.startsWith('/reply ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        let val = text.replace('/reply ', '').trim();
        await setConfig(env, 'auto_reply_msg', val);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 自动回复已更新。" });
    }
    // 分批广播辅助函数
    if (text.startsWith('/appeal ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const val = text.replace('/appeal ', '').trim();
        await setConfig(env, 'appeal_url', val);
        await setConfig(env, 'local_appeal_url', val);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 本地申诉链接已更新。" });
    }

    if (text === '/keywords') {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        await deleteConfig(env, 'blocked_keywords');
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 关键词已清空。" });
    }
    if (text.startsWith('/keywords ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const val = text.replace('/keywords ', '').trim();
        await setConfig(env, 'blocked_keywords', val);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 关键词已更新。" });
    }
    if (text.startsWith('/lang ')) {
        if (!(await hasPermission(env, msg.from.id, 'config'))) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: '🚫 需要 config 权限。' });
        const val = text.replace('/lang ', '').trim().toLowerCase();
        if (!['auto', 'zh', 'en'].includes(val)) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 用法：/lang auto、/lang zh 或 /lang en" });
        await setConfig(env, 'language', val);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 多语言模式已更新。" });
    }

    async function sendBroadcastBatch(env, token, chatId, broadcastMsg, offset, batchSize) {
        let cursor = undefined;
        const allKeys = [];
        while (true) {
            const res = await env.KV.list({ prefix: 'user:', cursor });
            allKeys.push(...res.keys);
            if (res.list_complete) break;
            cursor = res.cursor;
        }

        const total = allKeys.length;
        const batch = allKeys.slice(offset, offset + batchSize);

        let sent = 0, failed = 0, skipped = 0;
        const startTime = Date.now();
        const maxDuration = 25000;
        let timedOut = false;

        for (const key of batch) {
            if (Date.now() - startTime > maxDuration) {
                timedOut = true;
                break;
            }
            const uid = key.name.split(':')[1];

            // 检查用户是否被封禁
            const userData = await env.KV.get(`user:${uid}`, { type: 'json' });
            if (userData && userData.is_banned) {
                skipped++;
                continue;
            }

            try {
                const result = await tgRequest(token, 'sendMessage', { chat_id: uid, text: broadcastMsg });
                if (result.ok) sent++; else failed++;
            } catch (e) { failed++; }
            if ((sent + failed) % 25 === 0) await new Promise(r => setTimeout(r, 1000));
        }

        return { sent: offset + sent, failed, skipped, total, hasMore: offset + sent + skipped < total && !timedOut, nextOffset: offset + sent + skipped, timedOut };
    }

    if (text.startsWith('/broadcast ')) {
        const broadcastMsg = text.replace('/broadcast ', '').trim();
        if (!broadcastMsg) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 消息内容不能为空。" });

        // 保存消息到 KV
        await env.KV.put(`broadcast_msg:${chatId}`, broadcastMsg, { expirationTtl: 86400 });

        // 发送第一批
        const result = await sendBroadcastBatch(env, token, chatId, broadcastMsg, 0, 500);
        const statusIcon = result.timedOut ? '⚠️' : '✅';
        const statusText = result.timedOut ? '部分完成（超时）' : '完成';
        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `${statusIcon} <b>广播${statusText}</b>\n\n✅ 已发送：${result.sent}/${result.total}\n❌ 失败：${result.failed}${result.skipped > 0 ? `\n⏭️ 跳过（封禁）：${result.skipped}` : ''}${result.hasMore ? `\n\n继续发送：/bcontinue ${result.nextOffset}` : ''}`,
            parse_mode: 'HTML'
        });
    }
    if (text.startsWith('/bcontinue')) {
        const offset = parseInt(text.split(' ')[1]) || 0;
        const broadcastMsg = await env.KV.get(`broadcast_msg:${chatId}`);
        if (!broadcastMsg) return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "❌ 未找到广播消息，请先使用 /broadcast 开始广播" });

        const result = await sendBroadcastBatch(env, token, chatId, broadcastMsg, offset, 500);
        const statusIcon = result.timedOut ? '⚠️' : '✅';
        const statusText = result.timedOut ? '部分完成（超时）' : '完成';
        return tgRequest(token, 'sendMessage', {
            chat_id: chatId,
            text: `${statusIcon} <b>广播${statusText}</b>\n\n✅ 已发送：${result.sent}/${result.total}\n❌ 失败：${result.failed}${result.skipped > 0 ? `\n⏭️ 跳过（封禁）：${result.skipped}` : ''}${result.hasMore ? `\n\n继续发送：/bcontinue ${result.nextOffset}` : ''}`,
            parse_mode: 'HTML'
        });
    }
    if (text === '/bcancel') {
        await env.KV.delete(`broadcast_msg:${chatId}`);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 已取消广播" });
    }
    return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "🤖 发送 /menu 打开面板" });
}

// 处理群组消息 (Topic 内回复)
async function handleGroupMessage(env, msg) {
    const command = (msg.text || '').trim().split(/\s+/)[0].split('@')[0];
    const fromId = msg.from && msg.from.id;

    if ((await hasPermission(env, fromId, 'panel')) && ['/menu', '/panel'].includes(command)) {
        const menu = await generateSettingsMenu(env);
        const payload = { chat_id: msg.chat.id, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup };
        if (msg.is_topic_message && msg.message_thread_id) payload.message_thread_id = msg.message_thread_id;
        return tgRequest(env.BOT_TOKEN, 'sendMessage', payload);
    }

    if (!msg.is_topic_message || !msg.message_thread_id) return;

    // 通过 Thread ID 反查 User ID；系统 Topic 或未映射 Topic 不应转发给用户。
    const mappedUserId = await getUserIdByThread(env, msg.message_thread_id);
    if (!mappedUserId || String(mappedUserId).startsWith('system:')) return;
    const userId = String(mappedUserId);

    if (command) {
        if (command === '/ban') {
            if (!(await hasPermission(env, fromId, 'ban'))) return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🚫 需要 ban 权限。" });
            await banUserWithNotice(env, userId, '管理员在话题内封禁');
            await writeAuditLog(env, fromId, 'user.ban', userId, { source: 'topic_command' });

            return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🚫 用户已封禁。" });
        }
        if (command === '/unban') {
            if (!(await hasPermission(env, fromId, 'ban'))) return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🚫 需要 ban 权限。" });
            await unbanUser(env, userId);
            await writeAuditLog(env, fromId, 'user.unban', userId, { source: 'topic_command' });

            return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 用户已解除封禁。" });
        }
        if (command === '/note') {
            if (!(await hasPermission(env, fromId, 'reply'))) return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🚫 需要 reply 权限。" });
            const note = (msg.text || '').replace(/^\/note(@\w+)?\s*/, '').trim();
            const userData = await getUser(env, userId) || { user_id: userId, thread_id: msg.message_thread_id };
            userData.note = note;
            await upsertUser(env, userData);
            await upsertProfileCard(env, msg.chat.id, userId, userData);
            return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 备注已更新。" });
        }
        if (command === '/tag') {
            if (!(await hasPermission(env, fromId, 'reply'))) return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🚫 需要 reply 权限。" });
            const raw = (msg.text || '').replace(/^\/tag(@\w+)?\s*/, '').trim();
            const userData = await getUser(env, userId) || { user_id: userId, thread_id: msg.message_thread_id };
            userData.tags = raw.split(/[,，\s]+/).map(x => x.trim()).filter(Boolean).slice(0, 20);
            await upsertUser(env, userData);
            await upsertProfileCard(env, msg.chat.id, userId, userData);
            return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 标签已更新。" });
        }
        if (command === '/clear') {
            if (!(await hasPermission(env, fromId, 'reply'))) return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "🚫 需要 reply 权限。" });
            const userData = await getUser(env, userId) || { user_id: userId, thread_id: msg.message_thread_id };
            userData.note = '';
            await upsertUser(env, userData);
            await upsertProfileCard(env, msg.chat.id, userId, userData);
            return tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: msg.chat.id, message_thread_id: msg.message_thread_id, text: "✅ 备注已删除。" });
        }
    }
    if (!(await hasPermission(env, fromId, 'reply'))) return;
    await forwardMessage(env, env.BOT_TOKEN, userId, msg.chat.id, msg);
}

async function handlePrivateOnlyUserMessage(env, msg, userId, userData, options = {}) {
    const ownerId = env.OWNER_ID;
    const token = env.BOT_TOKEN;
    const now = Date.now();
    const info = msg.from || {};
    const next = {
        ...(userData || {}),
        user_id: String(userId),
        user_info: info,
        first_seen: (userData && userData.first_seen) || now,
        last_seen: now,
        message_count: ((userData && Number(userData.message_count)) || 0) + (!msg.text || !msg.text.startsWith('/start') ? 1 : 0),
        phone_region: (userData && userData.phone_region) || detectPhoneRegion(getMessageText(msg)),
        is_verified: true,
        is_banned: false
    };
    if (msg.text === '/start') {
        if (options.verifiedJustNow) return sendWelcomeMessage(env, userId, { includeBrand: true });
        return sendAlreadyVerifiedMessage(env, userId);
    }
    if (isUserCommandMessage(msg)) return tgRequest(token, 'sendMessage', { chat_id: userId, text: 'ℹ️ 这是机器人指令，不会转发给管理员。请直接发送你要咨询的内容。' });
    if (!ownerId) return tgRequest(token, 'sendMessage', { chat_id: userId, text: t(await getLang(env, msg), 'not_bound') });
    await sendUserForwardFeedback(env, userId);
    runBackground(options.ctx, async () => {
        await upsertUser(env, next);
        if (options.verifiedJustNow) await sendWelcomeMessage(env, userId, { includeBrand: true });
        const userButton = getUserLinkButton(userId, info);
        const forwarded = await forwardMessage(env, token, ownerId, userId, msg, null, { reply_markup: { inline_keyboard: [[userButton]] } });
        if (forwarded && !forwarded.ok) return tgRequest(token, 'sendMessage', { chat_id: userId, text: `⚠️ 消息发送失败：${forwarded.description || 'Unknown error'}` });
        await sendUserIdentityCard(env, ownerId, null, userId, info, '📩 新私聊消息');
        await maybeTranslateToChinese(env, ownerId, null, msg);
    });
    return { ok: true };
}

// 用户私聊核心逻辑
async function handleUserPrivateMessage(env, groupId, msg, ctx = null) {
    const userId = String(msg.from.id);
    const token = env.BOT_TOKEN;
    const lang = await getLang(env, msg);

    // 1. 读取用户数据（D1 优先，KV 兼容）
    let userData = await getUser(env, userId);

    // 验证码刷新入口必须早于本地封禁检查，封禁用户重验也要能回跳。
    if (msg.text && msg.text.startsWith('/start refresh_')) {
        const refreshSettings = await getVerifySettings(env);
        const unionEnabled = await getUnionBanEnabled(env);
        if (shouldRunCaptcha(refreshSettings, unionEnabled)) return handleUnionRefresh(env, groupId, msg, userId, token);
    }

    const reverifyPendingBeforeBan = await env.KV.get(`reverify_pending:${userId}`, { type: 'json' });
    const questionPendingBeforeBan = await env.KV.get(`verify_pending:${userId}`, { type: 'json' });
    if (reverifyPendingBeforeBan && questionPendingBeforeBan) {
        return handleLocalVerification(env, groupId, msg, userId, token, questionPendingBeforeBan.type);
    }

    // 本地封禁检查
    if (userData && userData.is_banned) {
        const appealUrl = await getLocalAppealUrl(env);
        if (msg.text === '/start') await createBlacklistCard(env, userId, '已封禁用户重新进入', appealUrl);
        await upsertVerifySession(env, userId, 'banned_reentry', 'appeal_or_reverify', 0, 3600);
        if (await env.KV.get(`appeal_reason_pending:${userId}`) && msg.text && !msg.text.startsWith('/')) {
            return submitLocalAppeal(env, userId, msg.from, msg.text);
        }
        const keyboard = [[{ text: '📨 本地申诉（填写理由）', callback_data: `appeal:${userId}` }], [{ text: '🔁 重新验证', callback_data: `reverify:${userId}` }]];
        if (appealUrl) keyboard.push([{ text: '🔗 本地申诉链接', url: appealUrl }]);
        return tgRequest(token, 'sendMessage', {
            chat_id: userId,
            text: `${t(lang, 'banned')}\n\n你可以点击下方按钮提交本地申诉，申诉时需要填写理由。`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: keyboard },
        });
    }

    // 2. 读取联合封禁配置（内存缓存 → KV）
    let isUnionBanEnabled = await getUnionBanEnabled(env);

    // 3. 联合封禁检查（内存缓存 → KV 缓存 → 远程 API）
    if (isUnionBanEnabled) {
        const gbanKey = `gban:${userId}`;
        let gbanStatus = memGet(gbanKey);
        if (gbanStatus === undefined) {
            gbanStatus = await env.KV.get(gbanKey);
            if (gbanStatus === null) {
                const remoteCheck = await callCentralApi('/check_ban', { user_id: String(userId) });
                gbanStatus = (remoteCheck && remoteCheck.banned) ? "true" : "false";
                await env.KV.put(gbanKey, gbanStatus, { expirationTtl: CACHE_TTL_BAN_CHECK });
            }
            memSet(gbanKey, gbanStatus);
        }
        if (gbanStatus === "true") {
            const unionAppealUrl = await getUnionAppealUrl(env);
            return tgRequest(token, 'sendMessage', {
                chat_id: userId,
                text: `🚫 <b>您已被联合封禁。</b>\n这是外部联合封禁服务，不是 NooMiChat 本地黑名单。\n\n如需申诉，请使用联合封禁申诉入口。`,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: { inline_keyboard: [[{ text: '🔗 联合封禁申诉', url: unionAppealUrl }]] }
            });
        }
    }

    // 刷新 verify cache
    if (msg.text && msg.text.startsWith('/start refresh_') && isUnionBanEnabled) {
        return handleUnionRefresh(env, groupId, msg, userId, token);
    }

    const verifySettings = await getVerifySettings(env);
    if (userData && (userData.thread_id || userData.is_verified) && await shouldReverifyInactive(env, userData, verifySettings, isUnionBanEnabled)) {
        await discardVerificationMessage(env, userId);
        await env.KV.put(`reverify_pending:${userId}`, JSON.stringify({ thread_id: userData.thread_id || null, reason: 'inactive', last_seen: userData.last_seen || 0 }), { expirationTtl: 1800 });
        await upsertVerifySession(env, userId, 'inactive_reverify', 'started', 0, 600);
        await tgRequest(token, 'sendMessage', { chat_id: userId, text: `🔒 会话验证已过期\n\n你已超过 ${formatInactiveHours(await getVerifyInactiveHours(env))} 未发送消息，需要重新验证后再继续。\n\n为了安全，刚才这条消息不会保存或转发；验证通过后请重新发送。` });
        if (shouldRunCaptcha(verifySettings, isUnionBanEnabled)) return startCaptchaVerification(env, groupId, msg, userId, token, verifySettings, isUnionBanEnabled);
        return handleLocalVerification(env, groupId, msg, userId, token, verifySettings.questionMode);
    }

    // 已验证用户：支持有群 Topic，也支持无群直接转发给主人
    const isVerified = userData && (userData.thread_id || userData.is_verified);
    if (isVerified) {
        if (msg.text === '/start') return sendAlreadyVerifiedMessage(env, userId);
        if (isUserCommandMessage(msg)) return tgRequest(token, 'sendMessage', { chat_id: userId, text: 'ℹ️ 这是机器人指令，不会转发给管理员。请直接发送你要咨询的内容。' });

        const spamCheck = await checkAntiSpam(env, groupId, msg, userData);
        if (!spamCheck.ok) return tgRequest(token, 'sendMessage', { chat_id: userId, text: t(lang, spamCheck.messageKey), parse_mode: 'HTML' });

        if (await maybeSendRestNotice(env, userId)) return;

        if (!msg.media_group_id) {
            let autoReplyMsg = memGet('config:auto_reply_msg');
            if (autoReplyMsg === undefined) {
                autoReplyMsg = await getConfig(env, 'auto_reply_msg');
                memSet('config:auto_reply_msg', autoReplyMsg);
            }
            if (autoReplyMsg) {
                const replyKey = `last_reply:${userId}`;
                if (!(await env.KV.get(replyKey))) {
                    await tgRequest(token, 'sendMessage', { chat_id: userId, text: autoReplyMsg });
                    await env.KV.put(replyKey, '1', { expirationTtl: 600 });
                }
            }
        }

        const targetId = groupId || env.OWNER_ID;
        if (!targetId) return tgRequest(token, 'sendMessage', { chat_id: userId, text: t(lang, 'not_bound') });
        await sendUserForwardFeedback(env, userId);
        runBackground(ctx, async () => {
            if (groupId && !userData.thread_id) return initializeUser(env, groupId, msg, userId, token, { ctx });
            const nextUserData = await syncUserActivity(env, groupId, userId, msg, userData);
            if (!groupId) await sendUserIdentityCard(env, targetId, null, userId, msg.from || {}, '📨 来自用户');
            const userButton = getUserLinkButton(userId, msg.from || {});
            const forwarded = await forwardMessage(env, token, targetId, userId, msg, groupId ? nextUserData.thread_id : null, { reply_markup: { inline_keyboard: [[userButton]] } });
            if (forwarded && forwarded.ok === false) return tgRequest(token, 'sendMessage', { chat_id: userId, text: `⚠️ 消息发送失败：${forwarded.description || 'Unknown error'}` });
            if (groupId && nextUserData.thread_id) await maybeTranslateToChinese(env, groupId, nextUserData.thread_id, msg);
            if (!groupId) await maybeTranslateToChinese(env, targetId, null, msg);
        });
        return { ok: true };
    }
    // 新用户验证：支持验证码、问答、验证码+问答组合
    const captchaPassedKey = `verify_captcha_passed:${userId}`;
    const captchaPassed = env.KV ? await env.KV.get(captchaPassedKey) : null;
    if (shouldRunQuestion(verifySettings) && (!shouldRunCaptcha(verifySettings, isUnionBanEnabled) || captchaPassed === '1')) {
        if (captchaPassed === '1' && env.KV) await env.KV.delete(captchaPassedKey);
        return handleLocalVerification(env, groupId, msg, userId, token, verifySettings.questionMode);
    }
    if (shouldRunCaptcha(verifySettings, isUnionBanEnabled)) {
        return startCaptchaVerification(env, groupId, msg, userId, token, verifySettings, isUnionBanEnabled);
    } else {
        if (!shouldRunQuestion(verifySettings)) {
            if (!groupId) return handlePrivateOnlyUserMessage(env, msg, userId, userData, { ctx });
            await sendUserForwardFeedback(env, userId);
            runBackground(ctx, () => initializeUser(env, groupId, msg, userId, token, { ctx }));
            return { ok: true };
        }
        return handleLocalVerification(env, groupId, msg, userId, token, verifySettings.questionMode);
    }
}

async function startCaptchaVerification(env, groupId, msg, userId, token, verifySettings, isUnionBanEnabled) {
    const botUsername = memGet('config:bot_username') || await getConfig(env, 'bot_username', 'Bot');
    memSet('config:bot_username', botUsername);
    const payloadObj = { uid: userId, bot: botUsername, ts: Date.now(), provider: verifySettings.captchaMode, combo: verifySettings.comboMode };
    const payload = btoa(JSON.stringify(payloadObj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const webAppUrl = `https://t.me/${CENTRAL_BOT_USERNAME}/${CENTRAL_WEBAPP_NAME}?startapp=${payload}`;
    const providerName = verifySettings.captchaMode === 'cloudflare_turnstile' ? 'Cloudflare Turnstile' : 'Google reCAPTCHA';
    const questionTip = shouldRunQuestion(verifySettings) ? '\n\n完成验证码后还需要继续回答本地问题。' : '';
    await discardVerificationMessage(env, userId);
    await upsertVerifySession(env, userId, verifySettings.captchaMode || 'captcha', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 600);
    return tgRequest(token, 'sendMessage', {
        chat_id: userId,
        text: `🔒 <b>安全验证</b>\n\n验证前发送的消息不会保存或转发，验证通过后请重新发送。\n\n本机器人已开启 ${providerName} 验证，请点击下方按钮验证身份。${questionTip}\n\n请在 10 分钟内完成验证并返回。`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: "👉 点击验证 (Click to Verify)", url: webAppUrl }]] }
    });
}

async function handleUnionRefresh(env, groupId, msg, userId, token) {
    // 强制清除 KV 缓存 + 内存缓存
    await env.KV.delete(`gban:${userId}`);
    memDelete(`gban:${userId}`);
    console.log(`[UnionRefresh] Cleared ban cache for user ${userId}`);

    const payload = { user_id: String(userId) };
    const checkRes = await callCentralApi('/check_verify_temp', payload);

    if (!checkRes) return tgRequest(token, 'sendMessage', { chat_id: userId, text: "❌ 网络错误" });

    if (checkRes.verified) {
        const settings = await getVerifySettings(env);
        if (shouldRunQuestion(settings)) {
            await env.KV.put(`verify_captcha_passed:${userId}`, '1', { expirationTtl: 600 });
            await tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 验证码通过，请继续完成问答验证。" });
            return handleLocalVerification(env, groupId, { ...msg, text: '/start' }, userId, token, settings.questionMode);
        }
        const reverifyPending = await env.KV.get(`reverify_pending:${userId}`, { type: 'json' });
        if (reverifyPending) {
            await env.KV.delete(`reverify_pending:${userId}`);
            if (reverifyPending.reason === 'inactive') {
                await markUserVerificationPassed(env, userId, msg);
                await env.KV.delete(`verify_original:${userId}`);
                return tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 验证已恢复。刚才那条消息不会保存或转发，请重新发送。" });
            }
            await unbanUser(env, userId);
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 重新验证通过，您可以继续聊天。" });
        }
        return finishInitialVerification(env, userId, msg, token);
    } else {
        let debugText = "❌ 验证状态已过期。请发送 /start 重新验证。";
        if (checkRes.debug_info) {
            debugText += `\n\nDebug: Q=${checkRes.debug_info.key} Found=${checkRes.debug_info.timestamp}`;
        }
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: debugText });
    }
}

async function handleLocalVerification(env, groupId, msg, userId, token, mode) {
    const tempKey = `verify_pending:${userId}`;
    const pendingState = await env.KV.get(tempKey, { type: 'json' });

    if (!pendingState) {
        await discardVerificationMessage(env, userId);
        return startQuestionVerification(env, groupId, msg, userId, token, mode);
    }

    if (pendingState) {
        let passed = false;
        if (pendingState.type === 'sticker' && (msg.sticker || isEmojiOnlyText(msg.text))) passed = true;
        else if (pendingState.type === 'math' && msg.text && parseInt(msg.text) === pendingState.ans) passed = true;
        else if (pendingState.type === 'custom_question' && msg.text && msg.text.trim().toLowerCase() === pendingState.ans) passed = true;
        if (pendingState.type === 'button_math' || pendingState.type === 'image_digit') return;

        if (passed) {
            return completeQuestionVerification(env, groupId, msg, userId, token, pendingState);
        } else {
            await env.KV.delete(tempKey);
            await env.KV.delete(`verify_original:${userId}`);
            const failCount = await recordVerifyFail(env, userId);
            const limit = await getVerifyFailLimit(env);
            if (failCount >= limit) return banUserWithNotice(env, userId, `验证失败 ${failCount}/${limit}`);
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: `❌ 验证失败，请发送 /start 重试。剩余次数：${limit - failCount}` });
        }
    }
}

async function initializeUser(env, groupId, msg, userId, token, options = {}) {
    if (!groupId) return handlePrivateOnlyUserMessage(env, msg, userId, await getUser(env, userId), options);

    try {
        // 创建 Topic
        const name = `${msg.from.first_name}`.trim().slice(0, 128) || `User ${userId}`;
        const newTopic = await tgRequest(token, 'createForumTopic', { chat_id: groupId, name: name });

        if (!newTopic.ok) {
            throw new Error(newTopic.description);
        }

        const threadId = newTopic.result.message_thread_id;

        // 保存映射关系到 KV
        // 1. User -> Thread + Info
        const userData = {
            user_id: String(userId),
            thread_id: threadId,
            is_verified: true,
            is_banned: false,
            user_info: msg.from,
            first_seen: Date.now(),
            last_seen: Date.now(),
            message_count: (!msg.text || !msg.text.startsWith('/start')) ? 1 : 0,
            phone_region: detectPhoneRegion(getMessageText(msg)),
            topic_title: name
        };
        await upsertUser(env, userData);
        await env.KV.put(`user:${userId}`, JSON.stringify(userData));

        // 2. Thread -> User (用于快速反查)
        await env.KV.put(`thread:${threadId}`, String(userId));

        // 新用户通知
        const firstName = escapeHtml(msg.from.first_name || '');
        const lastName = escapeHtml(msg.from.last_name || '');
        const fullName = (firstName + ' ' + lastName).trim() || 'No Name';
        const uidLink = `tg://user?id=${userId}`;
        const username = msg.from.username ? `@${escapeHtml(msg.from.username)}` : 'None';

        const infoMsg = `👤 <b>新用户接入</b>\n\n` +
            `🔸 名称：<a href="${uidLink}">${fullName}</a>\n` +
            `🆔 UID：${userId}\n` +
            `💫 用户名：${username}`;

        await tgRequest(token, 'sendMessage', { chat_id: groupId, message_thread_id: threadId, text: infoMsg, parse_mode: 'HTML' });
        await upsertProfileCard(env, groupId, userId, userData);
        await sendWelcomeMessage(env, userId, { includeBrand: !!options.verifiedJustNow });

        if (isUserCommandMessage(msg)) {
            await tgRequest(token, 'sendMessage', { chat_id: userId, text: 'ℹ️ 这是机器人指令，不会转发给管理员。请直接发送你要咨询的内容。' });
        } else if (!msg.text || !msg.text.startsWith('/start')) {
            await upsertInboxCard(env, groupId, userId, userData, msg);
            const userButton = getUserLinkButton(userId, msg.from || {});
            await forwardMessage(env, token, groupId, userId, msg, threadId, { reply_markup: { inline_keyboard: [[userButton]] } });
            await sendUserForwardFeedback(env, userId);
            runBackground(options.ctx, () => maybeTranslateToChinese(env, groupId, threadId, msg));
        }
    } catch (e) {
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: "Error: " + e.message });
    }
}










