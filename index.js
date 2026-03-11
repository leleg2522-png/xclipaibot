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
    .then(() => console.log("Database Railway terhubung!"))
    .catch((err) => console.error("Database connection error:", err.message));
} else {
  console.warn("RAILWAY_DATABASE_URL not set - login feature disabled");
}

if (!TELEGRAM_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

const RAW_KEYS = process.env.FREEPIK_API_KEY || "";
const API_KEYS = RAW_KEYS.split(",").map((k) => k.trim()).filter(Boolean);

if (API_KEYS.length === 0) {
  console.error("FREEPIK_API_KEY is not set (provide one or more keys separated by commas)");
  process.exit(1);
}

const USE_PROXY = (process.env.USE_PROXY || "true").toLowerCase() === "true";
const RAW_PROXIES = process.env.PROXY_LIST || "";
const PROXIES = RAW_PROXIES.split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
  const parts = p.split(":");
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return p;
});

console.log(`Loaded ${API_KEYS.length} Freepik API key(s)`);
console.log(`Loaded ${PROXIES.length} proxy(ies)`);

let keyIndex = 0;
let proxyIndex = 0;
const keyFailures = {};
const proxyFailures = {};

function getNextApiKey() {
  const now = Date.now();
  for (let i = 0; i < API_KEYS.length; i++) {
    const idx = (keyIndex + i) % API_KEYS.length;
    const key = API_KEYS[idx];
    const failure = keyFailures[key];
    if (failure && failure.until > now) {
      continue;
    }
    keyIndex = (idx + 1) % API_KEYS.length;
    return key;
  }
  keyIndex = (keyIndex + 1) % API_KEYS.length;
  return API_KEYS[keyIndex];
}

function getNextProxy() {
  if (PROXIES.length === 0) return null;
  const now = Date.now();
  for (let i = 0; i < PROXIES.length; i++) {
    const idx = (proxyIndex + i) % PROXIES.length;
    const proxy = PROXIES[idx];
    const failure = proxyFailures[proxy];
    if (failure && failure.until > now) {
      continue;
    }
    proxyIndex = (idx + 1) % PROXIES.length;
    return proxy;
  }
  proxyIndex = (proxyIndex + 1) % PROXIES.length;
  return PROXIES[proxyIndex];
}

function getStickyProxyAgent(proxyUrl) {
  if (!USE_PROXY || !proxyUrl) return {};
  const agent = new HttpsProxyAgent(proxyUrl);
  console.log(`Using proxy: ${proxyUrl.replace(/:[^:@]+@/, ":***@")}`);
  return { httpsAgent: agent, httpAgent: agent, proxy: false };
}

function getProxyAgent() {
  if (!USE_PROXY) return {};
  const proxyUrl = getNextProxy();
  if (!proxyUrl) return {};
  const agent = new HttpsProxyAgent(proxyUrl);
  console.log(`Using proxy: ${proxyUrl.replace(/:[^:@]+@/, ":***@")}`);
  return { httpsAgent: agent, httpAgent: agent, proxy: false };
}

function markProxyFailed(proxyUrl, cooldownMs = 240000) {
  proxyFailures[proxyUrl] = { until: Date.now() + cooldownMs };
  console.log(`Proxy ${proxyUrl.replace(/:[^:@]+@/, ":***@")} cooldown for ${cooldownMs / 1000}s`);
}

function markProxyOk(proxyUrl) {
  delete proxyFailures[proxyUrl];
}

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

app.use("/files", express.static(UPLOAD_DIR));

app.get("/", (req, res) => {
  res.json({ status: "ok", bot: "Kling 2.6 Motion Control" });
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

  return { filename, localPath, publicUrl: getPublicFileUrl(filename) };
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
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log("Webhook cleared, starting polling...");
  } catch (e) {
    console.log("Clear webhook skipped:", e.message);
  }
  bot.startPolling();
})();

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
      `SELECT ms.id, ms.expired_at, ms.is_active, mr.name as room_name
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
      `SELECT s.id, s.expired_at, s.status, sp.name as plan_name
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

