/**
 * PhotoStream — Servidor Express com Cloudinary
 *
 * Estratégia de upload:
 *   multer (memoryStorage) recebe o arquivo em RAM →
 *   cloudinary.uploader.upload_stream envia o buffer para a nuvem.
 *
 * Isso elimina a dependência do pacote multer-storage-cloudinary,
 * que era incompatível com Cloudinary v2.
 */

const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const crypto     = require('crypto');
const { Readable } = require('stream');
const cloudinary = require('cloudinary').v2;

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────

const AUTH_USER    = process.env.AUTH_USER || 'admin';
const AUTH_PASS    = process.env.AUTH_PASS || 'fotos123';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── CONFIGURAR CLOUDINARY ────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ─── SESSÕES EM MEMÓRIA ───────────────────────────────────────────────────────

const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  const { createdAt } = sessions.get(token);
  if (Date.now() - createdAt > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// ─── MULTER — salva em memória (sem disco, sem pacote extra) ──────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo não permitido. Use JPG, PNG, WEBP ou GIF.'));
    }
  },
});

// ─── Envia buffer para o Cloudinary e retorna Promise ────────────────────────

function uploadToCloudinary(buffer) {
  return new Promise((resolve, reject) => {
    const publicId = `img_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const stream   = cloudinary.uploader.upload_stream(
      {
        folder:           'photostream',
        public_id:        publicId,
        allowed_formats:  ['jpg', 'jpeg', 'png', 'webp', 'gif'],
        resource_type:    'image',
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    // Converte o buffer em stream legível e envia
    Readable.from(buffer).pipe(stream);
  });
}

// ─── MIDDLEWARES ──────────────────────────────────────────────────────────────

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (isValidSession(token)) return next();
  res.status(401).json({ error: 'Não autorizado. Faça login.' });
}

// ─── ROTAS DE AUTENTICAÇÃO ────────────────────────────────────────────────────

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    res.json({ success: true, token: createSession() });
  } else {
    res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ success: true });
});

app.get('/api/check', requireAuth, (req, res) => {
  res.json({ valid: true });
});

// ─── ROTAS DE IMAGENS ─────────────────────────────────────────────────────────

// Lista todas as imagens (mais recentes primeiro)
app.get('/api/images', requireAuth, async (req, res) => {
  try {
    const result = await cloudinary.api.resources({
      type:          'upload',
      prefix:        'photostream/',
      max_results:   100,
      resource_type: 'image',
    });

    const images = result.resources
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(img => ({
        url:       img.secure_url,
        publicId:  img.public_id,
        createdAt: img.created_at,
      }));

    res.json({ images, total: images.length });
  } catch (err) {
    console.error('Erro ao listar imagens:', err);
    res.status(500).json({ error: 'Erro ao listar imagens.' });
  }
});

// Verifica se há imagem nova (usado pelo polling do frontend)
app.get('/api/images/latest', requireAuth, async (req, res) => {
  try {
    const result = await cloudinary.api.resources({
      type:          'upload',
      prefix:        'photostream/',
      max_results:   1,
      resource_type: 'image',
    });

    const latest = result.resources.length > 0
      ? new Date(result.resources[0].created_at).getTime()
      : 0;

    res.json({ latest, count: result.resources.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar imagens.' });
  }
});

// Recebe a imagem, passa pelo Cloudinary via stream
app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('image')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'Arquivo muito grande. Máximo: 10MB.'
        : (err.message || 'Erro no upload.');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    try {
      const result = await uploadToCloudinary(req.file.buffer);
      res.json({
        success:  true,
        url:      result.secure_url,
        publicId: result.public_id,
        message:  'Imagem enviada com sucesso!',
      });
    } catch (uploadErr) {
      console.error('Erro ao enviar para Cloudinary:', uploadErr);
      res.status(500).json({ error: 'Falha ao salvar a imagem. Tente novamente.' });
    }
  });
});

// ─── INICIAR SERVIDOR ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 PhotoStream rodando em http://localhost:${PORT}`);
  console.log(`👤 Usuário: ${AUTH_USER}`);
  console.log(`☁️  Cloudinary: ${process.env.CLOUDINARY_CLOUD_NAME || '(não configurado)'}\n`);
});
