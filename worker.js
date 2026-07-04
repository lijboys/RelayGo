/**
 * RelayGo - 新一代 Telegram 私聊机器人
 * 项目地址: https://github.com/abcxyz-123456/RelayGo
 * 版本: 2.0 (Standalone)
 * 官方频道：https://t.me/RelayGo
 * 当前版本可能仍不稳定，如遇到 BUG 请提交至 issues
 */

// 中心化服务配置，非必要请勿修改
const CENTRAL_API_URL = "https://verify.wzxabc.eu.org";
const CENTRAL_BOT_USERNAME = "RelayVerifyBot";
const CENTRAL_WEBAPP_NAME = "verify";
const FIXED_BRAND_MSG = "🔥 基于 @RelayGo 开源项目构建";
const CACHE_TTL_BAN_CHECK = 3600 * 24;     // 全局封禁状态缓存24小时

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

const D1_TABLES_SQL = [
    `CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, data TEXT, thread_id INTEGER, is_banned INTEGER DEFAULT 0, first_seen INTEGER, last_seen INTEGER, message_count INTEGER DEFAULT 0, note TEXT, tags TEXT, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS topics (thread_id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, status TEXT DEFAULT 'active', updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS admins (user_id TEXT PRIMARY KEY, permissions TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS verify_sessions (user_id TEXT PRIMARY KEY, mode TEXT, state TEXT, fail_count INTEGER DEFAULT 0, expires_at INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS blacklist (user_id TEXT PRIMARY KEY, reason TEXT, appeal_url TEXT, card_message_id INTEGER, created_at INTEGER NOT NULL, lifted_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS inbox_cards (user_id TEXT PRIMARY KEY, message_id INTEGER, thread_id INTEGER, last_message_at INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS profile_cards (user_id TEXT PRIMARY KEY, message_id INTEGER, thread_id INTEGER, updated_at INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, detail TEXT, created_at INTEGER NOT NULL)`
];
const ALL_PERMISSIONS = ['reply', 'panel', 'ban', 'config'];

