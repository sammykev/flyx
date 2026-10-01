@echo off
cd /d "%~dp0"
if not exist config.json (
  echo config.json is missing. Copy config.example.json to config.json and set your router password first.
  pause & exit /b 1
)
schtasks /Create /TN "Flyx" /TR "wscript.exe \"%~dp0flyx-hidden.vbs\"" /SC ONLOGON /F
if errorlevel 1 (echo Could not create the task. & pause & exit /b 1)
echo.
echo Done. Flyx will now start automatically (hidden) each time you sign in to Windows.
echo Starting it now...
wscript.exe "%~dp0flyx-hidden.vbs"
echo.
echo Open http://localhost:8080 to check. To stop auto-start, run uninstall-autostart.bat
pause
