# Ad sync (Windsor.ai replacement)

Pulls daily campaign stats from Google Ads and Meta Ads into the `Island-dream`
Supabase project, free of charge, using the platforms' own APIs.

| Piece | Where |
|---|---|
| Tables `ad_performance_daily`, `ad_sync_runs`, view `ad_performance_monthly` | `migrations/20260928000000_ad_sync.sql` |
| Sync code | `functions/ad-sync/index.ts` (edge function `ad-sync`) |
| Schedule | `pg_cron` job `ad-sync-daily`, 04:17 Bali time, re-pulls the last 3 days |

The database, function and schedule are already live. The only remaining
steps need your logins, and each platform works on its own — do whichever
you want first. Paste each value into **Supabase dashboard → Island-dream →
Edge Functions → Secrets** (never into chat).

## Meta Ads (≈15 min)

1. Go to **business.facebook.com → Settings → Users → System users**. Add a
   system user (role: Admin).
2. **Assign assets** → your ad account(s) → *Manage campaigns* (or *View
   performance* for read-only).
3. **Generate new token** → pick an app (create one at developers.facebook.com
   → *My Apps → Create App → Other → Business* if you have none) → tick
   `ads_read` → set expiry to **Never**.
4. Add secrets:
   - `META_ACCESS_TOKEN` = the token
   - `META_AD_ACCOUNT_IDS` = your ad account id(s), comma-separated
     (the number in Ads Manager's URL after `act=`)

## Google Ads (≈30 min + Google's review wait)

1. **Developer token.** Google Ads needs a *manager account* (free —
   ads.google.com/home/tools/manager-accounts). Link your ad account to it,
   then in the manager account open **Admin → API Center**, fill in the form and
   apply. Explorer/Basic access is enough. Approval can take a few days.
2. **OAuth client.** At console.cloud.google.com create a project → enable
   **Google Ads API** → *APIs & Services → Credentials → Create credentials →
   OAuth client ID → Web application*. Add authorised redirect URI
   `https://developers.google.com/oauthplayground`. Put the app on the
   *Production* publishing status so the refresh token doesn't expire in 7 days.
3. **Refresh token.** Open developers.google.com/oauthplayground → ⚙️ → *Use
   your own OAuth credentials* (paste the client id/secret) → scope
   `https://www.googleapis.com/auth/adwords` → *Authorize* → *Exchange
   authorization code for tokens* → copy the **refresh token**.
4. Add secrets:
   - `GOOGLE_ADS_DEVELOPER_TOKEN`
   - `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`
   - `GOOGLE_ADS_REFRESH_TOKEN`
   - `GOOGLE_ADS_CUSTOMER_IDS` = ad account id(s), e.g. `123-456-7890`
   - `GOOGLE_ADS_LOGIN_CUSTOMER_ID` = the manager account id

## Running it

In the Supabase SQL editor:

```sql
-- sync the last 3 days now
select public.ad_sync_trigger();

-- backfill history (Google keeps ~2+ years, Meta ~37 months); run in chunks
select public.ad_sync_trigger('2025-01-01', '2025-06-30');

-- did it work?
select * from ad_sync_runs order by id desc limit 5;
select * from ad_performance_monthly order by month desc;
```

A platform whose secrets aren't set yet shows `skipped` in `ad_sync_runs`.

## Upkeep

- **Google API version**: Google retires each version about a year after
  release and emails a sunset reminder. Set the `GOOGLE_ADS_API_VERSION`
  secret (e.g. `v24`) to move up without redeploying.
- **Meta**: system-user tokens don't expire; `META_API_VERSION` can be bumped
  the same way.
