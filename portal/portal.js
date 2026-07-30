/* ============================================================================
   BRACE owners portal — the estate office.

   This fronts the agentic software, so it is two-factor and the second factor
   is not optional. Access is decided in the database, not here:
   is_portal_owner() requires the email to be on the owners list AND the
   session to have reached AAL2 (a verified TOTP code). A password-only or
   link-only session reads zero rows, whatever the browser does.
   ========================================================================== */
import { supabase } from './supabase-portal.js';

const root = document.getElementById('root');
const ic = (id, w = 18) => `<svg width="${w}" height="${w}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n ?? 0).toLocaleString('en-GB');
const dateFmt = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

// The fallback in index.html reports whichever of these was reached last, so a
// stall names its step instead of guessing at a cause.
const stage = (what) => { root.dataset.bootStage = what; };

// Dropping the stored session must not depend on the network or on the client
// being healthy — those are exactly the things that are broken when it is
// needed. Straight at the storage.
function forgetStoredSession() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('sb-') || k.startsWith('brace-portal'))
      .forEach((k) => localStorage.removeItem(k));
  } catch { /* private browsing */ }
}

// Supabase calls normally answer in well under a second. Anything still
// outstanding after this is not going to arrive, and a rejection the visitor
// can read beats a spinner that turns for ever.
function within(promise, seconds, what) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer within ${seconds} seconds.`)), seconds * 1000);
    }),
  ]);
}

/* How was this session authenticated? Supabase reports it alongside the
   assurance level; the access token's own amr claim is the fallback if the
   client predates that field. Either way the answer travels with the session,
   which is what makes it survive a new tab. */
function authMethods(session, aal) {
  const reported = (aal?.currentAuthenticationMethods || []).map((m) => m.method);
  if (reported.length) return reported;
  try {
    const b64 = String(session?.access_token || '').split('.')[1]
      .replace(/-/g, '+').replace(/_/g, '/');
    const claims = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
    return (claims.amr || []).map((m) => m.method);
  } catch { return []; }
}

/* ---------- gate shell ---------- */

function gate(inner, tag = 'Owners portal', mod = '') {
  epoch += 1;                     // any gate screen retires the dashboard
  clearInterval(poll); poll = null;
  root.dataset.up = '1';          // tells the fallback in index.html to stand down
  root.innerHTML = `
    <div class="gate">
      <div class="gate-card ${mod}">
        <a class="gate-home" href="../" aria-label="Back to Brace"><img class="gate-mark" src="../assets/brand/brace-a-mark-white.svg" alt="Brace" width="740" height="732" /></a>
        <div class="gate-tag">${esc(tag)}</div>
        ${inner}
      </div>
    </div>`;
}
const setErr = (m) => { const e = document.getElementById('err'); if (e) e.textContent = m || ''; };
const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

/* A spinner that never resolves is the worst thing this page can do: nothing to
   read, nothing to report, nothing to debug. Every failure lands here instead. */
function renderBroken(what, err) {
  const msg = err && (err.message || err.error_description || err.msg) || String(err ?? 'Unknown error');
  gate(`
    <h1>The portal could not start</h1>
    <p class="gate-lede">${esc(what)}</p>
    <div class="err" style="margin:0 0 16px">${esc(msg)}</div>
    <button class="btn" id="again">Try again</button>
    <button class="btn btn-ghost" id="out" style="margin-top:10px">Forget this session and start over</button>
    <div class="gate-foot">If it keeps happening, send that message on — it says
       exactly which step failed.</div>`);
  document.getElementById('again').addEventListener('click', () => { booting = false; boot(); });
  document.getElementById('out').addEventListener('click', async () => {
    // signOut() needs the network. If that is what is broken, clearing the
    // stored session locally is the only way back to the sign-in form.
    try { await within(supabase.auth.signOut(), 6, 'Signing out'); } catch { /* do it by hand */ }
    forgetStoredSession();
    try { sessionStorage.clear(); } catch { /* private browsing */ }
    location.replace(location.pathname);
  });
}

/* ---------- 1 · password ---------- */

function renderSignIn(err = '') {
  gate(`
    <h1>Sign in</h1>
    <p class="gate-lede">Owners only. Password and an authenticator code are both required.</p>
    <form id="f">
      <div class="field"><input type="email" id="email" placeholder="you@estate.com" autocomplete="email" required /></div>
      <div class="field"><input type="password" id="pw" placeholder="Password" autocomplete="current-password" required /></div>
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" type="submit">Continue</button>
    </form>
    <div class="gate-foot">
      <a href="#" id="first">First time, or forgotten it?</a><br />
      <a href="../app/">Open the app</a> · <a href="../">Back to the site</a>
    </div>`);

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    busy(btn, true, 'Checking…'); setErr('');
    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('pw').value,
    });
    if (error) { busy(btn, false, 'Continue'); setErr(error.message); return; }
    sessionStorage.setItem('brace-portal-pw', '1');   // first factor satisfied
    boot();                       // boot decides the next factor
  });

  document.getElementById('first').addEventListener('click', (e) => { e.preventDefault(); renderBootstrap(); });
}

/* ---------- bootstrap: a one-time link, only ever to SET a password ---------- */
// A link on its own can't reach anything (it lands at aal1), so this is safe:
// it exists so an owner can set a first password and enrol a factor.

function renderBootstrap(err = '') {
  gate(`
    <h1>Set up your access</h1>
    <p class="gate-lede">We'll email you a one-time link. It won't open the portal on its own —
       it lets you set a password and add your authenticator.</p>
    <form id="f">
      <div class="field"><input type="email" id="email" placeholder="you@estate.com" autocomplete="email" required /></div>
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" type="submit">Email me a link</button>
    </form>
    <div class="gate-foot"><a href="#" id="back">Back to sign in</a></div>`);

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    const email = document.getElementById('email').value.trim();
    busy(btn, true, 'Sending…'); setErr('');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    });
    if (error) { busy(btn, false, 'Email me a link'); setErr(error.message); return; }
    gate(`<h1>Check your inbox</h1>
      <p class="gate-lede">A set-up link is on its way to <strong>${esc(email)}</strong>.
         Open it on this device.</p>`);
  });
  document.getElementById('back').addEventListener('click', (e) => { e.preventDefault(); renderSignIn(); });
}

/* ---------- 2 · set a password (first run) ---------- */

function renderSetPassword(err = '', change = false) {
  gate(`
    <h1>${change ? 'Change your password' : 'Choose a password'}</h1>
    <p class="gate-lede">${change
      ? 'This replaces the first of your two factors. Your authenticator is untouched.'
      : 'This is the first of your two factors. Make it long and unique to Brace.'}</p>
    <form id="f">
      <div class="field"><input type="password" id="pw1" placeholder="New password" autocomplete="new-password" required /></div>
      <div class="field"><input type="password" id="pw2" placeholder="Repeat it" autocomplete="new-password" required /></div>
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" type="submit">Save password</button>
    </form>
    <div class="gate-foot">${change
      ? '<a href="#" id="back">Back to the pipeline</a>'
      : 'Already set one? <a href="#" id="out">Sign out and use it</a>.'}</div>`);

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    const a = document.getElementById('pw1').value, b = document.getElementById('pw2').value;
    if (a.length < 12) return setErr('Use at least 12 characters.');
    if (a !== b) return setErr("Those don't match.");
    busy(btn, true, 'Saving…'); setErr('');
    const { error } = await supabase.auth.updateUser({
      password: a, data: { portal_password_set: true },
    });
    if (error) { busy(btn, false, 'Save password'); return setErr(error.message); }
    sessionStorage.setItem('brace-portal-pw', '1');
    boot();
  });
  document.getElementById('back')?.addEventListener('click', (e) => { e.preventDefault(); boot(); });
  document.getElementById('out')?.addEventListener('click', async (e) => { e.preventDefault(); sessionStorage.removeItem('brace-portal-pw');
    sessionStorage.removeItem('brace-portal-otp'); await supabase.auth.signOut(); boot(); });
}

/* ---------- 3 · enrol an authenticator ---------- */

let enrolling = false;

