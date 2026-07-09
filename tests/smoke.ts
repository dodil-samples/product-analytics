// Live smoke test: drive the analytics router against a throwaway K3 bucket.
// Run via run_smoke.sh (which injects SMOKE_TOKEN/ORG + ANALYTICS_BUCKET from config).
import { _setToken } from "../lib/auth.ts";
import { handle } from "../handler.ts";

_setToken(
  Deno.env.get("SMOKE_TOKEN")!,
  Deno.env.get("SMOKE_ORG_ID")!,
  Deno.env.get("SMOKE_ORG_NAME")!,
);

const enc = new TextEncoder();
async function run(label: string, payload: unknown) {
  const out = await handle(enc.encode(JSON.stringify(payload)), {});
  console.log(`\n### ${label}\n${out.slice(0, 900)}`);
  return JSON.parse(out);
}

// A controlled funnel dataset: signup -> activated -> checkout_completed
const ev = (user: string, name: string, ts: string, props: Record<string, unknown> = {}) =>
  ({ name, user_id: user, ts, props, country: "US" });
const events = [
  ev("u1", "signup", "2026-07-01T10:00:00Z"),
  ev("u1", "activated", "2026-07-01T10:05:00Z"),
  ev("u1", "checkout_completed", "2026-07-01T10:10:00Z", { plan: "pro", amount: 129 }),
  ev("u1", "session_start", "2026-07-02T09:00:00Z"), // day-1 retention for cohort 07-01
  ev("u2", "signup", "2026-07-01T11:00:00Z"),
  ev("u2", "activated", "2026-07-01T11:05:00Z"),
  ev("u3", "signup", "2026-07-01T12:00:00Z"),
  ev("u4", "signup", "2026-07-02T09:00:00Z"),
  ev("u4", "activated", "2026-07-02T09:05:00Z"),
  ev("u4", "checkout_completed", "2026-07-02T09:10:00Z", { plan: "free", amount: 0 }),
  ev("u5", "signup", "2026-07-02T13:00:00Z"),
];

await run("track_batch (11 events)", { action: "track_batch", events });
await run("track (single)", { action: "track", name: "checkout_completed", user_id: "u2", props: { plan: "pro", amount: 59 } });
await run("identify", { action: "identify", user_id: "u1", traits: { email: "a@x.io" }, plan: "pro", country: "US" });
await run("funnel", { action: "funnel", steps: ["signup", "activated", "checkout_completed"] });
await run("active_users", { action: "active_users" });
await run("top_events", { action: "top_events" });
await run("breakdown by plan", { action: "breakdown", event: "checkout_completed", property: "plan" });
await run("retention", { action: "retention", offsets: [0, 1] });
await run("catalog_search (vector; may be empty)", { action: "catalog_search", query: "checkout revenue" });

// --- public/private gate (lib/gate.ts) -------------------------------------
// With no keys configured (env + api_keys table empty) every tier is open, so
// the calls above all ran unkeyed. Now create an admin key: once one exists the
// PRIVATE tier is "configured" and unkeyed private calls must start failing.
await run("public_overview (PUBLIC, no key)", { action: "public_overview" });
const created = await run("create_key admin (open until the first admin key exists)", {
  action: "create_key", kind: "admin", label: "smoke",
});
const adminKey = created?.result?.key as string | undefined;

const denied = await run("top_events WITHOUT key (expect ok:false 401 now)", { action: "top_events" });
console.log(denied.ok ? "  !! GATE FAILED: private tier still open" : "  ✓ gate rejected unkeyed private call");

await run("top_events WITH admin key (expect ok:true)", { action: "top_events", key: adminKey });
await run("track (PUBLIC, still open — no public key set)", { action: "track", name: "gate_probe", user_id: "u1" });

// Revoke it (pass the key to authorize the call + name it as the revoke target),
// leaving the tier open again.
await run("revoke_key (admin)", { action: "revoke_key", key: adminKey, revoke: adminKey });
