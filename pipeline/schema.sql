-- Brace training data pipeline schema
-- Run in Supabase SQL editor or: psql < schema.sql

create table if not exists pipeline_videos (
    video_id      text primary key,          -- YouTube ID or source-specific ID
    source        text not null default 'youtube',
    title         text,
    channel       text,
    url           text not null,
    duration_s    integer,
    view_count    integer,
    status        text not null default 'discovered',
    -- discovered -> downloaded (triaged, awaiting review) -> approved
    --            -> clipped | rejected | error
    triage_score  real,                       -- 0-10 from vision model
    triage_notes  text,
    local_path    text,
    discovered_at timestamptz default now(),
    updated_at    timestamptz default now()
);

create table if not exists pipeline_clips (
    clip_id        uuid primary key default gen_random_uuid(),
    video_id       text references pipeline_videos(video_id) on delete cascade,
    shot_ts        real not null,             -- seconds into source video
    clip_start     real not null,
    clip_end       real not null,
    is_pair        boolean default false,     -- second spike within pair window
    pair_gap_s     real,                      -- gap to companion shot if pair
    file_path      text,
    label_status   text not null default 'pending',
    -- pending -> prelabelled | rejected   (Roboflow owns what happens next)
    roboflow_id    text,
    created_at     timestamptz default now()
);

create table if not exists pipeline_labels (
    clip_id        uuid primary key references pipeline_clips(clip_id) on delete cascade,
    clay_colour    text,                      -- orange | black | white | other
    background     text,                      -- sky | trees | mixed | ground
    weather        text,                      -- clear | overcast | rain | low_light
    camera         text,                      -- pov_glasses | barrel | gopro | unknown
    n_clays        integer,
    boxes_json     jsonb,                     -- pre-label boxes per frame
    created_at     timestamptz default now()
);

create index if not exists idx_videos_status on pipeline_videos(status);
create index if not exists idx_clips_status  on pipeline_clips(label_status);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Without this the tables are readable by anyone holding the anon key, which
-- ships in the browser. The Brace project already has these applied as the
-- `pipeline_tables` migration; this block is here so the file stands a database
-- up correctly on its own rather than leaving it open.
--
-- Both gate functions live in the owners-portal migration:
--   is_portal_owner()        email on portal_owners AND the JWT carries aal2
--   is_portal_owner_email()  email only, for routing the login screens
-- Modal connects with the service key and bypasses all of this by design.

alter table pipeline_videos enable row level security;
alter table pipeline_clips  enable row level security;
alter table pipeline_labels enable row level security;

create policy "owners read videos" on pipeline_videos
  for select to authenticated using (public.is_portal_owner());

-- the review queue is the only write a browser makes: approve or reject
create policy "owners judge videos" on pipeline_videos
  for update to authenticated
  using (public.is_portal_owner())
  with check (public.is_portal_owner());

create policy "owners read clips" on pipeline_clips
  for select to authenticated using (public.is_portal_owner());

create policy "owners judge clips" on pipeline_clips
  for update to authenticated
  using (public.is_portal_owner())
  with check (public.is_portal_owner());

create policy "owners read labels" on pipeline_labels
  for select to authenticated using (public.is_portal_owner());
