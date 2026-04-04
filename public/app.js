/**
 * PhotoStream — Frontend App
 * Funcionalidades:
 *  - Login / logout com token em memória
 *  - Upload de imagens
 *  - Visualizador com navegação, download e lightbox (tela cheia ao clicar)
 *  - Galeria em grade responsiva com lightbox integrado
 *  - Polling automático a cada 5 segundos
 */

// ─── ESTADO GLOBAL ─────────────────────────────────────────────────────────────
const state = {
  token: localStorage.getItem('ps_token') || null,
  images: [],        // [{ url, publicId, createdAt }, ...]
  currentIndex: 0,   // índice ativo no visualizador
  latestTimestamp: 0,
  lightboxIndex: 0,  // índice ativo no lightbox
  lightboxOrigin: 'viewer' // 'viewer' | 'gallery'
};

// ─── ATALHO DOM ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// Login
const loginScreen   = $('loginScreen');
const appScreen     = $('appScreen');
const loginError    = $('loginError');
const usernameEl    = $('username');
const passwordEl    = $('password');
const togglePw      = $('togglePw');
const loginBtn      = $('loginBtn');
const logoutBtn     = $('logoutBtn');

// Tabs
const tabUpload     = $('tabUpload');
const tabView       = $('tabView');
const tabGallery    = $('tabGallery');
const panelUpload   = $('panelUpload');
const panelView     = $('panelView');
const panelGallery  = $('panelGallery');

// Upload
const uploadZone    = $('uploadZone');
const uploadInner   = $('uploadInner');
const previewWrap   = $('previewWrap');
const previewImg    = $('previewImg');
const previewName   = $('previewName');
const previewSize   = $('previewSize');
const fileInput     = $('fileInput');
const selectFileBtn = $('selectFileBtn');
const cancelBtn     = $('cancelBtn');
const sendBtn       = $('sendBtn');
const uploadStatus  = $('uploadStatus');

// Viewer
const imgCounter    = $('imgCounter');
const refreshBtn    = $('refreshBtn');
const noImages      = $('noImages');
const imgStage      = $('imgStage');
const currentImg    = $('currentImg');
const imgLoading    = $('imgLoading');
const newBadge      = $('newBadge');
const prevBtn       = $('prevBtn');
const downloadBtn   = $('downloadBtn');
const nextBtn       = $('nextBtn');

// Galeria
const galleryCount        = $('galleryCount');
const galleryRefreshBtn   = $('galleryRefreshBtn');
const galleryGrid         = $('galleryGrid');
const galleryEmpty        = $('galleryEmpty');
const galleryLoading      = $('galleryLoading');

// Lightbox
const lightbox        = $('lightbox');
const lightboxClose   = $('lightboxClose');
const lightboxPrev    = $('lightboxPrev');
const lightboxNext    = $('lightboxNext');
const lightboxImg     = $('lightboxImg');
const lightboxSpinner = $('lightboxSpinner');
const lightboxCounter = $('lightboxCounter');
const lightboxDownload= $('lightboxDownload');

// ─── UTILITÁRIOS ───────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function api(method, endpoint, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': state.token }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(endpoint, opts);
  if (res.status === 401) { handleLogout(false); throw new Error('Sessão expirada.'); }
  return res;
}

function showStatus(msg, type) {
  uploadStatus.textContent = msg;
  uploadStatus.className = `upload-status ${type}`;
  uploadStatus.classList.remove('hidden');
  if (type === 'success') setTimeout(() => uploadStatus.classList.add('hidden'), 4000);
}

// ─── AUTENTICAÇÃO ──────────────────────────────────────────────────────────────

async function init() {
  if (state.token) {
    try {
      const res = await fetch('/api/check', { headers: { 'x-auth-token': state.token } });
      if (res.ok) { showApp(); return; }
    } catch (_) {}
    state.token = null;
    localStorage.removeItem('ps_token');
  }
  showLogin();
}

function showLogin() {
  loginScreen.style.display = '';
  appScreen.style.display   = 'none';
  loginScreen.classList.add('active');
  appScreen.classList.remove('active');
  stopPolling();
}

function showApp() {
  loginScreen.style.display = 'none';
  appScreen.style.display   = 'flex';
  loginScreen.classList.remove('active');
  appScreen.classList.add('active');
  loadImages();
  startPolling();
}