Bot ini mentransfer gerakan dari video referensi ke gambar karakter menggunakan Freepik Kling 2.6 Motion Control API.

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
• Harus login dan punya langganan Motion aktif
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

    session.loggedIn = true;
    session.userId = authResult.userId;
    session.username = authResult.username;
    session.loginStep = null;
    session.loginEmail = null;

    if (subResult.active) {
      const expDate = new Date(subResult.expiredAt).toLocaleDateString("id-ID", {
        day: "numeric", month: "long", year: "numeric",
      });
      bot.sendMessage(
        chatId,
        `Login berhasil! Selamat datang, ${authResult.username}.\n\nLangganan: ${subResult.planName} (Aktif)\nBerlaku sampai: ${expDate}\n\nSilakan kirim foto dan video, lalu ketik /generate.`
      );
    } else {
      bot.sendMessage(
        chatId,
        `Login berhasil! Selamat datang, ${authResult.username}.\n\n⚠️ ${subResult.reason}`
      );
    }
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
  const endpoint =
    session.quality === "pro"
      ? "https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-pro"
      : "https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-std";

  const body = {
    image_url: session.imageFile.publicUrl,
    video_url: session.videoFile.publicUrl,
    character_orientation: session.orientation,
    cfg_scale: 0.5,
  };

  if (session.prompt) {
    body.prompt = session.prompt;
  }

  console.log(`Submit image_url: ${body.image_url}`);
  console.log(`Submit video_url: ${body.video_url}`);

  const triedKeys = new Set();
  let lastError = null;

  for (let keyAttempt = 0; keyAttempt < API_KEYS.length; keyAttempt++) {
    const apiKey = getNextApiKey();
    if (triedKeys.has(apiKey)) continue;
    triedKeys.add(apiKey);
    console.log(`Using API key ...${apiKey.slice(-6)} for submit (attempt ${keyAttempt + 1}/${API_KEYS.length})`);

    const maxProxyRetries = Math.min(PROXIES.length + 1, 5);
    for (let attempt = 0; attempt < maxProxyRetries; attempt++) {
      const proxyUrl = getNextProxy();
      try {
        const response = await axios.post(endpoint, body, {
          headers: {
            "Content-Type": "application/json",
            "x-freepik-api-key": apiKey,
          },
          ...getStickyProxyAgent(proxyUrl),
        });
        markKeyOk(apiKey);
        if (proxyUrl) markProxyOk(proxyUrl);
        session.apiKey = apiKey;
        session.submitProxy = proxyUrl;
        return response.data;
      } catch (err) {
        const status = err.response?.status;
        const msg = err.response?.data?.message || err.message;
        lastError = err;

        if (status === 403 && msg.includes("blocked")) {
          if (proxyUrl) markProxyFailed(proxyUrl, 240000);
          console.log(`Submit blocked on proxy, trying next proxy...`);
          continue;
        }

        if (status === 429) {
          markKeyFailed(apiKey, 300000);
          console.log(`API key ...${apiKey.slice(-6)} rate limited (429), cooldown 5min, trying next key...`);
          break;
        }

        if (status === 403) {
          markKeyFailed(apiKey, 600000);
          console.log(`API key ...${apiKey.slice(-6)} forbidden (403), cooldown 10min, trying next key...`);
          break;
        }

        if (status === 401) {
          markKeyFailed(apiKey, 86400000);
          console.log(`API key ...${apiKey.slice(-6)} invalid/expired (401), disabled 24h, trying next key...`);
          break;
        }

        if (status === 402) {
          markKeyFailed(apiKey, 86400000);
          console.log(`API key ...${apiKey.slice(-6)} quota habis (402), disabled 24h, trying next key...`);
          break;
        }

        throw err;
      }
    }
  }

  if (lastError) throw lastError;
  throw new Error("Semua API key dan proxy tidak tersedia. Coba lagi nanti.");
}

async function checkTaskStatus(taskId, apiKey, stickyProxy) {
  const url = `https://api.freepik.com/v1/ai/image-to-video/kling-v2-6/${taskId}`;
  const key = apiKey || getNextApiKey();

  const proxyConfig = stickyProxy ? getStickyProxyAgent(stickyProxy) : getProxyAgent();
  const response = await axios.get(url, {
    headers: {
      "x-freepik-api-key": key,
    },
    ...proxyConfig,
  });

  return response.data;
}