function getD1(env) { return env.DB || env.D1 || env.DATABASE || env.RELAYGO_DB || null; }
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
    const db = getD1(env);
    if (!db) return null;
    await ensureD1Schema(env);
    const row = await db.prepare('SELECT permissions FROM admins WHERE user_id = ?').bind(String(userId)).first();
    if (!row) return null;
    return { user_id: String(userId), permissions: JSON.parse(row.permissions || '[]'), is_owner: false };
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
    return finalPerms;
}
async function removeAdmin(env, userId) {
    if (String(userId) === String(env.OWNER_ID)) throw new Error('OWNER_ID cannot be removed');
    const db = getD1(env);
    if (!db) throw new Error('D1 binding is required to store co-admins');
    await ensureD1Schema(env);
    await db.prepare('DELETE FROM admins WHERE user_id = ?').bind(String(userId)).run();
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
async function sendWelcomeMessage(env, userId) {
    const welcomeMsg = await getConfig(env, 'welcome_msg', "👋 欢迎使用本机器人！");
    let welcomeText = welcomeMsg;
    welcomeText += `\n\n${FIXED_BRAND_MSG}`;

    const payload = { chat_id: userId, text: welcomeText, disable_web_page_preview: true };
    const buttonsJson = await getConfig(env, 'welcome_buttons');
    if (buttonsJson) {
        try { payload.reply_markup = { inline_keyboard: JSON.parse(buttonsJson) }; } catch (e) { }
    }
    await tgRequest(env.BOT_TOKEN, 'sendMessage', payload);
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
    const webhook = await tgRequest(env.BOT_TOKEN, 'getWebhookInfo', {});
    const menu = await generateSettingsMenu(env);
    const admins = await listAdmins(env);
    const verifyQuestionMode = await getConfig(env, 'verify_question_mode', await getConfig(env, 'verify_mode', 'off'));
    const settings = {
        worker_url: getBaseUrl(request),
        webhook_url: `${getBaseUrl(request)}/webhook`,
        group_id: await getConfig(env, 'group_id', ''),
        business_status: await getConfig(env, 'business_status', 'open'),
        ai_translate: await getConfig(env, 'ai_translate', '0'),
        union_ban: await getConfig(env, 'union_ban', '0'),
        verify_captcha_mode: await getConfig(env, 'verify_captcha_mode', 'off'),
        verify_question_mode: verifyQuestionMode,
        verify_combo_mode: await getConfig(env, 'verify_combo_mode', 'question_only'),
        verify_fail_limit: await getConfig(env, 'verify_fail_limit', '2'),
        appeal_url: await getAppealUrl(env),
        welcome_msg: await getConfig(env, 'welcome_msg', ''),
        auto_reply_msg: await getConfig(env, 'auto_reply_msg', ''),
        business_rest_message: await getConfig(env, 'business_rest_message', '⏸ 当前为休息中，管理员稍后会回复您。'),
        business_rest_cooldown: await getConfig(env, 'business_rest_cooldown', '600')
    };
    return { ok: true, status: 'running', version: '1.1.6 (Standalone)', settings, admins, telegram_webhook: webhook, telegram_panel: menu.text };
}

async function handleWebAdminApi(request, env) {
    if (!requireWebAdmin(request, env)) return errorResponse('Unauthorized', 401);
    const url = new URL(request.url);
    if (url.pathname === '/api/status') return jsonResponse(await getWebAdminState(env, request));
    if (url.pathname === '/api/webhook/set' && request.method === 'POST') return jsonResponse(await setWebhookToCurrentWorker(env, request));
    if (url.pathname === '/api/commands/set' && request.method === 'POST') return jsonResponse(await setupBotCommands(env));
    if (url.pathname === '/api/config' && request.method === 'POST') {
        const body = await request.json();
        const allowed = new Set(['business_status', 'business_rest_message', 'business_rest_cooldown', 'ai_translate', 'union_ban', 'verify_captcha_mode', 'verify_question_mode', 'verify_combo_mode', 'verify_fail_limit', 'appeal_url', 'welcome_msg', 'auto_reply_msg']);
        const keys = [];
        for (const [key, value] of Object.entries(body || {})) {
            if (allowed.has(key)) {
                await setConfig(env, key, value);
                keys.push(key);
            }
        }
        await writeAuditLog(env, 'web_admin', 'config.update', '', { keys });
        return jsonResponse({ ok: true, state: await getWebAdminState(env, request) });
    }
    return errorResponse('Not found', 404);
}

function renderWebAdminPage() {
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RelayGo 后台</title><style>:root{color-scheme:dark light;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0f172a;color:#e5e7eb}body{margin:0;background:radial-gradient(circle at top,#1d4ed8 0,#0f172a 36rem);min-height:100vh}.wrap{max-width:1120px;margin:0 auto;padding:32px 18px 56px}.hero{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:22px}.card{background:rgba(15,23,42,.78);border:1px solid rgba(148,163,184,.25);border-radius:18px;padding:18px;box-shadow:0 20px 60px rgba(0,0,0,.28);backdrop-filter:blur(16px)}h1{margin:0 0 8px;font-size:32px}.muted{color:#94a3b8}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.full{grid-column:1/-1}label{display:block;margin:12px 0 6px;color:#cbd5e1;font-size:14px}input,select,textarea{box-sizing:border-box;width:100%;border:1px solid rgba(148,163,184,.35);background:#020617;color:#e5e7eb;border-radius:12px;padding:11px 12px;font:inherit}textarea{min-height:86px;resize:vertical}button{border:0;border-radius:12px;padding:11px 14px;background:#2563eb;color:white;font-weight:700;cursor:pointer;margin:6px 8px 6px 0}button.secondary{background:#334155}button.good{background:#16a34a}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.pill{display:inline-flex;padding:5px 9px;border-radius:999px;background:#1e293b;border:1px solid rgba(148,163,184,.25);font-size:12px}.ok{color:#86efac}.bad{color:#fca5a5}pre{white-space:pre-wrap;word-break:break-word;background:#020617;border-radius:12px;padding:12px;max-height:280px;overflow:auto}.toast{position:fixed;right:18px;bottom:18px;background:#111827;border:1px solid #334155;border-radius:14px;padding:12px 14px;display:none}@media(max-width:760px){.grid{grid-template-columns:1fr}.hero{display:block}}</style></head><body><div class="wrap"><div class="hero"><div><h1>RelayGo 后台</h1><div class="muted">网页管理、Webhook 一键配置、基础开关设置</div></div><div class="card"><div class="muted">认证密钥</div><input id="adminKey" type="password" placeholder="ADMIN_KEY / OWNER_ID"><button onclick="saveKey()">保存并刷新</button></div></div><div class="grid"><section class="card"><h2>部署状态</h2><div id="status" class="muted">等待加载...</div><div class="row"><button class="good" onclick="setWebhook()">一键设置 Webhook + 菜单</button><button class="secondary" onclick="setCommands()">只设置 TG 菜单</button><button class="secondary" onclick="loadState()">刷新状态</button></div><pre id="webhookInfo"></pre></section><section class="card"><h2>快捷入口</h2><p class="muted">如果按钮无效，先确认 Webhook 指向当前 Worker。</p><div class="row"><a id="openWebhook" target="_blank"><button class="secondary">打开 Webhook 地址</button></a></div><pre id="workerInfo"></pre></section><section class="card"><h2>运行开关</h2><label>营业状态</label><select id="business_status"><option value="open">营业中</option><option value="rest">休息中</option></select><label>休息提示</label><textarea id="business_rest_message"></textarea><label>休息冷却秒数</label><input id="business_rest_cooldown" type="number" min="60"><label>AI 翻译</label><select id="ai_translate"><option value="0">关闭</option><option value="1">开启</option></select><label>联盟封禁</label><select id="union_ban"><option value="0">关闭</option><option value="1">开启</option></select><button onclick="saveConfig()">保存开关</button></section><section class="card"><h2>验证系统</h2><label>验证码模式</label><select id="verify_captcha_mode"><option value="off">关闭</option><option value="cloudflare_turnstile">Cloudflare Turnstile</option><option value="google_recaptcha">Google reCAPTCHA</option></select><label>问答模式</label><select id="verify_question_mode"><option value="off">关闭</option><option value="math">数学题</option><option value="button_math">算术按钮</option><option value="image_digit">图片数字</option><option value="custom_question">自定义问答</option></select><label>组合模式</label><select id="verify_combo_mode"><option value="captcha_only">只验证码</option><option value="question_only">只问答</option><option value="captcha_question">验证码 + 问答</option></select><label>失败封禁次数</label><input id="verify_fail_limit" type="number" min="1" max="9"><label>申诉链接</label><input id="appeal_url"><button onclick="saveConfig()">保存验证</button></section><section class="card full"><h2>消息配置</h2><label>欢迎语</label><textarea id="welcome_msg"></textarea><label>自动回复</label><textarea id="auto_reply_msg"></textarea><button onclick="saveConfig()">保存消息配置</button></section><section class="card full"><h2>协管列表</h2><pre id="admins"></pre><p class="muted">添加/删除协管暂时仍建议在 Telegram 私聊发送 /addadmin 和 /deladmin，避免网页误操作。</p></section></div></div><div id="toast" class="toast"></div><script>let state=null;const $=id=>document.getElementById(id);$('adminKey').value=localStorage.getItem('relaygo_admin_key')||'';function toast(msg){const el=$('toast');el.textContent=msg;el.style.display='block';setTimeout(()=>el.style.display='none',2600)}function saveKey(){localStorage.setItem('relaygo_admin_key',$('adminKey').value.trim());loadState()}async function api(path,opt={}){const key=$('adminKey').value.trim();const res=await fetch(path,{...opt,headers:{'content-type':'application/json','x-admin-key':key,...(opt.headers||{})}});const data=await res.json().catch(()=>({error:'Invalid JSON'}));if(!res.ok)throw new Error(data.error||res.statusText);return data}function fill(s){state=s;const cfg=s.settings;$('status').innerHTML='<span class="pill ok">Worker running</span> '+(s.version||'');$('workerInfo').textContent='Worker: '+cfg.worker_url+'\nWebhook: '+cfg.webhook_url+'\nGroup ID: '+(cfg.group_id||'未绑定');$('webhookInfo').textContent=JSON.stringify(s.telegram_webhook,null,2);$('openWebhook').href=cfg.webhook_url;for(const k of Object.keys(cfg)){if($(k))$(k).value=cfg[k]??''}$('admins').textContent=(s.admins||[]).map(a=>a.user_id+' ['+(a.is_owner?'OWNER':'ADMIN')+'] '+a.permissions.join(',')).join('\n')||'暂无协管'}async function loadState(){try{fill(await api('/api/status'));toast('已刷新')}catch(e){$('status').innerHTML='<span class="bad">'+e.message+'</span>';toast(e.message)}}async function setWebhook(){try{const r=await api('/api/webhook/set',{method:'POST',body:'{}'});toast(r.telegram&&r.telegram.ok?'Webhook 已设置':'设置失败');loadState()}catch(e){toast(e.message)}}async function setCommands(){try{const r=await api('/api/commands/set',{method:'POST',body:'{}'});toast(r.ok?'菜单已设置':'设置失败')}catch(e){toast(e.message)}}async function saveConfig(){const keys=['business_status','business_rest_message','business_rest_cooldown','ai_translate','union_ban','verify_captcha_mode','verify_question_mode','verify_combo_mode','verify_fail_limit','appeal_url','welcome_msg','auto_reply_msg'];const body={};for(const k of keys)body[k]=$(k).value;try{const r=await api('/api/config',{method:'POST',body:JSON.stringify(body)});fill(r.state);toast('配置已保存')}catch(e){toast(e.message)}}if($('adminKey').value)loadState();else $('status').textContent='请输入 ADMIN_KEY 后加载。';</script></body></html>`;
}
// 主入口
export default {
    async fetch(request, env, ctx) {
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
                const update = await request.json();
                ctx.waitUntil(handleUpdate(env, update, ctx));
                return jsonResponse({ ok: true });
            }
            return jsonResponse({ status: 'running', version: '1.1.6 (Standalone)', admin: `${url.origin}/admin`, webhook: `${url.origin}/webhook` });
        } catch (e) {
            ctx.waitUntil(reportError(env, e, "Main Fetch Loop"));
            return errorResponse(e.message);
        }
    }
};

