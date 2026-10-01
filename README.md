# Flyx

A liquid-glass, installable iPhone web app (PWA) for the **MTN Broadband 5G ZLT X17U** router: data usage, live speed, signal, connected devices and connection info.

## How it works
A browser can't safely call a router directly (CORS), so a tiny zero-dependency Node server runs on your network (PC, Raspberry Pi, home server), talks to the router, records your daily usage to `data/history.json`, and serves the app.

## Run
```bash
cp config.example.json config.json   # set router host/password
npm start                            # http://<this-machine>:8080
npm run mock                         # fake router data, no hardware needed
```
On iPhone (same Wi-Fi): open the URL in Safari → Share → **Add to Home Screen**.

## Router API caveat
`server/adapters/zlt.js` uses the common ZTE/ZLT `goform` API. It is not yet verified against a real X17U. If fields are blank, open `http://<server>:8080/api/raw?cmd=network_type,signalbar` to test commands, and adjust `FIELDS` / `loginMode` (`base64`, `plain`, `none`). If your firmware needs a different login, edit `login()`.

Usage is tallied by the server from router byte counters, so it only counts traffic while the server is running.
