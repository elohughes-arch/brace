# Brace — The Modern Shooting Log (landing page)

A redesign of [braceshooting.com](https://braceshooting.com)'s marketing site.

**Brace** turns a day's POV footage into a private, heritage **game book**, automatically —
*"Wear the camera. Shoot the day."* This is a self-contained static landing page; it does not
touch the existing app in the repo root.

## Design system

- **Concept:** *the leather game book, re-cut in midnight and brass — a precision instrument that writes itself.*
- **Colour (60 / 30 / 8 / 2):** Midnight `#0B1B2D` · Warm ivory `#F4EEE1` · Field green `#34503C`
  (Sage `#7E9B82` for legible green on dark) · Brass `#B8995A` as a precious ~2% accent only.
- **Type:** Cormorant Garamond (display, with the signature ivory headline + one brass-italic word),
  Inter (body), IBM Plex Mono (ledger/data).
- **Craft:** no photography — all richness is CSS/SVG (estate-map contours, blueprint grid, the
  game-book card). Responsive, accessible (WCAG AA), and honours `prefers-reduced-motion`.

## Files

| File | Purpose |
|------|---------|
| `index.html` | The full landing page + inline SVG icon sprite/logo |
| `styles.css` | Tokenised design system + every section |
| `script.js`  | Sticky header, scroll reveals, count-up, FAQ, mobile nav, founding-member form |

## Preview locally

```bash
cd brace
python3 -m http.server 8000   # then open http://localhost:8000
```

No build step. Deployed to GitHub Pages via `.github/workflows/pages.yml`.