async function renderEnrol(err = '') {
  if (enrolling) return;          // never enrol twice for one visit
  enrolling = true;
  gate(`<h1>Add your authenticator</h1><p class="gate-lede">Preparing…</p>`);

  // The latch above must reopen even if this fails. Left shut, every later
  // boot() returns from renderEnrol without drawing anything, and the visitor
  // is stuck on "Preparing…" until they clear the tab.
  let data, error;
  try {
    // Clear any half-finished factors first. Every enroll() mints a fresh
    // secret, so a stale one left lying about means the QR on screen and the
    // factor being verified can disagree — codes then never match.
    const { data: list } = await supabase.auth.mfa.listFactors();
    for (const f of (list?.all || list?.totp || [])) {
      if (f.status !== 'verified') {
        try { await supabase.auth.mfa.unenroll({ factorId: f.id }); } catch { /* already gone */ }
      }
    }
    ({ data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp', friendlyName: 'Brace portal',
    }));
  } finally {
    enrolling = false;
  }
  if (error) {
    gate(`<h1>Add your authenticator</h1><div class="err">${esc(error.message)}</div>
          <button class="btn btn-ghost" id="out">Sign out</button>`);
    document.getElementById('out').addEventListener('click', async () => { sessionStorage.removeItem('brace-portal-pw');
    sessionStorage.removeItem('brace-portal-otp'); await supabase.auth.signOut(); boot(); });
    return;
  }
  const factorId = data.id;
  const qr = (data.totp.qr_code || '').trim();
  const uri = data.totp.uri || '';
  const secret = data.totp.secret || '';
  const qrHtml = qr.startsWith('<svg')
    ? `<div class="qr" role="img" aria-label="Enrolment QR code">${qr}</div>`
    : `<img class="qr" src="${esc(qr)}" alt="Enrolment QR code" />`;
  // grouped in fours, so it can be read off the screen without losing your place
  const grouped = (secret.match(/.{1,4}/g) || [secret]).join(' ');

  gate(`
    <h1>Add your authenticator</h1>
    <p class="gate-lede">A six-digit code, as well as your password.
       You only set this up once.</p>

    <div class="rule"></div>

    <p class="step-label">Step one · Scan with your authenticator</p>
    <div class="qr-plate">${qrHtml}</div>
    <details class="alt">
      <summary>Can't scan it? Enter the key by hand</summary>
      <div class="alt-body">
        <div class="secret-row">
          <code id="secret">${esc(grouped)}</code>
          <button type="button" class="btn-copy" id="copy">Copy</button>
        </div>
      </div>
    </details>

    <div class="rule"></div>

    <p class="step-label">Step two · Enter the code it shows</p>
    <form id="f">
      <input type="text" id="code" inputmode="numeric" autocomplete="one-time-code"
        pattern="[0-9]{6}" maxlength="6" placeholder="000000" required aria-label="Six-digit code" />
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" type="submit">Verify and finish</button>
    </form>
    <div class="gate-foot"><a href="#" id="out">Sign out</a></div>`,
    'Owners portal · Set-up', 'centred');

  document.getElementById('copy').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(secret);      // copy it unspaced
      e.target.textContent = 'Copied';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 1600);
    } catch {
      const r = document.createRange(); r.selectNode(document.getElementById('secret'));
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }
  });

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    busy(btn, true, 'Verifying…'); setErr('');
    try {
      const ch = await supabase.auth.mfa.challenge({ factorId });
      if (ch.error) return setErr(ch.error.message);
      const v = await supabase.auth.mfa.verify({
        factorId, challengeId: ch.data.id, code: document.getElementById('code').value.trim(),
      });
      if (v.error) return setErr(v.error.message);
      sessionStorage.setItem('brace-portal-otp', '1');   // this tab has proven the code
      boot();
    } catch (err) {
      setErr(err.message || 'Could not reach Supabase. Try again.');
    } finally {
      busy(btn, false, 'Verify and finish');
    }
  });
  document.getElementById('out').addEventListener('click', async (e) => { e.preventDefault(); sessionStorage.removeItem('brace-portal-pw');
    sessionStorage.removeItem('brace-portal-otp'); await supabase.auth.signOut(); boot(); });
}

/* ---------- 4 · the second factor, every sign-in ---------- */

function renderChallenge(factorId, err = '') {
  gate(`
    <h1>Authenticator code</h1>
    <p class="gate-lede">Six digits from your authenticator app.</p>
    <div class="rule"></div>
    <form id="f">
      <input type="text" id="code" inputmode="numeric" autocomplete="one-time-code"
        pattern="[0-9]{6}" maxlength="6" placeholder="000000" required autofocus aria-label="Six-digit code" />
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" type="submit">Unlock</button>
    </form>
    <div class="gate-foot"><a href="#" id="out">Sign out</a></div>`,
    'Owners portal', 'centred');

  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    busy(btn, true, 'Checking…'); setErr('');
    // Without the finally, a dropped request leaves the button disabled on
    // "Checking…" with no way to try the next code.
    try {
      const ch = await supabase.auth.mfa.challenge({ factorId });
      if (ch.error) return setErr(ch.error.message);
      const v = await supabase.auth.mfa.verify({
        factorId, challengeId: ch.data.id, code: document.getElementById('code').value.trim(),
      });
      if (v.error) return setErr(v.error.message);
      sessionStorage.setItem('brace-portal-otp', '1');   // this tab has proven the code
      boot();
    } catch (err) {
      setErr(err.message || 'Could not reach Supabase. Try again.');
    } finally {
      busy(btn, false, 'Unlock');
    }
  });
  document.getElementById('out').addEventListener('click', async (e) => { e.preventDefault(); sessionStorage.removeItem('brace-portal-pw');
    sessionStorage.removeItem('brace-portal-otp'); await supabase.auth.signOut(); boot(); });
}

function renderDenied(email) {
  gate(`
    <h1>Not on the owners list</h1>
    <p class="gate-lede">${esc(email)} can't reach the portal. If it should,
       add it to <code>portal_owners</code> in Supabase.</p>
    <a class="btn" href="../">Back to Brace</a>
    <button class="btn btn-ghost" id="out" style="margin-top:10px">Sign out</button>`);
  document.getElementById('out').addEventListener('click', async () => { sessionStorage.removeItem('brace-portal-pw');
    sessionStorage.removeItem('brace-portal-otp'); await supabase.auth.signOut(); boot(); });
}

/* ---------- the pipeline ----------
   Third-party footage in, labelled clays out. Five states, and the only one
   that needs a person is the review queue: triage decides what is worth
   keeping, a human decides what is worth cutting. */

const STAGES = [
  { key: 'discovered', label: 'Discovered', note: 'found by search' },
  { key: 'downloaded', label: 'Triaged', note: 'awaiting your call' },
  { key: 'approved', label: 'Approved', note: 'queued to clip' },
  { key: 'clipped', label: 'Clipped', note: 'cut around each shot' },
];

const RUNS = [
  { stage: 'discover', label: 'Discover', busy: 'Searching', desc: 'Search YouTube for new candidates. Runs on the website itself, so it works before Modal does.' },
  { stage: 'triage', label: 'Triage', busy: 'Triaging', desc: 'Download the next batch, sample frames, score them for training value. What survives lands in the review queue. Needs Modal.' },
  { stage: 'clip', label: 'Clip', busy: 'Clipping', desc: 'Find the shots in everything you have approved and cut a clip around each one. Needs Modal.' },
  { stage: 'screen', label: 'Screen', busy: 'Screening', desc: 'Detect clays in every raw cut: no clay rejects it, a clay trims it to the flight and sends it for your check. Needs Modal.' },
  { stage: 'prelabel', label: 'Pre-label', busy: 'Pre-labelling', desc: 'Draw the first pass of boxes on the clays and push the frames to Roboflow for checking. Needs Modal.', primary: true },
];

const log = [];
const now = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const note = (line, tone = '') => { log.unshift({ t: now(), line, tone }); log.length = Math.min(log.length, 40); };

