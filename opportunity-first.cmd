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
"%AUTOMATON_NODE_EXE%" "%~dp0node_modules\tsx\dist\cli.mjs" "%~dp0scripts\opportunity-first.ts" %*
exit /b %ERRORLEVEL%
