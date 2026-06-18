@echo off
chcp 65001 >nul
title 量化行情分析

cd /d "%~dp0"

if not exist "node_modules\" (
    echo [1/2] 安装依赖...
    npm install
)

echo [2/2] 启动开发服务器...
start "" http://localhost:5173
npx vite
pause
