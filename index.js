const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const FormData = require("form-data");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN;
const RAILWAY_DB_URL = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;

let db = null;
if (RAILWAY_DB_URL) {
  db = new Pool({
    connectionString: RAILWAY_DB_URL,
    ssl: RAILWAY_DB_URL.includes('railway') || RAILWAY_DB_URL.includes('neon') || RAILWAY_DB_URL.includes('replit') ? { rejectUnauthorized: false } : false,
    max: 5,
  });
  db.query("SELECT 1")
    .then(() => {
      console.log("Database Railway terhubung!");
      return db.query(`
        CREATE TABLE IF NOT EXISTS api_key_pool (
          id SERIAL PRIMARY KEY,
          api_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'available',
          assigned_to BIGINT,
          created_at TIMESTAMP DEFAULT NOW(),
          dead_at TIMESTAMP
        )
      `);
    })
    .then(() => {
      console.log("api_key_pool table ready");
      return db.query(`
        CREATE TABLE IF NOT EXISTS user_api_keys (
          id SERIAL PRIMARY KEY,
          user_id BIGINT NOT NULL,
          api_key TEXT NOT NULL,
          assigned_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(user_id, api_key)
        )
      `);
    })
    .then(() => {
      return Promise.all([
        db.query("ALTER TABLE user_api_keys ALTER COLUMN user_id TYPE BIGINT").catch(() => {}),
        db.query("ALTER TABLE api_key_pool ALTER COLUMN assigned_to TYPE BIGINT").catch(() => {})
      ]);
    })
    .then(() => console.log("user_api_keys table ready"))
    .then(() => db.query(`
        CREATE TABLE IF NOT EXISTS xclipaibot_users (
          telegram_id BIGINT PRIMARY KEY,
          username TEXT,
          first_name TEXT,
          balance INTEGER NOT NULL DEFAULT 0,
          linked_user_id BIGINT,
          converted BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `))
    .then(() => console.log("xclipaibot_users table ready"))
    .then(() => db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS xclipaibot_users_linked_user_id_uidx
        ON xclipaibot_users (linked_user_id) WHERE linked_user_id IS NOT NULL
      `))
    .then(() => console.log("xclipaibot_users linked_user_id unique index ready"))
    .then(() => db.query(`
        CREATE TABLE IF NOT EXISTS xclipaibot_topups (
          order_id TEXT PRIMARY KEY,
          telegram_id BIGINT NOT NULL,
          amount INTEGER NOT NULL,
          total_amount NUMERIC NOT NULL,
          video_count INTEGER NOT NULL,
          signature TEXT,
          status TEXT NOT NULL DEFAULT 'PENDING',
          created_at TIMESTAMP DEFAULT NOW(),
          paid_at TIMESTAMP
        )
      `))
    .then(() => console.log("xclipaibot_topups table ready"))
    .catch((err) => console.error("Database connection error:", err.message));
} else {
  console.warn("RAILWAY_DATABASE_URL not set - login feature disabled");
}

if (!TELEGRAM_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const FLORA_BASE = "https://app.flora.ai";
const FLORA_MODEL_NAME = "Kling MC V3 PRO";
let FLORA_MODEL_ID = process.env.FLORA_MODEL_ID || null;
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(id => id.trim()).filter(Boolean);

const MODELS = {
  // === MOTION CONTROL (foto karakter + video referensi gerakan) via Flora AI ===
  'kling-2-6-pro-mc': {
    name: 'Kling MC V3 PRO',
    emoji: '🔥',
    floraModel: FLORA_MODEL_NAME,
    imageField: 'image_url',
    requiresVideo: true,
    motionControl: true,
    hasAudio: true,
  },
};

const KEYS_PER_USER = 1;

let VPS_PROXIES = [];

function getModelKeyboard() {
  return [
    [{ text: "🔥 Kling MC V3 PRO", callback_data: "model_kling-2-6-pro-mc" }],
  ];
}

function initProxy() {
  // Proxy (Decodo/VPS) DINONAKTIFKAN. Koneksi ke Flora selalu langsung (direct).
  // VPS_PROXIES / PROXY_LIST sengaja diabaikan di semua environment.
  VPS_PROXIES = [];
  console.log("Proxy dinonaktifkan - koneksi Flora langsung (direct)");
}

initProxy();

function buildProxyUrl(proxy) {
  if (proxy.username && proxy.password) {
    return `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  }
  return `http://${proxy.host}:${proxy.port}`;
}

function floraHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Authorization': `Bearer ${apiKey.replace(/[^\x20-\x7E]/g, '').trim()}`
  };
}

function isApiError(err) {
  const status = err.response?.status;
  if (!status) return false;
  const body = err.response?.data;
  if (!body) return false;
  if (typeof body === 'object' && (body.message || body.detail || body.error)) return true;
  if (typeof body === 'string' && body.startsWith('{')) return true;
  return false;
}

function randomDelay(baseMs, jitterMs) {
  return baseMs + Math.floor(Math.random() * jitterMs);
}

async function makeFloraRequest(method, url, apiKey, body = null) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (VPS_PROXIES.length === 0) {
    const config = { method, url, headers: floraHeaders(apiKey), timeout: 120000 };
    if (body) config.data = body;
    return axios(config);
  }

  let attempt = 0;
  let proxyIndex = 0;
  const maxAttempts = 15;

  while (attempt < maxAttempts) {
    const proxy = VPS_PROXIES[proxyIndex % VPS_PROXIES.length];
    const proxyUrl = buildProxyUrl(proxy);

    const config = {
      method,
      url,
      headers: floraHeaders(apiKey),
      timeout: 120000,
      httpsAgent: new HttpsProxyAgent(proxyUrl, { rejectUnauthorized: false }),
      proxy: false
    };
    if (body) config.data = body;

    attempt++;
    console.log(`[PROXY] Attempt ${attempt}/${maxAttempts} via ${proxy.host}:${proxy.port}`);

    try {
      const resp = await axios(config);
      if (typeof resp.data === 'string' && resp.data.includes('Access denied')) {
        throw new Error('Blocked by proxy/API');
      }
      return resp;
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) throw err;
      if (status === 401 && isApiError(err)) throw err;
      if (status === 402 && isApiError(err)) throw err;
      if (status === 403 && isApiError(err)) throw err;

      const errMsg = (err.message || '').toLowerCase();
      const isSocketErr = errMsg.includes('socket') || errMsg.includes('econnreset') ||
                          errMsg.includes('etimedout') || errMsg.includes('ssl') ||
                          errMsg.includes('econnrefused') || errMsg.includes('enotfound');
      const isProxyBlock = (status === 403 && !isApiError(err)) ||
                           status === 407 || status === 502 || status === 503 || status === 504 ||
                           status === 522 || status === 524;

      if (isSocketErr || isProxyBlock) {
        const reason = isSocketErr ? `Socket error (${err.code || errMsg.substring(0, 30)})` : `HTTP ${status}`;
        console.log(`[PROXY] ${reason}, rotating IP... (wait ${Math.round(randomDelay(2000, 2000) / 1000)}s)`);
        proxyIndex++;
        await sleep(randomDelay(2000, 2000));
        continue;
      }

      throw err;
    }
  }

  console.log(`[PROXY] All ${maxAttempts} proxy attempts failed, trying DIRECT connection...`);
  try {
    const directConfig = { method, url, headers: floraHeaders(apiKey), timeout: 120000 };
    if (body) directConfig.data = body;
    const resp = await axios(directConfig);
    console.log(`[DIRECT] Success without proxy`);
    return resp;
  } catch (directErr) {
    console.error(`[DIRECT] Also failed:`, directErr.message);
    throw directErr;
  }
}

// Discovers the Flora model id for the configured model name from the /models
// catalog. Flora does not publish the id, so we look it up at runtime and cache it.
async function getFloraModelId(apiKey) {
  if (FLORA_MODEL_ID) return FLORA_MODEL_ID;
  const resp = await makeFloraRequest('GET', `${FLORA_BASE}/api/v1/models`, apiKey);
  const payload = resp.data;
  const list = Array.isArray(payload) ? payload
    : (payload?.models || payload?.data || payload?.results || []);
  const wanted = FLORA_MODEL_NAME.toLowerCase().replace(/\s+/g, ' ').trim();
  const norm = (v) => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
  let match = list.find(m => norm(m.name) === wanted || norm(m.displayName) === wanted || norm(m.title) === wanted);
  if (!match) {
    match = list.find(m => {
      const n = norm(m.name) + ' ' + norm(m.displayName) + ' ' + norm(m.title);
      return n.includes('kling') && n.includes('2.6') && n.includes('motion');
    });
  }
  if (!match) {
    const available = list.map(m => m.name || m.displayName || m.title || m.id).filter(Boolean);
    throw new Error(`Model "${FLORA_MODEL_NAME}" tidak ditemukan di katalog Flora. Tersedia: ${available.slice(0, 40).join(', ')}`);
  }
  FLORA_MODEL_ID = match.id || match.modelId || match.model_id || match.slug;
  console.log(`[flora] Resolved model "${FLORA_MODEL_NAME}" -> ${FLORA_MODEL_ID}`);
  if (!FLORA_MODEL_ID) throw new Error('Flora model ditemukan tapi tidak punya id');
  return FLORA_MODEL_ID;
}

// Each Flora API key belongs to an account with its own workspace + project.
// A generate call requires both, so we discover and cache them per key.
const floraContextCache = new Map();
async function getFloraContext(apiKey) {
  if (floraContextCache.has(apiKey)) return floraContextCache.get(apiKey);

  const wsResp = await makeFloraRequest('GET', `${FLORA_BASE}/api/v1/workspaces`, apiKey);
  const workspaces = wsResp.data?.workspaces || wsResp.data?.data || (Array.isArray(wsResp.data) ? wsResp.data : []);
  const workspaceId = workspaces[0]?.workspace_id || workspaces[0]?.id;
  if (!workspaceId) throw new Error('Tidak ada workspace pada akun untuk API key ini.');

  const prjResp = await makeFloraRequest('GET', `${FLORA_BASE}/api/v1/projects?workspace_id=${encodeURIComponent(workspaceId)}`, apiKey);
  const projects = prjResp.data?.projects || prjResp.data?.data || (Array.isArray(prjResp.data) ? prjResp.data : []);
  let projectId = projects[0]?.project_id || projects[0]?.id;

  if (!projectId) {
    const created = await makeFloraRequest('POST', `${FLORA_BASE}/api/v1/projects`, apiKey, {
      workspace_id: workspaceId,
      name: 'Telegram Bot',
    });
    projectId = created.data?.project_id || created.data?.id || created.data?.project?.project_id;
  }
  if (!projectId) throw new Error('Tidak bisa menemukan/membuat project untuk API key ini.');

  const ctx = { workspaceId, projectId };
  floraContextCache.set(apiKey, ctx);
  console.log(`[flora] Context for key ...${apiKey.slice(-6)}: ws=${workspaceId} prj=${projectId}`);
  return ctx;
}

