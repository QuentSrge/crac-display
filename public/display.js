/* ============================================================
   CRAC Display — vanilla JS, design fidèle au bundle Anthropic
   ============================================================ */

// ── State ─────────────────────────────────────────────────
let scores   = null;
let sponsors = [];
let config   = {};

let currentViewIdx = 0;
let progressStart  = 0;
let viewTimer      = null;
let tickTimer      = null;
let sponsorIdx     = 0;
let sponsorTimer   = null;

// ── Views (seulement Scores + Sponsors pour l'instant) ────
const VIEWS = [
  { id: 'scores',   label: 'Scores',      getDuration() { return config?.displayDurations?.scores   || 30_000; } },
  { id: 'sponsors', label: 'Partenaires', getDuration() { return config?.displayDurations?.sponsors || 15_000; } },
];

// ── DOM refs ──────────────────────────────────────────────
const headerEl   = document.getElementById('header');
const mainEl     = document.getElementById('main');
const footerEl   = document.getElementById('footer');
const progressEl = document.getElementById('progress-fill');

// ── Utils ─────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function statusLabel(m) {
  if (m.status === 'live')     return 'En cours';
  if (m.status === 'finished') return 'Terminé';
  if (m.status === 'upcoming') return 'À venir';
  return m.status || '';
}

function statusClass(m) {
  return m.status === 'live' ? 'live' : '';
}

// ── Clock ─────────────────────────────────────────────────
const DAYS   = ['Dimanche','Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi'];
const MONTHS = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

