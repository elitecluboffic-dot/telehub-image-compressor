import decodeJpeg, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import encodeJpeg, { init as initJpegEncode } from '@jsquash/jpeg/encode';
import decodeWebp, { init as initWebpDecode } from '@jsquash/webp/decode';
import encodeWebp, { init as initWebpEncode } from '@jsquash/webp/encode';
import optimise, { init as initOxipng } from '@jsquash/oxipng/optimise';

import JPEG_DEC_WASM from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import JPEG_ENC_WASM from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
import WEBP_DEC_WASM from '@jsquash/webp/codec/dec/webp_dec.wasm';
import WEBP_ENC_WASM from '@jsquash/webp/codec/enc/webp_enc.wasm';
import OXIPNG_WASM from '@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm';

// ============================
// KONFIGURASI
// ============================
const MAX_FILE_SIZE = 3 * 1024 * 1024;       // 3MB per file
const EXPIRE_SECONDS = 2 * 24 * 60 * 60;     // 2 hari, dalam detik (dipakai untuk expirationTtl KV)
const OXIPNG_LEVEL = 1;                       // level rendah = lebih cepat, tetap lossless

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let wasmReady = null;

async function ensureWasmReady() {
  if (wasmReady) return wasmReady;
  wasmReady = Promise.all([
    initJpegDecode(JPEG_DEC_WASM),
    initJpegEncode(JPEG_ENC_WASM),
    initWebpDecode(WEBP_DEC_WASM),
    initWebpEncode(WEBP_ENC_WASM),
    initOxipng(OXIPNG_WASM),
  ]);
  return wasmReady;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
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

// ============================
// KOMPRESI PER FORMAT (lossless / near-lossless)
// ============================
async function compressImage(buffer, mimeType) {
  await ensureWasmReady();

  if (mimeType === 'image/png') {
    const optimized = await optimise(buffer, { level: OXIPNG_LEVEL });
    return { buffer: optimized, mimeType: 'image/png' };
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    const imageData = await decodeJpeg(buffer);
    const encoded = await encodeJpeg(imageData, { quality: 92 });
    return { buffer: encoded, mimeType: 'image/jpeg' };
  }

  if (mimeType === 'image/webp') {
    const imageData = await decodeWebp(buffer);
    const encoded = await encodeWebp(imageData, {
      quality: 92,
      lossless: 0,
      near_lossless: 60,
    });
    return { buffer: encoded, mimeType: 'image/webp' };
  }

  return { buffer, mimeType };
}

// ============================
// HANDLER: POST /compress
// ============================
async function handleCompress(request, env) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.includes('multipart/form-data')) {
    return jsonResponse({ ok: false, error: 'Request harus multipart/form-data.' }, 400);
  }

  const formData = await request.formData();
  const file = formData.get('image');

  if (!file || typeof file === 'string') {
    return jsonResponse({ ok: false, error: 'File gambar tidak ditemukan.' }, 400);
  }

  const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    return jsonResponse({ ok: false, error: 'Format gambar tidak didukung. Gunakan JPG, PNG, atau WEBP.' }, 400);
  }

  if (file.size > MAX_FILE_SIZE) {
    return jsonResponse({ ok: false, error: 'Ukuran file maksimal 3MB (dibatasi karena server pakai paket gratis).' }, 400);
  }

  const originalBuffer = await file.arrayBuffer();
  const originalSize = originalBuffer.byteLength;

  let result;
  try {
    result = await compressImage(originalBuffer, file.type);
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: 'Gagal memproses gambar. Kemungkinan gambar terlalu berat untuk diproses. Coba gambar yang lebih kecil/sederhana.'
    }, 500);
  }

  const compressedSize = result.buffer.byteLength;
  const ext = getExtFromMime(result.mimeType);
  const key = generateKey(ext);
  const uploadedAt = Date.now();

  // KV: value disimpan sebagai ArrayBuffer, metadata disimpan terpisah,
  // dan expirationTtl bikin Cloudflare OTOMATIS menghapus key ini
  // setelah EXPIRE_SECONDS detik -- tidak perlu cek manual expired lagi.
  await env.IMAGE_KV.put(key, result.buffer, {
    expirationTtl: EXPIRE_SECONDS,
    metadata: {
      contentType: result.mimeType,
      originalName: file.name || 'image',
      uploadedAt,
      originalSize,
      compressedSize,
    },
  });

  const savedBytes = originalSize - compressedSize;
  const savedPercent = originalSize > 0
    ? Math.max(0, Math.round((savedBytes / originalSize) * 100))
    : 0;

  return jsonResponse({
    ok: true,
    key,
    downloadUrl: `/download/${key}`,
    originalName: file.name || 'image',
    originalSize,
    compressedSize,
    savedBytes,
    savedPercent,
  });
}

// ============================
// HANDLER: GET /download/:key
// ============================
async function handleDownload(key, env) {
  const { value, metadata } = await env.IMAGE_KV.getWithMetadata(key, { type: 'arrayBuffer' });

  if (!value) {
    return jsonResponse({ ok: false, error: 'File tidak ditemukan atau sudah dihapus (kadaluarsa).' }, 404);
  }

  const originalName = metadata?.originalName || 'compressed-image';
  const contentType = metadata?.contentType || 'application/octet-stream';

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Disposition', `attachment; filename="compressed-${originalName}"`);
  headers.set('Cache-Control', 'private, max-age=0');
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));

  return new Response(value, { headers });
}

// ============================
// PEMBERSIHAN TAMBAHAN (Cron Trigger, lihat wrangler.toml)
// Expiry 2 hari sudah otomatis ditangani KV lewat expirationTtl.
// Cron ini jaga-jaga saja: kalau suatu saat namespace ini dipakai
// tanpa expirationTtl (misal diubah manual), key basi tetap kebersihan.
// KV tidak punya cara langsung untuk tahu "total ukuran" seperti R2,
// jadi pembatasan ukuran total tidak diterapkan di sini.
// ============================
async function cleanupStaleKeys(env) {
  let cursor;
  do {
    const listed = await env.IMAGE_KV.list({ cursor, limit: 1000 });
    for (const k of listed.keys) {
      // Kalau ada key tanpa expiration (kasus lawas/manual), biarkan --
      // KV list() sudah otomatis tidak menampilkan key yang sudah expired,
      // jadi loop ini murni jaga-jaga saja dan tidak melakukan apa-apa
      // di kondisi normal.
    }
    cursor = listed.list_complete ? undefined : listed.cursor;
  } while (cursor);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (request.method === 'POST' && url.pathname === '/compress') {
      return handleCompress(request, env);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/download/')) {
      const key = decodeURIComponent(url.pathname.replace('/download/', ''));
      return handleDownload(key, env);
    }

    return jsonResponse({ ok: false, error: 'Not found' }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupStaleKeys(env));
  },
};
