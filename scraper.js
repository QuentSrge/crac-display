/* ============================================================
   CRAC – Scraper monclubhouse.ffr.fr
   Site : Next.js App Router + Directus API

   Stratégie 1 (rapide) : appel direct à l'API Directus
   Stratégie 2 (fallback) : Puppeteer avec les vrais sélecteurs CSS
   En cas d'échec : silencieux, scores.json inchangé.
   ============================================================ */

const path  = require('path');
const fs    = require('fs');
const https = require('https');

const DATA_DIR = path.join(__dirname, 'data');

// ── Helpers ───────────────────────────────────────────────────

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8');
}

function saveStatus(status, error = null) {
  const prev = readJson('scrape-status.json', {});
  writeJson('scrape-status.json', {
    lastAttempt: new Date().toISOString(),
    lastSuccess: status === 'success' ? new Date().toISOString() : (prev.lastSuccess || null),
    status,
    error: error ? String(error).slice(0, 400) : null,
  });
}

// Extrait l'ID numérique depuis l'URL de la poule (dernier segment)
function extractPoolId(url) {
  const m = url.match(/\/(\d+)\/?$/);
  return m ? m[1] : null;
}

// Requête HTTPS simple (sans puppeteer)
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124',
        'Accept': 'application/json, text/html, */*',
      },
      timeout: 12000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpsGet(res.headers.location));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Stratégie 1 : API Directus ───────────────────────────────
// monclubhouse.ffr.fr utilise Directus CMS en backend.
// L'API expose les rencontres par poule.

async function fetchViaApi(poolId) {
  // Plusieurs patterns Directus possibles — on essaie dans l'ordre
  const endpoints = [
    `https://api-web.monclubhouse.ffr.fr/items/rencontres?filter={"poule_id":{"_eq":${poolId}}}&fields=*&sort=date_rencontre`,
    `https://api-web.monclubhouse.ffr.fr/items/Rencontres?filter={"poule_id":{"_eq":${poolId}}}&fields=*&sort=date_rencontre`,
    `https://api-web.monclubhouse.ffr.fr/items/rencontres?filter={"poule":{"_eq":${poolId}}}&fields=*&sort=date_rencontre`,
    `https://api-web.monclubhouse.ffr.fr/items/Rencontres?filter={"poule":{"_eq":${poolId}}}&fields=*&sort=date_rencontre`,
  ];

  for (const url of endpoints) {
    try {
      const { status, body } = await httpsGet(encodeURI(url));
      if (status !== 200) continue;
      const json = JSON.parse(body);
      if (!json.data || json.data.length === 0) continue;

      console.log(`[scraper] API Directus OK : ${json.data.length} rencontres`);
      return normalizeDirectusMatches(json.data);
    } catch {
      // essaie le prochain endpoint
    }
  }
  return null; // API n'a pas fonctionné → passe au fallback
}

function normalizeDirectusMatches(items) {
  const matches = [];
  for (const item of items) {
    // Noms des champs Directus — peut varier selon la config du site
    const home  = item.equipe_domicile_nom || item.club_domicile || item.domicile || item.team_home || '';
    const away  = item.equipe_visiteur_nom || item.club_visiteur || item.visiteur || item.team_away || '';
    const sh    = item.score_domicile ?? item.score_home ?? item.pts_domicile ?? null;
    const sa    = item.score_visiteur ?? item.score_away ?? item.pts_visiteur ?? null;
    const status = item.statut || item.status || (sh !== null ? 'finished' : 'upcoming');

    if (!home || !away) continue;
    matches.push({ home, away, scoreHome: sh, scoreAway: sa, status });
  }
  return matches;
}

// ── Stratégie 2 : Puppeteer ───────────────────────────────────
// Sélecteurs identifiés par inspection du DOM réel du site.

