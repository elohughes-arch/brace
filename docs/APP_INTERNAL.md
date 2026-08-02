# Internal — the owners portal inside the iOS app

A brief for the Brace iOS app session. The goal: a row in Settings called
**Internal** that opens the company's own rooms — run the pipeline, see costs
and hours, tick tasks, open the documents shelf — native, on a phone.

The good news first: **there is no backend to build.** The owners portal at
`www.braceshooting.com/portal` is a thin skin over two services the app can
talk to directly. Everything below already exists and is already secured.

## The two services

1. **Supabase** — project `tvcbizxwadibtclamnyy` (`SUPABASE_URL` +
   `SUPABASE_ANON_KEY`, same values the web app ships; the anon key is public
   by design). Auth, every table, and the documents bucket.
2. **The Vercel proxy** — `POST https://www.braceshooting.com/api/run/{stage}`
   with the user's Supabase access token as a `Bearer` header. This is the
   only way to start pipeline work; the Modal token never leaves the server.

**Never embed** the `PIPELINE_TOKEN`, the `service_role` key, or any secret in
the app binary. The app needs only the URL and the anon key.

## Who sees Internal

Owners are rows in `portal_owners`, checked by two RPCs:

- `is_portal_owner_email()` — true if the signed-in email is on the list.
  Cheap; call it after sign-in and use it to decide whether the Internal row
  *renders at all*. Non-owners never see the row.
- `is_portal_owner()` — email **and** `aal2` (a verified TOTP factor this
  session). This is what RLS and the proxy actually enforce. Reading office
  tables and running stages both require it.

So the flow is: sign in as usual → if `is_portal_owner_email()` → show the
Internal row → on first entry, run the TOTP challenge
(`auth.mfa.listFactors` → `challenge` → `verify` in supabase-swift) to reach
aal2 → the doors open. A phone that skips the challenge gets empty reads and
403s — the database refuses, not the UI.

Keep the portal session separate from the member session if the app has one:
the web app uses a distinct `storageKey` (`brace-portal-auth`) for exactly
this reason.

## Running the pipeline

`POST https://www.braceshooting.com/api/run/{stage}` — empty body,
`Authorization: Bearer <access_token>`.

- Stages: `discover`, `triage`, `clip`, `screen`, `prelabel`, `health`.
- Optional query keys (all others are dropped): `limit`, `unreviewed`;
  `discover` also takes `level` (`1`–`8` or `pov`) for criteria discovery.
- A long stage answers `202` after ~25s — the job is still running on Modal;
  poll the tables for progress rather than re-posting.
- Errors are JSON with a `hint`; `401/403` mean the token or aal2 gate.

## What to read (all plain Supabase queries, RLS does the guarding)

| Screen | Source |
|---|---|
| Counts / badges | `pipeline_videos` by `status`, `pipeline_clips` by `label_status`, `todos` where `done = false` |
| Review queue | `pipeline_videos` where `status = 'downloaded'` |
| Health | `pipeline_health` (probe, status, detail, checked_at) |
| Activity feed | `pipeline_activity` (at, stage, line, tone) — every run's outcome, written by the web portal and by Modal itself; newest first |
| AI spend | RPC `total_spend()` |
| Dataset ladder | RPC `dataset_progress()`; splits via `split_preview()` |
| Model trials | `verdict_trials` + RPC `trial_accuracy()` |
| Tasks | `todos` — a kanban: `status` is `not_started` / `in_progress` / `complete`. Insert `{title, added_by}` (status defaults to not started); move a task by updating `status` (also set `done` and `done_at` when it reaches complete, the web portal keeps them in step); any owner may update or delete |
| Hours | `work_log` — insert `{email, hours, task, worked_on}`; owners read all, delete own |
| Costs | `expenses` — `{email, item, amount, category, bought_on, recurrence}`; categories: Software subscription, Hardware, Data & AI, Shooting, Other; `recurrence` is `one-time` / `weekly` / `monthly` / `yearly`. The forecast stat is derived, not stored: sum recurring rows normalised to a month (weekly ×52/12, monthly ×1, yearly ÷12) |

Names for the two owners: `elohughes@icloud.com` → Eddie,
`rupertokelly98@gmail.com` → Rupert.

## Documents

Private bucket `documents` (owners-only via storage RLS):

- List: `storage.from("documents").list()`
- Open: `createSignedURL(path, expiresIn: 3600)` → hand to `SFSafariViewController`
  or QuickLook
- Upload: `upload("\(timestamp)-\(filename)", data)` — the web portal prefixes
  a millisecond timestamp to dodge name collisions; do the same
- Create: the web portal also *writes* documents — a title plus markdown body
  uploaded as `\(timestamp)-\(title).md`. Mirror it with a simple editor if
  you like; they are ordinary files in the same bucket
- The dataset strategy is not a file: it is a live page (`#strategy` on the
  web portal, fed by RPC `dataset_progress()`). In the app, render it from the
  RPC rather than looking for a document

The plan holds 100 GB; decks and PDFs are nothing.

## Suggested shape

Settings → **Internal** (owners only) →

- **Agentic** — counts at the top, run buttons per stage, health dots,
  AI spend line
- **Productivity** — the kanban (not started / in progress / complete),
  log-hours form, hours split
- **Costs** — purchase form, totals, category split
- **Documents** — the shelf

Mirror the web portal's order and words where possible so the two feel like
one product. Anything unclear, read `portal/portal.js` in this repo — the
web implementation is the reference for every query above.