const mmss = (s) => {
  if (!s && s !== 0) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`;
};

// Count rows per state. The column being *selected* and the column being
// *filtered* are different things — filtering the id column against a status
// name matches nothing at all, and against a uuid id it is a type error.
async function tally(table, idCol, stateCol, values) {
  const res = await Promise.all(values.map((v) =>
    supabase.from(table).select(idCol, { count: 'exact', head: true }).eq(stateCol, v)));
  const out = {};
  values.forEach((v, i) => { out[v] = res[i].error ? null : (res[i].count ?? 0); });
  return out;
}

async function loadCounts() {
  const [videos, clips] = await Promise.all([
    tally('pipeline_videos', 'video_id', 'status',
      ['discovered', 'downloaded', 'approved', 'clipped', 'rejected', 'error']),
    tally('pipeline_clips', 'clip_id', 'label_status', ['raw', 'pending', 'queued', 'prelabelled']),
  ]);
  return { ...videos, ...clips };
}

async function loadSources() {
  const { data, error } = await supabase.from('pipeline_sources')
    .select('*').order('kind').order('label');
  return error ? [] : (data || []);
}

async function loadIssues() {
  const { data, error } = await supabase.from('pipeline_videos')
    .select('video_id,title,triage_notes,updated_at')
    .eq('status', 'error')
    .order('updated_at', { ascending: false })
    .limit(12);
  return error ? [] : (data || []);
}

// Recorded token counts, not a guess. Priced at Haiku rates because that is
// the default triage model; if TRIAGE_MODEL is changed the tokens stay right
// and only the multiplication is off.
const HAIKU_IN_PER_M = 1.00;
const HAIKU_OUT_PER_M = 5.00;

async function loadSpend() {
  let data, error;
  try { ({ data, error } = await supabase.rpc('pipeline_spend')); }
  catch { return null; }   // a missing function is a blank line, not a broken page
  if (error || !data || !data.length) return null;
  const s = data[0];
  return {
    scored: Number(s.scored || 0),
    usd: (Number(s.in_tokens || 0) / 1e6) * HAIKU_IN_PER_M
       + (Number(s.out_tokens || 0) / 1e6) * HAIKU_OUT_PER_M,
  };
}

// The coverage matrix: surviving clips per weather slice, split into what
// trains the model and what measures it (the golden holdout). This is the
// sourcing dashboard — a thin row is a condition the model hasn't been
// taught yet, and that row names the next filming day or channel to chase.
async function loadCoverage() {
  try {
    const { data, error } = await supabase.rpc('coverage_matrix');
    return error ? [] : (data || []);
  } catch { return []; }   // a missing function is a blank panel, not a broken page
}

async function loadClips() {
  const PAGE = 40;
  const { data, error } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,clip_start,clip_end,is_pair,label_status,roboflow_id,preview_path,poster_path,file_path,created_at')
    .eq('label_status', 'pending')
    .order('video_id').order('shot_ts')
    .range(clipPage * PAGE, clipPage * PAGE + PAGE - 1);
  if (error) return [];
  const rows = data || [];
  // Previews live in a private bucket; a signed URL is the only way a
  // browser can play one, and signing is itself gated by is_portal_owner().
  await signClipMedia(rows);
  await titleClips(rows);
  return rows;
}

// Previews and posters live in a private bucket; signed URLs are the only
// way a browser can fetch them, and signing is gated by is_portal_owner().
async function signClipMedia(rows) {
  const paths = rows.flatMap((k) => [k.preview_path, k.poster_path]).filter(Boolean);
  if (!paths.length) return;
  try {
    const { data: signed } = await supabase.storage.from('clips')
      .createSignedUrls(paths, 3600);
    const byPath = new Map((signed || []).map((x) => [x.path, x.signedUrl]));
    rows.forEach((k) => {
      k.preview_url = byPath.get(k.preview_path) || null;
      k.poster_url = byPath.get(k.poster_path) || null;
    });
  } catch { /* players fall back to the YouTube link */ }
}

async function titleClips(rows) {
  const vids = [...new Set(rows.map((k) => k.video_id))];
  if (!vids.length) return;
  const { data: tv } = await supabase.from('pipeline_videos')
    .select('video_id,title').in('video_id', vids);
  const titles = new Map((tv || []).map((v) => [v.video_id, v.title]));
  rows.forEach((k) => {
    k.title = titles.get(k.video_id) || k.video_id;
    k.shot_no = Number((k.file_path || '').match(/shot(\d+)/)?.[1] || 0);
  });
}

// The AI's queue and its output, for oversight: what is waiting to be boxed,
// what has been boxed, and how many clays it claims per clip.
async function loadAiClips() {
  const PAGE = 40;
  const { data, error } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,label_status,roboflow_id,preview_path,poster_path,file_path,outcome,outcome_conf,outcome_2,outcome_2_conf,outcome_3,outcome_3_conf,det_conf,range_m,speed_mph,created_at')
    .in('label_status', ['queued', 'prelabelled'])
    .order('created_at', { ascending: false })
    .range(aiPage * PAGE, aiPage * PAGE + PAGE - 1);
  if (error) return [];
  const rows = data || [];
  await Promise.all([signClipMedia(rows), titleClips(rows)]);
  const ids = rows.map((k) => k.clip_id);
  if (ids.length) {
    const { data: lab } = await supabase.from('pipeline_labels')
      .select('clip_id,n_clays').in('clip_id', ids);
    const byClip = new Map((lab || []).map((x) => [x.clip_id, x.n_clays]));
    rows.forEach((k) => { k.n_clays = byClip.get(k.clip_id); });
  }
  return rows;
}

async function loadSentClips() {
  // Only clips that have actually gone to the AI — a raw cut still waiting on
  // screening is not "sent", and listing it here read as a bug.
  const { data } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,label_status,roboflow_id,file_path')
    .in('label_status', ['queued', 'prelabelled'])
    .order('created_at', { ascending: false }).limit(8);
  const rows = data || [];
  await titleClips(rows);
  return rows;
}

// The machine's discards, for auditing: clips screening threw out as
// clayless. A wrong rejection is a training example lost silently, so the
// owner can watch each one and send any mistake back for re-screening.
async function loadRejectedClips() {
  const { data, error, count } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,clip_start,clip_end,preview_path,poster_path,file_path,created_at', { count: 'exact' })
    .eq('label_status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) return { rows: [], total: 0 };
  const rows = data || [];
  await Promise.all([signClipMedia(rows), titleClips(rows)]);
  return { rows, total: count ?? rows.length };
}

async function loadSheet() {
  let q = supabase.from('pipeline_videos')
    .select('video_id,title,channel,status,triage_score,duration_s,used,weather,updated_at')
    .order('updated_at', { ascending: false }).limit(150);
  if (sheetFilter !== 'all') q = q.eq('status', sheetFilter);
  const { data, error } = await q;
  state.sheetErr = error ? (error.message || String(error)) : '';
  if (error) return [];
  const rows = data || [];
  // clips cut / sent per video, computed fresh rather than stored
  try {
    const { data: cc } = await supabase.rpc('sheet_clip_counts');
    const byVid = new Map((cc || []).map((x) => [x.video_id, x]));
    rows.forEach((v) => {
      const x = byVid.get(v.video_id);
      v.clips = x ? Number(x.clips) : 0;
      v.sent = x ? Number(x.sent) : 0;
    });
  } catch { /* counts stay undefined; the sheet still lists */ }
  return rows;
}

const judged = new Set();   // survives a queue read that overtakes a decision

async function loadQueue() {
  const { data, error } = await supabase.from('pipeline_videos')
    .select('video_id,title,channel,url,duration_s,view_count,triage_score,triage_notes,updated_at')
    .eq('status', 'downloaded')
    .order('triage_score', { ascending: false })
    .limit(24);
  return error ? [] : (data || []).filter((v) => !judged.has(v.video_id));
}

/* ---------- running a stage ---------- */

let running = null;

async function runStage(stage, query = {}) {
  if (running) return;
  running = stage;
  note(`${stage} requested`);
  paint();
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const qs = new URLSearchParams(query).toString();
    const call = (path) => fetch(`${path}${qs ? `?${qs}` : ''}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session?.access_token || ''}` },
    });
    let res = await call(`/api/run/${stage}`);
    if (res.status === 404 || res.status === 405) res = await call(`/api/run/${stage}/`);
    // Read it as text first. A platform-level 404 is an HTML page, and
    // res.json() throwing on it is how "failed (404) — no detail" happened:
    // the one case where the body was the whole explanation.
    const text = await res.text().catch(() => '');
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { /* not ours */ }
    const plain = () => text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
    if (res.status === 202) {
      note(`${stage} is still running on Modal — the counts will catch up.`);
    } else if (res.ok) {
      const { stage: _s, ...rest } = body;
      const said = Object.entries(rest).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ');
      note(`${stage} finished${said ? ` — ${said}` : ''}`, 'good');
    } else {
      // error is the headline, detail is the way out — show both when present.
      const why = [body.error, body.detail].filter(Boolean).join(': ') || plain() || 'no detail';
      note(`${stage} failed (${res.status}) — ${why}`, 'bad');
    }
  } catch (e) {
    note(`${stage} could not be reached — ${e.message || e}`, 'bad');
  }
  running = null;
  if (dashboardIsCurrent()) await refresh();
}

/* ---------- shell ---------- */

const viewFromHash = () => ['review', 'sources', 'triage', 'labelling', 'mastersheet'].find((v) => location.hash === `#${v}`) || 'control';
let view = viewFromHash();
let state = { email: '', counts: null, queue: [], sources: [], issues: [], spend: null, coverage: [], clips: [], sent: [], rej: { rows: [], total: 0 }, ai: [], sheet: [], sheetErr: '', loading: true };
let sheetFilter = 'all';
let clipPage = 0;   // 40 clips a page, grouped by video
let aiPage = 0;
let batch = 10;   // videos per press — survives repaints, resets with the tab
let poll = null;

/* Every trip through route() bumps `epoch`. A dashboard load that was already
   in flight when the visitor signed out finishes against the old epoch, so it
   knows to stay quiet instead of repainting itself over the sign-in screen —
   and, worse, starting an 8s poll that route() could never have cleared,
   because the interval did not exist yet when route() ran. */
let epoch = 0;
let dashEpoch = -1;
const dashboardIsCurrent = () => dashEpoch === epoch;

function shell(body) {
  root.dataset.up = '1';
  const item = (hash, label, badge = 0) => `
    <a href="#${hash}" class="${view === hash ? 'on' : ''}">${label}
      ${badge ? `<b>${fmt(badge)}</b>` : ''}</a>`;
  root.innerHTML = `
    <div class="crm">
      <aside class="side">
        <a class="brand" href="../"><img src="../assets/brand/brace-wordmark-white.svg" alt="Brace" width="3579" height="732" /></a>
        <nav class="views">
          ${item('control', 'Home')}
          ${item('review', 'Review', state.counts?.downloaded)}
          ${item('sources', 'Sources')}
          ${item('triage', 'Triage', state.counts?.pending)}
          ${item('labelling', 'Labelling', state.counts?.queued)}
          ${item('mastersheet', 'Mastersheet')}
        </nav>
        <div class="side-foot">
          ${state.spend && state.spend.scored
    ? `<div class="side-line">${fmt(state.spend.scored)} scored · ~$${state.spend.usd.toFixed(2)}</div>` : ''}
          <div class="side-line who" title="${esc(state.email)}">${esc(state.email)}</div>
          <button class="signout" id="changepw">${ic('lock', 14)} Password</button>
          <button class="signout" id="signout">${ic('signout', 14)} Sign out</button>
        </div>
      </aside>
      <main>${body}</main>
    </div>`;
  document.getElementById('changepw').addEventListener('click', () => {
    clearInterval(poll);          // else the 8s refresh repaints over the form
    renderSetPassword('', true);
  });
  document.getElementById('signout').addEventListener('click', async () => {
    clearInterval(poll);
    sessionStorage.removeItem('brace-portal-pw');
    sessionStorage.removeItem('brace-portal-otp');
    // A failed global sign-out used to leave the dashboard sitting there as if
    // nothing had happened. Re-route either way: the local session is gone.
    try { await supabase.auth.signOut(); } catch { /* offline, or already out */ }
    boot();
  });
}

