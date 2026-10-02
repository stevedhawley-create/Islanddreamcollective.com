// ad-manage: lets Claude make changes to Meta ads that Steve has approved.
// Every change is previewed first; nothing is applied unless the request
// carries "confirm": true. Each applied change is logged in public.ad_change_log.
//
// Called with `select public.ad_manage('{...}'::jsonb);` and the response read
// from net._http_response. Request bodies:
//   { "action": "list" }                                   campaigns + ad sets with status and budgets
//   { "action": "pause",    "id": "<campaign or ad set id>" }
//   { "action": "activate", "id": "<campaign or ad set id>" }
//   { "action": "set_daily_budget", "id": "<id>", "daily_budget": 150000 }
//       daily_budget is in the account's currency as Meta stores it
//       (whole rupiah for IDR accounts; cents for AUD accounts)
//   { "action": "set_placements", "id": "<ad set id>", "publisher_platforms": ["facebook"] }
//       where an ad set's ads show: any of facebook, instagram, messenger,
//       audience_network, threads. Positions on dropped platforms are removed.
//   add "confirm": true to apply; without it the change is only previewed.
//
// Secrets: META_ACCESS_TOKEN (needs ads_management), META_AD_ACCOUNT_IDS,
// META_API_VERSION (optional). Only objects in those ad accounts can be changed.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const META_API_VERSION = Deno.env.get("META_API_VERSION") ?? "v23.0";
const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const token = () => Deno.env.get("META_ACCESS_TOKEN")?.trim() ?? "";
const accounts = () =>
  (Deno.env.get("META_AD_ACCOUNT_IDS") ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^act_/, ""))
    .filter(Boolean);

async function graph(path: string, params: Record<string, string> = {}, method = "GET") {
  const url = new URL(`${GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token() });
  const res = method === "GET"
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

const FIELDS = "id,name,status,effective_status,daily_budget,lifetime_budget";

async function list() {
  const out = [];
  for (const acct of accounts()) {
    const info = await graph(`act_${acct}`, { fields: "name,currency" });
    const campaigns = await graph(`act_${acct}/campaigns`, { fields: FIELDS, limit: "200" });
    const adsets = await graph(`act_${acct}/adsets`, { fields: FIELDS + ",campaign_id", limit: "200" });
    out.push({
      account_id: acct,
      account_name: info.name,
      currency: info.currency,
      campaigns: campaigns.data,
      ad_sets: adsets.data,
    });
  }
  return out;
}

// Returns the object's current state, and refuses anything outside our ad accounts.
async function current(id: string) {
  const obj = await graph(id, { fields: FIELDS + ",account_id" });
  if (!accounts().includes(String(obj.account_id))) {
    throw new Error(`Object ${id} is not in an allowed ad account`);
  }
  return obj;
}

const PLATFORMS = ["facebook", "instagram", "messenger", "audience_network", "threads"];
const POSITION_KEYS: Record<string, string> = {
  facebook: "facebook_positions", instagram: "instagram_positions", messenger: "messenger_positions",
  audience_network: "audience_network_positions", threads: "threads_positions",
};

// Changes which platforms an ad set's ads show on. Meta needs the whole
// targeting object back, so the current one is read, edited and resent.
async function setPlacements(body: Record<string, unknown>) {
  if (!body.id) throw new Error("id is required");
  const wanted = Array.isArray(body.publisher_platforms) ? body.publisher_platforms.map(String) : [];
  if (!wanted.length || wanted.some((p) => !PLATFORMS.includes(p))) {
    throw new Error("publisher_platforms must list one or more of: " + PLATFORMS.join(", "));
  }
  const id = String(body.id);
  const obj = await graph(id, { fields: "id,name,account_id,targeting" });
  if (!accounts().includes(String(obj.account_id))) throw new Error(`Object ${id} is not in an allowed ad account`);
  if (!obj.targeting) throw new Error("This object has no targeting (placements are set on an ad set)");
  const before = obj.targeting;
  const after: Record<string, unknown> = { ...before, publisher_platforms: wanted };
  for (const p of PLATFORMS) if (!wanted.includes(p)) delete after[POSITION_KEYS[p]];
  const summary = (t: Record<string, unknown>) => ({
    publisher_platforms: t.publisher_platforms ?? "automatic (all)",
    ...Object.fromEntries(Object.values(POSITION_KEYS).filter((k) => t[k]).map((k) => [k, t[k]])),
  });
  if (body.confirm !== true) {
    return Response.json({ ok: true, preview: true, id, name: obj.name, before: summary(before), after: summary(after) });
  }
  await graph(id, { targeting: JSON.stringify(after) }, "POST");
  const now = await graph(id, { fields: "targeting" });
  await supabase.from("ad_change_log").insert({
    platform: "meta", object_id: id, object_name: obj.name, action: "set_placements",
    before: summary(before), after: summary(now.targeting ?? {}), note: (body.note as string) ?? null,
  });
  return Response.json({ ok: true, applied: true, id, name: obj.name, before: summary(before), after: summary(now.targeting ?? {}) });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const secret = req.headers.get("x-sync-secret") ?? "";
  const { data: ok } = await supabase.rpc("ad_sync_check_secret", { p_secret: secret });
  if (!ok) return new Response("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({}));
  try {
    if (!token() || accounts().length === 0) throw new Error("META secrets not set");

    if (body.action === "list") return Response.json({ ok: true, accounts: await list() });

    if (body.action === "set_placements") return await setPlacements(body);

    if (!["pause", "activate", "set_daily_budget"].includes(body.action)) {
      throw new Error(`Unknown action: ${body.action}`);
    }
    if (!body.id) throw new Error("id is required");

    const before = await current(String(body.id));
    const change: Record<string, string> = {};
    if (body.action === "pause") change.status = "PAUSED";
    if (body.action === "activate") change.status = "ACTIVE";
    if (body.action === "set_daily_budget") {
      const amount = Number(body.daily_budget);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error("daily_budget must be a positive number");
      if (!before.daily_budget) throw new Error("This object has no daily budget (budget may be set at campaign or ad set level)");
      change.daily_budget = String(Math.round(amount));
    }

    if (body.confirm !== true) {
      return Response.json({ ok: true, preview: true, id: body.id, name: before.name, before, change });
    }

    await graph(String(body.id), change, "POST");
    const after = await current(String(body.id));
    await supabase.from("ad_change_log").insert({
      platform: "meta",
      object_id: String(body.id),
      object_name: before.name,
      action: body.action,
      before,
      after,
      note: body.note ?? null,
    });
    return Response.json({ ok: true, applied: true, id: body.id, name: before.name, before, after });
  } catch (e) {
    return Response.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, { status: 400 });
  }
});
