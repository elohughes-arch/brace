/* ============================================================================
   POST /api/run/<stage>  — the only door between the portal and the pipeline.

   Two kinds of stage live behind this one endpoint.

   `discover` is plain HTTP: search YouTube, filter, write rows. It runs right
   here, because sending it to Modal would mean standing Modal up before the
   dashboard could show a single thing. It writes with the caller's own Supabase
   session, so Row Level Security applies exactly as it does in the browser and
   no service key is needed on this side.

   `triage`, `clip` and `prelabel` need yt-dlp, ffmpeg and a GPU. They run on
   Modal, and this proxies to them. The pipeline token never reaches a browser:
   this function holds it and only attaches it once the database has confirmed
   the caller is a Brace owner on a two-factor session. is_portal_owner()
   returns true only when the email is on portal_owners AND the JWT carries
   aal2, and PostgREST verifies the token's signature before that function ever
   runs, so a forged bearer gets nowhere.

   Environment (Vercel project settings):
     SUPABASE_URL       https://<project>.supabase.co          (always)
     SUPABASE_ANON_KEY  the anon key, already public in the client (always)
     YOUTUBE_API_KEY    YouTube Data API v3                    (discover)
     PIPELINE_TOKEN     the shared secret, same value as the Modal secret
     MODAL_BASE_URL     https://<workspace>--brace-pipeline
                        (stage endpoints are <base>-<stage>.modal.run)
     MODAL_URL_TRIAGE / _CLIP / _PRELABEL   optional per-stage overrides
   ========================================================================== */

const STAGES = ['discover', 'triage', 'clip', 'prelabel'];
const LOCAL_STAGES = ['discover'];      // run here, not on Modal

// Vercel functions are capped well below Modal's 30-minute timeouts, so we
// stop waiting long before the platform kills us. Modal carries on regardless
// of whether anyone is still holding the connection. Raise PIPELINE_WAIT_MS if
// your plan allows a longer function duration.
const WAIT_MS = Number(process.env.PIPELINE_WAIT_MS) || 25_000;

// Only these reach Modal; everything else in the query string is dropped.
const PASSTHROUGH = ['limit', 'unreviewed'];

/* ---------------------------------------------------------------- discover */
// Kept deliberately in step with pipeline/discover.py, which is the same search
// run from a terminal. Change one, change the other.

const QUERIES = [
  'clay shooting POV',
  'sporting clays first person',
  'shotkam clay',
  'clay pigeon shooting gopro',
  'simulated game day shooting',
  'skeet shooting POV',
  'compak sporting POV',
];
const MIN_DURATION_S = 30;
const MAX_DURATION_S = 3600;
const REJECT_TITLE_WORDS = [
  'review', 'unboxing', 'compilation', 'vs', 'reaction',
  'cleaning', 'reload', 'airsoft', 'video game', 'gameplay',
];

function iso8601Seconds(d) {
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

async function youtubeCandidates(key, query) {
  const search = new URL('https://www.googleapis.com/youtube/v3/search');
  search.search = new URLSearchParams({
    key, q: query, part: 'snippet', type: 'video',
    maxResults: '50', videoDuration: 'medium',
  }).toString();
  const found = await fetch(search);
  if (!found.ok) throw new Error(`YouTube search failed (${found.status}): ${(await found.text()).slice(0, 200)}`);
  const ids = ((await found.json()).items || []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  const details = new URL('https://www.googleapis.com/youtube/v3/videos');
  details.search = new URLSearchParams({
    key, id: ids.join(','), part: 'contentDetails,statistics,snippet',
  }).toString();
  const meta = await fetch(details);
  if (!meta.ok) throw new Error(`YouTube lookup failed (${meta.status})`);

  const out = [];
  for (const v of (await meta.json()).items || []) {
    const title = v.snippet?.title || '';
    const seconds = iso8601Seconds(v.contentDetails?.duration);
    if (seconds < MIN_DURATION_S || seconds > MAX_DURATION_S) continue;
    if (REJECT_TITLE_WORDS.some((w) => title.toLowerCase().includes(w))) continue;
    out.push({
      video_id: v.id,
      source: 'youtube',
      title,
      channel: v.snippet?.channelTitle || null,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      duration_s: seconds,
      view_count: Number(v.statistics?.viewCount || 0),
      status: 'discovered',
    });
  }
  return out;
}

async function runDiscover({ supabaseUrl, anonKey, auth }) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    return {
      code: 500,
      body: {
        error: 'discover not configured',
        detail: 'Set YOUTUBE_API_KEY in the Vercel project. It is the only key '
          + 'this stage needs — everything else runs on your own session.',
      },
    };
  }

  const rows = [];
  const seen = new Set();
  const problems = [];
  for (const q of QUERIES) {
    try {
      for (const row of await youtubeCandidates(key, q)) {
        if (seen.has(row.video_id)) continue;   // the queries overlap heavily
        seen.add(row.video_id);
        rows.push(row);
      }
    } catch (e) {
      problems.push(`${q}: ${e.message}`);
    }
  }

  if (!rows.length) {
    return {
      code: problems.length ? 502 : 200,
      body: problems.length
        ? { error: 'YouTube would not answer', detail: problems[0] }
        : { stage: 'discover', found: 0, added: 0 },
    };
  }

  // Written as the signed-in owner, so RLS decides, exactly as in the browser.
  // ignore-duplicates keeps a re-run from resetting the status of anything
  // already part-way through the pipeline.
  const write = await fetch(
    `${supabaseUrl}/rest/v1/pipeline_videos?on_conflict=video_id`,
    {
      method: 'POST',
      headers: {
        apikey: anonKey,
        authorization: auth,
        'content-type': 'application/json',
        prefer: 'resolution=ignore-duplicates,return=representation',
      },
      body: JSON.stringify(rows),
    },
  );
  const text = await write.text();
  if (!write.ok) {
    return {
      code: 502,
      body: { error: 'could not write the candidates', detail: text.slice(0, 300) },
    };
  }
  let added = null;
  try { added = JSON.parse(text).length; } catch { /* return=minimal, or odd body */ }

  return {
    code: 200,
    body: {
      stage: 'discover',
      found: rows.length,
      added: added == null ? 'unknown' : added,
      ...(problems.length ? { warnings: problems.length } : {}),
    },
  };
}