loginBtn.addEventListener('click', async () => {
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) { showLoginError('Preencha usuário e senha.'); return; }
  loginBtn.disabled = true;
  loginBtn.textContent = 'Entrando...';
  try {
    const res  = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok && data.token) {
      state.token = data.token;
      localStorage.setItem('ps_token', data.token);
      loginError.classList.add('hidden');
      showApp();
    } else {
      showLoginError(data.error || 'Erro ao fazer login.');
    }
  } catch (_) {
    showLoginError('Erro de conexão. Tente novamente.');
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Entrar';
  }
});

[usernameEl, passwordEl].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
});

togglePw.addEventListener('click', () => {
  const show = passwordEl.type === 'password';
  passwordEl.type = show ? 'text' : 'password';
  togglePw.textContent = show ? '🙈' : '👁';
});

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

logoutBtn.addEventListener('click', () => handleLogout(true));

async function handleLogout(callApi = true) {
  if (callApi && state.token) {
    try { await fetch('/api/logout', { method: 'POST', headers: { 'x-auth-token': state.token } }); } catch (_) {}
  }
  state.token = null;
  localStorage.removeItem('ps_token');
  showLogin();
}

// ─── TABS ──────────────────────────────────────────────────────────────────────

const tabs   = [tabUpload,   tabView,   tabGallery];
const panels = [panelUpload, panelView, panelGallery];

function switchTab(idx) {
  tabs.forEach((t, i) => {
    t.classList.toggle('active', i === idx);
    panels[i].classList.toggle('active', i === idx);
  });
  if (idx === 1) loadImages();       // Visualizar
  if (idx === 2) renderGallery();    // Galeria
}

tabUpload .addEventListener('click', () => switchTab(0));
tabView   .addEventListener('click', () => switchTab(1));
tabGallery.addEventListener('click', () => switchTab(2));

// ─── UPLOAD ────────────────────────────────────────────────────────────────────

let selectedFile = null;

selectFileBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) handleFileSelected(file);
});

uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) handleFileSelected(file);
});

function handleFileSelected(file) {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) { showStatus('Tipo não permitido. Use JPG, PNG, WEBP ou GIF.', 'error'); return; }
  if (file.size > 10 * 1024 * 1024) { showStatus('Arquivo muito grande. Máximo: 10MB.', 'error'); return; }
  selectedFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    previewImg.src = e.target.result;
    previewName.textContent = file.name;
    previewSize.textContent = formatBytes(file.size);
    uploadInner.classList.add('hidden');
    previewWrap.classList.remove('hidden');
    uploadStatus.classList.add('hidden');
  };
  reader.readAsDataURL(file);
}

cancelBtn.addEventListener('click', resetUpload);

function resetUpload() {
  selectedFile = null; fileInput.value = ''; previewImg.src = '';
  previewWrap.classList.add('hidden'); uploadInner.classList.remove('hidden');
}

sendBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  sendBtn.disabled = true; sendBtn.textContent = 'Enviando...';
  showStatus('Enviando imagem...', 'loading');
  const formData = new FormData();
  formData.append('image', selectedFile);
  try {
    const res  = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-auth-token': state.token },
      body: formData
    });
    const data = await res.json();
    if (res.ok) {
      showStatus(`✓ ${data.message}`, 'success');
      resetUpload();
      await loadImages();
    } else {
      showStatus(data.error || 'Erro no upload.', 'error');
    }
  } catch (_) {
    showStatus('Erro de conexão. Tente novamente.', 'error');
  } finally {
    sendBtn.disabled = false; sendBtn.textContent = '↑ Enviar';
  }
});

// ─── CARREGAR IMAGENS ──────────────────────────────────────────────────────────

async function loadImages(isPolling = false) {
  try {
    const res  = await api('GET', '/api/images');
    const data = await res.json();
    const newImages = data.images || [];
    const hadImages = state.images.length > 0;
    const prevFirst = state.images[0]?.url;
    state.images = newImages;

    if (newImages.length === 0) { showNoImages(); return; }
    if (isPolling && hadImages && newImages[0]?.url !== prevFirst) {
      state.currentIndex = 0;
      showNewBadge();
      // Se o lightbox estiver aberto, atualiza para mostrar a nova imagem
      if (!lightbox.classList.contains('hidden')) {
        state.lightboxIndex = 0;
        loadLightboxImage(0);
      }
    }
    updateViewer();
  } catch (err) {
    console.error('Erro ao carregar imagens:', err);
  }
}

