import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthProvider, authHeaders, cookieHeader, loadConfig, loadSettings } from '../src/config.js';
import { extractElementId } from '../src/client/ids.js';

test('MILANOTE_BASE_URL : seule une origine https de milanote.com est acceptée (le cookie part vers cette adresse)', () => {
  assert.equal(loadSettings({}).baseUrl, 'https://app.milanote.com');
  assert.equal(loadSettings({ MILANOTE_BASE_URL: 'https://app.milanote.com/' }).baseUrl, 'https://app.milanote.com');
  assert.throws(() => loadSettings({ MILANOTE_BASE_URL: 'https://evil.example' }), /refusée/);
  assert.throws(() => loadSettings({ MILANOTE_BASE_URL: 'http://app.milanote.com' }), /refusée/);
  assert.throws(() => loadSettings({ MILANOTE_BASE_URL: 'https://milanote.com.evil.example' }), /refusée/);
  assert.throws(() => loadSettings({ MILANOTE_TIMEOUT_MS: 'abc' }), /nombre/);
  assert.equal(loadSettings({ MILANOTE_AUTO_REFRESH: '0' }).autoRefresh, false);
});

test('session paresseuse : le serveur démarre sans session, puis la prend dès que le fichier apparaît', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milanote-mcp-test-'));
  const file = path.join(dir, 'session.json');
  try {
    const provider = new AuthProvider({ MILANOTE_SESSION_FILE: file });
    assert.throws(() => provider.current(), /npm run session/);
    fs.writeFileSync(file, JSON.stringify({ token: 'tok1', expires: '2999-01-01T00:00:00.000Z', savedAt: 'x' }));
    assert.equal(provider.current().auth.token, 'tok1');
    assert.equal(provider.current().source, 'file');
    // Nouveau `npm run session` : le fichier change, la session suit sans redémarrage.
    fs.writeFileSync(file, JSON.stringify({ token: 'tok2', expires: '2999-01-01T00:00:00.000Z', savedAt: 'y' }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    assert.equal(provider.current().auth.token, 'tok2');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractElementId : id brut ou URL Milanote, rien d’autre', () => {
  assert.equal(extractElementId('1Xe000TESTCL02'), '1Xe000TESTCL02');
  assert.equal(extractElementId(' https://app.milanote.com/1Xe000TESTCL02/mcp-test?p=x '), '1Xe000TESTCL02');
  assert.equal(extractElementId('https://example.com/1Xe000TESTCL02'), undefined);
  assert.equal(extractElementId('pas un id'), undefined);
});

const fakeJwt = (claims: object) =>
  ['eyJhbGciOiJIUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'signature'].join('.');

test('mode jwt : lit userId et rootBoardId dans le JWT ; écritures désactivées par défaut', () => {
  const c = loadConfig({ MILANOTE_TOKEN: fakeJwt({ _id: 'u1', rootBoardId: '1Xe000TESTCL01' }) });
  assert.equal(c.auth.kind, 'jwt');
  assert.equal(c.userId, 'u1');
  assert.equal(c.rootBoardId, '1Xe000TESTCL01');
  assert.equal(c.enableWrite, false);
  assert.equal(c.cacheTtlMs, 60_000);
  assert.match(authHeaders(c.auth).authorization ?? '', /^Bearer eyJ/);
  assert.match(cookieHeader(c.auth), /^mn-token=/);
});

test('mode session (Better Auth) : cookie seul, identité résolue plus tard', () => {
  const c = loadConfig({ MILANOTE_SESSION_TOKEN: 'abc.def', MILANOTE_TOKEN: fakeJwt({ _id: 'u1', rootBoardId: 'r' }) });
  assert.equal(c.auth.kind, 'session', 'la session prime sur le JWT');
  assert.equal(c.userId, undefined);
  assert.equal(cookieHeader(c.auth), '__Secure-milanote.session_token=abc.def');
  assert.deepEqual(Object.keys(authHeaders(c.auth)), ['cookie']);
  assert.throws(() => loadConfig({ MILANOTE_SESSION_TOKEN: 'a b' }), /invalide/);
});

test('MILANOTE_ENABLE_WRITE=1 active les écritures', () => {
  const c = loadConfig({ MILANOTE_TOKEN: fakeJwt({ _id: 'u1', rootBoardId: 'r' }), MILANOTE_ENABLE_WRITE: '1' });
  assert.equal(c.enableWrite, true);
});

test('erreurs explicites, sans écho du jeton', () => {
  assert.throws(() => loadConfig({ MILANOTE_SESSION_FILE: 'C:/inexistant/session.json' }), /npm run session/);
  assert.throws(() => loadConfig({ MILANOTE_TOKEN: 'pas-un-jwt' }), (e: Error) => !e.message.includes('pas-un-jwt'));
  assert.throws(() => loadConfig({ MILANOTE_TOKEN: fakeJwt({}) }), /claims/);
});

test('repli sur le fichier de session déposé par scripts/session.mjs', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milanote-mcp-test-'));
  const file = path.join(dir, 'session.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ token: 'tok', expires: '2999-01-01T00:00:00.000Z', savedAt: 'x' }));
    const c = loadConfig({ MILANOTE_SESSION_FILE: file });
    assert.equal(c.auth.kind, 'session');
    assert.equal(cookieHeader(c.auth), '__Secure-milanote.session_token=tok');
    fs.writeFileSync(file, JSON.stringify({ token: 'tok', expires: '2000-01-01T00:00:00.000Z', savedAt: 'x' }));
    assert.throws(() => loadConfig({ MILANOTE_SESSION_FILE: file }), /expirée/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
