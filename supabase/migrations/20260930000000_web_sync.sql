-- Website stats sync (GA4 + Search Console), replacing Windsor.ai's GA4 access.
-- ga4_daily was created on 30 Sep 2026 to hold the Windsor backup; the web-sync
-- function upserts into the same table (source = 'ga4_api').

create table if not exists public.ga4_daily (
  property_id text not null,
  property_name text,
  date date not null,
  source_medium text not null,
  sessions bigint not null default 0,
  active_users bigint not null default 0,
  engaged_sessions bigint not null default 0,
  avg_session_duration_s numeric,
  source text not null default 'windsor_backup',
  synced_at timestamptz not null default now(),
  primary key (property_id, date, source_medium)
);

-- One row per site/day/query and per site/day/page.
create table if not exists public.search_console_daily (
  site text not null,
  date date not null,
  dimension text not null check (dimension in ('query', 'page')),
  key text not null,
  clicks bigint not null default 0,
  impressions bigint not null default 0,
  ctr numeric,
  position numeric,
  synced_at timestamptz not null default now(),
  primary key (site, date, dimension, key)
);

create table if not exists public.web_sync_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  date_from date,
  date_to date,
  status text not null default 'running',
  details jsonb
);

-- Backend only, like the other tables.
alter table public.ga4_daily enable row level security;
alter table public.search_console_daily enable row level security;
alter table public.web_sync_runs enable row level security;
revoke all on public.ga4_daily, public.search_console_daily, public.web_sync_runs
  from anon, authenticated;

-- Manual trigger: `select public.web_sync_trigger();` (last 5 days) or
-- `select public.web_sync_trigger('2025-01-01', '2025-06-30');` for a backfill.
-- Reuses the ad-sync vault secret for the header check.
create or replace function public.web_sync_trigger(p_from date default null, p_to date default null)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://nwzeyivptlnnqdiliaxe.supabase.co/functions/v1/web-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ad_sync_secret')
    ),
    body := case
      when p_from is null then '{"days":5}'::jsonb
      else jsonb_build_object('from', p_from, 'to', coalesce(p_to, current_date - 1))
    end,
    timeout_milliseconds := 150000
  );
$$;

revoke all on function public.web_sync_trigger(date, date) from public, anon, authenticated;

-- Daily at 20:27 UTC (04:27 Bali), ten minutes after the ad sync. Re-pulls the
-- last 5 days because Search Console data lands 2-3 days late.
select cron.unschedule('web-sync-daily')
where exists (select 1 from cron.job where jobname = 'web-sync-daily');

select cron.schedule('web-sync-daily', '27 20 * * *', $$ select public.web_sync_trigger(); $$);
