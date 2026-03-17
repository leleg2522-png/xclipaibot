# Instruksi Proxy Hemat Bandwidth untuk Bot (Freepik API)

## Prinsip Utama
- Gunakan Decodo rotating proxy HANYA untuk request JSON kecil (create task, poll status)
- JANGAN PERNAH kirim gambar/video lewat proxy — sangat boros bandwidth
- Gambar base64 harus disimpan ke file lokal dulu, lalu kirim public URL-nya saja ke Freepik API

## Setup

### Dependencies
```
npm install axios https-proxy-agent
```

### Environment Variable
```
VPS_PROXIES=gate.decodo.com:10001:username:password
```

## Logic Proxy

### 1. Inisialisasi Proxy
```javascript
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');

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
```

### 2. Build Proxy URL
```javascript
function buildProxyUrl(proxy) {
  if (proxy.username && proxy.password) {
    return `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
  }
  return `http://${proxy.host}:${proxy.port}`;
}
```

### 3. Freepik Headers
```javascript
function freepikHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'x-freepik-api-key': apiKey.replace(/[^\x20-\x7E]/g, '').trim()
  };
}
```

### 4. Request Lewat Proxy (Fungsi Utama)
```javascript
async function makeFreepikRequest(method, url, apiKey, body = null) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  if (VPS_PROXIES.length === 0) {
    // Fallback tanpa proxy
    return axios({ method, url, headers: freepikHeaders(apiKey), data: body, timeout: 120000 });
  }

  let attempt = 0;
  let proxyIndex = 0;

  while (true) {
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
    console.log(`[PROXY] Attempt ${attempt} via ${proxy.host}:${proxy.port}`);

    try {
      const resp = await axios(config);
      // Cek apakah response HTML (blocked)
      if (typeof resp.data === 'string' && resp.data.includes('Access denied')) {
        throw new Error('Blocked by Freepik');
      }
      return resp;
    } catch (err) {
      const status = err.response?.status;

      // 429 = API key limit, jangan retry proxy — throw supaya ganti key
      if (status === 429) throw err;

      // Socket error atau blocked → rotate IP, retry
      const msg = (err.message || '').toLowerCase();
      const isSocketErr = msg.includes('socket') || msg.includes('econnreset') ||
                          msg.includes('etimedout') || msg.includes('ssl');
      const isBlocked = status === 403;

      if (isSocketErr || isBlocked) {
        console.log(`[PROXY] ${isSocketErr ? 'Socket error' : 'Blocked'}, rotating IP...`);
        proxyIndex++;
        await sleep(1500);
        continue;
      }

      throw err;
    }
  }
}
```

### 5. Simpan Gambar Base64 ke File (PENTING — Hemat Bandwidth)
```javascript
const fs = require('fs');
const path = require('path');

function saveBase64ToFile(base64Data, folder = './uploads') {
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  // Hapus prefix "data:image/png;base64," kalau ada
  const cleanBase64 = base64Data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(cleanBase64, 'base64');

  const filename = `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  const filepath = path.join(folder, filename);
  fs.writeFileSync(filepath, buffer);

  return filepath; // Return path lokal
}
```

### 6. Contoh: Create Video Task (Image-to-Video)
```javascript
async function createVideoTask(imageBase64OrUrl, prompt, apiKey) {
  let imageUrl = imageBase64OrUrl;

  // Kalau base64, simpan ke file dulu → buat public URL
  if (imageBase64OrUrl.startsWith('data:')) {
    const localPath = saveBase64ToFile(imageBase64OrUrl);
    imageUrl = `https://your-domain.com/${localPath}`; // Ganti dengan public URL server kamu
  }

  // Body request kecil — hanya URL + prompt, bukan gambar
  const body = {
    image: imageUrl,  // Public URL, bukan base64!
    prompt: prompt
  };

  const response = await makeFreepikRequest(
    'POST',
    'https://api.freepik.com/v1/ai/image-to-video/kling-v2-6',
    apiKey,
    body
  );

  return response.data;
}
```

### 7. Contoh: Poll Status Task
```javascript
async function pollTask(taskId, apiKey) {
  const response = await makeFreepikRequest(
    'GET',
    `https://api.freepik.com/v1/ai/image-to-video/kling-v2-6/${taskId}`,
    apiKey
  );

  const data = response.data?.data || response.data;
  return {
    status: data.status,
    videoUrl: data.generated?.[0] || data.video?.url || null
  };
}
```

### 8. Download Video — TANPA PROXY (langsung dari CDN)
```javascript
async function downloadVideo(videoUrl, outputPath) {
  // JANGAN pakai proxy — video besar, langsung download dari Freepik CDN
  const response = await axios({
    method: 'GET',
    url: videoUrl,
    responseType: 'stream',
    timeout: 300000
  });

  const writer = fs.createWriteStream(outputPath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}
```

## Ringkasan Aturan Bandwidth

| Aksi | Lewat Proxy? | Size |
|------|-------------|------|
| Create task (POST) | ✅ YA | ~1-2 KB |
| Poll status (GET) | ✅ YA | ~500 bytes |
| Refresh URL (GET) | ✅ YA | ~500 bytes |
| Upload gambar | ❌ TIDAK | ~2-5 MB |
| Download video | ❌ TIDAK | ~10-50 MB |

## Key Rotation (Multiple API Keys)
```javascript
const API_KEYS = process.env.FREEPIK_KEYS?.split(',') || [];
let keyIndex = 0;

function getNextKey() {
  const key = API_KEYS[keyIndex % API_KEYS.length];
  keyIndex++;
  return key;
}

// Kalau kena 429, otomatis ganti key
async function createWithKeyRotation(imageUrl, prompt) {
  for (let i = 0; i < API_KEYS.length; i++) {
    const key = getNextKey();
    try {
      return await createVideoTask(imageUrl, prompt, key);
    } catch (err) {
      if (err.response?.status === 429) {
        console.log(`Key habis quota, coba key berikutnya...`);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Semua API key habis quota');
}
```
