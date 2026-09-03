@echo off
setlocal

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or 22, then reopen this terminal.
  exit /b 1
)

for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set "AUTOMATON_NODE_MAJOR=%%V"
if not "%AUTOMATON_NODE_MAJOR%"=="20" if not "%AUTOMATON_NODE_MAJOR%"=="22" (
  echo Automaton requires Node.js 20 or 22. Found Node.js %AUTOMATON_NODE_MAJOR%.
  exit /b 1
)

if not exist "%~dp0node_modules\tsx\dist\cli.mjs" (
  echo Dependencies are missing. Run: corepack pnpm install
  exit /b 1
)

if not defined AUTOMATON_VM_BACKEND set "AUTOMATON_VM_BACKEND=wsl"
if not defined AUTOMATON_INFERENCE_URL set "AUTOMATON_INFERENCE_URL=http://127.0.0.1:1234"

node "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\index.ts" %*
exit /b %ERRORLEVEL%