const lockedKeys = new Set();

function lockKey(key) {
  lockedKeys.add(key);
  console.log(`Key ...${key.slice(-6)} LOCKED`);
}

function unlockKey(key) {
  lockedKeys.delete(key);
  console.log(`Key ...${key.slice(-6)} UNLOCKED`);
}

async function getUserKeys(userId) {
  if (!db) return [];
  const result = await db.query(
    "SELECT api_key FROM user_api_keys WHERE user_id = $1",
    [userId]
  );
  return result.rows.map(r => r.api_key);
}

async function assignKeysToUser(userId) {
  if (!db) return [];
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      "SELECT api_key FROM user_api_keys WHERE user_id = $1",
      [userId]
    );
    if (existing.rows.length >= KEYS_PER_USER) {
      await client.query("COMMIT");
      return existing.rows.map(r => r.api_key);
    }

    const needed = KEYS_PER_USER - existing.rows.length;
    const available = await client.query(
      "SELECT api_key FROM api_key_pool WHERE status = 'available' ORDER BY created_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED",
      [needed]
    );

    for (const row of available.rows) {
      await client.query(
        "UPDATE api_key_pool SET status = 'assigned', assigned_to = $1 WHERE api_key = $2",
        [userId, row.api_key]
      );
      await client.query(
        "INSERT INTO user_api_keys (user_id, api_key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [userId, row.api_key]
      );
      console.log(`[pool] Assigned key ...${row.api_key.slice(-6)} to user ${userId}`);
    }

    await client.query("COMMIT");
    return await getUserKeys(userId);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[pool] assignKeysToUser error:", err.message);
    return await getUserKeys(userId);
  } finally {
    client.release();
  }
}

async function replaceDeadKey(userId, deadKey) {
  if (!db) return null;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM user_api_keys WHERE api_key = $1",
      [deadKey]
    );
    await client.query(
      "DELETE FROM api_key_pool WHERE api_key = $1",
      [deadKey]
    );
    console.log(`[pool] Key ...${deadKey.slice(-6)} permanently deleted (dead) for user ${userId}`);

    const available = await client.query(
      "SELECT api_key FROM api_key_pool WHERE status = 'available' ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED"
    );

    if (available.rows.length > 0) {
      const newKey = available.rows[0].api_key;
      await client.query(
        "UPDATE api_key_pool SET status = 'assigned', assigned_to = $1 WHERE api_key = $2",
        [userId, newKey]
      );
      await client.query(
        "INSERT INTO user_api_keys (user_id, api_key) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [userId, newKey]
      );
      await client.query("COMMIT");
      console.log(`[pool] Replaced with new key ...${newKey.slice(-6)} for user ${userId}`);
      return newKey;
    }

    await client.query("COMMIT");
    console.log(`[pool] No available keys to replace for user ${userId}`);
    return null;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[pool] replaceDeadKey error:", err.message);
    return null;
  } finally {
    client.release();
  }
}

// --- Rotasi pool bersama (key TIDAK di-assign permanen ke user) ---
let globalRotation = 0;

async function getPoolKeys() {
  if (!db) return [];
  const result = await db.query(
    "SELECT api_key FROM api_key_pool ORDER BY created_at ASC"
  );
  return result.rows.map(r => r.api_key);
}

async function deleteDeadKey(deadKey) {
  if (!db) return;
  try {
    await db.query("DELETE FROM api_key_pool WHERE api_key = $1", [deadKey]);
    await db.query("DELETE FROM user_api_keys WHERE api_key = $1", [deadKey]);
    console.log(`[pool] Key ...${deadKey.slice(-6)} dihapus permanen (mati)`);
  } catch (err) {
    console.error("[pool] deleteDeadKey error:", err.message);
  }
}

function isAdmin(msg) {
  return ADMIN_IDS.includes(String(msg.from.id));
}

const keyFailures = {};

function markKeyFailed(key, cooldownMs = 60000) {
  keyFailures[key] = { until: Date.now() + cooldownMs };
  console.log(`API key ...${key.slice(-6)} cooldown for ${cooldownMs / 1000}s`);
}

function markKeyOk(key) {
  delete keyFailures[key];
}

function randomJitter(baseMs) {
  return baseMs + Math.floor(Math.random() * 5000);
}

