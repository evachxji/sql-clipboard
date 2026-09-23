@echo off
chcp 936 >nul
title SQL 剪切板 - 本地开发服务（标准版）
echo ==========================================
echo   SQL 剪切板 本地开发服务（标准版/完整功能）
echo   启动前会重新构建前端为标准版，请耐心等待
echo   关闭应用窗口或按 Ctrl+C 停止服务
echo ==========================================
echo.
cd /d "%~dp0app"

rem tauri.conf 未配 devUrl，tauri dev 直接加载 dist 静态产物；
rem 若 dist 是上次 build:official 的残留，界面就会是正式版。
rem 因此先清掉 VITE_EDITION 并重新构建前端，保证是带 tab 栏的标准版。
set "VITE_EDITION="
echo [1/2] 构建标准版前端...
call npx vite build
if errorlevel 1 (
  echo.
  echo 前端构建失败，按任意键关闭窗口。
  pause >nul
  exit /b 1
)

echo.
echo [2/2] 启动 Tauri 开发服务...
call npm run tauri dev

echo.
echo 服务已停止，按任意键关闭窗口。
pause >nul