// ─── VISUALIZADOR ──────────────────────────────────────────────────────────────

function showNoImages() {
  noImages.classList.remove('hidden');
  imgStage.classList.add('hidden');
  imgCounter.textContent = '— / —';
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  downloadBtn.disabled = true;
}

function updateViewer() {
  if (state.images.length === 0) { showNoImages(); return; }

  noImages.classList.add('hidden');
  imgStage.classList.remove('hidden');

  const total = state.images.length;
  const idx   = state.currentIndex;
  const img   = state.images[idx];

  imgCounter.textContent  = `${idx + 1} / ${total}`;
  prevBtn.disabled        = idx >= total - 1;
  nextBtn.disabled        = idx <= 0;
  downloadBtn.disabled    = false;

  // Carrega imagem com feedback visual
  currentImg.classList.add('loading');
  imgLoading.classList.remove('hidden');

  const tempImg = new Image();
  tempImg.onload = () => {
    currentImg.src = tempImg.src;
    currentImg.classList.remove('loading');
    imgLoading.classList.add('hidden');
  };
  tempImg.onerror = () => {
    imgLoading.classList.add('hidden');
    currentImg.classList.remove('loading');
  };
  tempImg.src = img.url;
}

prevBtn.addEventListener('click', () => {
  if (state.currentIndex < state.images.length - 1) { state.currentIndex++; updateViewer(); }
});
nextBtn.addEventListener('click', () => {
  if (state.currentIndex > 0) { state.currentIndex--; updateViewer(); }
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.style.transform = 'rotate(360deg)';
  refreshBtn.style.transition = 'transform 0.5s';
  setTimeout(() => { refreshBtn.style.transform = ''; refreshBtn.style.transition = ''; }, 500);
  await loadImages();
});

// ── Gera nome de arquivo com timestamp ───────────────────
function downloadFilename() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `PhotoStream_${ts}.jpg`;
}

// ── Download da imagem atual ──────────────────────────────
downloadBtn.addEventListener('click', () => {
  const img = state.images[state.currentIndex];
  if (!img) return;
  triggerDownload(img.url, downloadFilename());
});

function triggerDownload(url, filename) {
  // Adiciona fl_attachment na URL do Cloudinary para forçar download
  // Para outros servidores, usa fetch + blob
  const a = document.createElement('a');
  // Tenta forçar download via URL com parâmetro do Cloudinary
  const dlUrl = url.includes('cloudinary.com')
    ? url.replace('/upload/', '/upload/fl_attachment/')
    : url;
  a.href     = dlUrl;
  a.download = filename;
  a.target   = '_blank';
  a.rel      = 'noopener';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Clique na imagem abre lightbox ───────────────────────
currentImg.addEventListener('click', () => {
  if (state.images.length === 0) return;
  state.lightboxIndex  = state.currentIndex;
  state.lightboxOrigin = 'viewer';
  openLightbox(state.currentIndex);
});

function showNewBadge() {
  newBadge.classList.remove('hidden');
  setTimeout(() => newBadge.classList.add('hidden'), 3500);
}

// ─── GALERIA ───────────────────────────────────────────────────────────────────

async function renderGallery() {
  galleryLoading.classList.remove('hidden');
  galleryGrid.classList.add('hidden');
  galleryEmpty.classList.add('hidden');

  // Recarrega imagens se necessário
  if (state.images.length === 0) await loadImages();

  galleryLoading.classList.add('hidden');

  if (state.images.length === 0) {
    galleryEmpty.classList.remove('hidden');
    galleryCount.textContent = '0 fotos';
    return;
  }

  galleryCount.textContent = `${state.images.length} foto${state.images.length !== 1 ? 's' : ''}`;
  galleryGrid.innerHTML = '';

  state.images.forEach((img, idx) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.title = 'Toque para expandir';

    const numBadge = document.createElement('span');
    numBadge.className = 'gallery-item-num';
    numBadge.textContent = idx + 1;

    const image = document.createElement('img');
    image.className = 'loading';
    image.alt = `Foto ${idx + 1}`;

    // Carrega lazy com Intersection Observer para performance
    const observer = new IntersectionObserver((entries, obs) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          image.src = img.url;
          image.onload  = () => image.classList.remove('loading');
          image.onerror = () => image.classList.remove('loading');
          obs.unobserve(entry.target);
        }
      });
    }, { rootMargin: '100px' });

    observer.observe(item);

    // Clique abre lightbox
    item.addEventListener('click', () => {
      state.lightboxOrigin = 'gallery';
      openLightbox(idx);
    });

    item.appendChild(image);
    item.appendChild(numBadge);
    galleryGrid.appendChild(item);
  });

  galleryGrid.classList.remove('hidden');
}

