const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN;
const RAILWAY_DB_URL = process.env.RAILWAY_DATABASE_URL;

let db = null;
if (RAILWAY_DB_URL) {
  db = new Pool({
    connectionString: RAILWAY_DB_URL,
    ssl: { rejectUnauthorized: false },
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
          assigned_to INTEGER,
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
    .then(() => db.query("ALTER TABLE user_api_keys ALTER COLUMN user_id TYPE BIGINT").catch(() => {}))
    .then(() => console.log("user_api_keys table ready"))
    .catch((err) => console.error("Database connection error:", err.message));
} else {
  console.warn("RAILWAY_DATABASE_URL not set - login feature disabled");
}

if (!TELEGRAM_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const API_BASE = "https://api.freepik.com";
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(id => id.trim()).filter(Boolean);
const KEYS_PER_USER = 2;

let VPS_PROXIES = [];

function initProxy() {
  const bulkVar = process.env.VPS_PROXIES;
  if (bulkVar) {
    bulkVar.split(',').map(e => e.trim()).filter(Boolean).forEach(entry => {
      const parts = entry.split(':');
      if (parts.length >= 2) {
        VPS_PROXIES.push({
          host: parts[0],
          port: parseInt(parts[1]),
          username: parts[2] || null,
          password: parts[3] || null
        });
      }
    });
  }
  console.log(`Proxy initialized: ${VPS_PROXIES.length} proxy(s)`);
}

initProxy();

function buildProxyUrl(proxy) {
  if (proxy.username && proxy.password) {
    return `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  }
  return `http://${proxy.host}:${proxy.port}`;
}

function freepikHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'x-freepik-api-key': apiKey.replace(/[^\x20-\x7E]/g, '').trim()
  };
}

function isFreepikApiError(err) {
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

async function makeFreepikRequest(method, url, apiKey, body = null) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (VPS_PROXIES.length === 0) {
    const config = { method, url, headers: freepikHeaders(apiKey), timeout: 120000 };
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
      headers: freepikHeaders(apiKey),
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
        throw new Error('Blocked by Freepik');
      }
      return resp;
    } catch (err) {
      const status = err.response?.status;

      if (status === 429) throw err;
      if (status === 401 && isFreepikApiError(err)) throw err;
      if (status === 402 && isFreepikApiError(err)) throw err;
      if (status === 403 && isFreepikApiError(err)) throw err;

      const errMsg = (err.message || '').toLowerCase();
      const isSocketErr = errMsg.includes('socket') || errMsg.includes('econnreset') ||
                          errMsg.includes('etimedout') || errMsg.includes('ssl') ||
                          errMsg.includes('econnrefused') || errMsg.includes('enotfound');
      const isProxyBlock = (status === 403 && !isFreepikApiError(err)) ||
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

  throw new Error('Proxy gagal setelah semua percobaan. Coba lagi nanti.');
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
      "UPDATE api_key_pool SET status = 'dead', dead_at = NOW() WHERE api_key = $1",
      [deadKey]
    );
    await client.query(
      "DELETE FROM user_api_keys WHERE user_id = $1 AND api_key = $2",
      [userId, deadKey]
    );
    console.log(`[pool] Key ...${deadKey.slice(-6)} marked dead for user ${userId}`);

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
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const express = require("express");
const app = express();
const FILE_SERVER_PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/files", express.static(UPLOAD_DIR));

const pendingTasks = new Map();

app.get("/", (req, res) => {
  res.json({ status: "ok", bot: "Kling 2.6 Motion Control", pendingTasks: pendingTasks.size });
});

app.post("/webhook/freepik", async (req, res) => {
  try {
    const payload = req.body;
    console.log("[WEBHOOK] Received:", JSON.stringify(payload).substring(0, 1000));

    const taskId = payload?.data?.task_id || payload?.task_id || payload?.id;
    if (!taskId) {
      console.log("[WEBHOOK] No task_id found in payload");
      return res.status(400).json({ error: "No task_id" });
    }

    const taskInfo = pendingTasks.get(taskId);
    if (!taskInfo) {
      console.log(`[WEBHOOK] Unknown task ${taskId}, ignoring`);
      return res.status(200).json({ ok: true });
    }

    const result = payload?.data || payload;
    const status = (result?.status || "").toUpperCase();
    console.log(`[WEBHOOK] Task ${taskId} status=${status}`);

    if (status === "COMPLETED" || status === "FAILED" || status === "ERROR") {
      taskInfo.resolve(result);
      pendingTasks.delete(taskId);
      console.log(`[WEBHOOK] Task ${taskId} resolved (${status})`);
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK] Error:", err.message);
    res.status(500).json({ error: err.message });
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

const COOLDOWN_MS = 10 * 60 * 1000;
const DAILY_LIMIT = 10;
const userCooldowns = new Map();
const userDailyUsage = new Map();
const userKeyRotation = new Map();

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyUsage(userId) {
  const entry = userDailyUsage.get(userId);
  const today = getTodayKey();
  if (!entry || entry.date !== today) return 0;
  return entry.count;
}

function incrementDailyUsage(userId) {
  const today = getTodayKey();
  const entry = userDailyUsage.get(userId);
  if (!entry || entry.date !== today) {
    userDailyUsage.set(userId, { date: today, count: 1 });
  } else {
    entry.count++;
  }
}

function getDailyRemaining(userId) {
  return Math.max(0, DAILY_LIMIT - getDailyUsage(userId));
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

async function downloadTelegramFile(fileId) {
  const file = await bot.getFile(fileId);
  const telegramUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
  const ext = path.extname(file.file_path) || "";
  const filename = crypto.randomBytes(16).toString("hex") + ext;
  const localPath = path.join(UPLOAD_DIR, filename);

  const response = await axios.get(telegramUrl, { responseType: "stream" });
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
      loggedIn: false,
      userId: null,
      username: null,
      loginStep: null,
      loginEmail: null,
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
      const createdAt = new Date(sub.created_at || sub.expired_at);
      const expiredAt = new Date(sub.expired_at);
      const durationDays = (expiredAt - createdAt) / (1000 * 60 * 60 * 24);
      if (durationDays < 28) {
        return { active: false, reason: "Bot ini hanya untuk langganan bulanan. Paket harian/mingguan tidak bisa menggunakan bot ini." };
      }
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
      const durationDays = sub.duration_days || (() => {
        const createdAt = new Date(sub.created_at || sub.expired_at);
        const expiredAt = new Date(sub.expired_at);
        return (expiredAt - createdAt) / (1000 * 60 * 60 * 24);
      })();
      if (durationDays < 28) {
        return { active: false, reason: "Bot ini hanya untuk langganan bulanan. Paket harian/mingguan tidak bisa menggunakan bot ini." };
      }
      return {
        active: true,
        expiredAt: sub.expired_at,
        planName: sub.plan_name || "xclip Premium",
      };
    }

    return { active: false, reason: "Kamu belum punya langganan bulanan aktif. Hubungi admin untuk berlangganan paket bulanan." };
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
    session.orientation = "video";
    session.quality = "std";
    session.isGenerating = false;
    session.loginStep = null;
    session.loginEmail = null;
  }
}

bot.onText(/\/start/, (msg) => {
  const session = getSession(msg);
  const wasLoggedIn = session.loggedIn;
  const savedUsername = session.username;
  const savedUserId = session.userId;
  resetSession(msg);
  if (wasLoggedIn) {
    const s = getSession(msg);
    s.loggedIn = true;
    s.username = savedUsername;
    s.userId = savedUserId;
  }
  bot.sendMessage(
    msg.chat.id,
`🎬 Kling 2.6 Motion Control Bot

Bot ini mentransfer gerakan dari video referensi ke gambar karakter menggunakan Kling Motion Control API.

Cara pakai:
1️⃣ Login dulu: /login email password
2️⃣ Kirim foto karakter
3️⃣ Kirim video referensi gerakan
4️⃣ Ketik /generate untuk mulai

Perintah:
/start - Mulai ulang
/login - Login dengan email/username xclip
/logout - Logout
/generate - Generate video
/prompt [teks] - Set prompt tambahan
/orientation [video|image] - Set orientasi karakter
/quality [std|pro] - Set kualitas (std = 720p, pro = 1080p)
/status - Cek status session saat ini
/reset - Reset session

Catatan:
• Harus login dan punya langganan bulanan aktif
• Foto: min 300x300px, max 10MB (JPG/PNG/WEBP)
• Video: durasi 3-30 detik, max 100MB (MP4/MOV/WEBM)
• Orientasi "video" = max 30 detik, "image" = max 10 detik`
  );
});

bot.onText(/\/login(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  console.log(`/login command received from chat ${chatId}`);
  const session = getSession(msg);

  if (session.loggedIn) {
    bot.sendMessage(chatId, `Kamu sudah login sebagai ${session.username}. Ketik /logout untuk keluar.`);
    return;
  }

  const input = (match[1] || "").trim();

  if (input) {
    const args = input.split(/\s+/);
    if (args.length >= 2) {
      const [loginInput, password] = args;
      try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
      await processLogin(chatId, msg, session, loginInput, password);
      return;
    }
  }

  session.loginStep = "email";
  session.loginEmail = null;
  bot.sendMessage(chatId, "Masukkan email atau username kamu:");
});

async function processLogin(chatId, msg, session, loginInput, password) {
  try {
    console.log(`Attempting login for: ${loginInput}`);
    const authResult = await authenticateUser(loginInput, password);
    console.log(`Auth result: success=${authResult.success}`);

    if (!authResult.success) {
      bot.sendMessage(chatId, "Login gagal: Email/username atau password salah.");
      session.loginStep = null;
      session.loginEmail = null;
      return;
    }

    const subResult = await checkSubscription(authResult.userId);

    if (!subResult.active) {
      session.loginStep = null;
      session.loginEmail = null;
      bot.sendMessage(chatId, `Login ditolak.\n\n⚠️ ${subResult.reason}`);
      return;
    }

    session.loggedIn = true;
    session.userId = authResult.userId;
    session.username = authResult.username;
    session.loginStep = null;
    session.loginEmail = null;

    const expDate = new Date(subResult.expiredAt).toLocaleDateString("id-ID", {
      day: "numeric", month: "long", year: "numeric",
    });
    bot.sendMessage(
      chatId,
      `Login berhasil! Selamat datang, ${authResult.username}.\n\nLangganan: ${subResult.planName} (Aktif)\nBerlaku sampai: ${expDate}\n\nSilakan kirim foto dan video, lalu ketik /generate.`
    );
  } catch (err) {
    console.error("Login error:", err);
    bot.sendMessage(chatId, "Terjadi kesalahan saat login. Coba lagi nanti.");
    session.loginStep = null;
    session.loginEmail = null;
  }
}

bot.onText(/\/logout/, (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);

  if (!session.loggedIn) {
    bot.sendMessage(chatId, "Kamu belum login.");
    return;
  }

  const username = session.username;
  resetSession(msg, true);
  bot.sendMessage(chatId, `Logout berhasil. Sampai jumpa, ${username}!`);
});

bot.onText(/\/reset/, (msg) => {
  resetSession(msg);
  bot.sendMessage(msg.chat.id, "Session direset. Silakan kirim foto dan video baru.");
});

bot.onText(/\/status/, async (msg) => {
  const session = getSession(msg);
  const lines = [
    "📋 Status Session:",
    `Login: ${session.loggedIn ? `Ya (${session.username})` : "Belum"}`,
  ];

  if (session.loggedIn) {
    const subResult = await checkSubscription(session.userId);
    if (subResult.active) {
      const expDate = new Date(subResult.expiredAt).toLocaleDateString("id-ID", {
        day: "numeric", month: "long", year: "numeric",
      });
      lines.push(`Langganan: Aktif - ${subResult.planName} (s/d ${expDate})`);
    } else {
      lines.push(`Langganan: Tidak aktif`);
    }
  }

  lines.push(
    `Foto: ${session.imageFile ? "Sudah ada" : "Belum"}`,
    `Video: ${session.videoFile ? "Sudah ada" : "Belum"}`,
    `Prompt: ${session.prompt || "(kosong)"}`,
    `Orientasi: ${session.orientation}`,
    `Kualitas: ${session.quality}`,
    `Generating: ${session.isGenerating ? "Ya" : "Tidak"}`,
    `Cooldown: ${session.userId ? (() => { const r = getCooldownRemaining(session.userId); return r > 0 ? `${Math.ceil(r / 60000)} menit lagi` : "Siap generate"; })() : "N/A"}`,
    `Generate hari ini: ${session.userId ? `${getDailyUsage(session.userId)}/${DAILY_LIMIT}` : "N/A"}`,
  );
  bot.sendMessage(msg.chat.id, lines.join("\n"));
});

bot.on("text", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;
  const chatId = msg.chat.id;
  const session = getSession(msg);

  if (!session.loginStep) return;

  if (session.loginStep === "email") {
    session.loginEmail = msg.text.trim();
    session.loginStep = "password";
    bot.sendMessage(chatId, "Masukkan password kamu:");
    return;
  }

  if (session.loginStep === "password") {
    const password = msg.text.trim();
    try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) {}
    await processLogin(chatId, msg, session, session.loginEmail, password);
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

bot.onText(/\/quality (std|pro)/, (msg, match) => {
  const session = getSession(msg);
  session.quality = match[1];
  const label = match[1] === "pro" ? "Pro (1080p)" : "Standard (720p)";
  bot.sendMessage(msg.chat.id, `Kualitas diset: ${label}`);
});

bot.onText(/\/addkeys(.*)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  const input = (match[1] || "").trim();
  if (!input) {
    bot.sendMessage(chatId, "Format: /addkeys key1,key2,key3,...");
    return;
  }
  const keys = input.split(",").map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    bot.sendMessage(chatId, "Tidak ada key yang valid.");
    return;
  }
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
  bot.sendMessage(chatId, `Berhasil menambahkan ${added} key baru ke pool.${duplicate > 0 ? `\n${duplicate} key sudah ada/duplikat.` : ""}`);
});

bot.onText(/\/poolstatus/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg)) {
    bot.sendMessage(chatId, "Hanya admin yang bisa menggunakan perintah ini.");
    return;
  }
  try {
    const total = await db.query("SELECT COUNT(*) as count FROM api_key_pool");
    const available = await db.query("SELECT COUNT(*) as count FROM api_key_pool WHERE status = 'available'");
    const assigned = await db.query("SELECT COUNT(*) as count FROM api_key_pool WHERE status = 'assigned'");
    const dead = await db.query("SELECT COUNT(*) as count FROM api_key_pool WHERE status = 'dead'");
    const users = await db.query("SELECT COUNT(DISTINCT user_id) as count FROM user_api_keys");

    bot.sendMessage(chatId,
      `📊 Pool Status:\n\n` +
      `Total key: ${total.rows[0].count}\n` +
      `Tersedia: ${available.rows[0].count}\n` +
      `Terpakai: ${assigned.rows[0].count}\n` +
      `Mati: ${dead.rows[0].count}\n` +
      `User dengan key: ${users.rows[0].count}\n` +
      `Key per user: ${KEYS_PER_USER}\n` +
      `Kapasitas user: ${Math.floor(available.rows[0].count / KEYS_PER_USER)} user lagi`
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

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);

  try {
    const photo = msg.photo[msg.photo.length - 1];
    cleanupFile(session.imageFile?.localPath);
    session.imageFile = await downloadTelegramFile(photo.file_id);

    let reply = "Foto karakter diterima!";
    if (!session.videoFile) {
      reply += "\n\nSekarang kirim video referensi gerakan.";
    } else {
      reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
    }
    bot.sendMessage(chatId, reply);
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

    let reply = "GIF/animasi diterima sebagai video referensi!";
    if (!session.imageFile) {
      reply += "\n\nSekarang kirim foto karakter.";
    } else {
      reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
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
      let reply = "Foto karakter diterima (sebagai file)!";
      if (!session.videoFile) {
        reply += "\n\nSekarang kirim video referensi gerakan.";
      } else {
        reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
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

async function submitMotionControl(session) {
  const quality = session.quality === "pro" ? "pro" : "std";
  const url = `${API_BASE}/v1/ai/video/kling-v2-6-motion-control-${quality}`;

  const imageUrl = session.imageFile.publicUrl;
  const videoUrl = session.videoFile.publicUrl;

  console.log(`[freepik] Submit quality=${quality}`);
  console.log(`[freepik] image_url: ${imageUrl}`);
  console.log(`[freepik] video_url: ${videoUrl}`);

  const webhookUrl = PUBLIC_DOMAIN ? `https://${PUBLIC_DOMAIN}/webhook/freepik` : null;

  const body = {
    image_url: imageUrl,
    video_url: videoUrl,
    character_orientation: session.orientation || "video",
    cfg_scale: 0.5,
  };

  if (webhookUrl) {
    body.webhook = webhookUrl;
    console.log(`[freepik] Webhook URL: ${webhookUrl}`);
  }

  if (session.prompt) {
    body.prompt = session.prompt;
  }

  const userKeys = await assignKeysToUser(session.userId);
  if (userKeys.length === 0) {
    throw new Error("Tidak ada API key tersedia. Hubungi admin.");
  }

  console.log(`[freepik] User ${session.userId} has ${userKeys.length} keys`);

  const userRoundRobin = userKeyRotation.get(session.userId) || 0;
  const rotatedKeys = [...userKeys.slice(userRoundRobin % userKeys.length), ...userKeys.slice(0, userRoundRobin % userKeys.length)];
  userKeyRotation.set(session.userId, userRoundRobin + 1);

  let lastError = null;

  for (const apiKey of rotatedKeys) {
    const now = Date.now();
    const failure = keyFailures[apiKey];
    if (failure && failure.until > now) {
      console.log(`[freepik] Key ...${apiKey.slice(-6)} on cooldown, skipping`);
      continue;
    }

    console.log(`[freepik] Using key ...${apiKey.slice(-6)}`);

    try {
      const response = await makeFreepikRequest('POST', url, apiKey, body);
      markKeyOk(apiKey);
      lockKey(apiKey);
      session.apiKey = apiKey;
      return response.data;
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.message || err.response?.data?.detail || err.message;
      lastError = err;

      console.log(`[freepik] Submit error: ${status} - ${msg}`);

      if (status === 429) {
        markKeyFailed(apiKey, 300000);
        console.log(`[freepik] Key ...${apiKey.slice(-6)} rate limited, cooldown 5min`);
        continue;
      }

      if (status === 401) {
        console.log(`[freepik] Key ...${apiKey.slice(-6)} invalid, replacing...`);
        await replaceDeadKey(session.userId, apiKey);
        continue;
      }

      if (status === 402 || status === 403) {
        console.log(`[freepik] Key ...${apiKey.slice(-6)} no balance/forbidden, replacing...`);
        await replaceDeadKey(session.userId, apiKey);
        continue;
      }

      throw err;
    }
  }

  if (lastError) throw lastError;
  throw new Error("Semua API key tidak tersedia. Coba lagi nanti.");
}

async function checkTaskStatus(taskId, apiKey) {
  if (!apiKey) throw new Error("API key is required for polling");
  const url = `${API_BASE}/v1/ai/image-to-video/kling-v2-6/${taskId}`;
  const response = await makeFreepikRequest('GET', url, apiKey);
  return response.data;
}

function waitForWebhook(taskId, timeoutMs = 25 * 60 * 1000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingTasks.delete(taskId);
      resolve(null);
    }, timeoutMs);

    pendingTasks.set(taskId, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      }
    });

    console.log(`[WEBHOOK] Waiting for task ${taskId} (timeout ${timeoutMs / 1000}s)`);
  });
}

