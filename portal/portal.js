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

/* ---------- gate shell ---------- */

function gate(inner, tag = 'Owners portal', mod = '') {
  root.innerHTML = `
    <div class="gate">
      <div class="gate-card ${mod}">
        <img class="gate-mark" src="../assets/brand/brace-a-mark-white.svg" alt="Brace" width="740" height="732" />
        <div class="gate-tag">${esc(tag)}</div>
        ${inner}
      </div>
    </div>`;
}
const setErr = (m) => { const e = document.getElementById('err'); if (e) e.textContent = m || ''; };
const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.textContent = label; };

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

function renderSetPassword(err = '') {
  gate(`
    <h1>Choose a password</h1>
    <p class="gate-lede">This is the first of your two factors. Make it long and unique to Brace.</p>
    <form id="f">
      <div class="field"><input type="password" id="pw1" placeholder="New password" autocomplete="new-password" required /></div>
      <div class="field"><input type="password" id="pw2" placeholder="Repeat it" autocomplete="new-password" required /></div>
      <div class="err" id="err">${esc(err)}</div>
      <button class="btn" type="submit">Save password</button>
    </form>
    <div class="gate-foot"><a href="#" id="out">Sign out</a></div>`);

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
  document.getElementById('out').addEventListener('click', async (e) => { e.preventDefault(); sessionStorage.removeItem('brace-portal-pw'); await supabase.auth.signOut(); boot(); });
}

/* ---------- 3 · enrol an authenticator ---------- */

let enrolling = false;

async function renderEnrol(err = '') {
  if (enrolling) return;          // never enrol twice for one visit
  enrolling = true;
  gate(`<h1>Add your authenticator</h1><p class="gate-lede">Preparing…</p>`);

  // Clear any half-finished factors first. Every enroll() mints a fresh
  // secret, so a stale one left lying about means the QR on screen and the
  // factor being verified can disagree — codes then never match.
  const { data: list } = await supabase.auth.mfa.listFactors();
  for (const f of (list?.all || list?.totp || [])) {
    if (f.status !== 'verified') {
      try { await supabase.auth.mfa.unenroll({ factorId: f.id }); } catch { /* already gone */ }
    }
  }

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp', friendlyName: 'Brace portal',
  });
  enrolling = false;
  if (error) {
    gate(`<h1>Add your authenticator</h1><div class="err">${esc(error.message)}</div>
          <button class="btn btn-ghost" id="out">Sign out</button>`);
    document.getElementById('out').addEventListener('click', async () => { sessionStorage.removeItem('brace-portal-pw'); await supabase.auth.signOut(); boot(); });
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
    const ch = await supabase.auth.mfa.challenge({ factorId });
    if (ch.error) { busy(btn, false, 'Verify and finish'); return setErr(ch.error.message); }
    const v = await supabase.auth.mfa.verify({
      factorId, challengeId: ch.data.id, code: document.getElementById('code').value.trim(),
    });
    if (v.error) { busy(btn, false, 'Verify and finish'); return setErr(v.error.message); }
    boot();
  });
  document.getElementById('out').addEventListener('click', async (e) => { e.preventDefault(); sessionStorage.removeItem('brace-portal-pw'); await supabase.auth.signOut(); boot(); });
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
    const ch = await supabase.auth.mfa.challenge({ factorId });
    if (ch.error) { busy(btn, false, 'Unlock'); return setErr(ch.error.message); }
    const v = await supabase.auth.mfa.verify({
      factorId, challengeId: ch.data.id, code: document.getElementById('code').value.trim(),
    });
    if (v.error) { busy(btn, false, 'Unlock'); return setErr(v.error.message); }
    boot();
  });
  document.getElementById('out').addEventListener('click', async (e) => { e.preventDefault(); sessionStorage.removeItem('brace-portal-pw'); await supabase.auth.signOut(); boot(); });
}

function renderDenied(email) {
  gate(`
    <h1>Not on the owners list</h1>
    <p class="gate-lede">${esc(email)} can't reach the portal. If it should,
       add it to <code>portal_owners</code> in Supabase.</p>
    <a class="btn" href="../">Back to Brace</a>
    <button class="btn btn-ghost" id="out" style="margin-top:10px">Sign out</button>`);
  document.getElementById('out').addEventListener('click', async () => { sessionStorage.removeItem('brace-portal-pw'); await supabase.auth.signOut(); boot(); });
}

/* ---------- dashboard data ---------- */

async function count(table, filter) {
  let q = supabase.from(table).select('*', { count: 'exact', head: true });
  if (filter) q = filter(q);
  const { count: n, error } = await q;
  return error ? null : n;
}

async function loadData() {
  const [members, sessions, clips, founders, analyses, subsActive, recentAnalyses, foundersRecent, clipRows] =
    await Promise.all([
      count('profiles'),
      count('sessions'),
      count('clips'),
      count('founding_members'),
      count('analysis_results'),
      count('subscriptions', (q) => q.eq('status', 'active')),
      supabase.from('analysis_results')
        .select('shots_fired,hits,accuracy,created_at,clip_id')
        .order('created_at', { ascending: false }).limit(7),
      supabase.from('founding_members')
        .select('email,source,created_at')
        .order('created_at', { ascending: false }).limit(10),
      supabase.from('clips').select('status'),
    ]);
  const clipStatus = {};
  for (const r of clipRows.data || []) clipStatus[r.status || 'unknown'] = (clipStatus[r.status || 'unknown'] || 0) + 1;
  return {
    members, sessions, clips, founders, analyses, subsActive,
    recentAnalyses: recentAnalyses.data || [],
    foundersRecent: foundersRecent.data || [],
    clipStatus,
  };
}

/* ---------- dashboard render ---------- */