const UPLOAD_DIR = path.join(__dirname, "uploads");
if (fs.existsSync(UPLOAD_DIR)) {
  const oldFiles = fs.readdirSync(UPLOAD_DIR);
  if (oldFiles.length > 0) {
    oldFiles.forEach(f => { try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch (_) {} });
    console.log(`[cleanup] Deleted ${oldFiles.length} leftover files from uploads/`);
  }
} else {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const express = require("express");
const app = express();
const FILE_SERVER_PORT = process.env.PORT || 5000;

app.use(express.json());
app.use("/files", express.static(UPLOAD_DIR));

app.get("/", (req, res) => {
  res.json({ status: "ok", bot: "Kling MC V3 PRO" });
});

// Webhook KlikQRIS: dipanggil otomatis saat status berubah (PAID/EXPIRED).
app.post("/webhook/klikqris", async (req, res) => {
  try {
    if (!db) return res.status(200).json({ ok: true, ignored: "no db" });
    const body = req.body || {};
    const d = body.data || {};
    const orderId = d.order_id;
    if (!orderId) return res.status(200).json({ ok: true, ignored: "no order_id" });

    const row = (await db.query("SELECT * FROM xclipaibot_topups WHERE order_id = $1", [orderId])).rows[0];
    if (!row) return res.status(200).json({ ok: true, ignored: "unknown order" });

    // Validasi signature: harus sama dengan yang didapat saat Membuat Transaksi.
    if (!row.signature || !d.signature || String(d.signature) !== String(row.signature)) {
      console.error("[topup] webhook signature mismatch untuk", orderId);
      return res.status(401).json({ ok: false, error: "invalid signature" });
    }

    const status = String(d.status || "").toUpperCase();
    if (status === "PAID" || status === "SUCCESS") {
      const credited = await creditTopupIfPaid(orderId);
      if (credited) {
        bot.sendMessage(
          row.telegram_id,
          `✅ Pembayaran diterima! Saldo +${credited.videoCount} video.\n\n💳 Saldo sekarang: ${credited.balance} video.\n\nLangsung kirim foto + video lalu /generate.`
        );
      }
    } else if (status === "EXPIRED") {
      await db.query("UPDATE xclipaibot_topups SET status = 'EXPIRED' WHERE order_id = $1 AND status = 'PENDING'", [orderId]);
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[topup] webhook error:", err.message);
    return res.status(200).json({ ok: true });
  }
});

app.listen(FILE_SERVER_PORT, "0.0.0.0", () => {
  console.log(`File server running on port ${FILE_SERVER_PORT}`);
});

function getPublicFileUrl(filename) {
  if (PUBLIC_DOMAIN) {
    return `https://${PUBLIC_DOMAIN}/files/${filename}`;
  }
  return `http://localhost:${FILE_SERVER_PORT}/files/${filename}`;
}

const COOLDOWN_MS = 3 * 60 * 1000;
// Konversi langganan lama -> saldo (dipakai oleh /link). Ubah angka ini sesuka hati.
const CONVERSION_CREDITS = 100;

// ===== KlikQRIS payment gateway (top-up otomatis) =====
const KLIKQRIS_API_KEY = process.env.KLIKQRIS_API_KEY;
const KLIKQRIS_MERCHANT_ID = process.env.KLIKQRIS_MERCHANT_ID;
const KLIKQRIS_BASE = "https://klikqris.com/api/qrisv2";
// Top-up bebas: 1 video = PRICE_PER_VIDEO rupiah. User pilih/ketik jumlah video.
const PRICE_PER_VIDEO = 2000;
const TOPUP_MIN_VIDEOS = 1;
const TOPUP_MAX_VIDEOS = 500;
const userCooldowns = new Map();
const userKeyRotation = new Map();

// Global submission queue — staggers Flora API calls across users
// to avoid burst patterns that trigger abuse/IP bans
const SUBMIT_JITTER_MIN_MS = 8000;
const SUBMIT_JITTER_MAX_MS = 20000;
let submitQueueBusy = false;
const submitQueue = [];

function scheduleSubmit(fn) {
  return new Promise((resolve, reject) => {
    submitQueue.push({ fn, resolve, reject });
    drainSubmitQueue();
  });
}

async function drainSubmitQueue() {
  if (submitQueueBusy || submitQueue.length === 0) return;
  submitQueueBusy = true;
  while (submitQueue.length > 0) {
    const { fn, resolve, reject } = submitQueue.shift();
    try {
      const result = await fn();
      resolve(result);
    } catch (err) {
      reject(err);
    }
    if (submitQueue.length > 0) {
      const jitter = SUBMIT_JITTER_MIN_MS + Math.floor(Math.random() * (SUBMIT_JITTER_MAX_MS - SUBMIT_JITTER_MIN_MS));
      console.log(`[queue] Jitter ${jitter}ms sebelum submit berikutnya (${submitQueue.length} antrian)`);
      await new Promise(r => setTimeout(r, jitter));
    }
  }
  submitQueueBusy = false;
}

function getCooldownRemaining(userId) {
  const lastUsed = userCooldowns.get(userId);
  if (!lastUsed) return 0;
  const elapsed = Date.now() - lastUsed;
  return Math.max(0, COOLDOWN_MS - elapsed);
}

function setCooldown(userId) {
  userCooldowns.set(userId, Date.now());
}

// --- Sistem saldo (per Telegram ID), disimpan di tabel xclipaibot_users ---
// Identitas user = Telegram ID; tidak ada login. Saldo bertahan lintas restart.
async function ensureUser(telegramId, username, firstName) {
  if (!db || !telegramId) return null;
  try {
    const res = await db.query(
      `INSERT INTO xclipaibot_users (telegram_id, username, first_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO UPDATE
         SET username = COALESCE(EXCLUDED.username, xclipaibot_users.username),
             first_name = COALESCE(EXCLUDED.first_name, xclipaibot_users.first_name),
             updated_at = NOW()
       RETURNING *`,
      [telegramId, username || null, firstName || null]
    );
    return res.rows[0];
  } catch (err) {
    console.error("[saldo] ensureUser error:", err.message);
    return null;
  }
}

async function getBalance(telegramId) {
  if (!db || !telegramId) return 0;
  try {
    const res = await db.query(
      "SELECT balance FROM xclipaibot_users WHERE telegram_id = $1",
      [telegramId]
    );
    return res.rows.length ? res.rows[0].balance : 0;
  } catch (err) {
    console.error("[saldo] getBalance error:", err.message);
    return 0;
  }
}

async function addBalance(telegramId, amount) {
  if (!db || !telegramId) return null;
  const res = await db.query(
    `INSERT INTO xclipaibot_users (telegram_id, balance)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE
       SET balance = xclipaibot_users.balance + $2, updated_at = NOW()
     RETURNING balance`,
    [telegramId, amount]
  );
  return res.rows[0].balance;
}

// Pengurangan atomik: hanya berhasil kalau saldo cukup. Return saldo baru, atau
// null kalau saldo tidak cukup (aman dari generate paralel/race).
async function deductBalance(telegramId, amount = 1) {
  if (!db || !telegramId) return null;
  const res = await db.query(
    `UPDATE xclipaibot_users SET balance = balance - $2, updated_at = NOW()
     WHERE telegram_id = $1 AND balance >= $2
     RETURNING balance`,
    [telegramId, amount]
  );
  return res.rows.length ? res.rows[0].balance : null;
}

// ===== KlikQRIS helpers =====
async function createKlikqrisTransaction(orderId, amount, keterangan) {
  const resp = await axios.post(
    `${KLIKQRIS_BASE}/create`,
    { order_id: orderId, id_merchant: KLIKQRIS_MERCHANT_ID, amount, keterangan: keterangan || "" },
    {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": KLIKQRIS_API_KEY,
        "id_merchant": KLIKQRIS_MERCHANT_ID,
      },
      timeout: 30000,
    }
  );
  return resp.data;
}

async function checkKlikqrisStatus(orderId) {
  const resp = await axios.get(
    `${KLIKQRIS_BASE}/status/${KLIKQRIS_MERCHANT_ID}/${orderId}`,
    {
      headers: { "x-api-key": KLIKQRIS_API_KEY, "id_merchant": KLIKQRIS_MERCHANT_ID },
      timeout: 30000,
    }
  );
  return resp.data;
}

// Tambah saldo untuk order yang lunas — idempotent (aman dari webhook dobel).
// Hanya dipanggil ketika provider (KlikQRIS) sudah memastikan PAID. Menerima baris
// berstatus PENDING maupun EXPIRED: kalau ternyata benar dibayar (mis. dibayar mepet
// atau status sempat ketinggalan jadi EXPIRED), saldo tetap masuk. Baris yang sudah
// PAID diabaikan (return null) sehingga tidak pernah dobel.
// Transaksional: kunci baris order, tambah saldo, lalu tandai PAID dalam SATU commit
// sehingga tidak mungkin status jadi PAID tanpa saldo bertambah (atau sebaliknya).
async function creditTopupIfPaid(orderId) {
  if (!db) return null;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query(
      `SELECT telegram_id, video_count FROM xclipaibot_topups
       WHERE order_id = $1 AND status IN ('PENDING', 'EXPIRED') FOR UPDATE`,
      [orderId]
    )).rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return null;
    }
    const { telegram_id, video_count } = row;
    const balance = (await client.query(
      `INSERT INTO xclipaibot_users (telegram_id, balance)
       VALUES ($1, $2)
       ON CONFLICT (telegram_id) DO UPDATE
         SET balance = xclipaibot_users.balance + $2, updated_at = NOW()
       RETURNING balance`,
      [telegram_id, video_count]
    )).rows[0].balance;
    await client.query(
      `UPDATE xclipaibot_topups SET status = 'PAID', paid_at = NOW() WHERE order_id = $1`,
      [orderId]
    );
    await client.query("COMMIT");
    return { telegramId: telegram_id, videoCount: video_count, balance };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function createTopupOrder(chatId, from, videos) {
  const telegramId = from.id;
  if (!KLIKQRIS_API_KEY || !KLIKQRIS_MERCHANT_ID) {
    bot.sendMessage(chatId, "Fitur top-up belum aktif. Hubungi admin.");
    return;
  }
  if (!Number.isInteger(videos) || videos < TOPUP_MIN_VIDEOS || videos > TOPUP_MAX_VIDEOS) {
    bot.sendMessage(chatId, `Jumlah video harus antara ${TOPUP_MIN_VIDEOS}–${TOPUP_MAX_VIDEOS}. Contoh: /topup 5`);
    return;
  }
  await ensureUser(telegramId, from.username, from.first_name);
  const amount = videos * PRICE_PER_VIDEO;
  const orderId = `XCA-${telegramId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  try {
    const res = await createKlikqrisTransaction(orderId, amount, `Top-up ${videos} video`);
    const d = (res && res.data) ? res.data : {};
    if (!res || res.status !== true || !d.order_id) {
      console.error("[topup] create gagal:", JSON.stringify(res));
      bot.sendMessage(chatId, "Gagal membuat tagihan. Coba lagi nanti.");
      return;
    }
    await db.query(
      `INSERT INTO xclipaibot_topups (order_id, telegram_id, amount, total_amount, video_count, signature, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, telegramId, amount, d.total_amount || amount, videos, d.signature || null]
    );
    const total = d.total_amount || amount;
    const caption =
      `💳 *Top-up ${videos} video*\n\n` +
      `Harga: Rp${PRICE_PER_VIDEO.toLocaleString("id-ID")}/video\n` +
      `Total bayar: *Rp${Number(total).toLocaleString("id-ID")}*\n` +
      `Scan QRIS di atas pakai e-wallet / m-banking apa saja.\n\n` +
      `⏳ Berlaku sampai: ${d.expired_at || "-"}\n\n` +
      `Setelah bayar, saldo bertambah otomatis. Kalau lama, tekan "Cek pembayaran".`;
    const keyboard = {
      inline_keyboard: [
        ...(d.direct_url ? [[{ text: "🔗 Halaman bayar", url: d.direct_url }]] : []),
        [{ text: "✅ Cek pembayaran", callback_data: `topupcheck:${orderId}` }],
      ],
    };
    if (d.qris_url) {
      await bot.sendPhoto(chatId, d.qris_url, { caption, parse_mode: "Markdown", reply_markup: keyboard });
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } catch (err) {
    console.error("[topup] create error:", err.response?.data || err.message);
    bot.sendMessage(chatId, "Gagal membuat tagihan QRIS. Coba lagi nanti.");
  }
}

async function handleTopupQty(query) {
  const chatId = query.message.chat.id;
  const videos = parseInt(query.data.split(":")[1], 10);
  if (!Number.isInteger(videos)) { bot.answerCallbackQuery(query.id, { text: "Jumlah tidak dikenal." }); return; }
  bot.answerCallbackQuery(query.id, { text: "Membuat tagihan QRIS..." });
  await createTopupOrder(chatId, query.from, videos);
}

async function handleTopupCheck(query) {
  const chatId = query.message.chat.id;
  const orderId = query.data.split(":").slice(1).join(":");
  bot.answerCallbackQuery(query.id, { text: "Mengecek pembayaran..." });
  try {
    const row = (await db.query("SELECT * FROM xclipaibot_topups WHERE order_id = $1", [orderId])).rows[0];
    if (!row) { bot.sendMessage(chatId, "Transaksi tidak ditemukan."); return; }
    if (row.status === "PAID") {
      bot.sendMessage(chatId, "✅ Pembayaran ini sudah lunas & saldo sudah ditambahkan.");
      return;
    }
    const res = await checkKlikqrisStatus(orderId);
    const st = String(res?.data?.status || "").toUpperCase();
    if (st === "PAID" || st === "SUCCESS") {
      const credited = await creditTopupIfPaid(orderId);
      if (credited) {
        bot.sendMessage(chatId, `✅ Pembayaran diterima! Saldo +${credited.videoCount} video.\n💳 Saldo sekarang: ${credited.balance} video.`);
      } else {
        bot.sendMessage(chatId, "✅ Pembayaran sudah diproses.");
      }
    } else if (st === "EXPIRED") {
      await db.query("UPDATE xclipaibot_topups SET status = 'EXPIRED' WHERE order_id = $1 AND status = 'PENDING'", [orderId]);
      bot.sendMessage(chatId, "⌛ QRIS sudah kedaluwarsa. Silakan /topup lagi.");
    } else {
      bot.sendMessage(chatId, "⏳ Pembayaran belum masuk. Coba lagi beberapa saat setelah kamu bayar.");
    }
  } catch (err) {
    console.error("[topup] check error:", err.response?.data || err.message);
    bot.sendMessage(chatId, "Gagal cek status. Coba lagi nanti.");
  }
}

// ===== Auto-poll top-up (fallback andal kalau webhook tidak terdaftar) =====
// KlikQRIS "MY PG v2" tidak punya kolom pendaftaran webhook di dashboard, jadi
// kita tidak bergantung pada webhook: bot mengecek sendiri status semua order
// PENDING secara berkala dan mengkredit saldo otomatis begitu PAID. Idempotent
// (creditTopupIfPaid) jadi aman walau webhook/tombol manual juga jalan. Sweep ini
// juga tetap bekerja setelah bot restart (baca dari DB, bukan timer in-memory).
const TOPUP_POLL_INTERVAL_MS = 15000;
const TOPUP_POLL_WINDOW_MINUTES = 120; // berhenti poll order yang lebih tua dari ini
const TOPUP_POLL_CONCURRENCY = 3;      // batasi request paralel (pool DB shared, max 5)
let topupPollRunning = false;

async function pollOnePendingTopup(order) {
  const orderId = order.order_id;
  try {
    const res = await checkKlikqrisStatus(orderId);
    const st = String(res?.data?.status || "").toUpperCase();
    if (st === "PAID" || st === "SUCCESS") {
      const credited = await creditTopupIfPaid(orderId);
      if (credited) {
        bot.sendMessage(
          credited.telegramId,
          `✅ Pembayaran diterima! Saldo +${credited.videoCount} video.\n\n💳 Saldo sekarang: ${credited.balance} video.\n\nLangsung kirim foto + video lalu /generate.`
        ).catch(() => {});
      }
    } else if (st === "EXPIRED") {
      await db.query("UPDATE xclipaibot_topups SET status = 'EXPIRED' WHERE order_id = $1 AND status = 'PENDING'", [orderId]);
    }
  } catch (err) {
    // Jangan spam log; error transien akan dicoba lagi pada sweep berikutnya.
    console.error("[topup] poll error", orderId, err.response?.data?.message || err.message);
  }
}

