@echo off
rem Starts the Social Listener plugin helper (MCP server) on Windows.
rem Uses the app's private Node.js, or Node 18+ from PATH, or downloads a private copy (no admin).
rem stdout is the MCP channel: everything else goes to stderr.
setlocal
set "SL_NODE_DIR=%LOCALAPPDATA%\social-listener\runtime\node"
set "PNODE=%SL_NODE_DIR%\node.exe"
set "PROXY=%~dp0mcp-proxy.js"
if exist "%PNODE%" goto private
where node >NUL 2>NUL
if errorlevel 1 goto fetch
node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" >NUL 2>NUL
if errorlevel 1 goto fetch
node "%PROXY%"
exit /b %errorlevel%
:fetch
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get-node.ps1" -Dir "%SL_NODE_DIR%" -Wait 25 1>&2
if exist "%PNODE%" goto private
echo [social-listener] Still downloading Node.js in the background. Start a new chat in a minute and it will be ready. 1>&2
exit /b 1
:private
"%PNODE%" "%PROXY%"
exit /b %errorlevel%
