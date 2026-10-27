import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const routePaths = ['/', '/login', '/pricing', '/privacy', '/gizlilik', '/kvkk', '/terms', '/cookies', '/support'];
const providers = [
  ['create-iyzico-checkout', 503, 'PAYMENT_PROVIDER_DISABLED'],
  ['iyzico-webhook', 503, 'PAYMENT_PROVIDER_DISABLED'],
  ['paytr-token', 503, 'PAYMENT_PROVIDER_DISABLED'],
  ['paytr-webhook', 503, 'PAYMENT_PROVIDER_DISABLED'],
  ['drive-sync', 410, 'DRIVE_SYNC_RETIRED'],
];

function isPublicKey(key) {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role === 'anon'; }
  catch { return false; }
}

// All remote text stays in memory: only fixed check names are printed by the CLI.
export async function runHttpChecks(config, { fetch = globalThis.fetch, sleep = delay } = {}) {
  const { baseUrl, supabaseUrl, publishableKey, expectedSha } = config;
  assert.match(baseUrl, /^https:\/\/[^/?#]+$/);
  assert.match(supabaseUrl, /^https:\/\/[a-z0-9-]+\.supabase\.co$/);
  assert.ok(isPublicKey(publishableKey), 'A browser publishable/anon key is required');
  assert.match(expectedSha, /^[a-f0-9]{40}$/i, 'Artifact release SHA is required');
  const checks = [];
  async function probe(label, work) {
    try { await work(); }
    catch { throw new Error(`Check failed: ${label}`); }
    checks.push(label);
  }
  const request = (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  for (const path of routePaths) {
    await probe(`route:${path}`, async () => {
      // Public routes may redirect (for example locale aliases).
      const res = await fetch(`${baseUrl}${path}`, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      assert.equal(res.status, 200);
      assert.match(await res.text(), /planicworks/i);
    });
  }
  const post = path => request(`${supabaseUrl}${path}`, {
    method: 'POST', body: '{}',
    headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}`, 'Content-Type': 'application/json' },
  });
  for (const [name, status, code] of providers) {
    await probe(`function:${name}`, async () => {
      const res = await post(`/functions/v1/${name}`);
      assert.equal(res.status, status);
      assert.equal((await res.json()).code, code);
    });
  }
  await probe('rpc:anonymous-denied', async () => {
    const res = await post('/rest/v1/rpc/crm_get_runtime_state');
    assert.equal(res.status, 401);
    assert.equal((await res.json()).code, '42501');
  });
  await probe('release:sha', async () => {
    for (let attempt = 1; attempt <= 36; attempt++) {
      const res = await request(`${baseUrl}/release.json?expected=${expectedSha}&attempt=${attempt}&cache_bust=${Date.now()}`, {
        cache: 'no-store', headers: { 'cache-control': 'no-cache' },
      });
      if (res.ok && (await res.json()).sha === expectedSha) return;
      if (attempt < 36) await sleep(5000);
    }
    throw new Error('Release mismatch');
  });
  return checks;
}

export async function runBrowserChecks(baseUrl, chrome, exec = execute) {
  assert.ok(chrome, 'Chrome is required');
  const publicPages = [
    ['pricing', /Fiyat|fiyat|Pricing|Prices|Preise/],
    ['privacy', /Gizlilik|gizlilik|Privacy|Datenschutz/],
    ['kvkk', /KVKK|Kişisel|kişisel|Personal Data|Personenbezogene/],
    ['terms', /Kullanım|kullanım|Terms|Nutzungsbedingungen/],
    ['cookies', /Çerez|çerez|Cookie/],
    ['support', /Destek|destek|Support|Hilfe/],
  ];
  const checks = [];
  for (const [route, marker] of [['dashboard'], ['settings'], ['super-admin'], ...publicPages]) {
    let passed = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Each attempt gets a separate empty profile; no customer session is used.
      const profile = await mkdtemp(join(tmpdir(), 'planicworks-monitor-'));
      let result;
      try {
        result = await exec(chrome, [
          '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
          '--enable-logging=stderr', '--window-size=390,844', `--user-data-dir=${profile}`,
          `--virtual-time-budget=${marker ? 8000 : 12000}`, '--dump-dom',
          `${baseUrl}/${route}?ops_monitor_attempt=${attempt}`,
        ], { timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
      } catch { continue; }
      finally { await rm(profile, { recursive: true, force: true }); }
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Uncaught (Error|TypeError)|Unhandled promise rejection/i, `Runtime error on /${route}`);
      passed = marker ? marker.test(result.stdout) : /type="email"/.test(result.stdout) && /type="password"/.test(result.stdout);
      if (passed) break;
    }
    assert.ok(passed, `Browser check failed: /${route}`);
    checks.push(`browser:/${route}`);
  }
  return checks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // release.json belongs to the checked-out public artifact, not its Git commit.
    const release = JSON.parse(await readFile('release.json', 'utf8'));
    const config = {
      baseUrl: 'https://planicworks.com',
      supabaseUrl: process.env.PLANICWORKS_SUPABASE_URL || '',
      publishableKey: process.env.PLANICWORKS_SUPABASE_PUBLISHABLE_KEY || '',
      expectedSha: release.sha,
    };
    const checks = await runHttpChecks(config);
    checks.push(...await runBrowserChecks(config.baseUrl, process.env.CHROME_BIN));
    console.log(JSON.stringify({ ok: true, total: checks.length, checks }));
  } catch (error) {
    // Never dump server response bodies, DOM, Chrome stderr or credentials.
    console.error(error.message?.startsWith('Check failed:') ? error.message : 'Public monitor failed; inspect configuration or browser checks.');
    process.exitCode = 1;
  }
}