async function sweepPendingTopups() {
  if (!db || !KLIKQRIS_API_KEY || !KLIKQRIS_MERCHANT_ID) return;
  if (topupPollRunning) return; // cegah sweep menumpuk
  topupPollRunning = true;
  try {
    // Poll hanya order PENDING yang masih dalam jendela waktu, untuk membatasi
    // beban API/DB. Order yang lebih tua TIDAK dipaksa EXPIRED (itu bisa memblokir
    // kredit untuk pembayaran yang sah) — dibiarkan PENDING; masih bisa dikreditkan
    // lewat tombol "Cek pembayaran" atau ketika provider melaporkan status final.
    const pending = (await db.query(
      `SELECT order_id, telegram_id FROM xclipaibot_topups
       WHERE status = 'PENDING'
         AND created_at > NOW() - ($1 || ' minutes')::interval
       ORDER BY created_at ASC
       LIMIT 200`,
      [String(TOPUP_POLL_WINDOW_MINUTES)]
    )).rows;
    for (let i = 0; i < pending.length; i += TOPUP_POLL_CONCURRENCY) {
      const batch = pending.slice(i, i + TOPUP_POLL_CONCURRENCY);
      await Promise.all(batch.map(pollOnePendingTopup));
    }
  } catch (err) {
    console.error("[topup] sweep error:", err.message);
  } finally {
    topupPollRunning = false;
  }
}

function startTopupPoller() {
  if (!KLIKQRIS_API_KEY || !KLIKQRIS_MERCHANT_ID) {
    console.log("[topup] auto-poll nonaktif (KLIKQRIS creds belum diset).");
    return;
  }
  setInterval(() => { sweepPendingTopups(); }, TOPUP_POLL_INTERVAL_MS);
  console.log(`[topup] auto-poll aktif tiap ${TOPUP_POLL_INTERVAL_MS / 1000}s (fallback tanpa webhook).`);
}

