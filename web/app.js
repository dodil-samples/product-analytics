/*
 * Product Analytics dashboard — a pure static page that calls the app's public
 * (anonymous, CORS-open) FQDN directly. No build step, no server, no bundler:
 * `fetch(APP_URL, { method:"POST", body: JSON.stringify({ action, ... }) })`.
 *
 * Public actions (public_overview, track) need at most a project key; admin
 * reports (funnel/retention/...) require an admin key. Keys travel in the JSON
 * body because the anon FQDN's CORS preflight only allows the content-type header.
 *
 * Config resolves from, in order: ?app=&pk=&ak= query params → localStorage →
 * the defaults below. Set them via the ⚙ Settings panel.
 */
const DEFAULTS = {
  // Point this at your deployed app. Overridable via ⚙ Settings or ?app=…
  url: "https://product-analytics-cardinalai.ignite.dodil.cloud/",
  pk: "", // project (public) key — leave blank if the public tier is open
  ak: "", // admin key — unlocks the private reports
};

const qs = new URLSearchParams(location.search);
const store = {
  get url() { return qs.get("app") || localStorage.getItem("pa_url") || DEFAULTS.url; },
  get pk()  { return qs.get("pk")  || localStorage.getItem("pa_pk")  || DEFAULTS.pk; },
  get ak()  { return qs.get("ak")  || localStorage.getItem("pa_ak")  || DEFAULTS.ak; },
  set(url, pk, ak) {
    localStorage.setItem("pa_url", url);
    localStorage.setItem("pa_pk", pk);
    localStorage.setItem("pa_ak", ak);
  },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/** One anonymous invocation. `key` (if given) is added to the JSON body. */
async function invoke(action, payload = {}, key = "") {
  const body = { action, ...payload };
  if (key) body.key = key;
  const res = await fetch(store.url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: "non-JSON response" }));
  return json;
}

// --------------------------------------------------------------------- overview
async function loadOverview() {
  $("urlEcho").textContent = store.url;
  const r = await invoke("public_overview", { days: 14 }, store.pk);
  if (!r.ok) {
    $("tiles").innerHTML = `<span class="err">${esc(r.error || "failed")}</span>`;
    return;
  }
  const o = r.result;
  const t = o.totals || {};
  $("tiles").innerHTML = [
    ["Events", t.events], ["Users", t.users],
    ["Events today", t.events_today], ["Event types", t.event_types],
  ].map(([l, v]) => `<div class="tile"><div class="v">${fmt(v)}</div><div class="l">${l}</div></div>`).join("");

  drawDau(o.daily_active || []);
  drawBars($("topEvents"), (o.top_events || []).map((e) => ({ name: e.name, value: Number(e.events) })));

  if (o.funnel && o.funnel.steps && o.funnel.steps.length) {
    $("funnelWrap").classList.remove("hidden");
    drawBars($("funnel"), o.funnel.steps.map((s) => ({
      name: s.step, value: Number(s.users),
      note: (Number(s.conversion_from_start) * 100).toFixed(0) + "%",
    })));
  }
}

const fmt = (n) => (Number(n) || 0).toLocaleString();

/** Horizontal magnitude bars: single accent hue, direct value labels. */
function drawBars(el, rows) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  el.innerHTML = rows.length
    ? rows.map((r) => `
      <div class="bar-row" title="${esc(r.name)}: ${fmt(r.value)}">
        <span class="name">${esc(r.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${(r.value / max * 100).toFixed(1)}%"></div></div>
        <span class="val">${fmt(r.value)}${r.note ? ` · ${r.note}` : ""}</span>
      </div>`).join("")
    : `<span class="muted">No data yet.</span>`;
}

