/* ============================================================================
   BRACE app — mock data layer
   Stands in for the backend until a real API/Supabase is wired. Shapes mirror
   what a real game-book record would hold so the UI is honest about the product.
   Persists lightweight state (auth, new entries) to localStorage.
   ========================================================================== */

export const USER = {
  name: 'James Alderton',
  initials: 'JA',
  plan: 'Founding member',
  since: '2026',
  gun: 'Beretta 687 Silver Pigeon · 12-bore O/U',
  cartridge: 'Hull High Pheasant 30g · No.5 · fibre wad',
  cameras: ['Insta360 GO 3 (cap mount)', 'GoPro Hero 12 (stock mount)'],
  email: 'james@aldertonfarms.co.uk',
};

// Species colour key, shared with the landing-page card.
export const SPECIES = {
  pheasant: { label: 'Pheasant', pip: 'pheasant' },
  partridge: { label: 'Partridge', pip: 'partridge' },
  woodcock: { label: 'Woodcock', pip: 'woodcock' },
  duck: { label: 'Duck', pip: 'woodcock' },
  pigeon: { label: 'Pigeon', pip: 'partridge' },
};

// ── The game book: a season of days, newest first ──────────────────────────
export const DAYS = [
  {
    id: 'bolton-abbey-2026-11-14',
    date: '2026-11-14', display: 'Sat 14 November 2026', day: 'Saturday',
    estate: 'Bolton Abbey', estateAccent: 'Abbey',
    county: 'Wharfedale · North Yorkshire',
    coords: '54.0156°N, 1.8889°W', gridRef: 'SE 074 542',
    dayType: 'Driven day', status: 'written',
    drives: [
      { no: '01', name: 'The Hag', time: '08:52', detail: 'NW wind · 11 guns', bag: 38, species: ['pheasant', 'pheasant', 'partridge'] },
      { no: '02', name: 'Strid Wood', time: '10:05', detail: 'high birds · 11 guns', bag: 61, species: ['pheasant', 'pheasant', 'pheasant'] },
      { no: '03', name: 'Pickles Beck', time: '11:40', detail: 'steady · 11 guns', bag: 44, species: ['pheasant', 'partridge', 'woodcock'] },
      { no: '04', name: 'Barden Tower', time: '14:10', detail: 'last drive · 11 guns', bag: 53, species: ['pheasant', 'pheasant', 'partridge'] },
    ],
    speciesTally: { pheasant: 163, partridge: 28, woodcock: 5 },
    totalBag: 196, conditions: '4°C · NW 12mph · low cloud, dry underfoot',
    gunsInLine: 11, yourBag: 22, yourShots: 31,
    gun: 'Beretta 687 Silver Pigeon · 12-bore O/U',
    load: 'Hull High Pheasant 30g · No.5 · fibre wad',
    notableMoments: [
      { time: '10:14', text: 'Right-and-left on curling birds, Strid Wood.', emphasis: 'Right-and-left' },
      { time: '11:58', text: 'Woodcock taken in front — first of the season.', emphasis: 'first of the season' },
      { time: '14:22', text: 'Tall cock pheasant, peg 7, last drive.', emphasis: 'peg 7' },
    ],
    footageDuration: '6h 12m', footageSummary: 'Written by Brace from 6h 12m of footage',
  },
  {
    id: 'swinton-2026-11-07',
    date: '2026-11-07', display: 'Sat 7 November 2026', day: 'Saturday',
    estate: 'Swinton Park', estateAccent: 'Park',
    county: 'Wensleydale · North Yorkshire',
    coords: '54.2061°N, 1.6783°W', gridRef: 'SE 213 794',
    dayType: 'Driven day', status: 'written',
    drives: [
      { no: '01', name: 'Druid’s Plantation', time: '09:10', detail: 'fresh SW · 8 guns', bag: 41, species: ['pheasant', 'pheasant', 'partridge'] },
      { no: '02', name: 'High Knowle', time: '10:30', detail: 'testing birds · 8 guns', bag: 52, species: ['pheasant', 'pheasant', 'pheasant'] },
      { no: '03', name: 'The Terrace', time: '12:05', detail: 'steady · 8 guns', bag: 39, species: ['pheasant', 'partridge', 'partridge'] },
    ],
    speciesTally: { pheasant: 109, partridge: 23, woodcock: 0 },
    totalBag: 132, conditions: '6°C · SW 15mph · bright, blustery',
    gunsInLine: 8, yourBag: 19, yourShots: 28,
    gun: 'Beretta 687 Silver Pigeon · 12-bore O/U',
    load: 'Hull High Pheasant 30g · No.5 · fibre wad',
    notableMoments: [
      { time: '10:47', text: 'Long crosser folded over the trees, High Knowle.', emphasis: 'Long crosser' },
      { time: '12:20', text: 'Three birds in quick succession on The Terrace.', emphasis: 'Three birds' },
    ],
    footageDuration: '5h 38m', footageSummary: 'Written by Brace from 5h 38m of footage',
  },
  {
    id: 'wemmergill-2026-10-25',
    date: '2026-10-25', display: 'Sat 25 October 2026', day: 'Saturday',
    estate: 'Wemmergill', estateAccent: 'Wemmergill',
    county: 'Lunedale · County Durham',
    coords: '54.6111°N, 2.1483°W', gridRef: 'NY 920 213',
    dayType: 'Walked-up day', status: 'written',
    drives: [
      { no: '01', name: 'Hagworm Hill', time: '09:30', detail: 'walked-up · 6 guns', bag: 11, species: ['pheasant', 'partridge', 'woodcock'] },
      { no: '02', name: 'Grain Beck', time: '11:15', detail: 'rough shooting · 6 guns', bag: 14, species: ['pheasant', 'duck', 'woodcock'] },
    ],
    speciesTally: { pheasant: 14, partridge: 4, woodcock: 4, duck: 3 },
    totalBag: 25, conditions: '3°C · N 9mph · clear, hard ground',
    gunsInLine: 6, yourBag: 6, yourShots: 14,
    gun: 'Beretta 687 Silver Pigeon · 12-bore O/U',
    load: 'Hull Sovereign 28g · No.6 · fibre wad',
    notableMoments: [
      { time: '11:48', text: 'Snipe off the beck, taken cleanly.', emphasis: 'Snipe' },
    ],
    footageDuration: '4h 02m', footageSummary: 'Written by Brace from 4h 02m of footage',
  },
  {
    id: 'raby-2026-10-18',
    date: '2026-10-18', display: 'Sat 18 October 2026', day: 'Saturday',
    estate: 'Raby Castle', estateAccent: 'Castle',
    county: 'Teesdale · County Durham',
    coords: '54.5908°N, 1.8033°W', gridRef: 'NZ 129 218',
    dayType: 'Driven day', status: 'written',
    drives: [
      { no: '01', name: 'Deer Park', time: '09:00', detail: 'partridge · 9 guns', bag: 47, species: ['partridge', 'partridge', 'pheasant'] },
      { no: '02', name: 'Keepers’ Wood', time: '10:40', detail: 'mixed · 9 guns', bag: 58, species: ['pheasant', 'pheasant', 'partridge'] },
      { no: '03', name: 'Bath Wood', time: '12:15', detail: 'high pheasant · 9 guns', bag: 51, species: ['pheasant', 'pheasant', 'pheasant'] },
      { no: '04', name: 'Low Carrs', time: '14:00', detail: 'last drive · 9 guns', bag: 39, species: ['pheasant', 'partridge', 'pigeon'] },
    ],
    speciesTally: { pheasant: 118, partridge: 71, pigeon: 6 },
    totalBag: 195, conditions: '8°C · SW 7mph · still, overcast',
    gunsInLine: 9, yourBag: 24, yourShots: 33,
    gun: 'Beretta 687 Silver Pigeon · 12-bore O/U',
    load: 'Hull High Pheasant 30g · No.5 · fibre wad',
    notableMoments: [
      { time: '09:22', text: 'Covey split high over the Deer Park — two down.', emphasis: 'two down' },
      { time: '12:41', text: 'Archangel cock pheasant over Bath Wood.', emphasis: 'Archangel' },
    ],
    footageDuration: '6h 28m', footageSummary: 'Written by Brace from 6h 28m of footage',
  },
  {
    id: 'castle-howard-2026-10-04',
    date: '2026-10-04', display: 'Sat 4 October 2026', day: 'Saturday',
    estate: 'Castle Howard', estateAccent: 'Howard',
    county: 'Howardian Hills · North Yorkshire',
    coords: '54.1206°N, 0.9094°W', gridRef: 'SE 716 701',
    dayType: 'Partridge day', status: 'written',
    drives: [
      { no: '01', name: 'Pyramid Belt', time: '09:15', detail: 'partridge · 8 guns', bag: 54, species: ['partridge', 'partridge', 'partridge'] },
      { no: '02', name: 'Temple Hole', time: '10:50', detail: 'driven · 8 guns', bag: 62, species: ['partridge', 'partridge', 'pheasant'] },
      { no: '03', name: 'New River', time: '12:30', detail: 'last · 8 guns', bag: 41, species: ['partridge', 'pheasant', 'pigeon'] },
    ],
    speciesTally: { partridge: 121, pheasant: 31, pigeon: 5 },
    totalBag: 157, conditions: '12°C · W 11mph · warm, fast birds',
    gunsInLine: 8, yourBag: 21, yourShots: 30,
    gun: 'Beretta 687 Silver Pigeon · 12-bore O/U',
    load: 'Hull Sovereign 28g · No.6 · fibre wad',
    notableMoments: [
      { time: '11:05', text: 'Fast covey over Temple Hole — a right-and-left of partridge.', emphasis: 'right-and-left' },
    ],
    footageDuration: '5h 11m', footageSummary: 'Written by Brace from 5h 11m of footage',
  },
];

