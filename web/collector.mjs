/*
 * Optional collector — the one piece the anonymous FQDN can't do itself:
 * GET tracking pixels for CRM / marketing emails, where there is no JavaScript,
 * only an <img> tag. The app's public FQDN routes POST bodies to the handler but
 * answers bare GETs with a platform health check, so email-open / link-click
 * tracking needs this thin GET→track shim. It also statically serves the
 * dashboard, so `node web/collector.mjs` gives you both from one command.
 *
 * Zero dependencies (Node's http/fs only). Env:
 *   APP_URL     the app's anon FQDN (default: the cardinalai dev deployment)
 *   PUBLIC_KEY  project key added to every tracked event (optional)
 *   PORT        listen port (default 8787)
 *
 * Email open pixel:   <img src="http://HOST:8787/px.gif?e=email_open&u=u_42&c=welcome">
 * Tracked click link: <a href="http://HOST:8787/click?e=email_click&u=u_42&to=https://site/pricing">
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_URL = process.env.APP_URL || "https://product-analytics-cardinalai.ignite.dodil.cloud/";
const PUBLIC_KEY = process.env.PUBLIC_KEY || "";
const PORT = Number(process.env.PORT || 8787);

// 1x1 transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

/** Fire a track event to the app's public path; never throws (best-effort). */
async function track(q) {
  const props = {};
  for (const [k, v] of q) if (!["e", "u", "to"].includes(k)) props[k] = v;
  const body = { action: "track", name: q.get("e") || "email_open", user_id: q.get("u") || "", props };
  if (PUBLIC_KEY) body.key = PUBLIC_KEY;
  try {
    await fetch(APP_URL, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body) });
  } catch (err) {
    console.error("track failed:", err.message);
  }
}

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === "/" ? "/index.html" : urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = join(HERE, rel);
  if (!file.startsWith(HERE)) { res.writeHead(403).end("forbidden"); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  if (u.pathname === "/px.gif") {
    track(u.searchParams); // fire-and-forget
    res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store" });
    return res.end(PIXEL);
  }
  if (u.pathname === "/click") {
    await track(u.searchParams);
    const to = u.searchParams.get("to") || "/";
    res.writeHead(302, { location: to });
    return res.end();
  }
  if (u.pathname === "/event" && req.method === "POST") { // sendBeacon target
    let data = ""; req.on("data", (c) => (data += c));
    req.on("end", async () => {
      try { await track(new URLSearchParams(JSON.parse(data || "{}"))); } catch { /* ignore */ }
      res.writeHead(204).end();
    });
    return;
  }
  return serveStatic(res, u.pathname);
}).listen(PORT, () => {
  console.log(`collector → app ${APP_URL}`);
  console.log(`dashboard  http://localhost:${PORT}/`);
  console.log(`email pixel http://localhost:${PORT}/px.gif?e=email_open&u=u_42&c=welcome`);
});
