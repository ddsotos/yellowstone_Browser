@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0online-status.ps1" %*