async function pollForResult(chatId, taskId, apiKey) {
  const useWebhook = PUBLIC_DOMAIN && pendingTasks.has(taskId);
  const maxWaitMs = 25 * 60 * 1000;
  const pollInterval = useWebhook ? 30000 : 15000;
  const maxAttempts = Math.ceil(maxWaitMs / pollInterval);
  let consecutiveErrors = 0;
  let totalWaitMs = 0;

  console.log(`[freepik] Poll mode: ${useWebhook ? 'webhook + backup poll (30s)' : 'poll only (15s)'}`);

  for (let i = 0; i < maxAttempts; i++) {
    const intervalMs = pollInterval + Math.floor(Math.random() * 1000);

    if (useWebhook) {
      const webhookResult = await Promise.race([
        new Promise((resolve) => {
          const existing = pendingTasks.get(taskId);
          if (!existing) resolve(null);
          else {
            const origResolve = existing.resolve;
            existing.resolve = (result) => {
              origResolve(result);
              resolve(result);
            };
          }
        }),
        new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), intervalMs))
      ]);

      totalWaitMs += intervalMs;

      if (webhookResult && webhookResult !== 'TIMEOUT') {
        console.log(`[WEBHOOK] Got result for task ${taskId} via webhook! (${Math.round(totalWaitMs / 1000)}s)`);
        return webhookResult;
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      totalWaitMs += intervalMs;
    }

    try {
      const rawResult = await checkTaskStatus(taskId, apiKey);
      const result = rawResult?.data || rawResult;
      const status = (result?.status || "").toUpperCase();
      console.log(`[freepik] Poll #${i + 1} task ${taskId}: status=${status} (${Math.round(totalWaitMs / 1000)}s)`);
      consecutiveErrors = 0;

      if (status === "COMPLETED") {
        console.log("[freepik] Task completed! Full response:", JSON.stringify(rawResult));
        pendingTasks.delete(taskId);
        return result;
      } else if (status === "FAILED" || status === "ERROR") {
        console.log("[freepik] Task failed! Full response:", JSON.stringify(rawResult));
        pendingTasks.delete(taskId);
        return result;
      }

      if (i > 0 && i % 4 === 0) {
        const elapsed = Math.round(totalWaitMs / 1000);
        bot.sendMessage(chatId, `Masih memproses... (${elapsed} detik)`);
      }
    } catch (err) {
      console.error(`[freepik] Poll #${i + 1} error:`, err.response?.status, err.response?.data || err.message);
      consecutiveErrors++;

      if (consecutiveErrors >= 5) {
        console.log("[freepik] 5 consecutive poll errors, continuing...");
        consecutiveErrors = 0;
      }
    }
  }

  pendingTasks.delete(taskId);
  return null;
}

