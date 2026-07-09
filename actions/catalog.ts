/**
 * Event catalog — a semantically-searchable dictionary of the events you send.
 * register_event (PRIVATE) writes a catalog doc + kicks embedding; catalog_search
 * (PUBLIC) does the vector lookup.
 */

import { K3 } from "../lib/k3.ts";
import { type Json, slug } from "./common.ts";

export async function registerEvent(k3: K3, p: Json): Promise<Json> {
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

export async function catalogSearch(k3: K3, p: Json): Promise<Json> {
  return { query: p.query ?? "", results: await k3.vectorSearch(p.query ?? "", Number(p.top_k ?? 5)) };
}