/* ---------- control ---------- */

function controlView() {
  const c = state.counts;
  const n = (k) => (c && c[k] != null ? fmt(c[k]) : '—');
  const live = (k) => (c && c[k] > 0 ? 'on' : 'off');

  const cardDefs = [
    ...STAGES.map((s) => ({ key: s.key, label: s.label, sub: s.note })),
    { key: 'rejected', label: 'Rejected', sub: 'triage said no' },
    { key: 'error', label: 'Errored', sub: 'needs a retry', warn: true },
  ];

  return `
    <div class="crm-head">
      <div>
        <h1>Pipeline</h1>
        <p>Third-party footage in, labelled clays out. Triage and everything after it run on Modal.</p>
      </div>
      ${c && c.error ? `<a href="#" id="retry" class="p-act warn">Send ${n('error')} errored back</a>` : ''}
    </div>

    <div class="stats">
      ${cardDefs.map((s) => `
        <div class="stat ${s.warn && c && c[s.key] ? 'stat-warn' : ''}">
          <span class="clay ${live(s.key)}"></span>
          <div class="num">${n(s.key)}</div>
          <div class="cap">${s.label}</div>
          <div class="sub">${s.sub}</div>
        </div>`).join('')}
    </div>

    <div class="tally">
      <span>${n('raw')} clips being screened for clays</span>
      <span>${n('pending')} clips awaiting your check</span>
      <span>${n('queued')} queued for AI labelling</span>
      <span>${n('prelabelled')} pre-labelled</span>
    </div>

    <div class="grid">
      <section class="panel">
        <div class="p-head"><span class="p-title">Run a stage</span>
          <span>
            <select id="batch" class="mini" title="How many videos one press works through — the cost dial">
              ${[3, 10, 25, 50].map((v) => `<option value="${v}" ${v === batch ? 'selected' : ''}>${v} at a time</option>`).join('')}
            </select>
            <a class="p-act" href="#" id="refresh" style="margin-left:10px">Refresh</a>
          </span></div>
        <div class="runs">
          ${RUNS.map((r) => `
            <div class="run">
              <button class="btn ${r.primary ? '' : 'btn-ghost'}" data-stage="${r.stage}"
                ${running ? 'disabled' : ''}>${running === r.stage ? `${r.busy}…` : r.label}</button>
              <p>${r.desc}</p>
            </div>`).join('')}
        </div>
        <p class="foot-note">Discover runs here and answers straight away. The other
           three need yt-dlp, ffmpeg and a GPU, so they run on Modal and can outlive
           the request: a button that comes back saying it is still running is Modal
           working, not a failure, and the counts above move as it goes. The batch
           size is the cost dial — small while trying things out, larger once a run
           is trusted.</p>
      </section>

      <section class="panel">
        <div class="p-head"><span class="p-title">Activity</span></div>
        ${log.length ? log.slice(0, 14).map((l, i) => `
          <div class="line ${l.tone} ${i === 0 ? 'fresh' : ''}">
            <span class="t">${l.t}</span><span class="m">${esc(l.line)}</span>
          </div>`).join('') : '<div class="empty">Nothing run this session yet.</div>'}
      </section>
    </div>

    ${coveragePanel()}

    ${state.issues && state.issues.length ? `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Issues — what went wrong, in the tool's own words</span></div>
      ${state.issues.map((v) => `
        <div class="row">
          <span class="dot off"></span>
          <div class="main">
            <div class="t">${esc(v.title || v.video_id)}</div>
            <div class="s" title="${esc(v.triage_notes || '')}">${esc(v.triage_notes || 'no detail recorded')}</div>
          </div>
          <div class="end">
            <button class="linky" data-requeue="${esc(v.video_id)}">Send back</button>
          </div>
        </div>`).join('')}
      <p class="foot-note">Send back returns a video to Discovered so the next triage
         run retries it. If the same words keep coming back, that is the fault to
         report, verbatim.</p>
    </section>` : ''}`;
}

// The scorecard behind the data strategy. Rows are condition slices, the two
// column pairs are the two jobs a clip can have: teaching the model, or
// measuring it. Roughly one video in seven is drawn into the golden holdout
// — whole videos, so frames from one flight never straddle the line — and
// its frames go to Roboflow's test split, which no training run can see.
const WEATHER_ORDER = ['clear', 'overcast', 'rain', 'fog', 'dusk', 'indoor', 'unknown'];

function coveragePanel() {
  const rows = state.coverage || [];
  if (!rows.length) return '';
  const by = new Map();
  rows.forEach((r) => {
    const w = r.weather || 'unknown';
    const c = by.get(w) || { train: 0, trainLab: 0, gold: 0, goldLab: 0 };
    if (r.golden) { c.gold += Number(r.clips); c.goldLab += Number(r.labelled); }
    else { c.train += Number(r.clips); c.trainLab += Number(r.labelled); }
    by.set(w, c);
  });
  const order = [...WEATHER_ORDER.filter((w) => by.has(w)),
    ...[...by.keys()].filter((w) => !WEATHER_ORDER.includes(w))];
  const tot = { train: 0, trainLab: 0, gold: 0, goldLab: 0 };
  order.forEach((w) => { const c = by.get(w); tot.train += c.train; tot.trainLab += c.trainLab; tot.gold += c.gold; tot.goldLab += c.goldLab; });
  return `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Coverage — what the model is taught, and what it is measured with</span></div>
      <table class="matrix">
        <thead><tr><th>Condition</th><th>Training clips</th><th>labelled</th>
          <th>Golden clips</th><th>verified</th></tr></thead>
        <tbody>
          ${order.map((w) => { const c = by.get(w); return `
          <tr><td>${esc(w)}</td>
            <td>${fmt(c.train)}</td><td class="dim">${fmt(c.trainLab)}</td>
            <td>${fmt(c.gold)}</td><td class="dim">${fmt(c.goldLab)}</td></tr>`; }).join('')}
          <tr class="matrix-tot"><td>all</td>
            <td>${fmt(tot.train)}</td><td class="dim">${fmt(tot.trainLab)}</td>
            <td>${fmt(tot.gold)}</td><td class="dim">${fmt(tot.goldLab)}</td></tr>
        </tbody>
      </table>
      <p class="foot-note">Golden clips are the held-out test set: about one video in
         seven, drawn whole so no flight ever sits on both sides of the line. Their
         frames land in Roboflow's <em>test</em> split, are never auto-accepted, and
         no training run can see them — so the accuracy Roboflow reports after each
         train is a real number, not the model marking its own homework. A thin row
         here is the next condition to go and source.</p>
    </section>`;
}

/* ---------- review ---------- */

function reviewView() {
  if (state.loading) return '<div class="empty">Loading the queue…</div>';
  const q = state.queue;
  return `
    <div class="page-head">
      <div class="over">Review queue</div>
      <h1>${q.length ? `${fmt(q.length)} ${q.length === 1 ? 'video' : 'videos'} waiting on you.` : 'Nothing waiting on you.'}</h1>
      <p>Triage has already thrown out the obvious misses. What is left is footage the
         model thinks is worth the GPU time. Approve it and the clipper cuts it into
         shots; reject it and it goes no further.</p>
    </div>
    ${q.length ? `<div class="queue">${q.map(card).join('')}</div>`
      : `<div class="panel"><div class="empty">The queue is clear. Run triage to bring
           more through, or discover to widen the net.</div></div>`}`;
}

function card(v) {
  const score = v.triage_score == null ? '—' : Number(v.triage_score).toFixed(1);
  // esc() stops the attribute being escaped out of, but it would happily keep a
  // javascript: scheme. Only http(s) is ever a video link.
  const href = /^https?:\/\//i.test(v.url || '')
    ? v.url : `https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}`;
  return `
    <article class="cardv" data-id="${esc(v.video_id)}">
      <a class="thumb" href="${esc(href)}" target="_blank" rel="noopener">
        <img src="https://i.ytimg.com/vi/${esc(v.video_id)}/mqdefault.jpg" alt="" loading="lazy"
             onerror="this.remove()" />
        <span class="dur">${mmss(v.duration_s)}</span>
      </a>
      <div class="body">
        <div class="score"><b>${score}</b><span>/10</span></div>
        <h2>${esc(v.title || v.video_id)}</h2>
        <div class="meta">${esc(v.channel || 'Unknown channel')}${v.view_count ? ` · ${fmt(v.view_count)} views` : ''}</div>
        ${v.triage_notes ? `<p class="notes">${esc(v.triage_notes)}</p>` : ''}
        <div class="judge">
          <button class="btn" data-act="approved">Approve</button>
          <button class="btn btn-ghost" data-act="rejected">Reject</button>
        </div>
      </div>
    </article>`;
}

async function judge(id, status, el) {
  el.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  const { data, error } = await supabase.from('pipeline_videos')
    .update({ status }).eq('video_id', id).select('video_id');
  const verb = status === 'approved' ? 'approve' : 'reject';
  if (error || !data || !data.length) {
    note(`could not ${verb} ${id} — ${error ? error.message : 'the database changed nothing'}`, 'bad');
    el.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    return;
  }
  note(`${id} ${status}`, status === 'approved' ? 'good' : '');
  judged.add(id);
  state.queue = state.queue.filter((v) => v.video_id !== id);
  el.classList.add('gone');
  setTimeout(() => { if (dashboardIsCurrent()) paint(); }, 220);
  loadCounts().then((c) => { state.counts = c; }).catch(() => { /* the poll will retry */ });
}


