# Brace — The Modern Shooting Log (braceshooting.com)

**Brace** turns a day's POV footage into a private, heritage **game book**, automatically —
*"Wear the camera. Shoot the day."*

## What's here

| Path | Purpose |
|------|---------|
| `index.html` + `styles.css` + `script.js` | The marketing landing page (new branding) |
| `app/` | The authenticated member app — Supabase auth, no build step |
| `portal/` | **Owners portal** — the estate office (see below) |
| `mobile/` | The Expo / React Native app (not part of the web deploy) |
| `vercel.json` / `.vercelignore` | Static deploy config for Vercel |

## Design system

- **Concept:** *the leather game book, re-cut in midnight and brass — a precision instrument that writes itself.*
- **Colour (60 / 30 / 8 / 2):** Midnight `#0B1B2D` · Warm ivory `#F4EEE1` · Field green `#34503C`
  (Sage `#7E9B82` for legible green on dark) · Brass `#B8995A` as a precious ~2% accent only.
- **Type:** Cormorant Garamond (display, with the signature ivory headline + one brass-italic word),
  Inter (body), IBM Plex Mono (ledger/data).
- **Craft:** no photography — all richness is CSS/SVG. Responsive, accessible (WCAG AA),
  honours `prefers-reduced-motion`.

## Deploying on Vercel

The site is a static deploy — no build step. To connect:

1. **Vercel → Add New → Project → Import** this repo (`elohughes-arch/brace`).
   Framework preset: **Other**; leave build command empty, output directory default.
   `vercel.json` (clean URLs, trailing slashes) and `.vercelignore` do the rest.
2. **Settings → Domains** — attach `braceshooting.com`.
3. Done — `/` is the landing page, `/app/` the member app, `/portal/` the owners portal.
   Every push to `main` deploys production; branches get preview URLs.

No environment variables are needed: the site talks to Supabase with the public anon
key, and everything sensitive is protected by Row Level Security.

## Owners portal — the estate office (`/portal/`)

Staff-only. Signs in against the same Supabase project as the app; access is decided
**server-side** by `public.is_portal_owner()` — a security-definer check against the
`portal_owners` table (RLS everywhere; a non-owner session reads zero rows).

- **Ledger** — live members, days recorded, clips, analysed days, active subs, founding list.
- **Field agent** — the footage pipeline as it runs: clip statuses + recent analysis results.
- **Founding members** — the landing form writes to `founding_members` (anon insert-only);
  the portal reads the list.
- **Docking bays** — where the next agents (game-book writer, highlights cutter,
  coaching agent) plug in as they come online.

To add an owner: `insert into public.portal_owners (email) values ('name@domain.com');`
(Supabase SQL editor — the table is service-role only by design.) The owner also needs a
normal account (email + password) in Supabase auth.

## Preview locally

```bash
python3 -m http.server 8000   # repo root → open http://localhost:8000
```
