// web-sync: pulls daily website stats from Google Analytics 4 and Google Search
// Console into public.ga4_daily and public.search_console_daily. Triggered by
// pg_cron (see the web_sync migration) or manually with
// `select public.web_sync_trigger();`.
//
// Request body (all optional):
//   { "days": 5 }                                -> last N full days (default 5)
//   { "from": "2025-01-01", "to": "2025-03-31" } -> explicit window (backfill)
//   { "sources": ["ga4"] }                       -> limit to "ga4" or "search_console"
//
// Secrets (Supabase dashboard -> Edge Functions -> Secrets):
//   GOOGLE_SERVICE_ACCOUNT_JSON  the service account's JSON key file, pasted whole
//   GA4_PROPERTIES   optional, "id:name,id:name" (defaults below)
//   GSC_SITES        optional, comma-separated Search Console site URLs (defaults below)
// The service account's email must be added as a Viewer in each GA4 property and
// as a Restricted user in each Search Console property.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const DEFAULT_GA4_PROPERTIES =
  "541593723:BVB Website,543472930:Island Dream Collective Website,552472225:hostOPZ";
const DEFAULT_GSC_SITES =
  "https://www.balivillabookings.com/,https://www.islanddreamcollective.com/";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
].join(" ");

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

function env(name: string): string | undefined {
  const v = Deno.env.get(name)?.trim();
  return v ? v : undefined;
}

function list(name: string, fallback: string): string[] {
  return (env(name) ?? fallback).split(",").map((s) => s.trim()).filter(Boolean);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

// ---------- Google service-account auth (JWT bearer flow) ----------

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function googleAccessToken(): Promise<string> {
  const key = JSON.parse(env("GOOGLE_SERVICE_ACCOUNT_JSON")!);
  const pem = String(key.private_key)
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." +
    b64url(JSON.stringify({
      iss: key.client_email,
      scope: SCOPES,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }));
  const sig = new Uint8Array(
    await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(unsigned)),
  );

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${b64url(sig)}`,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Google auth: ${json.error_description ?? json.error ?? res.status}`);
  return json.access_token;
}

async function upsert(table: string, rows: Record<string, unknown>[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(error.message);
  }
}

// ---------- GA4 ----------

async function syncGa4(token: string, from: string, to: string, now: string) {
  const out: Record<string, unknown> = {};
  for (const entry of list("GA4_PROPERTIES", DEFAULT_GA4_PROPERTIES)) {
    const [id, ...nameParts] = entry.split(":");
    const name = nameParts.join(":") || id;
    try {
      const res = await fetch(
        `https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            dateRanges: [{ startDate: from, endDate: to }],
            dimensions: [{ name: "date" }, { name: "sessionSourceMedium" }],
            metrics: [
              { name: "sessions" },
              { name: "activeUsers" },
              { name: "engagedSessions" },
              { name: "averageSessionDuration" },
            ],
            limit: 100000,
          }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);

      const rows = (json.rows ?? []).map((r: any) => {
        const d = r.dimensionValues[0].value as string; // YYYYMMDD
        const m = r.metricValues.map((v: any) => Number(v.value));
        return {
          property_id: id,
          property_name: name,
          date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`,
          source_medium: r.dimensionValues[1].value || "(not set)",
          sessions: Math.round(m[0]),
          active_users: Math.round(m[1]),
          engaged_sessions: Math.round(m[2]),
          avg_session_duration_s: Math.round(m[3] * 100) / 100,
          source: "ga4_api",
          synced_at: now,
        };
      });
      await upsert("ga4_daily", rows, "property_id,date,source_medium");
      out[name] = { rows: rows.length };
    } catch (e) {
      out[name] = { error: String(e instanceof Error ? e.message : e) };
    }
  }
  return out;
}

// ---------- Search Console ----------

async function gscQuery(token: string, site: string, body: unknown) {
  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json.rows ?? [];
}

async function syncSearchConsole(token: string, from: string, to: string, now: string) {
  const out: Record<string, unknown> = {};
  for (const site of list("GSC_SITES", DEFAULT_GSC_SITES)) {
    try {
      let total = 0;
      for (const dimension of ["query", "page"]) {
        const rows: Record<string, unknown>[] = [];
        for (let startRow = 0; ; startRow += 25000) {
          const batch = await gscQuery(token, site, {
            startDate: from,
            endDate: to,
            dimensions: ["date", dimension],
            rowLimit: 25000,
            startRow,
          });
          for (const r of batch) {
            rows.push({
              site,
              date: r.keys[0],
              dimension,
              key: r.keys[1],
              clicks: r.clicks,
              impressions: r.impressions,
              ctr: r.ctr,
              position: r.position,
              synced_at: now,
            });
          }
          if (batch.length < 25000) break;
        }
        await upsert("search_console_daily", rows, "site,date,dimension,key");
        total += rows.length;
      }
      out[site] = { rows: total };
    } catch (e) {
      out[site] = { error: String(e instanceof Error ? e.message : e) };
    }
  }
  return out;
}

// ---------- Handler ----------

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // Shares the ad-sync header secret so both syncs use one vault entry.
  const secret = req.headers.get("x-sync-secret") ?? "";
  const { data: ok } = await supabase.rpc("ad_sync_check_secret", { p_secret: secret });
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  const yesterday = addDays(isoDate(new Date()), -1);
  const to: string = body.to ?? yesterday;
  const from: string = body.from ?? addDays(to, -((body.days ?? 5) - 1));
  const wanted: string[] = body.sources ?? ["ga4", "search_console"];

  const { data: run } = await supabase
    .from("web_sync_runs")
    .insert({ date_from: from, date_to: to })
    .select("id")
    .single();

  const now = new Date().toISOString();
  const details: Record<string, unknown> = {};

  if (!env("GOOGLE_SERVICE_ACCOUNT_JSON")) {
    details.google = "skipped: GOOGLE_SERVICE_ACCOUNT_JSON not set";
  } else {
    try {
      const token = await googleAccessToken();
      if (wanted.includes("ga4")) details.ga4 = await syncGa4(token, from, to, now);
      if (wanted.includes("search_console")) {
        details.search_console = await syncSearchConsole(token, from, to, now);
      }
    } catch (e) {
      details.google = { error: String(e instanceof Error ? e.message : e) };
    }
  }

  const failed = JSON.stringify(details).includes('"error"');
  const status = failed ? "error" : "ok";
  if (run) {
    await supabase
      .from("web_sync_runs")
      .update({ finished_at: new Date().toISOString(), status, details })
      .eq("id", run.id);
  }

  return Response.json({ status, from, to, details }, { status: failed ? 500 : 200 });
});
