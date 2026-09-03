@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or 22, then reopen this terminal.
  exit /b 1
)
cd /d "%~dp0"
node node_modules\tsx\dist\cli.mjs scripts\paper-trading-dashboard.ts
endlocal
