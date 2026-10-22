// ad-sync: pulls daily campaign performance from Google Ads and Meta Ads into
// public.ad_performance_daily. Triggered by pg_cron (see the ad_sync migration)
// or manually with `select public.ad_sync_trigger();`.
//
// Request body (all optional):
//   { "days": 3 }                                -> last N full days (default 3)
//   { "from": "2025-01-01", "to": "2025-03-31" } -> explicit window (backfill)
//   { "platforms": ["google_ads"] }              -> limit to one platform
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets). A platform whose
// secrets are missing is skipped, so each can be set up independently.
//   Google: GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_CLIENT_ID,
//           GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
//           GOOGLE_ADS_CUSTOMER_IDS (comma-separated, digits only),
//           GOOGLE_ADS_LOGIN_CUSTOMER_ID (manager account id, optional),
//           GOOGLE_ADS_API_VERSION (optional, default below)
//   Meta:   META_ACCESS_TOKEN, META_AD_ACCOUNT_IDS (comma-separated, no "act_"),
//           META_API_VERSION (optional, default below)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Google sunsets each version roughly a year after release (v22 ends 2026-10-07);
// bump this, or set the secret, when the sunset reminder arrives.
const GOOGLE_ADS_API_VERSION = Deno.env.get("GOOGLE_ADS_API_VERSION") ?? "v23";
const META_API_VERSION = Deno.env.get("META_API_VERSION") ?? "v23.0";

// Meta reports many action types; these are the ones counted as conversions.
// "lead" is Meta's rollup of all lead types, so it is used alone when present.
const META_LEAD_ACTIONS = [
  "lead",
  "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead",
];

type Row = {
  platform: "google_ads" | "meta";
  account_id: string;
  campaign_id: string;
  date: string;
  campaign_name: string | null;
  campaign_status: string | null;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversion_value: number;
  raw: unknown;
  synced_at: string;
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function env(name: string): string | undefined {
  const v = Deno.env.get(name)?.trim();
  return v ? v : undefined;
}

function ids(name: string): string[] {
  return (env(name) ?? "")
    .split(",")
    .map((s) => s.trim().replace(/-/g, "").replace(/^act_/, ""))
    .filter(Boolean);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

// Splits [from, to] into windows of at most `size` days so large backfills
// stay within API response limits.
function windows(from: string, to: string, size: number): [string, string][] {
  const out: [string, string][] = [];
  for (let start = from; start <= to; start = addDays(start, size)) {
    const end = addDays(start, size - 1);
    out.push([start, end < to ? end : to]);
  }
  return out;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- Google Ads

async function googleAccessToken(): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: env("GOOGLE_ADS_CLIENT_ID")!,
    client_secret: env("GOOGLE_ADS_CLIENT_SECRET")!,
    refresh_token: env("GOOGLE_ADS_REFRESH_TOKEN")!,
  });
  const json = await fetchJson("https://oauth2.googleapis.com/token", { method: "POST", body });
  return json.access_token;
}

