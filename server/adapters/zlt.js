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
    const res = await fetch(url, { headers: headers() });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if ((!json || json.loginfo === "no") && retry) {
      await login();
      return get(cmds, { retry: false });
    }
    if (!json) throw new Error("unexpected router response");
    return json;
  }

  return {
    name: "zlt",
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
