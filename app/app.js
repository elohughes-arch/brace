/* ============================================================================
   BRACE app — simple WHOOP-style overview + process shooting
   Real auth, storage and data via Supabase. CV model is stubbed (data.js).
   ========================================================================== */
import { supabase } from './supabase.js';
import { processClip, PROC_STEPS, greeting } from './data.js';

const root = document.getElementById('root');
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const ic = (id, w = 20) => `<svg width="${w}" height="${w}" aria-hidden="true"><use href="#i-${id}"/></svg>`;

let state = { user: null, name: '', sessions: [], route: 'home', authMode: 'signin', busy: false };

/* ---------- boot ---------- */
init();
async function init() {
  root.innerHTML = `<div class="center-load">Loading…</div>`;
  const { data: { session } } = await supabase.auth.getSession();
  state.user = session?.user || null;
  supabase.auth.onAuthStateChange((_e, s) => {
    const was = state.user?.id;
    state.user = s?.user || null;
    if (state.user?.id !== was) { if (state.user) enter(); else renderAuth(); }
  });
  window.addEventListener('hashchange', route);
  if (state.user) enter(); else renderAuth();
}

async function enter() {
  state.name = await loadName();
  await loadSessions();
  route();
}

function route() {
  if (!state.user) return renderAuth();
  const m = (location.hash || '').match(/^#\/s\/(.+)$/);
  if (m) { const s = state.sessions.find(x => x.id === m[1]); if (s) return renderDetail(s); }
  renderHome();
}

/* ---------- data ---------- */
async function loadName() {
  const { data } = await supabase.from('profiles').select('name').eq('id', state.user.id).maybeSingle();
  return data?.name || (state.user.email || '').split('@')[0];
}
async function loadSessions() {
  const { data } = await supabase.from('sessions').select('*').order('created_at', { ascending: false });
  state.sessions = data || [];
}

/* ---------- AUTH ---------- */
function renderAuth() {
  const signup = state.authMode === 'signup';
  root.innerHTML = `
  <div class="auth">
    <div class="bp"></div><div class="glow"></div>
    <div class="auth-card">
      <div class="auth-brand">
        <svg class="logo" aria-hidden="true"><use href="#i-logo"/></svg>
        <span class="wm">BRACE</span><span class="tg">The Modern Shooting Log</span>
      </div>
      <div class="auth-panel">
        <h1>${signup ? 'Create your account' : 'Welcome back'}</h1>
        <p class="sub">${signup ? 'Take your founding place — it costs nothing.' : 'Sign in to your shooting.'}</p>
        <form id="authForm" novalidate>
          ${signup ? `<div class="field"><label for="name">Name</label><input id="name" type="text" placeholder="James Alderton" autocomplete="name"></div>` : ''}
          <div class="field"><label for="email">Email</label><input id="email" type="email" placeholder="you@shootingclub.co.uk" autocomplete="email" required></div>
          <div class="field"><label for="pw">Password</label><input id="pw" type="password" placeholder="At least 6 characters" autocomplete="${signup ? 'new-password' : 'current-password'}" required></div>
          <p class="auth-err" id="authErr" role="alert"></p>
          <button class="btn btn-primary btn-block btn-lg" type="submit" id="authBtn">${signup ? 'Create account' : 'Sign in'}</button>
        </form>
        <div class="auth-switch">${signup ? 'Already with us?' : 'No account yet?'}
          <button id="authSwitch" type="button">${signup ? 'Sign in' : 'Create one'}</button>
        </div>
      </div>
      <p class="auth-note">Your shooting is private to you · Brace is now in development</p>
    </div>
  </div>`;

  const form = document.getElementById('authForm');
  const err = document.getElementById('authErr');
  const btn = document.getElementById('authBtn');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const email = document.getElementById('email').value.trim();
    const pw = document.getElementById('pw').value;
    const name = signup ? (document.getElementById('name').value.trim()) : '';
    if (!/.+@.+\..+/.test(email)) { err.textContent = 'Enter a valid email address.'; return; }
    if (pw.length < 6) { err.textContent = 'Password must be at least 6 characters.'; return; }
    btn.disabled = true; btn.textContent = signup ? 'Creating…' : 'Signing in…';
    try {
      if (signup) {
        const { data, error } = await supabase.auth.signUp({ email, password: pw, options: { data: { name } } });
        if (error) throw error;
        if (!data.session) {
          // email confirmation is on — guide the user
          root.querySelector('.auth-panel').innerHTML =
            `<h1>Check your inbox</h1><p class="sub">We've sent a confirmation link to <b style="color:var(--c-ivory)">${email}</b>. Confirm it, then sign in.</p>
             <button class="btn btn-ghost btn-block" id="backSignin">Back to sign in</button>`;
          document.getElementById('backSignin').addEventListener('click', () => { state.authMode = 'signin'; renderAuth(); });
          return;
        }
        // session present (confirmation off) → onAuthStateChange will enter()
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
      }
    } catch (ex) {
      err.textContent = friendlyErr(ex);
      btn.disabled = false; btn.textContent = signup ? 'Create account' : 'Sign in';
    }
  });
  document.getElementById('authSwitch').addEventListener('click', () => { state.authMode = signup ? 'signin' : 'signup'; renderAuth(); });
}
function friendlyErr(ex) {
  const m = (ex && ex.message) || 'Something went wrong.';
  if (/invalid login/i.test(m)) return 'Email or password not recognised.';
  if (/already registered/i.test(m)) return 'That email already has an account — sign in instead.';
  return m;
}

