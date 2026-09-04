@echo off
setlocal

if not defined AUTOMATON_NODE_EXE set "AUTOMATON_NODE_EXE=node"

if /i "%AUTOMATON_NODE_EXE%"=="node" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js was not found. Install Node.js 20 or 22, then reopen this terminal.
    exit /b 1
  )
) else if not exist "%AUTOMATON_NODE_EXE%" (
  echo The configured Node.js executable was not found: %AUTOMATON_NODE_EXE%
  exit /b 1
)

"%AUTOMATON_NODE_EXE%" -e "process.exit(['20','22'].includes(process.versions.node.split('.')[0]) ? 0 : 1)"
if errorlevel 1 (
  echo Automaton requires Node.js 20 or 22. Set AUTOMATON_NODE_EXE to a supported node.exe.
  exit /b 1
)

if not exist "%~dp0node_modules\tsx\dist\cli.mjs" (
  echo Dependencies are missing. Run: corepack pnpm install
  exit /b 1
)

if not defined AUTOMATON_VM_BACKEND set "AUTOMATON_VM_BACKEND=wsl"
if not defined AUTOMATON_INFERENCE_URL set "AUTOMATON_INFERENCE_URL=http://127.0.0.1:1235"
if not defined AUTOMATON_GEMMA_CONTEXT_LENGTH set "AUTOMATON_GEMMA_CONTEXT_LENGTH=24576"
if not defined AUTOMATON_IDLE_SLEEP_MS set "AUTOMATON_IDLE_SLEEP_MS=600000"

"%AUTOMATON_NODE_EXE%" "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0src\index.ts" %*
exit /b %ERRORLEVEL%
