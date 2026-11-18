#!/usr/bin/env node
// Ouvre Milanote dans un navigateur à profil persistant (hors du dépôt), attend que la session soit valide,
// puis dépose le cookie `__Secure-milanote.session_token` dans %USERPROFILE%\.milanote-mcp\session.json
// (pas dans %LOCALAPPDATA%, redirigé pour les processus lancés par l'application Claude : voir src/session-file.ts).
// Le mot de passe n'est jamais lu ni stocké : c'est l'utilisateur qui se connecte dans la fenêtre.
//
// Usage : npm run session            → rafraîchit le fichier (ouvre la fenêtre seulement si la session est absente)
//         npm run session -- --check → affiche l'état du fichier sans rien ouvrir
//         npm run session -- --login → force l'ouverture de la fenêtre (changement de compte, session invalide)
//         npm run session -- --refresh → sans fenêtre uniquement (utilisé par le serveur) ; code 2 si le profil n'est plus connecté
// Variables : MILANOTE_HOME (dossier du profil et du fichier), MILANOTE_BROWSER (chrome | msedge, défaut chrome).
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { isExpired, legacySessionDir, readSessionFile, sessionDir, sessionFilePath } from '../dist/src/session-file.js';

const COOKIE = '__Secure-milanote.session_token';
const ORIGIN = 'https://app.milanote.com';
const args = new Set(process.argv.slice(2));
const dir = sessionDir();
const file = sessionFilePath();
const profile = path.join(dir, 'profile');

const describe = (s) =>
  !s ? 'aucune session enregistrée' : isExpired(s) ? `session expirée (${s.expires})` : `session valide jusqu'au ${s.expires ?? '(cookie de session)'}, enregistrée le ${s.savedAt}`;

if (args.has('--check')) {
  console.log(`${file} : ${describe(readSessionFile())}`);
  process.exit(0);
}

// Migration depuis l'ancien dossier (%LOCALAPPDATA%\milanote-mcp, redirigé par l'application Claude MSIX) :
// copie du profil connecté, l'ancien dossier n'est jamais modifié ni supprimé.
const legacyProfile = path.join(legacySessionDir(), 'profile');
if (!process.env.MILANOTE_HOME && !fs.existsSync(profile) && fs.existsSync(legacyProfile)) {
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(legacyProfile, profile, { recursive: true, errorOnExist: false, force: false });
  console.error(`Profil navigateur copié depuis ${legacyProfile} vers ${profile}.`);
}
fs.mkdirSync(profile, { recursive: true });
const channel = process.env.MILANOTE_BROWSER ?? 'chrome';

async function grab(context) {
  const c = (await context.cookies(ORIGIN)).find((x) => x.name === COOKIE);
  return c ? { token: c.value, expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null } : undefined;
}

function save(found) {
  const data = { token: found.token, expires: found.expires, savedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  console.log(`Session enregistrée dans ${file} (${found.expires ? `expire le ${found.expires}` : 'cookie de session'}).`);
}

// 1. Sans fenêtre : le profil a peut-être encore une session valide.
if (!args.has('--login')) {
  const ctx = await chromium.launchPersistentContext(profile, { channel, headless: true });
  try {
    const page = await ctx.newPage();
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
    const found = await grab(ctx);
    if (found && (!found.expires || Date.parse(found.expires) > Date.now())) {
      save(found);
      await ctx.close();
      process.exit(0);
    }
  } finally {
    await ctx.close().catch(() => {});
  }
}

// --refresh (lancé en arrière-plan par le serveur) : jamais de fenêtre ; l'utilisateur se reconnecte lui-même.
if (args.has('--refresh')) {
  console.error('Profil non connecté : lancer « npm run session » pour se reconnecter.');
  process.exit(2);
}

// 2. Avec fenêtre : l'utilisateur se connecte lui-même.
console.log('Connecte-toi à Milanote dans la fenêtre qui s’ouvre ; elle se fermera toute seule une fois la session détectée.');
const ctx = await chromium.launchPersistentContext(profile, { channel, headless: false, viewport: null });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(`${ORIGIN}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
const deadline = Date.now() + 10 * 60_000;
let found;
while (Date.now() < deadline) {
  await page.waitForTimeout(1_500);
  if (page.isClosed()) break;
  const c = await grab(ctx);
  if (c && !page.url().includes('/login')) {
    found = c;
    break;
  }
}
if (!found) {
  console.error('Session non détectée (fenêtre fermée ou délai de 10 min dépassé). Relancer : npm run session -- --login');
  await ctx.close().catch(() => {});
  process.exit(1);
}
save(found);
await ctx.close();
