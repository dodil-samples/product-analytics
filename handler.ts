/**
 * Product Analytics — the Ignite (Deno) function ENTRYPOINT, action-routed.
 *
 * A Mixpanel/Amplitude-style backend where K3 is the whole store: events + users
 * in the SQL warehouse (events partitioned by day), raw batches archived as
 * objects, and an event catalog in the vector pillar. Every metric is a SQL query.
 *
 * This file is only the plumbing: parse the event, bootstrap the schema, gate the
 * action, dispatch. The product lives in actions/ (one file per domain — the
 * README actions table maps 1:1); the clients live in lib/.
 *
 * Invoke with an `action`, e.g.
 *   { "action": "track", "name": "checkout_completed", "user_id": "u_1", "props": {"amount": 129} }
 *   { "action": "funnel", "steps": ["signup","activated","checkout_completed"] }
 *   { "action": "active_users" }
 */

import { K3Error } from "./lib/k3.ts";
import * as bootstrap from "./lib/bootstrap.ts";
import * as gate from "./lib/gate.ts";
import { ACTIONS } from "./actions/mod.ts";

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

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