/* ---------- HOME (overview) ---------- */
function renderHome() {
  const sessions = state.sessions;
  const latest = sessions[0];
  const score = latest ? (latest.score || 0) : 0;
  const week = sessions.filter(s => Date.now() - new Date(s.created_at).getTime() < 7 * 864e5);
  const avgRate = sessions.length ? Math.round(sessions.reduce((a, s) => a + (s.hit_rate || 0), 0) / sessions.length) : 0;
  const bestRun = sessions.reduce((a, s) => Math.max(a, s.best_run || 0), 0);

  root.innerHTML = shell(`
    ${ovHero(latest, score)}
    <div class="tiles rv">
      ${tile('Avg hit rate', avgRate, '%', `${sessions.length} sessions`)}
      ${tile('Best run', bestRun, '', 'straight targets', false)}
      ${tile('This week', week.length, '', week.length === 1 ? 'session' : 'sessions', false)}
    </div>

    <div class="sec rv">
      <div class="sec-head"><span class="t">Recent sessions</span></div>
      ${sessions.length ? `<div class="sessions">${sessions.slice(0, 6).map(sessionRow).join('')}</div>`
        : `<div class="empty">No sessions yet. Process your first below.</div>`}
    </div>

    ${processCard()}
  `);
  wireHome();
}

function shell(body) {
  return `
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="app" id="main">
    <header class="topbar">
      <div class="who"><div class="g">${greeting()},</div><div class="n">${esc(state.name)}</div></div>
      <button class="iconbtn" id="signOut" aria-label="Sign out">${ic('signout', 18)}</button>
    </header>
    ${body}
  </div>`;
}

function ovHero(latest, score) {
  const R = 92, C = 2 * Math.PI * R;
  const off = C * (1 - Math.max(0, Math.min(100, score)) / 100);
  const sub = latest
    ? `Your last session — <b>${latest.ground || latest.discipline}</b>, ${latest.hit_rate}% on ${latest.targets}.`
    : `Process a clip to see your first score.`;
  return `
  <section class="ov-hero rv">
    <div class="glow"></div>
    <div class="ring-wrap">
      <svg class="ring" viewBox="0 0 220 220" aria-hidden="true">
        <defs><linearGradient id="ringgrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#9C7E45"/><stop offset="1" stop-color="#C9A968"/></linearGradient></defs>
        <circle class="track" cx="110" cy="110" r="${R}" stroke-width="12"/>
        <circle class="bar" cx="110" cy="110" r="${R}" stroke-width="12"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${reduce ? off.toFixed(1) : C.toFixed(1)}" data-off="${off.toFixed(1)}"/>
      </svg>
      <div class="ring-center"><div class="v" data-count="${score}">${reduce ? score : 0}</div><div class="l">Form</div></div>
    </div>
    <p class="ov-sub">${sub}</p>
  </section>`;
}

