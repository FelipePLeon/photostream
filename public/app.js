/**
 * PhotoStream — Frontend App
 * Gerencia login, upload e visualização de imagens.
 */

// ─── ESTADO GLOBAL ─────────────────────────────────────────────────────────────
const state = {
  token: localStorage.getItem('ps_token') || null,
  images: [],        // lista de nomes de arquivo (mais recente primeiro)
  currentIndex: 0,   // índice da imagem sendo visualizada
  latestTimestamp: 0 // timestamp para detectar novas imagens via polling
};

// ─── ELEMENTOS DO DOM ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const loginScreen  = $('loginScreen');
const appScreen    = $('appScreen');
const loginError   = $('loginError');
const usernameEl   = $('username');
const passwordEl   = $('password');
const togglePw     = $('togglePw');
const loginBtn     = $('loginBtn');
const logoutBtn    = $('logoutBtn');

const tabUpload    = $('tabUpload');
const tabView      = $('tabView');
const panelUpload  = $('panelUpload');
const panelView    = $('panelView');

const uploadZone   = $('uploadZone');
const uploadInner  = $('uploadInner');
const previewWrap  = $('previewWrap');
const previewImg   = $('previewImg');
const previewName  = $('previewName');
const previewSize  = $('previewSize');
const fileInput    = $('fileInput');
const selectFileBtn= $('selectFileBtn');
const cancelBtn    = $('cancelBtn');
const sendBtn      = $('sendBtn');
const uploadStatus = $('uploadStatus');

const viewerArea   = $('viewerArea');
const noImages     = $('noImages');
const imgStage     = $('imgStage');
const currentImg   = $('currentImg');
const imgLoading   = $('imgLoading');
const imgCounter   = $('imgCounter');
const newBadge     = $('newBadge');
const refreshBtn   = $('refreshBtn');
const prevBtn      = $('prevBtn');
const nextBtn      = $('nextBtn');

// ─── UTILITÁRIOS ───────────────────────────────────────────────────────────────

/** Formata bytes em string legível */
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Faz requisição autenticada */
async function api(method, endpoint, body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-auth-token': state.token }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(endpoint, opts);
  if (res.status === 401) {
    handleLogout(false);
    throw new Error('Sessão expirada.');
  }
  return res;
}

/** Mostra mensagem de status do upload */
function showStatus(msg, type) {
  uploadStatus.textContent = msg;
  uploadStatus.className = `upload-status ${type}`;
  uploadStatus.classList.remove('hidden');
  if (type === 'success') {
    setTimeout(() => uploadStatus.classList.add('hidden'), 4000);
  }
}

// ─── AUTENTICAÇÃO ──────────────────────────────────────────────────────────────

/** Inicializa: verifica se já há sessão válida */
async function init() {
  if (state.token) {
    try {
      const res = await fetch('/api/check', { headers: { 'x-auth-token': state.token } });
      if (res.ok) {
        showApp();
        return;
      }
    } catch (_) {}
    state.token = null;
    localStorage.removeItem('ps_token');
  }
  showLogin();
}

function showLogin() {
  loginScreen.classList.add('active');
  appScreen.classList.remove('active');
  loginScreen.style.display = '';
  appScreen.style.display = 'none';
  stopPolling();
}

function showApp() {
  loginScreen.classList.remove('active');
  appScreen.classList.add('active');
  loginScreen.style.display = 'none';
  appScreen.style.display = 'flex';
  loadImages();
  startPolling();
}

loginBtn.addEventListener('click', async () => {
  const username = usernameEl.value.trim();
  const password = passwordEl.value;
  if (!username || !password) {
    showLoginError('Preencha usuário e senha.');
    return;
  }
  loginBtn.disabled = true;
  loginBtn.textContent = 'Entrando...';
  try {
    const res = await fetch('/api/login', {
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

// Login ao pressionar Enter
[usernameEl, passwordEl].forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') loginBtn.click(); });
});

// Mostrar/ocultar senha
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
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'x-auth-token': state.token } });
    } catch (_) {}
  }
  state.token = null;
  localStorage.removeItem('ps_token');
  showLogin();
}

// ─── TABS ──────────────────────────────────────────────────────────────────────

function switchTab(tab) {
  if (tab === 'upload') {
    tabUpload.classList.add('active');
    tabView.classList.remove('active');
    panelUpload.classList.add('active');
    panelView.classList.remove('active');
  } else {
    tabView.classList.add('active');
    tabUpload.classList.remove('active');
    panelView.classList.add('active');
    panelUpload.classList.remove('active');
    loadImages(); // recarrega ao trocar para aba de visualização
  }
}

