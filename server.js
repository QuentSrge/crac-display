/* ============================================================
   CRAC Display – Serveur Express
   ============================================================ */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');
const cron    = require('node-cron');

const { runScrape } = require('./scraper');

// ── Constantes ────────────────────────────────────────────────
const app      = express();
const PORT     = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPL_DIR  = path.join(__dirname, 'uploads', 'sponsors');

// Garantit que le dossier uploads existe
fs.mkdirSync(UPL_DIR, { recursive: true });

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Multer ────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPL_DIR),
  filename:    (req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `sponsor-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.svg', '.webp', '.gif'];
    return allowed.includes(path.extname(file.originalname).toLowerCase());
  },
});

// ── JSON helpers ──────────────────────────────────────────────
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2), 'utf8');
}

// ── Routes publiques ──────────────────────────────────────────
app.get('/api/scores', (req, res) => {
  const data = readJson('scores.json');
  data ? res.json(data) : res.status(503).json({ error: 'Données indisponibles' });
});

app.get('/api/classement', (req, res) => {
  const data = readJson('classement.json');
  data ? res.json(data) : res.status(503).json({ error: 'Données indisponibles' });
});

app.get('/api/sponsors', (req, res) => res.json(readJson('sponsors.json', [])));

app.get('/api/config', (req, res) => {
  const { adminPassword, ...safe } = readJson('config.json', {});
  res.json(safe);
});

// ── Middleware auth admin ──────────────────────────────────────
function adminAuth(req, res, next) {
  const config = readJson('config.json', {});
  const token  = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token || token !== config.adminPassword) {
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// ── Routes admin ──────────────────────────────────────────────

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  const { adminPassword } = readJson('config.json', {});
  password === adminPassword
    ? res.json({ ok: true })
    : res.status(401).json({ error: 'Mot de passe incorrect' });
});

app.get('/api/admin/status', adminAuth, (req, res) => {
  const { adminPassword, ...safeConfig } = readJson('config.json', {});
  res.json({
    scrapeStatus: readJson('scrape-status.json', {}),
    config:       safeConfig,
  });
});

app.put('/api/admin/config', adminAuth, (req, res) => {
  const current = readJson('config.json', {});
  const { adminPassword, ...updates } = req.body; // Le mot de passe n'est jamais modifié ici
  writeJson('config.json', { ...current, ...updates });
  res.json({ ok: true });
});

// Changement de mot de passe (route dédiée)
app.put('/api/admin/password', adminAuth, (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Mot de passe trop court (min 4 caractères)' });
  }
  const current = readJson('config.json', {});
  writeJson('config.json', { ...current, adminPassword: newPassword });
  res.json({ ok: true });
});

// Déclenchement manuel du scraping
let scrapeInProgress = false;

app.post('/api/admin/scrape', adminAuth, async (req, res) => {
  if (scrapeInProgress) {
    return res.json({ ok: false, message: 'Actualisation déjà en cours' });
  }
  res.json({ ok: true, message: 'Actualisation lancée' });
  scrapeInProgress = true;
  try { await runScrape(); }
  finally { scrapeInProgress = false; }
});

// Upload sponsors (multi-fichiers)
app.post('/api/admin/sponsors/upload', adminAuth, upload.array('logos', 10), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'Aucun fichier image valide' });
  }
  const sponsors    = readJson('sponsors.json', []);
  const newSponsors = req.files.map((file, i) => ({
    id:       crypto.randomBytes(8).toString('hex'),
    name:     path.parse(file.originalname).name,
    filename: file.filename,
    url:      `/uploads/sponsors/${file.filename}`,
    order:    sponsors.length + i,
  }));
  writeJson('sponsors.json', [...sponsors, ...newSponsors]);
  res.json(newSponsors);
});

// Suppression d'un sponsor
app.delete('/api/admin/sponsors/:id', adminAuth, (req, res) => {
  let sponsors = readJson('sponsors.json', []);
  const target = sponsors.find(s => s.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'Sponsor introuvable' });

  try {
    const fp = path.join(__dirname, 'uploads', 'sponsors', target.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch { /* ignore */ }

  sponsors = sponsors
    .filter(s => s.id !== req.params.id)
    .map((s, i) => ({ ...s, order: i }));
  writeJson('sponsors.json', sponsors);
  res.json({ ok: true });
});

// Réordonnancement des sponsors
app.put('/api/admin/sponsors/reorder', adminAuth, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'Format invalide' });
  const sponsors  = readJson('sponsors.json', []);
  const reordered = ids
    .map((id, i) => { const s = sponsors.find(sp => sp.id === id); return s ? { ...s, order: i } : null; })
    .filter(Boolean);
  writeJson('sponsors.json', reordered);
  res.json(reordered);
});

// Mise à jour du nom d'un sponsor
app.patch('/api/admin/sponsors/:id', adminAuth, (req, res) => {
  const { name } = req.body;
  const sponsors = readJson('sponsors.json', []);
  const idx      = sponsors.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Sponsor introuvable' });
  sponsors[idx].name = name || sponsors[idx].name;
  writeJson('sponsors.json', sponsors);
  res.json(sponsors[idx]);
});

// ── Cron : scraping toutes les 3 minutes ─────────────────────
cron.schedule('*/3 * * * *', async () => {
  if (scrapeInProgress) return;
  scrapeInProgress = true;
  try { await runScrape(); }
  finally { scrapeInProgress = false; }
});

// ── Démarrage ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  CRAC Display Server démarré`);
  console.log(`    Affichage : http://localhost:${PORT}/display.html`);
  console.log(`    Admin     : http://localhost:${PORT}/admin.html\n`);

  // Premier scraping 15s après le démarrage
  setTimeout(async () => {
    if (scrapeInProgress) return;
    scrapeInProgress = true;
    try { await runScrape(); }
    finally { scrapeInProgress = false; }
  }, 15000);
});
