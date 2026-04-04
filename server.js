/**
 * PhotoStream - Servidor Express
 * Servidor simples para upload e visualização de imagens em tempo real.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────

// Credenciais fixas (altere conforme necessário)
const AUTH_USER = process.env.AUTH_USER || 'admin';
const AUTH_PASS = process.env.AUTH_PASS || 'fotos123';

// Limite de tamanho de upload: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Tipos de arquivo permitidos
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// ─── SESSÕES SIMPLES EM MEMÓRIA ────────────────────────────────────────────────
const sessions = new Map();

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token) {
  if (!token || !sessions.has(token)) return false;
  const session = sessions.get(token);
  // Sessão expira em 24h
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// ─── PASTA DE UPLOADS ──────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ─── CONFIGURAÇÃO DO MULTER ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    cb(null, `img_${timestamp}_${random}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Tipo de arquivo não permitido. Use JPG, PNG, WEBP ou GIF.'));
    }
  }
});

// ─── MIDDLEWARES ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Middleware de autenticação para rotas da API
function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'] || req.query.token;
  if (isValidSession(token)) {
    next();
  } else {
    res.status(401).json({ error: 'Não autorizado. Faça login.' });
  }
}

// ─── ROTAS DE AUTENTICAÇÃO ─────────────────────────────────────────────────────

// POST /api/login — realiza login e retorna token
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === AUTH_USER && password === AUTH_PASS) {
    const token = createSession();
    res.json({ success: true, token });
  } else {
    res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  }
});

// POST /api/logout — encerra sessão
app.post('/api/logout', (req, res) => {
  const token = req.headers['x-auth-token'];
  if (token) sessions.delete(token);
  res.json({ success: true });
});

// GET /api/check — verifica se token ainda é válido
app.get('/api/check', requireAuth, (req, res) => {
  res.json({ valid: true });
});

// ─── ROTAS DE IMAGENS ──────────────────────────────────────────────────────────

// GET /api/images — lista todas as imagens (mais recentes primeiro)
app.get('/api/images', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .map(f => {
        const stat = fs.statSync(path.join(UPLOADS_DIR, f));
        return { name: f, time: stat.mtimeMs };
      })
      .sort((a, b) => b.time - a.time)
      .map(f => f.name);

    res.json({ images: files, total: files.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao listar imagens.' });
  }
});

// GET /api/images/latest — retorna o timestamp da imagem mais recente (para polling)
app.get('/api/images/latest', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR)
      .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .map(f => fs.statSync(path.join(UPLOADS_DIR, f)).mtimeMs);

    const latest = files.length > 0 ? Math.max(...files) : 0;
    res.json({ latest, count: files.length });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao verificar imagens.' });
  }
});

// POST /api/upload — faz upload de uma imagem
app.post('/api/upload', requireAuth, (req, res) => {
  upload.single('image')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Arquivo muito grande. Máximo: 10MB.' });
      }
      return res.status(400).json({ error: err.message || 'Erro no upload.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    res.json({
      success: true,
      filename: req.file.filename,
      size: req.file.size,
      message: 'Imagem enviada com sucesso!'
    });
  });
});

// Servir arquivos de upload (com autenticação via query param)
app.get('/uploads/:filename', (req, res) => {
  const token = req.query.token;
  if (!isValidSession(token)) {
    return res.status(401).send('Não autorizado.');
  }
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send('Imagem não encontrada.');
  }
  res.sendFile(filePath);
});

// ─── INICIAR SERVIDOR ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 PhotoStream rodando em http://localhost:${PORT}`);
  console.log(`👤 Usuário: ${AUTH_USER} | Senha: ${AUTH_PASS}`);
  console.log(`📁 Imagens salvas em: ${UPLOADS_DIR}\n`);
});
