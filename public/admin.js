/* ============================================================
   CRAC Digital Signage — Admin Logic
   ============================================================ */

// ── Auth helpers ──────────────────────────────────────────────

const TOKEN_KEY = 'crac_admin_token';

function getToken()      { return sessionStorage.getItem(TOKEN_KEY); }
function setToken(t)     { sessionStorage.setItem(TOKEN_KEY, t); }
function clearToken()    { sessionStorage.removeItem(TOKEN_KEY); }

async function apiFetch(path, opts = {}) {
  const token = getToken();
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (res.status === 401) { showLogin(); throw new Error('Non autorisé'); }
  return res;
}

// ── Toast ─────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Login / Logout ────────────────────────────────────────────

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('dashboard').classList.add('hidden');
}

function showDashboard() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('dashboard').classList.remove('hidden');
}

document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const password = document.getElementById('pwd-input').value;
  const btn      = document.getElementById('login-btn');
  const errEl    = document.getElementById('login-error');

  btn.disabled = true;
  document.getElementById('login-btn-text').textContent = 'Connexion…';
  errEl.textContent = '';

  try {
    const res = await fetch('/api/admin/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ password }),
    });

    if (res.ok) {
      setToken(password);
      showDashboard();
      loadDashboard();
    } else {
      errEl.textContent = 'Mot de passe incorrect';
      document.getElementById('pwd-input').value = '';
      document.getElementById('pwd-input').focus();
    }
  } catch {
    errEl.textContent = 'Erreur de connexion au serveur';
  } finally {
    btn.disabled = false;
    document.getElementById('login-btn-text').textContent = 'Se connecter';
  }
});

document.getElementById('btn-logout').addEventListener('click', () => {
  clearToken();
  showLogin();
  document.getElementById('pwd-input').value = '';
});

// ── Dashboard loading ─────────────────────────────────────────

async function loadDashboard() {
  await Promise.allSettled([loadStatus(), loadSponsors()]);
}

// ── Configuration FFR ─────────────────────────────────────────

async function loadStatus() {
  try {
    const res  = await apiFetch('/api/admin/status');
    const data = await res.json();

    // Pré-remplir les champs config
    if (data.config) {
      document.getElementById('ffr-url').value       = data.config.ffrPoolUrl    || '';
      document.getElementById('ffr-name').value      = data.config.ffrPoolName   || '';
      document.getElementById('crac-team-name').value = data.config.cracTeamName || '';

      const d = data.config.displayDurations || {};
      document.getElementById('dur-scores').value   = (d.scores   || 30000) / 1000;
      document.getElementById('dur-sponsors').value = (d.sponsors || 15000) / 1000;
    }

    renderScrapeStatus(data.scrapeStatus);
  } catch { /* silencieux */ }
}

function renderScrapeStatus(s) {
  if (!s) return;
  const badge  = document.getElementById('status-badge');
  const detail = document.getElementById('status-detail');
  const text   = document.getElementById('badge-text');

  badge.className = 'status-badge';

  const labels = {
    success: { cls: 'success', label: 'Dernière actualisation réussie' },
    error:   { cls: 'error',   label: 'Erreur lors du dernier scraping' },
    empty:   { cls: 'empty',   label: 'Aucun match extrait' },
    'no-url':{ cls: 'error',   label: 'URL non configurée' },
    running: { cls: 'running', label: 'Actualisation en cours…' },
    idle:    { cls: '',        label: 'En attente' },
  };

  const info = labels[s.status] || labels.idle;
  badge.classList.add(info.cls);
  text.textContent = info.label;

  if (s.lastAttempt) {
    const d = new Date(s.lastAttempt);
    const fmt = d.toLocaleString('fr-FR', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    detail.textContent = `Dernière tentative : ${fmt}`;
  } else {
    detail.textContent = 'Jamais lancé';
  }

  if (s.error && s.status === 'error') {
    detail.textContent += ` — ${s.error}`;
  }
}

document.getElementById('btn-save-config').addEventListener('click', async () => {
  const btn = document.getElementById('btn-save-config');
  btn.disabled = true;
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PUT',
      body:   JSON.stringify({
        ffrPoolUrl:   document.getElementById('ffr-url').value.trim(),
        ffrPoolName:  document.getElementById('ffr-name').value.trim(),
        cracTeamName: document.getElementById('crac-team-name').value.trim(),
      }),
    });
    res.ok ? toast('Configuration enregistrée', 'success') : toast('Erreur lors de la sauvegarde', 'error');
  } catch { toast('Erreur réseau', 'error'); }
  finally { btn.disabled = false; }
});

