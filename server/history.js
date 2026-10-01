// Records data usage ourselves. Router counters reset on reconnect/reboot, so we
// accumulate deltas between polls into per-day buckets and persist to disk.
import fs from "node:fs";
import path from "node:path";

const FILE = path.resolve("data/history.json");
const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let state = { days: {}, last: null };
try { state = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}

let dirty = false;
export function record(rx, tx) {
  const last = state.last;
  // counter went backwards => session reset, so the whole value is new traffic
  const dRx = last && rx >= last.rx ? rx - last.rx : last ? rx : 0;
  const dTx = last && tx >= last.tx ? tx - last.tx : last ? tx : 0;
  state.last = { rx, tx };
  if (dRx || dTx) {
    const k = dayKey();
    const d = (state.days[k] ||= { rx: 0, tx: 0 });
    d.rx += dRx; d.tx += dTx;
  }
  dirty = true;
}

export function getDays(n = 30) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = dayKey(d);
    out.push({ date: k, rx: state.days[k]?.rx || 0, tx: state.days[k]?.tx || 0 });
  }
  return out;
}

setInterval(() => {
  if (!dirty) return;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state));
    dirty = false;
  } catch (e) { console.error("history save failed", e.message); }
}, 30_000).unref();

