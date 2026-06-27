// ── Brace design system (WHOOP-style: dark, rings, tracked labels) ──────────
export const colors = {
  bg: '#0B0E12',
  bgElevated: '#10141A',
  card: '#161A20',
  cardAlt: '#1C2128',
  border: '#262B31',
  borderStrong: '#333A42',

  text: '#F2F4F7',
  textMuted: '#8A93A0',
  textDim: '#5A626D',

  primary: '#16E0A0',   // teal-green — good / hit
  onPrimary: '#03130D',
  blue: '#3DA5FF',
  orange: '#FF6E2C',
  amber: '#FFC24B',
  red: '#FF4D4D',

  ringTrack: '#222831',
  overlay: 'rgba(0,0,0,0.6)',
};

// Metric colour key used across rings/cards
export const metricColors = {
  accuracy: colors.primary,
  hits: colors.blue,
  shots: colors.orange,
};

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32, huge: 48 };
export const radius = { sm: 8, md: 14, lg: 20, xl: 28, pill: 999 };

export const type = {
  display: { fontSize: 44, fontWeight: '800' as const, color: colors.text, letterSpacing: -1 },
  h1: { fontSize: 28, fontWeight: '800' as const, color: colors.text, letterSpacing: -0.4 },
  h2: { fontSize: 22, fontWeight: '700' as const, color: colors.text, letterSpacing: -0.2 },
  h3: { fontSize: 18, fontWeight: '700' as const, color: colors.text },
  body: { fontSize: 15, fontWeight: '400' as const, color: colors.text },
  bodyMuted: { fontSize: 15, fontWeight: '400' as const, color: colors.textMuted },
  small: { fontSize: 13, fontWeight: '400' as const, color: colors.textMuted },
  // uppercase tracked label (WHOOP signature)
  label: { fontSize: 11, fontWeight: '700' as const, color: colors.textMuted, letterSpacing: 1.5, textTransform: 'uppercase' as const },
  numeral: { fontSize: 40, fontWeight: '800' as const, color: colors.text, letterSpacing: -1 },
};

export const shadow = {
  card: {
    shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 4,
  },
};
