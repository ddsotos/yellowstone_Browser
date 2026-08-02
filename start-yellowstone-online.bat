@echo off
setlocal
cd /d "%~dp0"
if "%ONLINE_PORT%"=="" set ONLINE_PORT=9293
echo Starting Yellowstone online server on http://localhost:%ONLINE_PORT%/?online=1
npm run online
