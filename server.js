'use strict';

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const { Readable } = require('stream');
const { v2: cloudinary } = require('cloudinary');
const path = require('path');

// ─── Config ────────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'admin';
const PORT      = process.env.PORT      || 3000;

// ─── In-memory sessions ─────────────────────────────────────────────────────────
const sessions    = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000;

// ─── Media cache ─────────────────────────────────────────────────────────────────
const CACHE_TTL  = 30_000; // 30 segundos
const mediaCache = { data: null, fetchedAt: 0 };

function invalidateCache() {
  mediaCache.data      = null;
  mediaCache.fetchedAt = 0;
}

function createToken() { return crypto.randomBytes(32).toString('hex'); }

function isValidToken(token) {
  if (!token || !sessions.has(token)) return false;
  const { createdAt } = sessions.get(token);
  if (Date.now() - createdAt > SESSION_TTL) { sessions.delete(token); return false; }
  return true;
}

// ─── Multer — aceita imagens E vídeos ──────────────────────────────────────────
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/avi',
                             'video/x-msvideo', 'video/x-matroska'];
const ALL_ALLOWED = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 200 * 1024 * 1024 }, // 200 MB para vídeos
});

// ─── Auth middleware ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!isValidToken(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ─── Upload to Cloudinary via stream ────────────────────────────────────────────
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result);
    });
    Readable.from(buffer).pipe(stream);
  });
}

// ─── Helper: thumbnail URL para vídeos ─────────────────────────────────────────
// O Cloudinary gera thumbnails de vídeo automaticamente.
// Trocando /video/upload/ por /video/upload/so_0,w_400/ e a extensão por .jpg
// obtemos um frame do vídeo como imagem estática, sem chamada extra à API.
function getThumbUrl(resource) {
  if (resource.resource_type !== 'video') return resource.secure_url;
  return resource.secure_url
    .replace('/video/upload/', '/video/upload/so_0,w_400,c_fill/')
    .replace(/\.[^.]+$/, '.jpg');
}

// ─── Helper: normaliza um resource do Cloudinary para o formato da API ─────────
function normalizeResource(r) {
  const isVideo = r.resource_type === 'video';
  return {
    url:          r.secure_url,
    thumbnailUrl: isVideo ? getThumbUrl(r) : r.secure_url,
    publicId:     r.public_id,
    createdAt:    new Date(r.created_at).getTime(),
    type:         isVideo ? 'video' : 'image',
  };
}

// ─── Helper: busca imagens E vídeos da pasta photostream/ ─────────────────────
// Usa cache de 30s para minimizar chamadas à Admin API do Cloudinary.
// Upload invalida o cache imediatamente via invalidateCache().
async function fetchAllMedia() {
  if (mediaCache.data && Date.now() - mediaCache.fetchedAt < CACHE_TTL) {
    return mediaCache.data;
  }

  let all = [];

  // Busca imagens
  let cursor;
  do {
    const opts = { type: 'upload', prefix: 'photostream/', max_results: 500, sort_by: 'created_at', direction: 'asc' };
    if (cursor) opts.next_cursor = cursor;
    const batch = await cloudinary.api.resources({ ...opts, resource_type: 'image' });
    all    = all.concat(batch.resources || []);
    cursor = batch.next_cursor;
  } while (cursor);

  // Busca vídeos
  cursor = undefined;
  do {
    const opts = { type: 'upload', prefix: 'photostream/', max_results: 500, sort_by: 'created_at', direction: 'asc' };
    if (cursor) opts.next_cursor = cursor;
    const batch = await cloudinary.api.resources({ ...opts, resource_type: 'video' });
    all    = all.concat(batch.resources || []);
    cursor = batch.next_cursor;
  } while (cursor);

  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  mediaCache.data      = all;
  mediaCache.fetchedAt = Date.now();
  return all;
}

// ─── Token público ──────────────────────────────────────────────────────────────
const PUBLIC_VIEW_TOKEN = process.env.PUBLIC_VIEW_TOKEN || 'photostream';

// ─── Stability AI (mantido para reativação futura) ──────────────────────────────
const STABILITY_API_KEY       = process.env.STABILITY_API_KEY || '';
const STABILITY_STRUCTURE_URL = 'https://api.stability.ai/v2beta/stable-image/control/structure';

