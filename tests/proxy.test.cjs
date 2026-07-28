/* Exercises api/run/[stage].js the way Vercel invokes it. */
const path = '/workspace/brace/api/run/[stage].js';

const ENV = {
  SUPABASE_URL: 'https://sb.test',
  SUPABASE_ANON_KEY: 'anon-key',
  PIPELINE_TOKEN: 'tok-secret',
  MODAL_BASE_URL: 'https://ed--brace-pipeline',
  YOUTUBE_API_KEY: 'yt-key',
};

// One search hit that passes every filter, one too short, one with a barred word.
const YT_SEARCH = { items: [{ id: { videoId: 'good1' } }, { id: { videoId: 'tiny1' } }, { id: { videoId: 'revw1' } }] };
const YT_VIDEOS = { items: [
  { id: 'good1', snippet: { title: 'Sporting clays, full round', channelTitle: 'The Line' },
    contentDetails: { duration: 'PT12M22S' }, statistics: { viewCount: '18422' } },
  { id: 'tiny1', snippet: { title: 'Quick clay', channelTitle: 'X' },
    contentDetails: { duration: 'PT10S' }, statistics: { viewCount: '4' } },
  { id: 'revw1', snippet: { title: 'Shotgun REVIEW and unboxing', channelTitle: 'Y' },
    contentDetails: { duration: 'PT9M' }, statistics: { viewCount: '900' } },
]};

