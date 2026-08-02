@echo off
setlocal
cd /d "%~dp0..\server"
if not exist "..\.codex-runtime\multi-asset-monitor" mkdir "..\.codex-runtime\multi-asset-monitor"
call npm.cmd run multi-asset:monitor >> "..\.codex-runtime\multi-asset-monitor\scheduled-task.log" 2>&1
exit /b %ERRORLEVEL%
