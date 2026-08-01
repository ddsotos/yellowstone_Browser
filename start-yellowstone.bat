@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 18 or later, then run this file again.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Installing dependencies...
  call npm ci --cache .npm-cache
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo Starting Yellowstone Browser...
start "Yellowstone Browser Server" /D "%~dp0" cmd /k npm run dev -- --host 127.0.0.1 --port 5173 --strictPort

timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5173/"

endlocal
