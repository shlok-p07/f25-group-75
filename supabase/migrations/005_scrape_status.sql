-- Tracks whether each date's menu was fully scraped (all halls, no errors).
-- The scraper used to decide "skip this date" based on whether ANY row existed
-- for it, which meant a partial failure (e.g. one hall's request failing)
-- looked identical to a full success and was never retried. This table lets
-- the scraper distinguish "fully scraped" from "partially scraped" so
-- incomplete dates get retried on the next run instead of being skipped forever.

create table if not exists scrape_status (
  date         date primary key,
  complete     boolean not null default false,
  error_count  integer not null default 0,
  last_errors  jsonb not null default '[]',
  updated_at   timestamptz not null default now()
);

alter table scrape_status enable row level security;
create policy "public read scrape_status" on scrape_status for select using (true);
