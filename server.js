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

// ─── Stability AI ───────────────────────────────────────────────────────────────
//
// Usamos o endpoint "Structure" do Stable Image v2beta:
//   POST https://api.stability.ai/v2beta/stable-image/control/structure
//
// Por quê "Structure"?
//   • Recebe uma imagem de entrada + prompt de texto
//   • Preserva a estrutura/composição da imagem original (bordas, formas)
//   • Reestiliza/transforma o conteúdo de acordo com o prompt
//   • Edita uma imagem com texto, sem precisar de máscara ou área específica
//
// Autenticação: Bearer Token via header Authorization
// Formato do body: multipart/form-data
// Resposta: imagem binária (Accept: image/*) ou JSON com base64
//
const STABILITY_API_KEY      = process.env.STABILITY_API_KEY || '';
const STABILITY_STRUCTURE_URL = 'https://api.stability.ai/v2beta/stable-image/control/structure';

/**
 * Processa uma imagem com o modelo Structure da Stability AI.
 * Preserva a composição original e aplica a transformação descrita no prompt.
 *
 * @param {Buffer} imageBuffer  - imagem original em memória (JPEG/PNG/WebP)
 * @param {string} prompt       - instrução de edição em texto
 * @returns {Promise<Buffer>}   - imagem processada em memória (PNG)
 */