/* ---------- labelling ---------- */

// The clips are on Modal and the boxes land in Roboflow, so this page is the
// window between the two: what has been cut, what has been pushed, and the
// door to the human half of labelling.
const ROBOFLOW_ANNOTATE = 'https://app.roboflow.com/elohughes-icloud-com/brace-clay/annotate';

// Ticked clips survive the 8-second repaint because the selection lives here,
// not in the DOM the repaint replaces.
const picked = new Set();

function triageClipsView() {
  if (state.loading) return '<div class="empty">Loading clips…</div>';
  const c = state.counts || {};
  const PAGE = 40;
  const totalPending = c.pending ?? 0;
  const pages = Math.max(1, Math.ceil(totalPending / PAGE));
  const pending = state.clips;

  const yt = (k) => `https://www.youtube.com/watch?v=${encodeURIComponent(k.video_id)}&t=${Math.max(0, Math.floor(k.shot_ts || 0))}s`;
  // Every clip is the same card whether its preview exists yet or not: the
  // media box keeps its 16:9 shape and the grid never staggers. A rendered
  // preview plays in place; a poster-only clip shows its still with a badge;
  // a brand-new cut holds the space with a note.
  const pendingCard = (k) => `
    <div class="clipcard">
      <div class="clipmedia">
        <label class="clippick" title="Pick this clip">
          <input type="checkbox" class="tick" data-pick="${esc(k.clip_id)}" ${picked.has(k.clip_id) ? 'checked' : ''} />
        </label>
        ${k.preview_url
    ? `<video controls preload="metadata" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>`
    : k.poster_url
      ? `<img src="${esc(k.poster_url)}" alt="" /><span class="rendering badge">rendering…</span>`
      : '<span class="rendering">Preview rendering — plays here within the hour</span>'}
      </div>
      <div class="clipcap">
        <div class="t">Shot ${k.shot_no || '?'} · ${mmss(k.shot_ts)}
          · <a href="${esc(yt(k))}" target="_blank" rel="noopener">source ↗</a></div>
        <div class="s">clip ${mmss(k.clip_start)}–${mmss(k.clip_end)}${k.is_pair ? ' · pair' : ''}</div>
      </div>
    </div>`;

  // One heading per video, its clips beneath it — the page is already
  // ordered that way, so a heading appears wherever the video changes.
  let lastVid = null;
  const grouped = pending.map((k) => {
    const head = k.video_id !== lastVid
      ? `<div class="grouphead">${esc(k.title || k.video_id)}</div>` : '';
    lastVid = k.video_id;
    return head + pendingCard(k);
  }).join('');

  const doneRow = (k) => `
    <div class="row">
      <span class="dot ${k.label_status === 'prelabelled' ? 'on' : ''}"></span>
      <div class="main">
        <div class="t">${esc(k.title || k.video_id)}${k.shot_no ? ` — shot ${k.shot_no}` : ''} · ${mmss(k.shot_ts)}</div>
        <div class="s">${k.label_status === 'queued' ? 'queued — boxed within the hour' : 'pre-labelled'}${k.roboflow_id ? ' · in Roboflow' : ''}</div>
      </div>
    </div>`;

  return `
    <div class="crm-head">
      <div>
        <h1>Triage</h1>
        <p>Watch each cut, tick the good ones, and send them to the AI labeller.
           It boxes the clays and pushes the frames to Roboflow — confident
           frames to <b>auto-accepted</b>, shaky ones to <b>needs-review</b>.</p>
      </div>
      <a class="p-act" href="${ROBOFLOW_ANNOTATE}" target="_blank" rel="noopener">Open Roboflow ↗</a>
    </div>

    <div class="stats">
      <div class="stat"><span class="clay ${c.pending ? 'on' : 'off'}"></span>
        <div class="num">${fmt(c.pending ?? 0)}</div>
        <div class="cap">Awaiting your check</div><div class="sub">clay-verified, trimmed to flight</div></div>
      <div class="stat"><span class="clay ${c.queued ? 'on' : 'off'}"></span>
        <div class="num">${fmt(c.queued ?? 0)}</div>
        <div class="cap">Queued for AI</div><div class="sub">boxed within the hour</div></div>
      <div class="stat"><span class="clay ${c.prelabelled ? 'on' : 'off'}"></span>
        <div class="num">${fmt(c.prelabelled ?? 0)}</div>
        <div class="cap">Pre-labelled</div><div class="sub">boxed, in Roboflow</div></div>
    </div>

    <section class="panel">
      <div class="p-head"><span class="p-title">Clips to check${totalPending ? ` — ${fmt(totalPending)}` : ''}</span>
        <span>
          <button class="linky" id="pickall">Select all shown</button>
          <button class="linky" id="picknone" style="margin-left:10px">Clear</button>
          <button class="btn mini-btn" id="sendsel" style="margin-left:14px"
            ${picked.size ? '' : 'disabled'}>Send <span id="pickn">${picked.size}</span> to AI</button>
          <button class="btn btn-ghost mini-btn" id="sendall" style="margin-left:8px"
            ${totalPending ? '' : 'disabled'}>Send all ${fmt(totalPending)}</button>
        </span></div>
      ${grouped ? `<div class="clipgrid">${grouped}</div>`
    : '<div class="empty">Nothing waiting. Approve videos in Review and the clipper feeds this list within the hour.</div>'}
      ${pages > 1 ? `
      <div class="pager">
        <button class="linky" id="clipprev" ${clipPage ? '' : 'disabled'}>‹ Previous</button>
        <span>page ${clipPage + 1} of ${pages}</span>
        <button class="linky" id="clipnext" ${clipPage + 1 < pages ? '' : 'disabled'}>Next ›</button>
      </div>` : ''}
    </section>

    ${state.sent.length ? `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Recently sent</span></div>
      ${state.sent.map(doneRow).join('')}
    </section>` : ''}

    ${state.rej && state.rej.total ? `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Rejected by screening — ${fmt(state.rej.total)} discard${state.rej.total === 1 ? '' : 's'}, newest first</span></div>
      <div class="clipgrid">
        ${state.rej.rows.map((k) => `
        <div class="clipcard">
          <div class="clipmedia">
            ${k.preview_url
    ? `<video controls preload="metadata" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>`
    : k.poster_url
      ? `<img src="${esc(k.poster_url)}" alt="" />`
      : '<span class="rendering">Preview rendering — plays here within the hour</span>'}
          </div>
          <div class="clipcap">
            <div class="t">${esc(k.title || k.video_id)}${k.shot_no ? ` — shot ${k.shot_no}` : ''}</div>
            <div class="s">screening saw no clay ·
              <a href="#" class="linky" data-unreject="${esc(k.clip_id)}">not junk — send back</a></div>
          </div>
        </div>`).join('')}
      </div>
      <p class="foot-note">The machine's discards, for your audit. Screening rejects a
         cut when the detector finds no clay in any frame — watch a few: if a real
         clay is in there, "send back" returns it for re-screening, and tell the
         machine's keeper, because a silent wrong rejection is a training example
         lost. Only the newest twelve show; the count above is the full pile.</p>
    </section>` : ''}`;
}

