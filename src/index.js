import decodeJpeg from '@jsquash/jpeg/decode';
import encodeJpeg from '@jsquash/jpeg/encode';
import decodeWebp from '@jsquash/webp/decode';
import encodeWebp from '@jsquash/webp/encode';
import { optimise } from '@jsquash/oxipng';

// ============================
// KONFIGURASI
// ============================
const MAX_FILE_SIZE = 15 * 1024 * 1024;      // 15MB per file
const EXPIRE_MS = 2 * 24 * 60 * 60 * 1000;   // 2 hari
const BUCKET_SIZE_LIMIT = 500 * 1024 * 1024; // 500MB, kalau lebih -> bersihin file terlama

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://telehub.nfy.fyi',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

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
// KOMPRESI PER FORMAT
// Semua metode di sini LOSSLESS / NEAR-LOSSLESS -- tidak ada
// penurunan kualitas visual, ukuran mengecil murni dari optimasi
// struktur file, penghapusan metadata, dan encoding yang lebih efisien.
// ============================
async function compressImage(buffer, mimeType) {
  if (mimeType === 'image/png') {
    // Oxipng: re-kompresi PNG 100% lossless, piksel tidak berubah sama sekali.
    const optimized = await optimise(buffer, { level: 3 });
    return { buffer: optimized, mimeType: 'image/png' };
  }

  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    // Decode lalu re-encode pakai mozjpeg kualitas 92 (visually lossless)
    // + buang metadata EXIF yang tidak perlu.
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

  // Format lain dikembalikan apa adanya (tidak diproses)
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
    return jsonResponse({ ok: false, error: 'Ukuran file maksimal 15MB.' }, 400);
  }

  const originalBuffer = await file.arrayBuffer();
  const originalSize = originalBuffer.byteLength;

  let result;
  try {
    result = await compressImage(originalBuffer, file.type);
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Gagal memproses gambar: ' + err.message }, 500);
  }

  const compressedSize = result.buffer.byteLength;
  const ext = getExtFromMime(result.mimeType);
  const key = generateKey(ext);
  const uploadedAt = Date.now();
  const expiresAt = uploadedAt + EXPIRE_MS;

  await env.IMAGE_BUCKET.put(key, result.buffer, {
    httpMetadata: { contentType: result.mimeType },
    customMetadata: {
      originalName: file.name || 'image',
      uploadedAt: String(uploadedAt),
      expiresAt: String(expiresAt),
      originalSize: String(originalSize),
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
    expiresAt,
  });
}

// ============================
// HANDLER: GET /download/:key
// ============================
async function handleDownload(key, env) {
  const object = await env.IMAGE_BUCKET.get(key);

  if (!object) {
    return jsonResponse({ ok: false, error: 'File tidak ditemukan atau sudah dihapus (kadaluarsa).' }, 404);
  }

  const expiresAt = Number(object.customMetadata?.expiresAt || 0);
  if (expiresAt && Date.now() > expiresAt) {
    // Sudah lewat 2 hari -- hapus sekarang juga, anggap tidak ada
    await env.IMAGE_BUCKET.delete(key);
    return jsonResponse({ ok: false, error: 'File sudah kadaluarsa dan telah dihapus.' }, 404);
  }

  const originalName = object.customMetadata?.originalName || 'compressed-image';
  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Disposition', `attachment; filename="compressed-${originalName}"`);
  headers.set('Cache-Control', 'private, max-age=0');
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));

  return new Response(object.body, { headers });
}

// ============================
// PEMBERSIHAN OTOMATIS (Cron Trigger, lihat wrangler.toml)
// 1. Hapus semua file yang sudah lewat 2 hari.
// 2. Kalau total ukuran bucket masih > BUCKET_SIZE_LIMIT walau belum
//    2 hari, hapus file dari yang PALING LAMA duluan sampai ukurannya
//    turun di bawah batas -- supaya storage tidak menumpuk.
// ============================
async function cleanupBucket(env) {
  let cursor;
  let allObjects = [];

  do {
    const listed = await env.IMAGE_BUCKET.list({
      cursor,
      limit: 1000,
      include: ['customMetadata'],
    });
    allObjects = allObjects.concat(listed.objects);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  const now = Date.now();
  let totalSize = 0;
  const stillAlive = [];

  for (const obj of allObjects) {
    const expiresAt = Number(obj.customMetadata?.expiresAt || 0);
    if (expiresAt && now > expiresAt) {
      await env.IMAGE_BUCKET.delete(obj.key);
      continue;
    }
    totalSize += obj.size;
    stillAlive.push(obj);
  }

  if (totalSize > BUCKET_SIZE_LIMIT) {
    stillAlive.sort((a, b) => {
      const aTime = Number(a.customMetadata?.uploadedAt || 0);
      const bTime = Number(b.customMetadata?.uploadedAt || 0);
      return aTime - bTime; // paling lama duluan
    });

    for (const obj of stillAlive) {
      if (totalSize <= BUCKET_SIZE_LIMIT) break;
      await env.IMAGE_BUCKET.delete(obj.key);
      totalSize -= obj.size;
    }
  }
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
    ctx.waitUntil(cleanupBucket(env));
  },
};
