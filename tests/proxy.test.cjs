/* Exercises api/run/[stage].js the way Vercel invokes it. */
const path = '/workspace/brace/api/run/[stage].js';

const ENV = {
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_ANON_KEY: 'anon-key',
  PIPELINE_TOKEN: 'tok-secret',
  MODAL_BASE_URL: 'https://ed--brace-pipeline',
};

function mkRes() {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// Records what the handler asked for, and answers per the scenario.
function mkFetch({ owner = true, sbThrows = false, modal = { ok: true, status: 200, text: '{"stage":"discover","candidates":47}' }, hang = false }) {
  const calls = [];
  return [calls, async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes('/rpc/is_portal_owner')) {
      if (sbThrows) throw new Error('dns');
      return { ok: true, json: async () => owner };
    }
    if (hang) {
      return new Promise((_, rej) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      });
    }
    return { ok: modal.ok, status: modal.status, text: async () => modal.text };
  }];
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`);
}

async function run(name, { env = ENV, req = {}, fetchOpts = {}, expect }) {
  for (const k of Object.keys(process.env)) if (k in ENV || k === 'MODAL_URL_DISCOVER' || k === 'PIPELINE_WAIT_MS') delete process.env[k];
  Object.assign(process.env, env);
  const [calls, f] = mkFetch(fetchOpts);
  global.fetch = f;
  delete require.cache[require.resolve(path)];
  const handler = require(path);
  const r = mkRes();
  await handler({ method: 'POST', query: {}, headers: {}, ...req }, r);
  const ok = expect(r, calls);
  check(name, ok === true, ok === true ? '' : `got ${r.code} ${JSON.stringify(r.body)} | calls: ${calls.map((c) => c.url).join(', ')}`);
}

(async () => {
  const AUTH = { authorization: 'Bearer jwt-abc' };

  await run('GET is rejected', {
    req: { method: 'GET', query: { stage: 'discover' } },
    expect: (r) => r.code === 405 && r.headers.allow === 'POST',
  });

  await run('unknown stage is 404', {
    req: { query: { stage: 'delete-everything' }, headers: AUTH },
    expect: (r) => r.code === 404,
  });

  await run('missing config is a clear 500, not a crash', {
    env: { SUPABASE_URL: ENV.SUPABASE_URL },
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r) => r.code === 500 && /not configured/.test(r.body.error),
  });

  await run('no bearer is 401 and never reaches Modal', {
    req: { query: { stage: 'discover' } },
    expect: (r, c) => r.code === 401 && c.length === 0,
  });

  await run('non-owner is 403 and never reaches Modal', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    fetchOpts: { owner: false },
    expect: (r, c) => r.code === 403 && !c.some((x) => x.url.includes('modal.run')),
  });

  await run('aal1 owner (rpc false) cannot start a job', {
    req: { query: { stage: 'prelabel' }, headers: AUTH },
    fetchOpts: { owner: false },
    expect: (r, c) => r.code === 403 && !c.some((x) => x.url.includes('modal.run')),
  });

  await run('happy path proxies and returns Modal body', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r, c) => r.code === 200 && r.body.candidates === 47
      && c[1].url.startsWith('https://ed--brace-pipeline-discover.modal.run'),
  });

  await run('token is attached server-side and the JWT is not forwarded', {
    req: { query: { stage: 'triage' }, headers: AUTH },
    expect: (r, c) => c[1].opts.headers['x-pipeline-token'] === 'tok-secret'
      && !('authorization' in c[1].opts.headers),
  });

  await run('only whitelisted query keys reach Modal', {
    req: { query: { stage: 'clip', limit: '5', unreviewed: '1', evil: 'DROP' }, headers: AUTH },
    expect: (r, c) => {
      const u = new URL(c[1].url);
      return u.searchParams.get('limit') === '5'
        && u.searchParams.get('unreviewed') === '1'
        && !u.searchParams.has('evil');
    },
  });

  await run('per-stage URL override wins', {
    env: { ...ENV, MODAL_URL_DISCOVER: 'https://custom.modal.run' },
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r, c) => c[1].url.startsWith('https://custom.modal.run'),
  });

  await run('Supabase unreachable is 502', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    fetchOpts: { sbThrows: true },
    expect: (r) => r.code === 502,
  });

  await run('Modal rejecting the token surfaces as 502', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    fetchOpts: { modal: { ok: false, status: 401, text: '{"error":"unauthorised"}' } },
    expect: (r) => r.code === 502 && r.body.error === 'unauthorised',
  });

  await run('non-JSON from Modal does not throw', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    fetchOpts: { modal: { ok: false, status: 500, text: '<html>Internal Error</html>' } },
    expect: (r) => r.code === 502 && typeof r.body.detail === 'string',
  });

  await run('a long stage returns 202, not an error', {
    env: { ...ENV, PIPELINE_WAIT_MS: '150' },
    req: { query: { stage: 'triage' }, headers: AUTH },
    fetchOpts: { hang: true },
    expect: (r) => r.code === 202 && r.body.status === 'running',
  });

  await run('a mistyped MODAL_BASE_URL is explained, not a blank 500', {
    env: { ...ENV, MODAL_BASE_URL: 'ed--brace-pipeline' },
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r) => r.code === 500 && /MODAL_BASE_URL/.test(JSON.stringify(r.body)),
  });

  const bad = results.filter((r) => !r.pass);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
})();