function labellingView() {
  if (state.loading) return '<div class="empty">Loading…</div>';
  const c = state.counts || {};
  const PAGE = 40;
  const total = (c.queued ?? 0) + (c.prelabelled ?? 0);
  const pages = Math.max(1, Math.ceil(total / PAGE));

  // Clip on the left, the shooter's instrument panel on the right: the
  // verdict with its confidence, how sure the detector was of the clay it
  // tracked, and — for hits, where the bang-to-break clock can tick — the
  // estimated crossing speed and distance at impact.
  const metric = (label, value, cls = '') => `
    <div class="metric"><span class="k">${label}</span>
      <span class="v ${cls}">${value}</span></div>`;
  const row = (k) => {
    const vc = (o) => (o === 'hit' ? 'v-hit' : o === 'miss' ? 'v-miss' : '');
    const show = (o, c) => `${esc(o)}${c != null ? ` · ${Math.round(c * 100)}%` : ''}`;
    const panel = [
      // A burst is several shots, so it wears a verdict per clay.
      metric(k.outcome_2 ? 'First clay' : 'Verdict',
        k.outcome ? show(k.outcome, k.outcome_conf) : '—', vc(k.outcome)),
      k.outcome_2 ? metric('Second clay', show(k.outcome_2, k.outcome_2_conf), vc(k.outcome_2)) : '',
      k.outcome_3 ? metric('Third clay', show(k.outcome_3, k.outcome_3_conf), vc(k.outcome_3)) : '',
      metric('Clay detection', k.det_conf != null ? `${Math.round(k.det_conf * 100)}%` : '—'),
      // Speed and distance come from the bang-to-break clock, which only a
      // hit can stop — a miss flies on, so there is nothing to time. A hit
      // without numbers means the clock itself was untrustworthy: the
      // stored track was too noisy to pin the moment of the break.
      metric('Speed', k.speed_mph != null ? `~${fmt(k.speed_mph)} mph`
        : k.outcome === 'miss' ? '<span class="na">n/a on a miss</span>'
        : k.outcome === 'hit' ? '<span class="na">track too noisy</span>' : '—'),
      metric('Distance', k.range_m != null ? `~${k.range_m} m`
        : k.outcome === 'miss' ? '<span class="na">n/a on a miss</span>'
        : k.outcome === 'hit' ? '<span class="na">track too noisy</span>' : '—'),
    ].join('');
    return `
    <div class="row cliprow">
      <span class="dot ${k.label_status === 'prelabelled' ? 'on' : ''}" style="margin-top:8px"></span>
      <div class="aiwrap">
        <div class="aileft">
          ${k.preview_url
    ? `<video class="clipvid" controls preload="none" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>` : ''}
          <div class="t">${esc(k.title || k.video_id)}${k.shot_no ? ` — shot ${k.shot_no}` : ''}</div>
          <div class="s">${k.label_status === 'queued'
    ? 'queued — the AI boxes it within the hour'
    : `pre-labelled${k.n_clays != null ? ` · ${fmt(k.n_clays)} clay${k.n_clays === 1 ? '' : 's'} boxed` : ''} · frames in Roboflow`}</div>
        </div>
        <div class="aimetrics">${panel}</div>
      </div>
    </div>`;
  };

  return `
    <div class="crm-head">
      <div>
        <h1>Labelling</h1>
        <p>The AI's queue and its output. Queued clips get boxed on the next
           heartbeat; pre-labelled ones are in Roboflow — confident frames under
           <b>auto-accepted</b>, shaky ones under <b>needs-review</b>, where the
           final human check happens.</p>
      </div>
      <a class="p-act" href="${ROBOFLOW_ANNOTATE}" target="_blank" rel="noopener">Open Roboflow ↗</a>
    </div>

    <div class="stats">
      <div class="stat"><span class="clay ${c.queued ? 'on' : 'off'}"></span>
        <div class="num">${fmt(c.queued ?? 0)}</div>
        <div class="cap">Queued for AI</div><div class="sub">boxed within the hour</div></div>
      <div class="stat"><span class="clay ${c.prelabelled ? 'on' : 'off'}"></span>
        <div class="num">${fmt(c.prelabelled ?? 0)}</div>
        <div class="cap">Pre-labelled</div><div class="sub">boxed, in Roboflow</div></div>
    </div>

    <section class="panel">
      <div class="p-head"><span class="p-title">${fmt(total)} clips with the AI</span></div>
      ${state.ai.length ? state.ai.map(row).join('')
    : '<div class="empty">Nothing here yet — send clips from the Triage page and they appear the moment they are queued.</div>'}
      ${pages > 1 ? `
      <div class="pager">
        <button class="linky" id="aiprev" ${aiPage ? '' : 'disabled'}>‹ Previous</button>
        <span>page ${aiPage + 1} of ${pages}</span>
        <button class="linky" id="ainext" ${aiPage + 1 < pages ? '' : 'disabled'}>Next ›</button>
      </div>` : ''}
    </section>`;
}

async function queueClips(ids, btn) {
  if (!ids.length) return;
  if (btn) busy(btn, true, 'Sending…');
  const { error } = await supabase.from('pipeline_clips')
    .update({ label_status: 'queued' }).in('clip_id', ids).select('clip_id');
  if (error) note(`could not queue clips — ${error.message}`, 'bad');
  else {
    note(`${ids.length} clip${ids.length === 1 ? '' : 's'} queued for AI labelling`, 'good');
    ids.forEach((id) => picked.delete(id));
  }
  await refresh();
}

/* ---------- mastersheet ---------- */

// Every video the machine has ever touched, in one ledger. Its other job is
// reassurance: discover writes with ignore-duplicates against this sheet, so
// nothing on it is ever fetched, scored or clipped twice.
const SHEET_FILTERS = [
  ['all', 'All'], ['downloaded', 'Triaged'], ['approved', 'Approved'],
  ['clipped', 'Clipped'], ['rejected', 'Rejected'], ['discovered', 'Discovered'],
];
const SHEET_TONE = { clipped: 'on', approved: 'on', downloaded: 'on' };

function mastersheetView() {
  if (state.loading) return '<div class="empty">Loading the sheet…</div>';
  const c = state.counts || {};
  const row = (v) => `
    <div class="row">
      <label class="pickside" title="Mark as used">
        <input type="checkbox" class="tick" data-used="${esc(v.video_id)}" ${v.used ? 'checked' : ''} />
      </label>
      <div class="main">
        <div class="t"><a href="https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}"
          target="_blank" rel="noopener">${esc(v.title || v.video_id)}</a></div>
        <div class="s">${esc(v.channel || '')} · ${esc(v.status)}${v.triage_score != null
    ? ` · scored ${Number(v.triage_score).toFixed(1)}` : ''}${v.weather && v.weather !== 'unknown'
    ? ` · ${esc(v.weather)}` : ''} · ${mmss(v.duration_s)} · ${dateFmt(v.updated_at)}</div>
      </div>
      <div class="end">
        ${v.clips ? `<span class="s">${fmt(v.clips)} clips · ${fmt(v.sent)} sent</span>` : ''}
      </div>
    </div>`;

  return `
    <div class="crm-head">
      <div>
        <h1>Mastersheet</h1>
        <p>Every video the pipeline has touched, and what became of it. Discover
           checks this sheet before writing, so nothing on it is ever collected,
           scored or clipped twice.</p>
      </div>
    </div>

    <div class="tally">
      ${SHEET_FILTERS.map(([k, label]) => `
        <a href="#" class="p-act ${sheetFilter === k ? 'chip-on' : ''}" data-msf="${k}">${label}${k !== 'all' && c[k] != null ? ` ${fmt(c[k])}` : ''}</a>`).join('')}
    </div>

    ${state.sheetErr ? `<div class="err" style="margin-bottom:14px">The sheet could not load: ${esc(state.sheetErr)}</div>` : ''}
    <section class="panel">
      <div class="p-head"><span class="p-title">${sheetFilter === 'all' ? 'Most recent'
    : (SHEET_FILTERS.find(([k]) => k === sheetFilter) || ['', sheetFilter])[1]} — ${fmt(state.sheet.length)} shown</span></div>
      ${state.sheet.length ? state.sheet.map(row).join('')
    : '<div class="empty">Nothing with that status yet.</div>'}
    </section>`;
}

/* ---------- sources ---------- */

const KINDS = [
  { k: 'channel', label: 'Channel', hint: '@handle, channel URL, or UC… id' },
  { k: 'query', label: 'Search phrase', hint: 'e.g. sporting clays first person' },
  { k: 'video', label: 'One video', hint: 'a YouTube URL or video id' },
];
const PERMISSION = {
  unknown: 'Not asked', requested: 'Asked', granted: 'Given', declined: 'Refused',
};

function sourcesView() {
  const list = state.sources;
  const of = (k) => list.filter((x) => x.kind === k);
  const cost = list.filter((x) => x.enabled && x.kind === 'query').length * 100
    + list.filter((x) => x.enabled && x.kind !== 'query').length;

  const row = (x) => `
    <div class="row src ${x.enabled ? '' : 'off'}" data-src="${esc(x.id)}">
      <span class="dot ${x.enabled ? 'on' : 'off'}"></span>
      <div class="main">
        <div class="t">${esc(x.label || x.ref)}</div>
        <div class="s">${esc(x.ref)}${x.last_found != null ? ` · found ${fmt(x.last_found)} last run` : ''}</div>
      </div>
      <div class="end">
        <span class="perm perm-${esc(x.permission)}">${esc(PERMISSION[x.permission] || x.permission)}</span>
        <button class="linky" data-toggle="${esc(x.id)}">${x.enabled ? 'Mute' : 'Use'}</button>
        <button class="linky bad" data-drop="${esc(x.id)}">Remove</button>
      </div>
    </div>`;

  const group = (k, title, blurb) => `
    <section class="panel">
      <div class="p-head"><span class="p-title">${title}</span></div>
      <p class="foot-note" style="margin:0 0 14px;padding:0;border:0">${blurb}</p>
      ${of(k).map(row).join('') || '<div class="empty">None yet.</div>'}
    </section>`;

  return `
    <div class="page-head">
      <div class="over">Sources</div>
      <h1>Where the footage <em>comes from</em>.</h1>
      <p>Search phrases find things you did not know about. Channels are shooters
         you already trust, and cost a hundredth of the quota — one unit per fifty
         videos against a hundred per search. Naming a channel is also how you
         keep track of who you have asked permission from.</p>
    </div>

    <div class="tally">
      <span>${fmt(list.filter((x) => x.enabled).length)} in use of ${fmt(list.length)}</span>
      <span>about ${fmt(cost)} of 10,000 daily quota units a run</span>
    </div>

    <div class="grid">
      <div class="stack">
        ${group('channel', 'Channels', 'A whole back catalogue for one unit per fifty videos. The cheapest and best-aimed way to find footage.')}
        ${group('query', 'Search phrases', 'A hundred units each. Good for finding shooters you have never heard of; noisy by nature.')}
        ${group('video', 'Single videos', 'One-offs you have found by hand.')}
      </div>

      <section class="panel">
        <div class="p-head"><span class="p-title">Add a source</span></div>
        <form id="addsrc">
          <div class="field">
            <select id="s-kind">
              ${KINDS.map((k) => `<option value="${k.k}">${k.label}</option>`).join('')}
            </select>
          </div>
          <div class="field"><input id="s-ref" placeholder="@handle, URL, or phrase" required /></div>
          <div class="field"><input id="s-label" placeholder="What to call it (optional)" /></div>
          <div class="field">
            <select id="s-perm">
              ${Object.entries(PERMISSION).map(([v, l]) => `<option value="${v}">Permission: ${l}</option>`).join('')}
            </select>
          </div>
          <div class="err" id="err"></div>
          <button class="btn" type="submit">Add</button>
        </form>
        <p class="foot-note">Discover runs every source that is in use. Muting one
           keeps it on the list without searching it.</p>

        <div class="p-head" style="margin-top:22px"><span class="p-title">Paste a list</span></div>
        <form id="bulksrc">
          <div class="field"><textarea id="s-bulk" rows="6"
            placeholder="One per line — @handles and channel URLs become channels, video links become videos, anything else becomes a search phrase."></textarea></div>
          <div class="err" id="bulkerr"></div>
          <button class="btn btn-ghost" type="submit">Add the lot</button>
        </form>
      </section>
    </div>`;
}

