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
    -- discovered -> triaged -> rejected | downloaded -> clipped
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
    -- pending -> prelabelled -> uploaded -> verified | rejected
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
