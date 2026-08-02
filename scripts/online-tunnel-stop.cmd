@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0online-tunnel-stop.ps1" %*