bot.onText(/\/generate/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);

  if (!session.loggedIn) {
    bot.sendMessage(chatId, "Kamu harus login dulu. Ketik: /login username password");
    return;
  }

  const subResult = await checkSubscription(session.userId);
  if (!subResult.active) {
    bot.sendMessage(chatId, `⚠️ ${subResult.reason}`);
    return;
  }

  if (session.isGenerating) {
    bot.sendMessage(chatId, "Sedang dalam proses generate. Tunggu sampai selesai.");
    return;
  }

  const dailyRemaining = getDailyRemaining(session.userId);
  if (dailyRemaining <= 0) {
    bot.sendMessage(chatId, `Batas harian tercapai (${DAILY_LIMIT}x/hari). Coba lagi besok.`);
    return;
  }

  const cooldownLeft = getCooldownRemaining(session.userId);
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

  if (!session.videoFile) {
    bot.sendMessage(chatId, "Video referensi belum ada. Kirim video terlebih dahulu.");
    return;
  }

  bot.sendMessage(chatId, "Pilih kualitas video:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚡ Standard (720p)", callback_data: "quality_std" },
          { text: "🔥 Pro (1080p)", callback_data: "quality_pro" },
        ],
      ],
    },
  });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!data.startsWith("quality_")) return;

  const msg = { chat: query.message.chat, from: query.from };
  const session = getSession(msg);

  if (!session.loggedIn) {
    bot.answerCallbackQuery(query.id, { text: "Kamu harus login dulu." });
    return;
  }

  if (session.isGenerating) {
    bot.answerCallbackQuery(query.id, { text: "Sedang dalam proses generate." });
    return;
  }

  if (!session.imageFile || !session.videoFile) {
    bot.answerCallbackQuery(query.id, { text: "Foto atau video belum lengkap." });
    return;
  }

  const quality = data === "quality_pro" ? "pro" : "std";
  session.quality = quality;
  session.isGenerating = true;

  const qualityLabel = quality === "pro" ? "Pro (1080p)" : "Standard (720p)";

  bot.answerCallbackQuery(query.id);
  try { await bot.editMessageText(`Kualitas: ${qualityLabel}\n\nMemulai generate motion control video...\nOrientasi: ${session.orientation}\nPrompt: ${session.prompt || "(default)"}\n\nProses ini bisa memakan waktu 3-8 menit.`, { chat_id: chatId, message_id: query.message.message_id }); } catch (e) {}

  try {
    const submitStart = Date.now();
    const submitResult = await submitMotionControl(session);
    const submitTime = ((Date.now() - submitStart) / 1000).toFixed(1);
    console.log("[freepik] Full submit response:", JSON.stringify(submitResult));
    const taskId = submitResult?.data?.task_id || submitResult?.task_id || submitResult?.id;

    if (!taskId) {
      console.error("[freepik] No task_id in response:", JSON.stringify(submitResult));
      bot.sendMessage(chatId, "Gagal submit task. Response tidak valid dari API.");
      if (session.apiKey) unlockKey(session.apiKey);
      session.isGenerating = false;
      return;
    }

    console.log(`[freepik] Job ${taskId} submitted in ${submitTime}s`);
    setCooldown(session.userId);
    incrementDailyUsage(session.userId);
    const remaining = getDailyRemaining(session.userId);
    const webhookActive = !!PUBLIC_DOMAIN;
    bot.sendMessage(chatId, `Task berhasil disubmit! (${submitTime}s)\nJob ID: ${taskId}\nCooldown: 10 menit\nSisa generate hari ini: ${remaining}/${DAILY_LIMIT}\nMode: ${webhookActive ? 'Webhook + Polling' : 'Polling'}\n\nMenunggu hasil...`);

    if (webhookActive) {
      waitForWebhook(taskId);
    }

    const pollStart = Date.now();
    const result = await pollForResult(chatId, taskId, session.apiKey);
    const pollTime = ((Date.now() - pollStart) / 1000).toFixed(1);
    console.log(`[freepik] Job ${taskId} polling finished in ${pollTime}s`);

    if (!result) {
      bot.sendMessage(chatId, "Timeout: Video belum selesai setelah 20 menit. Coba lagi nanti.");
      if (session.apiKey) unlockKey(session.apiKey);
      session.isGenerating = false;
      return;
    }

    const jobStatus = (result?.status || "").toUpperCase();

    if (jobStatus === "COMPLETED") {
      console.log("[freepik] Full completed result:", JSON.stringify(result));

      const generated = result.generated || result.videos || [];
      const videoUrls = Array.isArray(generated)
        ? generated.filter(u => typeof u === "string" && u.startsWith("http"))
        : [];

      const uniqueUrls = [...new Set(videoUrls)];
      console.log("[freepik] Extracted video URLs:", uniqueUrls);

      if (uniqueUrls.length > 0) {
        for (const videoUrl of uniqueUrls) {
          try {
            console.log("Downloading video:", videoUrl.substring(0, 120));
            const videoResponse = await axios.get(videoUrl, {
              responseType: "arraybuffer",
              timeout: 120000,
            });
            const tempPath = path.join(UPLOAD_DIR, `result_${Date.now()}.mp4`);
            fs.writeFileSync(tempPath, videoResponse.data);
            const fileSizeMB = fs.statSync(tempPath).size / (1024 * 1024);
            console.log(`Video downloaded: ${fileSizeMB.toFixed(2)} MB`);

            if (fileSizeMB > 50) {
              await bot.sendMessage(chatId, `Video terlalu besar untuk Telegram (${fileSizeMB.toFixed(1)}MB). Download di sini:\n${videoUrl}`);
              cleanupFile(tempPath);
            } else {
              await bot.sendVideo(chatId, tempPath, {
                caption: `Motion control video selesai! (${qualityLabel})`,
              });
              cleanupFile(tempPath);
              console.log("sendVideo success");
            }
          } catch (sendErr) {
            console.error("sendVideo failed:", sendErr.message);
            await bot.sendMessage(chatId, `Video selesai! Download di sini:\n${videoUrl}`);
          }
        }
      } else {
        console.log("[freepik] No video URLs found. Full response:", JSON.stringify(result));
        bot.sendMessage(chatId, `Video selesai tapi URL tidak ditemukan.\n\nDebug: ${JSON.stringify(result).substring(0, 500)}`);
      }
    } else {
      const errDetail = result?.error || result?.message || JSON.stringify(result);
      bot.sendMessage(chatId, `Generate gagal. Status: ${jobStatus}\n\nDetail: ${errDetail}`);
    }

    if (session.apiKey) unlockKey(session.apiKey);
    resetSession(msg);
  } catch (err) {
    const errStatus = err.response?.status || 'N/A';
    const errBody = err.response?.data ? JSON.stringify(err.response.data).substring(0, 500) : 'N/A';
    console.error(`[freepik] Generate error: status=${errStatus} message=${err.message} body=${errBody}`);
    const errorMsg = err.response?.data?.message || err.response?.data?.detail || err.response?.data?.error || err.message || 'Unknown error';
    bot.sendMessage(chatId, `Error: ${errorMsg}`);
    if (session.apiKey) unlockKey(session.apiKey);
    session.isGenerating = false;
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.code, err.message);
});

console.log("Bot Telegram Kling Motion Control (Freepik API) sudah berjalan!");
console.log(`Admin IDs: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(", ") : "(tidak diset - /addkeys dan /poolstatus tidak bisa diakses)"}`);
console.log(`Keys per user: ${KEYS_PER_USER}`);
