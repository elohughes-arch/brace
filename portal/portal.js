/* ============================================================================
   BRACE owners portal — the estate office.
   Real Supabase auth; access is decided server-side by is_portal_owner()
   (RLS + a security-definer check against portal_owners). Nothing here is
   the gate — a non-owner session simply reads zero rows and is turned away.
   ========================================================================== */
import { supabase } from '../app/supabase.js';

const root = document.getElementById('root');
const ic = (id, w = 18) => `<svg width="${w}" height="${w}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n ?? 0).toLocaleString('en-GB');
const dateFmt = (iso) => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';

/* ---------- gate screens ---------- */

function renderSignIn(err = '') {
  root.innerHTML = `
    <div class="gate">
      <form class="gate-card" id="signin">
        <div class="gate-brand">${ic('logo', 22)}<span class="word">BRACE</span></div>
        <div class="gate-tag">Owners portal · The estate office</div>
        <h1>Sign the visitors' book</h1>
        <div class="field"><input type="email" id="email" placeholder="Email" autocomplete="email" required /></div>
        <div class="field"><input type="password" id="password" placeholder="Password" autocomplete="current-password" required /></div>
        <div class="err" id="err">${esc(err)}</div>
        <button class="btn" type="submit">${ic('lock', 15)} Enter</button>
        <div class="gate-foot">Owners only. Looking for your game book? <a href="../app/">Open the app</a> · <a href="../">Back to the site</a></div>
      </form>
    </div>`;
  document.getElementById('signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('.btn');
    btn.disabled = true;
    const { error } = await supabase.auth.signInWithPassword({
      email: document.getElementById('email').value.trim(),
      password: document.getElementById('password').value,
    });
    if (error) { btn.disabled = false; document.getElementById('err').textContent = error.message; }
    // success re-renders via onAuthStateChange
  });
}

function renderDenied(email) {
  root.innerHTML = `
    <div class="gate">
      <div class="gate-card">
        <div class="gate-brand">${ic('logo', 22)}<span class="word">BRACE</span></div>
        <div class="gate-tag">Owners portal · The estate office</div>
        <h1>Not in the book</h1>
        <p style="font-size:0.9rem;color:var(--c-ivory-60);line-height:1.6;margin-bottom:18px;">
          ${esc(email)} isn't on the owners list. If it should be, add it to
          <span style="font-family:var(--f-mono);font-size:0.8rem;">portal_owners</span> in Supabase.
        </p>
        <button class="btn btn-ghost" id="signout">${ic('signout', 15)} Sign out</button>
      </div>
    </div>`;
  document.getElementById('signout').addEventListener('click', () => supabase.auth.signOut());
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
      <a class="brand" href="../">${ic('logo', 20)}<span class="word">BRACE</span></a>
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

async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { renderSignIn(); return; }
  const email = session.user?.email || '';

  // Server-side owner check — the database decides, not the client.
  const { data: isOwner, error } = await supabase.rpc('is_portal_owner');
  if (error || !isOwner) { renderDenied(email); return; }

  const d = await loadData();
  renderDashboard(email, d);
}

supabase.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_IN' || event === 'SIGNED_OUT') boot();
});
boot();