function mkRes() {
  const r = { code: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

// Records what the handler asked for, and answers per the scenario.
function mkFetch({ owner = true, sbThrows = false, modal = { ok: true, status: 200, text: '{"stage":"discover","candidates":47}' }, hang = false, slowBody = false, ytFails = false, writeFails = false }) {
  const calls = [];
  return [calls, async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes('/rpc/is_portal_owner')) {
      if (sbThrows) throw new Error('dns');
      return { ok: true, json: async () => owner };
    }
    if (u.includes('googleapis.com/youtube/v3/search')) {
      if (ytFails) return { ok: false, status: 403, text: async () => 'quotaExceeded' };
      return { ok: true, json: async () => YT_SEARCH };
    }
    if (u.includes('googleapis.com/youtube/v3/videos')) {
      return { ok: true, json: async () => YT_VIDEOS };
    }
    if (u.includes('/rest/v1/pipeline_videos')) {
      if (writeFails) return { ok: false, status: 401, text: async () => '{"message":"permission denied"}' };
      const rows = JSON.parse(opts.body);
      return { ok: true, status: 201, text: async () => JSON.stringify(rows) };
    }
    if (hang) {
      return new Promise((_, rej) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
        });
      });
    }
    return {
      ok: modal.ok, status: modal.status,
      text: async () => {
        if (slowBody) await new Promise((r) => setTimeout(r, 400));  // outlives the wait
        return modal.text;
      },
    };
  }];
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `\n        ${detail}`}`);
}

async function run(name, { env = ENV, req = {}, fetchOpts = {}, expect }) {
  for (const k of Object.keys(process.env)) if (k in ENV || k === 'MODAL_URL_TRIAGE' || k === 'PIPELINE_WAIT_MS') delete process.env[k];
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

  await run('a Modal stage proxies and returns its body', {
    req: { query: { stage: 'triage' }, headers: AUTH },
    expect: (r, c) => r.code === 200 && r.body.candidates === 47
      && c[1].url.startsWith('https://ed--brace-pipeline-triage.modal.run'),
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
    env: { ...ENV, MODAL_URL_TRIAGE: 'https://custom.modal.run' },
    req: { query: { stage: 'triage' }, headers: AUTH },
    expect: (r, c) => c[1].url.startsWith('https://custom.modal.run'),
  });

  await run('Supabase unreachable is 502', {
    req: { query: { stage: 'triage' }, headers: AUTH },
    fetchOpts: { sbThrows: true },
    expect: (r) => r.code === 502,
  });

  await run('Modal rejecting the token surfaces as 502', {
    req: { query: { stage: 'triage' }, headers: AUTH },
    fetchOpts: { modal: { ok: false, status: 401, text: '{"error":"unauthorised"}' } },
    expect: (r) => r.code === 502 && r.body.error === 'unauthorised',
  });

  await run('non-JSON from Modal does not throw', {
    req: { query: { stage: 'triage' }, headers: AUTH },
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
    req: { query: { stage: 'triage' }, headers: AUTH },
    expect: (r) => r.code === 500 && /MODAL_BASE_URL/.test(JSON.stringify(r.body)),
  });

  await run('a redirect from Modal does not get the token re-sent', {
    req: { query: { stage: 'triage' }, headers: AUTH },
    fetchOpts: { modal: { ok: false, status: 302, text: '' } },
    expect: (r, c) => r.code === 502 && /redirected/i.test(r.body.error)
      && c[1].opts.redirect === 'manual',
  });

  await run('a slow body read is not mistaken for a timeout', {
    env: { ...ENV, PIPELINE_WAIT_MS: '120' },
    req: { query: { stage: 'triage' }, headers: AUTH },
    fetchOpts: { slowBody: true },
    expect: (r) => r.code === 200 && r.body.candidates === 47,
  });

  await run('config state is not disclosed before the bearer check', {
    env: { SUPABASE_URL: ENV.SUPABASE_URL },
    req: { query: { stage: 'discover' } },
    expect: (r) => r.code === 401 && !/configured/.test(JSON.stringify(r.body)),
  });

  await run('discover runs here and never touches Modal', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r, c) => r.code === 200 && r.body.stage === 'discover'
      && !c.some((x) => x.url.includes('modal.run')),
  });

  await run('discover keeps only what passes the filters', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r, c) => {
      const write = c.find((x) => x.url.includes('/rest/v1/pipeline_videos'));
      const rows = JSON.parse(write.opts.body);
      // the same video comes back from all seven queries; too-short and
      // review/unboxing titles are dropped
      return rows.length === 1 && rows[0].video_id === 'good1'
        && rows[0].duration_s === 742 && rows[0].status === 'discovered';
    },
  });

  await run('discover writes as the caller, not with a service key', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r, c) => {
      const write = c.find((x) => x.url.includes('/rest/v1/pipeline_videos'));
      return write.opts.headers.authorization === AUTH.authorization
        && /ignore-duplicates/.test(write.opts.headers.prefer)
        && write.url.includes('on_conflict=video_id');
    },
  });

  await run('discover without a YouTube key says so and writes nothing', {
    env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_ANON_KEY: ENV.SUPABASE_ANON_KEY },
    req: { query: { stage: 'discover' }, headers: AUTH },
    expect: (r, c) => r.code === 500 && /YOUTUBE_API_KEY/.test(JSON.stringify(r.body))
      && !c.some((x) => x.url.includes('pipeline_videos')),
  });

  await run('a YouTube quota error is reported, not swallowed', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    fetchOpts: { ytFails: true },
    expect: (r) => r.code === 502 && /YouTube/.test(r.body.error),
  });

  await run('RLS refusing the write surfaces', {
    req: { query: { stage: 'discover' }, headers: AUTH },
    fetchOpts: { writeFails: true },
    expect: (r) => r.code === 502 && /permission denied/.test(JSON.stringify(r.body)),
  });

  await run('a Modal stage without Modal configured says which is missing', {
    env: { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_ANON_KEY: ENV.SUPABASE_ANON_KEY },
    req: { query: { stage: 'clip' }, headers: AUTH },
    expect: (r) => r.code === 500 && /Modal/.test(r.body.error)
      && /Discover works without them/.test(r.body.detail),
  });

  const bad = results.filter((r) => !r.pass);
  console.log(`\n${results.length - bad.length}/${results.length} passed`);
  process.exit(bad.length ? 1 : 0);
})();