// One pasted line → what kind of source it is. Guessing here is fine:
// every guess is visible as a row and correctable with Remove.
function classifySource(line) {
  const s = line.trim();
  if (!s) return null;
  if (/^@[\w.-]+$/.test(s)) return { kind: 'channel', ref: s };
  if (/youtu\.be\/|[?&]v=/.test(s)) return { kind: 'video', ref: s };
  if (/youtube\.com\/(channel\/|@)/.test(s) || /\bUC[0-9A-Za-z_-]{22}\b/.test(s)) {
    return { kind: 'channel', ref: s };
  }
  return { kind: 'query', ref: s };
}

async function addBulkSources(e) {
  e.preventDefault();
  const btn = e.target.querySelector('.btn');
  const box = document.getElementById('s-bulk');
  const err = document.getElementById('bulkerr');
  const have = new Set(state.sources.map((x) => x.ref.toLowerCase()));
  const rows = box.value.split('\n').map(classifySource).filter(Boolean)
    .filter((r) => !have.has(r.ref.toLowerCase()))
    .map((r) => ({ ...r, permission: 'unknown' }));
  if (!rows.length) { err.textContent = 'Nothing new on those lines.'; return; }
  busy(btn, true, 'Adding…'); err.textContent = '';
  const { error } = await supabase.from('pipeline_sources').insert(rows);
  busy(btn, false, 'Add the lot');
  if (error) { err.textContent = error.message; return; }
  note(`added ${rows.length} sources from the list`, 'good');
  box.value = '';
  state.sources = await loadSources();
  paint(true);
}

async function addSource(e) {
  e.preventDefault();
  const btn = e.target.querySelector('.btn');
  const kind = document.getElementById('s-kind').value;
  const ref = document.getElementById('s-ref').value.trim();
  const label = document.getElementById('s-label').value.trim();
  const permission = document.getElementById('s-perm').value;
  if (!ref) return;
  busy(btn, true, 'Adding…'); setErr('');
  const { error } = await supabase.from('pipeline_sources')
    .insert({ kind, ref, label: label || null, permission });
  busy(btn, false, 'Add');
  if (error) return setErr(error.message);
  note(`added ${kind} ${label || ref}`, 'good');
  state.sources = await loadSources();
  paint(true);
}

async function setSourceEnabled(id, enabled) {
  const { error } = await supabase.from('pipeline_sources')
    .update({ enabled }).eq('id', id).select('id');
  if (error) return note(`could not change that source — ${error.message}`, 'bad');
  state.sources = await loadSources();
  paint(true);
}

async function dropSource(id) {
  const { error } = await supabase.from('pipeline_sources').delete().eq('id', id);
  if (error) return note(`could not remove that source — ${error.message}`, 'bad');
  state.sources = state.sources.filter((x) => x.id !== id);
  paint(true);
}

/* ---------- paint + poll ---------- */

// What is on screen, as a string. If a poll tick would draw the same thing,
// don't draw it at all: rebuilding root every eight seconds resets keyboard
// focus and swallows any click whose mousedown landed just before the repaint.
function signature() {
  // Everything a repaint could visibly change must be in here: paint() skips
  // redraws when the signature matches, so a state change this list misses is
  // a click that "does nothing" — the pager bug, once.
  return JSON.stringify([
    view, state.email, state.loading, running, state.counts,
    state.queue.map((v) => v.video_id), log.length, log[0]?.line,
    state.sources.map((x) => `${x.id}${x.enabled}${x.last_found}`),
    clipPage, aiPage, sheetFilter,
    state.clips.map((k) => k.clip_id + (k.preview_url ? 'v' : '')),
    (state.rej?.rows || []).map((k) => k.clip_id + (k.preview_url ? 'v' : '')),
    state.rej?.total,
    state.ai.map((k) => k.clip_id + k.label_status + (k.preview_url ? 'v' : '')
      + (k.outcome || '') + (k.outcome_2 || '') + (k.outcome_3 || '')
      + (k.speed_mph ?? '') + (k.range_m ?? '')),
    state.sheet.map((v) => v.video_id + v.status + (v.used ? 'u' : '')),
    state.coverage,
  ]);
}
let painted = '';

// When a repaint really is needed, focus survives it by name, not by node.
function focusKey() {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return null;
  if (a.id) return `#${a.id}`;
  if (a.dataset.stage) return `[data-stage="${a.dataset.stage}"]`;
  const card = a.closest && a.closest('.cardv');
  if (card && a.dataset.act) {
    return `.cardv[data-id="${CSS.escape(card.dataset.id)}"] [data-act="${a.dataset.act}"]`;
  }
  return null;
}

function paint(force = false) {
  // Never redraw over someone who is typing — the poll would eat a half-filled
  // form, and the sources panel is a form.
  const a = document.activeElement;
  if (!force && a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;

  const sig = signature();
  if (!force && sig === painted && root.dataset.up) return;
  painted = sig;
  const refocus = focusKey();

  shell(view === 'review' ? reviewView()
    : view === 'sources' ? sourcesView()
    : view === 'triage' ? triageClipsView()
    : view === 'labelling' ? labellingView()
    : view === 'mastersheet' ? mastersheetView()
    : controlView());

  document.querySelectorAll('.views a').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    location.hash = a.getAttribute('href');
  }));

  document.getElementById('refresh')?.addEventListener('click', (e) => { e.preventDefault(); refresh(); });
  document.getElementById('retry')?.addEventListener('click', async (e) => {
    e.preventDefault();
    const { data, error } = await supabase.from('pipeline_videos')
      .update({ status: 'discovered', local_path: null })
      .eq('status', 'error').select('video_id');
    note(error ? `could not requeue — ${error.message}` : `${data.length} sent back to discovered`,
      error ? 'bad' : 'good');
    refresh();
  });
  document.getElementById('batch')?.addEventListener('change', (e) => {
    batch = Number(e.target.value) || 10;
  });
  document.querySelectorAll('[data-stage]').forEach((b) =>
    b.addEventListener('click', () =>
      runStage(b.dataset.stage, b.dataset.stage === 'discover' ? {} : { limit: batch })));
  document.querySelectorAll('[data-requeue]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const { error } = await supabase.from('pipeline_videos')
        .update({ status: 'discovered', local_path: null })
        .eq('video_id', b.dataset.requeue).select('video_id');
      note(error ? `could not send ${b.dataset.requeue} back — ${error.message}`
        : `${b.dataset.requeue} sent back to discovered`, error ? 'bad' : 'good');
      refresh();
    }));
  document.querySelectorAll('.cardv').forEach((el) =>
    el.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => judge(el.dataset.id, b.dataset.act, el))));

  document.querySelectorAll('[data-pick]').forEach((cb) => cb.addEventListener('change', () => {
    cb.checked ? picked.add(cb.dataset.pick) : picked.delete(cb.dataset.pick);
    const n = document.getElementById('pickn');
    if (n) n.textContent = picked.size;
    const send = document.getElementById('sendsel');
    if (send) send.disabled = !picked.size;
  }));
  // Page flips show the loading state immediately — the fetch takes a beat,
  // and a button that answers half a second later reads as broken.
  const flip = (set) => { set(); state.loading = true; paint(true); refresh(); };
  document.getElementById('aiprev')?.addEventListener('click', () => {
    flip(() => { aiPage = Math.max(0, aiPage - 1); });
  });
  document.getElementById('ainext')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil(((state.counts?.queued ?? 0) + (state.counts?.prelabelled ?? 0)) / 40));
    flip(() => { aiPage = Math.min(aiPage + 1, pages - 1); });
  });
  document.getElementById('clipprev')?.addEventListener('click', () => {
    flip(() => { clipPage = Math.max(0, clipPage - 1); });
  });
  document.getElementById('clipnext')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil((state.counts?.pending ?? 0) / 40));
    flip(() => { clipPage = Math.min(clipPage + 1, pages - 1); });
  });
  document.querySelectorAll('[data-unreject]').forEach((b) =>
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      const { error } = await supabase.from('pipeline_clips')
        .update({ label_status: 'raw' }).eq('clip_id', b.dataset.unreject).select('clip_id');
      note(error ? `could not send the clip back — ${error.message}`
        : 'sent back — the next screening beat re-examines it', error ? 'bad' : 'good');
      refresh();
    }));
  document.getElementById('pickall')?.addEventListener('click', () => {
    document.querySelectorAll('[data-pick]').forEach((cb) => { cb.checked = true; picked.add(cb.dataset.pick); });
    paint(true);
  });
  document.getElementById('picknone')?.addEventListener('click', () => {
    picked.clear(); paint(true);
  });
  document.getElementById('sendsel')?.addEventListener('click', (e) =>
    queueClips([...picked], e.target));
  document.getElementById('sendall')?.addEventListener('click', async (e) => {
    // every pending clip, not just the page shown
    busy(e.target, true, 'Sending…');
    const { data, error } = await supabase.from('pipeline_clips')
      .select('clip_id').eq('label_status', 'pending').limit(1000);
    if (error) { note(`could not list pending clips — ${error.message}`, 'bad'); return refresh(); }
    await queueClips((data || []).map((r) => r.clip_id));
  });

  document.querySelectorAll('[data-used]').forEach((cb) => cb.addEventListener('change', async () => {
    const { error } = await supabase.from('pipeline_videos')
      .update({ used: cb.checked }).eq('video_id', cb.dataset.used).select('video_id');
    if (error) { note(`could not mark used — ${error.message}`, 'bad'); cb.checked = !cb.checked; }
  }));
  document.querySelectorAll('[data-msf]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    sheetFilter = a.dataset.msf;
    refresh();
  }));

  document.getElementById('addsrc')?.addEventListener('submit', addSource);
  document.getElementById('bulksrc')?.addEventListener('submit', addBulkSources);
  document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () =>
    setSourceEnabled(b.dataset.toggle, !state.sources.find((x) => x.id === b.dataset.toggle)?.enabled)));
  document.querySelectorAll('[data-drop]').forEach((b) => b.addEventListener('click', () =>
    dropSource(b.dataset.drop)));

  if (refocus) { try { root.querySelector(refocus)?.focus(); } catch { /* gone */ } }
}

