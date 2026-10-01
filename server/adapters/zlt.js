import http from "node:http";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

// Lenient fetch-like client. Node's built-in fetch (undici) crashes on this router's
// non-standard HTTP replies, so use node:http with the tolerant parser instead.
function nfetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    let body = opts.body;
    const headers = { "Accept-Encoding": "gzip, deflate", ...(opts.headers || {}), Connection: "close" };
    if (body instanceof URLSearchParams) body = body.toString();
    if (body != null) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request(
      { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: opts.method || "GET",
        headers, insecureHTTPParser: true, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        let finished = false;
        const done = () => {
          if (finished) return; finished = true;
          let buf = Buffer.concat(chunks);
          const enc = String(res.headers["content-encoding"] || "").toLowerCase();
          try {
            if (enc.includes("gzip")) buf = zlib.gunzipSync(buf);
            else if (enc.includes("deflate")) buf = zlib.inflateSync(buf);
            else if (enc.includes("br")) buf = zlib.brotliDecompressSync(buf);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: { get: (k) => res.headers[k.toLowerCase()] ?? null, getSetCookie: () => res.headers["set-cookie"] || [] },
            text: async () => buf.toString("utf8"),
            json: async () => JSON.parse(buf.toString("utf8")),
          });
        };
        res.on("end", done);
        res.on("close", () => { if (!res.complete) done(); });
        res.on("error", done);
      }
    );
    req.setTimeout(8000, () => { const e = new Error("timeout"); e.name = "TimeoutError"; req.destroy(e); });
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// Adapter for ZLT/ZTE-style "goform" routers (MTN Broadband 5G ZLT X17U).
// NOTE: endpoints/field names follow the common goform API and are unverified
// against a real X17U. If a field is blank, open http://<router>/ in a browser,
// watch the Network tab, and adjust FIELDS below (or use GET /api/raw?cmd=a,b).

const FIELDS = [
  "modem_main_state", "network_type", "network_provider", "signalbar",
  "rssi", "rsrp", "rsrq", "lte_rsrp", "lte_rsrq", "Z5g_rsrp", "Z5g_rsrq", "Z5g_SINR", "lte_snr",
  "wan_active_band", "nr5g_action_band", "wan_ipaddr", "ppp_status", "wan_connect_status",
  "realtime_rx_bytes", "realtime_tx_bytes", "realtime_rx_thrpt", "realtime_tx_thrpt",
  "realtime_time", "sta_count", "SSID1", "SSID2", "hardware_version", "wa_inner_version",
];


// MTN ZLT X17U web API: every call is a JSON POST to /cgi-bin/http.cgi like
// {cmd: <number>, method: "GET"|"POST", sessionId, ...}. Login is
// sha256(token + password) where the token comes from cmd 232.

const SECRET = /pass|pwd|psk|secret|token|key/i;
const redact = (v, k = "") =>
  Array.isArray(v) ? v.map((x) => redact(x)) :
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([a, b]) => [a, redact(b, a)])) :
  SECRET.test(k) && v ? "<hidden>" : v;

// flatten {a:{b:1}} -> {"a.b":1} so fields can be found by fuzzy key match
function flatten(o, p = "", out = {}) {
  if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) flatten(v, p ? `${p}.${k}` : k, out);
  else out[p] = o;
  return out;
}
const num = (v) => (v === undefined || v === null || v === "" || isNaN(+v) ? null : +v);

