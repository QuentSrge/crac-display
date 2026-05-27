/* ============================================================
   CRAC – Scraper monclubhouse.ffr.fr
   Site : Next.js App Router + Directus API

   Stratégie 1 (rapide) : appel direct à l'API Directus
   Stratégie 2 (fallback) : Puppeteer avec les vrais sélecteurs CSS
   En cas d'échec : silencieux, scores.json / classement.json inchangés.
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

// ── Stratégie 1 : API Directus — Rencontres ──────────────────
// monclubhouse.ffr.fr utilise Directus CMS en backend.

async function fetchViaApi(poolId) {
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
  return null;
}

function normalizeDirectusMatches(items) {
  const matches = [];
  for (const item of items) {
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

// ── Stratégie 1 : API Directus — Classement ──────────────────

async function fetchStandingsViaApi(poolId) {
  const endpoints = [
    `https://api-web.monclubhouse.ffr.fr/items/classements?filter={"poule_id":{"_eq":${poolId}}}&fields=*&sort=rang`,
    `https://api-web.monclubhouse.ffr.fr/items/Classements?filter={"poule_id":{"_eq":${poolId}}}&fields=*&sort=rang`,
    `https://api-web.monclubhouse.ffr.fr/items/classements?filter={"poule":{"_eq":${poolId}}}&fields=*&sort=rang`,
    `https://api-web.monclubhouse.ffr.fr/items/poule_equipes?filter={"poule_id":{"_eq":${poolId}}}&fields=*&sort=rang`,
    `https://api-web.monclubhouse.ffr.fr/items/poule_equipes?filter={"poule":{"_eq":${poolId}}}&fields=*&sort=rang`,
  ];

  for (const url of endpoints) {
    try {
      const { status, body } = await httpsGet(encodeURI(url));
      if (status !== 200) continue;
      const json = JSON.parse(body);
      if (!json.data || json.data.length === 0) continue;

      console.log(`[scraper] API Classement OK : ${json.data.length} équipes`);
      return normalizeDirectusStandings(json.data);
    } catch {
      // essaie le prochain endpoint
    }
  }
  return null;
}

function normalizeDirectusStandings(items) {
  return items.map(item => ({
    rank:          item.rang             ?? item.rank         ?? item.position      ?? null,
    team:          item.equipe_nom       || item.club_nom     || item.nom           || item.name || '',
    played:        item.matchs_joues     ?? item.joues        ?? item.played        ?? null,
    won:           item.victoires        ?? item.gagnes       ?? item.won           ?? null,
    drawn:         item.nuls             ?? item.drawn        ?? null,
    lost:          item.defaites         ?? item.perdus       ?? item.lost          ?? null,
    pointsFor:     item.points_marques   ?? item.pts_pour     ?? item.points_pour   ?? null,
    pointsAgainst: item.points_encaisses ?? item.pts_contre   ?? item.points_contre ?? null,
    bonusPoints:   item.points_bonus     ?? item.bonus        ?? null,
    totalPoints:   item.points           ?? item.total_points ?? item.pts_total     ?? null,
  })).filter(r => r.team);
}

// ── Stratégie 2 : Puppeteer ───────────────────────────────────
// Extrait rencontres ET classement en une seule session navigateur.

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
    await page.evaluate(() => new Promise(r => setTimeout(r, 2500)));

    // ── Extraction des scores ──────────────────────────────────
    const scoresResult = await page.evaluate(() => {
      let pageTitle = '';
      const titleEl = document.querySelector('h1, h2, [class*="competition-name"], [class*="title-competition"]');
      if (titleEl) pageTitle = titleEl.innerText.trim();
      if (!pageTitle) pageTitle = document.title.split('|')[0].trim();

      let round = '';
      const roundEl = document.querySelector('[class*="journee"], [class*="round-label"]');
      if (roundEl) round = roundEl.innerText.trim();

      const matchLinks = document.querySelectorAll('a[href*="/match/"]');
      const matches = [];

      for (const link of matchLinks) {
        const teamEls       = link.querySelectorAll('[class*="team__team-name"], [class*="team-name"]');
        const scoreLoserEl  = link.querySelector('[class*="score--loser"]');
        const scoreWinnerEl = link.querySelector('[class*="score--winner"]');
        const scoreBlockEl  = link.querySelector('[class*="score-card__score"], [class*="score__score"]');
        const statusEl      = link.querySelector('[class*="badge__text"], [class*="badge--"]');
        const roundInLink   = link.querySelector('[class*="journee"], [class*="round"]');

        if (roundInLink && !round) round = roundInLink.innerText.trim();
        if (teamEls.length < 2) continue;

        const home = teamEls[0].innerText.trim();
        const away = teamEls[teamEls.length - 1].innerText.trim();
        if (!home || !away) continue;

        let scoreHome = null, scoreAway = null;
        if (scoreLoserEl && scoreWinnerEl) {
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
          const nums = (scoreBlockEl.innerText.match(/\d+/g) || []).map(Number);
          if (nums.length >= 2) { scoreHome = nums[0]; scoreAway = nums[1]; }
        } else {
          const m = link.innerText.match(/(\d{1,3})\s*[-–]\s*(\d{1,3})/);
          if (m) { scoreHome = parseInt(m[1], 10); scoreAway = parseInt(m[2], 10); }
        }

        const statusText = (statusEl ? statusEl.innerText : link.innerText).toLowerCase();
        const status = statusText.includes('en cours') || statusText.includes('live')
          ? 'live'
          : scoreHome !== null ? 'finished' : 'upcoming';

        matches.push({ home, away, scoreHome, scoreAway, status });
      }

      return { pageTitle, round, matches };
    });

    // ── Navigation vers l'onglet Classement si présent ────────
    const clickedTab = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('a, button, [role="tab"], [class*="tab"]'));
      for (const el of candidates) {
        if (/classement|ranking|standing/i.test(el.innerText || el.textContent || '')) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (clickedTab) {
      await page.evaluate(() => new Promise(r => setTimeout(r, 1800)));
    }

    // ── Extraction du classement ──────────────────────────────
    const standings = await page.evaluate(() => {
      const results = [];

      // Sélecteurs courants pour un tableau de classement rugby
      const rowSelectors = [
        '[class*="classement"] tr, [class*="classement"] [class*="row"]',
        '[class*="ranking"] tr, [class*="ranking"] [class*="row"]',
        '[class*="standing"] tr, [class*="standing"] [class*="row"]',
        '[class*="pool-table"] tr',
        'tbody tr',
      ];

      let rows = null;
      for (const sel of rowSelectors) {
        try {
          const found = document.querySelectorAll(sel);
          if (found.length > 1) { rows = found; break; }
        } catch { /* sélecteur invalide */ }
      }

      if (!rows) return results;

      let autoRank = 1;
      for (const row of rows) {
        // Nom d'équipe
        const teamEl = row.querySelector(
          '[class*="team__team-name"], [class*="team-name"], [class*="club-name"], [class*="equipe"]'
        );
        const team = teamEl ? teamEl.innerText.trim() : null;
        if (!team || team.length < 2) continue;

        // Rang
        const rankEl = row.querySelector('[class*="rank"], [class*="rang"], [class*="position"], td:first-child');
        const rankRaw = rankEl ? parseInt(rankEl.innerText.trim(), 10) : NaN;
        const rank = isNaN(rankRaw) ? autoRank : rankRaw;

        // Stats numériques dans les cellules
        const cells = Array.from(row.querySelectorAll('td, [class*="cell"], [class*="stat"]'))
          .map(c => c.innerText.trim())
          .filter(t => /^\d+$/.test(t))
          .map(Number);

        results.push({
          rank,
          team,
          played:      cells[0] ?? null,
          won:         cells[1] ?? null,
          drawn:       cells[2] ?? null,
          lost:        cells[3] ?? null,
          totalPoints: cells[cells.length - 1] ?? null,
        });
        autoRank++;
      }

      return results;
    });

    return { ...scoresResult, standings };
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
    let rawMatches   = null;
    let rawStandings = null;
    let pageTitle    = config.ffrPoolName || '—';
    let round        = '';

    // Tentative 1 : API Directus (rapide, ~1s chacune)
    const poolId = extractPoolId(pageUrl);
    if (poolId) {
      [rawMatches, rawStandings] = await Promise.all([
        fetchViaApi(poolId),
        fetchStandingsViaApi(poolId),
      ]);
    }

    // Tentative 2 : Puppeteer si l'une ou l'autre API a échoué
    const needsPuppeteer = (!rawMatches || rawMatches.length === 0) ||
                           (!rawStandings || rawStandings.length === 0);

    if (needsPuppeteer) {
      console.log('[scraper] API incomplète → Puppeteer');
      const result = await fetchViaPuppeteer(pageUrl);

      if (!rawMatches || rawMatches.length === 0) {
        rawMatches = result.matches;
        if (result.pageTitle) pageTitle = result.pageTitle;
        if (result.round)     round     = result.round;
      }
      if (!rawStandings || rawStandings.length === 0) {
        rawStandings = result.standings || [];
      }
    }

    // ── Sauvegarde scores.json ─────────────────────────────────
    if (rawMatches && rawMatches.length > 0) {
      const enrichedMatches = rawMatches.map((m, i) => ({
        id:         i + 1,
        home:       m.home,
        away:       m.away,
        scoreHome:  m.scoreHome,
        scoreAway:  m.scoreAway,
        status:     m.status,
        homeIsCrac: m.home.toUpperCase().includes(cracName),
        awayIsCrac: m.away.toUpperCase().includes(cracName),
      }));

      const currentScores = readJson('scores.json', {});
      writeJson('scores.json', {
        competition: pageTitle || currentScores.competition || '—',
        pool:        config.ffrPoolName || currentScores.pool || '—',
        round:       round || currentScores.round || '—',
        lastUpdate:  new Date().toISOString(),
        matches:     enrichedMatches,
      });
      console.log(`[scraper] ✅ ${enrichedMatches.length} matchs enregistrés`);
    } else {
      saveStatus('empty');
      console.log('[scraper] Aucun match extrait — scores.json inchangé');
    }

    // ── Sauvegarde classement.json ─────────────────────────────
    if (rawStandings && rawStandings.length > 0) {
      const enrichedStandings = rawStandings.map(s => ({
        ...s,
        teamIsCrac: s.team.toUpperCase().includes(cracName),
      }));

      const currentClassement = readJson('classement.json', {});
      writeJson('classement.json', {
        competition: pageTitle || currentClassement.competition || '—',
        pool:        config.ffrPoolName || currentClassement.pool || '—',
        lastUpdate:  new Date().toISOString(),
        standings:   enrichedStandings,
      });
      console.log(`[scraper] ✅ ${enrichedStandings.length} équipes au classement`);
    } else {
      console.log('[scraper] Aucun classement extrait — classement.json inchangé');
    }

    if (rawMatches && rawMatches.length > 0) saveStatus('success');

  } catch (err) {
    saveStatus('error', err.message || String(err));
    console.error('[scraper] Erreur silencieuse :', err.message);
  }
}

module.exports = { runScrape };
