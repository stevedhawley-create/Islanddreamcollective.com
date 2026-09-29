-- Ad performance sync: pulls daily campaign stats from the Google Ads API and
-- the Meta Marketing API into Postgres, replacing the Windsor.ai connector.
-- Written by the `ad-sync` edge function (service role); never exposed to
-- anon/authenticated clients, matching the backend_only pattern used elsewhere.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.ad_performance_daily (
  platform          text        not null check (platform in ('google_ads', 'meta')),
  account_id        text        not null,
  campaign_id       text        not null,
  date              date        not null,
  campaign_name     text,
  campaign_status   text,
  currency          text,
  spend             numeric(14,2) not null default 0,
  impressions       bigint      not null default 0,
  clicks            bigint      not null default 0,
  conversions       numeric(14,2) not null default 0,
  conversion_value  numeric(14,2) not null default 0,
  raw               jsonb,
  synced_at         timestamptz not null default now(),
  primary key (platform, account_id, campaign_id, date)
);

create index if not exists ad_performance_daily_date_idx
  on public.ad_performance_daily (date desc);

create table if not exists public.ad_sync_runs (
  id           bigint generated always as identity primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  date_from    date,
  date_to      date,
  status       text not null default 'running',
  rows_upserted integer not null default 0,
  details      jsonb
);

alter table public.ad_performance_daily enable row level security;
alter table public.ad_sync_runs enable row level security;

drop policy if exists backend_only_deny_all on public.ad_performance_daily;
create policy backend_only_deny_all on public.ad_performance_daily
  for all to anon, authenticated using (false) with check (false);

drop policy if exists backend_only_deny_all on public.ad_sync_runs;
create policy backend_only_deny_all on public.ad_sync_runs
  for all to anon, authenticated using (false) with check (false);

-- Monthly rollup across platforms, for quick reporting.
create or replace view public.ad_performance_monthly
with (security_invoker = true) as
select
  date_trunc('month', date)::date as month,
  platform,
  account_id,
  currency,
  sum(spend)            as spend,
  sum(impressions)      as impressions,
  sum(clicks)           as clicks,
  sum(conversions)      as conversions,
  sum(conversion_value) as conversion_value,
  case when sum(clicks) > 0 then round(sum(spend) / sum(clicks), 2) end           as cpc,
  case when sum(conversions) > 0 then round(sum(spend) / sum(conversions), 2) end as cost_per_conversion
from public.ad_performance_daily
group by 1, 2, 3, 4;

revoke all on public.ad_performance_monthly from anon, authenticated;

-- Shared secret the cron job sends; the edge function checks it via RPC so the
-- value never has to be copied by hand.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ad_sync_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      'ad_sync_secret',
      'Header secret for the ad-sync edge function'
    );
  end if;
end $$;

create or replace function public.ad_sync_check_secret(p_secret text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'ad_sync_secret' and decrypted_secret = p_secret
  );
$$;

revoke all on function public.ad_sync_check_secret(text) from public, anon, authenticated;
grant execute on function public.ad_sync_check_secret(text) to service_role;

-- Manual trigger: `select public.ad_sync_trigger();` (last 3 days) or
-- `select public.ad_sync_trigger('2025-01-01', '2025-03-31');` for a backfill window.
create or replace function public.ad_sync_trigger(p_from date default null, p_to date default null)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://nwzeyivptlnnqdiliaxe.supabase.co/functions/v1/ad-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ad_sync_secret')
    ),
    body := case
      when p_from is null then '{"days":3}'::jsonb
      else jsonb_build_object('from', p_from, 'to', coalesce(p_to, current_date - 1))
    end,
    timeout_milliseconds := 150000
  );
$$;

revoke all on function public.ad_sync_trigger(date, date) from public, anon, authenticated;

-- Daily at 20:17 UTC (04:17 Bali). Re-pulls the last 3 days so late-attributed
-- conversions are picked up.
select cron.unschedule('ad-sync-daily')
where exists (select 1 from cron.job where jobname = 'ad-sync-daily');

select cron.schedule('ad-sync-daily', '17 20 * * *', $$ select public.ad_sync_trigger(); $$);
