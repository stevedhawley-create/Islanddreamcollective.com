-- Log and trigger for the ad-manage edge function (Claude-applied Meta ad
-- changes, each one approved by Steve first).

create table if not exists public.ad_change_log (
  id bigint generated always as identity primary key,
  changed_at timestamptz not null default now(),
  platform text not null,
  object_id text not null,
  object_name text,
  action text not null,
  before jsonb,
  after jsonb,
  note text
);

alter table public.ad_change_log enable row level security;
revoke all on public.ad_change_log from anon, authenticated;

-- `select public.ad_manage('{"action":"list"}'::jsonb);` returns a request id;
-- read the reply with `select content from net._http_response where id = <id>;`
create or replace function public.ad_manage(p_body jsonb)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select net.http_post(
    url := 'https://nwzeyivptlnnqdiliaxe.supabase.co/functions/v1/ad-manage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ad_sync_secret')
    ),
    body := p_body,
    timeout_milliseconds := 60000
  );
$$;

revoke all on function public.ad_manage(jsonb) from public, anon, authenticated;