const BAYS = [
  { name: 'Field agent', live: true, desc: 'Reads a day’s POV footage into shots, hits and metrics — the pipeline behind every game-book entry. Live below.' },
  { name: 'Game-book writer', live: false, desc: 'Turns a processed day into the finished ledger entry — drives, the bag, conditions, the line.' },
  { name: 'Highlights cutter', live: false, desc: 'Pulls the best moments of the day into a shareable reel, cut to the second of each shot.' },
  { name: 'Coaching agent', live: false, desc: 'Watches technique across a season and drafts what to work on before the next day in the line.' },
];

function renderDashboard(email, d) {
  const ledger = [
    { n: d.members, c: 'Members' },
    { n: d.sessions, c: 'Days recorded' },
    { n: d.clips, c: 'Clips in' },
    { n: d.analyses, c: 'Days analysed' },
    { n: d.subsActive, c: 'Active subs' },
    { n: d.founders, c: 'Founding list' },
  ];
  root.innerHTML = `
    <header class="topbar">
      <a class="brand" href="../"><img src="../assets/brand/brace-wordmark-white.svg" alt="Brace" width="3579" height="732" /></a>
      <span class="scope">Owners portal</span>
      <span class="who"><span>${esc(email)}</span>
        <button class="signout" id="signout">${ic('signout', 14)} Sign out</button></span>
    </header>
    <main>
      <div class="page-head">
        <div class="over">The estate office</div>
        <h1>The book that <em>writes itself</em>, and the desk that runs it.</h1>
        <p>Live figures from the Brace ledger, the footage pipeline as it runs, and the
           agents that keep the season's record. Owners only.</p>
      </div>

      <div class="ledger">
        ${ledger.map((x) => `<div class="cell"><div class="num">${x.n == null ? '—' : fmt(x.n)}</div><div class="cap">${x.c}</div></div>`).join('')}
      </div>

      <div class="grid">
        <div class="col">
          <section class="panel">
            <div class="p-head"><span class="p-title">Field agent · footage pipeline</span><a class="p-act" href="#" id="refresh">Refresh</a></div>
            <div class="chips">
              ${Object.entries(d.clipStatus).map(([s, n]) => `<span class="chip">${esc(s)} <b>${fmt(n)}</b></span>`).join('') || '<span class="empty">No clips yet.</span>'}
            </div>
            ${d.recentAnalyses.map((a) => `
              <div class="row">
                <span class="dot on"></span>
                <div class="main">
                  <div class="t">${fmt(a.shots_fired)} shots · ${fmt(a.hits)} hits</div>
                  <div class="s">${dateFmt(a.created_at)}</div>
                </div>
                <div class="end"><div class="t">${a.accuracy == null ? '—' : Math.round(a.accuracy) + '%'}</div></div>
              </div>`).join('') || '<div class="empty">No analysed days yet.</div>'}
          </section>

          <section class="panel">
            <div class="p-head"><span class="p-title">Agents · docking bays</span></div>
            ${BAYS.map((b) => `
              <div class="row bay">
                <span class="dot ${b.live ? 'on' : 'off'}"></span>
                <div class="main" style="white-space:normal;">
                  <div class="name">${b.name}</div>
                  <div class="desc" style="padding-left:0;">${b.desc}</div>
                </div>
              </div>`).join('')}
          </section>
        </div>

        <section class="panel">
          <div class="p-head"><span class="p-title">Founding members · latest</span></div>
          ${d.foundersRecent.map((f) => `
            <div class="row">
              <span class="dot brass"></span>
              <div class="main"><div class="t">${esc(f.email)}</div><div class="s">${esc(f.source)} · ${dateFmt(f.created_at)}</div></div>
            </div>`).join('') || '<div class="empty">No sign-ups captured yet — the landing form writes here.</div>'}
        </section>
      </div>
    </main>`;
  document.getElementById('signout').addEventListener('click', () => supabase.auth.signOut());
  document.getElementById('refresh')?.addEventListener('click', (e) => { e.preventDefault(); boot(); });
}

/* ---------- boot ---------- */
// One place decides what the visitor sees, and it always asks the database
// last. Order: signed in? → on the owners list? → password set? → factor
// enrolled? → factor verified this session? → the floor.

let booting = false;

async function boot() {
  // getSession + onAuthStateChange both fire on load; without this guard the
  // enrolment screen renders twice and mints two competing secrets.
  if (booting) return;
  booting = true;
  try { await route(); } finally { booting = false; }
}

async function route() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return renderSignIn();

  const email = session.user?.email || '';

  // Is this email an owner at all? (email-only check, so we can route properly)
  const { data: isOwnerEmail } = await supabase.rpc('is_portal_owner_email');
  if (!isOwnerEmail) return renderDenied(email);

  // Only the link route lands here without a password having been typed, and
  // the one reason to use the link is 'first time, or forgotten it'. A session
  // that came through the password form skips straight to the second factor.
  // Routing only — the database is what actually grants access.
  if (sessionStorage.getItem('brace-portal-pw') !== '1') {
    return renderSetPassword();
  }

  const { data: factors, error: fErr } = await supabase.auth.mfa.listFactors();
  if (fErr) return renderSignIn(fErr.message);
  const verified = (factors?.totp || []).filter((f) => f.status === 'verified');
  if (!verified.length) return renderEnrol();

  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel !== 'aal2') return renderChallenge(verified[0].id);

  // Two factors done. The database makes the final call.
  const { data: isOwner, error } = await supabase.rpc('is_portal_owner');
  if (error || !isOwner) return renderDenied(email);

  renderDashboard(email, await loadData());
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'MFA_CHALLENGE_VERIFIED') boot();
});
boot();
