#!/usr/bin/env node
// Contrôle avant publication : aucun secret ni donnée personnelle dans les fichiers suivis par git.
//
// 1. Motifs génériques (toujours vérifiés) : adresses e-mail réelles, clés AWS, URL S3 signées, jetons JWT,
//    cookies de session, identifiants d'éléments Milanote réels (hors identifiants de test `1Xe000TEST…`).
// 2. Termes privés (noms, entreprise, projets…) : liste lue HORS du dépôt, une entrée par ligne, dans
//    `~/.milanote-mcp/private-terms.txt` (ou le fichier désigné par MILANOTE_PRIVATE_TERMS).
//    Une ligne `=MOT` est cherchée en mot entier et sensible à la casse ; sinon, recherche insensible à la casse.
//    Lignes vides et lignes commençant par `#` ignorées.
//
// Usage : node tools/check-privacy.mjs   (code 1 si quelque chose est trouvé ; utilisé par le hook pre-push)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const termsFile = process.env.MILANOTE_PRIVATE_TERMS ?? path.join(process.env.USERPROFILE ?? os.homedir(), '.milanote-mcp', 'private-terms.txt');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const rules = [
  { name: 'adresse e-mail', re: /[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com)(?!example\.(?:com|org))[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { name: 'clé AWS', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'URL S3 signée', re: /X-Amz-(?:Signature|Credential)=/g },
  { name: 'jeton JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  { name: 'cookie de session', re: /session_token=[A-Za-z0-9._-]{20,}/g },
  { name: 'id Milanote réel', re: /\b1X[0-9A-Za-z]{12}\b/g, allow: (m) => m.startsWith('1Xe000TEST') || ['1XeP40TeStCld8', '1XeP7jTeStC20b'].includes(m) },
];

let termsCount = 0;
if (fs.existsSync(termsFile)) {
  for (const raw of fs.readFileSync(termsFile, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    termsCount += 1;
    rules.push(
      t.startsWith('=')
        ? { name: 'terme privé', re: new RegExp(`(?<![A-Za-z0-9])${escape(t.slice(1))}(?![A-Za-z0-9])`, 'g') }
        : { name: 'terme privé', re: new RegExp(escape(t), 'gi') },
    );
  }
} else {
  console.error(`Avertissement : liste de termes privés absente (${termsFile}) ; seuls les motifs génériques sont vérifiés.`);
}

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const hits = [];
for (const file of files) {
  if (file === 'package-lock.json' || file === 'LICENSE') continue;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const rule of rules) {
    for (const m of text.matchAll(rule.re)) {
      if (rule.allow?.(m[0])) continue;
      const line = text.slice(0, m.index).split('\n').length;
      // Le terme lui-même n'est pas réaffiché (il est privé) : seulement le fichier, la ligne et la règle.
      hits.push(`${file}:${line} — ${rule.name}${rule.name === 'terme privé' ? '' : ` (${m[0].slice(0, 12)}…)`}`);
    }
  }
}

console.error(`check-privacy : ${files.length} fichier(s) suivis, ${termsCount} terme(s) privé(s), ${hits.length} alerte(s).`);
if (hits.length) {
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
