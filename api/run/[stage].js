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

const STAGES = ['discover', 'triage', 'clip', 'screen', 'prelabel', 'recut', 'dataset', 'train', 'scrub', 'health'];
const LOCAL_STAGES = ['discover'];      // run here, not on Modal

// Vercel functions are capped well below Modal's 30-minute timeouts, so we
// stop waiting long before the platform kills us. Modal carries on regardless
// of whether anyone is still holding the connection. Raise PIPELINE_WAIT_MS if
// your plan allows a longer function duration.
const WAIT_MS = Number(process.env.PIPELINE_WAIT_MS) || 25_000;

// Only these reach Modal; everything else in the query string is dropped.
const PASSTHROUGH = ['limit', 'unreviewed', 'name', 'every', 'conf',
  'epochs', 'imgsz', 'base', 'phases', 'dry'];

/* ---------------------------------------------------------------- discover */
// Candidates come from pipeline_sources, which the portal edits. Three kinds:
//
//   query    a search phrase. 100 quota units a call, noisy, finds the unknown.
//   channel  a shooter you already trust. Listing uploads costs 1 unit per
//            fifty videos, so a whole back catalogue is nearly free — and it is
//            how permission-based sourcing works, since a channel row can
//            record that you asked.
//   video    one specific video, pasted in.

// The curriculum ladder: what to source at each rung, easiest first. The
// model earns each level before the next is poured in — the queries here are
// what "add criteria" discovery searches when a level is chosen instead of
// the sources list. Names and targets are mirrored in portal/portal.js.
const DS_LEVELS = {
  1: ['clay pigeon shooting slow motion', 'orange clay slow motion break',
    'incoming clay pigeon shot close', 'clay shooting first person easy targets'],
  2: ['sporting clays first person', 'clay pigeon crosser shotkam',
    'skeet shooting pov', 'trap shooting first person'],
  3: ['black clay pigeon shooting', 'midi clay sporting', 'blaze clay shooting'],
  4: ['clay shooting overcast', 'clay pigeon grey sky', 'winter clay shooting'],
  5: ['clay shooting woodland background', 'sporting clays trees',
    'clay pigeon valley shoot', 'high pheasant style clay'],
  6: ['long range clay shooting', 'high tower clay 40 yards', 'fast crossing clay'],
  7: ['clay shooting rain', 'clay shooting dusk', 'clay shooting fog low light'],
  8: ['simulated game shooting', 'clay flush shooting', 'rabbit clay shooting',
    'battue chandelle clay'],
  // Not a rung — a lens. Deployment is POV hardware, so training should be
  // too: the pack hunts footage from the exact cameras customers will wear.
  pov: ['shotkam clay shooting', 'shotkam sporting clays', 'barrel cam shotgun',
    'gopro head mount clay shooting', 'gopro chest mount skeet',
    'meta glasses shooting', 'smart glasses clay shooting pov',
    'point of view clay pigeon shooting'],
};

const MIN_DURATION_S = 30;
const MAX_DURATION_S = 3600;
const REJECT_TITLE_WORDS = [
  'review', 'unboxing', 'compilation', 'vs', 'reaction',
  'cleaning', 'reload', 'airsoft', 'video game', 'gameplay',
  'roblox', 'minecraft', 'fortnite', 'gta', 'farming simulator',
  "let's play", 'walkthrough', 'protest', 'manifestation', 'riot',
];

const yt = async (path, params) => {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${path}`);
  url.search = new URLSearchParams(params).toString();
  const r = await fetch(url);
  if (!r.ok) {
    const body = (await r.text()).slice(0, 200);
    throw new Error(`YouTube ${path} failed (${r.status}): ${body}`);
  }
  return r.json();
};

function iso8601Seconds(d) {
  const m = /^P(?:\d+D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  if (!m) return 0;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}

// A row is only worth keeping if it is long enough to hold shooting and its
// title does not announce that it is something else.
function rowsFrom(items, sourceId) {
  const out = [];
  for (const v of items || []) {
    const title = v.snippet?.title || '';
    const seconds = iso8601Seconds(v.contentDetails?.duration);
    if (seconds < MIN_DURATION_S || seconds > MAX_DURATION_S) continue;
    // Word boundaries, not substrings: bare includes('vs') rejected every
    // Elvis and canvas in the catalogue.
    if (REJECT_TITLE_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(title.toLowerCase()))) continue;
    out.push({
      video_id: v.id,
      source: 'youtube',
      title,
      channel: v.snippet?.channelTitle || null,
      url: `https://www.youtube.com/watch?v=${v.id}`,
      duration_s: seconds,
      view_count: Number(v.statistics?.viewCount || 0),
      status: 'discovered',
      source_id: sourceId,
    });
  }
  return out;
}

