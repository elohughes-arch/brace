/* ============================================================================
   POST /api/run/<stage>  — the only door between the portal and Modal.

   The pipeline token never reaches a browser. This function holds it, and it
   only attaches it once the database has confirmed the caller is a Brace owner
   on a two-factor session: is_portal_owner() returns true only when the email
   is on portal_owners AND the JWT carries aal2. PostgREST verifies the token's
   signature before that function ever runs, so a forged bearer gets nowhere.

   Environment (Vercel project settings):
     SUPABASE_URL       https://<project>.supabase.co
     SUPABASE_ANON_KEY  the anon/publishable key (already public in the client)
     PIPELINE_TOKEN     the shared secret, same value as the Modal secret
     MODAL_BASE_URL     https://<workspace>--brace-pipeline
                        (stage endpoints are <base>-<stage>.modal.run)
     MODAL_URL_DISCOVER / _TRIAGE / _CLIP / _PRELABEL  optional per-stage overrides
   ========================================================================== */

const STAGES = ['discover', 'triage', 'clip', 'prelabel'];

// Vercel functions are capped well below Modal's 30-minute timeouts, so we
// stop waiting long before the platform kills us. Modal carries on regardless
// of whether anyone is still holding the connection. Raise PIPELINE_WAIT_MS if
// your plan allows a longer function duration.
const WAIT_MS = Number(process.env.PIPELINE_WAIT_MS) || 25_000;

// Only these reach Modal; everything else in the query string is dropped.
const PASSTHROUGH = ['limit', 'unreviewed'];

function endpointFor(stage) {
  const override = process.env[`MODAL_URL_${stage.toUpperCase()}`];
  if (override) return override;
  const base = process.env.MODAL_BASE_URL;
  if (!base) return null;
  return `${base.replace(/\/+$/, '')}-${stage}.modal.run`;
}

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

  const { SUPABASE_URL, SUPABASE_ANON_KEY, PIPELINE_TOKEN } = process.env;
  const endpoint = endpointFor(stage);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !PIPELINE_TOKEN || !endpoint) {
    return res.status(500).json({
      error: 'pipeline not configured',
      detail: 'Set SUPABASE_URL, SUPABASE_ANON_KEY, PIPELINE_TOKEN and MODAL_BASE_URL.',
    });
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'sign in to the owners portal first' });
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

  // Hand-typed, and the workspace prefix takes an easily-missed double dash.
  // A bad value here should say so rather than throw a blank 500.
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return res.status(500).json({
      error: 'pipeline not configured',
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
    });
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
