'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════════════════ */
const state = {
  token:           null,
  images:          [],
  currentIndex:    0,
  latestTimestamp: 0,
  lightboxIndex:   0,
};

// Detecta se o usuário veio da public-view via botão "Galeria"
const _qs          = new URLSearchParams(location.search);
const FROM_PUBLIC  = _qs.get('from') === 'public-view';
const RETURN_URL   = FROM_PUBLIC ? (_qs.get('returnUrl') || '') : '';
// Token público passado pela public-view para autologin automático
const PV_TOKEN     = FROM_PUBLIC ? (_qs.get('pvtoken') || '') : '';

let pollingInterval = null;
let newBadgeTimer   = null;
let liveToastTimer  = null;

// ── Estado da galeria paginada ─────────────────────────────────────────────────
// A galeria pagina client-side sobre state.images (já carregado pelo viewer).
// Isso elimina chamadas extras ao Cloudinary e exibe imagens + vídeos juntos.
const GALLERY_PAGE_SIZE = 8;
const gallery = {
  items:   [],   // subconjunto de state.images atualmente renderizado
  offset:  0,    // quantos itens já foram exibidos
  total:   0,    // espelha state.images.length para detectar mudanças
  loading: false,
};

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════════════════ */
function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      'x-auth-token': state.token || '',
      ...(options.headers || {}),
    },
  });
}

function formatBytes(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function downloadFilename() {
  const now  = new Date();
  const pad  = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `PhotoStream_${date}_${time}.jpg`;
}

/* Helper — detecta se um item é vídeo */
function isVideo(item) { return item && item.type === 'video'; }

function triggerDownload(url, filename) {
  // Usa rota proxy do próprio servidor para garantir que o atributo `download`
  // funcione com o nome correto. Links cross-origin (Cloudinary) ignoram o
  // atributo `download` do navegador — o proxy contorna essa restrição.
  const proxyUrl = `/api/download?url=${encodeURIComponent(url)}&filename=${encodeURIComponent(filename)}`;
  const a = document.createElement('a');
  a.href     = proxyUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIVE PIN — envia imagem atual para a página pública
═══════════════════════════════════════════════════════════════════════════ */
async function pinToLive(index) {
  const img = state.images[index];
  if (!img) return;

  try {
    const r = await api('/api/public/pin', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url:          img.url,
        thumbnailUrl: img.thumbnailUrl || img.url,
        publicId:     img.publicId,
        createdAt:    img.createdAt,
        type:         img.type || 'image',
      }),
    });
    if (r.ok) {
      showLiveToast();
      // Se o usuário veio da public-view via botão "Galeria", redireciona de volta
      // após o pin, para que a public-view exiba imediatamente a imagem escolhida.
      if (FROM_PUBLIC && RETURN_URL) {
        setTimeout(() => { window.location.href = RETURN_URL; }, 900);
      }
    }
  } catch (_) {}
}

function showLiveToast() {
  const toast = document.getElementById('liveToast');
  toast.classList.remove('hidden');
  toast.classList.add('toast-enter');
  if (liveToastTimer) clearTimeout(liveToastTimer);
  liveToastTimer = setTimeout(() => {
    toast.classList.add('toast-leave');
    setTimeout(() => {
      toast.classList.add('hidden');
      toast.classList.remove('toast-enter', 'toast-leave');
    }, 400);
  }, 2500);
}

/* ═══════════════════════════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════════════════════════ */
async function init() {
  // Caso 1: já tem token salvo — verifica se ainda é válido
  const saved = localStorage.getItem('ps_token');
  if (saved) {
    state.token = saved;
    try {
      const r = await api('/api/check');
      if (r.ok) { showApp(); return; }
    } catch (_) {}
    state.token = null;
    localStorage.removeItem('ps_token');
  }

  // Caso 2: veio da public-view com pvtoken → faz autologin automático,
  // sem pedir usuário e senha. O servidor valida o PUBLIC_VIEW_TOKEN
  // e retorna uma sessão autenticada.
  if (FROM_PUBLIC && PV_TOKEN) {
    try {
      const r    = await fetch(`/api/public/autologin?token=${encodeURIComponent(PV_TOKEN)}`);
      const data = await r.json();
      if (r.ok && data.token) {
        state.token = data.token;
        localStorage.setItem('ps_token', data.token);
        showApp();
        return;
      }
    } catch (_) {}
    // Autologin falhou (token inválido) — cai no login normal
  }

  showLogin();
}

