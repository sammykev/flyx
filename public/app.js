const $ = (id) => document.getElementById(id);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let plan = { gb: store.get("planGb", 100), resetDay: store.get("resetDay", 1) };
let state = { status: null, days: [], range: 14 };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (b) => {
  if (b == null) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (b >= 1024 && i < 4) { b /= 1024; i++; }
  return `${b >= 100 || i === 0 ? b.toFixed(0) : b.toFixed(b >= 10 ? 1 : 2)} ${u[i]}`;
};
const rate = (b) => `${fmt(b)}/s`;
const dur = (s) => { const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };

// billing cycle helpers
function cycle() {
  const now = new Date(), y = now.getFullYear(), m = now.getMonth();
  const at = (yy, mm) => new Date(yy, mm, Math.min(plan.resetDay, new Date(yy, mm + 1, 0).getDate()));
  let start = at(y, m); if (start > now) start = at(y, m - 1);
  const end = at(start.getFullYear(), start.getMonth() + 1);
  return { start, end, daysLeft: Math.ceil((end - now) / 864e5) };
}
const key = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function cycleUsed() {
  if (state.status?.plan) return state.status.plan.usedBytes; // the router's own monthly counter
  const { start } = cycle(), s = key(start);
  return state.days.filter((d) => d.date >= s).reduce((a, d) => a + d.rx + d.tx, 0);
}

function render() {
  const s = state.status;
  const pill = $("conn");
  if (!s) { pill.className = "pill bad"; $("connText").textContent = "No data"; return; }
  pill.className = "pill " + (s.online ? "ok" : "bad");
  $("connText").textContent = s.online ? "Online" : "Offline";
  $("model").textContent = s.model;
  const bd = $("smsBadge"); bd.hidden = !s.smsUnread; bd.textContent = s.smsUnread > 99 ? "99+" : s.smsUnread;

  const P = s.plan;
  if (P) {
    plan.resetDay = P.resetDay;
    if (P.limitBytes) plan.gb = Math.round(P.limitBytes / 1024 ** 3 * 10) / 10;
    $("planGb").value = plan.gb; $("resetDay").value = plan.resetDay;
  }
  const used = cycleUsed(), cap = plan.gb * 1024 ** 3, pct = Math.min(used / cap, 1);
  $("usedBig").textContent = fmt(used);
  $("usedOf").textContent = `of ${plan.gb} GB plan`;
  $("remain").textContent = fmt(Math.max(cap - used, 0));
  $("resetIn").textContent = `${cycle().daysLeft} days`;
  const t = state.days.at(-1); $("todayTotal").textContent = fmt(t ? t.rx + t.tx : 0);
  const fg = $("ringFg");
  fg.style.strokeDashoffset = 326.7 * (1 - pct);
  fg.style.stroke = pct > .9 ? "var(--bad)" : pct > .7 ? "var(--warn)" : "var(--c1)";

  $("rx").textContent = rate(s.rxRate); $("tx").textContent = rate(s.txRate);
  $("net").textContent = s.networkType; $("op").textContent = `${s.operator} · ${s.band}`;
  $("bars").textContent = s.signalBars != null ? "▂▄▆█".slice(0, Math.max(1, Math.min(4, s.signalBars))) + ` ${s.signalBars}/5` : "—";
  $("rsrpSmall").textContent = s.rsrp != null ? `RSRP ${s.rsrp} dBm · SINR ${s.sinr ?? "—"} dB` : "";

  $("sRx").textContent = fmt(P ? P.dlBytes : s.sessionRx); $("sTx").textContent = fmt(P ? P.ulBytes : s.sessionTx);
  const row = (k, v) => `<div class="row"><span>${k}</span><span class="v">${esc(v)}</span></div>`;
  $("netList").innerHTML = "<h3>Connection</h3>" + [
    ["Status", s.online ? "Connected" : "Disconnected"], ["Operator", s.operator], ["Network type", s.networkType],
    ["Band", s.band], ["WAN IP", s.wanIp],
    ["Connected for", s.connectedFor != null ? dur(s.connectedFor) : null], ["Router uptime", dur(s.uptime)],
    ["Clients", s.clients], ...(s.details || []),
  ].filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => row(k, v)).join("");
}

