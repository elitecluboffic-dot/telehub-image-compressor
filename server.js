import express from 'express';
import multer from 'multer';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import cron from 'node-cron';
import { fileURLToPath } from 'url';

import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode.js';
import encodeJpeg, { init as initJpegEncode } from '@jsquash/jpeg/encode.js';
import decodeWebp, { init as initWebpDecode } from '@jsquash/webp/decode.js';
import encodeWebp, { init as initWebpEncode } from '@jsquash/webp/encode.js';
import optimise, { init as initOxipng } from '@jsquash/oxipng/optimise.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadWasmBuffer(relativePath) {
  return fs.readFileSync(path.join(__dirname, 'node_modules', relativePath));
}

// jpeg & webp codec wrapper mereka expect WebAssembly.Module yang sudah
// dikompilasi (bukan raw buffer), dan HARUS dipanggil dengan 2 argumen
// (module, options) -- kalau cuma 1 argumen, library-nya malah salah
// mengira argumen itu adalah "options", bukan module. Oxipng beda:
// wasm-bindgen-nya terima raw buffer langsung, jadi tidak perlu dikompilasi.
async function loadWasmModule(relativePath) {
  const buffer = loadWasmBuffer(relativePath);
  return WebAssembly.compile(buffer);
}

// ============================
// KONFIGURASI
// ============================
const PORT = process.env.PORT || 3000;
// Kalau di Railway kamu attach sebuah Volume, set STORAGE_DIR ke mount path-nya
// (misal "/data") lewat environment variable, biar file tidak hilang tiap redeploy.
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const MAX_FILE_SIZE = 3 * 1024 * 1024;       // 3MB per file
const EXPIRE_MS = 2 * 24 * 60 * 60 * 1000;   // 2 hari
const OXIPNG_LEVEL = 1;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://telehub.nfy.fyi';

if (!fs.existsSync(STORAGE_DIR)) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
}

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN, methods: ['GET', 'POST', 'OPTIONS'] }));

const upload = multer({ limits: { fileSize: MAX_FILE_SIZE } });

// ============================
// WASM INIT (sekali saja, di-cache)
// ============================
let wasmReady = null;
async function ensureWasmReady() {
  if (wasmReady) return wasmReady;

  const [jpegDecMod, jpegEncMod, webpDecMod, webpEncMod] = await Promise.all([
    loadWasmModule('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'),
    loadWasmModule('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'),
    loadWasmModule('@jsquash/webp/codec/dec/webp_dec.wasm'),
    loadWasmModule('@jsquash/webp/codec/enc/webp_enc.wasm'),
  ]);

  wasmReady = Promise.all([
    initJpegDecode(jpegDecMod, {}),
    initJpegEncode(jpegEncMod, {}),
    initWebpDecode(webpDecMod, {}),
    initWebpEncode(webpEncMod, {}),
    initOxipng(loadWasmBuffer('@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm')),
  ]);
  return wasmReady;
}

function generateKey(ext) {
  return `${Date.now()}-${crypto.randomUUID()}.${ext}`;
}