async function processWithAI(imageBuffer, prompt) {
  if (!STABILITY_API_KEY) throw new Error('STABILITY_API_KEY não configurada.');
  const form = new FormData();
  form.append('image',            new Blob([imageBuffer], { type: 'image/png' }), 'image.png');
  form.append('prompt',           prompt);
  form.append('output_format',    'png');
  form.append('control_strength', '0.7');
  const response = await fetch(STABILITY_STRUCTURE_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${STABILITY_API_KEY}`, 'Accept': 'image/*' },
    body: form,
  });
  if (!response.ok) throw new Error(`Stability AI: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// ─── App ────────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = createToken();
    sessions.set(token, { createdAt: Date.now() });
    return res.json({ token });
  }
  return res.status(401).json({ error: 'Credenciais inválidas' });
});

// POST /api/logout
app.post('/api/logout', requireAuth, (req, res) => {
  sessions.delete(req.headers['x-auth-token']);
  res.json({ success: true });
});

// GET /api/check
app.get('/api/check', requireAuth, (req, res) => res.json({ valid: true }));

// GET /api/images — lista completa para viewer/polling (imagens + vídeos)
app.get('/api/images', requireAuth, async (req, res) => {
  try {
    const resources = await fetchAllMedia();
    res.json(resources.map(normalizeResource));
  } catch (err) {
    console.error('GET /api/images error:', err);
    res.status(500).json({ error: 'Erro ao buscar mídia' });
  }
});

// GET /api/images/latest — polling endpoint
// Usa fetchAllMedia() (com cache) — zero chamadas extras ao Cloudinary.
app.get('/api/images/latest', requireAuth, async (req, res) => {
  try {
    const resources = await fetchAllMedia();
    const latest    = resources.length > 0 ? new Date(resources[0].created_at).getTime() : 0;
    res.json({ latest, count: resources.length });
  } catch (err) {
    console.error('GET /api/images/latest error:', err);
    res.status(500).json({ error: 'Erro ao verificar mídia' });
  }
});

// GET /api/images/page?cursor=CURSOR&limit=8
// ATENÇÃO: para ordenar por data no Cloudinary é OBRIGATÓRIO usar sort_by.
// O parâmetro direction sozinho só ordena por public_id (ordem alfabética).
// direction: 'desc' + sort_by: 'created_at' → mais recentes primeiro.
app.get('/api/images/page', requireAuth, async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit) || 8, 30);
    const cursor  = req.query.cursor || undefined;
    const reqType = req.query.resource_type || 'image';

    const opts = {
      type:        'upload',
      prefix:      'photostream/',
      max_results: limit,
      sort_by:     'created_at',   // ← ordenar por data de criação
      direction:   'desc',        // ← mais recentes primeiro
    };
    if (cursor) opts.next_cursor = cursor;

    const batch = await cloudinary.api.resources({ ...opts, resource_type: reqType });
    res.json({
      images:     (batch.resources || []).map(normalizeResource),
      nextCursor: batch.next_cursor || null,
      total:      batch.total_count || 0,
    });
  } catch (err) {
    console.error('GET /api/images/page error:', err);
    res.status(500).json({ error: 'Erro ao buscar mídia paginada' });
  }
});