function renderUsage() {
  const days = state.days.slice(-state.range);
  const max = Math.max(1, ...days.map((d) => d.rx + d.tx));
  $("chart").innerHTML = days.map((d) =>
    `<div class="bar" title="${d.date}"><i class="u" style="height:${d.tx / max * 100}%"></i><i class="d" style="height:${d.rx / max * 100}%"></i></div>`).join("");
  const tot = cycleUsed();
  $("mTotal").textContent = fmt(tot);
  $("mAvg").textContent = fmt(state.days.slice(-7).reduce((a, d) => a + d.rx + d.tx, 0) / 7);
  $("dayList").innerHTML = "<h3>Daily</h3>" + [...days].reverse().map((d) =>
    `<div class="row"><span>${new Date(d.date + "T00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</span><span class="v">↓ ${fmt(d.rx)} · ↑ ${fmt(d.tx)}</span></div>`).join("");
}

async function loadDevices() {
  try {
    const { devices } = await (await fetch("/api/devices")).json();
    $("devList").innerHTML = devices.length ? `<h3>${devices.length} connected</h3>` + devices.map((d) =>
      `<div class="row dev"><div><b>${esc(d.name)}</b><small>${esc(d.ip)} · ${esc(d.mac)}${d.note ? " · " + esc(d.note) : ""}</small></div><span class="tag">${d.type === "lan" ? "Ethernet" : "Wi-Fi"}</span></div>`).join("")
      : '<p class="empty">No devices found</p>';
  } catch { $("devList").innerHTML = '<p class="empty">Could not load devices</p>'; }
}

let sms = { msgs: [], page: 0, total: 0, unread: 0 };
async function loadSms(more) {
  try {
    if (!more) sms = { msgs: [], page: 0, total: 0, unread: 0 };
    const r = await (await fetch(`/api/sms?page=${sms.page + 1}`)).json();
    if (r.error) throw new Error(r.error);
    sms.page = r.page; sms.total = r.total || 0; sms.unread = r.unread || 0;
    sms.msgs = more ? sms.msgs.concat(r.messages) : r.messages;
    const head = `<h3>${sms.unread} unread${sms.total ? " · " + sms.total + " total" : ""}</h3>`;
    const items = sms.msgs.map((m) =>
      `<div class="sms ${m.unread ? "new" : ""}"><div class="h"><b>${esc(m.number || "Unknown")}</b><small>${esc(m.time)}</small></div><p>${esc(m.text)}</p></div>`).join("");
    const moreBtn = sms.msgs.length < sms.total && r.messages.length ? '<button class="more" id="smsMore">Load older messages</button>' : "";
    $("smsList").innerHTML = sms.msgs.length ? head + items + moreBtn
      : `<p class="empty">${r.found ? "No messages" : "Couldn't read the message list."}</p>`;
    const mb = $("smsMore"); if (mb) mb.onclick = () => loadSms(true);
  } catch (e) { $("smsList").innerHTML = `<p class="empty">Could not load messages: ${esc(e.message)}</p>`; }
}

async function refresh() {
  try {
    const [st, us] = await Promise.all([fetch("/api/status").then((r) => r.json()), fetch("/api/usage?days=30").then((r) => r.json())]);
    state.status = st.status; state.days = us.days;
    const bn = $("banner");
    bn.hidden = !st.error;
    if (st.error) bn.innerHTML = `<b>Can't read the router</b><br>${esc(st.error)}<br><a href="/api/diagnose" target="_blank">Run diagnostic</a>`;
  } catch (e) {
    state.status = null; $("banner").hidden = false;
    $("banner").innerHTML = "<b>Can't reach the Flyx server</b><br>Is it still running on your computer?";
  }
  render(); renderUsage();
}

// tabs
const titles = { home: "Home", usage: "Usage", devices: "Devices", sms: "Messages", network: "Network" };
$("tabs").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  document.querySelectorAll(".tabbar button").forEach((x) => x.classList.toggle("on", x === b));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "v-" + b.dataset.v));
  $("title").textContent = titles[b.dataset.v];
  if (b.dataset.v === "devices") loadDevices();
  if (b.dataset.v === "sms") loadSms();
  if (navigator.vibrate) navigator.vibrate(5);
};
$("range").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  state.range = +b.dataset.d;
  document.querySelectorAll("#range button").forEach((x) => x.classList.toggle("on", x === b));
  renderUsage();
};
$("planGb").value = plan.gb; $("resetDay").value = plan.resetDay;
$("planGb").onchange = (e) => { plan.gb = +e.target.value || 100; store.set("planGb", plan.gb); render(); };
$("resetDay").onchange = (e) => { plan.resetDay = Math.min(28, Math.max(1, +e.target.value || 1)); store.set("resetDay", plan.resetDay); render(); renderUsage(); };

refresh(); setInterval(refresh, 5000);
document.addEventListener("visibilitychange", () => !document.hidden && refresh());
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
