/**
 * Ingestion — the PUBLIC write path a website / app / CRM calls: track single or
 * batched events, and identify a user with traits.
 */

import { K3 } from "../lib/k3.ts";
import { type EventIn, ingest, type Json, nowIso, sqlStr } from "./common.ts";

export async function track(k3: K3, p: Json): Promise<Json> {
  const n = await ingest(k3, [p as EventIn]);
  return { ingested: n };
}

export async function trackBatch(k3: K3, p: Json): Promise<Json> {
  const n = await ingest(k3, (p.events ?? []) as EventIn[]);
  return { ingested: n };
}

export async function identify(k3: K3, p: Json): Promise<Json> {
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
