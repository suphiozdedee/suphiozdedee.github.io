import test from 'node:test';
import assert from 'node:assert/strict';
import { runHttpChecks, runBrowserChecks } from './planicworks-public-monitor.mjs';

const slug = 'projenic-tasarim-mimarlik-tic-ltd-sti';
const briefPath = `/brief/${slug}`;
const brand = { ok: true, tenant: { slug, name: 'Projenic', logoUrl: 'https://public.supabase.co/storage/v1/object/sign/company-branding/company/b1000000-0000-4000-8000-000000000010/branding/logo.png?token=public-test-signature' } };
const sha = 'a'.repeat(40);
const config = { baseUrl: 'https://site.example', supabaseUrl: 'https://public.supabase.co', publishableKey: 'sb_publishable_public_test_fixture', expectedSha: sha };
const providers = {
  'create-iyzico-checkout': [503, 'PAYMENT_PROVIDER_DISABLED'],
  'iyzico-webhook': [503, 'PAYMENT_PROVIDER_DISABLED'],
  'paytr-token': [503, 'PAYMENT_PROVIDER_DISABLED'],
  'paytr-webhook': [503, 'PAYMENT_PROVIDER_DISABLED'],
  'drive-sync': [410, 'DRIVE_SYNC_RETIRED'],
};
const response = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
function transport(overrides = {}) {
  return async (url, options) => {
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path](options);
    if (path === '/release.json') return response(200, { sha });
    if (path === '/functions/v1/exhibition-brief-intake') {
      assert.equal(options.method, 'POST');
      assert.deepEqual(JSON.parse(options.body), { action: 'branding', slug });
      assert.equal(options.headers.Origin, 'https://planicworks.com');
      assert.equal(options.headers.apikey, config.publishableKey);
      return response(200, brand);
    }
    if (path.startsWith('/functions/v1/')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body, '{}');
      assert.equal(options.headers.apikey, config.publishableKey);
      const [status, code] = providers[path.split('/').at(-1)];
      return response(status, { code });
    }
    if (path.startsWith('/rest/v1/rpc/')) return response(401, { code: '42501' });
    assert.ok(['/', '/login', '/pricing', '/privacy', '/gizlilik', '/kvkk', '/terms', '/cookies', '/support', briefPath].includes(path));
    return response(200, '<html>PlanicWorks</html>');
  };
}
const noWait = async () => {};
test('all public probes succeed only with the artifact release SHA', async () => {
  assert.equal((await runHttpChecks(config, { fetch: transport(), sleep: noWait })).length, 18);
});
test('a route outage and missing brand fail the run', async () => {
  for (const reply of [() => response(500, 'PlanicWorks'), () => response(200, '<html>wrong site</html>')]) {
    await assert.rejects(runHttpChecks(config, { fetch: transport({ '/pricing': reply }), sleep: noWait }));
  }
});
test('every dormant provider must return both the exact denial status and code', async () => {
  for (const [name, [status, code]] of Object.entries(providers)) {
    for (const reply of [() => response(200, { code }), () => response(status, { code: 'ENABLED' })]) {
      await assert.rejects(runHttpChecks(config, { fetch: transport({ [`/functions/v1/${name}`]: reply }), sleep: noWait }));
    }
  }
});
test('anonymous RPC success or unrelated denial fails the run', async () => {
  for (const reply of [() => response(200, {}), () => response(401, { code: 'OTHER' })]) {
    await assert.rejects(runHttpChecks(config, { fetch: transport({ '/rest/v1/rpc/crm_get_runtime_state': reply }), sleep: noWait }));
  }
});
test('release mismatch exhausts the bounded retry window and fails', async () => {
  let requests = 0;
  await assert.rejects(runHttpChecks(config, { fetch: transport({ '/release.json': () => { requests++; return response(200, { sha: 'b'.repeat(40) }); } }), sleep: noWait }));
  assert.equal(requests, 36);
});
test('release propagation can recover within the window', async () => {
  let requests = 0;
  assert.equal((await runHttpChecks(config, { fetch: transport({ '/release.json': () => response(200, { sha: ++requests === 3 ? sha : 'b'.repeat(40) }) }), sleep: noWait })).length, 18);
});
test('transport failures and malformed release responses fail closed', async () => {
  for (const reply of [() => { throw new Error('offline'); }, () => response(200, 'invalid json')]) {
    await assert.rejects(runHttpChecks(config, { fetch: transport({ '/release.json': reply }), sleep: noWait }));
  }
});
test('privileged JWTs and missing expected release are rejected before network', async () => {
  const privileged = `x.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.x`;
  for (const change of [{ publishableKey: privileged }, { expectedSha: '' }]) {
    let networkCalls = 0;
    await assert.rejects(runHttpChecks({ ...config, ...change }, { fetch: async (...args) => { networkCalls++; return transport()(...args); }, sleep: noWait }));
    assert.equal(networkCalls, 0);
  }
});

