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
    if (!text.trim()) return { empty: true };
    try { return JSON.parse(text); } catch {}
    const t = text.replace(/[\u0000-\u001f]+/g, " ").trim();
    for (const cand of [t, t.slice(0, t.lastIndexOf("}") + 1)]) { try { return JSON.parse(cand); } catch {} }
    throw new Error(`router returned non-JSON (HTTP ${r.status}): ${text.slice(0, 120)}`);
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

  // ---- data mapping (field names confirmed from real X17U responses) ----
  const MB = 1024 ** 2, GB = 1024 ** 3;
  const TTL = { 205: 60e3, 207: 60e3 }; // slow-changing; everything else is read each poll
  const memo = {}; let last = null;
  async function cached(cmd) {
    const m = memo[cmd];
    if (m && Date.now() - m.t < (TTL[cmd] ?? 0)) return m.v;
    const v = await call(cmd).catch((e) => ({ error: e.message }));
    memo[cmd] = { t: Date.now(), v };
    return v;
  }
  const secs = (dur) => { // "1-13-10-18" = days-hours-minutes-seconds
    const p = String(dur || "").split("-").map(Number);
    return p.length === 4 && p.every((x) => !isNaN(x)) ? p[0] * 86400 + p[1] * 3600 + p[2] * 60 + p[3] : null;
  };

  return {
    name: "zlt",
    call: async (cmd, extra) => redact(await call(cmd, extra)),

    async getStatus() {
      const w = await cached(133);                 // WAN, signal, counters
      if (w.error) throw new Error(w.error);
      const n = await cached(113), p = await cached(337), c = await cached(1005);
      const d = await cached(205), sys = await cached(207);

      const nr = /5g/i.test(n.network_type_str || "");
      const sig = (lte, nr5) => num(nr && w[nr5] !== "" && w[nr5] != null ? w[nr5] : w[lte]);

      // live speed from the change in the router's WAN byte counters
      const rx = num(w.wan_rx_bytes) ?? 0, tx = num(w.wan_tx_bytes) ?? 0, now = Date.now();
      let rxRate = 0, txRate = 0;
      if (last && now > last.t) {
        const dt = (now - last.t) / 1000;
        rxRate = Math.max(0, (rx - last.rx) / dt); txRate = Math.max(0, (tx - last.tx) / dt);
      }
      last = { rx, tx, t: now };

      // the router keeps its own monthly counter and plan
      const dl = num(p.dl_mon_flow), ul = num(p.ul_mon_flow);
      const plan = dl == null && ul == null ? null : {
        usedBytes: ((dl || 0) + (ul || 0)) * MB, dlBytes: (dl || 0) * MB, ulBytes: (ul || 0) * MB,
        limitBytes: p.limitSwitch === "1" && num(p.limitSize) ? num(p.limitSize) * (p.flow_limit_unit === "1" ? GB : MB) : null,
        resetDay: num(p.startDate) || 1,
      };

      const details = [];
      const add = (k, v) => { if (v !== "" && v != null && v !== "undefined") details.push([k, String(v)]); };
      add("5G band", w.currentband_5g && `n${w.currentband_5g}`);
      add("4G bands", w.currentband && "B" + w.currentband.split("+").join(" + B"));
      add("5G RSRP", w.RSRP_5G && `${w.RSRP_5G} dBm`); add("5G SINR", w.SINR_5G && `${w.SINR_5G} dB`);
      add("5G RSRQ", w.RSRQ_5G && `${w.RSRQ_5G} dB`);
      add("4G RSRP", w.RSRP && `${w.RSRP} dBm`); add("4G SINR", w.SINR && `${w.SINR} dB`);
      add("4G RSRQ", w.RSRQ && `${w.RSRQ} dB`);
      add("5G bandwidth", w.bandwidth_5g && `${w.bandwidth_5g} MHz`);
      add("MIMO", d.mimo_status); add("APN", w.apn_name);
      add("DNS", [w.wan_dns, w.wan_dns2].filter(Boolean).join(", "));
      add("Mobile data", n.data_switch === "1" ? "On" : n.data_switch === "0" ? "Off" : "");
      add("Roaming", n.roam_status === "1" ? "Yes" : n.roam_status === "0" ? "No" : "");
      add("Temperature", sys.device_temperature && `${sys.device_temperature} °C`);
      add("CPU load", sys.cpu_usage && `${sys.cpu_usage}%`);
      add("Firmware", w.real_fwversion || sys.real_fwversion);
      add("Unread SMS", c.sms_unread);

      const clients = ["24gwifi_clients_num", "5gwifi_clients_num", "eth_clients_num"].reduce((a, k) => a + (num(c[k]) || 0), 0);
      return {
        online: n.network_status === "1" || !!w.wan_ip,
        networkType: n.network_type_str || "—",
        operator: n.network_operator || "—",
        band: nr ? `n${w.currentband_5g}` : w.currentband ? `B${w.currentband.split("+")[0]}` : "—",
        signalBars: num(n.signal_lvl),
        rsrp: sig("RSRP", "RSRP_5G"), rsrq: sig("RSRQ", "RSRQ_5G"), sinr: sig("SINR", "SINR_5G"),
        wanIp: w.wan_ip || "—",
        sessionRx: rx, sessionTx: tx, rxRate, txRate,
        uptime: num(w.uptime) ?? num(sys.uptime) ?? 0,
        connectedFor: secs(d.onlineDuration || sys.online_duration),
        clients, plan, details, smsUnread: num(c.sms_unread),
        model: w.real_device || sys.real_device || "ZLT X17U",
      };
    },

    async getDevices() {
      const a = await call(223);
      const wifi = {};
      for (const [cmd, key, band] of [[225, "wlan5g_wifi_info", "5 GHz"], [224, "wlan24g_wifi_info", "2.4 GHz"]]) {
        const r = await call(cmd).catch(() => ({}));
        for (const x of Array.isArray(r[key]) ? r[key] : []) wifi[String(x.mac).toLowerCase()] = { ...x, band };
      }
      return (a.dhcp_list_info || []).map((d) => {
        const w = wifi[String(d.mac).toLowerCase()];
        return {
          name: d.hostname || "Unknown", ip: d.ip || "", mac: (d.mac || "").toUpperCase(),
          type: d.interface === "wlan" ? "wifi" : "lan",
          note: w ? [w.ssid, w.band, w.rssi && `${w.rssi} dBm`].filter(Boolean).join(" · ") : "",
        };
      });
    },

    // Read-only SMS inbox (cmd 12). Bodies are often UCS2-hex encoded; decode when they look like it.
    async getSms(page = 1) {
      const r = await call(12, { subcmd: 0, page_num: page });
      const list = Object.values(r).find((v) => Array.isArray(v) && (!v.length || typeof v[0] === "object")) || [];
      const g = (d, re) => { const k = Object.keys(d).find((x) => re.test(x)); return k ? d[k] : ""; };
      const dec = (t) => {
        t = String(t ?? "");
        if (t.length >= 4 && t.length % 4 === 0 && /^[0-9a-f]+$/i.test(t)) {
          try {
            const out = Buffer.from(t, "hex").swap16().toString("utf16le");
            if (!/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(out)) return out;
          } catch {}
        }
        return t;
      };
      return {
        found: Array.isArray(Object.values(r).find((v) => Array.isArray(v))),
        total: num(r.sms_total ?? r.total ?? r.sms_num ?? r.sms_count), unread: num(r.sms_unread),
        messages: list.map((d) => ({
          id: g(d, /^id$|index|^num$/i), number: dec(g(d, /phone|number|from|sender|addr/i)),
          text: dec(g(d, /content|text|body|msg|message/i)), time: g(d, /time|date/i),
          unread: /^(0|unread|new)$/i.test(String(g(d, /read|status|state|tag/i))),
        })),
      };
    },

    // Read-only GET commands; one login, then all responses (secrets hidden).
    async probe() {
      const cmds = [80, 104, 113, 133, 205, 207, 208, 218, 222, 223, 224, 225, 337, 355, 402, 1005, 3, 11];
      const out = { loggedIn: false, results: {} };
      await login(); out.loggedIn = true;
      for (const c of cmds) out.results[c] = redact(await call(c).catch((e) => ({ error: e.message })));
      return out;
    },

    // Search every script of the router's web UI for a string (code only, no personal data).
    async findcode(q, ctx = 500, max = 6) {
      const get = async (f) => (await nfetch(`${base}/js/${f}`)).text();
      const app = await get("app.js");
      const files = ["app.js", ...[...new Set([...app.matchAll(/chunk-([0-9a-f]{8})/g)].map((m) => `chunk-${m[1]}.js`))]];
      const out = [];
      for (const f of files) {
        if (out.length >= max) break;
        let t; try { t = f === "app.js" ? app : await get(f); } catch { continue; }
        let i = -1;
        while (out.length < max && (i = t.indexOf(q, i + 1)) !== -1) { out.push({ file: f, code: t.slice(Math.max(0, i - ctx), i + ctx) }); i += ctx; }
      }
      return { q, count: out.length, results: out };
    },

    async snippets(q, ctx = 600, max = 6, file = "app.js") {
      const text = await (await nfetch(`${base}/js/${file}`)).text();
      const out = []; let i = -1;
      while (out.length < max && (i = text.indexOf(q, i + 1)) !== -1) { out.push(text.slice(Math.max(0, i - ctx), i + ctx)); i += ctx; }
      return { q, file, count: out.length, snippets: out };
    },
  };
}