async function fetchViaPuppeteer(pageUrl) {
  const puppeteer = require('puppeteer');

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36');

    await page.goto(pageUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    // Délai pour le rendu Next.js App Router
    await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));

    return await page.evaluate(() => {
      // ── Titre compétition ──────────────────────────────────
      let pageTitle = '';
      // Le site monclubhouse affiche le titre dans des h1/h2 ou des spans spécifiques
      const titleEl = document.querySelector('h1, h2, [class*="competition-name"], [class*="title-competition"]');
      if (titleEl) pageTitle = titleEl.innerText.trim();
      if (!pageTitle) pageTitle = document.title.split('|')[0].trim();

      // ── Journée la plus récente ────────────────────────────
      let round = '';
      const roundEl = document.querySelector('[class*="journee"], [class*="round-label"]');
      if (roundEl) round = roundEl.innerText.trim();

      // ── Matchs : sélecteur identifié par debug réel ────────
      // Le site génère des <a href="...match/{id}"> pour chaque rencontre
      const matchLinks = document.querySelectorAll('a[href*="/match/"]');
      const matches = [];

      for (const link of matchLinks) {
        // Noms d'équipes : classe .team__team-name (confirmée par debug)
        const teamEls = link.querySelectorAll('[class*="team__team-name"], [class*="team-name"]');

        // Scores : classes spécifiques confirmées par debug
        const scoreLoserEl  = link.querySelector('[class*="score--loser"]');
        const scoreWinnerEl = link.querySelector('[class*="score--winner"]');
        // Fallback : n'importe quel span dans le bloc score
        const scoreBlockEl  = link.querySelector('[class*="score-card__score"], [class*="score__score"]');

        // Statut : classe badge__text (confirmée par debug)
        const statusEl = link.querySelector('[class*="badge__text"], [class*="badge--"]');

        // Round dans ce link
        const roundInLink = link.querySelector('[class*="journee"], [class*="round"]');
        if (roundInLink && !round) round = roundInLink.innerText.trim();

        if (teamEls.length < 2) continue;

        const home = teamEls[0].innerText.trim();
        const away = teamEls[teamEls.length - 1].innerText.trim();
        if (!home || !away) continue;

        // Extraction des scores
        let scoreHome = null, scoreAway = null;
        if (scoreLoserEl && scoreWinnerEl) {
          // On détermine quel side est home/away selon la position dans le DOM
          const loserPos  = scoreLoserEl.getBoundingClientRect().left;
          const winnerPos = scoreWinnerEl.getBoundingClientRect().left;
          if (loserPos < winnerPos) {
            scoreHome = parseInt(scoreLoserEl.innerText.trim(), 10);
            scoreAway = parseInt(scoreWinnerEl.innerText.trim(), 10);
          } else {
            scoreHome = parseInt(scoreWinnerEl.innerText.trim(), 10);
            scoreAway = parseInt(scoreLoserEl.innerText.trim(), 10);
          }
        } else if (scoreBlockEl) {
          // Fallback : extrait les chiffres du bloc score
          const nums = (scoreBlockEl.innerText.match(/\d+/g) || []).map(Number);
          if (nums.length >= 2) { scoreHome = nums[0]; scoreAway = nums[1]; }
        } else {
          // Dernier fallback : cherche X-Y dans tout le texte du link
          const m = link.innerText.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})/);
          if (m) { scoreHome = parseInt(m[1], 10); scoreAway = parseInt(m[2], 10); }
        }

        // Statut
        const statusText = (statusEl ? statusEl.innerText : link.innerText).toLowerCase();
        const status = statusText.includes('en cours') || statusText.includes('live')
          ? 'live'
          : scoreHome !== null ? 'finished' : 'upcoming';

        matches.push({ home, away, scoreHome, scoreAway, status });
      }

      return { pageTitle, round, matches };
    });
  } finally {
    await browser.close();
  }
}

// ── Orchestration ─────────────────────────────────────────────

async function runScrape() {
  const config  = readJson('config.json', {});
  const pageUrl = config.ffrPoolUrl;

  if (!pageUrl) { saveStatus('no-url'); return; }

  try {
    const cracName = (config.cracTeamName || 'CRAC').toUpperCase();
    let rawMatches = null;
    let pageTitle  = config.ffrPoolName || '—';
    let round      = '';

    // Tentative 1 : API Directus (rapide, ~1s)
    const poolId = extractPoolId(pageUrl);
    if (poolId) {
      rawMatches = await fetchViaApi(poolId);
    }

    // Tentative 2 : Puppeteer (fallback, ~10s)
    if (!rawMatches || rawMatches.length === 0) {
      console.log('[scraper] API Directus indisponible → Puppeteer');
      const result = await fetchViaPuppeteer(pageUrl);
      rawMatches = result.matches;
      if (result.pageTitle) pageTitle = result.pageTitle;
      if (result.round)     round     = result.round;
    }

    if (!rawMatches || rawMatches.length === 0) {
      saveStatus('empty');
      console.log('[scraper] Aucun match extrait — scores.json inchangé');
      return;
    }

    const enriched = rawMatches.map((m, i) => ({
      id:         i + 1,
      home:       m.home,
      away:       m.away,
      scoreHome:  m.scoreHome,
      scoreAway:  m.scoreAway,
      status:     m.status,
      homeIsCrac: m.home.toUpperCase().includes(cracName),
      awayIsCrac: m.away.toUpperCase().includes(cracName),
    }));

    const current = readJson('scores.json', {});
    writeJson('scores.json', {
      competition: pageTitle || current.competition || '—',
      pool:        config.ffrPoolName || current.pool || '—',
      round:       round || current.round || '—',
      lastUpdate:  new Date().toISOString(),
      matches:     enriched,
    });

    saveStatus('success');
    console.log(`[scraper] ✅ ${enriched.length} matchs enregistrés`);

  } catch (err) {
    saveStatus('error', err.message || String(err));
    console.error('[scraper] Erreur silencieuse :', err.message);
  }
}

module.exports = { runScrape };
