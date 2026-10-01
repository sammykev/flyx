@echo off
rem Right-click this file and choose "Run as administrator" so your iPhone can reach Flyx.
netsh advfirewall firewall add rule name="Flyx" dir=in action=allow protocol=TCP localport=8080 profile=private
pause