export function createZlt({ host, password }) {
  const base = `http://${host}`;
  let cookie = "", sessionId = "", rejected = 0, loggingIn = null;

  async function post(body) {
    const r = await nfetch(`${base}/cgi-bin/http.cgi`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Referer: `${base}/`, Origin: base, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body),
    }).catch((e) => {
      throw new Error(`cannot reach router at ${host} (${e.name === "TimeoutError" ? "timed out" : e.code || e.message})`);
    });
    const set = r.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await r.text();
    try { return JSON.parse(text); }
    catch { throw new Error(`router returned non-JSON (HTTP ${r.status}): ${text.slice(0, 120)}`); }
  }

  // Exactly one rejected login is allowed per run, so a wrong password or a
  // protocol mismatch can never hammer the router into its lockout.
  async function doLogin() {
    if (rejected) throw new Error("login was rejected earlier; not retrying to avoid locking the router. Check the password in config.json, then restart Flyx.");
    await post({ cmd: 104, method: "GET", sessionId: "" }).catch(() => {});
    const lock = await post({ cmd: 232, method: "GET", sessionId: "" });
    if (!lock.token) throw new Error(`router gave no login token: ${JSON.stringify(redact(lock)).slice(0, 200)}`);
    const passwd = createHash("sha256").update(lock.token + password).digest("hex");
    const r = await post({ sessionId: "", username: "admin", passwd, isAutoUpgrade: "1", method: "POST", cmd: 100, isCheckPasswd: "1" });
    if (r.login_fail === "fail" || r.login_fail2 === "fail" || !r.sessionId) {
      rejected = 1;
      throw new Error(`router rejected the login: ${JSON.stringify(redact(r)).slice(0, 250)}`);
    }
    sessionId = r.sessionId;
  }
  const login = () => (loggingIn ||= doLogin().finally(() => { loggingIn = null; }));

  async function call(cmd, extra = {}, retry = true) {
    if (!sessionId) await login();
    const res = await post({ cmd, method: "GET", sessionId, ...extra });
    if ((res.message === "NO_AUTH" || res.message === "LOGIN_TIMEOUT") && retry) {
      sessionId = ""; return call(cmd, extra, false);
    }
    return res;
  }

  // ---- data mapping (provisional until checked against real responses) ----
  const CMDS = { home: 402, network: 218, flow: 337, flowN: 355, devices: 223 };
  const pick = (flat, ...res) => {
    for (const re of res) for (const [k, v] of Object.entries(flat)) if (re.test(k) && v !== "" && v != null) return v;
    return null;
  };

  async function readAll() {
    const raw = {};
    for (const [name, cmd] of Object.entries(CMDS)) raw[name] = await call(cmd).catch((e) => ({ error: e.message }));
    return raw;
  }

  return {
    name: "zlt",
    call: async (cmd, extra) => redact(await call(cmd, extra)),

    async getStatus() {
      const raw = await readAll();
      if (Object.values(raw).every((r) => r.error)) throw new Error(Object.values(raw)[0].error);
      const f = flatten(raw);
      const net = pick(f, /network_?type|net_?type|nettype|rat\b/i, /mode/i);
      return {
        online: true,
        networkType: net != null ? String(net) : "—",
        operator: pick(f, /operator|provider|plmn|isp/i) ?? "—",
        band: pick(f, /band/i) ?? "—",
        signalBars: num(pick(f, /signal_?bar|signal_?level|signal$|bars?$/i)),
        rsrp: num(pick(f, /rsrp/i)), rsrq: num(pick(f, /rsrq/i)), sinr: num(pick(f, /sinr|snr/i)),
        wanIp: pick(f, /wan.*ip|ipv4|ip_?addr/i) ?? "—",
        sessionRx: num(pick(f, /(rx|down|download).*(byte|flow|total)|(byte|flow|total).*(rx|down)/i)) ?? 0,
        sessionTx: num(pick(f, /(tx|up|upload).*(byte|flow|total)|(byte|flow|total).*(tx|up)/i)) ?? 0,
        rxRate: num(pick(f, /(rx|down).*(rate|speed|thrpt)|(rate|speed).*(rx|down)/i)) ?? 0,
        txRate: num(pick(f, /(tx|up).*(rate|speed|thrpt)|(rate|speed).*(tx|up)/i)) ?? 0,
        uptime: num(pick(f, /uptime|runtime|run_?time|online_?time/i)) ?? 0,
        clients: num(pick(f, /(client|sta|device|user).*(num|count)|(num|count).*(client|sta|device|user)/i)),
        wifi: { ssid24: pick(f, /ssid.*(2|24)|2g.*ssid/i) || "", ssid5: pick(f, /ssid.*5|5g.*ssid/i) || "" },
        model: pick(f, /model|product|device_?name/i) || "ZLT X17U",
      };
    },

    async getDevices() {
      const res = await call(CMDS.devices);
      const list = Object.values(res).find((v) => Array.isArray(v) && v.length && typeof v[0] === "object") || [];
      const g = (d, re) => { const k = Object.keys(d).find((x) => re.test(x)); return k ? d[k] : ""; };
      return list.map((d) => ({
        name: g(d, /host|name/i) || "Unknown", ip: g(d, /^ip|ipaddr|ip_/i), mac: g(d, /mac/i),
        type: /lan|eth|wired/i.test(JSON.stringify(g(d, /type|conn|interface/i))) ? "lan" : "wifi",
      }));
    },

    // Read-only GET commands; one login, then all responses (secrets hidden).
    async probe() {
      const cmds = [80, 104, 113, 133, 205, 207, 208, 218, 222, 223, 224, 225, 337, 355, 402, 1005, 3, 11];
      const out = { loggedIn: false, results: {} };
      await login(); out.loggedIn = true;
      for (const c of cmds) out.results[c] = redact(await call(c).catch((e) => ({ error: e.message })));
      return out;
    },

    async snippets(q, ctx = 600, max = 6, file = "app.js") {
      const text = await (await nfetch(`${base}/js/${file}`)).text();
      const out = []; let i = -1;
      while (out.length < max && (i = text.indexOf(q, i + 1)) !== -1) { out.push(text.slice(Math.max(0, i - ctx), i + ctx)); i += ctx; }
      return { q, file, count: out.length, snippets: out };
    },
  };
}