// GET /api/download?url=...
app.get('/api/download', requireAuth, async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'url é obrigatório' });
  let parsed;
  try { parsed = new URL(url); } catch (_) { return res.status(400).json({ error: 'URL inválida' }); }
  if (!parsed.hostname.endsWith('cloudinary.com')) return res.status(403).json({ error: 'Domínio não permitido' });
  try {
    const https    = require('https');
    const safeFile = (filename || 'PhotoStream').replace(/[^a-zA-Z0-9._-]/g, '_');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    res.setHeader('Cache-Control', 'no-store');
    https.get(url, (upstream) => {
      res.setHeader('Content-Type', upstream.headers['content-type'] || 'application/octet-stream');
      upstream.pipe(res);
      upstream.on('error', () => res.end());
    }).on('error', () => res.status(502).json({ error: 'Erro ao buscar arquivo' }));
  } catch (err) {
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Estado "ao vivo" ───────────────────────────────────────────────────────────
let pinnedImage = null;

// GET /api/public/autologin?token=...
app.get('/api/public/autologin', (req, res) => {
  if (!req.query.token || req.query.token !== PUBLIC_VIEW_TOKEN)
    return res.status(403).json({ error: 'Token inválido.' });
  const token = createToken();
  sessions.set(token, { createdAt: Date.now() });
  res.json({ token });
});

// POST /api/public/unpin
app.post('/api/public/unpin', requireAuth, (req, res) => {
  pinnedImage = null;
  res.json({ success: true });
});

// POST /api/public/pin
app.post('/api/public/pin', requireAuth, (req, res) => {
  const { url, publicId, createdAt, thumbnailUrl, type } = req.body;
  if (!url || !publicId) return res.status(400).json({ error: 'url e publicId são obrigatórios' });
  pinnedImage = {
    url, publicId, thumbnailUrl: thumbnailUrl || url, type: type || 'image',
    createdAt: createdAt || Date.now(), pinnedAt: Date.now(),
  };
  res.json({ success: true, pinnedAt: pinnedImage.pinnedAt });
});

// GET /api/public/images?token=...
app.get('/api/public/images', async (req, res) => {
  if (!req.query.token || req.query.token !== PUBLIC_VIEW_TOKEN)
    return res.status(403).json({ error: 'Acesso negado.' });
  try {
    const resources = await fetchAllMedia();
    res.json(resources.map(normalizeResource));
  } catch (err) {
    console.error('GET /api/public/images error:', err);
    res.status(500).json({ error: 'Erro ao buscar mídia.' });
  }
});

// GET /api/public/latest?token=...
app.get('/api/public/latest', async (req, res) => {
  if (!req.query.token || req.query.token !== PUBLIC_VIEW_TOKEN)
    return res.status(403).json({ error: 'Acesso negado.' });
  try {
    if (pinnedImage) {
      const PIN_TTL = 2 * 60 * 60 * 1000;
      if (Date.now() - pinnedImage.pinnedAt > PIN_TTL) {
        pinnedImage = null;
      } else {
        return res.json({
          url:          pinnedImage.url,
          thumbnailUrl: pinnedImage.thumbnailUrl,
          publicId:     pinnedImage.publicId,
          createdAt:    pinnedImage.createdAt,
          type:         pinnedImage.type,
          pinned:       true,
          pinnedAt:     pinnedImage.pinnedAt,
        });
      }
    }
    const resources = await fetchAllMedia();
    if (resources.length === 0) return res.status(404).json({ error: 'Nenhuma mídia disponível.' });
    res.json(normalizeResource(resources[0]));
  } catch (err) {
    console.error('GET /api/public/latest error:', err);
    res.status(500).json({ error: 'Erro ao buscar mídia.' });
  }
});

// POST /api/upload — aceita imagens e vídeos
app.post('/api/upload', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
  if (!ALL_ALLOWED.includes(req.file.mimetype))
    return res.status(400).json({ success: false, message: 'Tipo não permitido.' });

  const isVideo  = ALLOWED_VIDEO_TYPES.includes(req.file.mimetype);
  const random   = crypto.randomBytes(4).toString('hex');
  const publicId = `photostream/media_${Date.now()}_${random}`;

  try {
    const result = await uploadToCloudinary(req.file.buffer, {
      public_id:     publicId,
      resource_type: isVideo ? 'video' : 'image',
    });

    // Novo upload: limpa pin ativo e invalida o cache para exposição imediata
    pinnedImage = null;
    invalidateCache();

    const r = normalizeResource({ ...result, resource_type: isVideo ? 'video' : 'image' });
    res.json({ success: true, ...r, message: isVideo ? 'Vídeo enviado com sucesso!' : 'Imagem enviada com sucesso!' });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ success: false, message: 'Erro ao fazer upload.' });
  }
});

// GET /api/ping
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ─── Start ───────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`PhotoStream running on http://localhost:${PORT}`);
});

server.keepAliveTimeout = 120_000;
server.headersTimeout   = 125_000;

if (process.env.PORT) {
  const SELF_URL      = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/api/ping`
    : `http://localhost:${PORT}/api/ping`;
  const PING_INTERVAL = 10 * 60 * 1000;
  setInterval(async () => {
    try { await fetch(SELF_URL); } catch (_) {}
  }, PING_INTERVAL);
}