/* ------------------------------------------------------------------- Modal */

function endpointFor(stage) {
  const override = process.env[`MODAL_URL_${stage.toUpperCase()}`];
  if (override) return override;
  const base = process.env.MODAL_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}-${stage}.modal.run`;
}

/* ----------------------------------------------------------------- handler */

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const stage = String(req.query.stage || '');
  if (!STAGES.includes(stage)) {
    return res.status(404).json({ error: 'unknown stage' });
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'sign in to the owners portal first' });
  }

  // Config state is only reported to someone who got past the bearer check.
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({
      error: 'pipeline not configured',
      detail: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel project.',
    });
  }

  // The database is the authority, not this function.
  let owner = false;
  try {
    const check = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_portal_owner`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: auth,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    owner = check.ok && (await check.json()) === true;
  } catch {
    return res.status(502).json({ error: 'could not reach Supabase' });
  }
  if (!owner) {
    return res.status(403).json({ error: 'owners only, and only on a two-factor session' });
  }

  if (LOCAL_STAGES.includes(stage)) {
    try {
      const { code, body } = await runDiscover({
        supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, auth,
      });
      return res.status(code).json(body);
    } catch (e) {
      return res.status(502).json({ error: 'discover failed', detail: String(e && e.message || e) });
    }
  }

  const PIPELINE_TOKEN = process.env.PIPELINE_TOKEN;
  const endpoint = endpointFor(stage);
  if (!PIPELINE_TOKEN || !endpoint) {
    return res.status(500).json({
      error: 'Modal not configured',
      detail: `${stage} needs yt-dlp, ffmpeg or a GPU, so it runs on Modal. `
        + 'Set PIPELINE_TOKEN and MODAL_BASE_URL once you have deployed it. '
        + 'Discover works without them.',
    });
  }

  // Hand-typed, and the workspace prefix takes an easily-missed double dash.
  // A bad value here should say so rather than throw a blank 500.
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return res.status(500).json({
      error: 'Modal not configured',
      detail: `MODAL_BASE_URL does not make a valid URL (built "${endpoint}"). `
        + 'It should look like https://<workspace>--brace-pipeline, including https:// '
        + 'and the double dash.',
    });
  }
  for (const key of PASSTHROUGH) {
    if (req.query[key] != null) url.searchParams.set(key, String(req.query[key]));
  }

  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), WAIT_MS);
  try {
    const run = await fetch(url, {
      method: 'POST',
      headers: { 'x-pipeline-token': PIPELINE_TOKEN, 'content-type': 'application/json' },
      body: '{}',
      signal: stop.signal,
      redirect: 'manual',        // never hand the token to a redirect target
    });
    clearTimeout(timer);         // answered; reading the body must not time out
    if (run.status >= 300 && run.status < 400) {
      return res.status(502).json({
        error: 'Modal redirected',
        detail: 'Check MODAL_BASE_URL points straight at the endpoint.',
      });
    }
    const text = await run.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { detail: text.slice(0, 500) }; }
    return res.status(run.ok ? 200 : 502).json(body);
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // Not a failure. Long stages outlive the request; the counts will move.
      return res.status(202).json({
        stage,
        status: 'running',
        detail: 'Still running on Modal. The counts will catch up.',
      });
    }
    return res.status(502).json({ error: 'could not reach Modal', detail: String(e) });
  } finally {
    clearTimeout(timer);
  }
};
