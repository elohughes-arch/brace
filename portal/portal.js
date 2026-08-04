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

// A recovery arrival must always reach the password screen. Before this, the
// route depended on a per-tab flag, so a stale one sent an owner who had come
// to reset their password to the authenticator instead — the one screen that
// cannot help them.
let recovering = /[?&#]type=recovery/.test(window.location.href);

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
      <button class="btn btn-ghost" id="first" type="button">Forgot password</button>
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
    <h1>Reset your password</h1>
    <p class="gate-lede">We'll email you a reset link. It cannot open the portal on its
       own — it lets you set a new password, and your authenticator is still required
       afterwards.</p>
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
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) { busy(btn, false, 'Email me a link'); setErr(error.message); return; }
    gate(`<h1>Check your inbox</h1>
      <p class="gate-lede">A reset link is on its way to <strong>${esc(email)}</strong>.
         Open it on this device — it lands on a page for choosing a new password.</p>`);
  });
  document.getElementById('back').addEventListener('click', (e) => { e.preventDefault(); renderSignIn(); });
}

/* ---------- 2 · set a password (first run) ---------- */

function renderSetPassword(err = '', change = false) {
  const reset = recovering && !change;
  gate(`
    <h1>${change ? 'Change your password' : reset ? 'Choose a new password' : 'Choose a password'}</h1>
    <p class="gate-lede">${change
      ? 'This replaces the first of your two factors. Your authenticator is untouched.'
      : reset
        ? 'Your authenticator has confirmed you. This replaces the password you lost — make it long and unique to Brace.'
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
    recovering = false;
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
  // On a reset the code is not the last step but the first: it proves who is
  // asking before a new password can be set.
  const forReset = recovering;
  gate(`
    <h1>${forReset ? 'Confirm it is you' : 'Authenticator code'}</h1>
    <p class="gate-lede">Six digits from your authenticator app.${forReset
      ? ' Your new password comes next — the code proves who is asking for it.' : ''}</p>
    <div class="rule"></div>
    <form id="f">
      <input type="text" id="code" inputmode="numeric" autocomplete="one-time-code"
        pattern="[0-9]{6}" maxlength="6" placeholder="000000" required autofocus aria-label="Six-digit code" />
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" type="submit">Unlock</button>
    </form>
    <div class="gate-foot"><a href="#" id="out">Sign out</a> &middot;
      <a href="#" id="lost">Forgot password</a></div>`,
    'Owners portal', 'centred');

  document.getElementById('lost').addEventListener('click', (e) => {
    e.preventDefault();
    renderBootstrap();
  });

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
  { stage: 'recut', label: 'Re-cut', busy: 'Re-cutting', desc: 'Cut again the clips whose start and end you have edited by hand, then send them back through screening. Needs Modal.' },
  { stage: 'dataset', label: 'Build set', busy: 'Building', desc: 'Assemble a training set from the boxes we already hold — no Roboflow involved. The overlay filter runs on the way out, so the reticle never reaches the model. Needs Modal.' },
  { stage: 'train', label: 'Train', busy: 'Training', desc: 'Fine-tune our own clay detector on that set. Once one exists, screening uses it instead of Grounding DINO — better on this subject and far cheaper per frame. Needs Modal.' },
  { hand: true, stage: 'rejudge', label: 'Re-judge verdicts', busy: 'Re-judging', desc: 'Call the outcome again on clips already judged, using the current tracking and crop size. The verdict is the product, and a clip judged before a crop or tracking fix was judged on less than the model can see now. Needs Modal.' },
  { hand: true, stage: 'climb', label: 'Climb a rung', busy: 'Climbing', desc: 'Take the next rung of the ladder: build the set for every phase up to it and train on that, easiest first. The beat does this on its own — this is only for when you would rather not wait. Needs Modal.' },
  { hand: true, stage: 'scrub', label: 'Scrub labels', busy: 'Scrubbing', desc: 'Re-run the current overlay filter over every clip already screened, so red dots and crosshairs stored as clays are re-labelled as the reticle. Anything it corrects goes back in the upload queue to replace the bad copy in Roboflow. Needs Modal.' },
  { hand: true, stage: 'ingest', label: 'Add a dataset', busy: 'Ingesting', desc: 'Fold somebody else’s clay dataset into ours. Paste a Roboflow Universe address as workspace/project/version, or a link to a zip of a YOLO dataset. Borrowed images only ever join the training split — valid and test stay our own footage, so the score keeps meaning what it means. Needs Modal.',
    ask: 'Roboflow Universe address as workspace/project/version, or a link to a zipped YOLO dataset' },
];

// Bumped with every deploy. It is here for one reason: from the browser
// there is otherwise no way to tell a missing feature from a stale cache.
const BUILD = '2026-08-04m';

const log = [];
const now = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const note = (line, tone = '') => { log.unshift({ ts: Date.now(), t: now(), line, tone }); log.length = Math.min(log.length, 40); };

// The feed used to live only in this array, so a reload forgot every run.
// Run outcomes also land in pipeline_activity — written by this browser for
// quick stages and by Modal itself for the long ones — and every refresh
// reads the table back, so the feed is shared, durable, and live.
const when = (iso) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
};
function record(stage, line, tone = '') {
  supabase.from('pipeline_activity').insert({ stage, line, tone })
    .then(({ error }) => { if (error) console.warn('activity not recorded:', error.message); });
}
async function loadActivity() {
  const { data } = await supabase.from('pipeline_activity')
    .select('at,line,tone').order('at', { ascending: false }).limit(40);
  return data || [];
}
// One list from two sources: durable rows plus this tab's transient notes
// ("task added", "purchase logged") that are not worth keeping. A quick run
// appears in both — same line text — so the table copy is dropped.
function feed() {
  const local = log.map((l) => ({ ts: l.ts || 0, t: l.t, line: l.line, tone: l.tone }));
  const seen = new Set(local.map((l) => l.line));
  const past = (state.activity || [])
    .filter((r) => !seen.has(r.line))
    .map((r) => ({ ts: Date.parse(r.at), t: when(r.at), line: r.line, tone: r.tone || '' }));
  return [...local, ...past].sort((a, b) => b.ts - a.ts).slice(0, 12);
}

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
  const [videos, clips, todo] = await Promise.all([
    tally('pipeline_videos', 'video_id', 'status',
      ['discovered', 'downloaded', 'approved', 'clipped', 'rejected', 'binned', 'error']),
    tally('pipeline_clips', 'clip_id', 'label_status', ['raw', 'pending', 'queued', 'prelabelled', 'impossible']),
    supabase.from('todos').select('id', { count: 'exact', head: true }).eq('done', false),
  ]);
  return { ...videos, ...clips, todo: todo.error ? 0 : (todo.count ?? 0) };
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
  // Everything the pipeline has spent, priced per model — triage and the
  // verdicts both. Verdicts were invisible here for a fortnight and ran up
  // fifteen dollars unseen; a cost you cannot see is a cost you cannot govern.
  let data, error;
  try { ({ data, error } = await supabase.rpc('total_spend')); }
  catch { return null; }
  if (error || !data || !data.length) return null;
  const rows = data.map((r) => ({
    model: r.model, calls: Number(r.calls || 0), usd: Number(r.usd || 0),
  }));
  return { rows, usd: rows.reduce((a, r) => a + r.usd, 0) };
}

// The credit book: Anthropic exposes no balance endpoint, so the estimate
// is arithmetic — top-ups logged here minus every metered token since the
// meter went in. The live probe on this page remains the truth about empty.
async function loadCredits() {
  const { data, error } = await supabase.from('credit_topups')
    .select('*').order('noted_at', { ascending: false }).limit(20);
  return { rows: error ? [] : (data || []), err: error?.message || '' };
}

// The whole findings report in one call. A dozen separate queries would be
// a dozen round trips and a dozen chances to half-load; the database builds
// the object where the data already is.
async function loadFindings() {
  try {
    const [rep, cov] = await Promise.all([
      supabase.rpc('findings_report'),
      supabase.rpc('clip_coverage'),
    ]);
    if (rep.error) return null;
    return { ...rep.data, coverage: cov.error ? [] : (cov.data || []) };
  } catch { return null; }
}

// The impossible: clips no person could call, newest first.
async function loadImpossible() {
  const { data, error } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,clip_start,clip_end,is_pair,n_shots,slo_mo,'
      + 'preview_path,poster_path,impossible_at,impossible_by,shot_type,'
      + 'clay_colour,weather,det_conf,label_status')
    .eq('label_status', 'impossible')
    .order('impossible_at', { ascending: false }).limit(120);
  if (error) return [];
  const rows = data || [];
  await signClipMedia(rows);
  await titleClips(rows);
  return rows;
}

function impossibleView() {
  if (state.loading) return '<div class="empty">Loading…</div>';
  const rows = state.impossible || [];
  const mine = rows.filter((k) => k.impossible_by === 'eddie').length;
  const theirs = rows.filter((k) => k.impossible_by === 'rupert').length;
  return `
    <div class="crm-head">
      <div>
        <h1>The impossible</h1>
        <p>Clips neither of you could call. Not the bin — the opposite end of it.
           If a person watching the footage cannot see what happened, that clip is
           the hardest thing this job contains, and it is worth more standing still
           as a benchmark than folded into training. Nothing here trains anything:
           a set you train on cannot also be the set that tells you how good you
           have become. When a model can call these, it has earned the name.</p>
      </div>
    </div>

    <div class="stats scoreboard">
      <div class="stat"><div class="num">${fmt(rows.length)}</div>
        <div class="cap">Filed</div><div class="sub">the standing benchmark</div></div>
      <div class="stat owner-eddie"><div class="num">${fmt(mine)}</div>
        <div class="cap">Eddie</div><div class="sub">filed by</div></div>
      <div class="stat owner-rupert"><div class="num">${fmt(theirs)}</div>
        <div class="cap">Rupert</div><div class="sub">filed by</div></div>
    </div>

    <section class="panel">
      <div class="p-head"><span class="p-title">Every one, newest first</span>
        <span class="s">press one back into the queue if it turns out to be callable</span></div>
      ${rows.length ? `<div class="clipgrid">${rows.map((k) => `
      <div class="clipcard" data-id="${esc(k.clip_id)}">
        <div class="clipmedia">${clipMedia(k)}</div>
        <div class="clipcap">
          <div class="t">${esc(k.title || k.video_id)}${k.shot_no ? ` — shot ${k.shot_no}` : ''}</div>
          <div class="s">${k.is_pair ? `pair · ${k.n_shots || 2} shots` : 'single'}
            · ${(k.clip_end - k.clip_start).toFixed(1)}s
            · det ${k.det_conf == null ? '—' : Math.round(k.det_conf * 100) + '%'}
            ${k.shot_type ? ` · ${esc(k.shot_type)}` : ''}${k.slo_mo ? ' · slo-mo' : ''}</div>
          <div class="s">filed by ${esc(who(k.impossible_by === 'eddie' ? 'elohughes@icloud.com'
    : k.impossible_by === 'rupert' ? 'rupertokelly98@gmail.com' : ''))}
            ${k.impossible_at ? `· ${ago(k.impossible_at)}` : ''}</div>
          <div class="clipsend-row">
            <button class="btn btn-ghost clipsend" data-unimpossible="${esc(k.clip_id)}">Back to triage</button>
          </div>
        </div>
      </div>`).join('')}</div>`
    : `<div class="empty">Nothing filed yet. When a clip defeats both of you, press
         Impossible on it in Triage and it lands here.</div>`}
    </section>`;
}

// Every detector we have trained, newest first. The row is the whole record
// of a run — what it was built from, what it scored — so a model can be
// judged against its predecessor rather than taken on trust.
async function loadModels() {
  const { data, error } = await supabase.from('pipeline_models')
    .select('*').order('created_at', { ascending: false }).limit(10);
  return error ? [] : (data || []);
}

// The coverage matrix: surviving clips per weather slice, split into what
// trains the model and what measures it. A thin row is a condition the model
// has not been taught yet, and it names the next filming day to chase.
async function loadCoverage() {
  try {
    const { data, error } = await supabase.rpc('coverage_matrix');
    return error ? [] : (data || []);
  } catch { return []; }   // a missing function is a blank panel, not a broken page
}

async function loadClips() {
  // Twelve, not forty. Every card carries a player and, once a pair or a
  // flush opens its rows, a dozen controls of its own — forty of them was
  // over a thousand live elements on one page, rebuilt whole on every
  // repaint, and two people working at once made it unusable. Twelve fills
  // a screen, and the pager is right there.
  const PAGE = TRIAGE_PAGE;
  let q = supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,clip_start,clip_end,is_pair,label_status,roboflow_id,preview_path,poster_path,file_path,sorter,owner_outcome,owner_outcome_2,owner_outcome_3,owner_outcomes,outcomes,n_shots,needs_recut,presentation,presentations,clay_colour,clay_colours,weather,background,backgrounds,shot_type,created_at',
      { count: 'exact' })
    .eq('label_status', 'pending');
  const me = WHOAMI();
  if (clipOwner === 'mine' && me) q = q.eq('sorter', me);
  if (clipOwner === 'theirs' && me) q = q.neq('sorter', me);
  const { data, error, count } = await q
    .order('video_id').order('shot_ts')
    .range(clipPage * PAGE, clipPage * PAGE + PAGE - 1);
  if (error) return [];
  // The pager has to count what the filter actually returns, or "Mine"
  // offers pages that are not there.
  state.clipTotal = count ?? null;
  const rows = data || [];
  // Whose clip is whose. The queue is ordered the same way every load, so
  // alternating on the row's position in the whole queue — not just this
  // page — deals an exactly even split that stays put across page flips.
  // A sorter already recorded in the database wins; this only fills the gap.
  rows.forEach((k, i) => {
    k.sorter = k.sorter || ((clipPage * PAGE + i) % 2 === 0 ? 'eddie' : 'rupert');
  });
  // Previews live in a private bucket; a signed URL is the only way a
  // browser can play one, and signing is itself gated by is_portal_owner().
  await signClipMedia(rows);
  await titleClips(rows);
  return rows;
}

// Previews and posters live in a private bucket; signed URLs are the only
// way a browser can fetch them, and signing is gated by is_portal_owner().
// Signed URLs are cached until they are nearly spent. Re-signing on every
// eight-second poll minted a fresh URL for the same file each time, which
// changed every <video src> on the page: the browser dropped what it had
// buffered and started the download again, so a preview could never finish
// loading between polls. Same URL, same buffer, no reload.
const signedUrls = new Map();   // path -> { url, until }
// Six hours, not one. The tab is left open all day on this page, and a URL
// that outlives the sitting is one that never dies mid-review.
const SIGN_FOR = 6 * 3600;

async function signClipMedia(rows) {
  const now = Date.now();
  const paths = [...new Set(rows.flatMap((k) => [k.preview_path, k.poster_path])
    .filter(Boolean))];
  const stale = paths.filter((p) => {
    const hit = signedUrls.get(p);
    return !hit || hit.until - now < 300_000;   // re-sign with 5 minutes left
  });
  if (stale.length) {
    try {
      const { data: signed } = await supabase.storage.from('clips')
        .createSignedUrls(stale, SIGN_FOR);
      (signed || []).forEach((x) => {
        if (x.signedUrl) {
          signedUrls.set(x.path, { url: x.signedUrl, until: now + SIGN_FOR * 1000 });
        }
      });
    } catch { /* players fall back to the YouTube link */ }
  }
  rows.forEach((k) => {
    k.preview_url = signedUrls.get(k.preview_path)?.url || null;
    k.poster_url = signedUrls.get(k.poster_path)?.url || null;
  });
  // A re-signed URL has to reach the page, and a repaint will not carry it:
  // the repaint signature records only whether a preview exists, not which
  // URL it is, so re-signing changed nothing the page could notice. The
  // markup kept the first URL it was given and went on serving it until it
  // expired — which is why a tab left open an hour filled with dead
  // players. Patch the elements directly, and never under a clip that is
  // playing.
  if (stale.length) {
    document.querySelectorAll('[data-path]').forEach((el) => {
      const fresh = signedUrls.get(el.dataset.path)?.url;
      if (!fresh || el.getAttribute('src') === fresh) return;
      if (el.tagName === 'VIDEO' && !el.paused && !el.ended) return;
      el.setAttribute('src', fresh);
    });
  }
  // The cache must not grow without bound as pages are flipped through.
  if (signedUrls.size > 600) {
    for (const [p, v] of signedUrls) {
      if (v.until < now) signedUrls.delete(p);
    }
  }
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
    .select('clip_id,video_id,shot_ts,label_status,roboflow_id,preview_path,poster_path,file_path,outcome,outcome_conf,outcome_2,outcome_2_conf,outcome_3,outcome_3_conf,owner_outcome,owner_outcome_2,owner_outcome_3,owner_outcomes,outcomes,n_shots,is_pair,clay_colour,presentation,presentations,weather,det_conf,range_m,speed_mph,created_at')
    .in('label_status', ['queued', 'prelabelled'])
    .order(aiSort === 'new' ? 'created_at' : 'outcome_conf',
      { ascending: aiSort === 'lo', nullsFirst: false })
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
    .select('clip_id,video_id,shot_ts,label_status,roboflow_id,file_path,sorter,sorter_colour')
    .in('label_status', ['queued', 'prelabelled'])
    .order('created_at', { ascending: false }).limit(8);
  const rows = data || [];
  await titleClips(rows);
  return rows;
}

// What one press of the handover button would deal to each Roboflow set.
async function loadSplitPreview() {
  try {
    const { data, error } = await supabase.rpc('split_preview');
    return error ? [] : (data || []);
  } catch { return []; }
}

// The machine's discards, for auditing: clips screening threw out as
// clayless. A wrong rejection is a training example lost silently, so the
// owner can watch each one and send any mistake back for re-screening.
async function loadRejectedClips() {
  const { data, error, count } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,clip_start,clip_end,preview_path,poster_path,file_path,created_at,sorter,sorter_colour', { count: 'exact' })
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
    .select('video_id,title,channel,status,triage_score,triage_notes,duration_s,used,weather,ds_level,updated_at')
    .order('updated_at', { ascending: false }).limit(150);
  if (sheetFilter !== 'all') q = q.eq('status', sheetFilter);
  const { data, error } = await q;
  state.sheetErr = error ? (error.message || String(error)) : '';
  if (error) return [];
  const rows = data || [];
  // clips cut / sent per video, computed fresh rather than stored
  try {
    const { data: cc } = await supabase.rpc('sheet_clip_verdicts');
    const byVid = new Map((cc || []).map((x) => [x.video_id, x]));
    rows.forEach((v) => {
      const x = byVid.get(v.video_id);
      v.clips = x ? Number(x.clips) : 0;
      v.sent = x ? Number(x.sent) : 0;
      v.called = x ? Number(x.called) : 0;
      v.hit = x ? Number(x.hit) : 0;
      v.chipped = x ? Number(x.chipped) : 0;
      v.miss = x ? Number(x.miss) : 0;
      v.unclear = x ? Number(x.unclear) : 0;
    });
  } catch { /* counts stay undefined; the sheet still lists */ }
  return rows;
}

const judged = new Set();   // survives a queue read that overtakes a decision

// One row of buttons per clay. A pair is two answers and a burst is three —
// a single call on a two-clay clip teaches the model half the truth.
const clayRows = new Map();          // clip_id -> rows opened by hand
// The first three calls still live in their own columns, because the
// mastersheet, the CSV export and the trials all read them. Past three there
// is only the array — a flush is however many birds were in the air.
const OWNER_SLOTS = ['owner_outcome', 'owner_outcome_2', 'owner_outcome_3'];
const MAX_CLAYS = 8;
const TRIAGE_PAGE = 12;   // cards per page — see loadClips()

// Whose clips the queue shows. The split judge already deals every clip to
// one of you, and the cards have carried the owner's colour for weeks — but
// the queue itself showed everything to everyone, so two people working at
// once were handed the same twelve clips and either duplicated the work or
// overwrote each other's call. Yours by default; the whole queue is one
// choice away for when one of you is clearing the other's backlog.
let clipOwner = 'mine';

// Who is signed in, in the same words the sorter column uses, so a call is
// credited to whoever made it rather than to whoever the clip was dealt to.
const WHOAMI = () => (state.email === 'rupertokelly98@gmail.com' ? 'rupert'
  : state.email === 'elohughes@icloud.com' ? 'eddie' : null);

// The tally window. Today by default — the question is almost always "how
// much have we done today" — but a week, a month and a year answer the
// other question, which is whether the pace is holding.
const SCOREBOARDS = [['day', 'Today'], ['week', 'This week'],
  ['month', 'This month'], ['year', 'This year']];
let scoreWindow = 'day';

// Local midnight, not UTC: a call made at eleven at night belongs to the
// day it felt like, not to tomorrow.
function windowStart(which) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (which === 'week') {
    const dow = (d.getDay() + 6) % 7;      // Monday starts the week
    d.setDate(d.getDate() - dow);
  } else if (which === 'month') {
    d.setDate(1);
  } else if (which === 'year') {
    d.setMonth(0, 1);
  }
  return d.toISOString();
}

async function loadScores() {
  const { data, error } = await supabase.from('pipeline_clips')
    .select('called_by,sorter')
    .gte('called_at', windowStart(scoreWindow)).limit(5000);
  if (error) return null;
  const out = { eddie: 0, rupert: 0, total: 0 };
  (data || []).forEach((r) => {
    const who = r.called_by || r.sorter;
    if (who === 'eddie' || who === 'rupert') out[who] += 1;
    out.total += 1;
  });
  return out;
}

// What the clay did and what the sky was, as the person watching sees it.
// Presentation is a property of the shot, never of the video; weather was
// only ever read once per film by triage, and a day's light moves.
// A crosser that falls away is a different target from one holding its
// line — the clay is dropping through the shot, so the lead changes as it
// goes. Kept as its own word rather than folded into "crosser", because
// that is the distinction the footage actually shows. The tracker already
// names a bare dropper from the flight geometry; these are the ones a
// coach would say out loud.
const PRESENTATIONS = ['crosser L→R', 'crosser R→L', 'dropping crosser L→R',
  'dropping crosser R→L', 'dropper', 'going away', 'incoming', 'driven',
  'quartering', 'looper', 'teal', 'rabbit', 'battue', 'chandelle',
  'simultaneous pair', 'on report'];
const WEATHERS = ['clear', 'light cloud', 'overcast', 'bright sun', 'rain',
  'fog', 'dusk', 'low light'];
// Colour is per clay — a pair can be an orange and a black. Background is
// per clip and is the only thing that can place a clip on phase 5.
const CLAY_COLOURS = ['orange', 'black', 'midi'];
// Clouds are their own background, not a kind of open sky: a clay against
// broken cloud is a far harder find than one against flat blue, and it is
// the single most common British sky.
const BACKGROUNDS = ['open sky', 'clouds', 'treeline', 'hillside', 'valley',
  'ground', 'buildings', 'mixed'];

// A clip's calls, newest storage first: the array if it has been written,
// the three legacy columns if this row predates it.
const ownerCalls = (k) => {
  const arr = Array.isArray(k.owner_outcomes) ? [...k.owner_outcomes] : [];
  if (arr.length) return arr;
  return OWNER_SLOTS.map((f) => k[f] ?? null);
};
const clayBackgrounds = (k) => {
  const arr = Array.isArray(k.backgrounds) ? [...k.backgrounds] : [];
  if (arr.length) return arr;
  return k.background ? [k.background] : [];
};
const clayColours = (k) => {
  const arr = Array.isArray(k.clay_colours) ? [...k.clay_colours] : [];
  if (arr.length) return arr;
  return k.clay_colour && k.clay_colour !== 'unknown' ? [k.clay_colour] : [];
};
const clayPresentations = (k) => {
  const arr = Array.isArray(k.presentations) ? [...k.presentations] : [];
  if (arr.length) return arr;
  return k.presentation ? [k.presentation] : [];
};
const aiCalls = (k) => {
  const arr = Array.isArray(k.outcomes) ? k.outcomes : [];
  if (arr.length) return arr.map((x) => [x.o, x.c]);
  return [[k.outcome, k.outcome_conf], [k.outcome_2, k.outcome_2_conf],
    [k.outcome_3, k.outcome_3_conf]].filter(([o]) => o != null);
};
function callRows(k) {
  const mine = ownerCalls(k);
  // However many the shot actually threw: the machine's own count of birds,
  // the calls already made, and a pair's second bird all open a row, so a
  // five-bird flush arrives with five rather than being clipped to three.
  const auto = Math.max(
    aiCalls(k).length,
    mine.filter((v) => v != null).length,
    k.n_shots || 0,
    k.is_pair ? 2 : 1);
  // A count set by hand is authoritative in both directions. Taking the
  // larger of the two would make "one fewer" do nothing whenever the
  // clipper had heard more bangs than there were clays — which is exactly
  // the case the button exists for.
  const manual = clayRows.get(k.clip_id);
  const shown = Math.min(MAX_CLAYS, manual != null ? Math.max(1, manual) : auto);
  const pres = clayPresentations(k);
  const cols = clayColours(k);
  const bgs = clayBackgrounds(k);
  const slot = (n) => `
    <div class="calls">
      ${shown > 1 ? `<span class="clayno">clay ${n}</span>` : ''}
      ${['hit', 'chipped', 'miss', 'unclear'].map((o) => `
        <button class="callbtn ${mine[n - 1] === o ? 'on' : ''}"
          data-call="${esc(k.clip_id)}" data-slot="${n}" data-out="${o}">${o}</button>`).join('')}
      <select class="mini claypres" data-pres="${esc(k.clip_id)}" data-slot="${n}"
        title="What this clay did">
        <option value="">${n === 1 && k.shot_type ? `— ${esc(k.shot_type)}?` : '— presentation'}</option>
        ${PRESENTATIONS.map((o) => `<option ${pres[n - 1] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
      <select class="mini claypres" data-colour="${esc(k.clip_id)}" data-slot="${n}"
        title="What colour this clay was">
        <option value="">${n === 1 && k.clay_colour && k.clay_colour !== 'unknown' ? `— ${esc(k.clay_colour)}?` : '— colour'}</option>
        ${CLAY_COLOURS.map((o) => `<option ${cols[n - 1] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
      <select class="mini claypres" data-bg="${esc(k.clip_id)}" data-slot="${n}"
        title="What this clay had to be found against">
        <option value="">— background</option>
        ${BACKGROUNDS.map((o) => `<option ${bgs[n - 1] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>
    </div>`;
  return `
    <div class="yourcall">
      <span class="k">Your call${shown > 1 ? 's — every clay gets one' : ''}</span>
      ${Array.from({ length: shown }, (_, i) => slot(i + 1)).join('')}
      <div class="claynudge">
        ${shown < MAX_CLAYS ? `<button class="linky addclay" data-addclay="${esc(k.clip_id)}" data-next="${shown + 1}">+ another clay</button>` : ''}
        ${shown > 1 ? `<button class="linky addclay" data-dropclay="${esc(k.clip_id)}" data-next="${shown - 1}">− one fewer</button>` : ''}
      </div>
      <div class="tagrow">
        <label>Weather
          <select class="mini" data-tag="weather" data-clip="${esc(k.clip_id)}">
            <option value="">—</option>
            ${WEATHERS.map((o) => `<option ${k.weather === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
          </select></label>

      </div>
    </div>`;
}

// Discovery's home: what the search found that triage has not yet judged.
// These rows are on the master from the moment discover returns — the page
// simply never showed them before.
async function loadDiscovered() {
  const { data, error } = await supabase.from('pipeline_videos')
    .select('video_id,title,channel,duration_s,view_count,discovered_at')
    .eq('status', 'discovered')
    .order('discovered_at', { ascending: false })
    .limit(30);
  return error ? [] : (data || []);
}

async function loadQueue() {
  const { data, error } = await supabase.from('pipeline_videos')
    .select('video_id,title,channel,url,duration_s,view_count,triage_score,triage_notes,criteria,ds_level,updated_at')
    .eq('status', 'downloaded')
    .order('triage_score', { ascending: false })
    .limit(24);
  return error ? [] : (data || []).filter((v) => !judged.has(v.video_id));
}

/* ---------- dataset strategy ---------- */

// The curriculum ladder: teach the easiest sight first, then add one axis of
// difficulty at a time, each rung measured before the next is poured in.
// Search queries per rung live server-side in api/run/[stage].js (DS_LEVELS);
// targets are distinct shots — the currency of the whole data strategy.
const DS_LADDER = [
  { n: 1, name: 'Foundation', target: 600, sub: 'Orange clays on clear sky, close and slow — slow motion welcome. The model learns what a clay is.' },
  { n: 2, name: 'Standard sporting', target: 500, sub: 'Orange clays, real presentations: crossers, going-away, skeet and trap, first person.' },
  { n: 3, name: 'Dark clays', target: 350, sub: 'Black, midi and blaze clays on clear sky — same flight, different disc.' },
  { n: 4, name: 'Overcast', target: 400, sub: 'Grey disc on grey sky — the classic killer, and most of British shooting.' },
  { n: 5, name: 'Cluttered ground', target: 400, sub: 'Treeline, hillside and valley backgrounds — the clay must be found against terrain, not sky.' },
  { n: 6, name: 'Long and fast', target: 300, sub: 'High towers, 40-yard birds, fast crossers — the clay is a few pixels with motion blur.' },
  { n: 7, name: 'Hard light', target: 250, sub: 'Rain, dusk, fog, low winter sun — the conditions a real shoot actually has.' },
  { n: 8, name: 'Edge cases', target: 200, sub: 'Sim-game flushes, rabbits rolling on the ground, battue and chandelle specialty targets.' },
];

async function loadProgress() {
  try {
    const { data, error } = await supabase.rpc('dataset_progress');
    return error ? [] : (data || []);
  } catch { return []; }
}

// The shot inventory: every observed category, as specific as the data can
// say — clay colour × weather × outcome, counted at the shot level. The
// categories aren't hand-defined; they emerge as the machine banks shots,
// so "black clay chipped in overcast" appears the moment one exists.
async function loadCategories() {
  try {
    const { data, error } = await supabase.rpc('shot_categories');
    return error ? [] : (data || []);
  } catch { return []; }
}

const OUTCOME_COLS = ['hit', 'chipped', 'miss', 'unclear'];

function inventoryPanel() {
  const cats = state.cats || [];
  if (!cats.length) {
    return `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Shot inventory — colour × conditions × outcome</span></div>
      <div class="empty">Empty until the machine banks judged shots — colour is read
        by the verdict model, so the inventory fills as screening runs.</div>
    </section>`;
  }
  // rows: colour × weather; columns: what happened to the clay
  const by = new Map();
  cats.forEach((r) => {
    const key = `${r.colour}|${r.weather}`;
    const row = by.get(key) || { colour: r.colour, weather: r.weather, hit: 0, chipped: 0, miss: 0, unclear: 0, total: 0 };
    if (OUTCOME_COLS.includes(r.outcome)) row[r.outcome] += Number(r.shots);
    row.total += Number(r.shots);
    by.set(key, row);
  });
  const rows = [...by.values()].sort((a, b) => b.total - a.total);
  return `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Shot inventory — colour × conditions × outcome, shots counted</span></div>
      <table class="matrix">
        <thead><tr><th>Clay</th><th>Conditions</th>
          <th>Hit</th><th>Chipped</th><th>Miss</th><th>Unclear</th><th>Total</th></tr></thead>
        <tbody>
          ${rows.map((r) => `
          <tr><td>${esc(r.colour)}</td><td>${esc(r.weather)}</td>
            <td>${fmt(r.hit)}</td><td>${fmt(r.chipped)}</td>
            <td>${fmt(r.miss)}</td><td class="dim">${fmt(r.unclear)}</td>
            <td><b>${fmt(r.total)}</b></td></tr>`).join('')}
        </tbody>
      </table>
      <p class="foot-note">As specific as the data can currently say: the clay's
         colour is read by the verdict model from the zoomed crops, conditions come
         from triage's weather call on the video, and each row splits by what
         happened to the clay — pulverised, chipped, missed, or unresolved. Every
         shot the machine judges lands in exactly one cell, live. A thin cell is a
         category to go and source.</p>
    </section>`;
}

function strategyView() {
  const by = new Map((state.progress || []).map((r) => [Number(r.level), r]));
  const totShots = (state.progress || []).reduce((a, r) => a + Number(r.shots || 0), 0);
  const totTarget = DS_LADDER.reduce((a, l) => a + l.target, 0);
  const card = (l) => {
    const p = by.get(l.n) || {};
    const shots = Number(p.shots || 0);
    const pct = Math.min(100, Math.round((shots / l.target) * 100));
    return `
    <section class="panel level ${shots >= l.target ? 'level-done' : ''}">
      <div class="p-head">
        <span class="p-title">Level ${l.n} — ${l.name}</span>
        <span class="lv-pct">${pct}%</span>
      </div>
      <p class="lv-sub">${l.sub}</p>
      <div class="lv-bar"><span style="width:${pct}%"></span></div>
      <div class="lv-nums">
        <span><b>${fmt(shots)}</b> of ${fmt(l.target)} shots</span>
        <span>${fmt(Number(p.videos || 0))} videos found · ${fmt(Number(p.kept || 0))} kept</span>
        <span>${fmt(Number(p.clips || 0))} clips · ${fmt(Number(p.clays || 0))} clays boxed</span>
        <button class="linky" data-dsfind="${l.n}" ${running ? 'disabled' : ''}>
          ${running === 'discover' ? 'searching…' : 'Find footage for this level'}</button>
      </div>
    </section>`;
  };
  return `
    <div class="crm-head">
      <div>
        <h1>Dataset strategy</h1>
        <p>The curriculum, as a ladder: teach the easiest sight first, then add one
           axis of difficulty at a time. Each level's numbers update live as
           discovery finds footage, you approve it, and the machine cuts and counts
           the shots. The currency is distinct shots — ${fmt(totShots)} banked of
           ~${fmt(totTarget)} for the full ladder.</p>
      </div>
    </div>
    <section class="panel" style="margin-bottom:18px">
      <div class="p-head"><span class="p-title">POV hunt — ShotKam · GoPro · Meta glasses</span>
        <button class="linky" data-dsfind="pov" ${running ? 'disabled' : ''}>
          ${running === 'discover' ? 'searching…' : 'Find POV footage'}</button>
      </div>
      <p class="lv-sub" style="margin:0">Not a rung of the ladder — a lens across all of
         it. The app will run on footage from the cameras shooters actually wear, so
         training should look through the same glass: this hunts barrel cams, head
         mounts and smart glasses specifically. Triage confirms the camera from the
         frames, so the Mastersheet's camera tags stay honest.</p>
    </section>

    <div class="stack">${DS_LADDER.map(card).join('')}</div>
    <p class="foot-note" style="margin-top:14px">"Find footage" runs a criteria
       discovery: it searches phrases written for that level and stamps every
       candidate with the level it was sourced for, so these counts and the
       Mastersheet stay honest. Videos found by ordinary source discovery carry no
       level until you set one on the Mastersheet.</p>
    ${inventoryPanel()}`;
}

/* ---------- model trials ---------- */

// The bench: the same clips judged by several models, side by side. The
// live verdict is untouched by a trial, so this compares opinions without
// disturbing the production line.
async function loadTrials() {
  const { data, error } = await supabase.from('verdict_trials')
    .select('clip_id,model,outcome,outcome_conf').limit(2000);
  if (error || !data || !data.length) return { trials: [], clips: [], acc: [] };
  let acc = [];
  try {
    const { data: a } = await supabase.rpc('trial_accuracy');
    acc = a || [];
  } catch { /* no calls made yet */ }
  const ids = [...new Set(data.map((t) => t.clip_id))];
  const { data: cl } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,outcome,outcome_conf,preview_path,poster_path,file_path')
    .in('clip_id', ids);
  const clips = cl || [];
  await Promise.all([signClipMedia(clips), titleClips(clips)]);
  return { trials: data, clips, acc };
}

const TRIAL_OUTCOMES = ['hit', 'chipped', 'miss', 'unclear'];

function trialsPanel() {
  const { trials = [], clips = [] } = state.trials || {};
  if (!trials.length) {
    return `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Model trials — the bench</span></div>
      <div class="empty">No trial has been run. Judge the same clips with two or
        more models and their verdicts land here side by side, with every
        disagreement listed for you to referee.</div>
    </section>`;
  }
  const models = [...new Set(trials.map((t) => t.model))].sort();
  const byClip = new Map();
  trials.forEach((t) => {
    const m = byClip.get(t.clip_id) || {};
    m[t.model] = t;
    byClip.set(t.clip_id, m);
  });
  const clipById = new Map(clips.map((k) => [k.clip_id, k]));

  // Judged by every model in the trial — the only fair comparison set.
  const complete = [...byClip.entries()].filter(([, m]) => models.every((x) => m[x]));
  const split = complete.filter(([, m]) => new Set(models.map((x) => m[x].outcome)).size > 1);

  const summary = models.map((mo) => {
    const mine = trials.filter((t) => t.model === mo);
    const conf = mine.filter((t) => t.outcome_conf != null);
    return {
      model: mo,
      n: mine.length,
      counts: Object.fromEntries(TRIAL_OUTCOMES.map((o) =>
        [o, mine.filter((t) => t.outcome === o).length])),
      avg: conf.length ? conf.reduce((a, t) => a + Number(t.outcome_conf), 0) / conf.length : null,
    };
  });

  const dis = split.slice(0, 20).map(([id, m]) => {
    const k = clipById.get(id) || {};
    return `
    <div class="clipcard">
      <div class="clipmedia">
        ${k.preview_url
    ? `<video controls preload="none" data-path="${esc(k.preview_path || '')}" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>`
    : '<span class="rendering">no preview</span>'}
      </div>
      <div class="clipcap">
        <div class="t">${esc(k.title || id)}${k.shot_no ? ` — shot ${k.shot_no}` : ''}</div>
        ${models.map((mo) => `<div class="s"><span class="tm">${esc(mo.replace('claude-', ''))}</span>
          <b class="${m[mo].outcome === 'hit' ? 'v-hit' : m[mo].outcome === 'miss' ? 'v-miss' : m[mo].outcome === 'chipped' ? 'v-chip' : ''}">${esc(m[mo].outcome)}</b>
          ${m[mo].outcome_conf != null ? `${Math.round(m[mo].outcome_conf * 100)}%` : ''}</div>`).join('')}
      </div>
    </div>`;
  }).join('');

  const acc = (state.trials || {}).acc || [];
  return `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Model trials — ${fmt(complete.length)} clips judged by all ${models.length}</span></div>
      ${acc.length ? `
      <table class="matrix" style="margin-bottom:20px">
        <thead><tr><th>Scored against your calls</th><th>Judged</th><th>Right</th>
          <th>Accuracy</th><th>Ducked it</th><th>Confidently wrong</th></tr></thead>
        <tbody>
          ${acc.map((r) => `
          <tr><td>${esc(r.model)}</td><td>${fmt(Number(r.judged))}</td>
            <td>${fmt(Number(r.correct))}</td>
            <td><b>${r.pct == null ? '—' : `${r.pct}%`}</b></td>
            <td class="dim">${fmt(Number(r.said_unclear))}</td>
            <td class="${Number(r.confidently_wrong) ? 'h-fail' : 'dim'}">${fmt(Number(r.confidently_wrong))}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="foot-note" style="margin:-10px 0 18px">The only honest column is
         accuracy, and it exists because you called these shots yourself. "Ducked it"
         counts clips it called unclear where you saw an answer — wasted footage.
         "Confidently wrong" counts calls it made at 80% or better and got wrong —
         far more dangerous than a duck, because nothing downstream doubts it.</p>`
    : `<p class="foot-note" style="margin:-6px 0 16px">No calls of your own yet — use
        the verdict buttons under each clip above and this becomes a real scorecard.
        Until then the models can only be compared to each other, which proves
        consistency, not correctness.</p>`}
      <table class="matrix">
        <thead><tr><th>Model</th><th>Judged</th>
          ${TRIAL_OUTCOMES.map((o) => `<th>${o}</th>`).join('')}
          <th>Avg confidence</th></tr></thead>
        <tbody>
          ${summary.map((r) => `
          <tr><td>${esc(r.model)}</td><td>${fmt(r.n)}</td>
            ${TRIAL_OUTCOMES.map((o) => `<td class="${o === 'unclear' ? 'dim' : ''}">${fmt(r.counts[o])}</td>`).join('')}
            <td>${r.avg == null ? '—' : `${Math.round(r.avg * 100)}%`}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="foot-note" style="margin-bottom:14px">
        ${fmt(complete.length - split.length)} clips where every model agrees ·
        <b>${fmt(split.length)} where they split</b>. Agreement proves consistency, not
        correctness — the split ones are the evidence: watch them and decide who was
        right. A model that is confidently wrong is worse than one that says unclear,
        and the unclear column is where a cheap model usually hides.</p>
      ${split.length ? `<div class="clipgrid">${dis}</div>` : ''}
    </section>`;
}

/* ---------- export ---------- */

// The bulk handover. Everything screening has passed goes to Roboflow in
// one press, dealt by the split judge — whole channels to one set, so the
// export can never leak between train, valid and test.
async function loadExport() {
  const count = (statuses, split) => supabase.from('pipeline_clips')
    .select('clip_id', { count: 'exact', head: true })
    .in('label_status', statuses).eq('rf_split', split);
  const splits = ['train', 'valid', 'test'];
  const res = await Promise.all([
    ...splits.map((s) => count(['pending'], s)),
    ...splits.map((s) => count(['queued', 'prelabelled'], s)),
  ]);
  const out = {};
  splits.forEach((s, i) => {
    out[s] = {
      ready: res[i].error ? 0 : (res[i].count ?? 0),
      sent: res[i + 3].error ? 0 : (res[i + 3].count ?? 0),
    };
  });
  return out;
}

function exportView() {
  if (state.loading) return '<div class="empty">Counting the deal…</div>';
  const e = state.exp || {};
  const ready = ['train', 'valid', 'test'].reduce((a, s) => a + (e[s]?.ready || 0), 0);
  const box = (s, label, sub) => `
    <div class="stat"><span class="clay ${e[s]?.ready ? 'on' : 'off'}"></span>
      <div class="num">${fmt(e[s]?.ready || 0)}</div>
      <div class="cap">${label}</div>
      <div class="sub">${sub} · ${fmt(e[s]?.sent || 0)} already with Roboflow</div></div>`;
  return `
    <div class="crm-head">
      <div>
        <h1>Export</h1>
        <p>The bulk handover to Roboflow. Every clip screening has passed goes over
           in one press, dealt by the split judge — whole channels to one set,
           so the export cannot leak between train, valid and test.</p>
      </div>
    </div>

    <div class="stats">
      ${box('train', 'Train', 'the model learns from these')}
      ${box('valid', 'Valid', 'steers training runs — human-checked')}
      ${box('test', 'Test', 'the golden ruler — never trained on')}
    </div>

    <section class="panel">
      <div class="p-head"><span class="p-title">One press, the whole queue</span></div>
      <div class="runs">
        <div class="run">
          <button class="btn" id="exportall" ${ready && !running ? '' : 'disabled'}>
            ${running === 'prelabel' ? 'Exporting…' : `Export ${fmt(ready)} to Roboflow`}</button>
          <p>Queues every pending clip and fires the labeller immediately — 50 clips a
             run, the hourly heartbeat sweeps the rest. Frames land in Roboflow already
             boxed, split-assigned, and batched for review: golden test frames under
             <b>golden-holdout</b>, valid under <b>valid-check</b>, train under
             <b>auto-accepted</b> or <b>needs-review</b> by confidence.</p>
        </div>
        <div class="run">
          <button class="btn btn-ghost" id="exportcsv">Download manifest (CSV)</button>
          <p>Your own copy of the ledger: every clip with its video, channel, split,
             ladder level, criteria, verdicts and status. The record of what went
             where, independent of any platform.</p>
        </div>
      </div>
      <p class="foot-note">The deal is deterministic — a channel always lands in the
         same set, this press and every press after it. Test and valid demand
         human-verified boxes in Roboflow before they count; that verification is the
         golden work only an owner can do.</p>
    </section>`;
}

async function exportCsv() {
  const [{ data: clips }, { data: vids }] = await Promise.all([
    supabase.from('pipeline_clips')
      .select('clip_id,video_id,shot_ts,rf_split,label_status,n_shots,outcome,outcome_2,outcome_3,clay_colour,det_conf,range_m,speed_mph,holdout,slo_mo')
      .in('label_status', ['pending', 'queued', 'prelabelled']).limit(5000),
    supabase.from('pipeline_videos')
      .select('video_id,title,channel,weather,ds_level,criteria').limit(5000),
  ]);
  const byVid = new Map((vids || []).map((v) => [v.video_id, v]));
  const cols = ['clip_id', 'video_id', 'title', 'channel', 'split', 'level', 'criteria',
    'weather', 'status', 'shots', 'outcome_1', 'outcome_2', 'outcome_3',
    'clay_colour', 'det_conf', 'range_m', 'speed_mph', 'golden', 'slo_mo'];
  const q = (x) => `"${String(x ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')];
  (clips || []).forEach((k) => {
    const v = byVid.get(k.video_id) || {};
    lines.push([k.clip_id, k.video_id, v.title, v.channel, k.rf_split, v.ds_level,
      v.criteria, v.weather, k.label_status, k.n_shots ?? 1, k.outcome, k.outcome_2,
      k.outcome_3, k.clay_colour, k.det_conf, k.range_m, k.speed_mph,
      k.holdout ? 'yes' : '', k.slo_mo ? 'yes' : ''].map(q).join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `brace-dataset-manifest-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  note(`manifest downloaded — ${lines.length - 1} clips`, 'good');
}

/* ---------- rejected pile ---------- */

// The whole discard pile, paginated — the audit of whether screening's
// no-gate is calling it right. Every card here is a cut the machine swore
// had no clay in it; the owner's job is to catch it lying.
async function loadRejectedPile() {
  const PAGE = 40;
  const [vids, clips] = await Promise.all([
    supabase.from('pipeline_videos')
      .select('video_id,title,channel,triage_score,triage_notes,duration_s,updated_at', { count: 'exact' })
      .eq('status', 'rejected')
      .order(rejSort === 'new' ? 'updated_at' : 'triage_score',
        { ascending: rejSort === 'lo', nullsFirst: false })
      .range(rejPage * PAGE, rejPage * PAGE + PAGE - 1),
    supabase.from('pipeline_clips')
      .select('clip_id,video_id,shot_ts,preview_path,poster_path,file_path,created_at', { count: 'exact' })
      .eq('label_status', 'rejected')
      .order('created_at', { ascending: false })
      .limit(24),
  ]);
  const rows = clips.error ? [] : (clips.data || []);
  await Promise.all([signClipMedia(rows), titleClips(rows)]);
  return {
    vids: vids.error ? [] : (vids.data || []),
    vtotal: vids.error ? 0 : (vids.count ?? 0),
    rows, total: clips.error ? 0 : (clips.count ?? 0),
  };
}

function rejectedView() {
  if (state.loading) return '<div class="empty">Loading the pile…</div>';
  const { vids = [], vtotal = 0, rows = [], total = 0 } = state.pile || {};
  const pages = Math.max(1, Math.ceil(vtotal / 40));
  // A thumbnail per refusal, playing in place when pressed — 460 discards
  // are only auditable if the eye can sweep them.
  const vcard = (v) => `
    <article class="cardv rej ${pilePicked.has(v.video_id) ? 'picked' : ''}" data-pileid="${esc(v.video_id)}">
      <label class="clippick pilebox" title="Select for deletion">
        <input type="checkbox" class="tick" data-pilepick="${esc(v.video_id)}" ${pilePicked.has(v.video_id) ? 'checked' : ''} />
      </label>
      ${watching === v.video_id
    ? `<div class="thumb playing"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.video_id)}?autoplay=1"
         title="Rejected video" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe></div>`
    : `<button class="thumb" data-watch="${esc(v.video_id)}" title="Play here">
         <img src="https://i.ytimg.com/vi/${esc(v.video_id)}/mqdefault.jpg" alt="" loading="lazy"
              onerror="this.remove()" />
         <span class="dur">${mmss(v.duration_s)}</span>
       </button>`}
      <div class="body">
        <div class="score"><b>${v.triage_score == null ? '—' : Number(v.triage_score).toFixed(1)}</b><span>/10</span></div>
        <h2>${esc(v.title || v.video_id)}</h2>
        <div class="meta">${esc(v.channel || 'Unknown channel')} · ${dateFmt(v.updated_at)}</div>
        ${v.triage_notes ? `<p class="notes">${esc(v.triage_notes)}</p>` : ''}
        <div class="judge">
          <button class="btn btn-ghost" data-watch="${esc(v.video_id)}">${watching === v.video_id ? 'Close' : 'Watch here'}</button>
          <button class="btn btn-ghost bad" data-bin="${esc(v.video_id)}">Delete</button>
          <button class="btn btn-ghost" data-force="${esc(v.video_id)}"
            title="You have watched it — fetch it and clip it, whatever triage scored">Force in</button>
        </div>
      </div>
    </article>`;
  const card = (k) => `
    <div class="clipcard">
      <div class="clipmedia">
        ${k.preview_url
    ? `<video controls preload="none" data-path="${esc(k.preview_path || '')}" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>`
    : k.poster_url
      ? `<img src="${esc(k.poster_url)}" alt="" />`
      : '<span class="rendering">Preview rendering — plays here within the hour</span>'}
      </div>
      <div class="clipcap">
        <div class="t">${esc(k.title || k.video_id)}${k.shot_no ? ` — shot ${k.shot_no}` : ''}</div>
        <div class="s">screening saw no clay ·
          <a href="#" class="linky" data-unreject="${esc(k.clip_id)}">not junk — send back</a></div>
      </div>
    </div>`;
  return `
    <div class="crm-head">
      <div>
        <h1>Rejected pile</h1>
        <p>Everything the machine said no to, and why. This page is the measure of
           the filters: spot-check the pile — if it is all talking heads, silent
           edits and empty sky, the gates are earning their keep. Find a good one
           and overrule it; a silent wrong rejection is training data lost.</p>
      </div>
    </div>

    <section class="panel">
      <div class="p-head"><span class="p-title">Videos triage refused — ${fmt(vtotal)}</span>
        <span>
          <button class="linky" id="pileall">Select all shown</button>
          <button class="linky" id="pilenone" style="margin-left:10px">Clear</button>
          <button class="btn mini-btn" id="piledel" style="margin-left:14px"
            ${pilePicked.size ? '' : 'disabled'}>Delete <span id="pilen">${pilePicked.size}</span> from pile</button>
          <select id="rejsort" class="mini" style="margin-left:14px" title="Sort the pile">
          <option value="new" ${rejSort === 'new' ? 'selected' : ''}>Newest first</option>
          <option value="hi" ${rejSort === 'hi' ? 'selected' : ''}>Highest score — near misses</option>
          <option value="lo" ${rejSort === 'lo' ? 'selected' : ''}>Lowest score — clear junk</option>
          </select>
        </span></div>
      ${vids.length ? `<div class="queue">${vids.map(vcard).join('')}</div>`
    : '<div class="empty">Nothing here — triage has refused no videos yet.</div>'}
      ${pages > 1 ? `
      <div class="pager">
        <button class="linky" id="rejprev" ${rejPage ? '' : 'disabled'}>‹ Previous</button>
        <span>page ${rejPage + 1} of ${pages}</span>
        <button class="linky" id="rejnext" ${rejPage + 1 < pages ? '' : 'disabled'}>Next ›</button>
      </div>` : ''}
      <p class="foot-note">Delete removes videos from this pile for good — the row
         stays quietly on the Mastersheet so discovery can never collect them again.
         The reason is triage's own words — a low score, no clays
         in the sampled frames, or the audio gate's 'no gunshots heard'. Watch plays
         the video here; Re-triage sends it back for a fresh score with the current,
         sharper eyes.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Cuts screening refused — ${fmt(total)}</span></div>
      ${rows.length ? `<div class="clipgrid">${rows.map(card).join('')}</div>`
    : `<div class="empty">None — screening has rejected no cuts. Audit that from the
         other side: if junk is reaching the Triage queue, the detection threshold
         is too generous (SCREEN_THRESHOLD in the Modal secret).</div>`}
    </section>`;
}

/* ---------- health ---------- */

// The machine's physical, read from pipeline_health. Probes are written
// server-side (daily cron, or the refresh button); the page only judges
// freshness — a heartbeat that has not stamped the clock in over an hour
// and a half is a dead machine whatever its last status said.
const HEALTH_LABELS = {
  heartbeat: ['Heartbeat', 'the hourly beat that pushes work through every stage'],
  anthropic: ['Claude API', 'triage scoring and shot verdicts — dies silently when credits run out'],
  youtube: ['YouTube API', 'discovery fuel — 10,000 units/day, criteria searches cost ~100 each'],
  cookies: ['YouTube cookies', 'downloads need them; YouTube rotates them without warning'],
  roboflow: ['Roboflow', 'where labelled frames land, split by the judge'],
  backlogs: ['Backlogs', 'work waiting at each stage — errors outrank volume'],
};

async function loadHealth() {
  const { data, error } = await supabase.from('pipeline_health')
    .select('*').order('probe');
  return error ? [] : (data || []);
}

function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 2 ? 'just now' : m < 60 ? `${m}m ago`
    : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

function healthStatus(h) {
  // The heartbeat's status is its age: a stale 'ok' is the failure.
  if (h.probe === 'heartbeat') {
    const mins = (Date.now() - new Date(h.checked_at).getTime()) / 60000;
    if (mins > 150) return ['fail', `no beat for ${Math.round(mins / 60)}h — the hourly cycle has stopped`];
    if (mins > 75) return ['warn', 'beat overdue'];
    return ['ok', h.detail];
  }
  return [h.status, h.detail];
}

function healthView() {
  if (state.loading) return '<div class="empty">Reading the vitals…</div>';
  const rows = state.health || [];
  const worst = rows.reduce((w, h) => {
    const [st] = healthStatus(h);
    return st === 'fail' ? 'fail' : (st === 'warn' && w !== 'fail') ? 'warn' : w;
  }, 'ok');
  const row = (h) => {
    const [st, detail] = healthStatus(h);
    const [label, sub] = HEALTH_LABELS[h.probe] || [h.probe, ''];
    return `
    <div class="row">
      <span class="dot ${st === 'ok' ? 'on' : st === 'warn' ? 'warned' : 'off'}"></span>
      <div class="main">
        <div class="t">${esc(label)} — <span class="${st === 'ok' ? '' : st === 'warn' ? 'h-warn' : 'h-fail'}">${esc(st === 'ok' ? 'healthy' : st === 'warn' ? 'attention' : 'down')}</span></div>
        <div class="s" title="${esc(detail || '')}">${esc(detail || '')}</div>
        <div class="s dim2">${esc(sub)}</div>
      </div>
      <div class="end"><span class="s">${ago(h.checked_at)}</span></div>
    </div>`;
  };
  return `
    <div class="crm-head">
      <div>
        <h1>Health</h1>
        <p>The machine's physical: every dependency the pipeline stands on, probed
           server-side. It checks itself daily at 8am; the button asks for a fresh
           opinion right now.</p>
      </div>
      <button class="btn mini-btn" id="healthrun" ${running ? 'disabled' : ''}>
        ${running === 'health' ? 'Probing…' : 'Run a check-up now'}</button>
    </div>

    <section class="panel ${worst === 'fail' ? 'stat-warn' : ''}">
      <div class="p-head"><span class="p-title">${rows.length ? {
    ok: 'All systems healthy', warn: 'Running, with warnings', fail: 'Something is down',
  }[worst] : 'No check-up recorded yet'}</span></div>
      ${rows.length ? rows.map(row).join('')
    : '<div class="empty">Press the button — the first check-up writes this page, and the daily 8am one keeps it honest.</div>'}
      <p class="foot-note">Probes run on Modal with the pipeline's own keys, so what
         is tested is exactly what production uses: a live one-token Claude call
         (catches an empty credit balance), a one-unit YouTube call (catches spent
         quota), Roboflow reachability, cookie age, and the stage backlogs. The
         heartbeat row is stamped by every hourly beat — its age, not its word, is
         the proof of life.</p>
    </section>

    ${creditPanel()}`;
}

// Anthropic has no balance endpoint, so this is a ledger: what you put in,
// minus what the meter has watched go out. The probe above stays the truth
// about actually-empty; this is the fuel gauge between refills.
function creditPanel() {
  const { rows = [], err = '' } = state.credits || {};
  const inUsd = rows.reduce((a, r) => a + Number(r.amount_usd), 0);
  const outUsd = state.spend?.usd || 0;
  const left = inUsd - outUsd;
  const low = rows.length && left <= 2;
  const topup = (r) => `
    <div class="row">
      <span class="dot on"></span>
      <div class="main">
        <div class="t">$${Number(r.amount_usd).toFixed(2)} added</div>
        <div class="s">${esc(who(r.email))} \u00b7 ${dateFmt(r.noted_at)}</div>
      </div>
      <div class="end">${r.email === state.email
    ? `<button class="linky bad" data-topupdel="${r.id}">Remove</button>` : ''}</div>
    </div>`;
  return `
    <section class="panel ${low ? 'stat-warn' : ''}" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Anthropic credit \u2014 the ledger</span></div>
      ${err ? `<div class="err" style="margin-bottom:12px">${esc(err)}</div>` : ''}
      <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:14px">
        <div class="stat"><div class="num ${low ? 'h-fail' : ''}">${rows.length ? `$${left.toFixed(2)}` : '\u2014'}</div>
          <div class="cap">Estimated remaining</div><div class="sub">top-ups minus metered spend</div></div>
        <div class="stat"><div class="num">$${inUsd.toFixed(2)}</div>
          <div class="cap">Put in</div><div class="sub">${fmt(rows.length)} top-up${rows.length === 1 ? '' : 's'} on record</div></div>
        <div class="stat"><div class="num">$${outUsd.toFixed(2)}</div>
          <div class="cap">Metered out</div><div class="sub">every token since the meter</div></div>
      </div>
      <form id="addtopup" class="formrow" style="margin-bottom:12px">
        <input class="inp" type="number" id="tu-amount" min="1" step="0.01" placeholder="Top-up ($)" required style="max-width:140px" />
        <button class="btn mini-btn" type="submit">Record top-up</button>
      </form>
      ${rows.length ? rows.slice(0, 8).map(topup).join('')
    : '<div class="empty">No top-ups on record. When you add credits at console.anthropic.com, log the amount here and the gauge starts.</div>'}
      <p class="foot-note">Anthropic offers no balance API, so this gauge is
         arithmetic: what you record going in, minus what the pipeline's meter
         watched go out. Spend from before the meter (2 Aug) and any use of the
         key outside the pipeline are invisible to it \u2014 the Claude probe above
         is the final word on empty.</p>
    </section>`;
}


/* ---------- the office: productivity, costs, documents ---------- */

const NAMES = { 'elohughes@icloud.com': 'Eddie', 'rupertokelly98@gmail.com': 'Rupert' };
const who = (e) => NAMES[e] || (e || '').split('@')[0];
const PIE = ['#F05A28', '#4ECDC4', '#CBBE93', '#6FBE72', '#E0705F', '#8f9bff'];
const today = () => new Date().toISOString().slice(0, 10);
const gbp = (n) => `£${Number(n).toFixed(2)}`;

// The office pie: conic-gradient does the slicing, a hole punched by a
// pseudo-element, a legend carrying the numbers. Named pie because the
// findings section has its own donut() and Safari refuses two of a name.
function pie(slices, title) {
  const total = slices.reduce((a, x) => a + x.v, 0);
  if (!total) return '<div class="empty">Nothing logged yet.</div>';
  let acc = 0;
  const stops = slices.map((x, i) => {
    const from = (acc / total) * 100; acc += x.v;
    return `${PIE[i % PIE.length]} ${from}% ${(acc / total) * 100}%`;
  }).join(', ');
  const leg = slices.map((x, i) =>
    `<span><i style="background:${PIE[i % PIE.length]}"></i>${esc(x.label)} — ${x.text}</span>`).join('');
  return `
    <div class="piewrap">
      <div class="pie" style="background:conic-gradient(${stops})"><span>${esc(title)}</span></div>
      <div class="pielegend">${leg}</div>
    </div>`;
}

async function loadProd() {
  const [tasks, rep] = await Promise.all([
    supabase.from('todos').select('*')
      .order('created_at', { ascending: false }).limit(200),
    supabase.rpc('productivity_report', { since: windowStart(scoreWindow) }),
  ]);
  return {
    tasks: tasks.data || [], report: rep.error ? null : rep.data,
    err: tasks.error?.message || rep.error?.message || '',
  };
}

async function loadCosts() {
  const { data, error } = await supabase.from('expenses').select('*')
    .order('bought_on', { ascending: false }).order('id', { ascending: false }).limit(300);
  return { rows: data || [], err: error?.message || '' };
}

async function loadDocs() {
  try {
    const { data, error } = await supabase.storage.from('documents')
      .list('', { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
    if (error) return { rows: [], err: error.message };
    return { rows: (data || []).filter((f) => f.name !== '.emptyFolderPlaceholder'), err: '' };
  } catch (e) { return { rows: [], err: String(e && e.message || e) }; }
}

const KANBAN = [
  ['not_started', 'Not started'],
  ['in_progress', 'In progress'],
  ['complete', 'Complete'],
];

function productivityView() {
  if (state.loading) return '<div class="empty">Loading…</div>';
  const { tasks = [], report, err = '' } = state.prod || {};
  const hours = (report && report.hours) || {};
  const calls = (report && report.calls) || {};
  const mach = (report && report.machine) || {};
  const hrs = (secs) => `${Math.round((Number(secs) || 0) / 360) / 10}h`;
  const label = ((SCOREBOARDS.find((w) => w[0] === scoreWindow) || [])[1] || '').toLowerCase();

  const person = (email, key) => `
    <div class="stat owner-${key}">
      <div class="num">${hrs(hours[email])}</div>
      <div class="cap">${esc(who(email))}</div>
      <div class="sub">${fmt(calls[key] || 0)} clips called</div>
    </div>`;

  const machRow = (t, v, sub) => `
    <div class="row"><div class="main"><div class="t">${t}</div>
      <div class="s">${sub}</div></div>
      <div class="end"><b>${fmt(v || 0)}</b></div></div>`;

  return `
    <div class="crm-head">
      <div>
        <h1>Productivity</h1>
        <p>Measured, not entered. Time banks while the portal is in front of you and
           you are working in it, and stops when you go idle or look away — so what
           is here is time at the work rather than time with the tab open. The
           machine's own output is counted the same way, from what it actually
           produced.</p>
      </div>
      <select id="scorewin" class="mini" title="The window everything here counts over">
        ${SCOREBOARDS.map(([v, l]) => `<option value="${v}" ${scoreWindow === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    ${err ? `<div class="err" style="margin-bottom:14px">${esc(err)}</div>` : ''}

    <div class="p-head" style="margin-bottom:10px">
      <span class="p-title">At the work — ${esc(label)}</span></div>
    <div class="stats scoreboard">
      ${person('elohughes@icloud.com', 'eddie')}
      ${person('rupertokelly98@gmail.com', 'rupert')}
      <div class="stat">
        <div class="num">${hrs(Object.values(hours).reduce((a, v) => a + Number(v || 0), 0))}</div>
        <div class="cap">Between you</div>
        <div class="sub">${fmt(Object.values(calls).reduce((a, v) => a + Number(v || 0), 0))} clips called</div>
      </div>
    </div>

    <section class="panel" style="margin-bottom:18px">
      <div class="p-head"><span class="p-title">What the machine did — ${esc(label)}</span></div>
      ${machRow('Videos triaged', mach.triaged, 'downloaded, listened to and scored')}
      ${machRow('Videos judged', mach.judged, 'approved by you and cut, or waiting to be')}
      ${machRow('Clips cut', mach.clipped, 'one per shot the ears found')}
      ${machRow('Clips screened', mach.screened, 'a clay found, trimmed to the flight')}
      ${machRow('Clips boxed', mach.boxed, 'first-pass boxes drawn and uploaded')}
      <p class="foot-note">Every figure on this page is read from what happened —
         hours from time actually spent in the portal, calls from the clips you
         called, the rest from what the pipeline produced. There is nothing to fill
         in, and nothing that can be filled in: an hour cannot be added by hand
         because an hour nobody worked is worse than no figure at all.</p>
    </section>

    <section class="panel" style="margin-bottom:18px">
      <div class="p-head"><span class="p-title">The board — drag a task between lanes</span></div>
      <form id="addtask" class="formrow" style="margin-bottom:14px">
        <input class="inp grow" type="text" id="task-title" placeholder="What needs doing?" required />
        <button class="btn mini-btn" type="submit">Add</button>
      </form>
      <div class="kanban">
        ${KANBAN.map(([key, label]) => {
    const lane = tasks.filter((t) => (t.status || 'not_started') === key);
    return `
        <div class="kcol" data-col="${key}">
          <div class="khead">${label} <b>${fmt(lane.length)}</b></div>
          ${lane.map((t) => `
          <div class="kcard ${key === 'complete' ? 'kdone' : ''}" draggable="true" data-task="${t.id}">
            <div class="t ${key === 'complete' ? 'struck' : ''}">${esc(t.title)}</div>
            <div class="s">${esc(who(t.added_by))} · ${dateFmt(key === 'complete' && t.done_at ? t.done_at : t.created_at)}</div>
            <button class="kdel" data-taskdel="${t.id}" title="Delete">×</button>
          </div>`).join('') || '<div class="kempty">Drop here</div>'}
        </div>`;
  }).join('')}
      </div>
    </section>`;
}

const COST_CATS = ['Software subscription', 'Hardware', 'Data & AI', 'Shooting', 'Other'];

// A recurring purchase's weight on one month's bill.
const MONTHLY = { weekly: 52 / 12, monthly: 1, yearly: 1 / 12 };

function costsView() {
  if (state.loading) return '<div class="empty">Loading…</div>';
  const { rows = [], err = '' } = state.costs || {};
  const total = rows.reduce((a, r) => a + Number(r.amount), 0);
  const month = today().slice(0, 7);
  const thisMonth = rows.filter((r) => (r.bought_on || '').startsWith(month))
    .reduce((a, r) => a + Number(r.amount), 0);
  const forecast = rows.filter((r) => MONTHLY[r.recurrence])
    .reduce((a, r) => a + Number(r.amount) * MONTHLY[r.recurrence], 0);
  const byCat = new Map();
  const byPerson = new Map();
  rows.forEach((r) => {
    byCat.set(r.category, (byCat.get(r.category) || 0) + Number(r.amount));
    byPerson.set(r.email, (byPerson.get(r.email) || 0) + Number(r.amount));
  });
  const spent = (e) => rows.filter((r) => r.email === e)
    .reduce((a, r) => a + Number(r.amount), 0);
  const catSlices = [...byCat.entries()].sort((a, b) => b[1] - a[1])
    .map(([c, v]) => ({ label: c, v, text: gbp(v) }));
  const perSlices = [...byPerson.entries()]
    .map(([e, v]) => ({ label: who(e), v, text: gbp(v) }));

  const row = (r) => `
    <div class="row">
      <span class="dot on"></span>
      <div class="main">
        <div class="t">${esc(r.item)}</div>
        <div class="s">${esc(r.category)} · ${esc(who(r.email))} · ${dateFmt(r.bought_on)}${r.recurrence && r.recurrence !== 'one-time' ? ` · <span class="rec-tag">${esc(r.recurrence)}</span>` : ''}</div>
      </div>
      <div class="end"><span class="s"><b>${gbp(r.amount)}</b></span>
        ${r.email === state.email ? `<button class="linky bad" data-costdel="${r.id}">Remove</button>` : ''}</div>
    </div>`;

  return `
    <div class="crm-head">
      <div>
        <h1>Costs</h1>
        <p>Every pound the company spends, who spent it and on what. The AI spend
           on Home is metered automatically; this is everything bought by hand.</p>
      </div>
    </div>
    ${err ? `<div class="err" style="margin-bottom:14px">${esc(err)}</div>` : ''}

    <div class="stats" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
      <div class="stat"><div class="num">${gbp(total)}</div>
        <div class="cap">Total expenses</div><div class="sub">${fmt(rows.length)} purchases, all time</div></div>
      <div class="stat"><div class="num">${gbp(thisMonth)}</div>
        <div class="cap">This month</div><div class="sub">logged since the 1st</div></div>
      <div class="stat"><div class="num">${gbp(forecast)}</div>
        <div class="cap">Next month, forecast</div><div class="sub">what the subscriptions will take</div></div>
      <div class="stat"><div class="num">${gbp(spent('elohughes@icloud.com'))}</div>
        <div class="cap">Eddie</div><div class="sub">all time</div></div>
      <div class="stat"><div class="num">${gbp(spent('rupertokelly98@gmail.com'))}</div>
        <div class="cap">Rupert</div><div class="sub">all time</div></div>
    </div>

    <div class="grid">
      <section class="panel">
        <div class="p-head"><span class="p-title">Log a purchase</span></div>
        <form id="addcost" class="formcol">
          <input class="inp" type="text" id="ac-item" placeholder="What was bought?" required />
          <input class="inp" type="number" id="ac-amount" min="0" step="0.01" placeholder="Amount (£)" required />
          <select class="inp" id="ac-cat">
            ${COST_CATS.map((c) => `<option>${c}</option>`).join('')}
          </select>
          <input type="hidden" id="ac-rec" value="one-time" />
          <div class="pillrow">
            <button type="button" class="callbtn on" data-costkind="one-time">One time</button>
            <button type="button" class="callbtn" data-costkind="rec">Recurring</button>
            <span id="ac-freqs" style="display:none">
              <button type="button" class="callbtn" data-costfreq="weekly">Weekly</button>
              <button type="button" class="callbtn on" data-costfreq="monthly">Monthly</button>
              <button type="button" class="callbtn" data-costfreq="yearly">Yearly</button>
            </span>
          </div>
          <button class="btn" type="submit">Log purchase</button>
        </form>
      </section>
      <section class="panel">
        <div class="p-head"><span class="p-title">Where it goes</span></div>
        ${pie(catSlices, gbp(total))}
        <div style="height:18px"></div>
        ${perSlices.length > 1 ? pie(perSlices, 'who') : ''}
      </section>
    </div>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">The book — newest first</span></div>
      ${rows.length ? rows.slice(0, 40).map(row).join('')
    : '<div class="empty">Nothing bought yet — or nothing owned up to.</div>'}
    </section>`;
}

function documentsView() {
  if (state.loading) return '<div class="empty">Loading…</div>';
  const { rows = [], err = '' } = state.docs || {};
  const size = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB`
    : b > 1024 ? `${Math.round(b / 1024)} KB` : `${b || 0} B`);
  const used = rows.reduce((a, f) => a + (f.metadata?.size || 0), 0);
  const row = (f) => `
    <div class="row">
      <span class="dot on"></span>
      <div class="main">
        <div class="t">${esc(f.name.replace(/^\d+-/, ''))}</div>
        <div class="s">${size(f.metadata?.size || 0)} · ${dateFmt(f.created_at)}</div>
      </div>
      <div class="end">
        <button class="linky" data-docdl="${esc(f.name)}">Open</button>
        <button class="linky bad" data-docdel="${esc(f.name)}">Delete</button>
      </div>
    </div>`;
  return `
    <div class="crm-head">
      <div>
        <h1>Documents</h1>
        <p>The company's shelf: decks, market research, agreements — anything worth
           both of you being able to reach. Private to owners, like everything here.</p>
      </div>
      <button class="btn mini-btn" id="doccompose">New document</button>
      <button class="btn mini-btn" id="docpick">Upload</button>
      <input type="file" id="docupload" multiple style="display:none" />
    </div>
    ${err ? `<div class="err" style="margin-bottom:14px">${esc(err)}</div>` : ''}
    <section class="panel" id="composer" style="display:none;margin-bottom:18px">
      <div class="p-head"><span class="p-title">A new document, written here</span></div>
      <div class="formcol">
        <input class="inp" type="text" id="doc-title" placeholder="Title" />
        <textarea class="inp doc-body" id="doc-body" placeholder="Write. Markdown works: # headings, **bold**, - lists."></textarea>
        <div class="formrow">
          <button class="btn mini-btn" id="docsave" type="button">Save to the shelf</button>
        </div>
      </div>
    </section>
    <section class="panel" style="margin-bottom:18px">
      <div class="p-head"><span class="p-title">Living documents</span></div>
      <div class="row">
        <span class="dot on"></span>
        <div class="main">
          <div class="t">Dataset strategy</div>
          <div class="s">The complexity ladder and its live counts — a page, not a file, so it is never stale.</div>
        </div>
        <div class="end"><a class="linky" href="#strategy">Open</a></div>
      </div>
    </section>
    <section class="panel">
      <div class="p-head"><span class="p-title">${fmt(rows.length)} document${rows.length === 1 ? '' : 's'} · ${size(used)} of 100 GB on the plan</span></div>
      ${rows.length ? rows.map(row).join('')
    : '<div class="empty">Empty shelf. Write one here, or upload the deck.</div>'}
      <p class="foot-note">Files live in the same private storage as the clip previews,
         behind the same owners-only rule; Open mints a one-hour signed link. The plan
         holds a hundred gigabytes across everything — room for every deck this
         company will ever write.</p>
    </section>`;
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
      record(stage, `${stage} started — still running on Modal`);
    } else if (res.ok) {
      const { stage: _s, ...rest } = body;
      const said = Object.entries(rest).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ');
      note(`${stage} finished${said ? ` — ${said}` : ''}`, 'good');
      record(stage, `${stage} finished${said ? ` — ${said}` : ''}`, 'good');
    } else {
      // error is the headline, detail is the way out — show both when present.
      const why = [body.error, body.detail].filter(Boolean).join(': ') || plain() || 'no detail';
      note(`${stage} failed (${res.status}) — ${why}`, 'bad');
      record(stage, `${stage} failed (${res.status}) — ${why}`, 'bad');
    }
  } catch (e) {
    note(`${stage} could not be reached — ${e.message || e}`, 'bad');
    record(stage, `${stage} could not be reached — ${e.message || e}`, 'bad');
  }
  running = null;
  if (dashboardIsCurrent()) await refresh();
}

/* ---------- shell ---------- */

const viewFromHash = () => ['control', 'review', 'sources', 'triage', 'labelling', 'impossible', 'findings', 'mastersheet', 'strategy', 'export', 'health', 'rejected', 'productivity', 'costs', 'documents'].find((v) => location.hash === `#${v}`) || 'office';
let view = viewFromHash();
let state = { email: '', counts: null, queue: [], sources: [], issues: [], spend: null, coverage: [], clips: [], sent: [], rej: { rows: [], total: 0 }, ai: [], sheet: [], sheetErr: '', progress: [], cats: [], split: [], exp: null, health: [], pile: { rows: [], total: 0 }, trials: null, prod: null, costs: null, docs: null, disc: [], activity: [], credits: null, models: [], findings: null, partners: [], scores: null, impossible: [], clipTotal: null, loading: true };
let sheetFilter = 'all';
let watching = null;   // video_id with its player open on the rejected audit
let clipPage = 0;   // 40 clips a page, grouped by video
let rejPage = 0;    // the rejected pile pages the same way
let rejSort = 'new';   // new | hi | lo — the pile's sort order
let aiSort = 'new';    // new | hi | lo — labelling, by verdict confidence
const pilePicked = new Set();   // rejected videos ticked for binning
const queuePicked = new Set();  // review-queue videos ticked for binning
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

const AGENTIC_VIEWS = ['control', 'review', 'sources', 'triage', 'rejected',
  'labelling', 'impossible', 'mastersheet', 'export', 'health'];

/* The portal's front door: four rooms, pick one. The wordmark up top
   always leads back here. */
function officeView() {
  const room = (hash, name, blurb, badge = 0) => `
    <a class="room" href="#${hash}">
      <div class="room-name">${name}${badge ? ` <b>${fmt(badge)}</b>` : ''}</div>
      <div class="room-blurb">${blurb}</div>
    </a>`;
  return `
    <div class="head"><h1>Owners portal</h1>
      <div class="sub">Where Brace is run.</div></div>
    <div class="rooms">
      ${room('control', 'Agentic', 'The pipeline — discovery, triage, review, labelling and export.',
    (state.counts?.pending || 0) + (state.counts?.downloaded || 0))}
      ${room('productivity', 'Productivity', 'The task list, and who worked which hours on what.',
    state.counts?.todo)}
      ${room('costs', 'Costs', 'Who bought what, and where the money goes.')}
      ${room('documents', 'Documents', 'Decks, market research and everything worth keeping.')}
    </div>`;
}

function shell(body) {
  root.dataset.up = '1';
  const item = (hash, label, badge = 0) => `
    <a href="#${hash}" class="${view === hash ? 'on' : ''}">${label}
      ${badge ? `<b>${fmt(badge)}</b>` : ''}</a>`;
  root.innerHTML = `
    <div class="crm">
      <aside class="side">
        <a class="brand" href="#" title="Portal home"><img src="../assets/brand/brace-wordmark-white.svg" alt="Brace" width="3579" height="732" /></a>
        <nav class="views">
          ${AGENTIC_VIEWS.includes(view) ? `
          <a href="#control" class="navhead on">Agentic</a>
          <div class="groupnav">
          ${item('control', 'Home')}
          ${item('sources', 'Sources')}
          ${item('triage', 'Triage', state.counts?.pending)}
          <a href="#rejected" class="sub ${view === 'rejected' ? 'on' : ''}">Rejected pile${(state.pile?.vtotal || 0) + (state.pile?.total || 0) ? ` <b>${fmt((state.pile?.vtotal || 0) + (state.pile?.total || 0))}</b>` : ''}</a>
          ${item('review', 'Review', state.counts?.downloaded)}
          ${item('labelling', 'Labelling', state.counts?.queued)}
          ${item('impossible', 'The impossible', state.counts?.impossible)}
          ${item('mastersheet', 'Mastersheet')}
          ${item('export', 'Export')}
          ${item('health', 'Health', (state.health || []).filter((h) => healthStatus(h)[0] !== 'ok').length)}
          </div>` : `
          <a href="#control" class="navhead">Agentic</a>`}
          <a href="#partnerships" class="navhead ${view === 'partnerships' ? 'on' : ''}">Partnerships${(state.partners || []).filter((p) => p.status === 'agreed').length ? ` <b>${fmt((state.partners || []).filter((p) => p.status === 'agreed').length)}</b>` : ''}</a>
          <a href="#findings" class="navhead ${view === 'findings' ? 'on' : ''}">Findings</a>
          <a href="#productivity" class="navhead ${view === 'productivity' ? 'on' : ''}">Productivity${state.counts?.todo ? ` <b>${fmt(state.counts.todo)}</b>` : ''}</a>
          <a href="#costs" class="navhead ${view === 'costs' ? 'on' : ''}">Costs</a>
          <a href="#documents" class="navhead ${view === 'documents' || view === 'strategy' ? 'on' : ''}">Documents</a>
        </nav>
        <div class="side-foot">
          ${state.spend && state.spend.usd
    ? `<div class="side-line">~$${state.spend.usd.toFixed(2)} spent on AI</div>` : ''}
          <div class="side-line" title="The build this page was served from. If this is not the newest, the deploy has not landed and a hard refresh is the first thing to try.">build ${BUILD}</div>
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
  const c = state.counts || {};
  const n = (k) => (c[k] != null ? fmt(c[k]) : '—');

  // The three gates only a human can open. Everything else on this page is
  // the machine reporting; this is the page's actual job.
  const gates = [
    { href: '#review', num: c.downloaded ?? 0, label: 'videos to review',
      sub: 'approve what is worth cutting' },
    { href: '#triage', num: c.pending ?? 0, label: 'clips to check',
      sub: 'clay-verified, trimmed to the flight' },
    { href: ROBOFLOW_ANNOTATE, num: c.prelabelled ?? 0, label: 'in Roboflow to verify',
      sub: 'the golden work — boxes checked by hand', out: true },
  ];

  // Where work is sitting, read left to right. A step with nothing in it is
  // a hairline; a step holding work lights up, so the shape of the backlog
  // arrives in one glance instead of six equal cards.
  const flow = (steps) => `
    <div class="flow">
      ${steps.map((s, i) => `
        ${i ? '<span class="flow-arrow">›</span>' : ''}
        <div class="flow-step ${s.v ? 'on' : ''} ${s.warn && s.v ? 'bad' : ''}">
          <div class="fnum">${fmt(s.v)}</div>
          <div class="flab">${s.label}</div>
        </div>`).join('')}
    </div>`;

  // The machine's own line: is it beating, is it well, what has it spent.
  const hb = (state.health || []).find((h) => h.probe === 'heartbeat');
  const unwell = (state.health || []).filter((h) => healthStatus(h)[0] !== 'ok').length;

  return `
    <div class="crm-head">
      <div>
        <h1>Home</h1>
        <p>Third-party footage in, labelled clays out. The machine runs itself every
           hour; what is below is what it needs from you, and where the work sits.</p>
      </div>
      ${c.error ? `<a href="#" id="retry" class="p-act warn">Send ${n('error')} errored back</a>` : ''}
    </div>

    <div class="gates">
      ${gates.map((g) => `
        <a class="gatecard ${g.num ? 'live' : ''}" href="${esc(g.href)}"
           ${g.out ? 'target="_blank" rel="noopener"' : ''}>
          <div class="g-num">${fmt(g.num)}</div>
          <div class="g-lab">${g.label}${g.out ? ' ↗' : ''}</div>
          <div class="g-sub">${g.sub}</div>
        </a>`).join('')}
    </div>

    <div class="machine">
      <span class="m-dot ${hb && healthStatus(hb)[0] === 'ok' ? 'on' : hb ? 'bad' : ''}"></span>
      <span>${hb ? `Last beat ${ago(hb.checked_at)}` : 'No beat recorded yet'}</span>
      <span class="m-sep">·</span>
      <a href="#health">${unwell ? `${unwell} probe${unwell === 1 ? '' : 's'} need attention`
    : 'all systems healthy'}</a>
      ${state.spend && state.spend.usd ? `<span class="m-sep">·</span>
        <span title="${esc(state.spend.rows.map((r) => `${r.model}: ${fmt(r.calls)} calls, $${r.usd.toFixed(2)}`).join(' · '))}">~$${state.spend.usd.toFixed(2)} spent on AI</span>` : ''}
    </div>

    ${state.spend && state.spend.rows.length > 1 ? `
    <section class="panel" style="margin-bottom:18px">
      <div class="p-head"><span class="p-title">What the thinking costs — $${state.spend.usd.toFixed(2)} all told</span></div>
      <table class="matrix">
        <thead><tr><th>Model</th><th>Calls</th><th>Cost</th></tr></thead>
        <tbody>
          ${state.spend.rows.map((r) => `
          <tr><td>${esc(r.model)}</td><td>${fmt(r.calls)}</td><td>$${r.usd.toFixed(2)}</td></tr>`).join('')}
        </tbody>
      </table>
      <p class="foot-note">Triage scores each video once; verdicts judge each bang,
         so a pair costs two calls and a burst three. Re-judging the whole library
         after an improvement costs a full pass again — which is where fifteen
         dollars went in a single day, unseen, before this table existed.</p>
    </section>` : ''}

    <section class="panel">
      <div class="p-head"><span class="p-title">Where the work is sitting</span>
        <a class="p-act" href="#" id="refresh">Refresh</a></div>
      <div class="flow-label">Videos</div>
      ${flow([
    { v: c.discovered ?? 0, label: 'found' },
    { v: c.downloaded ?? 0, label: 'triaged' },
    { v: c.approved ?? 0, label: 'approved' },
    { v: c.clipped ?? 0, label: 'clipped' },
    { v: c.error ?? 0, label: 'errored', warn: true },
  ])}
      <div class="flow-label">Clips</div>
      ${flow([
    { v: c.raw ?? 0, label: 'screening' },
    { v: c.pending ?? 0, label: 'to check' },
    { v: c.queued ?? 0, label: 'queued' },
    { v: c.prelabelled ?? 0, label: 'in Roboflow' },
  ])}
      <p class="foot-note">The hourly beat moves work rightwards on its own: triage
         what discovery found, clip what you approved, screen what was cut, upload
         what you sent. A step that stays lit for hours is where to look, and the
         Health page says whether the beat is still running.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Run by hand</span>
        <span class="s">the beat never reaches these on its own</span></div>
      <div class="runrow" style="margin-top:10px">
        ${RUNS.filter((r) => r.hand).map((r) => `
          <button class="btn btn-ghost mini-btn" data-stage="${r.stage}"
            title="${esc(r.desc)}" ${running ? 'disabled' : ''}>
            ${running === r.stage ? `${r.busy}…` : r.label}</button>`).join('')}
      </div>
      <p class="foot-note">Re-judging calls the outcome again on clips already
         judged — worth a pass after any change to tracking or crop size, since
         a clip judged before one was judged on less than the model can see now.
         Scrubbing re-filters stored boxes. Climbing takes the next rung early
         rather than waiting for the beat.</p>
    </section>

    <div class="grid" style="margin-top:18px">
      <section class="panel">
        <div class="p-head"><span class="p-title">The machine runs itself</span></div>
        <p class="foot-note" style="margin-top:0">Every half hour the beat takes each
           stage as far as it will go rather than one batch and stopping — triage what
           was found, cut what you approved, screen what was cut, box what was sent —
           and it keeps going until the queue is empty or the half hour is up. An
           errored video is put back for another attempt instead of being left. There
           is nothing here you need to press.</p>
        <details class="handrun">
          <summary>Push a stage through early</summary>
          <div class="p-head" style="margin-top:10px"><span class="p-title">Run a stage by hand</span>
            <select id="batch" class="mini" title="How many videos one press works through — the cost dial">
              ${[3, 10, 25, 50].map((v) => `<option value="${v}" ${v === batch ? 'selected' : ''}>${v} at a time</option>`).join('')}
              <option value="500" ${batch === 500 ? 'selected' : ''}>everything in the queue</option>
            </select></div>
          <div class="runrow">
            ${RUNS.filter((r) => !r.hand).map((r) => `
              <button class="btn ${r.primary ? '' : 'btn-ghost'} mini-btn" data-stage="${r.stage}"
                title="${esc(r.desc)}" ${running ? 'disabled' : ''}>
                ${running === r.stage ? `${r.busy}…` : r.label}</button>`).join('')}
          </div>
          <p class="foot-note">Only for when you cannot wait for the next beat. Discover
             answers here and now; the rest run on Modal and outlive the request, so
             "still running" is Modal working, not a failure.</p>
        </details>
      </section>

      <section class="panel">
        <div class="p-head"><span class="p-title">Activity</span></div>
        ${feed().length ? feed().map((l, i) => `
          <div class="line ${l.tone} ${i === 0 ? 'fresh' : ''}">
            <span class="t">${l.t}</span><span class="m">${esc(l.line)}</span>
          </div>`).join('') : '<div class="empty">Nothing run yet — the machine does not need you to press anything.</div>'}
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
  // The headline is the true backlog — the sidebar's number — not merely
  // how many cards this page happened to load.
  const total = Math.max(state.counts?.downloaded ?? 0, q.length);
  return `
    <div class="page-head">
      <div class="over">Review queue</div>
      <h1>${total ? `${fmt(total)} ${total === 1 ? 'video' : 'videos'} waiting on you.` : 'Nothing waiting on you.'}</h1>
      <p>Triage has already thrown out the obvious misses. What is left is footage the
         model thinks is worth the GPU time. Approve it and the clipper cuts it into
         shots; reject it and it goes no further.${total > q.length
    ? ` Showing the ${fmt(q.length)} highest-scored — judging these pulls the rest through.` : ''}</p>
    </div>
    ${q.length ? `
    <div class="p-head" style="margin-bottom:14px">
      <span class="p-title">Tick to clear several at once</span>
      <span>
        <button class="linky" id="qall">Select all shown</button>
        <button class="linky" id="qnone" style="margin-left:10px">Clear</button>
        <button class="btn btn-ghost mini-btn" id="qdel" style="margin-left:14px"
          ${queuePicked.size ? '' : 'disabled'}>Delete <span id="qn">${queuePicked.size}</span></button>
      </span>
    </div>
    <div class="queue">${q.map(card).join('')}</div>`
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
    <article class="cardv ${queuePicked.has(v.video_id) ? 'picked' : ''}" data-id="${esc(v.video_id)}" data-qid="${esc(v.video_id)}">
      <label class="clippick pilebox" title="Select for deletion">
        <input type="checkbox" class="tick" data-qpick="${esc(v.video_id)}" ${queuePicked.has(v.video_id) ? 'checked' : ''} />
      </label>
      <a class="thumb" href="${esc(href)}" target="_blank" rel="noopener">
        <img src="https://i.ytimg.com/vi/${esc(v.video_id)}/mqdefault.jpg" alt="" loading="lazy"
             onerror="this.remove()" />
        <span class="dur">${mmss(v.duration_s)}</span>
      </a>
      <div class="body">
        <div class="score"><b>${score}</b><span>/10</span></div>
        <h2>${esc(v.title || v.video_id)}</h2>
        <div class="meta">${esc(v.channel || 'Unknown channel')}${v.view_count ? ` · ${fmt(v.view_count)} views` : ''}</div>
        ${v.criteria || v.ds_level ? `
        <div class="crit">
          ${v.criteria ? `<span class="crit-tag">${esc(v.criteria)}</span>` : ''}
          ${v.ds_level ? `<span class="crit-tag lv" title="${esc((DS_LADDER[v.ds_level - 1] || {}).sub || '')}">L${v.ds_level} · ${esc((DS_LADDER[v.ds_level - 1] || {}).name || '')}</span>` : ''}
        </div>` : ''}
        ${v.triage_notes ? `<p class="notes">${esc(v.triage_notes)}</p>` : ''}
        <div class="judge">
          <button class="btn" data-act="approved">Approve</button>
          <button class="btn btn-ghost" data-act="rejected">Reject</button>
          <select class="mini" data-dslevel="${esc(v.video_id)}" title="Place this footage on the dataset ladder as you approve it">
            <option value="">L—</option>
            ${DS_LADDER.map((l) => `<option value="${l.n}" ${v.ds_level === l.n ? 'selected' : ''}>L${l.n}</option>`).join('')}
          </select>
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
let sweeping = false;      // Select multiple: drag across cards to pick them
let sweepDown = false;
window.addEventListener('mouseup', () => {
  sweepDown = false;
  document.body.classList.remove('is-dragging');
});

// Press on a card and pull the mouse across its neighbours — the same sweep
// the Triage grid uses, for any page with a card and a tick. The card keeps
// its own buttons: a press that lands on one is left alone, so Watch here,
// Re-triage and Force in still work.
function wireSweep(cards, idOf, pickedSet, sync) {
  const apply = (card, on) => {
    const id = idOf(card);
    if (!id) return;
    on ? pickedSet.add(id) : pickedSet.delete(id);
    card.classList.toggle('picked', on);
    const cb = card.querySelector('input[type=checkbox]');
    if (cb) cb.checked = on;
    sync();
  };
  cards.forEach((card) => {
    card.addEventListener('mousedown', (e) => {
      if (e.target.closest('button, a, select, textarea, iframe, video')) return;
      e.preventDefault();
      sweepDown = true;
      document.body.classList.add('is-dragging');
      apply(card, !pickedSet.has(idOf(card)));
    });
    card.addEventListener('mouseenter', () => { if (sweepDown) apply(card, true); });
  });
}

// Trimming a clip by hand. The clipper cuts on sound, so it cannot know
// that a clay flew out of frame and the same clay was shot ten seconds
// later — it hears two bangs and cuts around both, or around the wrong one.
// The eye can see it in a moment, so the eye gets the controls.
//
// Every edit is in absolute seconds into the source video, which is what
// clip_start and clip_end mean. The preview plays the cut as it stands, so
// the playhead maps straight across: absolute = clip_start + currentTime.
// That makes "start here" and "end here" exact rather than a guess.
// The card last worked on. Trimming one, calling it, or simply playing it
// leaves a mark, because a grid of forty near-identical clips gives the eye
// nothing to come back to — you adjust a length, look away, and cannot find
// which one it was.
let lastTouched = null;

function touchCard(id) {
  if (!id || id === lastTouched) return;
  lastTouched = id;
  // Moved in place: a repaint here would tear down the very video that is
  // probably playing, which is what the mark exists to help you return to.
  document.querySelectorAll('.clipcard.last-touched')
    .forEach((c) => c.classList.remove('last-touched'));
  document.querySelector(`.clipcard[data-clip="${CSS.escape(id)}"]`)
    ?.classList.add('last-touched');
}

// The clock that measures work instead of asking for it.
//
// Time only banks while the page is in front of you and you are doing
// something with it: a pointer move, a key, a scroll, a call saved. Go idle
// for two minutes, switch tab, or lock the screen and it stops — so what
// lands in Productivity is time at the work, not time with the tab open.
// Banked in half-minutes through a function that can only ever add a small
// amount to your own row, never set a total.
const IDLE_AFTER = 120_000;      // two minutes without a sign of life
let lastSeen = Date.now();
let unbanked = 0;                // active milliseconds not yet written

function stirred() { lastSeen = Date.now(); }

async function bankTime() {
  const now = Date.now();
  const awake = !document.hidden && (now - lastSeen) < IDLE_AFTER;
  if (awake) unbanked += 15_000;      // the tick we just lived through
  if (unbanked < 30_000) return;
  const seconds = Math.round(unbanked / 1000);
  unbanked = 0;
  try { await supabase.rpc('log_activity', { seconds }); }
  catch { unbanked += seconds * 1000; }   // keep it for the next tick
}

// Wired once against the document, not per repaint: these must survive the
// markup being replaced, and re-binding them each time would stack handlers.
let globalsWired = false;
function wireGlobals() {
  if (globalsWired) return;
  globalsWired = true;

  // One clip at a time. Two previews talking over each other is not review,
  // and with forty on a page it was easy to leave several running.
  document.addEventListener('play', (e) => {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement)) return;
    document.querySelectorAll('video').forEach((o) => {
      if (o !== v && !o.paused) o.pause();
    });
    touchCard(v.closest('.clipcard')?.dataset.clip);
  }, true);   // capture: 'play' does not bubble

  document.addEventListener('pointerdown', (e) => {
    const card = e.target.closest?.('.clipcard[data-clip]');
    if (card) touchCard(card.dataset.clip);
  }, true);

  // Space rewatches the clip under the cursor, full screen, from the top.
  //
  // Pressing space used to scroll the page, which on a grid of forty cards
  // means losing the clip you were looking at — the one key you reach for
  // to see a shot again was the one that took you away from it. It now
  // replays whatever is under the pointer, or the last card worked on if
  // the pointer is elsewhere, and Escape comes back out.
  // Which card the pointer is over. pointerover fires on every element
  // boundary the mouse crosses, so this used to walk the tree hundreds of
  // times a second across the whole document. pointermove on the grid
  // alone, throttled to once a frame, answers the same question for a
  // fraction of the work.
  let hoverCard = null;
  let hoverPending = false;
  document.addEventListener('pointermove', (e) => {
    if (hoverPending) return;
    hoverPending = true;
    const { target } = e;
    requestAnimationFrame(() => {
      hoverPending = false;
      const c = target instanceof Element ? target.closest('.clipcard[data-clip]') : null;
      if (c) hoverCard = c.dataset.clip;
    });
  }, { passive: true });

  const goFullscreen = (el) => {
    const go = el.requestFullscreen || el.webkitRequestFullscreen
      || el.webkitEnterFullscreen || el.msRequestFullscreen;
    if (go) Promise.resolve(go.call(el)).catch(() => el.closest('.clipmedia')?.classList.add('blown'));
    else el.closest('.clipmedia')?.classList.add('blown');
  };

  const replay = (card) => {
    const box = card.querySelector('.clipmedia');
    if (!box) return;
    const video = box.querySelector('video');
    if (video) {
      video.currentTime = 0;
      video.play().catch(() => {});
      goFullscreen(video);
      return;
    }
    const frame = box.querySelector('iframe');
    if (frame) return goFullscreen(frame);
    // Nothing rendered yet: open the source embed, which starts at the
    // clip's own timestamps, then take that full screen.
    const play = box.querySelector('[data-ytplay]');
    if (play) {
      play.click();
      requestAnimationFrame(() => {
        const f = box.querySelector('iframe');
        if (f) goFullscreen(f);
      });
    }
  };

  document.addEventListener('keydown', (e) => {
    const a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    if (e.key === ' ' || e.code === 'Space') {
      const id = hoverCard || lastTouched;
      const card = id && document.querySelector(`.clipcard[data-clip="${CSS.escape(id)}"]`);
      if (!card) return;
      e.preventDefault();          // the page must not scroll out from under it
      touchCard(id);
      replay(card);
    } else if (e.key === 'Escape') {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
      }
      document.querySelectorAll('.clipmedia.blown')
        .forEach((el) => el.classList.remove('blown'));
    }
  });

  ['pointermove', 'pointerdown', 'keydown', 'wheel', 'scroll'].forEach((ev) =>
    document.addEventListener(ev, stirred, { passive: true, capture: true }));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) stirred();
  });
  setInterval(bankTime, 15_000);
  // Do not lose the last half-minute to closing the tab.
  window.addEventListener('pagehide', () => {
    if (unbanked >= 10_000) {
      supabase.rpc('log_activity', { seconds: Math.round(unbanked / 1000) });
      unbanked = 0;
    }
  });
}

const trimEdits = new Map();     // clip_id -> { start, end }
const trimOpen = new Set();

function trimRow(k) {
  const id = k.clip_id;
  const e = trimEdits.get(id) || { start: Number(k.clip_start), end: Number(k.clip_end) };
  const dirty = Math.abs(e.start - Number(k.clip_start)) > 0.01
    || Math.abs(e.end - Number(k.clip_end)) > 0.01;
  if (!trimOpen.has(id)) {
    return `<div class="trim">
      <button class="linky" data-trimopen="${esc(id)}">Adjust length</button>
      ${k.needs_recut ? '<span class="s trim-wait">edit saved — re-cuts on the next run</span>' : ''}
    </div>`;
  }
  const nudge = (which, by) => `
    <button class="callbtn tiny" data-trim="${esc(id)}" data-which="${which}" data-by="${by}">${by > 0 ? '+' : ''}${by}s</button>`;
  return `
    <div class="trim open" data-trimrow="${esc(id)}">
      <div class="s">Length ${(e.end - e.start).toFixed(1)}s
        <span class="tm">${mmss(e.start)} → ${mmss(e.end)}</span></div>
      <div class="calls">
        <span class="clayno">start</span>
        ${nudge('start', -2)}${nudge('start', -0.5)}${nudge('start', 0.5)}${nudge('start', 2)}
        <button class="callbtn tiny" data-trimhere="${esc(id)}" data-which="start">here</button>
      </div>
      <div class="calls">
        <span class="clayno">end</span>
        ${nudge('end', -2)}${nudge('end', -0.5)}${nudge('end', 0.5)}${nudge('end', 2)}
        <button class="callbtn tiny" data-trimhere="${esc(id)}" data-which="end">here</button>
      </div>
      <div class="clipsend-row">
        <button class="linky" data-trimcancel="${esc(id)}">Cancel</button>
        <button class="btn clipsend" data-trimsave="${esc(id)}" ${dirty ? '' : 'disabled'}>Save length</button>
      </div>
      <p class="foot-note" style="margin:6px 0 0;padding:0;border:none">"here" takes the
         playhead where the preview is paused. Saving re-cuts from the source and sends
         the clip back through screening, so its boxes and verdict are drawn again on
         the footage that then exists — press Re-cut on Home, or wait for the beat.</p>
    </div>`;
}

// What to put in a clip card's media box.
//
// A rendered preview is best: it is the exact cut, it scrubs, and it is the
// thing the trim controls talk to. But a clip only gets one once screening
// has run, and until then the card was a black rectangle promising a preview
// "within the hour" — which is useless when the job in front of you is to
// watch that clip now.
//
// The source is on YouTube and we know the clip's window in it, so the
// fallback plays the real footage between those two timestamps. Not loaded
// until asked: forty iframes on one page would be slower than the problem
// it solves, so the thumbnail stands in and the embed replaces it on press.
const ytOpen = new Set();

function clipMedia(k) {
  const fs = `<button class="expand" data-expand="${esc(k.clip_id)}" title="Full screen">⤢</button>`;
  if (k.preview_url) {
    return `<video controls preload="none" data-path="${esc(k.preview_path || '')}"
      ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>${fs}`;
  }
  if (ytOpen.has(k.clip_id)) {
    const a = Math.max(0, Math.floor(k.clip_start || 0));
    const b = Math.ceil(k.clip_end || (a + 10));
    return `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(k.video_id)}?start=${a}&end=${b}&autoplay=1&rel=0"
      title="Source footage for this clip" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe>${fs}`;
  }
  const poster = k.poster_url
    ? `<img src="${esc(k.poster_url)}" alt="" loading="lazy" />`
    : `<img src="https://i.ytimg.com/vi/${esc(k.video_id)}/mqdefault.jpg" alt="" loading="lazy" onerror="this.remove()" />`;
  return `${poster}
    <button class="ytplay" data-ytplay="${esc(k.clip_id)}"
      title="No rendered preview yet — play the source at this clip's timestamps">
      <span class="ytplay-i">▶</span>
      <span class="ytplay-t">Play from source${k.poster_url ? '' : ' · preview not rendered'}</span>
    </button>`;
}

function triageClipsView() {
  if (state.loading) return '<div class="empty">Loading clips…</div>';
  const c = state.counts || {};
  const PAGE = TRIAGE_PAGE;
  const totalPending = state.clipTotal ?? (c.pending ?? 0);
  const pages = Math.max(1, Math.ceil(totalPending / PAGE));
  const pending = state.clips;

  const yt = (k) => `https://www.youtube.com/watch?v=${encodeURIComponent(k.video_id)}&t=${Math.max(0, Math.floor(k.shot_ts || 0))}s`;
  // Every clip is the same card whether its preview exists yet or not: the
  // media box keeps its 16:9 shape and the grid never staggers. A rendered
  // preview plays in place; a poster-only clip shows its still with a badge;
  // a brand-new cut holds the space with a note.
  const pendingCard = (k) => `
    <div class="clipcard ${picked.has(k.clip_id) ? 'picked' : ''} ${lastTouched === k.clip_id ? 'last-touched' : ''}" data-id="${esc(k.clip_id)}" data-clip="${esc(k.clip_id)}" data-owner="${esc(k.sorter)}" data-src="${esc(k.preview_url)}">
      <div class="clipmedia">${clipMedia(k)}</div>
      <div class="clipcap">
        <div class="t">Shot ${k.shot_no || '?'} · ${mmss(k.shot_ts)}
          · <a href="${esc(yt(k))}" target="_blank" rel="noopener">source ↗</a></div>
        <div class="s">clip ${mmss(k.clip_start)}–${mmss(k.clip_end)}${k.is_pair ? ' · pair' : ''}</div>
        ${callRows(k)}
        ${trimRow(k)}
        <div class="clipsend-row">
          <button class="btn btn-ghost clipsend" data-deleteone="${esc(k.clip_id)}">Delete</button>
          <button class="btn btn-ghost clipsend impossible" data-impossible="${esc(k.clip_id)}"
            title="Neither of you can call this one — keep it as a benchmark">Impossible</button>
          <button class="btn clipsend" data-sendone="${esc(k.clip_id)}">Send to AI</button>
        </div>
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

    <div class="p-head" style="margin-bottom:10px">
      <span class="p-title">Clips called ${esc((SCOREBOARDS.find((w) => w[0] === scoreWindow) || [])[1] || '').toLowerCase()}</span>
      <select id="scorewin" class="mini" title="The window these three count over">
        ${SCOREBOARDS.map(([v, l]) => `<option value="${v}" ${scoreWindow === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
    </div>
    <div class="stats scoreboard">
      <div class="stat owner-eddie"><div class="num">${fmt(state.scores?.eddie ?? 0)}</div>
        <div class="cap">Eddie</div><div class="sub">clips called</div></div>
      <div class="stat owner-rupert"><div class="num">${fmt(state.scores?.rupert ?? 0)}</div>
        <div class="cap">Rupert</div><div class="sub">clips called</div></div>
      <div class="stat"><div class="num">${fmt(state.scores?.total ?? 0)}</div>
        <div class="cap">Between you</div><div class="sub">clips called</div></div>
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
      <p class="foot-note" style="margin:0 0 16px;padding:0;border:none">Call each shot as
         you watch it — hit, chipped, miss, or unclear if you genuinely cannot tell. Your
         calls are the only ground truth in the system: they are what the trialled models
         are scored against, and what an outcome model would one day be trained on. The
         machines' own verdicts are deliberately not shown here, so what you see is the
         clip rather than a suggestion.</p>
      <div class="p-head"><span class="p-title">Clips to check${totalPending ? ` — ${fmt(totalPending)}` : ''}</span>
        <span>
          <select id="clipowner" class="mini" title="Whose clips this queue shows">
            <option value="mine" ${clipOwner === 'mine' ? 'selected' : ''}>Mine</option>
            <option value="theirs" ${clipOwner === 'theirs' ? 'selected' : ''}>${state.email === 'rupertokelly98@gmail.com' ? "Eddie's" : "Rupert's"}</option>
            <option value="all" ${clipOwner === 'all' ? 'selected' : ''}>Everyone's</option>
          </select>
          <button class="linky ${sweeping ? 'chip-on' : ''}" id="sweep" style="margin-left:10px">${sweeping ? 'Done selecting' : 'Select multiple'}</button>
          <button class="linky" id="pickall" style="margin-left:10px">Select all shown</button>
          <button class="linky" id="picknone" style="margin-left:10px">Clear</button>
          <button class="btn btn-ghost mini-btn" id="deletesel" style="margin-left:14px"
            ${picked.size ? '' : 'disabled'}>Delete <span id="pickdn">${picked.size}</span></button>
          <button class="btn mini-btn" id="sendsel" style="margin-left:8px"
            ${picked.size ? '' : 'disabled'}>Send <span id="pickn">${picked.size}</span> to AI</button>
          <button class="btn btn-ghost mini-btn" id="sendall" style="margin-left:8px"
            ${totalPending ? '' : 'disabled'}>Push all ${fmt(totalPending)} to Roboflow</button>
        </span></div>
      ${state.split && state.split.length ? `
      <p class="split-line">One press deals the whole queue by the split judge:
        ${['train', 'valid', 'test'].map((s) => {
    const r = state.split.find((x) => x.split === s);
    return `<b>${fmt(Number(r?.clips || 0))}</b> ${s}`;
  }).join(' · ')}
        — dealt per video, so no flight's frames ever straddle a set.</p>` : ''}
      ${sweeping ? '<p class="split-line">Hold the mouse down and sweep across clips to pick them; sweep a picked one to unpick. Press Done selecting to watch previews again.</p>' : ''}
      ${grouped ? `<div class="clipgrid ${sweeping ? 'sweepmode' : ''}">${grouped}</div>`
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
    ? `<video controls preload="none" data-path="${esc(k.preview_path || '')}" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>`
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
    </section>` : ''}

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Discovered — waiting for triage · ${fmt(c.discovered ?? 0)}</span></div>
      ${(state.disc || []).length ? (state.disc || []).slice(0, 8).map((v) => `
      <div class="row">
        <span class="dot"></span>
        <div class="main">
          <div class="t"><a href="https://www.youtube.com/watch?v=${encodeURIComponent(v.video_id)}" target="_blank" rel="noopener">${esc(v.title || v.video_id)}</a></div>
          <div class="s">${esc(v.channel || 'unknown channel')} · ${mmss(v.duration_s)} · ${fmt(v.view_count || 0)} views</div>
        </div>
        <div class="end"><span class="s">${v.discovered_at ? ago(v.discovered_at) : ''}</span></div>
      </div>`).join('')
    : '<div class="empty">Nothing waiting — run a discovery from Home and the finds land here.</div>'}
      <p class="foot-note">Every find is written to the master the moment discovery
         returns — this is the queue the next triage run will judge. Newest
         ${Math.min((state.disc || []).length, 8)} shown of ${fmt(c.discovered ?? 0)}; the mastersheet holds them all.</p>
    </section>`;
}

// Our own detectors, and what each one scored. mAP50 is the headline: how
// well the model finds a clay at a sane overlap. The panel is also the
// answer to "which detector is screening right now" — the newest run with
// weights still on the volume is the one in use.
function modelsPanel() {
  const rows = state.models || [];
  const pct = (v) => (v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
  return `
    <section class="panel" style="margin-bottom:18px">
      <div class="p-head"><span class="p-title">Our detector${rows.length === 1 ? '' : 's'}${rows.length ? ` — ${rows.length}` : ''}</span>
        <span>
          <select id="phasepick" class="mini" title="Which rungs go into the training set">
            <option value="">every phase</option>
            <option value="1">phase 1 only — foundation</option>
            <option value="1,2">phases 1–2</option>
            <option value="1,2,3">phases 1–3</option>
            <option value="1,2,3,4">phases 1–4</option>
          </select>
          <button class="linky" data-run="dataset" style="margin-left:10px">Build set</button>
          <button class="linky" data-run="train" style="margin-left:10px">Train</button>
        </span></div>
      ${rows.length ? rows.map((m, i) => `
      <div class="row">
        <span class="dot ${i === 0 ? 'on' : ''}"></span>
        <div class="main">
          <div class="t">${esc(m.name)}${i === 0 ? ' · in use' : ''}
            <span class="s">${esc(m.base || '')} · ${m.epochs || '?'} epochs · ${m.imgsz || '?'}px</span></div>
          <div class="s">mAP50 <b>${pct(m.map50)}</b> · mAP50-95 ${pct(m.map5095)}
            · precision ${pct(m.precision_)} · recall ${pct(m.recall)}
            · trained on ${fmt(m.n_train || 0)} frames, judged on ${fmt(m.n_valid || 0)}</div>
        </div>
        <div class="end"><span class="s">${m.created_at ? ago(m.created_at) : ''}</span></div>
      </div>`).join('')
    : `<div class="empty">No detector of our own yet. Build set assembles one from
         the ${fmt(state.counts?.pending ?? 0)} clips already boxed, then Train fits a
         model to it — after that, screening stops paying for Grounding DINO on
         every frame.</div>`}
      <p class="foot-note">Trained here, on our own boxes, from clips on our own
         volume — Roboflow is not in this loop. The overlay filter runs as the set
         is built, so the reticle that was being labelled as a clay never reaches
         the model. Screening picks up the newest run automatically; pin one with
         MODEL_NAME in the Modal secret, or set DETECTOR=dino to go back for a
         comparison.</p>
    </section>`;
}

/* ---------- findings ---------- */

// The categorical order for every chart on this page. Fixed, never cycled:
// a slice keeps its hue whatever else is on screen, so "orange" means the
// same thing in two charts side by side.
//
// These are not picked by eye. The brand's own extras — champagne against
// the positive green — collapse to a colour difference of 4.6 under
// protanopia, which is invisible; this order was checked against this
// portal's charcoal surface and clears every gate, worst adjacent pair 8.4
// colourblind and 19.8 in normal vision. Clay orange survives as slot two,
// which is where the eye expects it.
const VIZ = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9'];
const VIZ_MUTED = '#7c8078';    // "unknown" is absence, not a category

// A donut, for part-to-whole at a glance. Deliberately not used for
// everything: two slices is a statistic, not a chart, and progress towards
// a target is a meter — a pie cannot show the part that is missing.
function donut(entries, opts = {}) {
  const rows = entries.filter(([, v]) => Number(v) > 0);
  const total = rows.reduce((a, [, v]) => a + Number(v), 0);
  if (!total) return '<div class="empty">Nothing recorded yet.</div>';
  const R = 54, C = 2 * Math.PI * R;
  const colour = (k, i) => (/^(unknown|unplaced|not called)/i.test(k) ? VIZ_MUTED : VIZ[i % VIZ.length]);
  let at = 0;
  const arcs = rows.map(([k, v], i) => {
    const frac = Number(v) / total;
    // A 2px gap between fills, so neighbouring slices never touch — but
    // never below a sliver: one clip out of four hundred came out as a
    // zero-length arc and vanished, which reads as "none" when it is not.
    const len = Math.max(1.5, C * frac - 2);
    const seg = `<circle class="seg" r="${R}" cx="60" cy="60" fill="none"
      stroke="${colour(k, i)}" stroke-width="15"
      stroke-dasharray="${len} ${C - len}"
      stroke-dashoffset="${-C * at}"
      ${opts.pick ? `data-verdict="${esc(k)}" tabindex="0" role="button"` : ''}>
      <title>${esc(k)} — ${fmt(v)} of ${fmt(total)} (${(100 * frac).toFixed(1)}%)</title></circle>`;
    at += frac;
    return seg;
  }).join('');
  const legend = rows.map(([k, v], i) => `
    <div class="lg-row"${opts.pick ? ` data-verdict="${esc(k)}"` : ''}>
      <span class="sw" style="background:${colour(k, i)}"></span>
      <span class="lg-k">${esc(k)}</span>
      <span class="lg-v">${fmt(v)} · ${(100 * Number(v) / total).toFixed(0)}%</span>
    </div>`).join('');
  return `
    <div class="viz${opts.pick ? ' viz-pick' : ''}">
      <svg viewBox="0 0 120 120" class="donut" role="img"
           aria-label="${esc(opts.label || '')}: ${rows.map(([k, v]) => `${k} ${v}`).join(', ')}">
        <g transform="rotate(-90 60 60)">${arcs}</g>
        <text x="60" y="57" class="d-num">${fmt(total)}</text>
        <text x="60" y="72" class="d-cap">${esc(opts.unit || 'total')}</text>
      </svg>
      <div class="legend">${legend}</div>
    </div>`;
}

// A ratio against a limit is a meter, not a slice: the point is the gap.
function meter(have, target) {
  const pct = Math.min(100, 100 * have / Math.max(1, target));
  return `<div class="bar"><span style="width:${pct.toFixed(1)}%"></span></div>`;
}

// Opening a verdict shows the shots behind it, every variable beside each
// one, and a tally of those variables across the whole group. A count tells
// you there is a problem; this is for finding out what the problem is.
let drillOn = null;          // which verdict is open
let drillRows = [];

async function loadDrill(verdict) {
  const { data, error } = await supabase.from('pipeline_clips')
    .select('clip_id,video_id,shot_ts,clip_start,clip_end,is_pair,n_shots,slo_mo,outcome,outcome_conf,owner_outcome,det_conf,speed_mph,range_m,clay_colour,preview_path,poster_path')
    .eq('outcome', verdict).order('created_at', { ascending: false }).limit(60);
  if (error) return [];
  const rows = data || [];
  await signClipMedia(rows);
  const vids = [...new Set(rows.map((k) => k.video_id))];
  if (vids.length) {
    const { data: tv } = await supabase.from('pipeline_videos')
      .select('video_id,title,channel,weather,ds_level,duration_s').in('video_id', vids);
    const by = new Map((tv || []).map((v) => [v.video_id, v]));
    rows.forEach((k) => Object.assign(k, {
      title: by.get(k.video_id)?.title || k.video_id,
      channel: by.get(k.video_id)?.channel || '',
      weather: by.get(k.video_id)?.weather || 'unknown',
      camera: by.get(k.video_id)?.camera || 'unknown',
      ds_level: by.get(k.video_id)?.ds_level || null,
    }));
  }
  return rows;
}

function verdictDrill() {
  if (!drillOn) return '';
  const rows = drillRows;
  if (!rows.length) {
    return `<div class="empty">Loading the ${esc(drillOn)} shots…</div>`;
  }
  // The tally is the point: if one variable dominates a bad verdict, it is
  // the cause, and it shows up here as a lopsided row.
  const tally = (get) => {
    const m = {};
    rows.forEach((k) => { const v = get(k); m[v] = (m[v] || 0) + 1; });
    return Object.entries(m).sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${esc(k)} <b>${n}</b>`).join(' · ');
  };
  const band = (v, lo, hi) => (v == null ? 'unknown' : v < lo ? `under ${lo}` : v > hi ? `over ${hi}` : `${lo}–${hi}`);

  return `
    <div class="drill">
      <div class="p-head"><span class="p-title">${fmt(rows.length)} ${esc(drillOn)} shots — what they have in common</span>
        <button class="linky" data-verdictclose="1">Close</button></div>
      <div class="row"><div class="main"><div class="t">Shot type</div>
        <div class="s">${tally((k) => (k.is_pair ? `pair or burst (${k.n_shots || 2} shots)` : 'single shot'))}</div></div></div>
      <div class="row"><div class="main"><div class="t">Camera</div>
        <div class="s">${tally((k) => k.camera || 'unknown')}</div></div></div>
      <div class="row"><div class="main"><div class="t">Ladder level</div>
        <div class="s">${tally((k) => (k.ds_level ? `L${k.ds_level} ${(DS_LADDER[k.ds_level - 1] || {}).name || ''}` : 'unplaced'))}</div></div></div>
      <div class="row"><div class="main"><div class="t">Weather</div>
        <div class="s">${tally((k) => k.weather || 'unknown')}</div></div></div>
      <div class="row"><div class="main"><div class="t">Clay colour</div>
        <div class="s">${tally((k) => k.clay_colour || 'unknown')}</div></div></div>
      <div class="row"><div class="main"><div class="t">Detection confidence</div>
        <div class="s">${tally((k) => band(k.det_conf == null ? null : Math.round(k.det_conf * 10) / 10, 0.4, 0.6))}</div></div></div>
      <div class="row"><div class="main"><div class="t">Clip length</div>
        <div class="s">${tally((k) => band(Math.round(k.clip_end - k.clip_start), 6, 12) + 's')}</div></div></div>
      <div class="row"><div class="main"><div class="t">Slow motion</div>
        <div class="s">${tally((k) => (k.slo_mo ? 'slow motion' : 'real speed'))}</div></div></div>
      <div class="row"><div class="main"><div class="t">Channel</div>
        <div class="s">${tally((k) => k.channel || 'unknown')}</div></div></div>
      <div class="row"><div class="main"><div class="t">Where we disagreed</div>
        <div class="s">${tally((k) => (k.owner_outcome ? `we said ${k.owner_outcome}` : 'not called by hand yet'))}</div></div></div>

      <div class="p-head" style="margin-top:14px"><span class="p-title">The shots themselves</span></div>
      <div class="clipgrid">
        ${rows.slice(0, 24).map((k) => `
        <div class="clipcard">
          <div class="clipmedia">
            ${k.preview_url
    ? `<video controls preload="none" data-path="${esc(k.preview_path || '')}" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>`
    : k.poster_url ? `<img src="${esc(k.poster_url)}" alt="" loading="lazy" />`
      : '<span class="rendering">no preview</span>'}
          </div>
          <div class="clipcap">
            <div class="t">${esc(k.title)}</div>
            <div class="s">${k.is_pair ? `pair · ${k.n_shots || 2} shots` : 'single'}
              · ${(k.clip_end - k.clip_start).toFixed(1)}s
              · det ${k.det_conf == null ? '—' : Math.round(k.det_conf * 100) + '%'}
              · ${esc(k.weather || 'unknown')} · ${esc(k.camera || 'unknown')}${k.ds_level ? ` · L${k.ds_level}` : ''}${k.slo_mo ? ' · slo-mo' : ''}</div>
            <div class="s">verdict ${esc(k.outcome)}${k.outcome_conf != null ? ` · ${Math.round(k.outcome_conf * 100)}%` : ''}${k.owner_outcome ? ` · we said <b>${esc(k.owner_outcome)}</b>` : ''}</div>
          </div>
        </div>`).join('')}
      </div>
      ${rows.length > 24 ? `<p class="foot-note">Newest 24 shown of ${fmt(rows.length)}.</p>` : ''}
    </div>`;
}

// Everything the pipeline knows about itself, on one page: what was
// sourced, what survived, what we called, what the machine called, what the
// dataset is made of and what any of it is worth. The numbers are stated
// plainly, including the ones that are unflattering — a figure you cannot
// see is a figure you cannot act on.
async function loadPartners() {
  const { data, error } = await supabase.from('partnerships')
    .select('*').order('status').order('name');
  return error ? [] : (data || []);
}

// Where the footage comes from, as relationships rather than URLs. Sources
// records what to crawl; this records who agreed to it. The distinction
// matters more as the set grows: permission is the thing that does not scale
// by itself, and a ground that said yes once is worth more than a search
// query that happens to still work.
const PARTNER_STAGES = ['prospect', 'contacted', 'talking', 'agreed', 'declined', 'lapsed'];

function partnershipsView() {
  if (state.loading) return '<div class="empty">Loading…</div>';
  const rows = state.partners || [];
  const by = (st) => rows.filter((r) => r.status === st);
  const agreed = by('agreed');
  // Live channels we already crawl that nobody has a relationship with. The
  // gap between what we take and what we have asked for is the number worth
  // watching, not the count of partners.
  const known = new Set(rows.map((r) => (r.handle || '').toLowerCase()).filter(Boolean));
  const unasked = (state.sources || [])
    .filter((s) => s.kind === 'channel' && !known.has((s.ref || '').toLowerCase()));

  return `
    <div class="crm-head">
      <div>
        <h1>Partnerships</h1>
        <p>Who the footage comes from, and what they agreed to. Discovery finds
           channels; this is the record of having asked. A ground that says yes
           gives a back catalogue shot on the cameras we are building for, from
           angles a search never surfaces — and permission is the one part of
           sourcing that does not scale on its own.</p>
      </div>
    </div>

    <div class="stats">
      ${stat(fmt(agreed.length), 'Agreed', 'footage we may use', !agreed.length)}
      ${stat(fmt(by('talking').length + by('contacted').length), 'In conversation', 'asked, not yet settled')}
      ${stat(fmt(by('prospect').length), 'To approach', 'identified, not contacted')}
      ${stat(fmt(unasked.length), 'Crawled unasked', unasked.length ? 'channels we take from with no record of asking' : 'nothing untracked', unasked.length > 0)}
    </div>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Everyone, by where the conversation got to</span></div>
      ${rows.length ? PARTNER_STAGES.filter((st) => by(st).length).map((st) => `
        <div class="row"><div class="main"><div class="t">${esc(st)}</div>
          <div class="s">${by(st).map((r) => `${esc(r.name)}${r.handle ? ` <span class="s">${esc(r.handle)}</span>` : ''}`).join(' · ')}</div>
        </div><div class="n">${fmt(by(st).length)}</div></div>`).join('')
    : '<div class="empty">No partnerships recorded yet. Everything being crawled is being crawled on nobody\'s say-so.</div>'}
    </section>

    ${unasked.length ? `
    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Crawled, but never asked</span>
        <span class="s">${fmt(unasked.length)} channel${unasked.length === 1 ? '' : 's'}</span></div>
      <div class="s" style="padding:6px 0">${unasked.map((u) => esc(u.ref)).join(' · ')}</div>
      <p class="foot-note">Not a legal opinion and not an accusation — third-party
         footage is being used for training either way. It is a list of the
         people worth talking to: each one is already producing exactly the
         footage the model wants, and asking turns a scrape into a supply.</p>
    </section>` : ''}
  `;
}

function findingsView() {
  if (state.loading) return '<div class="empty">Loading the findings…</div>';
  const f = state.findings;
  if (!f) {
    return `<div class="crm-head"><div><h1>Findings</h1></div></div>
      <div class="panel"><div class="empty">The report could not be built. If this
      persists the findings_report function may be missing from the database.</div></div>`;
  }
  const s = f.sourcing || {};
  const cl = f.clips || {};
  const ds = f.dataset || {};
  const ag = f.agreement || {};
  const models = f.models || [];
  const num = (v, suffix = '') => (v == null ? '—' : `${fmt(v)}${suffix}`);
  const pctOf = (v) => (v == null ? '—' : `${v}%`);

  const stat = (n, cap, sub, warn = false) => `
    <div class="stat${warn ? ' stat-warn' : ''}">
      <div class="num">${n}</div><div class="cap">${cap}</div>
      <div class="sub">${sub}</div></div>`;

  // A dictionary of counts as a proportioned bar — the shape of a
  // distribution reads faster than a column of numbers.
  const dist = (obj, order, pick) => {
    const keys = order ? order.filter((k) => obj[k] != null) : Object.keys(obj || {});
    const total = keys.reduce((a, k) => a + Number(obj[k] || 0), 0) || 1;
    if (!keys.length) return '<div class="empty">Nothing recorded yet.</div>';
    return keys.map((k) => `
      <div class="row${pick ? ' pickable' : ''}"${pick ? ` data-verdict="${esc(k)}"` : ''}>
        <div class="main">
          <div class="t">${esc(k)}${pick ? ' <span class="s">— open</span>' : ''}</div>
          <div class="bar"><span style="width:${(100 * obj[k] / total).toFixed(1)}%"></span></div>
        </div>
        <div class="end"><span class="s">${fmt(obj[k])} · ${(100 * obj[k] / total).toFixed(1)}%</span></div>
      </div>`).join('');
  };

  const CALLS = ['hit', 'chipped', 'miss', 'unclear'];
  const spend = (f.spend || []).reduce((a, r) => a + Number(r.usd || 0), 0);

  return `
    <div class="crm-head">
      <div>
        <h1>Findings</h1>
        <p>Every figure the pipeline holds about itself, in one place: what has been
           sourced, what survived each gate, what we have called by hand, what the
           machine called, what the training set is actually made of, and what any
           of it is worth. Where a number is unflattering it is still here.</p>
      </div>
    </div>

    ${(() => {
    // The detector is the product; everything else on this page is how it
    // got made. So the model's own numbers go first and alone, and the
    // sourcing figures — which were sitting in the same row and reading as
    // equally important — drop to a second band below.
    const m = models[0] || null;
    const prev = models[1] || null;
    const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
    // Movement against the previous rung, which is the number that actually
    // says whether the last night's work helped.
    const delta = (m && prev && m.map50 != null && prev.map50 != null)
      ? (m.map50 - prev.map50) * 100 : null;
    const arrow = delta == null ? ''
      : ` · ${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)} on ${esc(prev.name)}`;
    const imgs = m ? (m.n_train || 0) + (m.n_valid || 0) + (m.n_test || 0) : 0;
    // Train's share of the set. Below about two thirds means images are
    // sitting in valid or test where they teach the model nothing, which is
    // worth seeing on the page rather than in a query.
    const trainShare = imgs ? (m.n_train || 0) / imgs : 0;
    return `
    <div class="p-head" style="margin:22px 0 8px">
      <span class="p-title">The detector — what we have actually built</span>
      ${m ? `<span class="s">${esc(m.name)} · ${esc(String(m.created_at || '').slice(0, 16).replace('T', ' '))}</span>` : ''}
    </div>
    <div class="stats">
      ${stat(m && m.map50 != null ? pct(m.map50) : '—', 'mAP50',
    m ? `${esc(m.name)}${arrow}` : 'no detector trained yet', !m)}
      ${stat(m && m.map5095 != null ? pct(m.map5095) : '—', 'mAP50-95',
    'how tight the boxes are', !m)}
      ${stat(m && m.recall != null ? pct(m.recall) : '—', 'Recall',
    m && m.precision_ != null ? `precision ${pct(m.precision_)}` : 'clays found of clays present', !m)}
      ${stat(num(imgs), 'Images in the set',
    m ? `${num(ds.label_rows)} clips boxed · ${num(ds.boxed_frames)} frames` : 'nothing built yet', !imgs)}
      ${stat(m ? `${num(m.n_train)}` : '—', 'Train',
    imgs ? `${(trainShare * 100).toFixed(0)}% of the set` : '—', imgs && trainShare < 0.6)}
      ${stat(m ? `${num(m.n_valid)}` : '—', 'Valid', 'tunes the run', false)}
      ${stat(m ? `${num(m.n_test)}` : '—', 'Test',
    m && m.n_test ? 'the frozen ruler' : 'no honest ruler', !(m && m.n_test))}
      ${stat(state.spend && state.spend.usd != null ? `$${Number(state.spend.usd).toFixed(2)}` : '—',
    'Cost to here', `${num(models.length)} training run${models.length === 1 ? '' : 's'} · all AI spend`)}
    </div>`;
  })()}

    <div class="p-head" style="margin:26px 0 8px">
      <span class="p-title">The pipeline — where the footage came from</span>
      <span class="s">how the set above got made</span>
    </div>
    <div class="stats">
      ${stat(num(s.videos), 'Videos seen', `${num(s.channels)} channels · ${num(s.hours)} hours`)}
      ${stat(pctOf(s.kept_pct), 'Survived triage', `${num(s.rejected)} refused · mean ${s.avg_score ?? '—'}`)}
      ${stat(num(cl.total), 'Clips cut', `${num(cl.pairs)} pairs · ${num(cl.slo_mo)} slow-motion`)}
      ${stat(pctOf(cl.call_pct), 'Checked by a person', `${num(cl.called)} of ${num(cl.total)} clips`, (cl.call_pct ?? 0) < 25)}
      ${stat(pctOf(ag.pct), 'Machine agrees with us', `${num(ag.compared)} clips called by both`, (ag.pct ?? 0) < 70)}
    </div>

    <section class="panel">
      <div class="p-head"><span class="p-title">The funnel — where every video ended up</span></div>
      ${dist({ discovered: s.discovered, triaged: s.triaged, approved: s.approved,
    clipped: s.clipped, rejected: s.rejected, binned: s.binned, errored: s.errored },
    ['discovered', 'triaged', 'approved', 'clipped', 'rejected', 'binned', 'errored'])}
      <p class="foot-note">${num(s.forced)} forced in by hand, overruling triage.
         A funnel this narrow at the top is discovery's problem, not triage's:
         ${pctOf(s.kept_pct)} surviving means most of what is being found is not
         what we are looking for.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">The calls — ours against the machine's</span>
        <span class="s">agreement on the first clay <b>${pctOf(ag.pct)}</b>
          (${num(ag.agreed)} of ${num(ag.compared)})</span></div>
      <div class="vizgrid">
        <figure><figcaption>Ours — the ground truth
          <span class="s">${num(cl.called)} of ${num(cl.total)} clips called</span></figcaption>
          ${donut(CALLS.map((k) => [k, (f.owner_calls || {})[k] || 0]), { label: 'Our calls', unit: 'calls' })}</figure>
        <figure><figcaption>The machine's
          <span class="s">press a slice to see the shots behind it</span></figcaption>
          ${donut(CALLS.map((k) => [k, (f.ai_calls || {})[k] || 0]), { label: "The machine's calls", unit: 'calls', pick: true })}</figure>
      </div>
      ${verdictDrill()}
      <p class="foot-note">Ours are the only calls made by a person and the only thing a
         model is ultimately scored against. Agreement counts only clips where both have
         called, so it moves as more are called. Up to ${num(cl.max_clays)} clays have
         been called on one clip.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">The training set</span></div>
      <div class="row"><div class="main"><div class="t">Boxed frames held</div>
        <div class="s">every frame the detector drew a box on, before striding</div></div>
        <div class="end"><b>${num(ds.boxed_frames)}</b></div></div>
      <div class="row"><div class="main"><div class="t">Clips with boxes</div></div>
        <div class="end"><b>${num(ds.label_rows)}</b></div></div>
      <div class="row"><div class="main"><div class="t">Mean detection confidence</div>
        <div class="s">how sure the detector was of the clay it followed</div></div>
        <div class="end"><b>${cl.avg_det_conf ?? '—'}</b></div></div>
      <div class="p-head" style="margin-top:14px"><span class="p-title">Split</span></div>
      ${dist(f.splits || {}, ['train', 'valid', 'test'])}
      <div class="p-head" style="margin-top:14px"><span class="p-title" style="font-size:12px">The scenes it was dealt from</span></div>
      ${(f.scenes || []).map((sc) => `
      <div class="row"><div class="main">
        <div class="t">${esc(sc.scene)} <span class="s">— ${esc(sc.split)}</span></div>
      </div><div class="end"><b>${fmt(sc.clips)}</b></div></div>`).join('')
    || '<div class="empty">Nothing clipped yet.</div>'}
      <p class="foot-note">The judge deals a whole <b>scene</b> — a channel, meaning one
         shooter at one ground on one camera — never a loose clip, because splitting by
         clip leaks near-identical frames across the divide and flatters every score
         that follows.
         ${(f.splits || {}).test
    ? ''
    : `<b>That is why there is no test scoring:</b> only ${fmt((f.scenes || []).length)}
         scenes have been clipped, and at roughly one in seven going to test, coming up
         empty on ${fmt((f.scenes || []).length)} draws is ordinary luck rather than a
         fault. It fills itself as more channels are clipped — there are
         ${fmt(state.counts?.downloaded ?? 0)} videos waiting in Review — and until it
         does the only honest reading is that the model is <b>unmeasured</b>. Validation
         tunes the model, so a score against it is not evidence.`}</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Coverage — was the whole film cut, or only the start of it?</span>
        <span class="s">${(() => {
    const cv = f.coverage || [];
    const thin = cv.filter((r) => (r.reached ?? 0) < 80).length;
    return cv.length ? `${fmt(cv.length)} films · ${thin ? `<b>${fmt(thin)} cut short</b>` : 'none cut short'}` : '';
  })()}</span></div>
      ${(f.coverage || []).length ? [...(f.coverage || [])]
    .sort((a, b) => (a.reached ?? 0) - (b.reached ?? 0)).slice(0, 12).map((r) => `
      <div class="row">
        <span class="dot ${(r.reached ?? 0) >= 80 ? 'on' : ''}"></span>
        <div class="main">
          <div class="t">${esc(r.title || r.video_id)}</div>
          <div class="s">${fmt(r.clips)} clips · first at ${mmss(r.first_s)} · last ends ${mmss(r.last_s)} of ${mmss(r.duration_s)}</div>
          ${meter(r.reached ?? 0, 100)}
        </div>
        <div class="end"><b>${r.reached ?? '—'}%</b></div>
      </div>`).join('')
    : '<div class="empty">Nothing clipped yet.</div>'}
      <p class="foot-note">The clipper cuts on sound, so the only honest test of whether
         it worked the whole film is where its last cut lands against how long the video
         ran — a five-minute film whose last clip ends at ninety seconds was abandoned,
         however many clips it made. Anything under 80% is worth opening: it is usually a
         quiet passage the ears missed rather than a fault, but it is also exactly what a
         broken run looks like. Worst twelve shown, thinnest first.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">The phases — how much of each complexity we hold</span>
        <span class="s">one phase per clip, read from the footage</span></div>
      ${DS_LADDER.map((l) => {
    const ph = (f.phases || {})[String(l.n)] || { clips: 0, called: 0 };
    const have = Number(ph.clips || 0);
    const derivable = ![5, 8].includes(l.n);
    const short = Math.max(0, l.target - have);
    return `
      <div class="row">
        <span class="dot ${have >= l.target ? 'on' : ''}"></span>
        <div class="main">
          <div class="t">L${l.n} · ${esc(l.name)}
            ${have >= l.target ? '<span class="s">— met</span>'
    : derivable ? `<span class="s">— ${fmt(short)} short</span>`
      : '<span class="s">— cannot be read from the footage; stamp by hand</span>'}</div>
          <div class="s">${esc(l.sub)}</div>
          ${meter(have, l.target)}
          <div class="s">${fmt(ph.called || 0)} of ${fmt(have)} checked by a person</div>
        </div>
        <div class="end"><span class="s">${fmt(have)} / ${fmt(l.target)}</span></div>
      </div>`;
  }).join('')}
      ${(f.phases || {})['0'] ? `
      <div class="row">
        <span class="dot"></span>
        <div class="main"><div class="t">Unplaced</div>
          <div class="s">nothing about these clips says which phase they belong to —
             usually an unread clay colour or unknown weather. Reading those is what
             moves them onto a rung.</div></div>
        <div class="end"><b>${fmt((f.phases || {})['0'].clips)}</b></div>
      </div>` : ''}
      <p class="foot-note">A phase is worked out from the clip itself — its clay colour,
         the weather, whether it is slow motion, how far and how fast — so this counts
         the footage we actually hold rather than a label nobody applied. One phase per
         clip, hardest thing in the frame wins: a black clay in fog counts as hard
         light, not as dark clays. Phases 5 and 8 have no field that could tell us, so
         they read nought until stamped by hand.
         <br><br><b>On having enough:</b> a count reaching its target is not proof that
         more would not help, and this page cannot tell you that on its own — only a
         trained model can. The honest test is to train, read the per-phase accuracy,
         add footage to the weakest phase, and train again: if the score stops moving,
         that phase is full and the next one is where the effort belongs. The targets
         here are a starting estimate, not a finding.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Conditions covered</span></div>
      <div class="vizgrid">
        <figure><figcaption>Camera <span class="s">what it was shot on</span></figcaption>
          ${donut(Object.entries(f.camera || {}).sort((a, b) => b[1] - a[1]), { label: 'Camera', unit: 'clips' })}</figure>
        <figure><figcaption>Clay colour</figcaption>
          ${donut(Object.entries(f.clay_colour || {}).sort((a, b) => b[1] - a[1]), { label: 'Clay colour', unit: 'clips' })}</figure>
        <figure><figcaption>Background <span class="s">what the clay was found against</span></figcaption>
          ${donut(Object.entries(f.background || {}).sort((a, b) => b[1] - a[1]), { label: 'Background', unit: 'clays' })}</figure>
        <figure><figcaption>Weather</figcaption>
          ${donut(Object.entries(f.weather || {}).sort((a, b) => b[1] - a[1]), { label: 'Weather', unit: 'clips' })}</figure>
        <figure><figcaption>Shot type <span class="s">read from the tracked flight</span></figcaption>
          ${donut(Object.entries(f.shot_type || {}).sort((a, b) => b[1] - a[1]), { label: 'Shot type', unit: 'clips' })}</figure>
        <figure><figcaption>Presentation <span class="s">as called by hand, where it was</span></figcaption>
          ${donut(Object.entries(f.presentation || {}).sort((a, b) => b[1] - a[1]).slice(0, 6), { label: 'Presentation', unit: 'clips' })}</figure>
        <figure><figcaption>Split <span class="s">train · valid · test</span></figcaption>
          ${donut(['train', 'valid', 'test'].map((k) => [k, (f.splits || {})[k] || 0]), { label: 'Split', unit: 'clips' })}</figure>
      </div>
      <p class="foot-note">What gets deployed is a camera on a gun or a face, so barrel,
         gopro and pov_glasses are the footage that matches the job — broadcast and
         third_person teach a view no customer will ever wear. A thin slice is not a
         statistic, it is the next filming day.
         A detector taught only on clear sky is a detector that fails on the first
         overcast morning, and "unknown" is the largest weather slice here because
         triage could not read the conditions from the frames it sampled.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">Reliability — what our detectors scored</span></div>
      ${models.length ? models.map((m) => `
      <div class="row">
        <div class="main">
          <div class="t">${esc(m.name)} <span class="s">${esc(m.base || '')} · ${m.epochs || '?'} epochs · ${m.imgsz || '?'}px</span></div>
          <div class="s">mAP50 <b>${m.map50 == null ? '—' : (m.map50 * 100).toFixed(1) + '%'}</b>
            · mAP50-95 ${m.map5095 == null ? '—' : (m.map5095 * 100).toFixed(1) + '%'}
            · precision ${m.precision_ == null ? '—' : (m.precision_ * 100).toFixed(1) + '%'}
            · recall ${m.recall == null ? '—' : (m.recall * 100).toFixed(1) + '%'}
            · ${fmt(m.n_train || 0)} train / ${fmt(m.n_valid || 0)} valid frames</div>
        </div>
        <div class="end"><span class="s">${m.created_at ? ago(m.created_at) : ''}</span></div>
      </div>`).join('')
    : '<div class="empty">No detector trained yet. Build set and Train on the Labelling page, and the scores land here.</div>'}
      <p class="foot-note">mAP50 is the headline: how reliably the model finds a clay
         at a sensible overlap. Judge it against the previous run, not against a
         number from a paper — the subject here is a few pixels wide.</p>
    </section>

    <section class="panel" style="margin-top:18px">
      <div class="p-head"><span class="p-title">What it has cost</span>
        <span class="s">$${spend.toFixed(2)} metered</span></div>
      ${(f.spend || []).length ? (f.spend || []).map((r) => `
      <div class="row"><div class="main">
        <div class="t">${esc(r.model)}</div>
        <div class="s">${fmt(r.calls || 0)} calls · ${fmt(r.in_tokens || 0)} in · ${fmt(r.out_tokens || 0)} out</div>
      </div><div class="end"><b>$${Number(r.usd || 0).toFixed(2)}</b></div></div>`).join('')
    : '<div class="empty">Nothing metered yet.</div>'}
      <p class="foot-note">Model calls only. The GPU time that screens and trains is
         billed by Modal and is not counted here, and neither is Roboflow.</p>
    </section>`;
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
    const vc = (o) => (o === 'hit' ? 'v-hit' : o === 'miss' ? 'v-miss' : o === 'chipped' ? 'v-chip' : '');
    const show = (o, c) => `${esc(o)}${c != null ? ` · ${Math.round(c * 100)}%` : ''}`;
    // A burst is several shots, so it wears a verdict per clay — as many as
    // were actually fired, not the three the old columns could hold.
    const ai = aiCalls(k);
    const ord = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth',
      'Seventh', 'Eighth'];
    const panel = [
      ...(ai.length ? ai.map(([o, c], i) => metric(
        // Named by the shot, not by where the clay sits. On a simultaneous
        // pair both are in the air at once and any spatial rule — left to
        // right, high to low — breaks the moment they cross, which on a
        // crosser pair is most of the flight. Order of engagement is always
        // defined, needs no convention memorised, and is already how
        // _shot_track resolves a clay to a bang: so the owner's index and the
        // machine's index cannot drift apart.
        ai.length > 1 ? `${ord[i] || `Shot ${i + 1}`} shot` : 'Verdict',
        o ? show(o, c) : '—', vc(o)))
        : [metric('Verdict', '—')]),
      k.clay_colour && k.clay_colour !== 'unknown' ? metric('Clay', esc(k.clay_colour)) : '',
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
    ? `<video class="clipvid" controls preload="none" data-path="${esc(k.preview_path || '')}" ${k.poster_url ? `poster="${esc(k.poster_url)}"` : ''} src="${esc(k.preview_url)}"></video>` : ''}
          <div class="t">${esc(k.title || k.video_id)}${k.shot_no ? ` — shot ${k.shot_no}` : ''}</div>
          <div class="s">${k.label_status === 'queued'
    ? 'queued — the AI boxes it within the hour'
    : `pre-labelled${k.n_clays != null ? ` · ${fmt(k.n_clays)} clay${k.n_clays === 1 ? '' : 's'} boxed` : ''} · frames in Roboflow`}</div>
        </div>
        <div class="aimetrics">${panel}
          ${callRows(k)}
        </div>
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

    ${modelsPanel()}

    <section class="panel">
      <div class="p-head"><span class="p-title">${fmt(total)} clips with the AI</span>
        <select id="aisort" class="mini" title="Sort by verdict confidence">
          <option value="new" ${aiSort === 'new' ? 'selected' : ''}>Newest first</option>
          <option value="hi" ${aiSort === 'hi' ? 'selected' : ''}>Highest confidence</option>
          <option value="lo" ${aiSort === 'lo' ? 'selected' : ''}>Lowest confidence</option>
        </select></div>
      ${state.ai.length ? state.ai.map(row).join('')
    : '<div class="empty">Nothing here yet — send clips from the Triage page and they appear the moment they are queued.</div>'}
      ${pages > 1 ? `
      <div class="pager">
        <button class="linky" id="aiprev" ${aiPage ? '' : 'disabled'}>‹ Previous</button>
        <span>page ${aiPage + 1} of ${pages}</span>
        <button class="linky" id="ainext" ${aiPage + 1 < pages ? '' : 'disabled'}>Next ›</button>
      </div>` : ''}
    </section>

    ${trialsPanel()}`;
}

// Taking clips off the page.
//
// Both of these used to make you wait for work that had nothing to do with
// the card disappearing. Send waited on the labeller being fired — a Modal
// call the proxy holds for up to twenty-five seconds — and Delete waited on
// a full reload of every panel on the page. Neither answer changes what the
// press meant, so neither is worth standing still for.
//
// The card goes now, the write follows, and only a failure brings it back:
// refresh() restores the truth if the database disagreed.
function takeOffPage(ids) {
  const gone = new Set(ids);
  ids.forEach((id) => {
    picked.delete(id);
    document.querySelector(`.clipcard[data-clip="${CSS.escape(id)}"]`)?.remove();
  });
  state.clips = state.clips.filter((k) => !gone.has(k.clip_id));
  const n = document.getElementById('pickn');
  if (n) n.textContent = picked.size;
  const dn = document.getElementById('pickdn');
  if (dn) dn.textContent = picked.size;
  settled();
}

async function queueClips(ids, btn) {
  if (!ids.length) return;
  if (btn) busy(btn, true, 'Sending…');
  takeOffPage(ids);
  const { error } = await supabase.from('pipeline_clips')
    .update({ label_status: 'queued' }).in('clip_id', ids).select('clip_id');
  if (error) { note(`could not queue clips — ${error.message}`, 'bad'); await refresh(); return; }
  note(`${ids.length} clip${ids.length === 1 ? '' : 's'} queued — handing over to Roboflow now`, 'good');
  // Fired, not awaited. The beat would box these within the half hour
  // anyway; firing now only makes it sooner, and nobody should watch a
  // spinner for it.
  runStage('prelabel', { limit: 50 }).catch(() => {});
}

// The far end of the ladder. A clip neither owner can call is not a bad
// clip — it is the hardest thing the job contains, and it is worth more
// standing still as a benchmark than folded into training. Held out
// deliberately: a set you train on cannot also be the set that tells you
// how good you have become.
async function markImpossible(ids, btn) {
  if (!ids.length) return;
  if (btn) busy(btn, true, 'Filing…');
  takeOffPage(ids);
  const { error } = await supabase.from('pipeline_clips').update({
    label_status: 'impossible',
    impossible_at: new Date().toISOString(),
    impossible_by: WHOAMI(),
  }).in('clip_id', ids).select('clip_id');
  if (error) { note(`could not file it — ${error.message}`, 'bad'); await refresh(); return; }
  note(`${ids.length} filed under the impossible — the benchmark, not the bin`, 'good');
}

async function deleteClips(ids, btn) {
  if (!ids.length) return;
  if (btn) busy(btn, true, 'Deleting…');
  takeOffPage(ids);
  // Same bucket screening's own rejects land in — reversible from the
  // Rejected by screening panel rather than gone for good.
  const { error } = await supabase.from('pipeline_clips')
    .update({ label_status: 'rejected' }).in('clip_id', ids).select('clip_id');
  if (error) { note(`could not delete clips — ${error.message}`, 'bad'); await refresh(); return; }
  note(`${ids.length} clip${ids.length === 1 ? '' : 's'} deleted`, 'good');
}

// portal.js is a module, so the drag-select layer in portal-select.js cannot
// see these. It has no Supabase client of its own — without this it would
// have to post to an HTTP endpoint that does not exist.
window.BraceOps = { queueClips, deleteClips };

/* ---------- mastersheet ---------- */

// Every video the machine has ever touched, in one ledger. Its other job is
// reassurance: discover writes with ignore-duplicates against this sheet, so
// nothing on it is ever fetched, scored or clipped twice.
const SHEET_FILTERS = [
  ['all', 'All'], ['downloaded', 'Triaged'], ['approved', 'Approved'],
  ['clipped', 'Clipped'], ['rejected', 'Rejected'], ['binned', 'Binned'],
  ['discovered', 'Discovered'],
];
const SHEET_TONE = { clipped: 'on', approved: 'on', downloaded: 'on' };

function mastersheetView() {
  if (state.loading) return '<div class="empty">Loading the sheet…</div>';
  const c = state.counts || {};
  // On the Rejected filter the sheet becomes triage's audit: the reason in
  // triage's own words, an in-page player, and a way to overrule the call.
  const auditing = sheetFilter === 'rejected';
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
        ${auditing && v.triage_notes ? `<div class="s why" title="${esc(v.triage_notes)}">${esc(v.triage_notes)}</div>` : ''}
        ${v.clips ? `<div class="s verdictline">${v.called
    ? `your calls: ${[['hit', v.hit], ['chipped', v.chipped], ['miss', v.miss], ['unclear', v.unclear]]
      .filter(([, n]) => n).map(([o, n]) => `${fmt(n)} ${o}`).join(' · ') || 'none yet'}${v.called < v.clips ? ` — ${fmt(v.clips - v.called)} of ${fmt(v.clips)} clips unwatched` : ''}`
    : `${fmt(v.clips)} clip${v.clips === 1 ? '' : 's'} awaiting your verdicts`}</div>` : ''}
      </div>
      <div class="end">
        ${v.clips ? `<span class="s">${fmt(v.clips)} clips · ${fmt(v.sent)} sent</span>` : ''}
        ${auditing ? `
          <button class="linky" data-watch="${esc(v.video_id)}">${watching === v.video_id ? 'Close' : 'Watch'}</button>
          <button class="linky" data-retriage="${esc(v.video_id)}">Re-triage</button>` : ''}
        ${sheetFilter === 'binned' ? `
          <button class="linky" data-unbin="${esc(v.video_id)}">Back to pile</button>` : ''}
        <select class="mini" data-dslevel="${esc(v.video_id)}" title="Dataset strategy level — which rung of the ladder this footage serves">
          <option value="">L—</option>
          ${DS_LADDER.map((l) => `<option value="${l.n}" ${v.ds_level === l.n ? 'selected' : ''}>L${l.n}</option>`).join('')}
        </select>
      </div>
    </div>
    ${auditing && watching === v.video_id ? `
    <div class="embedrow">
      <iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.video_id)}"
        title="Rejected video" allow="fullscreen" allowfullscreen loading="lazy"></iframe>
    </div>` : ''}`;

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
    (state.activity || []).length, state.activity?.[0]?.at,
    state.sources.map((x) => `${x.id}${x.enabled}${x.last_found}`),
    clipPage, clipOwner, aiPage, sheetFilter, watching, rejSort, aiSort, pilePicked.size,
    queuePicked.size, sweeping,
    lastTouched, ytOpen.size, scoreWindow, (state.impossible || []).length, JSON.stringify(state.scores || {}),
    state.clips.map((k) => k.clip_id + (k.preview_url ? 'v' : '') + (k.needs_recut ? 'r' : '')
      + k.clip_start + k.clip_end + JSON.stringify(k.presentations || []) + JSON.stringify(k.clay_colours || [])
      + (k.weather || '') + JSON.stringify(k.backgrounds || [])
      + JSON.stringify(k.owner_outcomes || [])),
    [...clayRows.entries()].map(([k, v]) => k + v).join(),
    (state.rej?.rows || []).map((k) => k.clip_id + (k.preview_url ? 'v' : '')),
    state.rej?.total,
    state.ai.map((k) => k.clip_id + k.label_status + (k.preview_url ? 'v' : '')
      + JSON.stringify(k.outcomes || []) + JSON.stringify(k.owner_outcomes || [])
      + (k.speed_mph ?? '') + (k.range_m ?? '')),
    state.sheet.map((v) => v.video_id + v.status + (v.used ? 'u' : '') + (v.ds_level ?? '') + (v.called ?? '') + (v.hit ?? '') + (v.miss ?? '')),
    state.progress,
    state.cats,
    state.split,
    state.exp,
    state.health,
    (state.trials?.trials || []).length,
    rejPage, (state.pile?.rows || []).map((k) => k.clip_id + (k.preview_url ? 'v' : '')), state.pile?.total,
    (state.prod?.logs || []).length, (state.prod?.tasks || []).map((t) => t.id + (t.status || '')),
    (state.costs?.rows || []).length, (state.docs?.rows || []).map((f) => f.name),
    (state.disc || []).map((v) => v.video_id),
    (state.credits?.rows || []).length, state.spend?.usd,
    (state.pile?.vids || []).map((v) => v.video_id), state.pile?.vtotal,
    (state.models || []).map((m) => m.id), state.findings && 1, drillOn,
    drillRows.length, state.coverage,
  ]);
}
let painted = '';
let tick = 0;   // which poll turn we are on; see refresh()

// After a change is applied to the DOM in place, tell the repaint it has
// nothing left to do. Without this an edit is drawn twice: once by hand,
// then again wholesale by the next poll, because state moved and the
// signature no longer matched. That second draw is what the lag after
// saving a length was — the whole grid rebuilt, every preview and every
// embed on the page thrown away and started again, to show a change that
// was already on screen.
function settled() { painted = signature(); }

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


// The owner's per-clay calls. Bound on its own rather than inside the big
// wire pass, because adding a clay re-renders one card's buttons and they
// need handlers again without the page being torn down. Idempotent: a
// button already bound is left alone, so re-running never double-fires.
function wireCalls() {

  document.querySelectorAll('[data-call]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', async () => {
      const id = b.dataset.call;
      const n = Number(b.dataset.slot || 1);
      const already = b.classList.contains('on');
      const out = already ? null : b.dataset.out;
      // paint the choice at once; the refresh confirms it
      b.closest('.calls').querySelectorAll('.callbtn').forEach((x) => x.classList.remove('on'));
      if (out) b.classList.add('on');
      const row = [...state.ai, ...state.clips].find((k) => k.clip_id === id);
      const calls = row ? ownerCalls(row) : [];
      while (calls.length < n) calls.push(null);
      calls[n - 1] = out;
      // Trailing blanks are noise, not an unanswered clay.
      while (calls.length && calls[calls.length - 1] == null) calls.pop();
      const patch = { owner_outcomes: calls };
      // The first three keep their own columns in step: the mastersheet, the
      // export and the trials all still read them.
      OWNER_SLOTS.forEach((f, i) => { patch[f] = calls[i] ?? null; });
      if (n === 1) patch.owner_outcome_at = out ? new Date().toISOString() : null;
      // Every clay's call is work, not just the first, and it is credited to
      // whoever made it rather than to whose queue the clip sat in.
      patch.called_by = calls.length ? WHOAMI() : null;
      patch.called_at = calls.length ? new Date().toISOString() : null;
      const { error } = await supabase.from('pipeline_clips')
        .update(patch).eq('clip_id', id).select('clip_id');
      if (error) note(`could not save your call — ${error.message}`, 'bad');
      if (row) Object.assign(row, patch);
      touchCard(id);
      settled();
    });
  });
  document.querySelectorAll('[data-dropclay]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', async () => {
      const id = b.dataset.dropclay;
      const n = Math.max(1, Number(b.dataset.next));
      clayRows.set(id, n);
      const row = [...state.clips, ...state.ai].find((x) => x.clip_id === id);
      // Trim the stored calls to match: a row taken away must not leave a
      // verdict behind for a clay we have decided was never there.
      if (row) {
        const calls = ownerCalls(row).slice(0, n);
        while (calls.length && calls[calls.length - 1] == null) calls.pop();
        const patch = { owner_outcomes: calls };
        OWNER_SLOTS.forEach((f, i) => { patch[f] = calls[i] ?? null; });
        const { error } = await supabase.from('pipeline_clips')
          .update(patch).eq('clip_id', id).select('clip_id');
        if (error) note(`could not drop the clay — ${error.message}`, 'bad');
        else Object.assign(row, patch);
      }
      touchCard(id);
      const card = b.closest('.clipcard, .airow, .cardv');
      const k = [...state.clips, ...state.ai].find((x) => x.clip_id === id);
      const host = card?.querySelector('.yourcall');
      if (host && k) host.outerHTML = callRows(k); else paint(true);
      wireCalls();
    });
  });
  // Presentation and weather: what the clay did and what the sky was.
  document.querySelectorAll('[data-pres]:not([data-wired])').forEach((sel) => {
    sel.dataset.wired = '1';
    sel.addEventListener('change', async () => {
      const id = sel.dataset.pres;
      const n = Number(sel.dataset.slot || 1);
      const row = [...state.clips, ...state.ai].find((x) => x.clip_id === id);
      const arr = row ? clayPresentations(row) : [];
      while (arr.length < n) arr.push(null);
      arr[n - 1] = sel.value || null;
      while (arr.length && arr[arr.length - 1] == null) arr.pop();
      // The first clay's word also fills the old single column, so anything
      // still reading that sees the clip's opening target rather than null.
      const patch = { presentations: arr, presentation: arr[0] ?? null };
      const { error } = await supabase.from('pipeline_clips')
        .update(patch).eq('clip_id', id).select('clip_id');
      if (error) return note(`could not save the presentation — ${error.message}`, 'bad');
      if (row) Object.assign(row, patch);
      touchCard(id);
      settled();
    });
  });
  document.querySelectorAll('[data-expand]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const box = b.closest('.clipmedia');
      // The media itself, so a video keeps its own controls full screen and
      // an embed keeps the player's. Nothing here ever called the Fullscreen
      // API — the old "viewer" was a fixed-position overlay, which is not the
      // same thing and is not what the button promises.
      const target = box?.querySelector('video, iframe') || box;
      if (!target) return;
      const go = target.requestFullscreen || target.webkitRequestFullscreen
        || target.webkitEnterFullscreen || target.msRequestFullscreen;
      if (go) {
        Promise.resolve(go.call(target)).catch(() => box?.classList.add('blown'));
      } else {
        box?.classList.toggle('blown');   // no API: fill the window instead
      }
    });
  });
  document.querySelectorAll('[data-bg]:not([data-wired])').forEach((sel) => {
    sel.dataset.wired = '1';
    sel.addEventListener('change', async () => {
      const id = sel.dataset.bg;
      const n = Number(sel.dataset.slot || 1);
      const row = [...state.clips, ...state.ai].find((x) => x.clip_id === id);
      const arr = row ? clayBackgrounds(row) : [];
      while (arr.length < n) arr.push(null);
      arr[n - 1] = sel.value || null;
      while (arr.length && arr[arr.length - 1] == null) arr.pop();
      // The single column is what the phase rule reads, and holds the
      // hardest background in the clip: if any clay had to be found against
      // terrain, the clip contains that difficulty whatever its partner did.
      const CLUTTER = ['treeline', 'hillside', 'valley', 'ground', 'buildings', 'mixed'];
      const hardest = arr.find((x) => CLUTTER.includes(x)) || arr.find(Boolean) || null;
      const patch = { backgrounds: arr, background: hardest };
      const { error } = await supabase.from('pipeline_clips')
        .update(patch).eq('clip_id', id).select('clip_id');
      if (error) return note(`could not save the background — ${error.message}`, 'bad');
      if (row) Object.assign(row, patch);
      touchCard(id);
      settled();
    });
  });
  document.querySelectorAll('[data-colour]:not([data-wired])').forEach((sel) => {
    sel.dataset.wired = '1';
    sel.addEventListener('change', async () => {
      const id = sel.dataset.colour;
      const n = Number(sel.dataset.slot || 1);
      const row = [...state.clips, ...state.ai].find((x) => x.clip_id === id);
      const arr = row ? clayColours(row) : [];
      while (arr.length < n) arr.push(null);
      arr[n - 1] = sel.value || null;
      while (arr.length && arr[arr.length - 1] == null) arr.pop();
      // The first clay's colour also fills the single column the phases and
      // the Roboflow tags still read.
      const patch = { clay_colours: arr, clay_colour: arr[0] ?? null };
      const { error } = await supabase.from('pipeline_clips')
        .update(patch).eq('clip_id', id).select('clip_id');
      if (error) return note(`could not save the colour — ${error.message}`, 'bad');
      if (row) Object.assign(row, patch);
      touchCard(id);
      settled();
    });
  });
  document.querySelectorAll('[data-ytplay]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.dataset.ytplay;
      ytOpen.add(id);
      touchCard(id);
      const k = [...state.clips, ...state.ai].find((x) => x.clip_id === id);
      const box = b.closest('.clipmedia');
      // Swap in place: a repaint would restart every other card on the page.
      if (box && k) { box.innerHTML = clipMedia(k); wireCalls(); settled(); } else paint(true);
    });
  });
  document.querySelectorAll('[data-tag]:not([data-wired])').forEach((sel) => {
    sel.dataset.wired = '1';
    sel.addEventListener('change', async () => {
      const id = sel.dataset.clip;
      const field = sel.dataset.tag;
      const value = sel.value || null;
      const { error } = await supabase.from('pipeline_clips')
        .update({ [field]: value }).eq('clip_id', id).select('clip_id');
      if (error) return note(`could not save the ${field} — ${error.message}`, 'bad');
      const row = [...state.clips, ...state.ai].find((x) => x.clip_id === id);
      if (row) row[field] = value;
      touchCard(id);
      settled();
    });
  });
  document.querySelectorAll('[data-addclay]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      clayRows.set(b.dataset.addclay, Math.min(MAX_CLAYS, Number(b.dataset.next)));
      // Grow the card in place. A full repaint here tore down and rebuilt
      // every video on the page to add one row of buttons, which is what
      // made adding a clay feel like the page had stalled.
      const card = b.closest('.clipcard, .airow, .cardv');
      const k = [...state.clips, ...state.ai].find((x) => x.clip_id === b.dataset.addclay);
      const host = card?.querySelector('.yourcall');
      if (host && k) host.outerHTML = callRows(k);
      else paint(true);
      wireCalls();
    });
  });
  wireTrim();
}

// The trim controls redraw their own row as they are used, so like the calls
// they bind on their own and never double-bind.
function wireTrim() {
  const rowFor = (id) => [...state.clips, ...state.ai].find((x) => x.clip_id === id);
  const redraw = (id) => {
    const k = rowFor(id);
    const host = document.querySelector(`[data-id="${CSS.escape(id)}"] .trim`);
    if (host && k) { host.outerHTML = trimRow(k); wireTrim(); } else paint(true);
  };
  const edit = (id) => {
    const k = rowFor(id);
    if (!trimEdits.has(id) && k) {
      trimEdits.set(id, { start: Number(k.clip_start), end: Number(k.clip_end) });
    }
    return trimEdits.get(id);
  };

  document.querySelectorAll('[data-verdict]:not([data-wired])').forEach((el) => {
    el.dataset.wired = '1';
    el.addEventListener('click', async () => {
      const v = el.dataset.verdict;
      if (drillOn === v) { drillOn = null; drillRows = []; return paint(true); }
      drillOn = v; drillRows = [];
      paint(true);
      drillRows = await loadDrill(v);
      paint(true);
    });
  });
  document.querySelectorAll('[data-verdictclose]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', () => { drillOn = null; drillRows = []; paint(true); });
  });
  document.querySelectorAll('[data-trimopen]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', () => { trimOpen.add(b.dataset.trimopen); redraw(b.dataset.trimopen); });
  });
  document.querySelectorAll('[data-trimcancel]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      const id = b.dataset.trimcancel;
      trimOpen.delete(id); trimEdits.delete(id); redraw(id);
    });
  });
  document.querySelectorAll('[data-trim]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      const id = b.dataset.trim;
      const e = edit(id);
      if (!e) return;
      const by = Number(b.dataset.by);
      if (b.dataset.which === 'start') e.start = Math.max(0, e.start + by);
      else e.end = e.end + by;
      // A clip that ends before it starts is not an edit, it is a mistake.
      if (e.end - e.start < 0.5) {
        note('a clip has to be at least half a second long', 'bad');
        if (b.dataset.which === 'start') e.start = e.end - 0.5; else e.end = e.start + 0.5;
      }
      redraw(id);
    });
  });
  document.querySelectorAll('[data-trimhere]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', () => {
      const id = b.dataset.trimhere;
      const k = rowFor(id);
      const v = document.querySelector(`[data-id="${CSS.escape(id)}"] video`);
      if (!k || !v) return note('play the preview first, then pause where you want it', 'bad');
      // The preview is the cut as it currently stands, so the playhead is an
      // offset into it — absolute time is the clip's own start plus that.
      const abs = Number(k.clip_start) + (v.currentTime || 0);
      const e = edit(id);
      if (b.dataset.which === 'start') e.start = Math.max(0, Math.min(abs, e.end - 0.5));
      else e.end = Math.max(e.start + 0.5, abs);
      redraw(id);
    });
  });
  document.querySelectorAll('[data-trimsave]:not([data-wired])').forEach((b) => {
    b.dataset.wired = '1';
    b.addEventListener('click', async () => {
      const id = b.dataset.trimsave;
      const e = trimEdits.get(id);
      if (!e) return;
      busy(b, true, 'Saving…');
      const { error } = await supabase.from('pipeline_clips').update({
        clip_start: Number(e.start.toFixed(2)),
        clip_end: Number(e.end.toFixed(2)),
        needs_recut: true,
        recut_note: null,
      }).eq('clip_id', id).select('clip_id');
      if (error) { note(`could not save the length — ${error.message}`, 'bad'); busy(b, false, 'Save length'); return; }
      touchCard(id);
      const k = rowFor(id);
      if (k) Object.assign(k, { clip_start: e.start, clip_end: e.end, needs_recut: true });
      trimOpen.delete(id); trimEdits.delete(id);
      redraw(id);
      settled();
      // The saved edit starts the cut itself — no second button to remember.
      // If a run is already going, the edit waits and the next run takes it.
      if (!running) {
        note(`${mmss(e.start)}–${mmss(e.end)} saved — re-cutting now`, 'good');
        runStage('recut');
      } else {
        note(`${mmss(e.start)}–${mmss(e.end)} saved — a run is going; the next re-cut takes it`, 'good');
      }
    });
  });
}

function paint(force = false) {
  // Never redraw over someone who is typing — the poll would eat a half-filled
  // form, and the sources panel is a form.
  const a = document.activeElement;
  if (!force && a && root.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
  // Nor over a preview someone is watching. A repaint rebuilds the page's
  // markup, so a playing clip was being torn out and restarted mid-flight
  // every time a count moved — the single worst of the glitches, and on the
  // one page where the whole job is watching clips. The poll comes round
  // again in eight seconds; the picture matters more than the freshness.
  if (!force && [...root.querySelectorAll('video')].some((v) => !v.paused && !v.ended)) return;

  const sig = signature();
  if (!force && sig === painted && root.dataset.up) return;
  painted = sig;
  const refocus = focusKey();

  shell(view === 'review' ? reviewView()
    : view === 'sources' ? sourcesView()
    : view === 'triage' ? triageClipsView()
    : view === 'labelling' ? labellingView()
    : view === 'impossible' ? impossibleView()
    : view === 'partnerships' ? partnershipsView()
    : view === 'findings' ? findingsView()
    : view === 'mastersheet' ? mastersheetView()
    : view === 'strategy' ? strategyView()
    : view === 'export' ? exportView()
    : view === 'health' ? healthView()
    : view === 'rejected' ? rejectedView()
    : view === 'productivity' ? productivityView()
    : view === 'costs' ? costsView()
    : view === 'documents' ? documentsView()
    : view === 'control' ? controlView()
    : officeView());

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
    b.addEventListener('click', () => {
      const stage = b.dataset.stage;
      const spec = RUNS.find((r) => r.stage === stage) || {};
      if (spec.ask) {
        // Two ways of naming the same thing, told apart by shape: a bare
        // workspace/project/version is Roboflow's, anything with a scheme is
        // a zip somewhere. Asking which would be asking the reader to know
        // our parameter names.
        const said = (window.prompt(spec.ask) || '').trim();
        if (!said) return;
        const q = /^https?:\/\//i.test(said) ? { url: said } : { rf: said };
        return runStage(stage, q);
      }
      return runStage(stage, stage === 'discover' ? {} : { limit: batch });
    }));
  // Build set and Train take no batch size — they work on the whole set —
  // and both outlive the proxy's wait, so the 202 is the expected answer.
  document.querySelectorAll('[data-run]').forEach((b) =>
    b.addEventListener('click', () => {
      // The rung choice names the set as well as filtering it, so phase 1's
      // weights and phase 1–2's weights never overwrite one another and can
      // be compared afterwards.
      const phases = document.getElementById('phasepick')?.value || '';
      const name = phases ? `p${phases.replace(/,/g, '')}` : 'brace';
      runStage(b.dataset.run, phases ? { phases, name } : { name });
    }));
  // Criteria discovery from the Dataset strategy page: search the phrases
  // written for that ladder rung and stamp what's found with its level.
  document.querySelectorAll('[data-dsfind]').forEach((b) =>
    b.addEventListener('click', () => runStage('discover', { level: b.dataset.dsfind })));
  // The owner's verdict on a shot — ground truth. Models are scored against
  // these, and one day an outcome model will be trained on them.
  wireGlobals();
  wireCalls();
  // ---- the office ----

  document.getElementById('addtask')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('task-title').value.trim();
    if (!title) return;
    const { error } = await supabase.from('todos')
      .insert({ title, added_by: state.email }).select('id');
    note(error ? `could not add the task — ${error.message}` : 'task added', error ? 'bad' : 'good');
    document.getElementById('task-title').value = '';
    refresh();
  });
  document.querySelectorAll('.kcard').forEach((card) => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.task);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  document.querySelectorAll('.kcol').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const id = Number(e.dataTransfer.getData('text/plain'));
      if (!id) return;
      const to = col.dataset.col;
      const { error } = await supabase.from('todos')
        .update({
          status: to,
          done: to === 'complete',
          done_at: to === 'complete' ? new Date().toISOString() : null,
        }).eq('id', id).select('id');
      if (error) note(`could not move the task — ${error.message}`, 'bad');
      refresh();
    });
  });
  document.querySelectorAll('[data-taskdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const { error } = await supabase.from('todos').delete()
        .eq('id', Number(b.dataset.taskdel));
      if (error) note(`could not delete the task — ${error.message}`, 'bad');
      refresh();
    }));
  // Hours are measured, never entered: there is nothing here to submit and
  // nothing to delete. bankTime() writes them from time actually spent.
  document.querySelectorAll('[data-costkind]').forEach((b) =>
    b.addEventListener('click', () => {
      const rec = b.dataset.costkind === 'rec';
      document.querySelectorAll('[data-costkind]').forEach((x) =>
        x.classList.toggle('on', x === b));
      document.getElementById('ac-freqs').style.display = rec ? '' : 'none';
      document.getElementById('ac-rec').value = rec
        ? (document.querySelector('[data-costfreq].on')?.dataset.costfreq || 'monthly')
        : 'one-time';
    }));
  document.querySelectorAll('[data-costfreq]').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-costfreq]').forEach((x) =>
        x.classList.toggle('on', x === b));
      document.getElementById('ac-rec').value = b.dataset.costfreq;
    }));
  document.getElementById('addcost')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await supabase.from('expenses').insert({
      email: state.email,
      item: document.getElementById('ac-item').value.trim(),
      amount: Number(document.getElementById('ac-amount').value),
      category: document.getElementById('ac-cat').value,
      bought_on: today(),
      recurrence: document.getElementById('ac-rec').value,
    }).select('id');
    note(error ? `could not log the purchase — ${error.message}` : 'purchase logged', error ? 'bad' : 'good');
    if (!error) { document.getElementById('ac-item').value = ''; document.getElementById('ac-amount').value = ''; }
    refresh();
  });
  document.querySelectorAll('[data-costdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      await supabase.from('expenses').delete().eq('id', Number(b.dataset.costdel));
      refresh();
    }));
  document.getElementById('doccompose')?.addEventListener('click', () => {
    const c = document.getElementById('composer');
    c.style.display = c.style.display === 'none' ? '' : 'none';
    if (c.style.display !== 'none') document.getElementById('doc-title')?.focus();
  });
  document.getElementById('docsave')?.addEventListener('click', async () => {
    const title = document.getElementById('doc-title').value.trim();
    const body = document.getElementById('doc-body').value;
    if (!title) { note('give it a title first', 'bad'); return; }
    const name = `${Date.now()}-${title.replace(/[^\w\- ]+/g, '').trim() || 'untitled'}.md`;
    const { error } = await supabase.storage.from('documents')
      .upload(name, new Blob([body], { type: 'text/markdown' }));
    note(error ? `could not save — ${error.message}` : 'saved to the shelf', error ? 'bad' : 'good');
    if (!error) {
      document.getElementById('doc-title').value = '';
      document.getElementById('doc-body').value = '';
      document.getElementById('composer').style.display = 'none';
    }
    refresh();
  });
  document.getElementById('docpick')?.addEventListener('click', () =>
    document.getElementById('docupload')?.click());
  document.getElementById('docupload')?.addEventListener('change', async (e) => {
    const files = [...(e.target.files || [])];
    if (!files.length) return;
    note(`uploading ${files.length} file${files.length === 1 ? '' : 's'}…`);
    for (const f of files) {
      const { error } = await supabase.storage.from('documents')
        .upload(`${Date.now()}-${f.name}`, f);
      if (error) note(`${f.name} failed — ${error.message}`, 'bad');
    }
    note('upload finished', 'good');
    refresh();
  });
  document.querySelectorAll('[data-docdl]').forEach((b) =>
    b.addEventListener('click', async () => {
      const { data, error } = await supabase.storage.from('documents')
        .createSignedUrl(b.dataset.docdl, 3600);
      if (error || !data?.signedUrl) { note(`could not open — ${error?.message || 'no link'}`, 'bad'); return; }
      window.open(data.signedUrl, '_blank', 'noopener');
    }));
  document.querySelectorAll('[data-docdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      const { error } = await supabase.storage.from('documents').remove([b.dataset.docdel]);
      note(error ? `could not delete — ${error.message}` : 'deleted', error ? 'bad' : 'good');
      refresh();
    }));
  document.getElementById('addtopup')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = Number(document.getElementById('tu-amount').value);
    if (!(amount > 0)) return;
    const { error } = await supabase.from('credit_topups')
      .insert({ amount_usd: amount }).select('id');
    note(error ? `could not record the top-up \u2014 ${error.message}` : `$${amount.toFixed(2)} top-up recorded`, error ? 'bad' : 'good');
    if (!error) document.getElementById('tu-amount').value = '';
    refresh();
  });
  document.querySelectorAll('[data-topupdel]').forEach((b) =>
    b.addEventListener('click', async () => {
      await supabase.from('credit_topups').delete().eq('id', Number(b.dataset.topupdel));
      refresh();
    }));
  document.getElementById('healthrun')?.addEventListener('click', () => runStage('health'));
  // The bulk handover and the ledger download, from the Export page.
  document.getElementById('exportall')?.addEventListener('click', async () => {
    const { data, error } = await supabase.from('pipeline_clips')
      .select('clip_id').eq('label_status', 'pending').limit(2000);
    if (error) { note(`could not read the queue — ${error.message}`, 'bad'); return; }
    await queueClips((data || []).map((r) => r.clip_id));
  });
  document.getElementById('exportcsv')?.addEventListener('click', () =>
    exportCsv().catch((e) => note(`manifest failed — ${e.message || e}`, 'bad')));
  document.querySelectorAll('[data-unbin]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const { error } = await supabase.from('pipeline_videos')
        .update({ status: 'rejected' }).eq('video_id', b.dataset.unbin).select('video_id');
      note(error ? `could not restore — ${error.message}`
        : `${b.dataset.unbin} back in the rejected pile`, error ? 'bad' : 'good');
      refresh();
    }));
  // The rejected-video audit: watch triage's discards in place, and
  // overrule a wrong call by sending the video back for a fresh score.
  document.querySelectorAll('[data-watch]').forEach((b) =>
    b.addEventListener('click', () => {
      watching = watching === b.dataset.watch ? null : b.dataset.watch;
      paint(true);
    }));
  document.querySelectorAll('[data-retriage]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const { error } = await supabase.from('pipeline_videos')
        .update({ status: 'discovered', local_path: null })
        .eq('video_id', b.dataset.retriage).select('video_id');
      note(error ? `could not re-triage — ${error.message}`
        : `${b.dataset.retriage} sent back — the next triage run rescores it`, error ? 'bad' : 'good');
      refresh();
    }));
  // The eye overruling the machine outright. Re-triage only offers the video
  // to the same judge that already refused it, and the rejected pile keeps
  // no file, so nothing can be clipped from where it stands: this sends it
  // back to be fetched with 'forced' set, and triage hands it to the clipper
  // without scoring it at all.
  document.querySelectorAll('[data-force]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      const { error } = await supabase.from('pipeline_videos')
        .update({ status: 'discovered', forced: true, local_path: null,
                  triage_notes: 'forced in by the owner — queued to fetch' })
        .eq('video_id', b.dataset.force).select('video_id');
      note(error ? `could not force it in — ${error.message}`
        : `${b.dataset.force} forced in — the next triage run fetches it and sends it straight to the clipper`,
      error ? 'bad' : 'good');
      refresh();
    }));
  // Placing a video on the ladder by hand, from the Mastersheet.
  document.querySelectorAll('[data-dslevel]').forEach((sel) =>
    sel.addEventListener('change', async () => {
      const lvl = sel.value ? Number(sel.value) : null;
      const { error } = await supabase.from('pipeline_videos')
        .update({ ds_level: lvl }).eq('video_id', sel.dataset.dslevel).select('video_id');
      note(error ? `could not set the level — ${error.message}`
        : `${sel.dataset.dslevel} placed at ${lvl ? `level ${lvl}` : 'no level'}`, error ? 'bad' : 'good');
    }));
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

  document.querySelectorAll('[data-sendone]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    queueClips([b.dataset.sendone], b);
  }));
  document.querySelectorAll('[data-impossible]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    markImpossible([b.dataset.impossible], b);
  }));
  document.querySelectorAll('[data-unimpossible]').forEach((b) => b.addEventListener('click', async (e) => {
    e.stopPropagation();
    busy(b, true, 'Returning…');
    const { error } = await supabase.from('pipeline_clips')
      .update({ label_status: 'pending', impossible_at: null, impossible_by: null })
      .eq('clip_id', b.dataset.unimpossible).select('clip_id');
    note(error ? `could not return it — ${error.message}` : 'back in the queue',
      error ? 'bad' : 'good');
    refresh();
  }));
  document.querySelectorAll('[data-deleteone]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteClips([b.dataset.deleteone], b);
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
  const syncPile = () => {
    const n = document.getElementById('pilen');
    if (n) n.textContent = pilePicked.size;
    const del = document.getElementById('piledel');
    if (del) del.disabled = !pilePicked.size;
  };
  document.querySelectorAll('[data-pilepick]').forEach((cb) => cb.addEventListener('change', () => {
    cb.checked ? pilePicked.add(cb.dataset.pilepick) : pilePicked.delete(cb.dataset.pilepick);
    cb.closest('.cardv')?.classList.toggle('picked', cb.checked);
    syncPile();
  }));
  wireSweep(document.querySelectorAll('.cardv.rej[data-pileid]'),
    (card) => card.dataset.pileid, pilePicked, syncPile);
  document.getElementById('pileall')?.addEventListener('click', () => {
    document.querySelectorAll('[data-pilepick]').forEach((cb) => {
      cb.checked = true;
      pilePicked.add(cb.dataset.pilepick);
      cb.closest('.cardv')?.classList.add('picked');
    });
    syncPile();
  });
  document.getElementById('pilenone')?.addEventListener('click', () => {
    pilePicked.clear();
    document.querySelectorAll('[data-pilepick]').forEach((cb) => {
      cb.checked = false;
      cb.closest('.cardv')?.classList.remove('picked');
    });
    syncPile();
  });
  document.querySelectorAll('[data-bin]').forEach((b) =>
    b.addEventListener('click', async () => {
      busy(b, true, 'Deleting…');
      // 'binned', not deleted: the row survives so discovery's dedupe
      // still knows this video and can never re-collect it.
      const { error } = await supabase.from('pipeline_videos')
        .update({ status: 'binned' }).eq('video_id', b.dataset.bin).select('video_id');
      note(error ? `could not delete — ${error.message}`
        : 'removed from the pile — the sheet still remembers it', error ? 'bad' : 'good');
      pilePicked.delete(b.dataset.bin);
      state.loading = true; paint(true); refresh();
    }));
  document.getElementById('piledel')?.addEventListener('click', async (e) => {
    const ids = [...pilePicked];
    if (!ids.length) return;
    busy(e.target, true, 'Deleting…');
    // 'binned', not deleted: the row must survive so discovery's dedupe
    // still knows this video and can never re-collect it.
    const { error } = await supabase.from('pipeline_videos')
      .update({ status: 'binned' }).in('video_id', ids).select('video_id');
    note(error ? `could not delete — ${error.message}`
      : `${ids.length} removed from the pile — the sheet still remembers them`, error ? 'bad' : 'good');
    if (!error) pilePicked.clear();
    state.loading = true; paint(true); refresh();
  });
  // The same sweep for the review queue: judging 83 videos one card at a
  // time when most are obvious noes is the slow way round.
  const syncQueue = () => {
    const n = document.getElementById('qn');
    if (n) n.textContent = queuePicked.size;
    const del = document.getElementById('qdel');
    if (del) del.disabled = !queuePicked.size;
  };
  document.querySelectorAll('[data-qpick]').forEach((cb) => cb.addEventListener('change', () => {
    cb.checked ? queuePicked.add(cb.dataset.qpick) : queuePicked.delete(cb.dataset.qpick);
    cb.closest('.cardv')?.classList.toggle('picked', cb.checked);
    syncQueue();
  }));
  wireSweep(document.querySelectorAll('.cardv[data-qid]'),
    (card) => card.dataset.qid, queuePicked, syncQueue);
  document.getElementById('qall')?.addEventListener('click', () => {
    document.querySelectorAll('[data-qpick]').forEach((cb) => {
      cb.checked = true;
      queuePicked.add(cb.dataset.qpick);
      cb.closest('.cardv')?.classList.add('picked');
    });
    syncQueue();
  });
  document.getElementById('qnone')?.addEventListener('click', () => {
    queuePicked.clear();
    document.querySelectorAll('[data-qpick]').forEach((cb) => {
      cb.checked = false;
      cb.closest('.cardv')?.classList.remove('picked');
    });
    syncQueue();
  });
  document.getElementById('qdel')?.addEventListener('click', async (e) => {
    const ids = [...queuePicked];
    if (!ids.length) return;
    busy(e.target, true, 'Deleting…');
    // 'binned' for the same reason the pile uses it: the row must survive so
    // discovery's dedupe still knows this video and never re-collects it.
    const { error } = await supabase.from('pipeline_videos')
      .update({ status: 'binned', local_path: null }).in('video_id', ids).select('video_id');
    note(error ? `could not delete — ${error.message}`
      : `${ids.length} removed from the queue — the sheet still remembers them`, error ? 'bad' : 'good');
    if (!error) queuePicked.clear();
    state.loading = true; paint(true); refresh();
  });
  document.getElementById('clipowner')?.addEventListener('change', (e) => {
    clipOwner = e.target.value;
    clipPage = 0;
    state.loading = true; paint(true); refresh();
  });
  document.getElementById('scorewin')?.addEventListener('change', async (e) => {
    scoreWindow = e.target.value;
    state.loading = true; paint(true);
    // Both pages count over this window, so both reload behind it.
    const [sc, pr] = await Promise.all([loadScores(), loadProd()]);
    state.scores = sc; state.prod = pr; state.loading = false;
    paint(true);
  });
  document.getElementById('rejsort')?.addEventListener('change', (e) => {
    flip(() => { rejSort = e.target.value; rejPage = 0; });
  });
  document.getElementById('aisort')?.addEventListener('change', (e) => {
    flip(() => { aiSort = e.target.value; aiPage = 0; });
  });
  document.getElementById('rejprev')?.addEventListener('click', () => {
    flip(() => { rejPage = Math.max(0, rejPage - 1); });
  });
  document.getElementById('rejnext')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil((state.pile?.vtotal ?? 0) / 40));
    flip(() => { rejPage = Math.min(rejPage + 1, pages - 1); });
  });
  document.getElementById('clipnext')?.addEventListener('click', () => {
    const pages = Math.max(1, Math.ceil((state.clipTotal ?? state.counts?.pending ?? 0) / TRIAGE_PAGE));
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
  document.getElementById('sweep')?.addEventListener('click', () => {
    sweeping = !sweeping;
    sweepDown = false;
    paint(true);
  });
  const syncPick = () => {
    const n = document.getElementById('pickn');
    if (n) n.textContent = picked.size;
    const dn = document.getElementById('pickdn');
    if (dn) dn.textContent = picked.size;
    const send = document.getElementById('sendsel');
    if (send) send.disabled = !picked.size;
    const del = document.getElementById('deletesel');
    if (del) del.disabled = !picked.size;
  };
  if (sweeping) {
    const set = (card, on) => {
      const id = card.dataset.clip;
      if (!id) return;
      on ? picked.add(id) : picked.delete(id);
      card.classList.toggle('picked', on);
      syncPick();
    };
    document.querySelectorAll('.clipcard[data-clip]').forEach((card) => {
      card.addEventListener('mousedown', (e) => {
        if (e.target.closest('[data-sendone], [data-deleteone]')) return;
        e.preventDefault();
        sweepDown = true;
        set(card, !picked.has(card.dataset.clip));
      });
      card.addEventListener('mouseenter', () => {
        if (sweepDown) set(card, true);
      });
    });
  }
  document.getElementById('pickall')?.addEventListener('click', () => {
    document.querySelectorAll('.clipcard[data-clip]').forEach((card) => {
      picked.add(card.dataset.clip);
      card.classList.add('picked');
    });
    syncPick();
  });
  document.getElementById('picknone')?.addEventListener('click', () => {
    picked.clear();
    document.querySelectorAll('.clipcard[data-clip]').forEach((c) => c.classList.remove('picked'));
    syncPick();
  });
  document.getElementById('sendsel')?.addEventListener('click', (e) =>
    queueClips([...picked], e.target));
  document.getElementById('deletesel')?.addEventListener('click', (e) =>
    deleteClips([...picked], e.target));
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
    // settled, not all: a loader that throws should cost its own panel and
    // nothing else. A missing function once took every figure on the page
    // with it, and the page reported only that it could not read the pipeline.
    // Spend, health and the activity feed do not change between one poll
    // and the next, and reloading them every fifteen seconds — twice over,
    // with two people on the page — was work nobody asked for. Once a
    // minute is plenty; the counts and whatever view is open stay live.
    tick += 1;
    const slow = tick % 4 === 1;
    const settle = (p, fallback) => Promise.resolve(p).then(
      (v) => v, (e) => { note(`one panel could not load — ${e.message || e}`, 'bad'); return fallback; });
    const [counts, queue, sources, issues, spend, coverage, clips, sent, rej, splitPrev, ai, trials, sheet, progress, cats, exp, health, pile, prod, costs, docs, disc, activity, credits, models, findings, scores, impossible] = await Promise.all([
      settle(loadCounts(), state.counts),
      view === 'review' ? settle(loadQueue(), state.queue) : Promise.resolve(state.queue),
      view === 'sources' ? settle(loadSources(), state.sources) : Promise.resolve(state.sources),
      view === 'control' ? settle(loadIssues(), state.issues) : Promise.resolve(state.issues),
      slow ? settle(loadSpend(), state.spend) : Promise.resolve(state.spend),
      view === 'control' ? settle(loadCoverage(), state.coverage) : Promise.resolve(state.coverage),
      view === 'triage' ? settle(loadClips(), state.clips) : Promise.resolve(state.clips),
      view === 'triage' ? settle(loadSentClips(), state.sent) : Promise.resolve(state.sent),
      view === 'triage' ? settle(loadRejectedClips(), state.rej) : Promise.resolve(state.rej),
      view === 'triage' ? settle(loadSplitPreview(), state.split) : Promise.resolve(state.split),
      view === 'labelling' ? settle(loadAiClips(), state.ai) : Promise.resolve(state.ai),
      view === 'labelling' ? settle(loadTrials(), state.trials) : Promise.resolve(state.trials),
      view === 'mastersheet' ? settle(loadSheet(), state.sheet) : Promise.resolve(state.sheet),
      view === 'strategy' ? settle(loadProgress(), state.progress) : Promise.resolve(state.progress),
      view === 'strategy' ? settle(loadCategories(), state.cats) : Promise.resolve(state.cats),
      view === 'export' ? settle(loadExport(), state.exp) : Promise.resolve(state.exp),
      slow ? settle(loadHealth(), state.health) : Promise.resolve(state.health),
      view === 'rejected' ? settle(loadRejectedPile(), state.pile) : Promise.resolve(state.pile),
      view === 'productivity' ? settle(loadProd(), state.prod) : Promise.resolve(state.prod),
      view === 'costs' ? settle(loadCosts(), state.costs) : Promise.resolve(state.costs),
      view === 'documents' ? settle(loadDocs(), state.docs) : Promise.resolve(state.docs),
      view === 'triage' ? settle(loadDiscovered(), state.disc) : Promise.resolve(state.disc),
      slow ? settle(loadActivity(), state.activity) : Promise.resolve(state.activity),
      view === 'health' ? settle(loadCredits(), state.credits) : Promise.resolve(state.credits),
      view === 'labelling' ? settle(loadModels(), state.models) : Promise.resolve(state.models),
      view === 'findings' ? settle(loadFindings(), state.findings) : Promise.resolve(state.findings),
      view === 'partnerships' ? settle(loadPartners(), state.partners) : Promise.resolve(state.partners),
      view === 'impossible' ? settle(loadImpossible(), state.impossible) : Promise.resolve(state.impossible),
      view === 'triage' ? settle(loadScores(), state.scores) : Promise.resolve(state.scores),
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
    state.split = splitPrev;
    state.ai = ai;
    state.models = models;
    state.findings = findings;
    state.scores = scores;
    state.impossible = impossible;
    state.trials = trials;
    state.sheet = sheet;
    state.progress = progress;
    state.cats = cats;
    state.exp = exp;
    state.health = health;
    state.pile = pile;
    state.prod = prod;
    state.costs = costs;
    state.docs = docs;
    state.disc = disc;
    state.activity = activity;
    state.credits = credits;
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
  state = { email, counts: null, queue: [], sources: [], issues: [], spend: null, coverage: [], clips: [], sent: [], rej: { rows: [], total: 0 }, ai: [], sheet: [], sheetErr: '', progress: [], cats: [], split: [], exp: null, health: [], pile: { rows: [], total: 0 }, trials: null, prod: null, costs: null, docs: null, disc: [], activity: [], credits: null, models: [], findings: null, scores: null, impossible: [], clipTotal: null, loading: true };
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
  }, 15000);
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
  stage('reading your authenticator');
  const { data: factors, error: fErr } = await within(supabase.auth.mfa.listFactors(), 15, 'Reading your authenticator');
  if (fErr) return renderBroken('Could not read your authenticator settings.', fErr);
  const verified = (factors?.totp || []).filter((f) => f.status === 'verified');

  // A recovery link lands at aal1, and Supabase refuses a password change on
  // an account with MFA until the session reaches aal2. So on a recovery the
  // authenticator comes first and the new password second — the reverse of
  // the first-run order, where there is no factor to answer with yet.
  if (recovering) {
    if (verified.length && aal?.currentLevel !== 'aal2') return renderChallenge(verified[0].id);
    return renderSetPassword();
  }

  if (!authMethods(session, aal).includes('password')
      && sessionStorage.getItem('brace-portal-pw') !== '1') {
    return renderSetPassword();
  }

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
  if (event === 'PASSWORD_RECOVERY') {
    recovering = true;
    sessionStorage.removeItem('brace-portal-pw');   // a stale flag must not skip it
    return boot();
  }
  if (event !== 'SIGNED_IN' && event !== 'MFA_CHALLENGE_VERIFIED') return;
  // A stored session is replayed as SIGNED_IN on every load, so this fires once
  // for a session route() is already handling. Re-route only when the token has
  // genuinely changed: a real sign-in, or the aal2 token a verified code mints.
  if (session?.access_token && session.access_token === routedToken) return;
  boot();   // if a pass is already running, boot() defers the decision to its end
});
boot();
