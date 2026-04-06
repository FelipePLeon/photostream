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
const sessions  = new Map();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 h

function createToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidToken(token) {
  if (!token || !sessions.has(token)) return false;
  const { createdAt } = sessions.get(token);
  if (Date.now() - createdAt > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// ─── Multer (memory only) ───────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// ─── Auth middleware ─────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!isValidToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
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

// ─── Helper: busca todas as imagens sem depender do índice de busca do Cloudinary
// cloudinary.search tem delay de indexação de até ~15s após o upload.
// cloudinary.api.resources() consulta o storage diretamente, sem esse delay.
async function fetchAllImages() {
  let all        = [];
  let nextCursor = undefined;

  do {
    const opts = {
      type:        'upload',
      prefix:      'photostream/',
      max_results: 500,
      direction:   -1, // desc por created_at
    };
    if (nextCursor) opts.next_cursor = nextCursor;

    const batch = await cloudinary.api.resources(opts);
    all         = all.concat(batch.resources || []);
    nextCursor  = batch.next_cursor;
  } while (nextCursor);

  // garantir ordenação desc
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all;
}

// ─── Token público (para a rota /api/public/latest) ────────────────────────────
// Troque este valor por qualquer string secreta de sua preferência.
// Quem tiver esse token pode ver a imagem mais recente sem fazer login.
const PUBLIC_VIEW_TOKEN = process.env.PUBLIC_VIEW_TOKEN || 'photostream';

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
  const token = req.headers['x-auth-token'];
  sessions.delete(token);
  res.json({ success: true });
});

// GET /api/check
app.get('/api/check', requireAuth, (req, res) => {
  res.json({ valid: true });
});

// GET /api/images
app.get('/api/images', requireAuth, async (req, res) => {
  try {
    const resources = await fetchAllImages();
    const images    = resources.map((r) => ({
      url:       r.secure_url,
      publicId:  r.public_id,
      createdAt: new Date(r.created_at).getTime(),
    }));
    res.json(images);
  } catch (err) {
    console.error('GET /api/images error:', err);
    res.status(500).json({ error: 'Erro ao buscar imagens' });
  }
});

// GET /api/images/latest — polling endpoint (sem cache de índice)
app.get('/api/images/latest', requireAuth, async (req, res) => {
  try {
    const resources = await fetchAllImages();
    const latest    = resources.length > 0
      ? new Date(resources[0].created_at).getTime()
      : 0;
    res.json({ latest, count: resources.length });
  } catch (err) {
    console.error('GET /api/images/latest error:', err);
    res.status(500).json({ error: 'Erro ao verificar imagens' });
  }
});

// GET /api/download?url=... — proxy para forçar nome correto no download (cross-origin)
app.get('/api/download', requireAuth, async (req, res) => {
  const { url, filename } = req.query;
  if (!url) return res.status(400).json({ error: 'url é obrigatório' });

  // Só permite URLs do Cloudinary
  let parsed;
  try { parsed = new URL(url); } catch (_) {
    return res.status(400).json({ error: 'URL inválida' });
  }
  if (!parsed.hostname.endsWith('cloudinary.com')) {
    return res.status(403).json({ error: 'Domínio não permitido' });
  }

  try {
    const https    = require('https');
    const safeFile = (filename || 'PhotoStream.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');

    res.setHeader('Content-Disposition', `attachment; filename="${safeFile}"`);
    res.setHeader('Cache-Control', 'no-store');

    https.get(url, (upstream) => {
      const ct = upstream.headers['content-type'] || 'image/jpeg';
      res.setHeader('Content-Type', ct);
      upstream.pipe(res);
      upstream.on('error', (e) => { console.error('proxy stream error:', e); res.end(); });
    }).on('error', (e) => {
      console.error('proxy request error:', e);
      res.status(502).json({ error: 'Erro ao buscar imagem' });
    });
  } catch (err) {
    console.error('GET /api/download error:', err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ─── Rota pública ───────────────────────────────────────────────────────────────
// GET /api/public/latest?token=...
// Não exige login. Retorna { url, publicId, createdAt } da imagem mais recente.
// Protegida pelo PUBLIC_VIEW_TOKEN enviado via query string.
app.get('/api/public/latest', async (req, res) => {
  // 1. Valida o token público
  if (!req.query.token || req.query.token !== PUBLIC_VIEW_TOKEN) {
    return res.status(403).json({ error: 'Acesso negado. Token inválido ou ausente.' });
  }

  try {
    const resources = await fetchAllImages();

    if (resources.length === 0) {
      return res.status(404).json({ error: 'Nenhuma imagem disponível.' });
    }

    const r = resources[0];
    res.json({
      url:       r.secure_url,
      publicId:  r.public_id,
      createdAt: new Date(r.created_at).getTime(),
    });
  } catch (err) {
    console.error('GET /api/public/latest error:', err);
    res.status(500).json({ error: 'Erro ao buscar imagem.' });
  }
});

// POST /api/upload
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

app.post('/api/upload', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
  }
  if (!ALLOWED_TYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ success: false, message: 'Tipo de arquivo não permitido.' });
  }

  try {
    const random   = crypto.randomBytes(4).toString('hex');
    const publicId = `photostream/img_${Date.now()}_${random}`;

    const result = await uploadToCloudinary(req.file.buffer, {
      public_id:     publicId,
      resource_type: 'image',
    });

    res.json({
      success:  true,
      url:      result.secure_url,
      publicId: result.public_id,
      message:  'Imagem enviada com sucesso!',
    });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ success: false, message: 'Erro ao fazer upload da imagem.' });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PhotoStream running on http://localhost:${PORT}`);
});
