const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;

if (!TELEGRAM_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is not set");
  process.exit(1);
}

if (!FREEPIK_API_KEY) {
  console.error("FREEPIK_API_KEY is not set");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

const userSessions = {};

function getSession(chatId) {
  if (!userSessions[chatId]) {
    userSessions[chatId] = {
      imageUrl: null,
      videoUrl: null,
      prompt: null,
      orientation: "video",
      quality: "std",
    };
  }
  return userSessions[chatId];
}

function resetSession(chatId) {
  delete userSessions[chatId];
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  resetSession(chatId);
  bot.sendMessage(
    chatId,
    `🎬 *Kling 2.6 Motion Control Bot*

Bot ini mentransfer gerakan dari video referensi ke gambar karakter menggunakan Freepik Kling 2.6 Motion Control API.

*Cara pakai:*
1️⃣ Kirim foto karakter (atau URL gambar)
2️⃣ Kirim video referensi gerakan (atau URL video)
3️⃣ Bot akan otomatis generate video motion control

*Perintah:*
/start - Mulai ulang
/generate - Generate video (jika foto & video sudah dikirim)
/prompt \\[teks\\] - Set prompt tambahan
/orientation \\[video|image\\] - Set orientasi karakter
/quality \\[std|pro\\] - Set kualitas (std = 720p, pro = 1080p)
/status - Cek status session saat ini
/reset - Reset session

*Catatan:*
• Foto: min 300x300px, max 10MB (JPG/PNG/WEBP)
• Video: durasi 3-30 detik, max 100MB (MP4/MOV/WEBM)
• Orientasi "video" = max 30 detik, "image" = max 10 detik`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/reset/, (msg) => {
  resetSession(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ Session direset. Silakan kirim foto dan video baru.");
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const status = [
    `📋 *Status Session:*`,
    `• Foto: ${session.imageUrl ? "✅ Sudah ada" : "❌ Belum"}`,
    `• Video: ${session.videoUrl ? "✅ Sudah ada" : "❌ Belum"}`,
    `• Prompt: ${session.prompt || "(kosong)"}`,
    `• Orientasi: ${session.orientation}`,
    `• Kualitas: ${session.quality}`,
  ];
  bot.sendMessage(chatId, status.join("\n"), { parse_mode: "Markdown" });
});

bot.onText(/\/prompt (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.prompt = match[1].trim();
  bot.sendMessage(chatId, `✅ Prompt diset: "${session.prompt}"`);
});

bot.onText(/\/orientation (video|image)/, (msg, match) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.orientation = match[1];
  bot.sendMessage(chatId, `✅ Orientasi diset: ${session.orientation}`);
});

bot.onText(/\/quality (std|pro)/, (msg, match) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  session.quality = match[1];
  const label = match[1] === "pro" ? "Pro (1080p)" : "Standard (720p)";
  bot.sendMessage(chatId, `✅ Kualitas diset: ${label}`);
});

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  try {
    const photo = msg.photo[msg.photo.length - 1];
    const file = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    session.imageUrl = fileUrl;

    let reply = "✅ Foto karakter diterima!";
    if (!session.videoUrl) {
      reply += "\n\nSekarang kirim video referensi gerakan.";
    } else {
      reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
    }
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error processing photo:", err.message);
    bot.sendMessage(chatId, "❌ Gagal memproses foto. Coba kirim ulang.");
  }
});

bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  try {
    const file = await bot.getFile(msg.video.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    session.videoUrl = fileUrl;

    let reply = "✅ Video referensi diterima!";
    if (!session.imageUrl) {
      reply += "\n\nSekarang kirim foto karakter.";
    } else {
      reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
    }
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error processing video:", err.message);
    bot.sendMessage(chatId, "❌ Gagal memproses video. Coba kirim ulang.");
  }
});

bot.on("animation", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  try {
    const file = await bot.getFile(msg.animation.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
    session.videoUrl = fileUrl;

    let reply = "✅ GIF/animasi diterima sebagai video referensi!";
    if (!session.imageUrl) {
      reply += "\n\nSekarang kirim foto karakter.";
    } else {
      reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
    }
    bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error processing animation:", err.message);
    bot.sendMessage(chatId, "❌ Gagal memproses animasi. Coba kirim ulang.");
  }
});