document.getElementById('btn-save-durations').addEventListener('click', async () => {
  const scores   = parseInt(document.getElementById('dur-scores').value,   10) * 1000;
  const sponsors = parseInt(document.getElementById('dur-sponsors').value, 10) * 1000;

  if (scores < 5000 || sponsors < 5000) {
    toast('Durée minimum : 5 secondes', 'error');
    return;
  }
  try {
    const res = await apiFetch('/api/admin/config', {
      method: 'PUT',
      body:   JSON.stringify({ displayDurations: { scores, sponsors } }),
    });
    res.ok ? toast('Durées enregistrées', 'success') : toast('Erreur', 'error');
  } catch { toast('Erreur réseau', 'error'); }
});

// ── Scraping manuel ───────────────────────────────────────────

let pollInterval = null;

async function triggerScrape() {
  const btn     = document.getElementById('btn-scrape');
  const icon    = document.getElementById('scrape-btn-icon');
  const label   = document.getElementById('scrape-btn-text');

  btn.disabled = true;
  icon.className = 'spin';
  label.textContent = 'Actualisation…';

  // Fausse mise à jour du badge immédiate
  renderScrapeStatus({ status: 'running' });

  try {
    await apiFetch('/api/admin/scrape', { method: 'POST' });
  } catch {
    toast('Erreur lors du lancement', 'error');
    resetScrapeBtn();
    return;
  }

  // Polling du statut jusqu'à résolution (max 60s)
  let attempts = 0;
  clearInterval(pollInterval);
  pollInterval = setInterval(async () => {
    attempts++;
    try {
      const res  = await apiFetch('/api/admin/status');
      const data = await res.json();
      const s    = data.scrapeStatus || {};

      if (s.status !== 'running' && s.lastAttempt) {
        clearInterval(pollInterval);
        renderScrapeStatus(s);
        resetScrapeBtn();

        if (s.status === 'success') toast(`${data.scrapeStatus ? '' : ''}Scores mis à jour`, 'success');
        else if (s.status === 'error') toast('Scraping échoué — scores inchangés', 'error');
        else if (s.status === 'empty') toast('Aucun match trouvé sur la page FFR', 'info');
        else if (s.status === 'no-url') toast("Configurez d'abord l'URL de la poule", 'error');
      }
    } catch { /* silencieux */ }

    if (attempts >= 30) { // timeout 60s
      clearInterval(pollInterval);
      resetScrapeBtn();
      loadStatus();
    }
  }, 2000);
}

function resetScrapeBtn() {
  const btn   = document.getElementById('btn-scrape');
  const icon  = document.getElementById('scrape-btn-icon');
  const label = document.getElementById('scrape-btn-text');
  btn.disabled   = false;
  icon.className = '';
  icon.textContent = '⟳';
  label.textContent = 'Actualiser maintenant';
}

document.getElementById('btn-scrape').addEventListener('click', triggerScrape);

// ── Sponsors ──────────────────────────────────────────────────

let sponsorsList = [];

async function loadSponsors() {
  try {
    const res = await apiFetch('/api/sponsors');
    sponsorsList = await res.json();
    renderSponsors();
  } catch { /* silencieux */ }
}