async function pollForResult(chatId, taskId, apiKey) {
  const maxAttempts = 60;
  const baseIntervalMs = 20000;

  const stickyProxy = getNextProxy();
  console.log(`Task ${taskId} assigned to proxy: ${stickyProxy ? stickyProxy.replace(/:[^:@]+@/, ":***@") : "direct"}`);

  let consecutiveErrors = 0;

  for (let i = 0; i < maxAttempts; i++) {
    const waitMs = randomJitter(baseIntervalMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));

    try {
      const result = await checkTaskStatus(taskId, apiKey, stickyProxy);
      const status = result?.data?.status;
      console.log(`Poll #${i + 1} for task ${taskId}: status=${status}`);
      consecutiveErrors = 0;
      if (stickyProxy) markProxyOk(stickyProxy);

      if (status === "COMPLETED") {
        console.log("Task completed! Generated URLs:", JSON.stringify(result?.data?.generated));
        return result;
      } else if (status === "FAILED" || status === "ERROR") {
        console.log("Task failed:", JSON.stringify(result?.data));
        return result;
      }

      if (i > 0 && i % 4 === 0) {
        const elapsed = Math.round(((i + 1) * baseIntervalMs) / 1000);
        bot.sendMessage(chatId, `Masih memproses... (${elapsed} detik)`);
      }
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.message || err.message;
      console.error(`Poll attempt ${i + 1} error:`, status, err.response?.data || err.message);
      consecutiveErrors++;

      if (status === 403 && msg.includes("blocked")) {
        if (stickyProxy) markProxyFailed(stickyProxy, 240000);
        bot.sendMessage(chatId, "Proxy kena blokir, task ini gagal. Silakan coba /generate lagi.");
        return null;
      }

      if (consecutiveErrors >= 5) {
        bot.sendMessage(chatId, "Terlalu banyak error berturut-turut. Silakan coba /generate lagi.");
        return null;
      }
    }
  }

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

  if (session.lastGenerateTime) {
    const cooldownMs = 4 * 60 * 1000;
    const elapsed = Date.now() - session.lastGenerateTime;
    if (elapsed < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - elapsed) / 1000);
      bot.sendMessage(chatId, `Cooldown aktif. Tunggu ${remaining} detik lagi sebelum generate berikutnya.`);
      return;
    }
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
  session.lastGenerateTime = Date.now();

  const qualityLabel = quality === "pro" ? "Pro (1080p)" : "Standard (720p)";

  bot.answerCallbackQuery(query.id);
  try { await bot.editMessageText(`Kualitas dipilih: ${qualityLabel}\n\nMemulai generate motion control video...\nOrientasi: ${session.orientation}\nPrompt: ${session.prompt || "(default)"}\n\nProses ini bisa memakan waktu 3-8 menit.`, { chat_id: chatId, message_id: query.message.message_id }); } catch (e) {}

  try {
    const submitResult = await submitMotionControl(session);
    const taskId = submitResult?.data?.task_id;

    if (!taskId) {
      console.error("No task_id in response:", JSON.stringify(submitResult));
      bot.sendMessage(chatId, "Gagal submit task. Response tidak valid dari Freepik API.");
      session.isGenerating = false;
      return;
    }

    bot.sendMessage(chatId, `Task berhasil disubmit!\nTask ID: ${taskId}\n\nMenunggu hasil...`);

    const result = await pollForResult(chatId, taskId, session.apiKey);

    if (!result) {
      bot.sendMessage(chatId, "Timeout: Video belum selesai setelah 20 menit. Coba lagi nanti.");
      session.isGenerating = false;
      return;
    }

    const status = result?.data?.status;

    if (status === "COMPLETED") {
      const generated = result?.data?.generated || [];
      console.log("Sending video results:", JSON.stringify(generated));

      const videoUrls = generated.map((item) => {
        if (typeof item === "string") return item;
        return item?.video || item?.url || item?.src || null;
      }).filter(Boolean);

      console.log("Extracted video URLs:", videoUrls);

      if (videoUrls.length > 0) {
        for (const videoUrl of videoUrls) {
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
        console.log("No video URLs found in generated data:", JSON.stringify(generated));
        bot.sendMessage(chatId, "Video selesai tapi tidak ada URL hasil.");
      }
    } else {
      bot.sendMessage(chatId, `Generate gagal. Status: ${status}\n\nDetail: ${JSON.stringify(result?.data)}`);
    }

    resetSession(msg);
  } catch (err) {
    console.error("Generate error:", err.response?.data || err.message);
    const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
    bot.sendMessage(chatId, `Error: ${errorMsg}`);
    session.isGenerating = false;
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.code, err.message);
});

console.log("Bot Telegram Kling 2.6 Motion Control sudah berjalan!");
