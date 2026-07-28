# Brace — The Modern Shooting Log (braceshooting.com)

**Brace** turns a day's POV footage into a private, heritage **game book**, automatically —
*"Wear the camera. Shoot the day."*

## What's here

| Path | Purpose |
|------|---------|
| `index.html` + `styles.css` + `script.js` | The marketing landing page (new branding) |
| `app/` | The authenticated member app — Supabase auth, no build step |
| `portal/` | **Owners portal** — the training-data pipeline dashboard (see below) |
| `api/run/[stage].js` | Server-side proxy that holds the pipeline token |
| `pipeline/` | The Modal pipeline: discover, triage, clip, pre-label (not part of the web deploy) |
| `mobile/` | The Expo / React Native app (not part of the web deploy) |
| `vercel.json` / `.vercelignore` | Static deploy config for Vercel |

## Design system

Everything follows the Brand & Design Bible. British English throughout.

- **Wordmark:** a vector asset in `assets/brand/`, never redrawn and never
  typeset from a font. The open `A` is the shot clay; the counter is the clay
  itself. Two lockups, one geometry.
- **Ground:** sunken `#1F2120` · base `#2A2C29` · raised `#33352F` · raised-2
  `#3C3E37`. Elevation is a step up that ramp plus an optional 1px hairline —
  never a drop shadow.
- **Accent:** clay `#F05A28`, and it is the only one. Positive state `#6FBE72`,
  destructive `#E0705F`.
- **Type:** one family, Inter. Instrument Sans is wordmark-only and the site
  never loads it. Figures use Inter's tabular numerals rather than a second face.
- **Splash:** the wordmark lands, the clay holds, then smokes to powder.

If something needs a value the bible does not have, the bible gets extended
first: no invented hexes, no second accent, no fifth font weight.

## Deploying on Vercel

The site is a static deploy — no build step. To connect:

1. **Vercel → Add New → Project → Import** this repo (`elohughes-arch/brace`).
   Framework preset: **Other**; leave build command empty, output directory default.
   `vercel.json` (clean URLs, trailing slashes) and `.vercelignore` do the rest.
2. **Settings → Domains** — attach `braceshooting.com`.
3. Done — `/` is the landing page, `/app/` the member app, `/portal/` the owners portal.
   Every push to `main` deploys production; branches get preview URLs.

The pages themselves need no environment variables: they talk to Supabase with the
public anon key, and everything sensitive is behind Row Level Security. The one
serverless function, `/api/run/<stage>`, does need four — see
[`pipeline/README.md`](pipeline/README.md).

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

### What's behind it: the training-data pipeline

The portal is the control surface for the agentic software that builds Brace's
object-detection training set. Third-party shooting footage goes in; labelled
clays come out.

```
discover  →  triage  →  [ you ]  →  clip  →  prelabel  →  Roboflow
  search      score       review     cut       boxes        humans check
```

- **Control** — live counts for every stage, a button per stage, and a running
  log of what was kicked off this session.
- **Review** — the one step that needs a person. Triage keeps what scores well;
  you approve what is worth the GPU time and reject the rest. Only approved
  footage reaches the clipper.

Every stage runs on Modal, not here. The buttons post to `/api/run/<stage>`, a
serverless function that asks the database `is_portal_owner()` and only then
attaches `PIPELINE_TOKEN` and calls Modal — so the token never reaches a
browser, and a session without the second factor cannot start a job any more
than it can read a row. Long stages outlive the request; the function returns
"still running" after 25 seconds and the counts catch up on their own.

Deploying the Modal side, the secret it needs, and the four Vercel environment
variables are all in [`pipeline/README.md`](pipeline/README.md).

## Checks

No build step, so no CI to speak of — but the two pieces that can silently
corrupt things are covered, and both run in under a second with no network,
no ffmpeg and no API keys.

```bash
node tests/proxy.test.cjs      # the /api/run door: who gets through, what reaches Modal
python3 tests/test_pipeline.py # clip boundaries, true pairs, reading the model's reply
```

The proxy suite is the one worth keeping green. It asserts that a request with
no bearer token, or one the database will not vouch for, never reaches Modal at
all — and that the pipeline token is attached server-side while the caller's own
JWT is not forwarded on.

## Preview locally

```bash
python3 -m http.server 8000   # repo root → open http://localhost:8000
```
