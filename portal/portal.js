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
    tally('pipeline_clips', 'clip_id', 'label_status', ['pending', 'prelabelled']),
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

const viewFromHash = () => ['review', 'sources'].find((v) => location.hash === `#${v}`) || 'control';
let view = viewFromHash();
let state = { email: '', counts: null, queue: [], sources: [], issues: [], spend: null, loading: true };
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
          ${item('control', 'Control')}
          ${item('review', 'Review', state.counts?.downloaded)}
          ${item('sources', 'Sources')}
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
      <span>${n('pending')} clips awaiting pre-label</span>
      <span>${n('prelabelled')} pre-labelled</span>
    </div>

    <div class="grid">
      <section class="panel">
        <div class="p-head"><span class="p-title">Run a stage</span>
          <span>
            <select id="batch" class="mini" title="How many videos one press works through — the cost dial">
              ${[3, 10, 25].map((v) => `<option value="${v}" ${v === batch ? 'selected' : ''}>${v} at a time</option>`).join('')}
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
      </section>
    </div>`;
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
  return JSON.stringify([
    view, state.email, state.loading, running, state.counts,
    state.queue.map((v) => v.video_id), log.length, log[0]?.line,
    state.sources.map((x) => `${x.id}${x.enabled}${x.last_found}`),
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

  shell(view === 'review' ? reviewView() : view === 'sources' ? sourcesView() : controlView());

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

  document.getElementById('addsrc')?.addEventListener('submit', addSource);
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
    const [counts, queue, sources, issues, spend] = await Promise.all([
      loadCounts(),
      view === 'review' ? loadQueue() : Promise.resolve(state.queue),
      view === 'sources' ? loadSources() : Promise.resolve(state.sources),
      view === 'control' ? loadIssues() : Promise.resolve(state.issues),
      view === 'control' ? loadSpend() : Promise.resolve(state.spend),
    ]);
    state.counts = counts;
    state.queue = queue;
    state.sources = sources;
    state.issues = issues;
    state.spend = spend;
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
  state = { email, counts: null, queue: [], sources: [], issues: [], spend: null, loading: true };
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