async function downloadTelegramFile(fileId) {
  const file = await bot.getFile(fileId);
  const telegramUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
  const ext = path.extname(file.file_path) || "";
  const filename = crypto.randomBytes(16).toString("hex") + ext;
  const localPath = path.join(UPLOAD_DIR, filename);

  const dlConfig = { responseType: "stream", timeout: 60000 };
  console.log(`[DIRECT] Downloading Telegram file (no proxy for file downloads)`);
  const response = await axios.get(telegramUrl, dlConfig);
  const writer = fs.createWriteStream(localPath);
  response.data.pipe(writer);

  await new Promise((resolve, reject) => {
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  const publicUrl = getPublicFileUrl(filename);
  console.log(`File downloaded: ${filename}, publicUrl: ${publicUrl}, telegramUrl: ${telegramUrl.substring(0, 60)}...`);
  return { filename, localPath, publicUrl, telegramUrl };
}

function cleanupFile(localPath) {
  try {
    if (localPath && fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  } catch (err) {
    console.error("Cleanup error:", err.message);
  }
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    autoStart: false,
    params: { timeout: 30 },
  },
});

(async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await bot.deleteWebHook({ drop_pending_updates: true });
      console.log("Webhook cleared, starting polling...");
      break;
    } catch (e) {
      console.log(`Clear webhook attempt ${attempt + 1} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  bot.startPolling();
})();

process.once("SIGTERM", () => {
  console.log("SIGTERM received, stopping bot...");
  bot.stopPolling();
  setTimeout(() => process.exit(0), 2000);
});

process.once("SIGINT", () => {
  console.log("SIGINT received, stopping bot...");
  bot.stopPolling();
  setTimeout(() => process.exit(0), 2000);
});

const userSessions = {};

function sessionKey(msg) {
  return `${msg.chat.id}:${msg.from.id}`;
}

function getSession(msg) {
  const key = sessionKey(msg);
  if (!userSessions[key]) {
    userSessions[key] = {
      imageFile: null,
      videoFile: null,
      prompt: null,
      orientation: "video",
      quality: "std",
      isGenerating: false,
      selectedModel: "kling-2-6-pro-mc",
    };
  }
  return userSessions[key];
}

async function authenticateUser(loginInput, password) {
  if (!db) return { success: false, error: "Database tidak tersedia." };
  try {
    const result = await db.query(
      "SELECT id, username, email, password_hash FROM users WHERE username = $1 OR email = $1",
      [loginInput]
    );
    if (result.rows.length === 0) {
      return { success: false, error: "Username/email tidak ditemukan." };
    }
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return { success: false, error: "Password salah." };
    }
    return { success: true, userId: user.id, username: user.username };
  } catch (err) {
    console.error("Auth error:", err.message);
    return { success: false, error: "Gagal mengakses database." };
  }
}

async function checkSubscription(userId) {
  if (!db) return { active: false, reason: "Database tidak tersedia." };
  try {
    const motionResult = await db.query(
      `SELECT ms.id, ms.expired_at, ms.is_active, ms.created_at, mr.name as room_name
       FROM motion_subscriptions ms
       LEFT JOIN motion_rooms mr ON ms.motion_room_id = mr.id
       WHERE ms.user_id = $1 AND ms.is_active = true AND ms.expired_at > NOW()
       ORDER BY ms.expired_at DESC LIMIT 1`,
      [userId]
    );
    if (motionResult.rows.length > 0) {
      const sub = motionResult.rows[0];
      return {
        active: true,
        expiredAt: sub.expired_at,
        planName: sub.room_name || "Motion Control",
      };
    }

    const subResult = await db.query(
      `SELECT s.id, s.expired_at, s.status, s.created_at, sp.name as plan_name, sp.duration_days
       FROM subscriptions s
       LEFT JOIN subscription_plans sp ON s.plan_id = sp.id
       WHERE s.user_id = $1 AND s.status = 'active' AND s.expired_at > NOW()
       ORDER BY s.expired_at DESC LIMIT 1`,
      [userId]
    );
    if (subResult.rows.length > 0) {
      const sub = subResult.rows[0];
      return {
        active: true,
        expiredAt: sub.expired_at,
        planName: sub.plan_name || "xclip Premium",
      };
    }

    return { active: false, reason: "Kamu belum punya langganan aktif. Hubungi admin untuk berlangganan." };
  } catch (err) {
    console.error("Subscription check error:", err.message);
    return { active: false, reason: "Gagal mengecek langganan." };
  }
}

function resetSession(msg, fullReset = false) {
  const key = sessionKey(msg);
  const session = userSessions[key];
  if (!session) return;

  cleanupFile(session.imageFile?.localPath);
  cleanupFile(session.videoFile?.localPath);

  if (fullReset) {
    delete userSessions[key];
  } else {
    session.imageFile = null;
    session.videoFile = null;
    session.prompt = null;
    session.duration = "5";
    session.awaitingPrompt = false;
    session.awaitingTopupQty = false;
    session.orientation = "video";
    session.motionStrength = 0.5;
    session.selectedModel = "kling-2-6-pro-mc";
    session.isGenerating = false;
  }
}

// Identitas otomatis: setiap pesan me-refresh data user (nama/@username) dan
// membuat baris saldo (default 0) bila belum ada. Tidak perlu login.
bot.on("message", (msg) => {
  if (msg.from && !msg.from.is_bot) {
    ensureUser(msg.from.id, msg.from.username, msg.from.first_name).catch(() => {});
  }
});

bot.onText(/\/start/, async (msg) => {
  resetSession(msg);
  await ensureUser(msg.from.id, msg.from.username, msg.from.first_name);
  const balance = await getBalance(msg.from.id);
  bot.sendMessage(
    msg.chat.id,
`🎬 AI Video Generator Bot

Bot ini menghasilkan video pakai model 🔥 Kling MC V3 PRO (foto karakter + video referensi gerakan).

💳 Saldo kamu: ${balance} video
1 video = 1 saldo (dipotong HANYA kalau video berhasil).

Cara pakai:
1️⃣ Kirim foto karakter
2️⃣ Kirim video referensi gerakan
3️⃣ /generate → langsung proses

Perintah:
/start - Mulai ulang
/saldo - Cek sisa saldo
/generate - Generate video
/prompt [teks] - Set prompt tambahan
/link email password - Klaim saldo dari langganan lama (sekali saja)
/status - Cek status
/reset - Reset foto/video

Catatan:
• Butuh saldo untuk generate. Habis? /topup (segera hadir) atau hubungi admin.
• Foto: JPG/PNG/WEBP. Video: MP4/MOV/WEBM (max 20MB).`
  );
});

bot.onText(/\/saldo/, async (msg) => {
  const chatId = msg.chat.id;
  await ensureUser(msg.from.id, msg.from.username, msg.from.first_name);
  const bal = await getBalance(msg.from.id);
  let text = `💳 Saldo kamu: ${bal} video\n\n1 video = 1 saldo (dipotong hanya kalau video berhasil).`;
  if (bal <= 0) {
    text += `\n\n⚠️ Saldo habis. Isi lewat /topup (segera hadir) atau hubungi admin.`;
  }
  bot.sendMessage(chatId, text);
});

// Migrasi user lama: klaim saldo dari langganan yang masih aktif, SEKALI saja.
bot.onText(/\/link(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;
  const args = (match[1] || "").trim().split(/\s+/).filter(Boolean);

  if (args.length < 2) {
    bot.sendMessage(chatId, "Format: /link email password\n\nUntuk klaim saldo dari langganan lama kamu (sekali saja). Pesan ini otomatis dihapus demi keamanan.");
    return;
  }

  const [email, password] = args;
  // Hapus pesan berisi password demi keamanan.
  try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}

  if (!db) {
    bot.sendMessage(chatId, "Database tidak tersedia. Coba lagi nanti.");
    return;
  }

  await ensureUser(telegramId, msg.from.username, msg.from.first_name);

  try {
    const existing = await db.query(
      "SELECT converted FROM xclipaibot_users WHERE telegram_id = $1",
      [telegramId]
    );
    if (existing.rows[0]?.converted) {
      bot.sendMessage(chatId, "✅ Kamu sudah pernah klaim saldo dari langganan lama. Tidak bisa klaim lagi.");
      return;
    }

    const auth = await authenticateUser(email, password);
    if (!auth.success) {
      bot.sendMessage(chatId, "Gagal: email/username atau password salah.");
      return;
    }

    // Cegah satu akun diklaim oleh banyak Telegram ID.
    const claimed = await db.query(
      "SELECT telegram_id FROM xclipaibot_users WHERE linked_user_id = $1 AND telegram_id <> $2",
      [auth.userId, telegramId]
    );
    if (claimed.rows.length > 0) {
      bot.sendMessage(chatId, "Akun ini sudah pernah ditautkan ke Telegram lain.");
      return;
    }

    const sub = await checkSubscription(auth.userId);
    if (!sub.active) {
      await db.query(
        "UPDATE xclipaibot_users SET linked_user_id = $1, updated_at = NOW() WHERE telegram_id = $2",
        [auth.userId, telegramId]
      );
      bot.sendMessage(chatId, "Akun berhasil ditautkan, tapi kamu tidak punya langganan aktif untuk dikonversi.\n\nIsi saldo lewat /topup (segera hadir) atau hubungi admin.");
      return;
    }

    // Konversi atomik + anti double-claim (WHERE converted = FALSE).
    const upd = await db.query(
      `UPDATE xclipaibot_users
         SET balance = balance + $1, linked_user_id = $2, converted = TRUE, updated_at = NOW()
       WHERE telegram_id = $3 AND converted = FALSE
       RETURNING balance`,
      [CONVERSION_CREDITS, auth.userId, telegramId]
    );
    if (upd.rows.length === 0) {
      bot.sendMessage(chatId, "✅ Kamu sudah pernah klaim saldo dari langganan lama.");
      return;
    }

    bot.sendMessage(chatId, `✅ Berhasil! Langganan lama kamu dikonversi jadi ${CONVERSION_CREDITS} video.\n\n💳 Saldo sekarang: ${upd.rows[0].balance} video.\n\nLangsung kirim foto + video lalu /generate.`);
  } catch (err) {
    // 23505 = pelanggaran unique index linked_user_id: akun sudah diklaim Telegram lain
    // (menangkap race dua /link paralel untuk akun yang sama).
    if (err.code === "23505") {
      bot.sendMessage(chatId, "Akun ini sudah pernah ditautkan ke Telegram lain.");
      return;
    }
    console.error("[link] error:", err.message);
    bot.sendMessage(chatId, "Terjadi kesalahan saat memproses. Coba lagi nanti.");
  }
});

bot.onText(/\/topup(?:@\w+)?(?:\s+(\d+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  await ensureUser(msg.from.id, msg.from.username, msg.from.first_name);
  if (!KLIKQRIS_API_KEY || !KLIKQRIS_MERCHANT_ID) {
    bot.sendMessage(chatId, "Fitur top-up belum aktif. Hubungi admin.");
    return;
  }
  const qty = match && match[1] ? parseInt(match[1], 10) : null;
  if (qty) {
    await createTopupOrder(chatId, msg.from, qty);
    return;
  }
  const session = getSession(msg);
  session.awaitingTopupQty = true;
  bot.sendMessage(
    chatId,
    `💳 *Top-up Saldo*\n\nHarga: *Rp${PRICE_PER_VIDEO.toLocaleString("id-ID")} / video*.\n\nKetik *jumlah video* yang mau kamu beli (angka saja), contoh: 5\n\nNanti kamu dapat QRIS. Setelah bayar, saldo bertambah otomatis.\n\n(Batas ${TOPUP_MIN_VIDEOS}–${TOPUP_MAX_VIDEOS} video sekali top-up.)`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/topuphistory(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  try {
    const filterId = match[1] ? match[1].trim() : null;
    const q = filterId
      ? await db.query("SELECT * FROM xclipaibot_topups WHERE telegram_id = $1 ORDER BY created_at DESC LIMIT 20", [filterId])
      : await db.query("SELECT * FROM xclipaibot_topups ORDER BY created_at DESC LIMIT 20");
    if (q.rows.length === 0) {
      bot.sendMessage(chatId, "Belum ada transaksi top-up.");
      return;
    }
    let text = "📊 Riwayat top-up terbaru:\n\n";
    for (const r of q.rows) {
      const icon = r.status === "PAID" ? "✅" : r.status === "EXPIRED" ? "⌛" : "⏳";
      text += `${icon} ${r.order_id}\n  user ${r.telegram_id} · Rp${Number(r.total_amount).toLocaleString("id-ID")} · ${r.video_count} video · ${r.status}\n`;
    }
    bot.sendMessage(chatId, text);
  } catch (err) {
    console.error("[topup] history error:", err.message);
    bot.sendMessage(chatId, "Gagal mengambil riwayat top-up.");
  }
});

bot.onText(/\/reset/, (msg) => {
  resetSession(msg);
  bot.sendMessage(msg.chat.id, "Session direset. Silakan kirim foto dan video baru.");
});

bot.onText(/\/status/, async (msg) => {
  const session = getSession(msg);
  const telegramId = msg.from.id;
  const balance = await getBalance(telegramId);
  const cd = getCooldownRemaining(telegramId);
  const lines = [
    "📋 Status:",
    `💳 Saldo: ${balance} video`,
    `Foto: ${session.imageFile ? "Sudah ada" : "Belum"}`,
    `Video: ${session.videoFile ? "Sudah ada" : "Belum"}`,
    `Prompt: ${session.prompt || "(kosong)"}`,
    `Orientasi: ${session.orientation}`,
    `Generating: ${session.isGenerating ? "Ya" : "Tidak"}`,
    `Cooldown: ${cd > 0 ? `${Math.ceil(cd / 60000)} menit lagi` : "Siap generate"}`,
  ];
  bot.sendMessage(msg.chat.id, lines.join("\n"));
});

bot.on("text", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const session = getSession(msg);

  if (session.awaitingTopupQty) {
    session.awaitingTopupQty = false;
    const t = (msg.text || "").trim();
    if (/^\d+$/.test(t)) {
      await createTopupOrder(chatId, msg.from, parseInt(t, 10));
    } else {
      bot.sendMessage(chatId, "Top-up dibatalkan (harus berupa angka). Ketik /topup lagi ya.");
    }
    return;
  }

  if (session.awaitingPrompt) {
    session.prompt = msg.text.trim();
    session.awaitingPrompt = false;
    const selectedModelConfig = session.selectedModel ? MODELS[session.selectedModel] : null;
    if (selectedModelConfig && selectedModelConfig.fixedDuration) {
      session.duration = selectedModelConfig.fixedDuration;
      const modelText = `${selectedModelConfig.emoji} ${selectedModelConfig.name}`;
      bot.sendMessage(chatId, `✅ Prompt: "${session.prompt}"\n⏱ Durasi: ${session.duration} detik (fixed)\n\nModel: ${modelText}\n\nSemua siap! Ketik /generate untuk mulai.`);
    } else {
      bot.sendMessage(chatId, `✅ Prompt: "${session.prompt}"\n\nPilih durasi video:`, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "⏱ 5 Detik", callback_data: "dur_5" },
              { text: "⏱ 10 Detik", callback_data: "dur_10" },
            ],
          ],
        },
      });
    }
    return;
  }
});

bot.onText(/\/prompt (.+)/, (msg, match) => {
  const session = getSession(msg);
  session.prompt = match[1].trim();
  bot.sendMessage(msg.chat.id, `Prompt diset: "${session.prompt}"`);
});

bot.onText(/\/orientation (video|image)/, (msg, match) => {
  const session = getSession(msg);
  session.orientation = match[1];
  bot.sendMessage(msg.chat.id, `Orientasi diset: ${session.orientation}`);
});

bot.onText(/\/quality/, (msg) => {
  bot.sendMessage(msg.chat.id, "Kualitas kini terintegrasi dalam pilihan model.\n\nGunakan /generate lalu pilih model 🔥 Kling MC V3 PRO.");
});

bot.onText(/\/addkeys(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  let input = (match[1] || "").trim();
  if (msg.reply_to_message && msg.reply_to_message.text) {
    input = input ? input + "\n" + msg.reply_to_message.text.trim() : msg.reply_to_message.text.trim();
  }
  const fullText = msg.text || "";
  const commandEnd = fullText.indexOf(" ");
  if (commandEnd > 0) {
    input = fullText.substring(commandEnd).trim();
  }
  if (!input) {
    bot.sendMessage(chatId, "Format:\n1. /addkeys key1,key2,key3,...\n2. /addkeys lalu key per baris\n3. Reply pesan berisi key dengan /addkeys");
    return;
  }
  const keys = input.split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    bot.sendMessage(chatId, "Tidak ada key yang valid.");
    return;
  }
  bot.sendMessage(chatId, `⏳ Memproses ${keys.length} key...`);
  let added = 0;
  let duplicate = 0;
  for (const key of keys) {
    try {
      const res = await db.query(
        "INSERT INTO api_key_pool (api_key, status) VALUES ($1, 'available') ON CONFLICT (api_key) DO NOTHING RETURNING api_key",
        [key]
      );
      if (res.rowCount > 0) added++;
      else duplicate++;
    } catch (err) {
      duplicate++;
    }
  }
  bot.sendMessage(chatId, `✅ Berhasil menambahkan ${added} key baru ke pool.${duplicate > 0 ? `\n⚠️ ${duplicate} key sudah ada/duplikat.` : ""}\n\nTotal diproses: ${keys.length}`);
});

bot.onText(/\/poolstatus/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  try {
    const total = await db.query("SELECT COUNT(*) as count FROM api_key_pool");
    const totalKeys = parseInt(total.rows[0].count, 10);
    const inUse = lockedKeys.size;
    const onCooldown = Object.values(keyFailures).filter(f => f.until > Date.now()).length;
    const idle = Math.max(0, totalKeys - inUse - onCooldown);

    bot.sendMessage(chatId,
      `📊 Pool Status (mode rotasi):\n\n` +
      `Total key: ${totalKeys}\n` +
      `Sedang dipakai: ${inUse}\n` +
      `Cooldown (rate limit): ${onCooldown}\n` +
      `Siap dipakai: ${idle}\n\n` +
      `ℹ️ Key dirotasi bergiliran, tidak nempel ke user.\n` +
      `ℹ️ Key mati langsung dihapus otomatis.\n` +
      `ℹ️ Maks generate berbarengan = jumlah key.`
    );
  } catch (err) {
    console.error("Pool status error:", err.message);
    bot.sendMessage(chatId, "Gagal mengambil status pool.");
  }
});

bot.onText(/\/returnkeys(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }

  try {
    const targetUserId = match[1] ? match[1].trim() : null;

    if (!targetUserId) {
      const allAssigned = await db.query(
        "SELECT ua.user_id, ua.api_key FROM user_api_keys ua ORDER BY ua.user_id"
      );
      if (allAssigned.rows.length === 0) {
        bot.sendMessage(chatId, "Tidak ada key yang sedang di-assign ke user.");
        return;
      }

      const grouped = {};
      for (const row of allAssigned.rows) {
        if (!grouped[row.user_id]) grouped[row.user_id] = [];
        grouped[row.user_id].push(row.api_key.slice(-6));
      }

      let text = "Key yang sedang di-assign:\n\n";
      for (const [uid, keys] of Object.entries(grouped)) {
        text += `User ${uid}: ${keys.map(k => `...${k}`).join(", ")}\n`;
      }
      text += `\nUntuk kembalikan key user tertentu:\n/returnkeys <user_id>`;
      bot.sendMessage(chatId, text);
      return;
    }

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const userKeys = await client.query(
        "SELECT api_key FROM user_api_keys WHERE user_id = $1", [targetUserId]
      );

      if (userKeys.rows.length === 0) {
        await client.query("COMMIT");
        bot.sendMessage(chatId, `User ${targetUserId} tidak punya key yang di-assign.`);
        return;
      }

      for (const row of userKeys.rows) {
        await client.query(
          "UPDATE api_key_pool SET status = 'available', assigned_to = NULL WHERE api_key = $1 AND status = 'assigned'",
          [row.api_key]
        );
      }
      await client.query("DELETE FROM user_api_keys WHERE user_id = $1", [targetUserId]);
      await client.query("COMMIT");

      bot.sendMessage(chatId, `${userKeys.rows.length} key dari user ${targetUserId} dikembalikan ke pool.`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Return keys error:", err.message);
    bot.sendMessage(chatId, "Gagal mengembalikan key: " + err.message);
  }
});

bot.onText(/\/resetlimit(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  const targetId = match[1] ? match[1].trim() : null;
  if (!targetId) {
    bot.sendMessage(chatId, "Format: /resetlimit <telegram_id>\n\nMenghapus cooldown user tersebut supaya bisa generate lagi.");
    return;
  }
  userCooldowns.delete(targetId);
  userCooldowns.delete(Number(targetId));
  bot.sendMessage(chatId, `✅ Cooldown user ${targetId} sudah direset. Siap generate lagi.`);
});

bot.onText(/\/addcredit(?:\s+(\d+)\s+(-?\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  if (!match[1] || match[2] === undefined) {
    bot.sendMessage(chatId, "Format: /addcredit <telegram_id> <jumlah>\n\nContoh: /addcredit 123456789 50\n(pakai angka negatif untuk mengurangi saldo)");
    return;
  }
  const targetId = match[1].trim();
  const amount = parseInt(match[2], 10);
  if (!Number.isFinite(amount) || amount === 0) {
    bot.sendMessage(chatId, "Jumlah tidak valid.");
    return;
  }
  try {
    const newBal = await addBalance(targetId, amount);
    bot.sendMessage(chatId, `✅ Saldo user ${targetId} sekarang: ${newBal} video (${amount >= 0 ? "+" : ""}${amount}).`);
    bot.sendMessage(targetId, `💳 Saldo kamu ${amount >= 0 ? "ditambah" : "dikurangi"} ${Math.abs(amount)} oleh admin.\nSaldo sekarang: ${newBal} video.`).catch(() => {});
  } catch (err) {
    console.error("[addcredit] error:", err.message);
    bot.sendMessage(chatId, "Gagal mengubah saldo. Coba lagi nanti.");
  }
});

bot.onText(/\/users/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  if (!db) {
    bot.sendMessage(chatId, "Database tidak tersedia.");
    return;
  }
  try {
    const totals = await db.query("SELECT COUNT(*)::int n, COALESCE(SUM(balance),0)::int s FROM xclipaibot_users");
    const res = await db.query(
      "SELECT telegram_id, username, first_name, balance FROM xclipaibot_users ORDER BY balance DESC, updated_at DESC LIMIT 50"
    );
    if (res.rows.length === 0) {
      bot.sendMessage(chatId, "Belum ada user.");
      return;
    }
    let text = `👥 Users: ${totals.rows[0].n} | Total saldo: ${totals.rows[0].s} video\n\n`;
    for (const r of res.rows) {
      const name = r.first_name || "-";
      const uname = r.username ? `@${r.username}` : "-";
      text += `• ${name} ${uname} | ${r.telegram_id} | 💳 ${r.balance}\n`;
    }
    if (res.rows.length === 50) text += `\n(menampilkan 50 teratas berdasarkan saldo)`;
    bot.sendMessage(chatId, text);
  } catch (err) {
    console.error("[users] error:", err.message);
    bot.sendMessage(chatId, "Gagal mengambil daftar user.");
  }
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);

  try {
    const photo = msg.photo[msg.photo.length - 1];
    cleanupFile(session.imageFile?.localPath);
    session.imageFile = await downloadTelegramFile(photo.file_id);

    const modelConfig = session.selectedModel ? MODELS[session.selectedModel] : null;

    if (modelConfig && modelConfig.motionControl) {
      let reply = "✅ Foto karakter diterima!";
      if (session.videoFile) {
        reply += "\n\nFoto + video sudah lengkap. Ketik /generate untuk mulai.";
      } else {
        reply += "\n\nSekarang kirim video referensi gerakan, lalu ketik /generate.";
      }
      bot.sendMessage(chatId, reply);
    } else {
      session.awaitingPrompt = true;
      bot.sendMessage(chatId, "✅ Foto karakter diterima!\n\n✏️ Ketik prompt untuk video (deskripsi gerakan/adegan yang diinginkan):");
    }
  } catch (err) {
    console.error("Error processing photo:", err.message);
    bot.sendMessage(chatId, "Gagal memproses foto. Coba kirim ulang.");
  }
});

bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);

  try {
    if (msg.video.file_size && msg.video.file_size > 20 * 1024 * 1024) {
      bot.sendMessage(chatId, "Video terlalu besar (max 20MB). Kompres dulu atau kirim video yang lebih kecil.");
      return;
    }
    cleanupFile(session.videoFile?.localPath);
    session.videoFile = await downloadTelegramFile(msg.video.file_id);

    let reply = "Video referensi diterima!";
    if (!session.imageFile) {
      reply += "\n\nSekarang kirim foto karakter.";
    } else {
      reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
    }
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error processing video:", err.message);
    if (err.message.includes("file is too big")) {
      bot.sendMessage(chatId, "Video terlalu besar (max 20MB). Kompres dulu atau kirim video yang lebih kecil.");
    } else {
      bot.sendMessage(chatId, "Gagal memproses video. Coba kirim ulang.");
    }
  }
});

bot.on("animation", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);

  try {
    cleanupFile(session.videoFile?.localPath);
    session.videoFile = await downloadTelegramFile(msg.animation.file_id);

    let reply = "✅ GIF/animasi diterima sebagai video referensi!";
    if (!session.imageFile) {
      reply += "\n\nSekarang kirim foto karakter juga.";
    } else {
      reply += "\n\nFoto + video sudah lengkap. Ketik /generate untuk mulai.";
    }
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error processing animation:", err.message);
    bot.sendMessage(chatId, "Gagal memproses animasi. Coba kirim ulang.");
  }
});

bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);
  const mimeType = msg.document.mime_type || "";

  try {
    if (mimeType.startsWith("image/")) {
      cleanupFile(session.imageFile?.localPath);
      session.imageFile = await downloadTelegramFile(msg.document.file_id);
      let reply = "✅ Foto karakter diterima (sebagai file)!";
      if (session.videoFile) {
        reply += "\n\nFoto + video sudah lengkap. Ketik /generate untuk mulai.";
      } else {
        reply += "\n\nKetik /generate untuk pilih model.\n\n💡 Jika pakai model Kling MC V3 PRO, kirim video referensi gerakan dulu sebelum /generate.";
      }
      bot.sendMessage(chatId, reply);
    } else if (mimeType.startsWith("video/")) {
      cleanupFile(session.videoFile?.localPath);
      session.videoFile = await downloadTelegramFile(msg.document.file_id);
      let reply = "Video referensi diterima (sebagai file)!";
      if (!session.imageFile) {
        reply += "\n\nSekarang kirim foto karakter.";
      } else {
        reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
      }
      bot.sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error("Error processing document:", err.message);
    bot.sendMessage(chatId, "Gagal memproses file. Coba kirim ulang.");
  }
});

function contentTypeFor(p) {
  const ext = path.extname(p || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.webm') return 'video/webm';
  return 'application/octet-stream';
}

// Flora hanya menerima media dari host allowlist (media.flora.ai / GCS / S3),
// jadi file harus di-upload dulu ke asset Flora. Alurnya: buat asset (signed-url)
// -> upload byte ke storage yang ditunjuk -> pakai URL media.flora.ai hasilnya.
async function uploadFloraAsset(apiKey, workspaceId, localPath, contentType) {
  const filename = path.basename(localPath);
  const createResp = await makeFloraRequest('POST', `${FLORA_BASE}/api/v1/assets`, apiKey, {
    source: 'signed-url',
    workspace_id: workspaceId,
    filename,
    content_type: contentType,
  });
  const data = createResp.data || {};
  const up = data.upload;
  const mediaUrl = data.url;
  if (!up || !up.url || !mediaUrl) {
    throw new Error('Flora tidak mengembalikan target upload asset.');
  }
  const fd = new FormData();
  for (const [k, v] of Object.entries(up.form_fields || {})) fd.append(k, String(v));
  fd.append(up.file_field || 'file', fs.createReadStream(localPath), { filename });
  try {
    await axios.post(up.url, fd, {
      headers: fd.getHeaders(),
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
  } catch (e) {
    // Kegagalan di sini adalah dari storage upload (ImageKit), BUKAN dari Flora
    // API key. Bungkus ulang tanpa `response` HTTP supaya submit loop tidak salah
    // menganggap key mati (401/402/403) lalu menghapusnya dari pool.
    const wrapped = new Error(`Gagal upload media ke Flora storage: ${e.response?.status || e.code || e.message}`);
    wrapped.isUploadError = true;
    throw wrapped;
  }
  return mediaUrl;
}

async function submitVideo(session, modelConfig) {
  const url = `${FLORA_BASE}/api/v1/generate`;

  console.log(`[flora] Submit model=${session.selectedModel}`);

  const orientation = session.orientation === 'image' ? 'image' : 'video';
  // Flora requires a non-empty top-level prompt for this model.
  const prompt = session.prompt || 'Animate the character in the image to follow the motion in the reference video.';

  const imageLocalPath = session.imageFile?.localPath;
  const videoLocalPath = session.videoFile?.localPath;
  if (!imageLocalPath || !fs.existsSync(imageLocalPath)) {
    throw new Error('File foto tidak ditemukan di server. Kirim ulang fotonya lalu /generate.');
  }
  if (modelConfig.requiresVideo && (!videoLocalPath || !fs.existsSync(videoLocalPath))) {
    throw new Error('File video tidak ditemukan di server. Kirim ulang videonya lalu /generate.');
  }

  // Di-upload sekali; URL media.flora.ai bersifat publik sehingga bisa dipakai
  // ulang lintas percobaan key kalau ada key yang mati saat submit.
  let floraImageUrl = null;
  let floraVideoUrl = null;
  console.log(`[flora] prompt: ${prompt}`);

  const poolKeys = await getPoolKeys();
  if (poolKeys.length === 0) {
    throw new Error("Tidak ada API key tersedia. Hubungi admin.");
  }

  console.log(`[flora] Pool punya ${poolKeys.length} key (mode rotasi)`);

  // Rotasi global round-robin: mulai dari posisi berbeda tiap generate.
  const start = globalRotation % poolKeys.length;
  globalRotation = (globalRotation + 1) % Number.MAX_SAFE_INTEGER;
  const rotatedKeys = [...poolKeys.slice(start), ...poolKeys.slice(0, start)];

  let lastError = null;
  const triedKeys = new Set();
  const queue = [...rotatedKeys];
  const MAX_RETRIES = Math.min(poolKeys.length, 20);
  let attempts = 0;
  let skippedBusy = false;

  while (queue.length > 0 && attempts < MAX_RETRIES) {
    const apiKey = queue.shift();
    if (triedKeys.has(apiKey)) continue;
    triedKeys.add(apiKey);

    const now = Date.now();
    const failure = keyFailures[apiKey];
    if (failure && failure.until > now) {
      console.log(`[flora] Key ...${apiKey.slice(-6)} on cooldown, skipping`);
      skippedBusy = true;
      continue;
    }

    // Key sedang dipakai generate lain -> lewati, jangan bentrok.
    if (lockedKeys.has(apiKey)) {
      console.log(`[flora] Key ...${apiKey.slice(-6)} sedang dipakai, skipping`);
      skippedBusy = true;
      continue;
    }

    attempts++;
    console.log(`[flora] Attempt ${attempts}/${MAX_RETRIES} using key ...${apiKey.slice(-6)}`);

    try {
      const modelId = await getFloraModelId(apiKey);
      const ctx = await getFloraContext(apiKey);

      // Upload media ke asset Flora (host allowlist). Sekali saja, lalu reuse.
      if (!floraImageUrl) {
        floraImageUrl = await uploadFloraAsset(apiKey, ctx.workspaceId, imageLocalPath, contentTypeFor(imageLocalPath));
        console.log(`[flora] image asset: ${floraImageUrl}`);
      }
      if (modelConfig.requiresVideo && !floraVideoUrl) {
        floraVideoUrl = await uploadFloraAsset(apiKey, ctx.workspaceId, videoLocalPath, contentTypeFor(videoLocalPath));
        console.log(`[flora] video asset: ${floraVideoUrl}`);
      }

      const params = { image_url: floraImageUrl, character_orientation: orientation };
      if (floraVideoUrl) params.video_url = floraVideoUrl;
      const body = { type: 'video', prompt, params };
      console.log(`[flora] params:`, JSON.stringify(params));

      const fullBody = { model: modelId, workspace_id: ctx.workspaceId, project_id: ctx.projectId, ...body };
      const response = await scheduleSubmit(() => makeFloraRequest('POST', url, apiKey, fullBody));
      markKeyOk(apiKey);
      lockKey(apiKey);
      session.apiKey = apiKey;
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const errData = err.response?.data;
      const errCode = (errData?.errorCode || errData?.error || '').toString().toLowerCase();
      const msg = errData?.message || errData?.detail || errData?.error || err.message;
      lastError = err;

      console.log(`[flora] Submit error: ${status} - ${errCode || ''} ${msg}`);

      // 401 unauthorized/invalid, 402 kredit habis, 403 forbidden -> key mati, hapus dari pool.
      if (status === 401 || status === 402 || status === 403) {
        const reason = status === 402 ? 'kredit habis'
                     : status === 401 ? 'invalid/unauthorized'
                     : 'forbidden';
        console.log(`[flora] Key ...${apiKey.slice(-6)} ${reason}, dihapus dari pool`);
        await deleteDeadKey(apiKey);
        continue;
      }

      // 429 rate limited -> key masih hidup, cooldown sebentar lalu coba key lain.
      if (status === 429) {
        console.log(`[flora] Key ...${apiKey.slice(-6)} rate limited, cooldown 60s`);
        markKeyFailed(apiKey, 60000);
        continue;
      }

      throw err;
    }
  }

  if (attempts >= MAX_RETRIES) {
    console.log(`[flora] Hit max retries (${MAX_RETRIES})`);
  }
  if (lastError) throw lastError;
  if (skippedBusy) {
    throw new Error("Semua API key sedang dipakai. Coba lagi beberapa menit lagi ya.");
  }
  throw new Error("Semua API key tidak tersedia. Coba lagi nanti.");
}

async function checkTaskStatus(pollTarget, apiKey) {
  if (!apiKey) throw new Error("API key is required for polling");
  if (!pollTarget) throw new Error("pollUrl/runId is required for polling");
  let url;
  if (/^https?:\/\//i.test(pollTarget)) {
    url = pollTarget;
  } else if (pollTarget.startsWith('/')) {
    url = `${FLORA_BASE}${pollTarget}`;
  } else {
    url = `${FLORA_BASE}/api/v1/runs/${pollTarget}`;
  }
  const response = await makeFloraRequest('GET', url, apiKey);
  return response.data;
}

// Flora is poll-only (no delivered webhooks). We poll the run's pollUrl until
// the status becomes completed/failed, or we hit the max wait window.
async function pollForResult(chatId, pollTarget, apiKey) {
  const maxWaitMs = 25 * 60 * 1000;
  const pollInterval = 15000;
  const maxAttempts = Math.ceil(maxWaitMs / pollInterval);
  let consecutiveErrors = 0;
  let totalWaitMs = 0;

  console.log(`[flora] Poll mode: poll only (15s), target=${pollTarget}`);

  for (let i = 0; i < maxAttempts; i++) {
    const intervalMs = pollInterval + Math.floor(Math.random() * 1000);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    totalWaitMs += intervalMs;

    try {
      const rawResult = await checkTaskStatus(pollTarget, apiKey);
      const result = rawResult?.data || rawResult;
      const status = (result?.status || "").toLowerCase();
      console.log(`[flora] Poll #${i + 1}: status=${status} (${Math.round(totalWaitMs / 1000)}s)`);
      consecutiveErrors = 0;

      if (status === "completed" || status === "succeeded" || status === "success") {
        console.log("[flora] Task completed! Full response:", JSON.stringify(rawResult));
        return result;
      } else if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
        console.log("[flora] Task failed! Full response:", JSON.stringify(rawResult));
        return result;
      }

      if (i > 0 && i % 4 === 0) {
        const elapsed = Math.round(totalWaitMs / 1000);
        bot.sendMessage(chatId, `Masih memproses... (${elapsed} detik)`);
      }
    } catch (err) {
      console.error(`[flora] Poll #${i + 1} error:`, err.response?.status, err.response?.data || err.message);
      consecutiveErrors++;

      if (consecutiveErrors >= 5) {
        console.log("[flora] 5 consecutive poll errors, continuing...");
        consecutiveErrors = 0;
      }
    }
  }

  return null;
}

