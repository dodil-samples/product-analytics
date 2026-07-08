/**
 * Product Analytics — one Ignite (Deno/TS) function, action-routed.
 *
 * A Mixpanel/Amplitude-style backend where K3 is the whole store: events + users in
 * the SQL warehouse (events partitioned by day), raw batches archived as objects, and
 * an event catalog in the vector pillar. Every metric is a SQL query.
 *
 * Invoke with an `action`, e.g.
 *   { "action": "track", "name": "checkout_completed", "user_id": "u_1", "props": {"amount": 129} }
 *   { "action": "funnel", "steps": ["signup","activated","checkout_completed"] }
 *   { "action": "active_users" }
 */

import { K3, K3Error } from "./k3.ts";
import * as bootstrap from "./bootstrap.ts";
import * as gate from "./gate.ts";
import { monotonicUlid } from "@std/ulid";
import { stringify as csvStringify } from "@std/csv";
import { retry } from "@std/async";
import { sumOf } from "@std/collections";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

// --------------------------------------------------------------------------- utils
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
const dayOf = (iso: string) => iso.slice(0, 10);
// Time-sortable event IDs via a monotonic ULID: lexical order == arrival order,
// so "latest N" and range scans work off the id alone, and ids minted in the same
// millisecond still sort deterministically. Beats a random UUID slice for an event log.
const uid = () => "ev_" + monotonicUlid();
const slug = (s: string) => (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event").slice(0, 48);
const sqlStr = (v: unknown) => "'" + String(v).replace(/'/g, "''") + "'";
const inList = (xs: string[]) => xs.map(sqlStr).join(", ");

interface EventIn {
  name: string;
  user_id?: string;
  anon_id?: string;
  session_id?: string;
  ts?: string;
  props?: Json;
  device?: string;
  os?: string;
  country?: string;
  app_version?: string;
}

function normalizeEvent(e: EventIn): Json {
  const ts = e.ts ?? nowIso();
  return {
    event_id: uid(),
    name: e.name,
    user_id: e.user_id ?? "",
    anon_id: e.anon_id ?? "",
    session_id: e.session_id ?? "",
    ts,
    day: dayOf(ts),
    props_json: JSON.stringify(e.props ?? {}),
    device: e.device ?? "",
    os: e.os ?? "",
    country: e.country ?? "",
    app_version: e.app_version ?? "",
  };
}

async function ingest(k3: K3, events: EventIn[]): Promise<number> {
  const rows = events.filter((e) => e.name).map(normalizeEvent);
  if (rows.length === 0) return 0;
  // The events insert is the one write we can't lose — retry transient K3 blips
  // with exponential backoff (bounded, so it still fits the function timeout).
  await retry(() => k3.insert("events", rows), {
    maxAttempts: 3,
    minTimeout: 200,
    maxTimeout: 1500,
    multiplier: 2,
  });
  // Upsert user first_seen/last_seen for identified users.
  const byUser = new Map<string, string>(); // user_id -> max ts
  for (const r of rows) {
    if (r.user_id) {
      const prev = byUser.get(r.user_id);
      if (!prev || r.ts > prev) byUser.set(r.user_id, r.ts as string);
    }
  }
  for (const [userId, ts] of byUser) {
    // first_seen only set if new (COALESCE on read); we upsert last_seen and let a
    // later identify fill traits. Keep it simple: upsert both, first_seen via SQL min later.
    await k3.upsert("users", [{ user_id: userId, first_seen: ts, last_seen: ts, traits_json: "{}", country: "", plan: "" }]);
    await k3.execute(
      `UPDATE users SET last_seen=${sqlStr(ts)}, ` +
        `first_seen=CASE WHEN first_seen='' OR first_seen IS NULL OR first_seen>${sqlStr(ts)} THEN ${sqlStr(ts)} ELSE first_seen END ` +
        `WHERE user_id=${sqlStr(userId)}`,
    );
  }
  // Archive the raw batch as a durable, re-processable object.
  const batchId = crypto.randomUUID().slice(0, 8);
  const day = rows[0].day;
  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  try {
    await k3.putObject(`raw/${day}/${batchId}.jsonl`, jsonl, "application/x-ndjson");
  } catch { /* archive is best-effort */ }
  return rows.length;
}

// ------------------------------------------------------------------------- actions
async function track(k3: K3, p: Json): Promise<Json> {
  const n = await ingest(k3, [p as EventIn]);
  return { ingested: n };
}

async function trackBatch(k3: K3, p: Json): Promise<Json> {
  const n = await ingest(k3, (p.events ?? []) as EventIn[]);
  return { ingested: n };
}

async function identify(k3: K3, p: Json): Promise<Json> {
  const now = nowIso();
  await k3.upsert("users", [{
    user_id: p.user_id,
    first_seen: now,
    last_seen: now,
    traits_json: JSON.stringify(p.traits ?? {}),
    country: p.country ?? "",
    plan: p.plan ?? "",
  }]);
  // Overwrite traits/plan/country without clobbering first/last seen if present.
  await k3.execute(
    `UPDATE users SET traits_json=${sqlStr(JSON.stringify(p.traits ?? {}))}` +
      (p.plan ? `, plan=${sqlStr(p.plan)}` : "") +
      (p.country ? `, country=${sqlStr(p.country)}` : "") +
      ` WHERE user_id=${sqlStr(p.user_id)}`,
  );
  return { user_id: p.user_id };
}

async function funnel(k3: K3, p: Json): Promise<Json> {
  const steps: string[] = p.steps ?? [];
  if (steps.length < 2) return { error: "funnel needs >= 2 steps" };
  await k3.compact("events"); // self-JOIN needs WAL flushed to Delta
  const dateClause = p.from && p.to ? ` AND ts BETWEEN ${sqlStr(p.from)} AND ${sqlStr(p.to)}` : "";
  const firsts = `WITH firsts AS (SELECT user_id, name, MIN(ts) AS t FROM events ` +
    `WHERE user_id <> '' AND name IN (${inList(steps)})${dateClause} GROUP BY user_id, name)`;
  const joins = steps.map((s, i) =>
    i === 0
      ? `LEFT JOIN firsts f0 ON f0.user_id=u.user_id AND f0.name=${sqlStr(s)}`
      : `LEFT JOIN firsts f${i} ON f${i}.user_id=u.user_id AND f${i}.name=${sqlStr(s)} AND f${i}.t >= f${i - 1}.t`
  ).join("\n");
  const counts = steps.map((_, i) => `COUNT(f${i}.user_id) AS step${i}`).join(", ");
  const sql = `${firsts}\nSELECT ${counts}\nFROM (SELECT DISTINCT user_id FROM firsts WHERE name=${sqlStr(steps[0])}) u\n${joins}`;
  const row = (await k3.execute(sql))[0] ?? {};
  const out = steps.map((name, i) => {
    const count = Number(row[`step${i}`] ?? 0);
    const top = Number(row["step0"] ?? 0) || 1;
    return { step: name, users: count, conversion_from_start: +(count / top).toFixed(3) };
  });
  return { steps: out };
}

async function retention(k3: K3, p: Json): Promise<Json> {
  await k3.compact("events");
  const offsets: number[] = p.offsets ?? [0, 1, 7];
  const cases = offsets.map((k) =>
    `COUNT(DISTINCT CASE WHEN CAST(act.d AS DATE) = CAST(fs.cohort AS DATE) + ${k} THEN act.user_id END) AS d${k}`
  ).join(",\n  ");
  const sql =
    `WITH fs AS (SELECT user_id, MIN(substr(ts,1,10)) AS cohort FROM events WHERE user_id <> '' GROUP BY user_id),\n` +
    `act AS (SELECT DISTINCT user_id, substr(ts,1,10) AS d FROM events WHERE user_id <> '')\n` +
    `SELECT fs.cohort, COUNT(DISTINCT fs.user_id) AS cohort_size,\n  ${cases}\n` +
    `FROM fs JOIN act ON act.user_id = fs.user_id GROUP BY fs.cohort ORDER BY fs.cohort`;
  return { offsets, cohorts: await k3.execute(sql) };
}

async function activeUsers(k3: K3, p: Json): Promise<Json> {
  const limit = Number(p.limit ?? 30);
  const rows = await k3.execute(
    `SELECT substr(ts,1,10) AS day, COUNT(DISTINCT COALESCE(NULLIF(user_id,''), anon_id)) AS active ` +
      `FROM events GROUP BY 1 ORDER BY 1 DESC LIMIT ${limit}`,
  );
  return { daily_active: rows };
}

async function topEvents(k3: K3, p: Json): Promise<Json> {
  const limit = Number(p.limit ?? 20);
  const where = p.from && p.to ? `WHERE ts BETWEEN ${sqlStr(p.from)} AND ${sqlStr(p.to)}` : "";
  const rows = await k3.execute(
    `SELECT name, COUNT(*) AS events, COUNT(DISTINCT user_id) AS users ` +
      `FROM events ${where} GROUP BY name ORDER BY events DESC LIMIT ${limit}`,
  );
  return { top_events: rows };
}

async function breakdown(k3: K3, p: Json): Promise<Json> {
  const prop = String(p.property);
  const rows = await k3.execute(
    `SELECT json_extract_string(props_json, '$.${prop}') AS value, COUNT(*) AS events, ` +
      `COUNT(DISTINCT user_id) AS users FROM events WHERE name=${sqlStr(p.event)} ` +
      `GROUP BY value ORDER BY events DESC LIMIT ${Number(p.limit ?? 25)}`,
  );
  return { event: p.event, property: prop, breakdown: rows };
}

async function registerEvent(k3: K3, p: Json): Promise<Json> {
  // The catalog doc is the essential, durable write — do it first.
  const key = `catalog/${slug(p.name)}.md`;
  await k3.putObject(key, `# ${p.name}\n\n${p.description ?? ""}`, "text/markdown");
  // Kicking ingest is best-effort and must never block the response: cap the whole
  // trigger under a cancelling budget so a stuck source/VBase can't hang the request.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("ingest trigger budget", "TimeoutError")), 15000);
  try {
    await k3.triggerIngest(ctrl.signal);
  } catch { /* best-effort */ } finally {
    clearTimeout(timer);
  }
  return { catalog_key: key, note: "K3 is embedding it for semantic catalog search." };
}

async function catalogSearch(k3: K3, p: Json): Promise<Json> {
  return { query: p.query ?? "", results: await k3.vectorSearch(p.query ?? "", Number(p.top_k ?? 5)) };
}

// Run any report and return it as RFC-4180 CSV (@std/csv) ready to pipe into a
// spreadsheet/BI tool — the export button every analytics product ships.
async function exportReport(k3: K3, p: Json): Promise<Json> {
  const report = String(p.report ?? "top_events");
  const runners: Record<string, () => Promise<Record<string, unknown>[]>> = {
    top_events: async () => (await topEvents(k3, p)).top_events ?? [],
    active_users: async () => (await activeUsers(k3, p)).daily_active ?? [],
    breakdown: async () => (await breakdown(k3, p)).breakdown ?? [],
    funnel: async () => (await funnel(k3, p)).steps ?? [],
    retention: async () => (await retention(k3, p)).cohorts ?? [],
  };
  const run = runners[report];
  if (!run) return { error: `unknown report '${report}'`, reports: Object.keys(runners) };
  const rows = await run();
  const columns = rows.length ? Object.keys(rows[0]) : [];
  const csv = rows.length ? csvStringify(rows, { columns, headers: true }) : "";
  // A single numeric-total convenience via @std/collections, when the report has a count column.
  const countCol = columns.find((c) => c === "events" || c === "users" || c === "active" || c === "n");
  const total = countCol ? sumOf(rows, (r) => Number(r[countCol] ?? 0)) : undefined;
  return { report, format: "csv", row_count: rows.length, columns, total, csv };
}

// PUBLIC, anon-safe rollup for the dashboard's default view: aggregate KPIs only
// — totals, DAU sparkline, top events — no raw user rows or per-user detail. An
// optional headline funnel is exposed via the PUBLIC_FUNNEL env (comma-separated
// step names) so a public status page can show conversion without allowing
// arbitrary funnel queries.
async function publicOverview(k3: K3, p: Json): Promise<Json> {
  const days = Math.min(Number(p.days ?? 14), 90);
  const today = dayOf(nowIso());
  const [totalsRow] = await k3.execute(
    `SELECT COUNT(*) AS events, COUNT(DISTINCT COALESCE(NULLIF(user_id,''), anon_id)) AS users, ` +
      `COUNT(DISTINCT name) AS event_types FROM events`,
  );
  const [todayRow] = await k3.execute(
    `SELECT COUNT(*) AS events FROM events WHERE substr(ts,1,10)=${sqlStr(today)}`,
  );
  const dau = (await activeUsers(k3, { limit: days })).daily_active ?? [];
  const top = (await topEvents(k3, { limit: Number(p.limit ?? 8) })).top_events ?? [];
  const out: Json = {
    totals: {
      events: Number(totalsRow?.events ?? 0),
      users: Number(totalsRow?.users ?? 0),
      event_types: Number(totalsRow?.event_types ?? 0),
      events_today: Number(todayRow?.events ?? 0),
    },
    daily_active: dau,
    top_events: top,
    updated_at: nowIso(),
  };
  const steps = (Deno.env.get("PUBLIC_FUNNEL") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (steps.length >= 2) {
    try {
      out.funnel = { steps: (await funnel(k3, { steps })).steps ?? [] };
    } catch { /* funnel is a nice-to-have on the public view */ }
  }
  return out;
}

const ACTIONS: Record<string, (k3: K3, p: Json) => Promise<Json>> = {
  // -- PUBLIC (anon-safe) --
  track,
  track_batch: trackBatch,
  identify,
  catalog_search: catalogSearch,
  public_overview: publicOverview,
  // -- PRIVATE (admin key) --
  funnel,
  retention,
  active_users: activeUsers,
  top_events: topEvents,
  breakdown,
  register_event: registerEvent,
  export: exportReport,
  create_key: gate.createKey,
  list_keys: gate.listKeys,
  revoke_key: gate.revokeKey,
};

// ------------------------------------------------------------------------- entrypoint
export async function handle(payload: Uint8Array, _ctx: unknown): Promise<string> {
  let event: Json = {};
  if (payload && payload.length > 0) {
    try {
      event = JSON.parse(new TextDecoder().decode(payload)) ?? {};
    } catch {
      return JSON.stringify({ ok: false, error: "invalid JSON payload" });
    }
  }
  const action = event.action;
  const fn = ACTIONS[action];
  if (!fn) {
    return JSON.stringify({ ok: false, error: `unknown action ${action}`, actions: Object.keys(ACTIONS) });
  }
  const timings: Record<string, number> = {};
  try {
    const t0 = Date.now();
    const k3 = await bootstrap.ensure();
    timings.bootstrap_ms = Date.now() - t0;
    // Public/private gate: PUBLIC actions are anon-safe (optionally project-keyed),
    // PRIVATE actions need an admin key. Unconfigured tiers stay open (see gate.ts).
    const decision = await gate.authorize(k3, action, event);
    if (!decision.ok) {
      return JSON.stringify({ ok: false, action, error: decision.error, code: 401 });
    }
    const t1 = Date.now();
    const result = await fn(k3, event);
    timings.action_ms = Date.now() - t1;
    return JSON.stringify({ ok: true, action, result, timings });
  } catch (e) {
    const msg = e instanceof K3Error ? `k3: ${e.message}` : `${(e as Error)?.name}: ${(e as Error)?.message}`;
    return JSON.stringify({ ok: false, action, error: msg, timings });
  }
}
