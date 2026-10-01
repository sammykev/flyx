@echo off
schtasks /Delete /TN "Flyx" /F
echo Auto-start removed. If Flyx is still running, end the "node.exe" process in Task Manager.
pause
