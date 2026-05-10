-- Dining hall weekly hours scraped from DineOnCampus weekly_schedule endpoint.
-- Stores all 31 campus dining locations (not just menu halls) so the app can
-- show hours for any location. Upserted daily so hours auto-update for any
-- semester (spring/summer/fall/winter break).

create table if not exists location_hours (
  id                   uuid primary key default gen_random_uuid(),
  location_original_id text not null,
  location_name        text not null,
  location_slug        text,
  date                 date not null,
  day_of_week          integer not null, -- 0=Sun … 6=Sat
  status               text not null default 'closed',
  hours                jsonb not null default '[]', -- [{start_hour, start_minutes, end_hour, end_minutes}]
  has_special_hours    boolean not null default false,
  always_open          boolean not null default false,
  scraped_at           timestamptz not null default now(),
  unique(location_original_id, date)
);

alter table location_hours enable row level security;
create policy "public read location_hours" on location_hours for select using (true);

create index if not exists idx_location_hours_date     on location_hours(date);
create index if not exists idx_location_hours_loc_date on location_hours(location_original_id, date);