async function login() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl    = document.getElementById('loginError');
  const btn      = document.getElementById('loginBtn');
  const btnText  = document.getElementById('loginBtnText');

  errEl.classList.add('hidden');
  btn.disabled = true;
  btnText.textContent = 'Entrando…';

  try {
    const r    = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await r.json();
    if (r.ok && data.token) {
      state.token = data.token;
      localStorage.setItem('ps_token', data.token);
      showApp();
    } else {
      showLoginError(data.error || 'Credenciais inválidas');
    }
  } catch (_) {
    showLoginError('Erro de conexão. Tente novamente.');
  } finally {
    btn.disabled = false;
    btnText.textContent = 'Entrar';
  }
}

function showLoginError(msg) {
  const el = document.getElementById('loginError');
  el.textContent = msg;
  el.classList.remove('hidden');
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
  stopPolling();
  state.token          = null;
  state.images         = [];
  state.currentIndex   = 0;
  state.latestTimestamp = 0;
  localStorage.removeItem('ps_token');
  showLogin();
}

/* ═══════════════════════════════════════════════════════════════════════════
   SCREEN TRANSITIONS
═══════════════════════════════════════════════════════════════════════════ */
function showLogin() {
  document.getElementById('appScreen').classList.add('hidden');
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPass').value = '';
  document.getElementById('loginError').classList.add('hidden');
}

function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appScreen').classList.remove('hidden');
  loadImages();
  startPolling();

  // Se veio da public-view, abre direto na aba Galeria
  if (FROM_PUBLIC) switchTab('gallery');
}