// 核心逻辑
async function handleUpdate(env, update, ctx) {
    const token = env.BOT_TOKEN;
    await ensureD1Schema(env);

    // 1. 处理回调查询
    if (update.callback_query) {
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
        if (await hasPermission(env, currentUserId, 'panel')) {
            return handleOwnerMenu(env, update.message, ctx);
        }
        return handleUserPrivateMessage(env, groupId, update.message);
    }
}

// 转发消息（支持媒体组相册）
const mediaGroupBuffers = new Map();

async function forwardMessage(env, token, targetChatId, fromChatId, msg, threadId = null) {
    if (!msg.media_group_id) {
        const payload = { chat_id: targetChatId, from_chat_id: fromChatId, message_id: msg.message_id };
        if (threadId) payload.message_thread_id = threadId;
        return tgRequest(token, 'copyMessage', payload);
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
        return tgRequest(buffer.token, 'copyMessages', payload);
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
    const keys = ['config:antispam','config:antispam_link','config:antispam_media','config:antispam_keyword','config:antispam_autoban'];
    const values = await Promise.all(keys.map(k => env.KV.get(k)));
    return { enabled: isEnabled(values[0], true), blockLinks: isEnabled(values[1], true), blockMedia: isEnabled(values[2], true), blockKeywords: isEnabled(values[3], true), autoBan: isEnabled(values[4], false), windowShort: 10, limitShort: 5, windowLong: 60, limitLong: 15, cooldown: 300, newUserMaxMedia: 3 };
}

async function tgFormRequest(token, method, formData) {
    const url = `https://api.telegram.org/bot${token}/${method}`;
    try {
        const resp = await fetch(url, { method: 'POST', body: formData });
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
    await env.KV.put(`spam:last:${userId}`, JSON.stringify(msg), { expirationTtl: 1800 });
    const name = escapeHtml(`${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() || 'Unknown');
    const username = msg.from.username ? `@${escapeHtml(msg.from.username)}` : 'None';
    const preview = escapeHtml(getMessageText(msg).slice(0, 500) || '[非文本消息]');
    const payload = { chat_id: targetChatId, text: `🛡 <b>防骚扰拦截</b>\n\n原因：${escapeHtml(reason)}\n用户：<a href="tg://user?id=${userId}">${name}</a>\nUID：<code>${userId}</code>\n用户名：${username}\n\n内容：\n<pre>${preview}</pre>`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '✅ 放行', callback_data: `spam_allow:${userId}` }, { text: '🚫 封禁', callback_data: `spam_ban:${userId}` }], [{ text: '⭐ 加白名单', callback_data: `spam_trust:${userId}` }]] } };
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
function makeDigitSvg(digit) {
    const noise = Array.from({ length: 8 }, () => `<line x1="${randomInt(0, 160)}" y1="${randomInt(0, 80)}" x2="${randomInt(0, 160)}" y2="${randomInt(0, 80)}" stroke="rgba(80,80,80,.35)" stroke-width="1"/>`).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80" viewBox="0 0 160 80"><rect width="160" height="80" fill="#f5f7fb"/><g transform="translate(80 48) rotate(${randomInt(-15, 15)})"><text text-anchor="middle" font-size="48" font-family="Arial, sans-serif" font-weight="700" fill="#1f2937">${digit}</text></g>${noise}<circle cx="${randomInt(15,145)}" cy="${randomInt(10,70)}" r="3" fill="#60a5fa" opacity=".5"/></svg>`;
}
function svgDataUrl(svg) { return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg))); }
async function getVerifyFailLimit(env) { return Math.max(1, Math.min(9, parseInt(await getConfig(env, 'verify_fail_limit', '2'), 10) || 2)); }
async function getAppealUrl(env) { return await getConfig(env, 'appeal_url', 'https://t.me/RelayGo/24'); }
async function getVerifySettings(env) {
    const legacyMode = await getConfig(env, 'verify_mode', 'off');
    const captchaMode = await getConfig(env, 'verify_captcha_mode', 'off');
    const questionMode = await getConfig(env, 'verify_question_mode', legacyMode === 'off' ? 'off' : legacyMode);
    const comboMode = await getConfig(env, 'verify_combo_mode', captchaMode !== 'off' && questionMode !== 'off' ? 'captcha_question' : (captchaMode !== 'off' ? 'captcha_only' : 'question_only'));
    return { captchaMode, questionMode, comboMode, legacyMode };
}
function shouldRunCaptcha(settings, unionBanEnabled) { return unionBanEnabled || ['cloudflare_turnstile', 'google_recaptcha'].includes(settings.captchaMode); }
function shouldRunQuestion(settings) { return settings.questionMode && settings.questionMode !== 'off' && settings.comboMode !== 'captcha_only'; }
async function banUserWithNotice(env, userId, reason = '验证失败') {
    await banUser(env, userId);
    const appealUrl = await getAppealUrl(env);
    await createBlacklistCard(env, userId, reason, appealUrl);
    const groupId = await getConfig(env, 'group_id');
    const userData = await getUser(env, userId);
    if (groupId && userData) await upsertProfileCard(env, groupId, userId, userData);
    await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: userId, text: `❌ 您已被封禁。\n原因：${reason}\n如需申诉：${appealUrl}`, disable_web_page_preview: true });
    if (env.OWNER_ID) await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: env.OWNER_ID, text: `🚫 用户被封禁\nUID：${userId}\n原因：${reason}` });
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
    const threadId = await ensureSystemTopic(env, groupId, 'blacklist_thread_id', '🚫 黑名单');
    if (!groupId || !threadId) return;
    const userData = await getUser(env, userId) || {};
    const text = `🚫 <b>黑名单用户</b>\n\n用户：<a href="tg://user?id=${userId}">${formatUserName(userData.user_info)}</a>\nUID：<code>${userId}</code>\n原因：${escapeHtml(reason)}\n申诉：${escapeHtml(appealUrl)}`;
    const sent = await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: groupId, message_thread_id: threadId, text, parse_mode: 'HTML' });
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
async function maybeTranslateToChinese(env, groupId, threadId, msg) {
    if ((await getConfig(env, 'ai_translate', '0')) !== '1') return;
    const text = getMessageText(msg).trim();
    if (!text || isProbablyChinese(text) || !env.AI) return;
    try {
        const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [
                { role: 'system', content: 'Translate the user message into concise Simplified Chinese. Return only the translation.' },
                { role: 'user', content: text.slice(0, 3000) }
            ]
        });
        const translated = (response && (response.response || response.result || response.text)) || '';
        if (translated.trim()) await tgRequest(env.BOT_TOKEN, 'sendMessage', { chat_id: groupId, message_thread_id: threadId, text: `🌐 <b>中文翻译</b>\n\n${escapeHtml(translated.trim())}`, parse_mode: 'HTML' });
    } catch (e) {
        console.error('AI translate failed:', e && e.message);
    }
}
function buildBusinessExport(configs) {
    const excluded = new Set(['bot_token', 'owner_id', 'd1', 'db', 'database', 'relaygo_db', 'kv', 'group_id']);
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
    const kvKeys = ['union_ban', 'verify_mode', 'verify_captcha_mode', 'verify_question_mode', 'verify_combo_mode', 'verify_custom_question', 'verify_custom_answer', 'verify_fail_limit', 'appeal_url', 'antispam', 'antispam_link', 'antispam_media', 'antispam_keyword', 'antispam_autoban', 'blocked_keywords', 'language', 'auto_reply_msg', 'welcome_msg', 'welcome_button_text', 'welcome_button_url', 'welcome_buttons', 'business_status', 'business_rest_message', 'business_rest_cooldown', 'ai_translate', 'inbox_thread_id', 'blacklist_thread_id'];
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
        if (['bot_token', 'owner_id', 'd1', 'db', 'database', 'relaygo_db', 'kv'].includes(lowerKey) || lowerKey.includes('token') || lowerKey.includes('secret')) continue;
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
    return { text: `🔒 <b>安全验证</b>\n\n请选择正确答案：${a} + ${b} = ?`, reply_markup: makeChoiceButtons(userId, [...choices]) };
}
async function buildImageDigitChallenge(env, userId) {
    const ans = randomInt(0, 9);
    const choices = new Set([ans]);
    while (choices.size < 4) choices.add(randomInt(0, 9));
    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'image_digit', ans }), { expirationTtl: 180 });
    await upsertVerifySession(env, userId, 'image_digit', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
    return { photo: svgDataUrl(makeDigitSvg(ans)), caption: '🔒 安全验证：请选择图片中的数字', reply_markup: makeChoiceButtons(userId, [...choices]) };
}
async function buildCustomQuestionChallenge(env, userId) {
    const question = await getConfig(env, 'verify_custom_question', '请回复：我不是机器人');
    const answer = await getConfig(env, 'verify_custom_answer', '我不是机器人');
    await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'custom_question', ans: String(answer).trim().toLowerCase() }), { expirationTtl: 180 });
    await upsertVerifySession(env, userId, 'custom_question', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
    return { text: `🔒 <b>安全验证</b>\n\n${escapeHtml(question)}\n\n请在 2 分钟内完成验证。` };
}
async function startQuestionVerification(env, groupId, msg, userId, token, mode) {
    if (mode === 'sticker') {
        await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'sticker' }), { expirationTtl: 180 });
        await upsertVerifySession(env, userId, 'sticker', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: "🔒 <b>安全验证</b>\n\n本机器人已开启人机验证，请发送任意 <em>贴纸（Stickers）</em> 以通过验证。\n\n请在 2 分钟内完成验证。", parse_mode: 'HTML' });
    } else if (mode === 'math') {
        const a = Math.floor(Math.random() * 10), b = Math.floor(Math.random() * 10);
        await env.KV.put(`verify_pending:${userId}`, JSON.stringify({ type: 'math', ans: a + b }), { expirationTtl: 180 });
        await upsertVerifySession(env, userId, 'math', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 180);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: `🔒 <b>安全验证</b>\n\n请计算结果（直接发送数字）: ${a} + ${b} = ?\n\n请在 2 分钟内完成验证。`, parse_mode: 'HTML' });
    } else if (mode === 'button_math') {
        const challenge = await buildButtonMathChallenge(env, userId);
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: challenge.text, parse_mode: 'HTML', reply_markup: challenge.reply_markup });
    } else if (mode === 'image_digit') {
        const challenge = await buildImageDigitChallenge(env, userId);
        return tgRequest(token, 'sendPhoto', { chat_id: userId, photo: challenge.photo, caption: challenge.caption, reply_markup: challenge.reply_markup });
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
        await unbanUser(env, userId);
        await tgRequest(token, 'sendMessage', { chat_id: userId, text: '✅ 重新验证通过，您可以继续聊天。' });
        return;
    }
    await tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 验证通过，您可以开始聊天了。" });
    return initializeUser(env, groupId, msg, userId, token);
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
    const unionRaw = await getConfig(env, 'union_ban');
    const unionEnabled = unionRaw === '1' || unionRaw === 'true';
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
    const selected = parseInt(parts[2], 10);
    const groupId = await getConfig(env, 'group_id');
    if (selected === pending.ans) {
        await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '验证通过' });
        try { await tgRequest(token, 'editMessageReplyMarkup', { chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } }); } catch (e) { }
        return completeQuestionVerification(env, groupId, { chat: query.message.chat, from: query.from, message_id: query.message.message_id, text: '/start' }, userId, token, pending);
    }
    const failCount = await recordVerifyFail(env, userId);
    const limit = await getVerifyFailLimit(env);
    await env.KV.delete(`verify_pending:${userId}`);
    if (failCount >= limit) {
        await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '验证失败，已封禁', show_alert: true });
        return banUserWithNotice(env, userId, `验证失败 ${failCount}/${limit}`);
    }
    await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: `验证错误，还剩 ${limit - failCount} 次机会`, show_alert: true });
    return tgRequest(token, 'sendMessage', { chat_id: userId, text: '❌ 验证错误，请发送 /start 重新验证。' });
}

