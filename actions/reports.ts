/**
 * Reports — the analytics reads. PRIVATE (admin): funnel, retention, active users,
 * top events, breakdown, and CSV export. PUBLIC: public_overview (curated
 * aggregate rollup, no raw user rows).
 */

import { K3 } from "../lib/k3.ts";
import { dayOf, inList, type Json, nowIso, sqlStr } from "./common.ts";
import { stringify as csvStringify } from "@std/csv";
import { sumOf } from "@std/collections";

export async function funnel(k3: K3, p: Json): Promise<Json> {
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

export async function retention(k3: K3, p: Json): Promise<Json> {
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

export async function activeUsers(k3: K3, p: Json): Promise<Json> {
  const limit = Number(p.limit ?? 30);
  const rows = await k3.execute(
    `SELECT substr(ts,1,10) AS day, COUNT(DISTINCT COALESCE(NULLIF(user_id,''), anon_id)) AS active ` +
      `FROM events GROUP BY 1 ORDER BY 1 DESC LIMIT ${limit}`,
  );
  return { daily_active: rows };
}

export async function topEvents(k3: K3, p: Json): Promise<Json> {
  const limit = Number(p.limit ?? 20);
  const where = p.from && p.to ? `WHERE ts BETWEEN ${sqlStr(p.from)} AND ${sqlStr(p.to)}` : "";
  const rows = await k3.execute(
    `SELECT name, COUNT(*) AS events, COUNT(DISTINCT user_id) AS users ` +
      `FROM events ${where} GROUP BY name ORDER BY events DESC LIMIT ${limit}`,
  );
  return { top_events: rows };
}

export async function breakdown(k3: K3, p: Json): Promise<Json> {
  const prop = String(p.property);
  const rows = await k3.execute(
    `SELECT json_extract_string(props_json, '$.${prop}') AS value, COUNT(*) AS events, ` +
      `COUNT(DISTINCT user_id) AS users FROM events WHERE name=${sqlStr(p.event)} ` +
      `GROUP BY value ORDER BY events DESC LIMIT ${Number(p.limit ?? 25)}`,
  );
  return { event: p.event, property: prop, breakdown: rows };
}

// Run any report and return it as RFC-4180 CSV (@std/csv) ready to pipe into a
// spreadsheet/BI tool — the export button every analytics product ships.
export async function exportReport(k3: K3, p: Json): Promise<Json> {
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
  const countCol = columns.find((c) => c === "events" || c === "users" || c === "active" || c === "n");
  const total = countCol ? sumOf(rows, (r) => Number(r[countCol] ?? 0)) : undefined;
  return { report, format: "csv", row_count: rows.length, columns, total, csv };
}

// PUBLIC, anon-safe rollup for the dashboard's default view: aggregate KPIs only
// — totals, DAU sparkline, top events — no raw user rows or per-user detail. An
// optional headline funnel is exposed via the PUBLIC_FUNNEL env (comma-separated
// step names) so a public status page can show conversion without allowing
// arbitrary funnel queries.
export async function publicOverview(k3: K3, p: Json): Promise<Json> {
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
