// Fake router so the UI can be developed without hardware: `npm run mock`.
const GB = 1024 ** 3;
const t0 = Date.now();
let rx = 40 * GB, tx = 6 * GB;

export function createMock() {
  return {
    name: "mock",
    async getStatus() {
      const s = (Date.now() - t0) / 1000;
      const rxRate = Math.max(0, 4e6 + Math.sin(s / 5) * 3e6 + Math.random() * 1e6);
      const txRate = Math.max(0, 6e5 + Math.cos(s / 7) * 4e5 + Math.random() * 1e5);
      rx += rxRate * 15; tx += txRate * 15;
      return {
        online: true,
        networkType: "5G NSA",
        operator: "MTN NG",
        band: "n78",
        signalBars: 4,
        rsrp: -92 + Math.round(Math.sin(s / 9) * 4),
        rsrq: -11,
        sinr: 14 + Math.round(Math.cos(s / 6) * 3),
        wanIp: "100.72.14.201",
        sessionRx: rx, sessionTx: tx,
        rxRate, txRate,
        uptime: Math.floor(s) + 86400 * 3 + 5400,
        clients: 5,
        wifi: { ssid24: "FLYX-5G", ssid5: "FLYX-5G_5GHz" },
        model: "ZLT X17U (mock)",
      };
    },
    async getDevices() {
      return [
        { name: "iPhone 16 Pro", ip: "192.168.0.101", mac: "A4:83:E7:11:22:01", type: "wifi" },
        { name: "MacBook Air", ip: "192.168.0.102", mac: "3C:22:FB:AA:BB:02", type: "wifi" },
        { name: "Smart TV", ip: "192.168.0.103", mac: "D8:9E:F3:33:44:03", type: "wifi" },
        { name: "PS5", ip: "192.168.0.104", mac: "00:D9:D1:55:66:04", type: "lan" },
        { name: "Galaxy Tab", ip: "192.168.0.105", mac: "F0:5C:77:77:88:05", type: "wifi" },
      ];
    },
  };
}