bot.onText(/\/generate/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);
  const telegramId = msg.from.id;

  if (session.isGenerating) {
    bot.sendMessage(chatId, "Sedang dalam proses generate. Tunggu sampai selesai.");
    return;
  }

  const balance = await getBalance(telegramId);
  if (balance <= 0) {
    bot.sendMessage(chatId, "⚠️ Saldo video kamu habis (0).\n\nIsi saldo lewat /topup (segera hadir) atau hubungi admin. Cek /saldo.");
    return;
  }

  const cooldownLeft = getCooldownRemaining(telegramId);
  if (cooldownLeft > 0) {
    const minutesLeft = Math.ceil(cooldownLeft / 60000);
    const secondsLeft = Math.ceil(cooldownLeft / 1000);
    const timeText = minutesLeft >= 1 ? `${minutesLeft} menit` : `${secondsLeft} detik`;
    bot.sendMessage(chatId, `Cooldown aktif. Tunggu ${timeText} lagi sebelum generate berikutnya.`);
    return;
  }

  if (!session.imageFile) {
    bot.sendMessage(chatId, "Foto karakter belum ada. Kirim foto terlebih dahulu.");
    return;
  }

  const modelConfig = session.selectedModel ? MODELS[session.selectedModel] : null;

  if (modelConfig) {
    if (modelConfig.requiresVideo && !session.videoFile) {
      bot.sendMessage(chatId, `Model ${modelConfig.emoji} ${modelConfig.name} membutuhkan video referensi gerakan.\n\nKirim video dulu lalu ketik /generate lagi.`);
      return;
    }
    session.isGenerating = true;
    bot.sendMessage(chatId, `Model: ${modelConfig.emoji} ${modelConfig.name}\n\nMemulai generate video...\n${modelConfig.motionControl ? `Orientasi: ${session.orientation}\n` : `Durasi: ${session.duration || "5"} detik\n`}Prompt: ${session.prompt || "(default)"}\n\nProses ini bisa memakan waktu 3-8 menit.`);
    runGenerate(chatId, msg, session, modelConfig);
  } else {
    bot.sendMessage(chatId, "Pilih model AI untuk generate video:", {
      reply_markup: { inline_keyboard: getModelKeyboard() },
    });
  }
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "noop") {
    bot.answerCallbackQuery(query.id);
    return;
  }

  if (data.startsWith("topupqty:")) {
    await handleTopupQty(query);
    return;
  }

  if (data.startsWith("topupcheck:")) {
    await handleTopupCheck(query);
    return;
  }

  if (data === "dur_5" || data === "dur_10") {
    const session = getSession({ chat: query.message.chat, from: query.from });
    session.duration = data === "dur_5" ? "5" : "10";
    bot.answerCallbackQuery(query.id);
    const modelConfig = session.selectedModel ? MODELS[session.selectedModel] : null;
    const modelText = modelConfig ? `${modelConfig.emoji} ${modelConfig.name}` : "belum dipilih";
    try {
      await bot.editMessageText(
        `✅ Prompt: "${session.prompt}"\n⏱ Durasi: ${session.duration} detik\n\nModel: ${modelText}\n\nSemua siap! Ketik /generate untuk mulai.`,
        { chat_id: chatId, message_id: query.message.message_id }
      );
    } catch (e) {
      bot.sendMessage(chatId, `⏱ Durasi: ${session.duration} detik\n\nSemua siap! Ketik /generate untuk mulai.`);
    }
    return;
  }

  if (!data.startsWith("model_")) return;

  const modelKey = data.replace("model_", "");
  const modelConfig = MODELS[modelKey];

  if (!modelConfig) {
    bot.answerCallbackQuery(query.id, { text: "Model tidak dikenal." });
    return;
  }

  const msg = { chat: query.message.chat, from: query.from };
  const session = getSession(msg);

  if (session.isGenerating) {
    bot.answerCallbackQuery(query.id, { text: "Sedang dalam proses generate." });
    return;
  }

  session.selectedModel = modelKey;
  bot.answerCallbackQuery(query.id);

  if (!session.imageFile) {
    let instruksi = `${modelConfig.emoji} Model dipilih: *${modelConfig.name}*\n\n`;
    if (modelConfig.motionControl) {
      instruksi += `Kirim:\n1️⃣ Foto karakter\n2️⃣ Video referensi gerakan\n\nLalu ketik /generate untuk mulai.`;
    } else {
      instruksi += `Kirim:\n1️⃣ Foto karakter\n\nLalu ketik /generate untuk mulai.`;
    }
    try {
      await bot.editMessageText(instruksi, { chat_id: chatId, message_id: query.message.message_id, parse_mode: "Markdown" });
    } catch (e) {
      bot.sendMessage(chatId, instruksi, { parse_mode: "Markdown" });
    }
    return;
  }

  if (modelConfig.requiresVideo && !session.videoFile) {
    bot.sendMessage(chatId, `Model ${modelConfig.emoji} ${modelConfig.name} membutuhkan video referensi gerakan.\n\nKirim video dulu lalu ketik /generate lagi.`);
    return;
  }

  session.isGenerating = true;
  runGenerate(chatId, msg, session, modelConfig);
});

