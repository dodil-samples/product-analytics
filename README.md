# Product Analytics (Deno/TS) — Mixpanel-style analytics on Ignite + K3

An event-analytics backend where **K3 is the entire datastore** and **Ignite** is the
compute. One Deno function, action-routed. Every metric — funnel, retention, DAU,
breakdown — is a **SQL query over the K3 warehouse**; no separate analytics DB.

- **Warehouse (SQL tables):** `events` (**partitioned by `day`** so range scans prune)
  and `users`. Merge-keyed, so re-ingest is idempotent.
- **Objects (S3):** every ingested batch is archived to `raw/{day}/{batch}.jsonl` —
  durable and re-processable (recompute metrics from source when logic changes).
- **Vector:** an event `catalog` collection embeds event names + descriptions for
  semantic "which events relate to checkout?" discovery.
- **Models (optional):** embeddings for the catalog; `kimi-k2.6` can narrate results.

## Architecture

```
invoke ──► main.ts  ─► start(handle)              (Deno "ignite" SDK entrypoint)
             lib/handler.ts   router on `action`
               ├─ lib/auth.ts     service account ─► bearer (OIDC client_credentials)
               ├─ lib/k3.ts       objects · tables (_execute/insert) · vector — fetch only
               ├─ lib/models.ts   /v1/embeddings · /v1/chat/completions
               └─ lib/bootstrap.ts idempotent bucket + events/users tables + catalog
```

Everything in `lib/` uses only web-standard `fetch`, so the logic runs under plain
`deno run` (see `smoke.ts`); `main.ts` is the only file that needs the platform SDK.

## Public vs private backend

The app is meant to be deployed with **anonymous invocation enabled** so its public
FQDN can be called with no Dodil credentials — a website snippet, a CRM, or an email
tracking pixel just `POST`s to it (see [`web/`](web/)). An in-app **gate**
([`lib/gate.ts`](lib/gate.ts)) is therefore the trust boundary and splits actions
into two tiers:

- **PUBLIC** (anon-safe): `track`, `track_batch`, `identify`, `catalog_search`,
  `public_overview`. Optionally gated by a non-secret **project key** you embed in
  the page/pixel.
- **PRIVATE** (admin key): the raw reports + `export` + key management. Gated by an
  **admin key**.

Keys are provided in two ways, merged — env (`PUBLIC_KEYS` / `ADMIN_KEYS`,
comma-separated, provisioned by the IAM-authenticated operator at deploy) and the
`api_keys` table managed at runtime via `create_key` / `list_keys` / `revoke_key`
(the "user management" bullet). Keys travel in the request **body** (`key` field),
because the anon FQDN's CORS preflight only allows the `content-type` header.
**Graceful default:** a tier with no key configured (env + table both empty) is
open, so `deno task smoke` / `dodil ignite invoke` keep working unchanged — set a
key to lock a tier down.

## Actions

| action | tier | payload | does |
|---|---|---|---|
| `track` | 🟢 public | name, user_id/anon_id, props, ts? | ingest one event (+ upsert user, + archive) |
| `track_batch` | 🟢 public | events: [...] | bulk ingest a batch |
| `identify` | 🟢 public | user_id, traits, plan?, country? | upsert user profile |
| `catalog_search` | 🟢 public | query, top_k? | semantic search over the event catalog |
| `public_overview` | 🟢 public | days?, limit? | aggregate KPIs for a public dashboard (no PII): totals, DAU, top events, optional funnel |
| `funnel` | 🔒 admin | steps: [names], from?, to? | ordered-step conversion (users per step) |
| `retention` | 🔒 admin | offsets?: [0,1,7] | cohort retention matrix by first-seen day |
| `active_users` | 🔒 admin | limit? | DAU (distinct users per day) |
| `top_events` | 🔒 admin | from?/to?/limit? | event volume + unique users |
| `breakdown` | 🔒 admin | event, property | group an event by a JSON property |
| `register_event` | 🔒 admin | name, description | add + embed an event into the catalog |
| `export` | 🔒 admin | report, … | render a report as CSV |
| `create_key` / `list_keys` / `revoke_key` | 🔒 admin | kind?, label? / — / revoke | manage project + admin keys |

## Deploy

```bash
SA=$(dodil auth service-account create product-analytics-sa -o json)
SA_ID=$(echo "$SA" | jq -r '.data.id // .id')
SA_SECRET=$(echo "$SA" | jq -r '.data.secret // .secret')
dodil auth service-account grant-role "$SA_ID" k3-authorization-service k3.admin

dodil ignite app deploy product-analytics --code ./product-analytics --runtime deno --tier small \
  --allow-unauthenticated \
  --env DODIL_SA_ID="$SA_ID" --env DODIL_SA_SECRET="$SA_SECRET" \
  --env ADMIN_KEYS="ak_choose_a_secret" --env PUBLIC_KEYS="pk_site_widget" \
  --env PUBLIC_FUNNEL="signup,activated,checkout_completed"
```

`--allow-unauthenticated` makes the public FQDN anonymously invokable (CORS-open) so
the static [dashboard](web/) and the email pixel can call it with no credentials.
**Set `ADMIN_KEYS` whenever you enable anonymous access** — otherwise the private
reports are open to anyone. The dashboard lives in [`web/`](web/).

## Invoke

```bash
dodil ignite invoke product-analytics --payload '{"action":"track","name":"checkout_completed","user_id":"u_42","props":{"amount":129,"currency":"USD","plan":"pro"}}'

dodil ignite invoke product-analytics --payload '{"action":"funnel","steps":["signup","activated","checkout_completed"]}'

dodil ignite invoke product-analytics --payload '{"action":"retention","offsets":[0,1,7]}'

dodil ignite invoke product-analytics --payload '{"action":"breakdown","event":"checkout_completed","property":"plan"}'
```

## Verified live (`smoke.ts`)
Against a real K3 bucket with a controlled 5-user dataset:
- **funnel** `signup → activated → checkout` = **5 → 3 → 3** (respects step ordering).
- **retention** cohort `2026-07-01` size 3, day-1 = 1; `2026-07-02` size 2, day-1 = 0.
- **active_users** DAU per day; **breakdown by plan** = pro 2 / free 1 (via
  `json_extract_string(props_json,'$.plan')`); **top_events** volume + unique users.

Run it yourself: extract a token into `SMOKE_TOKEN`/`SMOKE_ORG_ID`/`SMOKE_ORG_NAME`,
set `ANALYTICS_BUCKET=smoke-xyz`, then `deno task smoke`.

## Notes
- **Funnel/retention JOIN over fresh writes:** the app `compact`s `events` before those
  queries so the self-/multi-table JOINs see just-tracked rows (fresh inserts sit in
  the write-log until compacted). Single-table metrics (DAU, top_events, breakdown)
  read `FRESHNESS_STRONG` and need no compact.
- Vector `catalog_search` degrades to `[]` if the embedder is unavailable; the
  warehouse is unaffected.