/** DAU line+area over time — single series, so no legend; hover crosshair tooltip. */
function drawDau(rows) {
  const data = [...rows].reverse().map((r) => ({ day: r.day, v: Number(r.active) }));
  const el = $("dau");
  if (!data.length) { el.innerHTML = `<span class="muted">No data yet.</span>`; return; }
  const W = el.clientWidth || 900, H = 140, P = { l: 28, r: 8, t: 8, b: 18 };
  const max = Math.max(1, ...data.map((d) => d.v));
  const x = (i) => P.l + (data.length === 1 ? 0 : i / (data.length - 1) * (W - P.l - P.r));
  const y = (v) => H - P.b - (v / max) * (H - P.t - P.b);
  const pts = data.map((d, i) => [x(i), y(d.v)]);
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = `M${x(0).toFixed(1)} ${(H - P.b)} ` + line.slice(1) + ` L${x(data.length - 1).toFixed(1)} ${H - P.b} Z`;
  const ticks = [0, max].map((v) => `<line class="grid" x1="${P.l}" y1="${y(v)}" x2="${W - P.r}" y2="${y(v)}"/>
      <text x="0" y="${y(v) + 3}">${v}</text>`).join("");
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none">
      ${ticks}
      <line class="axis" x1="${P.l}" y1="${H - P.b}" x2="${W - P.r}" y2="${H - P.b}"/>
      <path class="area" d="${area}"/>
      <path class="line" d="${line}"/>
      ${pts.map((p, i) => `<circle class="dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3"
         data-lbl="${esc(data[i].day)}: ${data[i].v} active"/>`).join("")}
      <text x="${P.l}" y="${H - 4}">${data[0].day}</text>
      <text x="${W - P.r}" y="${H - 4}" text-anchor="end">${data[data.length - 1].day}</text>
    </svg>`;
  const tt = $("tt");
  el.querySelectorAll(".dot").forEach((c) => {
    c.addEventListener("mousemove", (e) => {
      tt.textContent = c.getAttribute("data-lbl");
      tt.style.left = e.clientX + 12 + "px"; tt.style.top = e.clientY - 8 + "px"; tt.style.opacity = 1;
    });
    c.addEventListener("mouseleave", () => (tt.style.opacity = 0));
  });
}

// --------------------------------------------------------------------- track
$("evSend").addEventListener("click", async () => {
  const btn = $("evSend"); btn.disabled = true;
  const props = {}; const p = $("evProp").value.trim(); if (p) props.plan = p;
  const r = await invoke("track", {
    name: $("evName").value.trim() || "demo_click",
    user_id: $("evUser").value.trim() || "u_demo", props,
  }, store.pk);
  const out = $("evOut"); out.classList.remove("hidden");
  out.textContent = JSON.stringify(r, null, 2);
  btn.disabled = false;
  if (r.ok) setTimeout(loadOverview, 400); // reflect the new event
});

// --------------------------------------------------------------------- admin reports
const DEFAULT_FUNNEL = ["signup", "activated", "checkout_completed"];
document.querySelectorAll("[data-report]").forEach((b) => {
  b.addEventListener("click", async () => {
    const out = $("reportOut"); out.classList.remove("hidden"); out.textContent = "…";
    const report = b.getAttribute("data-report");
    const extra = report === "funnel" ? { steps: DEFAULT_FUNNEL }
      : report === "breakdown" ? { event: "checkout_completed", property: "plan" } : {};
    const r = await invoke(report, extra, store.ak);
    out.textContent = JSON.stringify(r, null, 2);
    out.className = "out" + (r.ok ? " ok-border" : "");
  });
});

// --------------------------------------------------------------------- settings
function syncAdminHint() {
  $("adminHint").textContent = store.ak
    ? "Admin key set — reports unlocked."
    : "Set an admin key in ⚙ Settings to unlock.";
}
$("gear").addEventListener("click", () => $("settings").classList.toggle("open"));
$("cfgSave").addEventListener("click", () => {
  store.set($("cfgUrl").value.trim() || DEFAULTS.url, $("cfgPk").value.trim(), $("cfgAk").value.trim());
  $("settings").classList.remove("open");
  syncAdminHint(); loadOverview();
});

// init
$("cfgUrl").value = store.url; $("cfgPk").value = store.pk; $("cfgAk").value = store.ak;
syncAdminHint();
loadOverview();
window.addEventListener("resize", () => clearTimeout(window._rz) || (window._rz = setTimeout(loadOverview, 300)));