async function runGenerate(chatId, msg, session, modelConfig) {
  try {
    const submitStart = Date.now();
    const submitResult = await submitVideo(session, modelConfig);
    const submitTime = ((Date.now() - submitStart) / 1000).toFixed(1);
    console.log("[flora] Full submit response:", JSON.stringify(submitResult));
    const runId = submitResult?.run_id || submitResult?.runId || submitResult?.id || submitResult?.data?.run_id;
    const pollUrl = submitResult?.poll_url || submitResult?.pollUrl || submitResult?.data?.poll_url || runId;

    if (!pollUrl) {
      console.error("[flora] No runId/pollUrl in response:", JSON.stringify(submitResult));
      bot.sendMessage(chatId, "Gagal submit task. Response tidak valid dari API.");
      if (session.apiKey) unlockKey(session.apiKey);
      session.isGenerating = false;
      return;
    }

    console.log(`[flora] Job ${runId} submitted in ${submitTime}s (pollUrl=${pollUrl})`);
    setCooldown(msg.from.id);
    bot.sendMessage(chatId, `Task berhasil disubmit! (${submitTime}s)\nModel: ${modelConfig.name}\nJob ID: ${runId || '-'}\nCooldown: 3 menit\n\nMenunggu hasil...`);

    const pollStart = Date.now();
    const result = await pollForResult(chatId, pollUrl, session.apiKey);
    const pollTime = ((Date.now() - pollStart) / 1000).toFixed(1);
    console.log(`[flora] Job ${runId} polling finished in ${pollTime}s`);

    if (!result) {
      bot.sendMessage(chatId, "Timeout: Video belum selesai setelah 20 menit. Coba lagi nanti.");
      if (session.apiKey) unlockKey(session.apiKey);
      session.isGenerating = false;
      return;
    }

    const jobStatus = (result?.status || "").toLowerCase();

    if (jobStatus === "completed" || jobStatus === "succeeded" || jobStatus === "success") {
      console.log("[flora] Full completed result:", JSON.stringify(result));

      // Flora returns outputs: [{ type, url }]. Prefer these; fall back to a deep scan.
      function extractUrls(obj) {
        const urls = [];
        if (!obj) return urls;
        if (typeof obj === "string") {
          if (obj.startsWith("http")) urls.push(obj);
          return urls;
        }
        if (Array.isArray(obj)) {
          for (const item of obj) urls.push(...extractUrls(item));
          return urls;
        }
        if (typeof obj === "object") {
          const directKeys = ["url", "video_url", "video", "download_url", "src", "output", "outputs"];
          for (const key of directKeys) {
            if (obj[key]) urls.push(...extractUrls(obj[key]));
          }
          if (urls.length === 0) {
            for (const key of Object.keys(obj)) {
              if (!directKeys.includes(key)) urls.push(...extractUrls(obj[key]));
            }
          }
        }
        return urls;
      }

      let videoUrls = [];
      if (Array.isArray(result.outputs)) {
        videoUrls = result.outputs.map(o => (typeof o === 'string' ? o : o?.url)).filter(Boolean);
      }
      if (videoUrls.length === 0) {
        videoUrls = extractUrls(result);
      }
      console.log("[flora] All extracted URLs from result:", videoUrls);

      const uniqueUrls = [...new Set(videoUrls)];
      console.log("[flora] Extracted video URLs:", uniqueUrls);

      if (uniqueUrls.length > 0) {
        let deliveredAny = false;
        for (const videoUrl of uniqueUrls) {
          const videoCaption = `✅ Video selesai! Model: ${modelConfig.emoji} ${modelConfig.name}\n\nPrompt: ${session.prompt || "(default)"}`;
          let sent = false;
          let keepFile = false;
          let localPath = null;

          // Selalu download dulu ke SERVER KITA. URL Flora tidak pernah
          // diberikan ke Telegram — semua pengiriman lewat domain kita.
          try {
            const fname = `out_${crypto.randomBytes(8).toString("hex")}.mp4`;
            localPath = path.join(UPLOAD_DIR, fname);
            const resp = await axios.get(videoUrl, { responseType: "arraybuffer", timeout: 120000 });
            fs.writeFileSync(localPath, Buffer.from(resp.data));
            console.log("[deliver] Video downloaded ke server kita");
          } catch (eDl) {
            console.error("[deliver] download gagal:", eDl.message);
          }

          // 1) Kirim lewat URL SERVER KITA (Telegram fetch dari domain kita, ≤20MB).
          if (localPath && fs.existsSync(localPath) && PUBLIC_DOMAIN) {
            try {
              const ourUrl = getPublicFileUrl(path.basename(localPath));
              await bot.sendVideo(chatId, ourUrl, { caption: videoCaption });
              sent = true;
              console.log("[deliver] Video sent via URL server kita");
            } catch (e1) {
              console.error("[deliver] sendVideo(our url) failed:", e1.message);
            }
          }

          // 2) Fallback: upload bytes dari server kita langsung ke Telegram (≤50MB).
          if (!sent && localPath && fs.existsSync(localPath)) {
            try {
              await bot.sendVideo(chatId, localPath, { caption: videoCaption });
              sent = true;
              console.log("[deliver] Video sent via upload dari server kita");
            } catch (e2) {
              console.error("[deliver] local upload failed:", e2.message);
            }
          }

          // 3) Last resort (video >50MB): kirim LINK server kita. File dipertahankan.
          if (!sent && localPath && fs.existsSync(localPath) && PUBLIC_DOMAIN) {
            try {
              const ourUrl = getPublicFileUrl(path.basename(localPath));
              await bot.sendMessage(chatId, `${videoCaption}\n\n🔗 Tonton di sini:\n${ourUrl}`, { disable_web_page_preview: false });
              sent = true;
              keepFile = true;
              console.log("[deliver] Video sent via LINK server kita");
            } catch (e3) {
              console.error("[deliver] our link failed:", e3.message);
            }
          }

          // Bersihkan file kecuali dikirim sebagai link (link butuh file tetap ada).
          if (localPath && fs.existsSync(localPath) && !keepFile) {
            try { fs.unlinkSync(localPath); } catch (_) {}
          }

          if (!sent) {
            bot.sendMessage(chatId, "Video selesai tapi gagal dikirim. Coba /generate lagi ya.");
          } else {
            deliveredAny = true;
          }
        }

        // Potong 1 saldo HANYA kalau video benar-benar terkirim ke user
        // (bukan saat submit, bukan saat gagal, bukan kalau pengiriman gagal total).
        if (deliveredAny) {
          const newBalance = await deductBalance(msg.from.id, 1);
          if (newBalance !== null) {
            bot.sendMessage(chatId, `💳 Saldo dipotong 1. Sisa saldo: ${newBalance} video.`);
          } else {
            console.error(`[saldo] deduct gagal untuk ${msg.from.id} walau video terkirim (saldo tidak cukup / race)`);
          }
        }
      } else {
        console.log("[deliver] No video URLs found. Full response:", JSON.stringify(result));
        bot.sendMessage(chatId, "Video selesai tapi hasilnya tidak bisa diambil. Coba /generate lagi ya.");
      }
    } else {
      const errDetail = result?.error_message || result?.error_code || result?.errorCode || result?.error || result?.message || JSON.stringify(result);
      console.error(`[deliver] Generation failed status=${jobStatus} detail=${errDetail}`);
      bot.sendMessage(chatId, "Generate gagal diproses. Coba /generate lagi ya.");
    }

    if (session.apiKey) unlockKey(session.apiKey);
    resetSession(msg);
  } catch (err) {
    const errStatus = err.response?.status || 'N/A';
    const errBody = err.response?.data ? JSON.stringify(err.response.data).substring(0, 500) : 'N/A';
    console.error(`[flora] Generate error: status=${errStatus} message=${err.message} body=${errBody}`);
    const errorMsg = err.response?.data?.message || err.response?.data?.detail || err.response?.data?.error || err.message || 'Unknown error';
    console.error(`[deliver] runGenerate error: ${errorMsg}`);
    // Jangan bocorkan detail backend ke user; hanya tampilkan pesan aman.
    const leaks = /flora|http|workspace|project|\bfal\b/i.test(errorMsg);
    const userMsg = leaks ? "Terjadi kendala saat memproses. Coba /generate lagi ya." : errorMsg;
    bot.sendMessage(chatId, userMsg);
    if (session.apiKey) unlockKey(session.apiKey);
    session.isGenerating = false;
  }
}

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.code, err.message);
});

startTopupPoller();
console.log("Bot Telegram AI Video Generator (Flora AI - Kling MC V3 PRO) sudah berjalan!");
console.log(`Model tersedia: ${Object.keys(MODELS).join(", ")}`);
console.log(`Admin IDs: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "(tidak diset - /addkeys dan /poolstatus tidak bisa diakses)"}`);
console.log(`Keys per user: ${KEYS_PER_USER}`);
