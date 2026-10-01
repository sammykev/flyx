# Flyx

A liquid-glass, installable iPhone web app (PWA) for the **MTN Broadband 5G ZLT X17U** router: data usage, live speed, signal, connected devices and connection info.

## How it works
A browser can't safely call a router directly (CORS), so a tiny zero-dependency Node server runs on your network (PC, Raspberry Pi, home server), talks to the router, records your daily usage to `data/history.json`, and serves the app.

## Run
```bash
cp config.example.json config.json   # set router host/password
npm start                            # http://<this-machine>:8080
```
On iPhone (same Wi-Fi): open the URL in Safari → Share → **Add to Home Screen**.

## Router API
The X17U web UI talks to `POST /cgi-bin/http.cgi` with JSON like `{cmd, method, sessionId}`. Login is `sha256(token + password)` (token from cmd 232, login is cmd 100). `server/adapters/zlt.js` implements this. Flyx makes at most **one** login attempt per run, so a wrong password can never trigger the router's lockout.

Field mapping for signal/usage/devices is matched by name and is still being verified against real responses. To inspect them, open `http://<server>:8080/api/probe` (read-only commands, passwords hidden) or `/api/call?cmd=402`.

Usage is tallied by the server from router byte counters, so it only counts traffic while the server is running.

## Windows auto-start
1. Run `allow-firewall.bat` once as administrator (lets your iPhone reach the server).
2. Double-click `install-autostart.bat`. Flyx then starts hidden every time you sign in. Remove it with `uninstall-autostart.bat`.
3. Or just double-click `start-flyx.bat` to run it manually; it restarts itself if it stops.

## Messages
The SMS tab is read-only. If it cannot read your inbox, open `/api/call?cmd=12&subcmd=0&page_num=1` to see the raw reply.