function tile(label, val, unit, sub, up = true) {
  return `<div class="tile"><div class="l">${label}</div><div class="v">${val}${unit ? `<span class="u">${unit}</span>` : ''}</div><div class="d ${up && val ? 'up' : ''}">${sub}</div></div>`;
}

function sessionRow(s) {
  const dt = new Date(s.created_at);
  const proc = s.status !== 'done';
  return `<a class="session-row" href="#/s/${s.id}">
    <span class="date"><span class="d">${dt.getDate()}</span><span class="m">${MONTHS[dt.getMonth()]}</span></span>
    <span class="mid"><span class="t">${esc(s.ground || s.discipline || 'Session')}</span><span class="s">${esc(s.discipline || '')}${s.ground ? ' · ' : ''}${s.targets ? s.targets + ' targets' : ''}</span></span>
    <span class="end">${proc ? `<span class="pill proc"><span class="dot"></span>Processing</span>`
      : `<span class="v score">${s.score || 0}</span><span class="l">${s.hit_rate}% hit</span>`}</span>
  </a>`;
}

function processCard() {
  return `
  <section class="process rv" id="process">
    <div id="procBody">
      <div class="ic">${ic('upload', 20)}</div>
      <h3>Process a session</h3>
      <p>Pick a clip from your camera roll — the footage from your Meta glasses or POV camera. Brace reads it and turns it into your metrics.</p>
      <button class="btn btn-primary btn-lg" id="pickBtn">${ic('upload', 16)} Choose a clip</button>
      <input type="file" id="clipInput" accept="video/*" hidden />
      <div class="hint">${ic('lock', 14)} Your footage is private to you.</div>
    </div>
  </section>`;
}

function wireHome() {
  document.getElementById('signOut')?.addEventListener('click', async () => { await supabase.auth.signOut(); });
  // animate ring + count
  if (!reduce) requestAnimationFrame(() => {
    const bar = root.querySelector('.ring .bar');
    if (bar) bar.style.strokeDashoffset = bar.getAttribute('data-off');
    countUp(root.querySelector('.ring-center .v'));
  });
  // Clip acquisition. Web = file picker (per-clip consent). For the real
  // "Allow access to your photos & videos" permission grant, this is the single
  // place to swap in the native Capacitor path — see NATIVE-SETUP.md.
  const pick = document.getElementById('pickBtn');
  const input = document.getElementById('clipInput');
  if (pick && input) {
    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', () => { if (input.files && input.files[0]) runProcess(input.files[0]); });
  }
}

function countUp(el) {
  if (!el) return;
  const target = parseInt(el.getAttribute('data-count'), 10) || 0;
  let start = null; const dur = 900;
  function step(ts) { if (start === null) start = ts; const p = Math.min((ts - start) / dur, 1); const e = 1 - Math.pow(1 - p, 3); el.textContent = Math.round(target * e); if (p < 1) requestAnimationFrame(step); }
  requestAnimationFrame(step);
}