// Details come back fifty at a time, and cost one unit however many you ask for.
async function detailsFor(key, ids, sourceId) {
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const page = await yt('videos', {
      key, id: ids.slice(i, i + 50).join(','),
      part: 'contentDetails,statistics,snippet',
    });
    out.push(...rowsFrom(page.items, sourceId));
  }
  return out;
}

const VIDEO_ID = /(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/;

// A channel can be given as an id, an @handle, or any URL containing either.
async function channelUploads(key, ref, source, maxPages = 4) {
  let channelId = source.resolved_id || null;
  if (!channelId) {
    const idMatch = /(UC[A-Za-z0-9_-]{22})/.exec(ref);
    if (idMatch) {
      channelId = idMatch[1];
    } else {
      const handle = (/@([A-Za-z0-9._-]+)/.exec(ref) || [])[1];
      if (!handle) throw new Error(`not a channel id or @handle: ${ref}`);
      const found = await yt('channels', { key, forHandle: `@${handle}`, part: 'id' });
      channelId = found.items?.[0]?.id;
      if (!channelId) throw new Error(`no channel found for @${handle}`);
    }
  }
  // Every channel's uploads playlist is its id with the second letter changed.
  const uploads = `UU${channelId.slice(2)}`;
  const ids = [];
  let pageToken;
  for (let page = 0; page < maxPages; page += 1) {
    const list = await yt('playlistItems', {
      key, playlistId: uploads, part: 'contentDetails',
      maxResults: '50', ...(pageToken ? { pageToken } : {}),
    });
    ids.push(...(list.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean));
    pageToken = list.nextPageToken;
    if (!pageToken) break;
  }
  return { ids, channelId };
}

async function runDiscover({ supabaseUrl, anonKey, auth, level }) {
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

  const sb = (path, init) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: anonKey, authorization: auth, 'content-type': 'application/json', ...(init?.headers || {}) },
  });

  // Criteria discovery: a chosen ladder rung searches its own query pack
  // instead of the sources list, and every candidate found is stamped with
  // the level it was sourced for — that stamp is what the Dataset strategy
  // page and the Mastersheet count.
  if (level) {
    const queries = DS_LEVELS[level];
    if (!queries) return { code: 400, body: { error: `no such level: ${level}` } };
    const rows = [];
    const seen = new Set();
    for (const q of queries) {
      const hits = await yt('search', {
        key, q, part: 'snippet', type: 'video', maxResults: '50',
      });
      const ids = (hits.items || []).map((i) => i.id?.videoId).filter(Boolean);
      for (const row of await detailsFor(key, ids, null)) {
        if (seen.has(row.video_id)) continue;
        seen.add(row.video_id);
        // The POV pack is a lens, not a rung: triage will confirm the
        // camera from the frames, so it carries no ladder stamp.
        rows.push(Number.isInteger(level) ? { ...row, ds_level: level } : row);
      }
    }
    if (!rows.length) {
      return { code: 200, body: { stage: 'discover', level, found: 0, added: 0 } };
    }
    const write = await sb('pipeline_videos?on_conflict=video_id', {
      method: 'POST',
      headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify(rows),
    });
    const text = await write.text();
    if (!write.ok) {
      return { code: 502, body: { error: 'could not write the candidates', detail: text.slice(0, 300) } };
    }
    let added = null;
    try { added = JSON.parse(text).length; } catch { /* return=minimal */ }
    return {
      code: 200,
      body: { stage: 'discover', level, found: rows.length, added: added == null ? 'unknown' : added },
    };
  }

  const listed = await sb('pipeline_sources?enabled=eq.true&select=*');
  if (!listed.ok) {
    return { code: 502, body: { error: 'could not read your sources', detail: (await listed.text()).slice(0, 300) } };
  }
  const sources = await listed.json();
  if (!sources.length) {
    return { code: 200, body: { stage: 'discover', found: 0, added: 0, detail: 'no sources are switched on' } };
  }

  const rows = [];
  const seen = new Set();
  const problems = [];
  const touched = [];

  for (const src of sources) {
    try {
      let got = [];
      let resolved = src.resolved_id;
      if (src.kind === 'query') {
        // No videoDuration filter: it caps at 20 minutes, which would rule out
        // exactly the long simulated-game-day footage worth having.
        const hits = await yt('search', {
          key, q: src.ref, part: 'snippet', type: 'video', maxResults: '50',
        });
        const ids = (hits.items || []).map((i) => i.id?.videoId).filter(Boolean);
        got = await detailsFor(key, ids, src.id);
      } else if (src.kind === 'channel') {
        const { ids, channelId } = await channelUploads(key, src.ref, src);
        resolved = channelId;
        got = await detailsFor(key, ids, src.id);
      } else {
        const id = (VIDEO_ID.exec(src.ref) || [])[1] || src.ref.trim();
        got = await detailsFor(key, [id], src.id);
      }

      let fresh = 0;
      for (const row of got) {
        if (seen.has(row.video_id)) continue;
        seen.add(row.video_id);
        rows.push(row);
        fresh += 1;
      }
      touched.push({ id: src.id, resolved_id: resolved ?? null, last_found: fresh });
    } catch (e) {
      problems.push(`${src.label || src.ref}: ${e.message}`);
    }
  }

  // Record what each source turned up, so a dead one is visible on the page.
  const stamp = new Date().toISOString();
  await Promise.all(touched.map((t) => sb(`pipeline_sources?id=eq.${t.id}`, {
    method: 'PATCH',
    headers: { prefer: 'return=minimal' },
    body: JSON.stringify({ last_run_at: stamp, last_found: t.last_found, resolved_id: t.resolved_id }),
  }).catch(() => {})));

  if (!rows.length) {
    return {
      code: problems.length ? 502 : 200,
      body: problems.length
        ? { error: 'nothing could be searched', detail: problems[0] }
        : { stage: 'discover', found: 0, added: 0 },
    };
  }

  // Written as the signed-in owner, so RLS decides, exactly as in the browser.
  // ignore-duplicates keeps a re-run from resetting anything already part-way
  // through the pipeline.
  const write = await sb('pipeline_videos?on_conflict=video_id', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  const text = await write.text();
  if (!write.ok) {
    return { code: 502, body: { error: 'could not write the candidates', detail: text.slice(0, 300) } };
  }
  let added = null;
  try { added = JSON.parse(text).length; } catch { /* return=minimal, or odd body */ }

  return {
    code: 200,
    body: {
      stage: 'discover',
      sources: sources.length,
      found: rows.length,
      added: added == null ? 'unknown' : added,
      ...(problems.length ? { warnings: problems.slice(0, 3) } : {}),
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
      const level = req.query.level === 'pov' ? 'pov'
        : Math.max(0, Math.min(8, Number(req.query.level) || 0)) || null;
      const { code, body } = await runDiscover({
        supabaseUrl: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, auth, level,
      });
      return res.status(code).json(body);
    } catch (e) {
      return res.status(502).json({ error: 'discover failed', detail: String(e && e.message || e) });
    }
  }

  const PIPELINE_TOKEN = process.env.PIPELINE_TOKEN;
  const endpoint = endpointFor(stage);
  if (!PIPELINE_TOKEN || !endpoint) {
    // Name the absent variable: "not configured" alone cannot distinguish a
    // missing var from one saved in Vercel but scoped to an environment this
    // deployment was not built for.
    const missing = [
      !PIPELINE_TOKEN && 'PIPELINE_TOKEN',
      !endpoint && 'MODAL_BASE_URL',
    ].filter(Boolean).join(' and ');
    return res.status(500).json({
      error: 'Modal not configured',
      detail: `${missing} did not reach this deployment. If it is saved in `
        + 'Vercel, check it is ticked for the environment this deployment '
        + 'was built for (Production and Preview), then redeploy — variables '
        + 'only reach new builds.',
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
