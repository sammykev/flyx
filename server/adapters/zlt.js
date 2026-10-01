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

const TIMEOUT = 8000;
const num = (v) => (v === undefined || v === "" || isNaN(+v) ? null : +v);

export function createZlt({ host, password, loginMode = "base64" }) {
  const base = `http://${host}`;
  let cookie = "";

  const headers = (extra = {}) => ({
    Referer: `${base}/index.html`,
    Origin: base,
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  });

  async function login() {
    if (loginMode === "none") return;
    const pw = loginMode === "base64" ? Buffer.from(password).toString("base64") : password;
    const res = await fetch(`${base}/goform/goform_set_cmd_process`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams({ isTest: "false", goformId: "LOGIN", password: pw }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const body = await res.json().catch(() => ({}));
    if (body.result && body.result !== "0" && body.result !== "4") {
      throw new Error(`router login failed (result=${body.result})`);
    }
  }

  async function get(cmds, { retry = true } = {}) {
    const url = `${base}/goform/goform_get_cmd_process?isTest=false&multi_data=1&cmd=${cmds.join(",")}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT) }).catch((e) => {
      throw new Error(`cannot reach router at ${host} (${e.name === "TimeoutError" ? "timed out" : e.cause?.code || e.message})`);
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if ((!json || json.loginfo === "no") && retry) {
      await login();
      return get(cmds, { retry: false });
    }
    if (!json) throw new Error(`router at ${host} did not return goform JSON (HTTP ${res.status}); check host/firmware`);
    return json;
  }

  // Probe the router and report what it says, to debug login/field problems.
  async function diagnose() {
    const out = { host, steps: [] };
    const step = async (name, fn) => {
      try { out.steps.push({ name, ok: true, result: await fn() }); }
      catch (e) { out.steps.push({ name, ok: false, error: e.message }); }
    };
    const t = (u, o = {}) => fetch(base + u, { ...o, signal: AbortSignal.timeout(TIMEOUT) });
    await step("open router home page", async () => {
      const r = await t("/"); const b = await r.text();
      return { http: r.status, title: (b.match(/<title>(.*?)<\/title>/is) || [])[1] || null, bytes: b.length };
    });
    await step("read status without login", async () => {
      const r = await t("/goform/goform_get_cmd_process?isTest=false&multi_data=1&cmd=network_type,signalbar,loginfo", { headers: headers() });
      return { http: r.status, body: (await r.text()).slice(0, 300) };
    });
    for (const mode of ["base64", "plain"]) {
      await step(`login (${mode})`, async () => {
        const pw = mode === "base64" ? Buffer.from(password).toString("base64") : password;
        const r = await t("/goform/goform_set_cmd_process", {
          method: "POST", headers: headers({ "Content-Type": "application/x-www-form-urlencoded" }),
          body: new URLSearchParams({ isTest: "false", goformId: "LOGIN", password: pw }),
        });
        return { http: r.status, body: (await r.text()).slice(0, 300) };
      });
    }
    return out;
  }

  // Read the router's own web UI and list the API paths its scripts call.
  async function discover() {
    const t = async (u, o = {}) => {
      const r = await fetch(u.startsWith("http") ? u : base + u, { ...o, signal: AbortSignal.timeout(TIMEOUT) });
      return { status: r.status, type: r.headers.get("content-type"), server: r.headers.get("server"), text: await r.text() };
    };
    const out = { host };
    const home = await t("/");
    out.home = { status: home.status, server: home.server, html: home.text.slice(0, 1500) };
    const assets = [...home.text.matchAll(/(?:src|href)\s*=\s*["']([^"']+\.(?:js|json))["']/gi)].map((m) => m[1]);
    out.assets = [];
    const found = new Set();
    for (const a of [...new Set(assets)].slice(0, 12)) {
      try {
        const url = a.startsWith("http") ? a : new URL(a, base + "/").href;
        const r = await t(url);
        out.assets.push({ url: a, status: r.status, bytes: r.text.length });
        for (const m of r.text.matchAll(/["'`](\/?(?:cgi-bin|api|goform|ubus|rpc|jsonrpc|action|cmd|data|json|lua)[\w\-./?=&%]*)["'`]/gi)) found.add(m[1]);
        for (const m of r.text.matchAll(/["'`](\/[\w\-./]*(?:login|status|info|usage|traffic|signal|device|client|session)[\w\-./?=&%]*)["'`]/gi)) found.add(m[1]);
      } catch (e) { out.assets.push({ url: a, error: e.message }); }
    }
    out.apiPathsInScripts = [...found].slice(0, 80);
    const probes = ["/ubus", "/cgi-bin/luci", "/cgi-bin/", "/api", "/api/status", "/cgi-bin/get_status", "/cgi-bin/status.cgi", "/goform/goform_get_cmd_process", "/jsonrpc", "/rpc", "/data.json", "/status.json", "/cgi-bin/api"];
    out.probes = {};
    for (const p of probes) {
      try { const r = await t(p); out.probes[p] = `${r.status} ${r.type || ""} ${r.text.slice(0, 80).replace(/\s+/g, " ")}`; }
      catch (e) { out.probes[p] = "error " + e.message; }
    }
    return out;
  }

  // Return code snippets from the router's JS around a search term.
  async function snippets(q, ctx = 600, max = 6) {
    const out = [];
    for (const f of ["js/app.js"]) {
      const r = await fetch(`${base}/${f}`, { signal: AbortSignal.timeout(TIMEOUT) });
      const text = await r.text();
      let i = -1;
      while (out.length < max && (i = text.indexOf(q, i + 1)) !== -1) {
        out.push({ file: f, at: i, code: text.slice(Math.max(0, i - ctx), i + ctx) });
        i += ctx;
      }
    }
    return { q, count: out.length, snippets: out };
  }

  return {
    name: "zlt",
    snippets,
    diagnose,
    discover,
    raw: (cmds) => get(cmds),
    async getStatus() {
      const r = await get(FIELDS);
      const nr = r.network_type && /5g|nr/i.test(r.network_type);
      return {
        online: /connected/i.test(r.ppp_status || r.wan_connect_status || "") || !!r.wan_ipaddr,
        networkType: r.network_type || "—",
        operator: r.network_provider || "—",
        band: r.nr5g_action_band || r.wan_active_band || "—",
        signalBars: num(r.signalbar),
        rsrp: num(nr ? r.Z5g_rsrp || r.lte_rsrp : r.lte_rsrp || r.rsrp),
        rsrq: num(nr ? r.Z5g_rsrq || r.lte_rsrq : r.lte_rsrq || r.rsrq),
        sinr: num(r.Z5g_SINR || r.lte_snr),
        wanIp: r.wan_ipaddr || "—",
        sessionRx: num(r.realtime_rx_bytes) ?? 0,
        sessionTx: num(r.realtime_tx_bytes) ?? 0,
        rxRate: num(r.realtime_rx_thrpt) ?? 0,
        txRate: num(r.realtime_tx_thrpt) ?? 0,
        uptime: num(r.realtime_time) ?? 0,
        clients: num(r.sta_count),
        wifi: { ssid24: r.SSID1 || "", ssid5: r.SSID2 || "" },
        model: r.hardware_version || "ZLT X17U",
      };
    },
    async getDevices() {
      const r = await get(["station_list", "lan_station_list"]);
      const map = (list, type) =>
        (list || []).map((d) => ({
          name: d.hostname || d.hostName || "Unknown",
          ip: d.ip_addr || d.ipAddress || "",
          mac: d.mac_addr || d.macAddress || "",
          type,
        }));
      return [...map(r.station_list, "wifi"), ...map(r.lan_station_list, "lan")];
    },
  };
}
