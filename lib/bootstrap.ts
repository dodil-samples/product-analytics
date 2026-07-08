/**
 * Idempotent schema + storage bootstrap for Product Analytics.
 *
 * Creates the bucket, the two warehouse tables (`events` partitioned by day,
 * `users`), and the event-catalog vector collection. Guarded so it runs once per
 * cold start; re-creating an existing table/bucket is ignored.
 */

import { col, K3, T } from "./k3.ts";

export const BUCKET = Deno.env.get("ANALYTICS_BUCKET") ?? "product-analytics";
export const CATALOG_COLLECTION = Deno.env.get("ANALYTICS_CATALOG") ?? "catalog";

const state = { base: false, vector: false };

// One row per event — the warehouse. Partitioned by `day` so range scans prune.
const EVENTS_COLUMNS = [
  col("event_id", T.STRING, false),
  col("name", T.STRING),
  col("user_id", T.STRING),
  col("anon_id", T.STRING),
  col("session_id", T.STRING),
  col("ts", T.STRING), // ISO8601
  col("day", T.STRING), // YYYY-MM-DD (partition)
  col("props_json", T.STRING),
  col("device", T.STRING),
  col("os", T.STRING),
  col("country", T.STRING),
  col("app_version", T.STRING),
];

// One row per user — identity + traits, upserted on every track/identify.
const USERS_COLUMNS = [
  col("user_id", T.STRING, false),
  col("first_seen", T.STRING),
  col("last_seen", T.STRING),
  col("traits_json", T.STRING),
  col("country", T.STRING),
  col("plan", T.STRING),
];

// One row per API key — the public/private gate's user-management store (see gate.ts).
// `kind` is public (project write key) or admin; `disabled` soft-deletes on revoke.
const API_KEYS_COLUMNS = [
  col("key", T.STRING, false),
  col("label", T.STRING),
  col("kind", T.STRING), // public | admin
  col("created_at", T.STRING),
  col("disabled", T.INT),
];

export function k3(): K3 {
  return new K3(BUCKET);
}

export async function ensure(): Promise<K3> {
  const c = k3();
  // Bucket + tables: provision once (cheap, idempotent).
  if (!state.base) {
    await c.ensureBucket("Product analytics: events, users, catalog");
    try {
      await c.createTable("events", EVENTS_COLUMNS, ["event_id"], ["day"]);
    } catch { /* already exists */ }
    try {
      await c.createTable("users", USERS_COLUMNS, ["user_id"]);
    } catch { /* already exists */ }
    try {
      await c.createTable("api_keys", API_KEYS_COLUMNS, ["key"]);
    } catch { /* already exists */ }
    state.base = true;
  }
  // Vector engine provisions asynchronously (VBase spin-up takes minutes), so
  // NEVER block the request on it: run setup under a hard, *cancelling* time budget.
  // A single AbortController is threaded into every provisioning fetch, so when the
  // budget fires all in-flight and pending calls abort at once and nothing keeps
  // running past it (a Promise.race time-box did NOT cancel the losing fetches,
  // which is what let a fresh-bucket first call blow the 120s function limit).
  if (!state.vector) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException("vector setup budget exceeded", "TimeoutError")), 30000);
    try {
      await c.ensureVector(CATALOG_COLLECTION, "text_embedding_index", ["catalog/**"], ctrl.signal);
      state.vector = await c.hasVectorCollection(ctrl.signal);
    } catch { /* slow / not ready — retry next invocation, request still succeeds */ } finally {
      clearTimeout(timer);
    }
  }
  return c;
}