// ── Derived season figures ─────────────────────────────────────────────────
export function seasonStats(days) {
  const written = days.filter(d => d.status === 'written');
  const totalBag = written.reduce((s, d) => s + d.totalBag, 0);
  const yourBag = written.reduce((s, d) => s + (d.yourBag || 0), 0);
  const yourShots = written.reduce((s, d) => s + (d.yourShots || 0), 0);
  const estates = new Set(written.map(d => d.estate));
  const tally = {};
  written.forEach(d => {
    Object.entries(d.speciesTally).forEach(([k, v]) => { tally[k] = (tally[k] || 0) + v; });
  });
  const best = written.reduce((a, b) => (b.totalBag > (a ? a.totalBag : 0) ? b : a), null);
  return {
    days: written.length,
    estates: estates.size,
    totalBag, yourBag, yourShots,
    tally,
    best,
    pct: yourShots ? Math.round((yourBag / yourShots) * 100) : 0,
  };
}

// ── localStorage-backed session + any days added via the upload flow ───────
const LS_AUTH = 'brace_app_auth';
const LS_DAYS = 'brace_app_days';

export const session = {
  get() { try { return JSON.parse(localStorage.getItem(LS_AUTH) || 'null'); } catch (e) { return null; } },
  signIn(email) { const s = { email: email || USER.email, at: Date.now() }; try { localStorage.setItem(LS_AUTH, JSON.stringify(s)); } catch (e) {} return s; },
  signOut() { try { localStorage.removeItem(LS_AUTH); } catch (e) {} },
};

export function loadDays() {
  let extra = [];
  try { extra = JSON.parse(localStorage.getItem(LS_DAYS) || '[]'); } catch (e) { extra = []; }
  return [...extra, ...DAYS];
}
export function saveDay(day) {
  let extra = [];
  try { extra = JSON.parse(localStorage.getItem(LS_DAYS) || '[]'); } catch (e) { extra = []; }
  extra = [day, ...extra.filter(d => d.id !== day.id)];
  try { localStorage.setItem(LS_DAYS, JSON.stringify(extra)); } catch (e) {}
}
export function findDay(days, id) { return days.find(d => d.id === id) || null; }
