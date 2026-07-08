# Product Analytics — dashboard (public anonymous invocation)

A **pure static** dashboard: no build, no bundler, no server required. Every call is
an anonymous `POST` straight to the app's public FQDN, which is enabled for
anonymous access and returns permissive CORS:

```
POST https://product-analytics-<org>.ignite.dodil.cloud/
content-type: application/json
{ "action": "public_overview", "days": 14 }
```

## What it shows

- **Live overview** (`public_overview`) — totals, DAU sparkline, top events, and an
  optional headline funnel. Anonymous, no credentials.
- **Send a test event** (`track`) — the public ingestion path a website snippet or a
  CRM uses. Carries the project (public) key if one is configured.
- **Admin reports** (`funnel` / `retention` / `top_events` / `active_users`) — the
  **private** path. Requires an admin key; without it the app returns `401` and you
  see the gate reject the call.

## Run it

Just open `index.html` — or serve the folder (also enables the email pixel):

```bash
node collector.mjs            # dashboard on http://localhost:8787/
# or, dashboard only:
python3 -m http.server 8787   # then open http://localhost:8787/
```

Point it at your app and (optionally) keys via **⚙ Settings**, or with query params:

```
index.html?app=https://product-analytics-<org>.ignite.dodil.cloud/&pk=pk_xxx&ak=ak_xxx
```

The defaults in `app.js` target the `cardinalai` dev deployment; change `DEFAULTS`
or use Settings for your own.

## Host it on Ignite too (BYOI)

The same folder ships a `Dockerfile` so the dashboard can run **on Ignite** as a
bring-your-own-image app with its own public URL — the `collector.mjs` static
server on `$PORT`, answering `GET /healthz` for the readiness probe:

```bash
dodil ignite app deploy product-analytics-ui --code ./web --dockerfile-path Dockerfile \
  --allow-unauthenticated --tier small \
  --env APP_URL=https://product-analytics-<org>.ignite.dodil.cloud/
```

Live example: **https://product-analytics-ui-cardinalai.ignite.dodil.cloud/**

Note the `Dockerfile` uses a **numeric** `USER 1000` (not `USER node`): Ignite runs
pods `runAsNonRoot`, and Kubernetes rejects a *named* user with
`CreateContainerConfigError` ("cannot verify user is non-root").

## Email / CRM tracking pixel (`collector.mjs`)

The anon FQDN routes `POST` bodies to the handler but answers a bare `GET` with a
platform health check — so a no-JavaScript email pixel (`<img>`) can't reach it
directly. `collector.mjs` is a tiny zero-dependency Node shim that turns pixel
`GET`s into public `track` events (and serves the dashboard):

```bash
APP_URL=https://product-analytics-<org>.ignite.dodil.cloud/ \
PUBLIC_KEY=pk_xxx node collector.mjs
```

```html
<!-- email open -->
<img src="http://your-host:8787/px.gif?e=email_open&u=u_42&c=summer_launch" width="1" height="1">
<!-- tracked click (redirects to `to`) -->
<a href="http://your-host:8787/click?e=email_click&u=u_42&to=https://acme.io/pricing">Pricing</a>
```

Both fire an anonymous `track` to the public backend — the "public backend → CRM
email tracking" path.