/* ═══════════════════════════════════════════════════════════════════════════
   TABS
═══════════════════════════════════════════════════════════════════════════ */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel${cap(name)}`);
    p.classList.toggle('hidden', p.id !== `panel${cap(name)}`);
  });
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ═══════════════════════════════════════════════════════════════════════════
   IMAGES — load / polling
═══════════════════════════════════════════════════════════════════════════ */
async function loadImages(isPolling = false) {
  try {
    const r    = await api('/api/images');
    if (!r.ok) return;
    const data = await r.json();

    const wasEmpty     = state.images.length === 0;
    const prevFirstUrl = state.images[0]?.url || null;
    state.images       = data;

    if (state.images.length > 0) {
      state.latestTimestamp = state.images[0].createdAt;
    }

    // detect new image during polling
    if (isPolling && !wasEmpty && prevFirstUrl && state.images[0]?.url !== prevFirstUrl) {
      state.currentIndex = 0;
      showNewBadge();
      if (!document.getElementById('lightbox').classList.contains('hidden')) {
        state.lightboxIndex = 0;
        loadLightboxImage(0);
      }
    }

    renderViewer();
    renderGallery();
  } catch (_) {}
}

function startPolling() {
  stopPolling();
  pollingInterval = setInterval(async () => {
    try {
      const r    = await api('/api/images/latest');
      if (!r.ok) return;
      const data = await r.json();
      if (data.latest > state.latestTimestamp || data.count !== state.images.length) {
        state.latestTimestamp = data.latest;
        await loadImages(true);
      }
    } catch (_) {}
  }, 15000);
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

function showNewBadge() {
  const badge = document.getElementById('newBadge');
  badge.classList.remove('hidden');
  if (newBadgeTimer) clearTimeout(newBadgeTimer);
  newBadgeTimer = setTimeout(() => badge.classList.add('hidden'), 3500);
}

/* ═══════════════════════════════════════════════════════════════════════════
   VIEWER
═══════════════════════════════════════════════════════════════════════════ */
function renderViewer() {
  const total    = state.images.length;
  const counter  = document.getElementById('viewCounter');
  const empty    = document.getElementById('viewEmpty');
  const wrap     = document.getElementById('viewImgWrap');
  const prevBtn  = document.getElementById('viewPrev');
  const nextBtn  = document.getElementById('viewNext');
  const dlBtn    = document.getElementById('viewDownload');

  if (total === 0) {
    counter.textContent = '— / —';
    empty.classList.remove('hidden');
    wrap.classList.add('hidden');
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    dlBtn.disabled   = true;
    return;
  }

  if (state.currentIndex >= total) state.currentIndex = total - 1;

  counter.textContent = `${state.currentIndex + 1} / ${total}`;
  empty.classList.add('hidden');
  wrap.classList.remove('hidden');
  dlBtn.disabled = false;

  // Anterior = older = higher index; Próxima = newer = lower index
  prevBtn.disabled = state.currentIndex >= total - 1;
  nextBtn.disabled = state.currentIndex <= 0;

  loadViewerImage();
}

function loadViewerImage() {
  const item    = state.images[state.currentIndex];
  const img     = document.getElementById('viewImg');
  const video   = document.getElementById('viewVideo');
  const spinner = document.getElementById('viewImgSpinner');
  if (!item) return;

  spinner.classList.remove('hidden');

  if (isVideo(item)) {
    img.classList.add('hidden');
    img.src = '';
    video.classList.remove('hidden');
    video.pause();
    video.src = item.url;
    video.load();
    video.onloadedmetadata = () => spinner.classList.add('hidden');
    video.onerror          = () => spinner.classList.add('hidden');
  } else {
    video.classList.add('hidden');
    video.pause();
    video.src = '';
    img.classList.remove('hidden');
    img.style.opacity = '0';
    img.onload = () => {
      spinner.classList.add('hidden');
      img.style.opacity = '1';
      img.style.transition = 'opacity .2s';
    };
    img.onerror = () => spinner.classList.add('hidden');
    img.src = item.url;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   GALLERY — paginada client-side (8 por vez, botão "Carregar mais")
   Usa state.images como fonte, sem chamadas extras ao Cloudinary.
   Exibe imagens e vídeos juntos, na mesma ordem do viewer.
═══════════════════════════════════════════════════════════════════════════ */

/**
 * Exibe a próxima página da galeria a partir de state.images.
 * Se isReset=true, limpa o grid e recomeça do início.
 */
function loadGalleryPage(isReset = false) {
  if (gallery.loading) return;

  const grid    = document.getElementById('galleryGrid');
  const empty   = document.getElementById('galleryEmpty');
  const count   = document.getElementById('galleryCount');
  const spinner = document.getElementById('gallerySpinner');
  const loadBtn = document.getElementById('galleryLoadMore');

  if (isReset) {
    gallery.items  = [];
    gallery.offset = 0;
    gallery.total  = state.images.length;
    grid.innerHTML = '';
    empty.classList.add('hidden');
    loadBtn.classList.add('hidden');
  }

  if (state.images.length === 0) {
    empty.classList.remove('hidden');
    count.textContent = '0 fotos';
    return;
  }

  gallery.loading = true;
  spinner.classList.remove('hidden');

  if (!isReset) {
    loadBtn.disabled = true;
    loadBtn.innerHTML = '<span class="lm-spinner"></span> Carregando…';
  }

  const startIdx = gallery.offset;
  const newItems = state.images.slice(startIdx, startIdx + GALLERY_PAGE_SIZE);
  gallery.offset += newItems.length;
  gallery.items   = [...gallery.items, ...newItems];
  gallery.total   = state.images.length;

  const total = state.images.length;
  count.textContent = `${gallery.offset} de ${total} foto${total !== 1 ? 's' : ''}`;

  empty.classList.add('hidden');
  appendGalleryItems(grid, newItems, startIdx);

  if (gallery.offset < total) {
    loadBtn.classList.remove('hidden');
    loadBtn.disabled = false;
    loadBtn.textContent = 'Carregar mais';
  } else {
    loadBtn.classList.add('hidden');
  }

  gallery.loading = false;
  spinner.classList.add('hidden');
}

/**
 * Cria e insere os cards de galeria no grid.
 * startIdx: posição global (para numeração correta dos badges).
 */
function appendGalleryItems(grid, items, startIdx) {
  // Para vídeos usamos thumbnailUrl (frame do vídeo gerado pelo Cloudinary).
  // Para imagens usamos a própria url.
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el   = entry.target;
      const turl = el.dataset.thumb;
      if (!turl) return;
      const img = document.createElement('img');
      img.alt     = '';
      img.onload  = () => { el.querySelector('.gallery-placeholder')?.remove(); };
      img.onerror = () => { el.querySelector('.gallery-placeholder')?.remove(); };
      img.src = turl;
      el.appendChild(img);
      el.removeAttribute('data-thumb');
      observer.unobserve(el);
    });
  }, { rootMargin: '150px' });

  items.forEach((item, i) => {
    const globalIdx = startIdx + i;
    const div       = document.createElement('div');
    div.className       = 'gallery-item';
    div.dataset.thumb   = item.thumbnailUrl || item.url;
    div.dataset.index   = globalIdx;

    // Placeholder spinner
    const ph = document.createElement('div');
    ph.className = 'gallery-placeholder';
    const sp = document.createElement('div');
    sp.className = 'spinner';
    ph.appendChild(sp);
    div.appendChild(ph);

    // Badge número
    const num = document.createElement('span');
    num.className   = 'gallery-num';
    num.textContent = globalIdx + 1;
    div.appendChild(num);

    // Vídeos: play overlay + badge "VÍD"
    if (isVideo(item)) {
      const overlay = document.createElement('div');
      overlay.className = 'play-overlay';
      overlay.innerHTML = `<svg viewBox="0 0 24 24" fill="white"><circle cx="12" cy="12" r="11" fill="rgba(0,0,0,0.5)"/><polygon points="10,8 17,12 10,16" fill="white"/></svg>`;
      div.appendChild(overlay);

      const vbadge = document.createElement('span');
      vbadge.className   = 'video-badge';
      vbadge.textContent = '▶ VÍD';
      div.appendChild(vbadge);
    }

    // Clique → lightbox
    div.addEventListener('click', () => {
      const idx = state.images.findIndex(m => m.url === item.url);
      openLightbox(idx >= 0 ? idx : 0);
    });

    grid.appendChild(div);
    observer.observe(div);
  });
}

/**
 * Chamado pelo polling/loadImages para refletir novas mídias na galeria.
 * Reinicia o grid se houver mudança no total.
 */
function renderGallery() {
  if (state.images.length !== gallery.total || gallery.items.length === 0) {
    loadGalleryPage(true);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   LIGHTBOX
═══════════════════════════════════════════════════════════════════════════ */
function openLightbox(index) {
  state.lightboxIndex = index;
  document.getElementById('lightbox').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  loadLightboxImage(index);
}

function closeLightbox() {
  const lb    = document.getElementById('lightbox');
  const video = document.getElementById('lightboxVideo');
  lb.classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('lightboxImg').src = '';
  video.pause();
  video.src = '';
  video.classList.add('hidden');
}

function loadLightboxImage(index) {
  const total  = state.images.length;
  const img    = document.getElementById('lightboxImg');
  const spin   = document.getElementById('lightboxSpinner');
  const cnt    = document.getElementById('lightboxCounter');
  const dlLink = document.getElementById('lightboxDownload');
  const prev   = document.getElementById('lightboxPrev');
  const next   = document.getElementById('lightboxNext');

  if (total === 0) { closeLightbox(); return; }
  if (index < 0)      index = 0;
  if (index >= total) index = total - 1;

  state.lightboxIndex = index;
  cnt.textContent = `${index + 1} / ${total}`;

  // Anterior = older = higher index; Próxima = newer = lower index
  prev.disabled = index >= total - 1;
  next.disabled = index <= 0;

  const item  = state.images[index];
  const video = document.getElementById('lightboxVideo');
  const hint  = document.getElementById('lightboxLiveHint');

  spin.classList.remove('hidden');

  if (isVideo(item)) {
    img.classList.add('hidden');
    img.src = '';
    if (hint) hint.classList.add('hidden');
    video.classList.remove('hidden');
    video.pause();
    video.src = item.url;
    video.load();
    video.onloadedmetadata = () => spin.classList.add('hidden');
    video.onerror          = () => spin.classList.add('hidden');
  } else {
    video.classList.add('hidden');
    video.pause();
    video.src = '';
    if (hint) hint.classList.remove('hidden');
    img.classList.remove('hidden');
    img.style.opacity = '0';
    img.onload = () => {
      spin.classList.add('hidden');
      img.style.opacity = '1';
      img.style.transition = 'opacity .2s';
    };
    img.onerror = () => spin.classList.add('hidden');
    img.src = item.url;
  }

  // Download — extensão correta para vídeos
  const ext      = isVideo(item) ? item.url.split('.').pop().split('?')[0] : 'jpg';
  const fname    = `PhotoStream_${downloadFilename().replace('PhotoStream_','').replace('.jpg','')}.${ext}`;
  const proxyUrl = `/api/download?url=${encodeURIComponent(item.url)}&filename=${encodeURIComponent(fname)}`;
  dlLink.href     = proxyUrl;
  dlLink.download = fname;
}

/* ═══════════════════════════════════════════════════════════════════════════
   UPLOAD
═══════════════════════════════════════════════════════════════════════════ */
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/quicktime', 'video/webm', 'video/avi', 'video/x-msvideo'];
const ALLOWED_TYPES       = [...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES];
const MAX_IMAGE_SIZE      = 10  * 1024 * 1024;   // 10 MB
const MAX_VIDEO_SIZE      = 200 * 1024 * 1024;   // 200 MB

let selectedFile = null;

function resetUpload() {
  const pv = document.getElementById('previewVideo');
  if (pv.src && pv.src.startsWith('blob:')) URL.revokeObjectURL(pv.src);
  pv.src = '';
  pv.classList.add('hidden');
  document.getElementById('previewImg').classList.remove('hidden');
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadInitial').classList.remove('hidden');
  document.getElementById('uploadPreview').classList.add('hidden');
  hideFeedback();
}

function showFeedback(msg, type) {
  const el = document.getElementById('uploadFeedback');
  el.textContent = msg;
  el.className   = `upload-feedback ${type}`;
  el.classList.remove('hidden');
}

function hideFeedback() {
  document.getElementById('uploadFeedback').classList.add('hidden');
}

function handleFileSelect(file) {
  hideFeedback();
  if (!file) return;

  const isVid = ALLOWED_VIDEO_TYPES.includes(file.type);
  if (!ALLOWED_TYPES.includes(file.type)) {
    showFeedback('Tipo não permitido. Use JPEG/PNG/WebP/GIF ou MP4/MOV/WebM.', 'error');
    return;
  }
  const maxSize = isVid ? MAX_VIDEO_SIZE : MAX_IMAGE_SIZE;
  if (file.size > maxSize) {
    showFeedback(`Arquivo muito grande. Máximo ${isVid ? '200' : '10'} MB.`, 'error');
    return;
  }

  selectedFile = file;
  const previewImg   = document.getElementById('previewImg');
  const previewVideo = document.getElementById('previewVideo');

  if (isVid) {
    previewImg.classList.add('hidden');
    previewVideo.classList.remove('hidden');
    previewVideo.src = URL.createObjectURL(file);
  } else {
    previewVideo.classList.add('hidden');
    previewImg.classList.remove('hidden');
    const reader = new FileReader();
    reader.onload = (e) => { previewImg.src = e.target.result; };
    reader.readAsDataURL(file);
  }

  document.getElementById('previewName').textContent = file.name;
  document.getElementById('previewSize').textContent = formatBytes(file.size);
  document.getElementById('uploadInitial').classList.add('hidden');
  document.getElementById('uploadPreview').classList.remove('hidden');
}

async function sendUpload() {
  if (!selectedFile) return;

  const btn = document.getElementById('sendUploadBtn');
  btn.disabled    = true;
  const isVidUpload = selectedFile && ALLOWED_VIDEO_TYPES.includes(selectedFile.type);
  btn.textContent = 'Enviando…';
  showFeedback(isVidUpload ? 'Enviando vídeo…' : 'Enviando imagem…', 'loading');

  const form = new FormData();
  form.append('image', selectedFile);
  // Nota: processamento com IA (Stability AI) está temporariamente desativado.
  // Para reativar, adicione o campo "prompt" ao FormData e restaure o bloco
  // de UI no index.html (.ai-prompt-wrap) e o listener do aiPrompt.

  try {
    const r    = await api('/api/upload', { method: 'POST', body: form });
    const data = await r.json();
    if (data.success) {
      showFeedback('✓ ' + data.message, 'success');
      resetUpload();
      state.latestTimestamp = 0;
      await loadImages();
    } else {
      showFeedback(data.message || 'Erro ao enviar.', 'error');
    }
  } catch (_) {
    showFeedback('Erro de conexão. Tente novamente.', 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '↑ Enviar';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   EVENT LISTENERS
═══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  // ── Login ────────────────────────────────────────────────────────────────
  document.getElementById('loginBtn').addEventListener('click', login);
  document.getElementById('loginUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  document.getElementById('loginPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  // toggle password visibility
  document.getElementById('togglePass').addEventListener('click', () => {
    const inp  = document.getElementById('loginPass');
    const icon = document.getElementById('eyeIcon');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    icon.innerHTML = show
      ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>'
      : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  });

  // ── App ──────────────────────────────────────────────────────────────────
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // Tabs
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // ── Upload ───────────────────────────────────────────────────────────────
  const zone      = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');

  document.getElementById('chooseFileBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFileSelect(fileInput.files[0]));

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFileSelect(e.dataTransfer.files[0]);
  });

  document.getElementById('cancelUploadBtn').addEventListener('click', resetUpload);
  document.getElementById('sendUploadBtn').addEventListener('click', sendUpload);

  // Nota: listener do aiPrompt removido (UI de IA desativada temporariamente).

  // ── Viewer ───────────────────────────────────────────────────────────────
  document.getElementById('viewRefreshBtn').addEventListener('click', () => loadImages());

  document.getElementById('viewPrev').addEventListener('click', () => {
    if (state.currentIndex < state.images.length - 1) {
      state.currentIndex++;
      renderViewer();
    }
  });
  document.getElementById('viewNext').addEventListener('click', () => {
    if (state.currentIndex > 0) {
      state.currentIndex--;
      renderViewer();
    }
  });
  document.getElementById('viewDownload').addEventListener('click', () => {
    const img = state.images[state.currentIndex];
    if (img) triggerDownload(img.url, downloadFilename());
  });

  // click on viewer image opens lightbox
  document.getElementById('viewImg').addEventListener('click', () => {
    openLightbox(state.currentIndex);
  });

  // ── Gallery ──────────────────────────────────────────────────────────────
  document.getElementById('galleryRefreshBtn').addEventListener('click', () => {
    loadGalleryPage(true); // reinicia do zero
  });
  document.getElementById('galleryLoadMore').addEventListener('click', () => {
    loadGalleryPage(false); // carrega próxima página
  });

  // ── Lightbox ─────────────────────────────────────────────────────────────
  const lightbox = document.getElementById('lightbox');

  document.getElementById('lightboxClose').addEventListener('click', closeLightbox);

  // Clique na imagem do lightbox → pina ao vivo (apenas imagens)
  document.getElementById('lightboxImg').addEventListener('click', () => {
    const item = state.images[state.lightboxIndex];
    if (!isVideo(item)) pinToLive(state.lightboxIndex);
  });

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });

  document.getElementById('lightboxPrev').addEventListener('click', () => {
    if (state.lightboxIndex < state.images.length - 1) {
      loadLightboxImage(state.lightboxIndex + 1);
    }
  });
  document.getElementById('lightboxNext').addEventListener('click', () => {
    if (state.lightboxIndex > 0) {
      loadLightboxImage(state.lightboxIndex - 1);
    }
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (lightbox.classList.contains('hidden')) return;
    if (e.key === 'Escape')      closeLightbox();
    if (e.key === 'ArrowLeft')   { if (state.lightboxIndex < state.images.length - 1) loadLightboxImage(state.lightboxIndex + 1); }
    if (e.key === 'ArrowRight')  { if (state.lightboxIndex > 0) loadLightboxImage(state.lightboxIndex - 1); }
  });

  // swipe
  let touchStartX = 0;
  lightbox.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].clientX; }, { passive: true });
  lightbox.addEventListener('touchend', (e) => {
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) < 50) return;
    if (diff > 0) {
      // swipe left → next (more recent = lower index)
      if (state.lightboxIndex > 0) loadLightboxImage(state.lightboxIndex - 1);
    } else {
      // swipe right → prev (older = higher index)
      if (state.lightboxIndex < state.images.length - 1) loadLightboxImage(state.lightboxIndex + 1);
    }
  }, { passive: true });

  // ── Kick off ─────────────────────────────────────────────────────────────
  init();
});