const briefHtml = '<h1>Tasarım talebinizi birlikte netleştirelim.</h1><img alt="Projenic şirket logosu"><section><input id="brief-companyName"><input id="brief-contactName"><input id="brief-email"></section>';
const publicHtml = 'Fiyat Privacy KVKK Terms Cookie Support';
const loginHtml = '<input type="email"><input type="password">';
function chromeTransport(change = () => null) {
  return async (binary, args, options) => {
    assert.equal(binary, 'fake-chrome');
    assert.ok(options.timeout > 0);
    const url = new URL(args.at(-1));
    const protectedRoute = ['/dashboard', '/settings', '/super-admin', '/brief-talepleri'].includes(url.pathname);
    assert.ok(args.includes(`--virtual-time-budget=${protectedRoute ? 12000 : 8000}`));
    return change(url) || { stdout: protectedRoute ? loginHtml : url.pathname === briefPath ? briefHtml : publicHtml, stderr: '' };
  };
}
test('clean browser checks protect 4 auth routes and render 7 public pages', async () => {
  assert.equal((await runBrowserChecks(config.baseUrl, 'fake-chrome', chromeTransport())).length, 11);
});
test('missing password never passes and retries stop after 3 attempts', async () => {
  let attempts = 0;
  await assert.rejects(runBrowserChecks(config.baseUrl, 'fake-chrome', chromeTransport(url => {
    if (url.pathname === '/dashboard') { attempts++; return { stdout: '<input type="email">', stderr: '' }; }
  })));
  assert.equal(attempts, 3);
});
test('browser may recover on third attempt', async () => {
  assert.equal((await runBrowserChecks(config.baseUrl, 'fake-chrome', chromeTransport(url => {
    if (url.pathname === '/dashboard' && url.searchParams.get('ops_monitor_attempt') !== '3') return { stdout: '', stderr: '' };
  }))).length, 11);
});
test('runtime errors, missing public content and failed processes fail closed', async () => {
  for (const change of [
    () => ({ stdout: loginHtml, stderr: 'Uncaught TypeError: broken' }),
    url => url.pathname === '/pricing' ? { stdout: 'generic shell', stderr: '' } : null,
  ]) await assert.rejects(runBrowserChecks(config.baseUrl, 'fake-chrome', chromeTransport(change)));
  let attempts = 0;
  await assert.rejects(runBrowserChecks(config.baseUrl, 'fake-chrome', async () => { attempts++; throw new Error('timeout'); }));
  assert.equal(attempts, 3);
});


test('public brief HTTP route failure is detected', async () => {
  await assert.rejects(runHttpChecks(config, { fetch: transport({ [briefPath]: () => response(404, 'PlanicWorks') }), sleep: noWait }), /route:\/brief\//);
});
test('tenant branding rejects unavailable, wrong tenant, missing and foreign project logos', async () => {
  for (const [status, body] of [
    [503, { ok: false }], [200, { ...brand, ok: false }],
    [200, { ok: true, tenant: { ...brand.tenant, slug: 'other-company' } }],
    ...[null, 'https://public.supabase.co/storage/v1/object/public/company-branding/logo.png',
      brand.tenant.logoUrl.replace('public.supabase.co', 'other.supabase.co'),
      brand.tenant.logoUrl.replace('?token=public-test-signature', '')].map(logoUrl => [200, { ok: true, tenant: { ...brand.tenant, logoUrl } }]),
  ]) {
    await assert.rejects(runHttpChecks(config, { fetch: transport({ '/functions/v1/exhibition-brief-intake': () => response(status, body) }), sleep: noWait }), /Check failed: brief:branding$/);
  }
});
test('public brief requires its heading, company and actual form fields', async () => {
  for (const html of [publicHtml, briefHtml.replace(/<h1>.*?<\/h1>/, ''), briefHtml.replace('Projenic', 'Other'),
    briefHtml.replace('brief-companyName', 'unrelated-field'), briefHtml.replaceAll('<input ', '<span ')]) {
    await assert.rejects(runBrowserChecks(config.baseUrl, 'fake-chrome', chromeTransport(url =>
      url.pathname === briefPath ? { stdout: html, stderr: '' } : null)));
  }
});
test('brief inbox requires both login fields and keeps bounded retries', async () => {
  let attempts = 0;
  await assert.rejects(runBrowserChecks(config.baseUrl, 'fake-chrome', chromeTransport(url => {
    if (url.pathname === '/brief-talepleri') { attempts++; return { stdout: '<h1>Brief inbox</h1><input type="email">', stderr: '' }; }
  })));
  assert.equal(attempts, 3);
});
