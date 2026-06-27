/* ============================================================================
   BRACE app — SPA (hash router, mock-data backed)
   ========================================================================== */
import { USER, SPECIES, seasonStats, session, loadDays, saveDay, findDay } from './data.js';

const root = document.getElementById('root');
const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const fmt = n => Number(n).toLocaleString('en-GB');
const ic = (id, w = 20) => `<svg width="${w}" height="${w}" aria-hidden="true"><use href="#i-${id}"/></svg>`;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const NAV = [
  { id: 'dashboard', label: 'Season', icon: 'compass', route: '#/' },
  { id: 'book', label: 'Game Book', icon: 'book', route: '#/book' },
  { id: 'add', label: 'Add a day', icon: 'camera', route: '#/add' },
  { id: 'settings', label: 'Settings', icon: 'cog', route: '#/settings' },
];

let sidebarOpen = false;

/* ---------- routing ---------- */
function parseHash() {
  const h = (location.hash || '#/').replace(/^#/, '');
  const parts = h.split('/').filter(Boolean); // ['book','id']
  return { section: parts[0] || '', id: parts[1] || null };
}

function go(route) { location.hash = route; }

window.addEventListener('hashchange', render);
window.addEventListener('DOMContentLoaded', render);

/* ---------- render orchestrator ---------- */
function render() {
  const { section, id } = parseHash();
  const signedIn = !!session.get();

  if (!signedIn && section !== 'enter') { return renderAuth(); }
  if (section === 'enter') { return renderAuth(); }

  const days = loadDays();
  let active = section || 'dashboard';
  let title = 'Your season', subtitle = `${USER.plan} · ${new Date().getFullYear()} season`, body = '';

  if (section === '' || section === 'dashboard') { body = viewDashboard(days); active = 'dashboard'; }
  else if (section === 'book' && id) { const d = findDay(days, id); if (!d) { go('#/book'); return; } title = d.estate; subtitle = d.display; body = viewDay(d); active = 'book'; }
  else if (section === 'book') { title = 'Game Book'; subtitle = `${days.length} days recorded`; body = viewBook(days); active = 'book'; }
  else if (section === 'add') { title = 'Add a day'; subtitle = 'Let Brace read your footage'; body = viewAdd(); active = 'add'; }
  else if (section === 'settings') { title = 'Settings'; subtitle = USER.name; body = viewSettings(); active = 'settings'; }
  else { go('#/'); return; }

  root.innerHTML = shell(active, title, subtitle, body);
  afterRender(section, id, days);
}

/* ---------- shell ---------- */
function shell(active, title, subtitle, body) {
  return `
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="app">
    <aside class="sidebar${sidebarOpen ? ' open' : ''}" id="sidebar">
      <a class="brand" href="#/" aria-label="Brace">
        <svg class="logo" aria-hidden="true"><use href="#i-logo"/></svg>
        <span><span class="wm">BRACE</span><br><span class="tg">Shooting Log</span></span>
      </a>
      <nav aria-label="Primary">
        ${NAV.map(n => `<a class="nav-item${active === n.id ? ' active' : ''}" href="${n.route}">${ic(n.icon)}<span>${n.label}</span></a>`).join('')}
      </nav>
      <div class="spacer"></div>
      <div class="side-user">
        <span class="avatar">${USER.initials}</span>
        <span><span class="nm">${USER.name}</span><br><span class="pl">${USER.plan.toUpperCase()}</span></span>
      </div>
    </aside>
    <div class="scrim" id="scrim"></div>
    <div class="app-main">
      <header class="topbar">
        <div style="display:flex;align-items:center;gap:.5rem">
          <button class="menu-btn" id="menuBtn" aria-label="Open menu">${ic('menu', 22)}</button>
          <div><div class="tt">${title}</div><div class="ts">${subtitle}</div></div>
        </div>
        <a class="btn btn-primary btn-sm" href="#/add">${ic('camera', 16)} Add a day</a>
      </header>
      <main class="view" id="main">${body}</main>
    </div>
  </div>`;
}

/* ---------- Dashboard ---------- */
function viewDashboard(days) {
  const s = seasonStats(days);
  const t = s.tally;
  const order = ['pheasant', 'partridge', 'woodcock', 'pigeon', 'duck'];
  const segs = order.filter(k => t[k]).map(k => `<span class="pip-seg" style="flex:${t[k]};background:var(--c-${SPECIES[k].pip === 'pheasant' ? 'brass' : SPECIES[k].pip === 'partridge' ? 'sage' : 'ivory-48'});opacity:.85"></span>`).join('');
  const legend = order.filter(k => t[k]).map(k => `<span class="it"><i class="pip ${SPECIES[k].pip}"></i>${SPECIES[k].label} <span class="n">${fmt(t[k])}</span></span>`).join('');
  const recent = days.slice(0, 3);
  return `
  <div class="grid" style="gap:1.25rem">
    <div class="stat-grid">
      ${stat('Days in the line', s.days, '', 'compass', `${s.estates} estates this season`)}
      ${stat('Season bag', s.totalBag, 'head', 'feather', 'across every day recorded')}
      ${stat('Your bag', s.yourBag, 'head', 'cartridge', `${s.yourShots} shots · ${s.pct}% to bag`, false)}
      ${stat('Best day', s.best ? s.best.totalBag : 0, 'head', 'drive', s.best ? s.best.estate : '', true)}
    </div>

    <div class="two-col">
      <div class="card card-pad rv">
        <div class="section-label"><span class="a">The game book</span><a href="#/book">View all ${days.length} →</a></div>
        <div class="day-list">${recent.map(dayCard).join('')}</div>
      </div>
      <div class="card card-pad rv" data-stagger style="--i:1">
        <div class="section-label"><span class="a">Bag by species</span></div>
        <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:.25rem">
          <span class="overline">Season total</span>
          <span class="serif" style="font-size:2.4rem;color:var(--c-ivory)" data-count="${s.totalBag}">0</span>
        </div>
        <div class="season-bar">${segs}</div>
        <div class="legend">${legend}</div>
        <div style="margin-top:1.5rem;padding-top:1.1rem;border-top:1px solid var(--c-sage-hairline);display:flex;justify-content:space-between;align-items:center">
          <span class="mono" style="font-size:.65rem;color:var(--c-sage);letter-spacing:.1em">${s.days} DAYS · ${s.estates} ESTATES</span>
          <span class="serif" style="font-style:italic;color:var(--c-ivory-72)">written for you</span>
        </div>
      </div>
    </div>
  </div>`;
}

function stat(lbl, num, unit, icon, sub, accent) {
  return `<div class="card card-pad stat rv${accent ? ' accent-stat' : ''}" data-stagger>
    <div class="ic">${ic(icon, 18)}</div>
    <div class="lbl">${lbl}</div>
    <div class="num"><span data-count="${num}">0</span>${unit ? `<span class="u">${unit}</span>` : ''}</div>
    <div class="sub">${sub || ''}</div>
  </div>`;
}

/* ---------- Game book list ---------- */
function viewBook(days) {
  return `<div class="day-list">${days.map((d, i) => dayCard(d, i)).join('')}</div>`;
}

function dayCard(d, i = 0) {
  const dt = new Date(d.date + 'T00:00:00');
  const pips = pipsFor(d).slice(0, 6).map(p => `<i class="pip ${p}"></i>`).join('');
  return `<a class="day-card rv" data-stagger style="--i:${i}" href="#/book/${d.id}">
    <span class="dc-date"><span class="d">${dt.getDate()}</span><span class="m">${MONTHS[dt.getMonth()]}</span></span>
    <span class="dc-main">
      <span class="e">${accentEstate(d)}</span>
      <span class="c">${d.county}</span>
      <span class="meta"><span>${d.dayType}</span><span>·</span><span>${d.drives.length} drives</span><span class="pips">${pips}</span></span>
    </span>
    <span class="dc-bag"><span class="b">${fmt(d.totalBag)}</span> <span class="l">head</span><span class="y">your bag · ${d.yourBag}</span></span>
  </a>`;
}

function pipsFor(d) {
  const out = [];
  ['pheasant','partridge','woodcock','pigeon','duck'].forEach(k => { if (d.speciesTally[k]) out.push(SPECIES[k].pip); });
  return out;
}
function accentEstate(d) {
  if (!d.estateAccent || !d.estate.includes(d.estateAccent)) return d.estate;
  return d.estate.replace(d.estateAccent, `<em class="accent" style="font-size:inherit">${d.estateAccent}</em>`);
}

/* ---------- Day detail (full game-book entry) ---------- */
function viewDay(d) {
  const drives = d.drives.map(dr => `
    <div class="gb-drive">
      <span class="no">${dr.no}</span>
      <div><div class="name">${dr.name}</div><div class="detail">${dr.time} · ${dr.detail}</div></div>
      <span class="pips">${dr.species.map(s => `<i class="pip ${SPECIES[s] ? SPECIES[s].pip : 'woodcock'}"></i>`).join('')}</span>
      <span class="bag"><span data-count="${dr.bag}">0</span><span class="u">head</span></span>
    </div>`).join('');

  const order = ['pheasant','partridge','woodcock','pigeon','duck'];
  const tallyCells = order.filter(k => d.speciesTally[k]).slice(0, 3).map(k =>
    `<div class="cell"><div class="lbl">${SPECIES[k].label}</div><div class="num" data-count="${d.speciesTally[k]}">0</div></div>`).join('');

  const moments = d.notableMoments.map(m => {
    const x = m.emphasis ? m.text.replace(m.emphasis, `<b>${m.emphasis}</b>`) : m.text;
    return `<div class="gb-moment"><span class="t">${m.time}</span><span class="x">${x}</span></div>`;
  }).join('');

  const wave = Array.from({ length: 64 }, (_, i) => `<i style="height:${20 + Math.round(40 * Math.abs(Math.sin(i * 0.7)) )}%"></i>`).join('');
  const markers = d.notableMoments.map(m => `<span class="marker" style="left:${timeFrac(m.time)}%" title="${m.time}"></span>`).join('');

  return `
  <a href="#/book" class="overline" style="display:inline-flex;align-items:center;gap:.5rem;margin-bottom:1.25rem;color:var(--c-sage)">${ic('chevron-left', 14)} The game book</a>
  <article class="gamebook rv">
    <div class="gb-pad">
      <div class="gb-head">
        <div>
          <p class="ovl">Game Book · ${d.dayType}</p>
          <h2 class="gb-estate">${accentEstate(d)}</h2>
          <p class="gb-county">${d.county}</p>
          <span class="gb-seal"><span class="dot"></span>Verified from footage</span>
        </div>
        <div class="gb-margin">
          <div><span class="b">${d.display}</span></div>
          <div>${d.coords}</div>
          <div>OS · ${d.gridRef}</div>
        </div>
      </div>
      <div class="gb-drives">${drives}</div>
      <div class="gb-tally" role="img" aria-label="${order.filter(k=>d.speciesTally[k]).map(k=>d.speciesTally[k]+' '+SPECIES[k].label).join(', ')}. Total bag ${d.totalBag}.">
        ${tallyCells}
        <div class="cell total"><div class="lbl">Total Bag</div><div class="num" data-count="${d.totalBag}">0</div></div>
      </div>

      <div class="footage">
        <p class="overline" style="margin-bottom:.6rem">Footage · ${d.footageDuration} · ${d.notableMoments.length} moments found</p>
        <div class="bar"><div class="wave">${wave}</div>${markers}</div>
        <div class="scale"><span>00:00</span><span>${d.footageDuration}</span></div>
      </div>

      <div class="gb-lower">
        <div class="gb-block">
          <p class="ovl">The day</p>
          <dl class="gb-kv">
            <dt>Conditions</dt><dd>${d.conditions}</dd>
            <dt>Guns in line</dt><dd>${d.gunsInLine}</dd>
            <dt>Your bag</dt><dd>${d.yourBag} head · ${d.yourShots} shots</dd>
            <dt>Gun</dt><dd>${d.gun.split(' · ')[0]}</dd>
            <dt>Load</dt><dd>${d.load.split(' · ').slice(0,2).join(' · ')}</dd>
          </dl>
        </div>
        <div class="gb-block">
          <p class="ovl">Notable moments · auto-detected</p>
          ${moments}
        </div>
      </div>
    </div>
    <div class="gb-foot">
      <span class="by"><span class="ast">✳</span> ${d.footageSummary}</span>
      <span class="sig">— logged automatically</span>
    </div>
  </article>`;
}

function timeFrac(t) {
  const [h, m] = t.split(':').map(Number);
  const mins = h * 60 + m;
  return Math.max(2, Math.min(98, ((mins - 510) / (900 - 510)) * 100)).toFixed(1);
}

/* ---------- Add a day (upload + processing) ---------- */
function viewAdd() {
  return `
  <div class="card card-pad upload-card rv" id="addCard">
    <div id="addStage">
      <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="Select footage">
        <div class="ic">${ic('camera', 42)}</div>
        <h3>Bring in a day's footage</h3>
        <p>Drop your POV footage here, or choose a file. Brace will read it and write the day into your game book.</p>
        <div style="margin-top:1.25rem"><span class="btn btn-primary">Choose footage</span></div>
        <p style="margin-top:1rem;font-size:.75rem;color:var(--c-ivory-48)">Demo — selecting anything runs a sample day through Brace.</p>
      </div>
    </div>
  </div>`;
}

const PROC_STEPS = [
  'Reading footage…',
  'Finding the drives and their order…',
  'Counting the bag by species…',
  'Marking the moments worth keeping…',
  'Setting the page…',
];

// Templates for a freshly "read" day, chosen deterministically per session.
const NEW_DAYS = [
  { id: 'helmsley', estate: 'Helmsley', estateAccent: 'Helmsley', county: 'Rye Valley · North Yorkshire', coords: '54.2466°N, 1.0608°W', gridRef: 'SE 611 837',
    drives: [
      { no:'01', name:'Carlton Bank', time:'09:05', detail:'fresh W · 9 guns', bag:43, species:['pheasant','pheasant','partridge'] },
      { no:'02', name:'Duncombe', time:'10:40', detail:'high birds · 9 guns', bag:57, species:['pheasant','pheasant','pheasant'] },
      { no:'03', name:'Ash Dale', time:'12:20', detail:'last · 9 guns', bag:46, species:['pheasant','partridge','woodcock'] },
    ], speciesTally:{ pheasant:118, partridge:24, woodcock:4 }, totalBag:146, conditions:'5°C · W 13mph · bright spells',
    gunsInLine:9, yourBag:20, yourShots:29, notableMoments:[
      { time:'10:58', text:'Right-and-left over Duncombe — a fine pair.', emphasis:'Right-and-left' },
      { time:'12:34', text:'Woodcock flushed late on Ash Dale.', emphasis:'Woodcock' },
    ], footageDuration:'5h 47m' },
  { id: 'studley', estate: 'Studley Royal', estateAccent: 'Royal', county: 'Skell Valley · North Yorkshire', coords: '54.1339°N, 1.5783°W', gridRef: 'SE 278 702',
    drives: [
      { no:'01', name:'Lake Drive', time:'09:00', detail:'still · 8 guns', bag:39, species:['pheasant','partridge','partridge'] },
      { no:'02', name:'Obelisk', time:'10:35', detail:'testing · 8 guns', bag:55, species:['pheasant','pheasant','pheasant'] },
      { no:'03', name:'Seven Bridges', time:'12:10', detail:'steady · 8 guns', bag:48, species:['pheasant','partridge','pigeon'] },
    ], speciesTally:{ pheasant:112, partridge:26, pigeon:4 }, totalBag:142, conditions:'7°C · SW 9mph · soft, grey',
    gunsInLine:8, yourBag:22, yourShots:30, notableMoments:[
      { time:'10:51', text:'Towering cock pheasant over the Obelisk.', emphasis:'Towering' },
    ], footageDuration:'5h 22m' },
];

function makeNewDay() {
  const seen = loadDays().map(d => d.id);
  const tmpl = NEW_DAYS.find(t => !seen.includes(dayIdFor(t))) || NEW_DAYS[0];
  const today = new Date();
  const display = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][today.getDay()]} ${today.getDate()} ${MONTHS[today.getMonth()]} ${today.getFullYear()}`;
  return {
    ...tmpl, id: dayIdFor(tmpl), date: today.toISOString().slice(0, 10), display, day: '', dayType: 'Driven day',
    status: 'written', gun: USER.gun, load: USER.cartridge,
    footageSummary: `Written by Brace from ${tmpl.footageDuration} of footage`,
  };
}
function dayIdFor(t) { return `${t.id}-new`; }

/* ---------- Settings ---------- */
function viewSettings() {
  const priv = [
    { k: 'Private by default', d: 'Your game book is visible only to you.', on: true },
    { k: 'Footage used only to write your day', d: 'Your footage is read to build your record, and nothing else.', on: true },
    { k: 'Allow sharing a day by link', d: 'Off until you choose to hand a day to a fellow gun.', on: false },
  ];
  return `
  <div class="grid" style="gap:1.25rem;max-width:760px">
    <div class="card card-pad rv">
      <div class="section-label"><span class="a">Your details</span></div>
      <div class="set-row"><div><div class="k">Name</div></div><div class="v">${USER.name}</div></div>
      <div class="set-row"><div><div class="k">Email</div></div><div class="v">${USER.email}</div></div>
      <div class="set-row"><div><div class="k">Membership</div></div><div class="v">${USER.plan} · since ${USER.since}</div></div>
    </div>
    <div class="card card-pad rv" data-stagger style="--i:1">
      <div class="section-label"><span class="a">Your kit</span></div>
      <div class="set-row"><div><div class="k">Gun</div></div><div class="v">${USER.gun}</div></div>
      <div class="set-row"><div><div class="k">Cartridge</div></div><div class="v">${USER.cartridge}</div></div>
      <div class="set-row"><div><div class="k">Cameras</div><div class="d">The POV cameras Brace reads</div></div><div class="v">${USER.cameras.join('<br>')}</div></div>
    </div>
    <div class="card card-pad rv" data-stagger style="--i:2">
      <div class="section-label"><span class="a">Privacy</span></div>
      ${priv.map((p, i) => `<div class="set-row"><div><div class="k">${p.k}</div><div class="d">${p.d}</div></div>
        <button class="toggle" data-toggle aria-pressed="${p.on}" aria-label="${p.k}"></button></div>`).join('')}
    </div>
    <div>
      <button class="btn btn-ghost" id="signOut">${ic('signout', 16)} Sign out</button>
    </div>
  </div>`;
}

/* ---------- Auth ---------- */
let authMode = 'signin';
function renderAuth() {
  const isSignup = authMode === 'signup';
  root.innerHTML = `
  <div class="auth">
    <div class="bp"></div><div class="glow"></div>
    <div class="auth-card">
      <div class="brand">
        <svg class="logo" aria-hidden="true"><use href="#i-logo"/></svg>
        <span class="wm">BRACE</span>
        <span class="tg">The Modern Shooting Log</span>
      </div>
      <div class="auth-panel">
        <h1>${isSignup ? 'Create your account' : 'Welcome back'}</h1>
        <p class="sub">${isSignup ? 'Take your founding place. Creating an account costs nothing.' : 'Sign in to your private game book.'}</p>
        <form id="authForm" novalidate>
          ${isSignup ? `<div class="field"><label for="name">Name</label><input id="name" type="text" placeholder="James Alderton" autocomplete="name"></div>` : ''}
          <div class="field"><label for="email">Email address</label><input id="email" type="email" placeholder="you@estate.co.uk" autocomplete="email" required></div>
          <div class="field"><label for="pw">Password</label><input id="pw" type="password" placeholder="••••••••" autocomplete="${isSignup ? 'new-password' : 'current-password'}"></div>
          <button class="btn btn-primary btn-block" type="submit" style="margin-top:.5rem">${isSignup ? 'Create free account' : 'Sign in'} ${ic('arrow', 16)}</button>
        </form>
        <p style="text-align:center;margin-top:1rem;font-size:.72rem;color:var(--c-ivory-48)">Demo — any email signs you into a sample game book.</p>
        <div class="auth-switch">${isSignup ? 'Already with us?' : 'No account yet?'}
          <button id="authSwitch" type="button">${isSignup ? 'Sign in' : 'Create one'}</button>
        </div>
      </div>
    </div>
  </div>`;
  const form = document.getElementById('authForm');
  form.addEventListener('submit', e => {
    e.preventDefault();
    const email = document.getElementById('email');
    if (!email.value || !/.+@.+\..+/.test(email.value)) { email.focus(); email.style.borderColor = 'var(--c-brass-deep)'; return; }
    session.signIn(email.value);
    go('#/');
    render();
  });
  document.getElementById('authSwitch').addEventListener('click', () => { authMode = isSignup ? 'signin' : 'signup'; renderAuth(); });
}

/* ---------- After-render wiring ---------- */
function afterRender(section, id, days) {
  // mobile sidebar
  const menuBtn = document.getElementById('menuBtn');
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  function setSidebar(open) { sidebarOpen = open; sidebar.classList.toggle('open', open); scrim.classList.toggle('show', open); }
  if (menuBtn) menuBtn.addEventListener('click', () => setSidebar(true));
  if (scrim) scrim.addEventListener('click', () => setSidebar(false));
  sidebar && sidebar.querySelectorAll('.nav-item, .brand').forEach(a => a.addEventListener('click', () => setSidebar(false)));

  // reveals
  const rv = Array.prototype.slice.call(document.querySelectorAll('.rv'));
  if (reduce || !('IntersectionObserver' in window)) rv.forEach(e => e.classList.add('in'));
  else {
    const io = new IntersectionObserver((es, o) => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); o.unobserve(en.target); } }), { threshold: 0.1 });
    rv.forEach(e => io.observe(e));
  }

  // count-ups
  document.querySelectorAll('[data-count]').forEach(el => {
    const target = parseInt(el.getAttribute('data-count'), 10) || 0;
    if (reduce) { el.textContent = fmt(target); return; }
    let start = null;
    const dur = 850;
    function step(ts) { if (start === null) start = ts; const p = Math.min((ts - start) / dur, 1); const e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(Math.round(target * e)); if (p < 1) requestAnimationFrame(step); else el.textContent = fmt(target); }
    requestAnimationFrame(step);
  });

  // settings
  document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')));
  const so = document.getElementById('signOut');
  if (so) so.addEventListener('click', () => { session.signOut(); authMode = 'signin'; go('#/'); render(); });

  // add-a-day flow
  const dz = document.getElementById('dropzone');
  if (dz) {
    const trigger = () => runProcessing();
    dz.addEventListener('click', trigger);
    dz.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); } });
    ['dragover','dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('drag'); }));
    ['dragleave','drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('drag'); if (ev === 'drop') trigger(); }));
  }
}

function runProcessing() {
  const stage = document.getElementById('addStage');
  if (!stage) return;
  stage.innerHTML = `
    <div class="proc" role="status" aria-live="polite">
      <div class="ring">${ic('loader', 64)}</div>
      <h3>Brace is reading your day</h3>
      <p class="step-line" id="stepLine">${PROC_STEPS[0]}</p>
      <div class="proc-bar"><i id="procBar"></i></div>
    </div>`;
  const line = document.getElementById('stepLine');
  const bar = document.getElementById('procBar');
  const total = PROC_STEPS.length;
  let i = 0;
  const tick = () => {
    i++;
    if (bar) bar.style.width = Math.round((i / total) * 100) + '%';
    if (i < total) { if (line) line.textContent = PROC_STEPS[i]; setTimeout(tick, reduce ? 120 : 760); }
    else {
      const day = makeNewDay();
      saveDay(day);
      setTimeout(() => { go('#/book/' + day.id); render(); }, reduce ? 60 : 500);
    }
  };
  setTimeout(tick, reduce ? 120 : 760);
}
