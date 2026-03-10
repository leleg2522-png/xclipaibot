const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.REPLIT_DEV_DOMAIN;

if (!TELEGRAM_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

if (!FREEPIK_API_KEY) {
  console.error("FREEPIK_API_KEY is not set");
  process.exit(1);
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

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

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
    };
  }
  return userSessions[key];
}

function resetSession(msg) {
  const key = sessionKey(msg);
  const session = userSessions[key];
  if (session) {
    cleanupFile(session.imageFile?.localPath);
    cleanupFile(session.videoFile?.localPath);
  }
  delete userSessions[key];
}

bot.onText(/\/start/, (msg) => {
  resetSession(msg);
  bot.sendMessage(
    msg.chat.id,
    `🎬 *Kling 2.6 Motion Control Bot*

Bot ini mentransfer gerakan dari video referensi ke gambar karakter menggunakan Freepik Kling 2.6 Motion Control API.

*Cara pakai:*
1️⃣ Kirim foto karakter
2️⃣ Kirim video referensi gerakan
3️⃣ Ketik /generate untuk mulai

*Perintah:*
/start \\- Mulai ulang
/generate \\- Generate video
/prompt \\[teks\\] \\- Set prompt tambahan
/orientation \\[video|image\\] \\- Set orientasi karakter
/quality \\[std|pro\\] \\- Set kualitas \\(std = 720p, pro = 1080p\\)
/status \\- Cek status session saat ini
/reset \\- Reset session

*Catatan:*
• Foto: min 300x300px, max 10MB \\(JPG/PNG/WEBP\\)
• Video: durasi 3\\-30 detik, max 100MB \\(MP4/MOV/WEBM\\)
• Orientasi "video" = max 30 detik, "image" = max 10 detik`,
    { parse_mode: "MarkdownV2" }
  );
});

bot.onText(/\/reset/, (msg) => {
  resetSession(msg);
  bot.sendMessage(msg.chat.id, "Session direset. Silakan kirim foto dan video baru.");
});

bot.onText(/\/status/, (msg) => {
  const session = getSession(msg);
  const lines = [
    "Status Session:",
    `Foto: ${session.imageFile ? "Sudah ada" : "Belum"}`,
    `Video: ${session.videoFile ? "Sudah ada" : "Belum"}`,
    `Prompt: ${session.prompt || "(kosong)"}`,
    `Orientasi: ${session.orientation}`,
    `Kualitas: ${session.quality}`,
    `Generating: ${session.isGenerating ? "Ya" : "Tidak"}`,
  ];
  bot.sendMessage(msg.chat.id, lines.join("\n"));
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
    bot.sendMessage(chatId, "Gagal memproses video. Coba kirim ulang.");
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

  const response = await axios.post(endpoint, body, {
    headers: {
      "Content-Type": "application/json",
      "x-freepik-api-key": FREEPIK_API_KEY,
    },
  });

  return response.data;
}

async function checkTaskStatus(taskId) {
  const url = `https://api.freepik.com/v1/ai/image-to-video/kling-v2-6/${taskId}`;

  const response = await axios.get(url, {
    headers: {
      "x-freepik-api-key": FREEPIK_API_KEY,
    },
  });

  return response.data;
}

async function pollForResult(chatId, taskId) {
  const maxAttempts = 120;
  const intervalMs = 10000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    try {
      const result = await checkTaskStatus(taskId);
      const status = result?.data?.status;

      if (status === "COMPLETED") {
        return result;
      } else if (status === "FAILED" || status === "ERROR") {
        return result;
      }

      if (i > 0 && i % 6 === 0) {
        const elapsed = Math.round(((i + 1) * intervalMs) / 1000);
        bot.sendMessage(chatId, `Masih memproses... (${elapsed} detik)`);
      }
    } catch (err) {
      console.error(`Poll attempt ${i + 1} error:`, err.message);
    }
  }

  return null;
}

bot.onText(/\/generate/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(msg);

  if (session.isGenerating) {
    bot.sendMessage(chatId, "Sedang dalam proses generate. Tunggu sampai selesai.");
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

  session.isGenerating = true;

  const qualityLabel = session.quality === "pro" ? "Pro (1080p)" : "Standard (720p)";
  bot.sendMessage(
    chatId,
    `Memulai generate motion control video...\n\nKualitas: ${qualityLabel}\nOrientasi: ${session.orientation}\nPrompt: ${session.prompt || "(default)"}\n\nProses ini bisa memakan waktu 1-5 menit.`
  );

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

    const result = await pollForResult(chatId, taskId);

    if (!result) {
      bot.sendMessage(chatId, "Timeout: Video belum selesai setelah 20 menit. Coba lagi nanti.");
      session.isGenerating = false;
      return;
    }

    const status = result?.data?.status;

    if (status === "COMPLETED") {
      const videoUrls = result?.data?.generated || [];
      if (videoUrls.length > 0) {
        for (const videoUrl of videoUrls) {
          try {
            await bot.sendVideo(chatId, videoUrl, {
              caption: "Motion control video selesai!",
            });
          } catch (sendErr) {
            await bot.sendMessage(chatId, `Video selesai! Download di sini:\n${videoUrl}`);
          }
        }
      } else {
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