async function generateSettingsMenu(env) {
    const unionBanValue = await getConfig(env, 'union_ban');
    const unionBan = unionBanValue === '1' || unionBanValue === 'true';
    const verifyMode = await getConfig(env, 'verify_mode', 'off');
    const autoReplyMsg = await getConfig(env, 'auto_reply_msg');
    const botUsername = await getConfig(env, 'bot_username', 'My Bot');
    const language = await getConfig(env, 'language', 'auto');
    const anti = await getAntiSpamConfig(env);
    const keywordRaw = await getConfig(env, 'blocked_keywords');
    const keywordCount = keywordRaw ? keywordRaw.split(/[\n,，]/).map(x => x.trim()).filter(Boolean).length : 0;
    const failLimit = await getVerifyFailLimit(env);
    const appealUrl = await getAppealUrl(env);
    const businessStatus = await getConfig(env, 'business_status', 'open');
    const aiTranslate = await getConfig(env, 'ai_translate', '0');
    const unionStatus = unionBan ? '🟢 开启' : '🔴 关闭';
    const verifySettings = await getVerifySettings(env);
    const verifyLabels = { off: '🔴 关闭', math: '🔢 数学题', button_math: '🔘 算数按钮', sticker: '🎨 贴纸', image_digit: '🖼 图片数字', custom_question: '❓ 自定义问答' };
    const captchaLabels = { off: '🔴 无验证码', cloudflare_turnstile: '🛡 Turnstile', google_recaptcha: '🧩 reCAPTCHA' };
    const comboLabels = { captcha_only: '只验证码', question_only: '只问答', captcha_question: '验证码+问答' };
    const verifyDisplay = `${comboLabels[verifySettings.comboMode] || '只问答'} / ${captchaLabels[verifySettings.captchaMode] || '🔴 无验证码'} / ${verifyLabels[verifySettings.questionMode] || '🔴 关闭'}`;
    const replyStatus = autoReplyMsg ? '🟢 已启用' : '⚪️ 已关闭';
    const antiStatus = anti.enabled ? '🟢 开启' : '🔴 关闭';
    const businessDisplay = businessStatus === 'rest' ? '😴 休息中' : '🟢 营业中';
    const aiDisplay = aiTranslate === '1' ? '🟢 开' : '🔴 关';
    const langDisplay = ({ auto: '🌐 自动', zh: '🇨🇳 中文', en: '🇬🇧 English' })[language] || '🌐 自动';
    const info = `🛠 <b>${escapeHtml(botUsername)} 管理面板</b>\n\n📊 <b>当前配置:</b>\n🔸 营业状态：${businessDisplay}\n🔸 AI 翻译：${aiDisplay}\n🔸 防骚扰：${antiStatus}\n🔸 链接拦截：${anti.blockLinks ? '🟢 开启' : '🔴 关闭'}\n🔸 媒体限制：${anti.blockMedia ? '🟢 开启' : '🔴 关闭'}\n🔸 关键词：${anti.blockKeywords ? '🟢 开启' : '🔴 关闭'}（${keywordCount} 个）\n🔸 多语言：${langDisplay}\n🔸 联合封禁：${unionStatus}\n🔸 人机验证：${verifyDisplay}\n🔸 失败封禁：${failLimit} 次\n🔸 申诉链接：${escapeHtml(appealUrl)}\n🔸 自动回复：${replyStatus}\n\n👇 点击下方按钮修改设置`;
    const keyboard = { inline_keyboard: [
        [{ text: `🏪 ${businessDisplay}`, callback_data: 'toggle_business' }, { text: `🌐 AI翻译：${aiDisplay}`, callback_data: 'toggle_ai_translate' }],
        [{ text: `🛡 防骚扰：${antiStatus}`, callback_data: 'toggle_antispam' }],
        [{ text: `🔗 链接拦截：${anti.blockLinks ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_link' }, { text: `🖼 媒体限制：${anti.blockMedia ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_media' }],
        [{ text: `🚫 关键词：${anti.blockKeywords ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_keyword' }, { text: `⚡ 命中自封：${anti.autoBan ? '🟢' : '🔴'}`, callback_data: 'toggle_antispam_autoban' }],
        [{ text: '📝 关键词管理', callback_data: 'guide_keywords' }, { text: `🌐 语言：${langDisplay}`, callback_data: 'cycle_language' }],
        [{ text: `🌐 联合封禁：${unionStatus}`, callback_data: 'toggle_union' }],
        [{ text: `🧩 验证码：${captchaLabels[verifySettings.captchaMode] || '🔴'}`, callback_data: 'cycle_verify_captcha' }, { text: `❓ 问答：${verifyLabels[verifySettings.questionMode] || '🔴'}`, callback_data: 'cycle_verify_local' }],
        [{ text: `🔗 组合：${comboLabels[verifySettings.comboMode] || '只问答'}`, callback_data: 'cycle_verify_combo' }, { text: `❌ 失败封禁：${failLimit}次`, callback_data: 'cycle_verify_fail_limit' }],
        [{ text: '👮 协管列表', callback_data: 'admin_list' }],
        [{ text: '🔗 申诉设置', callback_data: 'guide_appeal' }, { text: '👋 欢迎消息', callback_data: 'guide_welcome' }],
        [{ text: '🤖 自动回复', callback_data: 'guide_reply' }, { text: '📢 广播', callback_data: 'guide_broadcast' }],
        [{ text: '📤 导出配置', callback_data: 'export_config' }, { text: '📥 导入说明', callback_data: 'guide_import' }],
        [{ text: '🔄 刷新', callback_data: 'refresh_menu' }]
    ] };
    return { text: info, reply_markup: keyboard };
}

async function handleOwnerCallback(env, query) {
    const token = env.BOT_TOKEN;
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('spam_')) {
        const [action, targetId] = data.split(':');
        if (action === 'spam_ban') {
            if (!(await hasPermission(env, query.from.id, 'ban'))) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '权限不足', show_alert: true });
            await banUserWithNotice(env, targetId, '管理员手动封禁');
            await writeAuditLog(env, query.from.id, 'user.ban', targetId, { source: 'spam_review' });
            await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已封禁用户' });
        }
        else if (action === 'spam_trust') { await env.KV.put(`trusted:${targetId}`, '1'); await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已加入白名单' }); }
        else if (action === 'spam_allow') { const raw = await env.KV.get(`spam:last:${targetId}`); if (!raw) return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '原消息已过期', show_alert: true }); const savedMsg = JSON.parse(raw); const userData = await getUser(env, targetId); const groupId = await getConfig(env, 'group_id'); if (groupId && userData && userData.thread_id) await forwardMessage(env, token, groupId, targetId, savedMsg, userData.thread_id); else if (groupId) await initializeUser(env, groupId, savedMsg, targetId, token); await tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id, text: '已放行' }); }
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

    const configActions = new Set(['toggle_union', 'toggle_business', 'toggle_ai_translate', 'toggle_antispam', 'toggle_antispam_link', 'toggle_antispam_media', 'toggle_antispam_keyword', 'toggle_antispam_autoban', 'cycle_language', 'cycle_verify_fail_limit', 'cycle_verify_captcha', 'cycle_verify_combo', 'cycle_verify_local', 'export_config']);
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
        await sendJsonDocument(env, query.from.id, `relaygo-config-${Date.now()}.json`, exported);
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
        const modes = ['off', 'math', 'button_math', 'image_digit', 'custom_question'];
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
        const currentText = current ? escapeHtml(current) : "(无)";
        const btnInfo = btns ? "已设置按钮" : "(无)";
        const text = `📝 <b>欢迎消息设置</b>\n\n当前文本:\n<pre>${currentText}</pre>\n\n当前按钮: ${btnInfo}\n\n👉 <b>修改文本:</b>\n发送 <code>/welcome</code> {消息内容}\n\n👉 <b>修改按钮:</b>\n发送 <code>/welbtn</code> {按钮内容}\n格式：按钮1 - 链接1 | 按钮2 - 链接2 , 按钮3 - 链接3\n(逗号换行，竖线同行，最多设置3个)\n\n发送 /cancel 返回`;
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

    const menu = await generateSettingsMenu(env);
    try { await tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup }); } catch (e) { }
    return tgRequest(token, 'answerCallbackQuery', { callback_query_id: query.id });
}

async function handleOwnerMenu(env, msg, ctx) {
    const token = env.BOT_TOKEN;
    const chatId = msg.chat.id;
    let text = msg.text || '';

    if (text === '/start') {
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: `👋 您好，机器人管理员！\n\n您看到此消息说明机器人已成功启动。\n\n当前版本：1.1.6 (Standalone) \n发送 /menu 显示管理菜单`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '查看帮助文档', url: 'https://t.me/RelayGo/14' }]] } });
    }

    if (['/menu', '/cancel'].includes(text)) {
        const menu = await generateSettingsMenu(env);
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: menu.text, parse_mode: 'HTML', reply_markup: menu.reply_markup });
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
        return sendJsonDocument(env, chatId, `relaygo-config-${Date.now()}.json`, exported);
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
        return tgRequest(token, 'sendMessage', { chat_id: chatId, text: "✅ 申诉链接已更新。" });
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

async function handlePrivateOnlyUserMessage(env, msg, userId, userData) {
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
        is_banned: false
    };
    await upsertUser(env, next);
    if (msg.text === '/start') return sendWelcomeMessage(env, userId);
    if (!ownerId) return tgRequest(token, 'sendMessage', { chat_id: userId, text: t(await getLang(env, msg), 'not_bound') });
    const name = formatUserName(info);
    const username = info.username ? `@${escapeHtml(info.username)}` : 'None';
    await tgRequest(token, 'sendMessage', {
        chat_id: ownerId,
        text: `📩 <b>新私聊消息</b>\n\n用户：<a href="tg://user?id=${userId}">${name}</a>\nUID：<code>${userId}</code>\n用户名：${username}`,
        parse_mode: 'HTML'
    });
    await forwardMessage(env, token, ownerId, userId, msg);
    return tgRequest(token, 'sendMessage', { chat_id: userId, text: '✅ 已收到您的消息，管理员会尽快回复。' });
}

// 用户私聊核心逻辑
async function handleUserPrivateMessage(env, groupId, msg) {
    const userId = String(msg.from.id);
    const token = env.BOT_TOKEN;
    const lang = await getLang(env, msg);

    // 1. 读取用户数据（D1 优先，KV 兼容）
    let userData = await getUser(env, userId);

    // 验证码刷新入口必须早于本地封禁检查，封禁用户重验也要能回跳。
    if (msg.text && msg.text.startsWith('/start refresh_')) {
        const refreshSettings = await getVerifySettings(env);
        const unionRaw = await getConfig(env, 'union_ban');
        const unionEnabled = unionRaw === '1' || unionRaw === 'true';
        if (shouldRunCaptcha(refreshSettings, unionEnabled)) return handleUnionRefresh(env, groupId, msg, userId, token);
    }

    const reverifyPendingBeforeBan = await env.KV.get(`reverify_pending:${userId}`, { type: 'json' });
    const questionPendingBeforeBan = await env.KV.get(`verify_pending:${userId}`, { type: 'json' });
    if (reverifyPendingBeforeBan && questionPendingBeforeBan) {
        return handleLocalVerification(env, groupId, msg, userId, token, questionPendingBeforeBan.type);
    }

    // 本地封禁检查
    if (userData && userData.is_banned) {
        const appealUrl = await getAppealUrl(env);
        if (msg.text === '/start') await createBlacklistCard(env, userId, '已封禁用户重新进入', appealUrl);
        await upsertVerifySession(env, userId, 'banned_reentry', 'appeal_or_reverify', 0, 3600);
        return tgRequest(token, 'sendMessage', {
            chat_id: userId,
            text: `${t(lang, 'banned')}\n\n请选择重新验证或通过申诉链接联系管理员：${appealUrl}`,
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '🔁 重新验证', callback_data: `reverify:${userId}` }, { text: '📨 申诉', url: appealUrl }]] },
        });
    }

    // 2. 读取联合封禁配置（内存缓存 → KV）
    let isUnionBanEnabled = memGet('config:union_ban');
    if (isUnionBanEnabled === undefined) {
        const raw = await getConfig(env, 'union_ban');
        isUnionBanEnabled = raw === '1' || raw === 'true';
        memSet('config:union_ban', isUnionBanEnabled);
    }

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
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: t(lang, 'union_banned'), parse_mode: 'HTML' });
        }
    }

    // 刷新 verify cache
    if (msg.text && msg.text.startsWith('/start refresh_') && isUnionBanEnabled) {
        return handleUnionRefresh(env, groupId, msg, userId, token);
    }

    // 已验证用户
    const spamCheck = await checkAntiSpam(env, groupId, msg, userData);
    if (!spamCheck.ok) {
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: t(lang, spamCheck.messageKey), parse_mode: 'HTML' });
    }

    if (userData && userData.thread_id) {
        if (msg.text === '/start') return sendWelcomeMessage(env, userId);

        const nextUserData = await syncUserActivity(env, groupId, userId, msg, userData);
        if (await maybeSendRestNotice(env, userId)) return;

        // 自动回复（媒体组只触发一次，内存缓存 → KV）
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
        const forwarded = await forwardMessage(env, token, groupId, userId, msg, nextUserData.thread_id);
        await maybeTranslateToChinese(env, groupId, nextUserData.thread_id, msg);
        return forwarded;
    }

    // 新用户验证：支持验证码、问答、验证码+问答组合
    const verifySettings = await getVerifySettings(env);
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
            if (!groupId) return handlePrivateOnlyUserMessage(env, msg, userId, userData);
            return initializeUser(env, groupId, msg, userId, token);
        }
        return handleLocalVerification(env, groupId, msg, userId, token, verifySettings.questionMode);
    }
}

async function startCaptchaVerification(env, groupId, msg, userId, token, verifySettings, isUnionBanEnabled) {
    const botUsername = memGet('config:bot_username') || await getConfig(env, 'bot_username', 'Bot');
    memSet('config:bot_username', botUsername);
    const payloadObj = { uid: userId, bot: botUsername, ts: Date.now(), provider: isUnionBanEnabled ? 'cloudflare_turnstile' : verifySettings.captchaMode, combo: verifySettings.comboMode };
    const payload = btoa(JSON.stringify(payloadObj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const webAppUrl = `https://t.me/${CENTRAL_BOT_USERNAME}/${CENTRAL_WEBAPP_NAME}?startapp=${payload}`;
    const providerName = isUnionBanEnabled || verifySettings.captchaMode === 'cloudflare_turnstile' ? 'Cloudflare Turnstile' : 'Google reCAPTCHA';
    await upsertVerifySession(env, userId, verifySettings.captchaMode || 'captcha', 'pending', parseInt(await env.KV.get(`verify_fail:${userId}`) || '0', 10), 600);
    return tgRequest(token, 'sendMessage', {
        chat_id: userId,
        text: `🔒 <b>安全验证</b>

本机器人已开启 ${providerName} 验证，请点击下方按钮验证身份。${shouldRunQuestion(verifySettings) ? '

完成验证码后还需要继续回答本地问题。' : ''}

请在 10 分钟内完成验证并返回。`,
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
            await unbanUser(env, userId);
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 重新验证通过，您可以继续聊天。" });
        }
        await tgRequest(token, 'sendMessage', { chat_id: userId, text: "✅ 验证通过，您可以开始聊天了。" });
        return initializeUser(env, groupId, msg, userId, token);
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

    if (!pendingState && msg.text === '/start') {
        return startQuestionVerification(env, groupId, msg, userId, token, mode);
    }

    if (pendingState) {
        let passed = false;
        if (pendingState.type === 'sticker' && msg.sticker) passed = true;
        else if (pendingState.type === 'math' && msg.text && parseInt(msg.text) === pendingState.ans) passed = true;
        else if (pendingState.type === 'custom_question' && msg.text && msg.text.trim().toLowerCase() === pendingState.ans) passed = true;
        if (pendingState.type === 'button_math' || pendingState.type === 'image_digit') return;

        if (passed) {
            return completeQuestionVerification(env, groupId, msg, userId, token, pendingState);
        } else {
            await env.KV.delete(tempKey);
            const failCount = await recordVerifyFail(env, userId);
            const limit = await getVerifyFailLimit(env);
            if (failCount >= limit) return banUserWithNotice(env, userId, `验证失败 ${failCount}/${limit}`);
            return tgRequest(token, 'sendMessage', { chat_id: userId, text: `❌ 验证失败，请发送 /start 重试。剩余次数：${limit - failCount}` });
        }
    }
}

async function initializeUser(env, groupId, msg, userId, token) {
    if (!groupId) return handlePrivateOnlyUserMessage(env, msg, userId, await getUser(env, userId));

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
        await sendWelcomeMessage(env, userId);

        if (!msg.text || !msg.text.startsWith('/start')) {
            await upsertInboxCard(env, groupId, userId, userData, msg);
            await forwardMessage(env, token, groupId, userId, msg, threadId);
            await maybeTranslateToChinese(env, groupId, threadId, msg);
        }
    } catch (e) {
        return tgRequest(token, 'sendMessage', { chat_id: userId, text: "Error: " + e.message });
    }
}











