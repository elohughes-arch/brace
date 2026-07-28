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

Staff-only, and **two-factor**, because this is where the agentic software
lives. Both factors are required every sign-in:

1. **Password** — email + password (`signInWithPassword`).
2. **Authenticator code** — a TOTP factor (1Password, Authy, Google
   Authenticator) verified through Supabase MFA, taking the session to AAL2.

**The gate is the database, not the browser.** Every portal policy is built on
`public.is_portal_owner()`, which returns true only when *both* hold:

- the signed-in email appears in `public.portal_owners`, and
- `auth.jwt()->>'aal' = 'aal2'` — a second factor was verified this session.

So a stolen password, a stolen magic link, or a hand-crafted AAL1 token reads
exactly nothing: not the ledger, not the pipeline, not the founding list.
Editing the page's JavaScript changes nothing either.

### First-time set-up

1. Add the owner: `insert into public.portal_owners (email) values ('name@domain.com');`
2. On `/portal/`, choose **First time, or forgotten it?** and request a link.
   The link authenticates at AAL1 only — on its own it opens nothing.
3. Set a password (12 characters minimum).
4. Scan the QR with an authenticator app and enter the six-digit code.
5. From then on: password, then code, every time.

For the emailed link to arrive back at the portal, add these under
Supabase → Authentication → URL Configuration:

- **Site URL**: `https://braceshooting.com`
- **Redirect URLs**: `https://braceshooting.com/portal/`,
  `https://brace-cyan.vercel.app/portal/`

Without them Supabase falls back to its default Site URL (`localhost:3000`)
and the link appears broken.

### What's behind it

- **Ledger** — live members, days recorded, clips, analysed days, active subs,
  founding list.
- **Field agent** — the footage pipeline as it runs.
- **Founding members** — captured by the landing form.
- **Docking bays** — where the next agents plug in.

## Preview locally

```bash
python3 -m http.server 8000   # repo root → open http://localhost:8000
```
