@echo off
setlocal
cd /d "%~dp0"
set "MARKET_NODE=node"
if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "MARKET_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%MARKET_NODE%" -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13)){console.error('Node.js 22.13+ required. Install Node.js 24 LTS.');process.exit(1)}"
if errorlevel 1 goto failed
if not exist "node_modules\express" goto missing
if not exist "dist\index.html" goto missing
echo Open http://127.0.0.1:3400 in your browser. Press Ctrl+C to stop.
"%MARKET_NODE%" --env-file-if-exists=.env server/index.mjs
goto end
:missing
echo First install dependencies and build: pnpm install --frozen-lockfile and pnpm build
:failed
pause
:end
endlocal
