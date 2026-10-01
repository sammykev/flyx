import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZlt } from "./adapters/zlt.js";
import { record, getDays } from "./history.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");

let config = { port: 8080, router: { host: "192.168.0.1", password: "admin" }, pollSeconds: 15 };
try { config = { ...config, ...JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")) }; } catch {}
const port = process.env.PORT || config.port;

if (!fs.existsSync(path.join(root, "config.json"))) {
  console.warn("config.json not found - using defaults (192.168.0.1 / admin). Copy config.example.json to config.json and set your router password.");
}
process.on("uncaughtException", (e) => { error = `router connection error: ${e.message}`; console.error(e.message); });
process.on("unhandledRejection", (e) => { error = String(e?.message || e); console.error(error); });
const router = createZlt(config.router);
console.log(`Router: ${config.router.host}`);

let status = null, error = null, updated = 0;
async function poll() {
  try {
    status = await router.getStatus();
    record(status.sessionRx, status.sessionTx);
    error = null; updated = Date.now();
  } catch (e) { error = e.message; }
}
poll();
setInterval(poll, config.pollSeconds * 1000);

const types = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript",
  ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png",
};
const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/status") return json(res, 200, { status, error, updated });
    if (url.pathname === "/api/usage") return json(res, 200, { days: getDays(+url.searchParams.get("days") || 30) });
    if (url.pathname === "/api/probe") return json(res, 200, await router.probe());
    if (url.pathname === "/api/call") {
      const extra = {};
      for (const [k, v] of url.searchParams) if (k !== "cmd") extra[k] = v !== "" && !isNaN(+v) ? +v : v;
      return json(res, 200, await router.call(+url.searchParams.get("cmd"), extra)); // always a read-only GET
    }
    if (url.pathname === "/api/findcode") return json(res, 200, await router.findcode(url.searchParams.get("q") || "", +url.searchParams.get("ctx") || 500, +url.searchParams.get("max") || 6));
    if (url.pathname === "/api/sms") return json(res, 200, await router.getSms(+url.searchParams.get("page") || 1));
    if (url.pathname === "/api/snippets") return json(res, 200, await router.snippets(url.searchParams.get("q") || "", +url.searchParams.get("ctx") || 600, +url.searchParams.get("max") || 6, url.searchParams.get("file") || "app.js"));
    if (url.pathname === "/api/devices") return json(res, 200, { devices: await router.getDevices() });

    let file = path.normalize(path.join(pub, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 502, { error: e.message }); }
}).listen(port, "0.0.0.0", () => console.log(`Flyx on http://localhost:${port}`));
