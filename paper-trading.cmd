@echo off
setlocal
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or 22, then reopen this terminal.
  exit /b 1
)
node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0scripts\paper-trading.ts" %*
exit /b %ERRORLEVEL%
