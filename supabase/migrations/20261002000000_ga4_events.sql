-- GA4 event counts by day and source for the booking and sign-up steps,
-- filled by the web-sync function. Read by hostOPZ's Marketing page.
create table if not exists public.ga4_events_daily (
  property_id text not null,
  property_name text,
  date date not null,
  event_name text not null,
  source_medium text not null,
  event_count bigint not null default 0,
  event_value numeric,
  synced_at timestamptz not null default now(),
  primary key (property_id, date, event_name, source_medium)
);

alter table public.ga4_events_daily enable row level security;
revoke all on public.ga4_events_daily from anon, authenticated;