async function syncGoogle(from: string, to: string, now: string): Promise<Row[]> {
  const customers = ids("GOOGLE_ADS_CUSTOMER_IDS");
  const token = await googleAccessToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "developer-token": env("GOOGLE_ADS_DEVELOPER_TOKEN")!,
    "Content-Type": "application/json",
  };
  const loginId = env("GOOGLE_ADS_LOGIN_CUSTOMER_ID")?.replace(/-/g, "");
  if (loginId) headers["login-customer-id"] = loginId;

  const query = `
    SELECT customer.id, customer.currency_code, campaign.id, campaign.name,
           campaign.status, segments.date, metrics.cost_micros,
           metrics.impressions, metrics.clicks, metrics.conversions,
           metrics.conversions_value
    FROM campaign
    WHERE segments.date BETWEEN '${from}' AND '${to}'`;

  const rows: Row[] = [];
  for (const cid of customers) {
    const batches = await fetchJson(
      `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${cid}/googleAds:searchStream`,
      { method: "POST", headers, body: JSON.stringify({ query }) },
    );
    for (const batch of batches ?? []) {
      for (const r of batch.results ?? []) {
        const m = r.metrics ?? {};
        rows.push({
          platform: "google_ads",
          account_id: cid,
          campaign_id: String(r.campaign.id),
          date: r.segments.date,
          campaign_name: r.campaign.name ?? null,
          campaign_status: r.campaign.status ?? null,
          currency: r.customer?.currencyCode ?? null,
          spend: Number(m.costMicros ?? 0) / 1_000_000,
          impressions: Number(m.impressions ?? 0),
          clicks: Number(m.clicks ?? 0),
          conversions: Number(m.conversions ?? 0),
          conversion_value: Number(m.conversionsValue ?? 0),
          raw: r,
          synced_at: now,
        });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------- Meta

function metaActionTotal(list: { action_type: string; value: string }[] | undefined): number {
  if (!list) return 0;
  const byType = new Map(list.map((a) => [a.action_type, Number(a.value)]));
  if (byType.has("lead")) return byType.get("lead")!;
  return META_LEAD_ACTIONS.reduce((sum, t) => sum + (byType.get(t) ?? 0), 0);
}

async function syncMeta(from: string, to: string, now: string): Promise<Row[]> {
  const token = env("META_ACCESS_TOKEN")!;
  const rows: Row[] = [];
  for (const accountId of ids("META_AD_ACCOUNT_IDS")) {
    for (const [since, until] of windows(from, to, 30)) {
      const params = new URLSearchParams({
        level: "campaign",
        time_increment: "1",
        time_range: JSON.stringify({ since, until }),
        fields: "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,account_currency",
        limit: "500",
        access_token: token,
      });
      let url: string | null =
        `https://graph.facebook.com/${META_API_VERSION}/act_${accountId}/insights?${params}`;
      while (url) {
        const page = await fetchJson(url);
        for (const r of page.data ?? []) {
          rows.push({
            platform: "meta",
            account_id: accountId,
            campaign_id: r.campaign_id,
            date: r.date_start,
            campaign_name: r.campaign_name ?? null,
            campaign_status: null,
            currency: r.account_currency ?? null,
            spend: Number(r.spend ?? 0),
            impressions: Number(r.impressions ?? 0),
            clicks: Number(r.clicks ?? 0),
            conversions: metaActionTotal(r.actions),
            conversion_value: metaActionTotal(r.action_values),
            raw: r,
            synced_at: now,
          });
        }
        url = page.paging?.next ?? null;
      }
    }
  }
  return rows;
}

// ------------------------------------------------------------------- Handler

const PLATFORMS = {
  google_ads: {
    configured: () =>
      ["GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
        "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_CUSTOMER_IDS"].every((n) => env(n)),
    sync: syncGoogle,
  },
  meta: {
    configured: () => ["META_ACCESS_TOKEN", "META_AD_ACCOUNT_IDS"].every((n) => env(n)),
    sync: syncMeta,
  },
} as const;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = req.headers.get("x-sync-secret") ?? "";
  const { data: ok } = await supabase.rpc("ad_sync_check_secret", { p_secret: secret });
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const yesterday = addDays(isoDate(new Date()), -1);
  const to: string = body.to ?? yesterday;
  const from: string = body.from ?? addDays(to, -((body.days ?? 3) - 1));
  const wanted: string[] = body.platforms ?? Object.keys(PLATFORMS);

  const { data: run } = await supabase
    .from("ad_sync_runs")
    .insert({ date_from: from, date_to: to })
    .select("id")
    .single();

  const now = new Date().toISOString();
  const details: Record<string, unknown> = {};
  let total = 0;

  for (const [name, platform] of Object.entries(PLATFORMS)) {
    if (!wanted.includes(name)) continue;
    if (!platform.configured()) {
      details[name] = "skipped: secrets not set";
      continue;
    }
    try {
      const rows = await platform.sync(from, to, now);
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase
          .from("ad_performance_daily")
          .upsert(rows.slice(i, i + 500), { onConflict: "platform,account_id,campaign_id,date" });
        if (error) throw new Error(error.message);
      }
      details[name] = { rows: rows.length };
      total += rows.length;
    } catch (e) {
      details[name] = { error: String(e instanceof Error ? e.message : e) };
    }
  }

  const failed = Object.values(details).some((d) => typeof d === "object" && d && "error" in d);
  const status = failed ? "error" : "ok";
  if (run) {
    await supabase
      .from("ad_sync_runs")
      .update({ finished_at: new Date().toISOString(), status, rows_upserted: total, details })
      .eq("id", run.id);
  }

  return Response.json({ status, from, to, rows: total, details }, { status: failed ? 500 : 200 });
});
