@echo off
chcp 936 >nul
title SQL 剪切板 - 一键打包
echo ==========================================
echo   SQL 剪切板 一键打包（标准版 + 正式版）
echo   产物输出到 便携版\ 目录，两个 exe 共用同目录数据库
echo   全程约需几分钟（两次 release 编译），请勿关闭窗口
echo ==========================================
echo.
cd /d "%~dp0app"
if not exist "..\便携版" mkdir "..\便携版"

rem ---------- 1. 标准版 ----------
rem 显式清空 VITE_EDITION，防止环境污染把标准版打成正式版
set "VITE_EDITION="
echo [1/2] 打包标准版（含 tab 栏与连接侧栏）...
call npm run tauri build
if errorlevel 1 goto :fail
if not exist "src-tauri\target\release\sql-clipboard.exe" (
  echo 未找到标准版产物 exe
  goto :fail
)
rem 运行中的 exe 会被 Windows 锁定无法覆盖（本应用可用全局快捷键隐藏窗口，
rem 窗口不见 + 进程还在），覆盖前先结束同名进程
taskkill /f /im sql-clipboard.exe >nul 2>&1
copy /y "src-tauri\target\release\sql-clipboard.exe" "..\便携版\sql-clipboard.exe" >nul
if errorlevel 1 goto :fail
echo       已输出 便携版\sql-clipboard.exe
echo.

rem ---------- 2. 正式版 ----------
rem build:official 内部会 set VITE_EDITION=official，Rust 端经 option_env! 识别并启用 IP 白名单
echo [2/2] 打包正式版（无 tab 栏，含 IP 白名单）...
call npm run build:official
if errorlevel 1 goto :fail
if not exist "src-tauri\target\release\sql-clipboard.exe" (
  echo 未找到正式版产物 exe
  goto :fail
)
taskkill /f /im sql-clipboard-正式版.exe >nul 2>&1
copy /y "src-tauri\target\release\sql-clipboard.exe" "..\便携版\sql-clipboard-正式版.exe" >nul
if errorlevel 1 goto :fail
echo       已输出 便携版\sql-clipboard-正式版.exe
echo.

rem ---------- 收尾 ----------
rem 正式版打包会在 dist 留下正式版前端，而 tauri dev 直接加载 dist，
rem 这里重建一次标准版前端，避免下次 start.cmd / tauri dev 误开正式版界面
set "VITE_EDITION="
call npx vite build >nul 2>&1

echo ==========================================
echo   打包完成！产物位于 便携版\
echo     sql-clipboard.exe        标准版
echo     sql-clipboard-正式版.exe  正式版
echo ==========================================
pause
exit /b 0

:fail
echo.
echo ==========================================
echo   打包失败，请检查上方错误信息
echo ==========================================
pause
exit /b 1