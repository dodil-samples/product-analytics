/**
 * Shared helpers for the action modules: time, SQL quoting, event normalization,
 * and the ingest path.
 *
 * The rule that keeps this repo traceable: `actions/` is WHAT the product does
 * (one file per domain, mapping 1:1 to the actions table in the README), `lib/`
 * is HOW it talks to things (K3, models, the gate).
 */

import { K3 } from "../lib/k3.ts";
import { monotonicUlid } from "@std/ulid";
import { retry } from "@std/async";

// deno-lint-ignore no-explicit-any
export type Json = Record<string, any>;

export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
export const dayOf = (iso: string) => iso.slice(0, 10);
// Time-sortable event IDs via a monotonic ULID: lexical order == arrival order,
// so "latest N" and range scans work off the id alone, and ids minted in the same
// millisecond still sort deterministically. Beats a random UUID slice for an event log.
export const uid = () => "ev_" + monotonicUlid();
export const slug = (s: string) =>
  (s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "event").slice(0, 48);
export const sqlStr = (v: unknown) => "'" + String(v).replace(/'/g, "''") + "'";
export const inList = (xs: string[]) => xs.map(sqlStr).join(", ");

export interface EventIn {
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

export function normalizeEvent(e: EventIn): Json {
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

/** Durable event write: append rows, upsert user first/last seen, archive the raw batch. */
export async function ingest(k3: K3, events: EventIn[]): Promise<number> {
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
