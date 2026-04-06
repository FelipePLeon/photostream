'use strict';

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const { Readable } = require('stream');
const { v2: cloudinary } = require('cloudinary');
const path = require('path');
// 🔐 TOKEN DE ACESSO PÚBLICO
const PUBLIC_TOKEN = 'photostream';

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
// Map<token, { createdAt: number }>
const sessions = new Map();
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
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
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
    const result = await cloudinary.search
      .expression('folder:photostream/*')
      .sort_by('created_at', 'desc')
      .max_results(200)
      .execute();

    const images = (result.resources || []).map((r) => ({
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

// GET /api/images/latest  — lightweight polling endpoint
app.get('/api/images/latest', requireAuth, async (req, res) => {
  try {
    const result = await cloudinary.search
      .expression('folder:photostream/*')
      .sort_by('created_at', 'desc')
      .max_results(1)
      .execute();

    const count   = result.total_count || 0;
    const latest  = result.resources && result.resources.length > 0
      ? new Date(result.resources[0].created_at).getTime()
      : 0;

    res.json({ latest, count });
  } catch (err) {
    console.error('GET /api/images/latest error:', err);
    res.status(500).json({ error: 'Erro ao verificar imagens' });
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

// GET /public/latest — página pública com auto-refresh CHATGPT
app.get('/public/latest', async (req, res) => {
  try {
    const result = await cloudinary.search
      .expression('folder:photostream/*')
      .sort_by('created_at', 'desc')
      .max_results(1)
      .execute();

    const image = result.resources && result.resources.length > 0
      ? result.resources[0].secure_url
      : null;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Live Photo</title>
        <style>
          body {
            margin: 0;
            background: black;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
          }
          img {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
          }
        </style>
      </head>
      <body>
        ${image ? `<img id="img" src="${image}" />` : `<p style="color:white;">Sem imagem</p>`}

        <script>
          let lastUrl = "${image || ''}";

          async function checkUpdate() {
            try {
              const r = await fetch('/public/latest-json');
              const data = await r.json();

              if (data.url && data.url !== lastUrl) {
                document.getElementById('img').src = data.url;
                lastUrl = data.url;
              }
            } catch (e) {}
          }

          setInterval(checkUpdate, 3000);
        </script>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao carregar imagem');
  }
});

// GET /public/latest-json — retorna só a imagem mais recente CHATGPT
app.get('/public/latest-json', async (req, res) => {

 // 🔐 VALIDAÇÃO DO TOKEN (coloque AQUI)
  if (req.query.token !== PUBLIC_TOKEN) {
    return res.status(403).send('Acesso negado');
  }

  try {
    const result = await cloudinary.search
      .expression('folder:photostream/*')
      .sort_by('created_at', 'desc')
      .max_results(1)
      .execute();

    const image = result.resources && result.resources.length > 0
      ? result.resources[0].secure_url
      : null;

    res.json({ url: image });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar imagem' });
  }
});



// ─── Start ───────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`PhotoStream running on http://localhost:${PORT}`);
});