function getExtFromMime(mime) {
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

function dataPath(key) {
  return path.join(STORAGE_DIR, key);
}

function metaPath(key) {
  return path.join(STORAGE_DIR, `${key}.meta.json`);
}

// ============================
// KOMPRESI PER FORMAT
// ============================
async function compressImage(buffer, mimeType) {
  await ensureWasmReady();

  if (mimeType === 'image/png') {
    const optimized = await optimise(new Uint8Array(buffer), { level: OXIPNG_LEVEL });
    return { buffer: Buffer.from(optimized), mimeType: 'image/png' };
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    const imageData = await decodeJpeg(buffer);
    const encoded = await encodeJpeg(imageData, { quality: 92 });
    return { buffer: Buffer.from(encoded), mimeType: 'image/jpeg' };
  }

  if (mimeType === 'image/webp') {
    const imageData = await decodeWebp(buffer);
    const encoded = await encodeWebp(imageData, {
      quality: 92,
      lossless: 0,
      near_lossless: 60,
    });
    return { buffer: Buffer.from(encoded), mimeType: 'image/webp' };
  }

  return { buffer, mimeType };
}

// ============================
// ROUTE: POST /compress
// ============================
app.post('/compress', upload.single('image'), async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ ok: false, error: 'File gambar tidak ditemukan.' });
    }

    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ ok: false, error: 'Format gambar tidak didukung. Gunakan JPG, PNG, atau WEBP.' });
    }

    const originalBuffer = file.buffer;
    const originalSize = originalBuffer.byteLength;

    let result;
    try {
      result = await compressImage(originalBuffer, file.mimetype);
    } catch (err) {
      console.error('Compress error:', err);
      return res.status(500).json({
        ok: false,
        error: 'Gagal memproses gambar. Kemungkinan gambar terlalu berat untuk diproses. Coba gambar yang lebih kecil/sederhana.',
      });
    }

    const compressedSize = result.buffer.byteLength;
    const ext = getExtFromMime(result.mimeType);
    const key = generateKey(ext);
    const uploadedAt = Date.now();
    const expiresAt = uploadedAt + EXPIRE_MS;

    fs.writeFileSync(dataPath(key), result.buffer);
    fs.writeFileSync(metaPath(key), JSON.stringify({
      contentType: result.mimeType,
      originalName: file.originalname || 'image',
      uploadedAt,
      expiresAt,
      originalSize,
      compressedSize,
    }));

    const savedBytes = originalSize - compressedSize;
    const savedPercent = originalSize > 0
      ? Math.max(0, Math.round((savedBytes / originalSize) * 100))
      : 0;

    return res.json({
      ok: true,
      key,
      downloadUrl: `/download/${key}`,
      originalName: file.originalname || 'image',
      originalSize,
      compressedSize,
      savedBytes,
      savedPercent,
    });
  } catch (err) {
    console.error('Unexpected error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ ok: false, error: 'Ukuran file maksimal 3MB.' });
    }
    return res.status(500).json({ ok: false, error: 'Terjadi kesalahan pada server.' });
  }
});

// ============================
// ROUTE: GET /download/:key
// ============================
app.get('/download/:key', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const dPath = dataPath(key);
  const mPath = metaPath(key);

  if (!fs.existsSync(dPath) || !fs.existsSync(mPath)) {
    return res.status(404).json({ ok: false, error: 'File tidak ditemukan atau sudah dihapus (kadaluarsa).' });
  }

  const metadata = JSON.parse(fs.readFileSync(mPath, 'utf-8'));

  if (metadata.expiresAt && Date.now() > metadata.expiresAt) {
    fs.unlinkSync(dPath);
    fs.unlinkSync(mPath);
    return res.status(404).json({ ok: false, error: 'File tidak ditemukan atau sudah dihapus (kadaluarsa).' });
  }

  res.setHeader('Content-Type', metadata.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="compressed-${metadata.originalName}"`);
  res.setHeader('Cache-Control', 'private, max-age=0');
  return res.sendFile(dPath);
});

// ============================
// CLEANUP: hapus file kadaluarsa tiap jam
// ============================
function cleanupStaleFiles() {
  const now = Date.now();
  const files = fs.readdirSync(STORAGE_DIR);
  for (const f of files) {
    if (!f.endsWith('.meta.json')) continue;
    const mPath = path.join(STORAGE_DIR, f);
    try {
      const metadata = JSON.parse(fs.readFileSync(mPath, 'utf-8'));
      if (metadata.expiresAt && now > metadata.expiresAt) {
        const key = f.replace('.meta.json', '');
        const dPath = dataPath(key);
        if (fs.existsSync(dPath)) fs.unlinkSync(dPath);
        fs.unlinkSync(mPath);
      }
    } catch (e) {
      console.error(`Gagal cek metadata ${f}:`, e);
    }
  }
}

cron.schedule('0 * * * *', cleanupStaleFiles); // tiap jam, sama seperti versi Workers

// ============================
// HEALTH CHECK (opsional, berguna buat Railway)
// ============================
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'telehub-image-compressor', status: 'running' });
});

app.listen(PORT, () => {
  console.log(`telehub-image-compressor listening on port ${PORT}`);
  console.log(`Storage dir: ${STORAGE_DIR}`);
});