function renderSponsors() {
  const list    = document.getElementById('sponsors-list');
  const empty   = document.getElementById('sponsors-empty');
  const counter = document.getElementById('sponsor-count');

  counter.textContent = sponsorsList.length;

  if (sponsorsList.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';
  list.innerHTML = sponsorsList
    .sort((a, b) => a.order - b.order)
    .map((s, idx) => `
      <div class="sponsor-item" data-id="${esc(s.id)}">
        ${s.url
          ? `<img class="sponsor-thumb" src="${esc(s.url)}" alt="${esc(s.name)}">`
          : `<div class="sponsor-thumb-placeholder">${esc(s.name.slice(0, 3))}</div>`
        }
        <span class="sponsor-name" title="${esc(s.name)}">${esc(s.name)}</span>
        <div class="sponsor-controls">
          <button class="btn btn-icon" onclick="moveSponsor('${esc(s.id)}', -1)"
                  ${idx === 0 ? 'disabled' : ''} title="Monter">↑</button>
          <button class="btn btn-icon" onclick="moveSponsor('${esc(s.id)}', 1)"
                  ${idx === sponsorsList.length - 1 ? 'disabled' : ''} title="Descendre">↓</button>
          <button class="btn btn-icon btn-danger" onclick="deleteSponsor('${esc(s.id)}')"
                  title="Supprimer">✕</button>
        </div>
      </div>`)
    .join('');
}

async function moveSponsor(id, dir) {
  const idx  = sponsorsList.findIndex(s => s.id === id);
  if (idx === -1) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= sponsorsList.length) return;

  [sponsorsList[idx], sponsorsList[newIdx]] = [sponsorsList[newIdx], sponsorsList[idx]];
  const ids = sponsorsList.map(s => s.id);

  try {
    await apiFetch('/api/admin/sponsors/reorder', {
      method: 'PUT',
      body:   JSON.stringify({ ids }),
    });
    sponsorsList = sponsorsList.map((s, i) => ({ ...s, order: i }));
    renderSponsors();
  } catch { toast('Erreur lors du réordonnancement', 'error'); }
}

async function deleteSponsor(id) {
  if (!confirm('Supprimer ce sponsor ?')) return;
  try {
    const res = await apiFetch(`/api/admin/sponsors/${id}`, { method: 'DELETE' });
    if (res.ok) {
      sponsorsList = sponsorsList.filter(s => s.id !== id);
      renderSponsors();
      toast('Sponsor supprimé', 'success');
    }
  } catch { toast('Erreur lors de la suppression', 'error'); }
}

// ── Upload ────────────────────────────────────────────────────

const uploadZone  = document.getElementById('upload-zone');
const fileInput   = document.getElementById('file-input');
const uploadProg  = document.getElementById('upload-progress');

uploadZone.addEventListener('click', () => fileInput.click());

uploadZone.addEventListener('dragover', e => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});

uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));

uploadZone.addEventListener('drop', e => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) uploadFiles(fileInput.files);
  fileInput.value = '';
});

async function uploadFiles(files) {
  const formData = new FormData();
  Array.from(files).forEach(f => formData.append('logos', f));

  uploadProg.textContent = `Envoi de ${files.length} fichier(s)…`;

  try {
    const res = await fetch('/api/admin/sponsors/upload', {
      method:  'POST',
      headers: { Authorization: `Bearer ${getToken()}` },
      body:    formData,
    });

    if (!res.ok) throw new Error(await res.text());

    const added = await res.json();
    sponsorsList = [...sponsorsList, ...added];
    renderSponsors();
    toast(`${added.length} sponsor(s) ajouté(s)`, 'success');
    uploadProg.textContent = '';
  } catch (err) {
    uploadProg.textContent = '';
    toast('Erreur upload : ' + err.message, 'error');
  }
}

// ── Utils ─────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Init ──────────────────────────────────────────────────────

async function init() {
  // Vérifie si déjà connecté (token en session)
  const token = getToken();
  if (token) {
    try {
      const res = await fetch('/api/admin/status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        showDashboard();
        loadDashboard();
        return;
      }
    } catch { /* silencieux */ }
    clearToken();
  }
  showLogin();
}

document.addEventListener('DOMContentLoaded', init);
