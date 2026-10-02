-- Microsoft Clarity's daily summary (sessions, scroll depth, rage and dead
-- clicks, quick-backs...), overall (url = '') and per page, saved by the
-- web-sync function so a history builds up (Clarity's export API only goes
-- back 3 days). Read by hostOPZ's Marketing page.
create table if not exists public.clarity_daily (
  project_id text not null,
  date date not null,
  metric text not null,
  url text not null default '',
  data jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  primary key (project_id, date, metric, url)
);

alter table public.clarity_daily enable row level security;
revoke all on public.clarity_daily from anon, authenticated;