async function refresh() {
  // This runs on a timer, so a rejection here would be an unhandled one every
  // eight seconds. Report it in the activity log and keep the page alive.
  try {
    const [counts, queue, sources, issues, spend, coverage, clips, sent, rej, ai, sheet] = await Promise.all([
      loadCounts(),
      view === 'review' ? loadQueue() : Promise.resolve(state.queue),
      view === 'sources' ? loadSources() : Promise.resolve(state.sources),
      view === 'control' ? loadIssues() : Promise.resolve(state.issues),
      view === 'control' ? loadSpend() : Promise.resolve(state.spend),
      view === 'control' ? loadCoverage() : Promise.resolve(state.coverage),
      view === 'triage' ? loadClips() : Promise.resolve(state.clips),
      view === 'triage' ? loadSentClips() : Promise.resolve(state.sent),
      view === 'triage' ? loadRejectedClips() : Promise.resolve(state.rej),
      view === 'labelling' ? loadAiClips() : Promise.resolve(state.ai),
      view === 'mastersheet' ? loadSheet() : Promise.resolve(state.sheet),
    ]);
    state.counts = counts;
    state.queue = queue;
    state.sources = sources;
    state.issues = issues;
    state.spend = spend;
    state.coverage = coverage;
    state.clips = clips;
    state.sent = sent;
    state.rej = rej;
    state.ai = ai;
    state.sheet = sheet;
  } catch (e) {
    note(`could not read the pipeline — ${e.message || e}`, 'bad');
  }
  state.loading = false;
  if (!dashboardIsCurrent()) return;   // signed out while this was in flight
  paint();
}

window.addEventListener('hashchange', () => {
  if (!dashboardIsCurrent()) return;   // the hash means nothing behind the gate
  const next = viewFromHash();
  if (next === view) return;
  view = next;
  state.loading = view !== 'control';
  paint();
  refresh();
});

async function renderDashboard(email) {
  const mine = epoch;
  state = { email, counts: null, queue: [], sources: [], issues: [], spend: null, coverage: [], clips: [], sent: [], rej: { rows: [], total: 0 }, ai: [], sheet: [], sheetErr: '', loading: true };
  dashEpoch = mine;
  paint(true);        // a gate screen may be up; never skip the first draw
  await refresh();
  if (mine !== epoch) return;          // route() moved on; do not start a poll
  clearInterval(poll);
  // Stages take minutes, so eight seconds is plenty to feel live without
  // hammering the database.
  poll = setInterval(() => {
    if (mine !== epoch) return clearInterval(poll);
    if (!document.hidden) refresh();
  }, 8000);
}

/* ---------- boot ---------- */
// One place decides what the visitor sees, and it always asks the database
// last. Order: signed in? → on the owners list? → password set? → factor
// enrolled? → factor verified this session? → the floor.

let booting = false;
let rebootWanted = false;
let routedToken = null;   // the session route() last decided on

async function boot() {
  // getSession + onAuthStateChange both fire on load; without this guard the
  // enrolment screen renders twice and mints two competing secrets. But a
  // request that arrives mid-route is not noise — a SIGNED_OUT during a slow
  // enrolment used to be dropped, leaving the old screen up. Remember it and
  // route again once the current pass finishes.
  if (booting) { rebootWanted = true; return; }
  booting = true;
  try {
    await route();
  } catch (e) {
    // route() makes five network calls. Any of them rejecting used to leave the
    // loading spinner up for ever with nothing on screen to explain it.
    renderBroken('Something failed while working out who you are.', e);
  } finally {
    booting = false;
  }
  if (!rebootWanted) return;
  rebootWanted = false;
  // Decide here, not when the event arrived: auth-js replays the stored session
  // as SIGNED_IN while the first route() is still inside getSession(), so at
  // that moment nothing yet knows which session is being handled. Ask now, and
  // only go round again if it is genuinely a different one.
  let current = null;
  try { current = (await supabase.auth.getSession()).data?.session?.access_token || null; } catch { /* treat as changed */ }
  if (current !== routedToken) await boot();
}

async function route() {
  // Any route away from the dashboard should stop it polling, and should
  // invalidate a dashboard load that has not finished yet.
  epoch += 1;
  clearInterval(poll);
  poll = null;

  // Not `const { data: { session } }` — getSession resolves with data:null on
  // some failures, and destructuring through it throws before anything renders.
  stage('reading your session');
  let got;
  try {
    got = await within(supabase.auth.getSession(), 12, 'Reading your session');
  } catch (e) {
    // A stored session that cannot even be read is not a session. Clear it and
    // reload into a clean client rather than showing a wall: the hung call may
    // still be holding the lock, so signing in on this page would hang too.
    // Once per tab, so a persistent fault cannot become a reload loop.
    if (!sessionStorage.getItem('brace-portal-recovered')) {
      sessionStorage.setItem('brace-portal-recovered', '1');
      forgetStoredSession();
      return location.replace(location.pathname);
    }
    throw e;
  }
  if (got.error) return renderBroken('Could not read your session.', got.error);
  const session = got.data?.session;
  routedToken = session?.access_token || null;
  if (!session) return renderSignIn();

  const email = session.user?.email || '';

  // Is this email an owner at all? (email-only check, so we can route properly)
  // An error here is not the same as "not an owner": treating a dropped request
  // as a refusal told legitimate owners they were off the list.
  stage('checking the owners list');
  const ownerEmail = await within(supabase.rpc('is_portal_owner_email'), 15, 'The owners list check');
  if (ownerEmail.error) return renderBroken('Could not check the owners list.', ownerEmail.error);
  if (!ownerEmail.data) return renderDenied(email);

  stage('checking your sign-in method');
  const { data: aal } = await within(supabase.auth.mfa.getAuthenticatorAssuranceLevel(), 12, 'Reading your assurance level');

  // Was a password actually typed for *this* session? Ask the session, not the
  // browser: the token's amr claim is the record of how it was authenticated.
  // (A sessionStorage flag can't answer this — it is per-tab, so a returning
  // owner opening the portal in a new tab looked like a first run.)
  // The link route is the only one that lands here without a password, and its
  // one purpose is setting a first one. Routing only — the database is what
  // actually grants access.
  if (!authMethods(session, aal).includes('password')
      && sessionStorage.getItem('brace-portal-pw') !== '1') {
    return renderSetPassword();
  }

  stage('reading your authenticator');
  const { data: factors, error: fErr } = await within(supabase.auth.mfa.listFactors(), 15, 'Reading your authenticator');
  if (fErr) return renderBroken('Could not read your authenticator settings.', fErr);
  const verified = (factors?.totp || []).filter((f) => f.status === 'verified');
  if (!verified.length) return renderEnrol();

  // aal2 alone is not enough: the browser keeps the session, so a returning
  // visit would walk straight in on yesterday's code. The flag lives in
  // sessionStorage precisely because it dies with the tab — every fresh
  // window re-proves the second factor, which is the point of having one.
  if (aal?.currentLevel !== 'aal2'
      || sessionStorage.getItem('brace-portal-otp') !== '1') {
    return renderChallenge(verified[0].id);
  }

  // Two factors done. The database makes the final call.
  stage('confirming your access');
  const owner = await within(supabase.rpc('is_portal_owner'), 15, 'The access check');
  if (owner.error) return renderBroken('Could not confirm your access.', owner.error);
  if (!owner.data) return renderDenied(email);

  return renderDashboard(email);
}

supabase.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') { routedToken = null; return boot(); }
  if (event !== 'SIGNED_IN' && event !== 'MFA_CHALLENGE_VERIFIED') return;
  // A stored session is replayed as SIGNED_IN on every load, so this fires once
  // for a session route() is already handling. Re-route only when the token has
  // genuinely changed: a real sign-in, or the aal2 token a verified code mints.
  if (session?.access_token && session.access_token === routedToken) return;
  boot();   // if a pass is already running, boot() defers the decision to its end
});
boot();
