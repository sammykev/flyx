@echo off
title Flyx
cd /d "%~dp0"
:loop
node server\server.js
echo.
echo Flyx stopped. Restarting in 5 seconds. Close this window to quit.
timeout /t 5 /nobreak >nul
goto loop