function tickClock() {
  const now  = new Date();
  const dateEl = headerEl.querySelector('.date');
  const timeEl = headerEl.querySelector('.time');
  if (dateEl) dateEl.textContent = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}`;
  if (timeEl) timeEl.textContent = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
}

// ── Render: Header ────────────────────────────────────────
function renderHeader() {
  const now   = new Date();
  const title = scores?.pool || config?.ffrPoolName || 'Championnat Régional';

  headerEl.innerHTML = `
    <div class="brand">
      <div class="brand-mark">
        <img src="crac-logo.svg" alt="CRAC" onerror="this.style.display='none'">
      </div>
      <div class="brand-name">
        <div class="name">CRAC</div>
        <div class="sub">Ancizes · Comps</div>
      </div>
    </div>
    <div class="header-center">
      <span class="dot"></span>
      <span class="pill">${esc(title)}</span>
    </div>
    <div class="header-right">
      <div class="date">${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}</div>
      <div class="time">${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}</div>
    </div>
  `;
}

// ── Render: Scoreboard ────────────────────────────────────
function renderScoreboard() {
  const el = document.getElementById('view-scores');

  if (!scores?.matches?.length) {
    el.innerHTML = `
      <div class="view-title">
        <h2><span class="accent-bar"></span>Résultats</h2>
        <div class="meta">En attente des données</div>
      </div>
      <div class="scoreboard">
        <div class="no-data">Données FFR en cours de chargement…</div>
      </div>`;
    return;
  }

  const featured = scores.matches.find(m => m.homeIsCrac || m.awayIsCrac);
  const others   = scores.matches.filter(m => !m.homeIsCrac && !m.awayIsCrac);

  // Density class based on number of non-featured rows
  const n = others.length;
  const density = n >= 7 ? 'tight' : n >= 5 ? 'compact' : '';

  const titleText = scores.round ? `${esc(scores.round)} · Résultats` : 'Résultats';
  const metaPool  = scores.pool        ? `${esc(scores.pool)}` : '';
  const metaComp  = scores.competition ? `<strong>${esc(scores.competition)}</strong>` : '';
  const meta      = [metaPool, metaComp].filter(Boolean).join(' · ');

  let html = `
    <div class="view-title">
      <h2><span class="accent-bar"></span>${titleText}</h2>
      <div class="meta">${meta}</div>
    </div>
    <div class="scoreboard ${density}">
  `;

  // Featured CRAC match
  if (featured) {
    const sH = featured.scoreHome;
    const sA = featured.scoreAway;
    const homeWin = sH != null && sA != null && sH > sA;
    const awayWin = sH != null && sA != null && sA > sH;
    const isScheduled = featured.status === 'upcoming' || (sH == null && sA == null);

    html += `
      <div class="match-featured">
        <div class="feature-tag">Match à l'affiche</div>
        <div class="team home">
          <div class="name ${featured.homeIsCrac ? 'is-crac' : ''}">${esc(featured.home)}</div>
          <div class="label">Domicile</div>
        </div>
        <div class="score-block">
          <div class="score ${homeWin ? 'win' : ''}">${sH ?? '—'}</div>
          <div class="sep"></div>
          <div class="score ${awayWin ? 'win' : ''}">${sA ?? '—'}</div>
          <div class="status ${statusClass(featured)}">${esc(statusLabel(featured))}</div>
        </div>
        <div class="team away">
          <div class="name ${featured.awayIsCrac ? 'is-crac' : ''}">${esc(featured.away)}</div>
          <div class="label">Extérieur</div>
        </div>
      </div>`;
  }

  // Regular rows
  for (const m of others) {
    const sH = m.scoreHome;
    const sA = m.scoreAway;
    const isScheduled = m.status === 'upcoming' || (sH == null && sA == null);

    html += `
      <div class="match-row ${isScheduled ? 'scheduled' : ''}">
        <div class="team home">
          <div class="name">${esc(m.home)}</div>
        </div>
        <div class="score-block">
          <div class="score">${sH ?? '—'}</div>
          <div class="sep"></div>
          <div class="score">${sA ?? '—'}</div>
          <div class="status ${statusClass(m)}">${esc(statusLabel(m))}</div>
        </div>
        <div class="team away">
          <div class="name">${esc(m.away)}</div>
        </div>
      </div>`;
  }

  // If no featured match, show all matches as regular rows
  if (!featured && others.length === 0) {
    html += `<div class="no-data">Aucun match programmé</div>`;
  }

  html += `</div>`;
  el.innerHTML = html;
}

// ── Render: Sponsors ──────────────────────────────────────
function renderSponsors() {
  const el = document.getElementById('view-sponsors');
  const sorted = [...sponsors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const titleHtml = `
    <div class="view-title">
      <h2><span class="accent-bar"></span>Nos partenaires</h2>
      <div class="meta">Ils nous <strong>soutiennent</strong></div>
    </div>`;

  if (!sorted.length) {
    el.innerHTML = titleHtml + `
      <div class="sponsors">
        <div class="sponsor-stage">
          <div class="sponsor-slide active">
            <div class="sponsor-featured">
              <div class="label">— PARTENAIRES OFFICIELS —</div>
              <div class="logo-frame">
                <div class="placeholder-logo">Vos logos ici<small>Ajoutez des sponsors via l'admin</small></div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    return;
  }

  const slidesHtml = sorted.map((s, i) => `
    <div class="sponsor-slide ${i === sponsorIdx ? 'active' : ''}" data-idx="${i}">
      <div class="sponsor-featured">
        <div class="label">— PARTENAIRE OFFICIEL —</div>
        <div class="logo-frame">
          ${s.url
            ? `<img src="${esc(s.url)}" alt="${esc(s.name)}">`
            : `<div class="placeholder-logo">${esc(s.name)}<small>Partenaire CRAC</small></div>`
          }
        </div>
        <div class="tagline">${esc(s.name)}</div>
      </div>
    </div>`).join('');

  const dotsHtml = sorted.map((_, i) =>
    `<div class="sd ${i === sponsorIdx ? 'active' : ''}"></div>`
  ).join('');

  el.innerHTML = titleHtml + `
    <div class="sponsors">
      <div class="sponsor-stage">${slidesHtml}</div>
      <div class="sponsor-dots">${dotsHtml}</div>
    </div>`;
}