tabUpload.addEventListener('click', () => switchTab('upload'));
tabView.addEventListener('click', () => switchTab('view'));

// ─── UPLOAD ────────────────────────────────────────────────────────────────────

let selectedFile = null;

selectFileBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  if (file) handleFileSelected(file);
});

// Drag & Drop (também funciona no desktop)
uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('dragover');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) handleFileSelected(file);
});

function handleFileSelected(file) {
  // Validação no front
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (!allowed.includes(file.type)) {
    showStatus('Tipo não permitido. Use JPG, PNG, WEBP ou GIF.', 'error');
    return;
  }
  if (file.size > 10 * 1024 * 1024) {
    showStatus('Arquivo muito grande. Máximo: 10MB.', 'error');
    return;
  }
  selectedFile = file;

  // Mostrar preview
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
  selectedFile = null;
  fileInput.value = '';
  previewImg.src = '';
  previewWrap.classList.add('hidden');
  uploadInner.classList.remove('hidden');
}

sendBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  sendBtn.disabled = true;
  sendBtn.textContent = 'Enviando...';
  showStatus('Enviando imagem...', 'loading');

  const formData = new FormData();
  formData.append('image', selectedFile);

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-auth-token': state.token },
      body: formData
    });
    const data = await res.json();

    if (res.ok) {
      showStatus(`✓ ${data.message}`, 'success');
      resetUpload();
      // Atualiza a lista de imagens em segundo plano
      await loadImages();
    } else {
      showStatus(data.error || 'Erro no upload.', 'error');
    }
  } catch (_) {
    showStatus('Erro de conexão. Tente novamente.', 'error');
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = '↑ Enviar';
  }
});

// ─── VISUALIZAÇÃO ──────────────────────────────────────────────────────────────

async function loadImages(isPolling = false) {
  try {
    const res = await api('GET', '/api/images');
    const data = await res.json();
    const newImages = data.images || [];

    const hadImages = state.images.length > 0;
    const prevFirst = state.images[0];
    state.images = newImages;

    if (newImages.length === 0) {
      showNoImages();
      return;
    }

    // Se é polling e chegou imagem nova, vai para ela
    if (isPolling && hadImages && newImages[0] !== prevFirst) {
      state.currentIndex = 0;
      showNewBadge();
    }

    updateViewer();
  } catch (err) {
    console.error('Erro ao carregar imagens:', err);
  }
}

function showNoImages() {
  noImages.classList.remove('hidden');
  imgStage.classList.add('hidden');
  imgCounter.textContent = '— / —';
  prevBtn.disabled = true;
  nextBtn.disabled = true;
}

function updateViewer() {
  if (state.images.length === 0) { showNoImages(); return; }

  noImages.classList.add('hidden');
  imgStage.classList.remove('hidden');

  const total = state.images.length;
  const idx   = state.currentIndex;
  const filename = state.images[idx];

  imgCounter.textContent = `${idx + 1} / ${total}`;
  prevBtn.disabled = idx >= total - 1;
  nextBtn.disabled = idx <= 0;

  // Carrega imagem com feedback de loading
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
  tempImg.src = `/uploads/${filename}?token=${state.token}`;
}

prevBtn.addEventListener('click', () => {
  if (state.currentIndex < state.images.length - 1) {
    state.currentIndex++;
    updateViewer();
  }
});

nextBtn.addEventListener('click', () => {
  if (state.currentIndex > 0) {
    state.currentIndex--;
    updateViewer();
  }
});

refreshBtn.addEventListener('click', async () => {
  refreshBtn.style.transform = 'rotate(360deg)';
  refreshBtn.style.transition = 'transform 0.5s';
  setTimeout(() => { refreshBtn.style.transform = ''; refreshBtn.style.transition = ''; }, 500);
  await loadImages();
});

function showNewBadge() {
  newBadge.classList.remove('hidden');
  setTimeout(() => newBadge.classList.add('hidden'), 3500);
}

// ─── POLLING ───────────────────────────────────────────────────────────────────

let pollingInterval = null;

function startPolling() {
  stopPolling();
  pollingInterval = setInterval(async () => {
    if (!state.token) return;
    try {
      const res = await api('GET', '/api/images/latest');
      const data = await res.json();
      // Só recarrega lista se houve mudança
      if (data.latest > state.latestTimestamp || data.count !== state.images.length) {
        state.latestTimestamp = data.latest;
        await loadImages(true);
      }
    } catch (_) {}
  }, 3000); // a cada 3 segundos
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
}

// ─── INICIALIZAR APP ───────────────────────────────────────────────────────────
init();
