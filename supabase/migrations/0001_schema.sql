-- Third Umpire: core schema. Every association-owned row carries association_id.
-- Row-level security is switched on in 0002; audit and feature flags in 0003.

create extension if not exists pgcrypto;

-- ---------- people and associations ----------
create table associations (
  id            text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  name          text not null,
  playhq_org_id text,                                   -- entered by the admin in Settings, never in the repo
  timezone      text not null default 'Australia/Sydney',
  notify_email  text,
  plan          text not null default 'trial' check (plan in ('trial','active','suspended')),
  week_start    int  not null default 1 check (week_start between 0 and 6),
  config        jsonb not null default '{}'::jsonb,     -- membership types, player-umpire rule, group order, grade-to-group
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table people (                                    -- one per person, edited by that person only
  email          text primary key check (email = lower(email)),
  first_name     text, last_name text, name text,
  dob            date, address text, phone text,
  accreditation  text, accreditation_provider text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table memberships (                               -- a person's place in one association
  association_id text not null references associations(id) on delete cascade,
  email          text not null references people(email) on delete cascade,
  pid            text not null,                          -- the app's umpire id
  active         boolean not null default false,
  membership     text,
  member_since   date,
  wants_to_umpire boolean,
  approved boolean, deactivated boolean, non_member boolean, rejected boolean, suspended boolean,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (association_id, email),
  unique (association_id, pid)
);

create table officers (
  association_id text not null references associations(id) on delete cascade,
  email          text not null check (email = lower(email)),
  added_at       timestamptz not null default now(),
  primary key (association_id, email)
);

create table platform_admins (email text primary key check (email = lower(email)));

-- ---------- competitions and fixtures ----------
create table groups (
  association_id text not null references associations(id) on delete cascade,
  id             uuid not null default gen_random_uuid(),
  key            text not null,                          -- e.g. senior
  name           text not null,
  sort           int  not null default 0,
  playhq_competition_id text,
  primary key (association_id, id),
  unique (association_id, key)
);

create table seasons (
  association_id text not null references associations(id) on delete cascade,
  id             text not null,                          -- the app's season id (PlayHQ season id once synced)
  name           text,
  group_key      text,
  playhq_season_id text,
  data           jsonb not null default '{}'::jsonb,     -- the season calendar umpires answer for
  updated_at     timestamptz not null default now(),
  primary key (association_id, id)
);

create table grades (
  association_id text not null references associations(id) on delete cascade,
  id             uuid not null default gen_random_uuid(),
  name           text not null,                          -- e.g. Senior B05
  short_label    text,                                   -- optional: B5
  group_key      text,
  umpires_per_game int not null default 0 check (umpires_per_game between 0 and 6),
  sort           int not null default 0,
  playhq_grade_id text,
  primary key (association_id, id),
  unique (association_id, name)
);

create table rounds (
  association_id text not null references associations(id) on delete cascade,
  id             text not null,
  comp           text, title text,
  start_date     date, end_date date,
  published      boolean not null default false,
  data           jsonb not null default '{}'::jsonb,     -- dates, stats, source, publishedAt...
  updated_at     timestamptz not null default now(),
  primary key (association_id, id)
);

create table games (
  association_id text not null references associations(id) on delete cascade,
  id             text not null,
  round_id       text not null,
  grade          text, comp text, round_name text,
  format         text,                                   -- twoDay / oneDay / t20 (matchType)
  home_name      text, away_name text,
  status         text,
  slots          int not null default 0,
  removed        boolean not null default false,         -- removed from the fixture, never deleted
  playhq_game_id text,
  last_synced_at timestamptz,
  extra          jsonb not null default '{}'::jsonb,     -- anything else the app keeps on a game
  primary key (association_id, id),
  foreign key (association_id, round_id) references rounds(association_id, id) on delete cascade
);
create index on games (association_id, round_id);
create unique index games_playhq on games (association_id, playhq_game_id) where playhq_game_id is not null;

create table game_days (                                  -- a two-day game is ONE game with two rows
  association_id text not null,
  game_id        text not null,
  day_no         int  not null,
  date           date not null,                          -- local date at the ground
  start_time     text,
  ground         text, address text, lat double precision, lng double precision,
  primary key (association_id, game_id, day_no),
  foreign key (association_id, game_id) references games(association_id, id) on delete cascade
);

-- ---------- allocation and history ----------
create table availability (
  association_id text not null references associations(id) on delete cascade,
  season_id      text not null,
  email          text not null,
  data           jsonb not null default '{}'::jsonb,     -- answers by date (part-of-day later, behind a flag)
  updated_at     timestamptz not null default now(),
  primary key (association_id, season_id, email)
);

create table appointments (                               -- one row per umpire per slot per day
  association_id text not null,
  game_id        text not null,
  date           date not null,
  slot_index     int  not null check (slot_index >= 0),
  pid            text not null,
  name           text,
  player_umpire  boolean not null default false,
  status         text not null default 'draft' check (status in ('draft','published','withdrawn')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (association_id, game_id, date, slot_index),
  foreign key (association_id, game_id) references games(association_id, id) on delete cascade,
  foreign key (association_id, pid) references memberships(association_id, pid) on delete restrict
);
create index on appointments (association_id, pid, date);   -- an umpire's history, 200-300 rows each

create table withdrawals (
  association_id text not null references associations(id) on delete cascade,
  id             text not null,
  email          text not null,
  pid            text not null,
  handled        boolean not null default false,
  data           jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now(),
  primary key (association_id, id)
);

create table association_settings (                        -- officer-only (slots by grade, player-umpire applications)
  association_id text primary key references associations(id) on delete cascade,
  data           jsonb not null default '{}'::jsonb
);

-- ---------- running the system ----------
create table audit_log (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  association_id text,
  actor          text,
  table_name     text not null,
  action         text not null,
  row_key        text,
  old_row        jsonb, new_row jsonb
);
create index on audit_log (association_id, at desc);

create table feature_flags (
  key text primary key, description text, enabled_by_default boolean not null default false
);
create table association_flags (
  association_id text not null references associations(id) on delete cascade,
  key text not null references feature_flags(key) on delete cascade,
  enabled boolean not null,
  primary key (association_id, key)
);

create table sync_runs (
  id             bigint generated always as identity primary key,
  association_id text not null references associations(id) on delete cascade,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  ok             boolean,
  games_seen     int, games_changed int, games_removed int,
  error          text
);

create table mail_queue (                                  -- picked up by the send-email function later
  id             bigint generated always as identity primary key,
  association_id text not null references associations(id) on delete cascade,
  to_email       text not null,
  message        jsonb not null,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz
);