bot.on("document", async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const mimeType = msg.document.mime_type || "";

  try {
    const file = await bot.getFile(msg.document.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;

    if (mimeType.startsWith("image/")) {
      session.imageUrl = fileUrl;
      let reply = "✅ Foto karakter diterima (sebagai file)!";
      if (!session.videoUrl) {
        reply += "\n\nSekarang kirim video referensi gerakan.";
      } else {
        reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
      }
      bot.sendMessage(chatId, reply);
    } else if (mimeType.startsWith("video/")) {
      session.videoUrl = fileUrl;
      let reply = "✅ Video referensi diterima (sebagai file)!";
      if (!session.imageUrl) {
        reply += "\n\nSekarang kirim foto karakter.";
      } else {
        reply += "\n\nFoto dan video sudah lengkap! Ketik /generate untuk mulai.";
      }
      bot.sendMessage(chatId, reply);
    }
  } catch (err) {
    console.error("Error processing document:", err.message);
    bot.sendMessage(chatId, "❌ Gagal memproses file. Coba kirim ulang.");
  }
});

async function submitMotionControl(session) {
  const endpoint =
    session.quality === "pro"
      ? "https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-pro"
      : "https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control-std";

  const body = {
    image_url: session.imageUrl,
    video_url: session.videoUrl,
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
  const url = `https://api.freepik.com/v1/ai/video/kling-v2-6-motion-control/${taskId}`;

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
        bot.sendMessage(chatId, `⏳ Masih memproses... (${elapsed} detik)`);
      }
    } catch (err) {
      console.error(`Poll attempt ${i + 1} error:`, err.message);
    }
  }

  return null;
}

bot.onText(/\/generate/, async (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (!session.imageUrl) {
    bot.sendMessage(chatId, "❌ Foto karakter belum ada. Kirim foto terlebih dahulu.");
    return;
  }

  if (!session.videoUrl) {
    bot.sendMessage(chatId, "❌ Video referensi belum ada. Kirim video terlebih dahulu.");
    return;
  }

  const qualityLabel = session.quality === "pro" ? "Pro (1080p)" : "Standard (720p)";
  bot.sendMessage(
    chatId,
    `🎬 Memulai generate motion control video...\n\n• Kualitas: ${qualityLabel}\n• Orientasi: ${session.orientation}\n• Prompt: ${session.prompt || "(default)"}\n\n⏳ Proses ini bisa memakan waktu 1-5 menit.`
  );

  try {
    const submitResult = await submitMotionControl(session);
    const taskId = submitResult?.data?.task_id;

    if (!taskId) {
      console.error("No task_id in response:", JSON.stringify(submitResult));
      bot.sendMessage(chatId, "❌ Gagal submit task. Response tidak valid dari Freepik API.");
      return;
    }

    bot.sendMessage(chatId, `✅ Task berhasil disubmit!\n📋 Task ID: \`${taskId}\`\n\n⏳ Menunggu hasil...`, {
      parse_mode: "Markdown",
    });

    const result = await pollForResult(chatId, taskId);

    if (!result) {
      bot.sendMessage(chatId, "❌ Timeout: Video belum selesai setelah 20 menit. Coba lagi nanti.");
      return;
    }

    const status = result?.data?.status;

    if (status === "COMPLETED") {
      const videoUrls = result?.data?.generated || [];
      if (videoUrls.length > 0) {
        for (const videoUrl of videoUrls) {
          try {
            await bot.sendVideo(chatId, videoUrl, {
              caption: "🎬 Motion control video selesai!",
            });
          } catch (sendErr) {
            await bot.sendMessage(chatId, `🎬 Video selesai! Download di sini:\n${videoUrl}`);
          }
        }
      } else {
        bot.sendMessage(chatId, "⚠️ Video selesai tapi tidak ada URL hasil.");
      }
    } else {
      bot.sendMessage(chatId, `❌ Generate gagal. Status: ${status}\n\nDetail: ${JSON.stringify(result?.data)}`);
    }

    resetSession(chatId);
  } catch (err) {
    console.error("Generate error:", err.response?.data || err.message);
    const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message;
    bot.sendMessage(chatId, `❌ Error: ${errorMsg}`);
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.code, err.message);
});

console.log("🤖 Bot Telegram Kling 2.6 Motion Control sudah berjalan!");
