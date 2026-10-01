import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZlt } from "./adapters/zlt.js";
import { createMock } from "./adapters/mock.js";
import { record, getDays, seedDemo } from "./history.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = path.join(root, "public");

let config = { port: 8080, router: { host: "192.168.0.1", password: "admin" }, pollSeconds: 15 };
try { config = { ...config, ...JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")) }; } catch {}
const port = process.env.PORT || config.port;

const mock = process.env.FLYX_MOCK === "1";
const router = mock ? createMock() : createZlt(config.router);
console.log(`Adapter: ${router.name}`);
if (mock) seedDemo();

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
    if (url.pathname === "/api/status") return json(res, 200, { status, error, updated, mock });
    if (url.pathname === "/api/usage") return json(res, 200, { days: getDays(+url.searchParams.get("days") || 30) });
    if (url.pathname === "/api/devices") return json(res, 200, { devices: await router.getDevices() });
    if (url.pathname === "/api/raw" && router.raw)
      return json(res, 200, await router.raw((url.searchParams.get("cmd") || "").split(",")));

    let file = path.normalize(path.join(pub, url.pathname === "/" ? "index.html" : url.pathname));
    if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 502, { error: e.message }); }
}).listen(port, "0.0.0.0", () => console.log(`Flyx on http://localhost:${port}`));
