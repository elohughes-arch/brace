# Brace training-data pipeline

Third-party shooting footage in, labelled clays out. Four stages, all running
on Modal, all writing back to Supabase. The owners portal at `/portal/` is the
control surface — nothing here is meant to be run by hand once it is deployed.

```
discover  →  triage  →  [ you ]  →  clip  →  prelabel  →  Roboflow
  search      score       review     cut       boxes        humans check
```

| Stage | Where | What it does | Leaves behind |
|---|---|---|---|
| `discover` | CPU, nightly 02:00 UTC | Searches the YouTube Data API against seven queries, filters by duration and title | `pipeline_videos` rows, `status='discovered'` |
| `triage` | CPU | Downloads at ≤720p, samples eight frames, asks Claude to score training value 0-10 | `status='downloaded'` (kept) or `'rejected'`, plus `triage_score` |
| review | the portal | You approve or reject what triage kept | `status='approved'` |
| `clip` | CPU | Finds gunshots by audio energy spike, cuts a clip around each, tags true pairs | `pipeline_clips` rows |
| `prelabel` | T4 GPU | Grounding DINO draws first-pass boxes at 5fps, uploads every third annotated frame | `pipeline_labels`, a Roboflow batch |

## Why the review step exists

Triage is cheap and clip-plus-prelabel is not: a download, an ffmpeg pass, GPU
time and then a human's attention in Roboflow. One person looking at a
thumbnail and a score for two seconds saves all of that. `clip` therefore reads
`status='approved'` only. If you want to skip review entirely, post to the clip
endpoint with `?unreviewed=1` and it will take anything that survived triage.

## Setting it up

**1. Database.** Already applied to the Brace project as the `pipeline_tables`
migration — the three tables, their indexes, and RLS policies that let a
two-factor portal owner read everything and update video status. `schema.sql`
is the plain version if you ever need to stand this up somewhere else.

**2. Modal secret.** Create one named `brace-pipeline` with:

```
SUPABASE_URL          https://tvcbizxwadibtclamnyy.supabase.co
SUPABASE_SERVICE_KEY  the service_role key (bypasses RLS — never ships to a browser)
YOUTUBE_API_KEY       YouTube Data API v3
ANTHROPIC_API_KEY     for triage scoring
ROBOFLOW_API_KEY      your Roboflow key
ROBOFLOW_PROJECT      the project slug
PIPELINE_TOKEN        a long random string you invent
```

**3. Deploy.**

```bash
pip install -r requirements.txt
modal deploy modal_app.py
```

Modal prints four URLs of the form
`https://<workspace>--brace-pipeline-<stage>.modal.run`.

**4. Point the website at them.** In the Vercel project, add:

```
SUPABASE_URL       https://tvcbizxwadibtclamnyy.supabase.co
SUPABASE_ANON_KEY  the anon/publishable key
PIPELINE_TOKEN     the same value as in the Modal secret
MODAL_BASE_URL     https://<workspace>--brace-pipeline
```

`MODAL_BASE_URL` is the shared prefix; `/api/run/<stage>` appends
`-<stage>.modal.run`. If your endpoint names differ, set `MODAL_URL_DISCOVER`,
`MODAL_URL_TRIAGE`, `MODAL_URL_CLIP` and `MODAL_URL_PRELABEL` instead.

## How the token stays secret

`PIPELINE_TOKEN` never leaves a server. The portal posts to `/api/run/<stage>`
on braceshooting.com carrying only the visitor's Supabase session. That
function asks the database `is_portal_owner()` — true only when the email is on
`portal_owners` **and** the session has cleared a TOTP code — and only then
attaches the token and calls Modal. A stolen anon key gets you nothing; a
password without the second factor gets you nothing.

## Running a stage by hand

Each script still works on its own, which is the fastest way to tune it against
your own Vanguard footage before it touches third-party video.

```bash
python discover.py --query "shotkam sporting clays"
python triage.py ~/footage/day1.mp4          # prints KEEP/DROP and why
python clipper.py ~/footage/day1.mp4 --dry-run   # lists detected shots
```

`clipper.py`'s thresholds are the ones worth tuning: `K_MAD` decides what counts
as a shot, `PRE_S`/`POST_S` how much flight and break you keep either side.

## A note on sourcing

Bulk-downloading platform footage sits against YouTube's terms of service.
Discovery and download are deliberately separate stages so the source can be
swapped for creator-permission footage without touching anything downstream —
point `discover` at a different list and the rest of the pipeline does not care.