/* ---------- process flow ---------- */
async function runProcess(file) {
  if (state.busy) return; state.busy = true;
  const body = document.getElementById('procBody');
  const steps = PROC_STEPS;
  body.innerHTML = `
    <div class="proc">
      <div class="ring-mini">${ic('loader', 54)}</div>
      <h3>Brace is reading your day</h3>
      <p class="step" id="pStep">${steps[0]}</p>
      <div class="proc-bar"><i id="pBar"></i></div>
    </div>`;
  const stepEl = document.getElementById('pStep');
  const barEl = document.getElementById('pBar');

  // kick off the real upload + the (stubbed) model in parallel with the animation
  const work = (async () => {
    let video_path = null;
    try {
      const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${state.user.id}/${cryptoId()}.${ext}`;
      const { error: upErr } = await supabase.storage.from('clips').upload(path, file, { upsert: false, contentType: file.type || 'video/mp4' });
      if (!upErr) video_path = path;
    } catch (e) { /* upload best-effort; metrics still produced */ }
    const m = await processClip(file); // PLACEHOLDER for the real CV model
    const row = {
      user_id: state.user.id, name: m.discipline + ' session', discipline: m.discipline, ground: m.ground,
      targets: m.targets, hits: m.hits, hit_rate: m.hitRate, best_run: m.bestRun, score: m.score,
      status: 'done', video_path, metrics: m.metrics,
    };
    const { data, error } = await supabase.from('sessions').insert(row).select().single();
    if (error) throw error;
    return data;
  })();

  // advance the visible steps over ~3.2s (or instantly under reduced motion)
  for (let i = 0; i < steps.length; i++) {
    if (stepEl) stepEl.textContent = steps[i];
    if (barEl) barEl.style.width = Math.round(((i + 1) / steps.length) * 100) + '%';
    await wait(reduce ? 40 : 640);
  }

  try {
    const created = await work;
    await loadSessions();
    state.busy = false;
    location.hash = `#/s/${created.id}`;
    route();
  } catch (ex) {
    state.busy = false;
    if (body) body.innerHTML = `<div class="ic">${ic('upload', 20)}</div><h3>That didn't process</h3>
      <p>${esc(friendlyErr(ex))}</p><button class="btn btn-primary" id="retry">Try another clip</button>`;
    document.getElementById('retry')?.addEventListener('click', renderHome);
  }
}

/* ---------- SESSION DETAIL ---------- */
function renderDetail(s) {
  const m = s.metrics || {};
  const map = Array.isArray(m.shotMap) ? m.shotMap : [];
  const bars = (map.length ? map : Array.from({ length: 25 }, (_, i) => (i % 6 !== 5 ? 1 : 0)))
    .slice(0, 60).map(h => `<i class="${h ? 'hit' : 'miss'}"></i>`).join('');
  root.innerHTML = shell(`
    <a class="back" href="#/">${ic('chevron-left', 14)} Overview</a>
    <div class="detail-head rv">
      <div><div class="t">${esc(s.ground || s.discipline || 'Session')}</div>
        <div class="s">${esc(s.discipline || '')} · ${new Date(s.created_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${s.targets} targets</div></div>
      <div class="score"><div class="v">${s.score || 0}</div><div class="l">Form</div></div>
    </div>
    <div class="rv">
      <div class="overline" style="margin-bottom:.5rem">The session · hit / miss</div>
      <div class="shot-bar" role="img" aria-label="${s.hits} of ${s.targets} targets hit.">${bars}</div>
    </div>
    <div class="kv rv">
      ${cell('Hit rate', (s.hit_rate || 0) + '%')}
      ${cell('Targets hit', `${s.hits}/${s.targets}`)}
      ${cell('Best run', s.best_run || 0)}
      ${cell('Time to break', (m.timeToBreak ? m.timeToBreak + 's' : '—'))}
      ${cell('Mount', (m.mount ? m.mount + '%' : '—'))}
      ${cell('Discipline', esc(s.discipline || '—'))}
    </div>
    <div class="clip-note rv">${ic('film', 18)} ${s.video_path ? 'Your clip is stored privately. Playback with shot markers is coming as the model is wired in.' : 'No clip stored for this session.'}</div>
  `);
  document.getElementById('signOut')?.addEventListener('click', async () => { await supabase.auth.signOut(); });
}
function cell(l, v) { return `<div class="cell"><div class="l">${l}</div><div class="v">${v}</div></div>`; }

/* ---------- utils ---------- */
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function cryptoId() { try { return crypto.randomUUID(); } catch (e) { return 'id-' + Date.now() + '-' + Math.floor(Math.random() * 1e6); } }