async function processWithAI(imageBuffer, prompt) {
  console.log(`[Stability] Iniciando processamento. Prompt: "${prompt}"`);

  if (!STABILITY_API_KEY) {
    throw new Error('STABILITY_API_KEY não configurada.');
  }

  // Monta o FormData com os campos exigidos pela API
  // A API aceita multipart/form-data — usamos o FormData nativo do Node 18+
  const form = new FormData();

  // Envia a imagem como Blob (necessário para o FormData nativo do Node 18+)
  const blob = new Blob([imageBuffer], { type: 'image/png' });
  form.append('image',         blob,    'image.png');
  form.append('prompt',        prompt);
  form.append('output_format', 'png');   // png | jpeg | webp
  // control_strength: 0.0–1.0 — quanto a estrutura da imagem original é preservada
  // 0.7 = boa fidelidade à composição original com liberdade criativa para o prompt
  form.append('control_strength', '0.7');

  const response = await fetch(STABILITY_STRUCTURE_URL, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${STABILITY_API_KEY}`,
      'Accept':        'image/*',  // retorna bytes binários da imagem
    },
    body: form,
  });

  // Conteúdo filtrado por política de segurança da Stability AI
  if (response.headers.get('finish-reason') === 'CONTENT_FILTERED') {
    throw new Error('Stability AI: imagem ou prompt bloqueados pela política de conteúdo.');
  }

  // Erros HTTP tratados individualmente
  if (response.status === 401 || response.status === 403) {
    throw new Error('Stability AI: chave de API inválida ou sem permissão.');
  }
  if (response.status === 400) {
    let msg = 'entrada inválida';
    try { const j = await response.json(); msg = JSON.stringify(j); } catch (_) {}
    throw new Error(`Stability AI: ${msg}`);
  }
  if (response.status === 402) {
    throw new Error('Stability AI: créditos insuficientes na conta.');
  }
  if (!response.ok) {
    let msg = `erro HTTP ${response.status}`;
    try { const j = await response.json(); msg = JSON.stringify(j); } catch (_) {}
    throw new Error(`Stability AI: ${msg}`);
  }

  // Lê a resposta como buffer binário (imagem PNG)
  const arrayBuffer = await response.arrayBuffer();
  const resultBuffer = Buffer.from(arrayBuffer);
  console.log(`[Stability] Imagem gerada com sucesso (${resultBuffer.length} bytes).`);
  return resultBuffer;
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

// ─── Estado "ao vivo" — imagem pinada pelo operador ────────────────────────────
// Quando o operador clica em uma imagem no lightbox, ela é salva aqui.
// A rota GET /api/public/latest retorna esta imagem em vez da mais recente
// do Cloudinary — enquanto houver um pin ativo.
let pinnedImage = null; // { url, publicId, createdAt, pinnedAt }

// GET /api/public/autologin?token=...
// Rota exclusiva para o fluxo public-view → galeria.
// Troca o PUBLIC_VIEW_TOKEN por uma sessão autenticada válida,
// sem precisar digitar usuário e senha.
// Segurança: só funciona com o mesmo token que já protege a public-view.
app.get('/api/public/autologin', (req, res) => {
  if (!req.query.token || req.query.token !== PUBLIC_VIEW_TOKEN) {
    return res.status(403).json({ error: 'Token inválido.' });
  }
  const token = createToken();
  sessions.set(token, { createdAt: Date.now() });
  res.json({ token });
});

// POST /api/public/unpin — autenticada, limpa o pin manualmente
app.post('/api/public/unpin', requireAuth, (req, res) => {
  pinnedImage = null;
  res.json({ success: true });
});

// POST /api/public/pin  — autenticada, seta a imagem ao vivo
app.post('/api/public/pin', requireAuth, (req, res) => {
  const { url, publicId, createdAt } = req.body;
  if (!url || !publicId) {
    return res.status(400).json({ error: 'url e publicId são obrigatórios' });
  }
  pinnedImage = { url, publicId, createdAt: createdAt || Date.now(), pinnedAt: Date.now() };
  res.json({ success: true, pinnedAt: pinnedImage.pinnedAt });
});

// GET /api/public/images?token=... — lista completa de imagens para a página pública
// Mesma proteção de token, sem necessidade de login.
app.get('/api/public/images', async (req, res) => {
  if (!req.query.token || req.query.token !== PUBLIC_VIEW_TOKEN) {
    return res.status(403).json({ error: 'Acesso negado. Token inválido ou ausente.' });
  }
  try {
    const resources = await fetchAllImages();
    const images    = resources.map((r) => ({
      url:       r.secure_url,
      publicId:  r.public_id,
      createdAt: new Date(r.created_at).getTime(),
    }));
    res.json(images);
  } catch (err) {
    console.error('GET /api/public/images error:', err);
    res.status(500).json({ error: 'Erro ao buscar imagens.' });
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
    // Se houver imagem pinada pelo operador, retorna ela diretamente.
    // Pin expira automaticamente em 2 horas (segurança contra pins esquecidos).
    if (pinnedImage) {
      const PIN_TTL = 2 * 60 * 60 * 1000; // 2 horas
      if (Date.now() - pinnedImage.pinnedAt > PIN_TTL) {
        console.log('[pin] Pin expirado (2h), limpando automaticamente.');
        pinnedImage = null;
      } else {
        return res.json({
          url:       pinnedImage.url,
          publicId:  pinnedImage.publicId,
          createdAt: pinnedImage.createdAt,
          pinned:    true,
          pinnedAt:  pinnedImage.pinnedAt,
        });
      }
    }

    // Fallback: imagem mais recente do Cloudinary
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
// Campo opcional no body: "prompt" (string) — se presente, processa com IA antes de salvar.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

app.post('/api/upload', requireAuth, upload.single('image'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Nenhum arquivo enviado.' });
  }
  if (!ALLOWED_TYPES.includes(req.file.mimetype)) {
    return res.status(400).json({ success: false, message: 'Tipo de arquivo não permitido.' });
  }

  const prompt = (req.body.prompt || '').trim();
  const useAI  = prompt.length > 0;

  // Valida chave Stability AI se o usuário pediu processamento com IA
  if (useAI && !STABILITY_API_KEY) {
    return res.status(400).json({
      success: false,
      message: 'STABILITY_API_KEY não configurada no servidor. Defina a variável de ambiente ou faça o upload sem prompt.',
    });
  }

  try {
    const random   = crypto.randomBytes(4).toString('hex');
    const publicId = `photostream/img_${Date.now()}_${random}`;

    let finalBuffer = req.file.buffer;
    let aiProcessed = false;

    // ── Etapa 1: Processamento com IA (opcional) ──────────────────────────────
    if (useAI) {
      console.log(`[upload] Iniciando processamento com Stability AI. Prompt: "${prompt}"`);
      try {
        finalBuffer = await processWithAI(req.file.buffer, prompt);
        aiProcessed  = true;
        console.log('[upload] IA concluída. Enviando para Cloudinary…');
      } catch (aiErr) {
        console.error('[upload] Erro na IA:', aiErr.message);
        return res.status(502).json({
          success: false,
          message: `Erro no processamento com IA: ${aiErr.message}`,
        });
      }
    }

    // ── Etapa 2: Upload para Cloudinary ───────────────────────────────────────
    // Sem eager transforms: evita o "filtro azul" em HTTPS no Render,
    // causado por URLs eager com f_auto que podem retornar AVIF/WebP
    // com metadados de cor corrompidos antes do processamento terminar.
    // O Cloudinary já otimiza automaticamente na entrega via CDN.
    const result = await uploadToCloudinary(finalBuffer, {
      public_id:     publicId,
      resource_type: 'image',
    });

    // ── Limpa o pin ativo ─────────────────────────────────────────────────────
    // Um novo upload é uma intenção explícita de mostrar essa foto ao vivo.
    // Se houver um pin ativo, ele precisa ser zerado para que a public-view
    // passe a exibir a nova foto (e não continue presa na foto pinada).
    pinnedImage = null;

    res.json({
      success:     true,
      url:         result.secure_url,
      publicId:    result.public_id,
      aiProcessed,
      message:     aiProcessed
        ? '✦ Imagem processada pela IA e enviada com sucesso!'
        : 'Imagem enviada com sucesso!',
    });
  } catch (err) {
    console.error('POST /api/upload error:', err);
    res.status(500).json({ success: false, message: 'Erro ao fazer upload da imagem.' });
  }
});

// ─── Health check / ping (mantém o serviço acordado no Render free tier) ────────
// O Render dorme serviços gratuitos após 15 min de inatividade.
// Esta rota leve é usada pelo auto-ping interno E por serviços externos
// como UptimeRobot para manter o servidor sempre ativo.
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ─── Start ───────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`PhotoStream running on http://localhost:${PORT}`);
});

// Render free tier fecha conexões ociosas após ~75s.
// Aumentar keepAliveTimeout e headersTimeout evita "Connection reset" intermitente.
server.keepAliveTimeout = 120_000;  // 120s
server.headersTimeout   = 125_000;  // deve ser maior que keepAliveTimeout

// ─── Auto-ping interno ────────────────────────────────────────────────────────────
// Pinga o próprio servidor a cada 10 minutos para evitar o sleep do Render.
// Só ativa em produção (quando PORT vem do ambiente, não localhost).
if (process.env.PORT) {
  const SELF_URL      = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL}/api/ping`
    : `http://localhost:${PORT}/api/ping`;
  const PING_INTERVAL = 10 * 60 * 1000; // 10 minutos

  setInterval(async () => {
    try {
      await fetch(SELF_URL);
      console.log(`[ping] self-ping ok → ${SELF_URL}`);
    } catch (e) {
      console.warn(`[ping] self-ping falhou: ${e.message}`);
    }
  }, PING_INTERVAL);

  console.log(`[ping] auto-ping ativo a cada 10min → ${SELF_URL}`);
}