function advanceSponsor() {
  const sorted = [...sponsors].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  if (!sorted.length) return;
  sponsorIdx = (sponsorIdx + 1) % sorted.length;

  // Update active classes without re-rendering
  document.querySelectorAll('#view-sponsors .sponsor-slide').forEach((el, i) => {
    el.classList.toggle('active', i === sponsorIdx);
  });
  document.querySelectorAll('#view-sponsors .sd').forEach((el, i) => {
    el.classList.toggle('active', i === sponsorIdx);
  });
}

// ── Render: Footer ────────────────────────────────────────
function renderFooter() {
  const nextView = VIEWS[(currentViewIdx + 1) % VIEWS.length];

  const dotsHtml = VIEWS.map((v, i) => `
    <div class="view-dot ${i === currentViewIdx ? 'active' : ''}">
      <span class="bullet"></span>
      <span>${esc(v.label)}</span>
    </div>`).join('');

  footerEl.innerHTML = `
    <div class="footer-left">
      <span style="color:var(--orange)">●</span>&nbsp; Mise à jour temps réel
    </div>
    <div class="view-dots">${dotsHtml}</div>
    <div class="footer-right">
      Suivant <span class="next">→ ${esc(nextView.label)}</span>
    </div>`;
}

// ── View switching ────────────────────────────────────────
function switchTo(idx) {
  const views = document.querySelectorAll('.view');
  views.forEach(v => v.classList.remove('active'));

  currentViewIdx = idx;
  const nextEl = document.getElementById(`view-${VIEWS[idx].id}`);
  if (nextEl) nextEl.classList.add('active');

  renderFooter();
  startProgress(VIEWS[idx].getDuration());

  // Sponsor cycling
  clearInterval(sponsorTimer);
  if (VIEWS[idx].id === 'sponsors') {
    sponsorIdx = 0;
    renderSponsors(); // re-render to reset to first slide
    sponsorTimer = setInterval(advanceSponsor, 4500);
  }
}

function nextView() {
  switchTo((currentViewIdx + 1) % VIEWS.length);
}

// ── Progress bar ──────────────────────────────────────────
function startProgress(duration) {
  clearTimeout(viewTimer);
  progressStart = Date.now();

  if (progressEl) {
    progressEl.style.transition = 'none';
    progressEl.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      progressEl.style.transition = `width ${duration}ms linear`;
      progressEl.style.width = '100%';
    }));
  }

  viewTimer = setTimeout(nextView, duration);
}

// ── API polling ───────────────────────────────────────────
async function fetchScores() {
  try {
    const res = await fetch('/api/scores', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    scores = await res.json();
    if (currentViewIdx === 0) renderScoreboard();
    // Update competition pill in header
    const pill = headerEl.querySelector('.pill');
    if (pill) pill.textContent = scores?.pool || config?.ffrPoolName || 'Championnat Régional';
  } catch { /* silencieux */ }
}

async function fetchSponsors() {
  try {
    const res = await fetch('/api/sponsors', { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    sponsors = await res.json();
  } catch { /* silencieux */ }
}

async function fetchConfig() {
  try {
    const res = await fetch('/api/config', { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    config = await res.json();
  } catch { /* silencieux */ }
}

// ── Stage scaler (1920×1080 → viewport) ──────────────────
function applyScale() {
  const stage = document.getElementById('stage');
  if (!stage) return;
  const s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  stage.style.transform = `translate(-50%, -50%) scale(${s})`;
}
window.addEventListener('resize', applyScale);

// ── Bootstrap ─────────────────────────────────────────────
async function init() {
  applyScale();

  await Promise.allSettled([fetchConfig(), fetchScores(), fetchSponsors()]);

  renderHeader();
  renderScoreboard();
  renderSponsors();
  renderFooter();

  // Start on scores view
  switchTo(0);

  // Clock
  tickTimer = setInterval(tickClock, 1000);

  // Polling
  setInterval(fetchScores,   30_000);
  setInterval(fetchSponsors, 60_000);
}

document.addEventListener('DOMContentLoaded', init);