galleryRefreshBtn.addEventListener('click', async () => {
  galleryRefreshBtn.style.transform = 'rotate(360deg)';
  galleryRefreshBtn.style.transition = 'transform 0.5s';
  setTimeout(() => { galleryRefreshBtn.style.transform = ''; galleryRefreshBtn.style.transition = ''; }, 500);
  state.images = []; // força recarregar do servidor
  await renderGallery();
});

// ─── LIGHTBOX ──────────────────────────────────────────────────────────────────

function openLightbox(idx) {
  state.lightboxIndex = idx;
  lightbox.classList.remove('hidden');
  document.body.style.overflow = 'hidden'; // trava scroll do fundo
  loadLightboxImage(idx);
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  document.body.style.overflow = '';
  lightboxImg.src = '';
}

function loadLightboxImage(idx) {
  const img   = state.images[idx];
  const total = state.images.length;

  lightboxCounter.textContent = `${idx + 1} / ${total}`;
  lightboxPrev.disabled = idx >= total - 1;
  lightboxNext.disabled = idx <= 0;

  // Link de download no rodapé do lightbox
  const dlUrl = img.url.includes('cloudinary.com')
    ? img.url.replace('/upload/', '/upload/fl_attachment/')
    : img.url;
  lightboxDownload.href     = dlUrl;
  lightboxDownload.download = downloadFilename();

  // Mostra spinner enquanto carrega
  lightboxSpinner.classList.remove('hidden');
  lightboxImg.style.opacity = '0';

  const tempImg = new Image();
  tempImg.onload = () => {
    lightboxImg.src = tempImg.src;
    lightboxImg.style.opacity = '1';
    lightboxSpinner.classList.add('hidden');
  };
  tempImg.onerror = () => {
    lightboxSpinner.classList.add('hidden');
  };
  tempImg.src = img.url;
}

function lightboxGoTo(delta) {
  const newIdx = state.lightboxIndex - delta; // -delta pois índice 0 = mais recente
  if (newIdx < 0 || newIdx >= state.images.length) return;
  state.lightboxIndex = newIdx;
  loadLightboxImage(newIdx);
}

// Botões do lightbox
lightboxClose.addEventListener('click', closeLightbox);
lightboxPrev.addEventListener('click', () => lightboxGoTo(-1)); // vai para imagem mais antiga
lightboxNext.addEventListener('click', () => lightboxGoTo(1));  // vai para imagem mais recente

// Fechar ao clicar no fundo escuro
lightbox.addEventListener('click', e => {
  if (e.target === lightbox) closeLightbox();
});

// Navegação por teclado
document.addEventListener('keydown', e => {
  if (lightbox.classList.contains('hidden')) return;
  if (e.key === 'Escape')      closeLightbox();
  if (e.key === 'ArrowLeft')   lightboxGoTo(-1);
  if (e.key === 'ArrowRight')  lightboxGoTo(1);
});

// Swipe no celular (lightbox)
let touchStartX = 0;
lightbox.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
lightbox.addEventListener('touchend', e => {
  const diff = touchStartX - e.changedTouches[0].clientX;
  if (Math.abs(diff) > 50) lightboxGoTo(diff > 0 ? 1 : -1);
}, { passive: true });

// ─── POLLING ───────────────────────────────────────────────────────────────────

let pollingInterval = null;

function startPolling() {
  stopPolling();
  pollingInterval = setInterval(async () => {
    if (!state.token) return;
    try {
      const res  = await api('GET', '/api/images/latest');
      const data = await res.json();
      if (data.latest > state.latestTimestamp || data.count !== state.images.length) {
        state.latestTimestamp = data.latest;
        await loadImages(true);
      }
    } catch (_) {}
  }, 5000);
}

function stopPolling() {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

// ─── INICIALIZAR ───────────────────────────────────────────────────────────────
init();
