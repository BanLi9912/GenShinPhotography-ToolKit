@echo off
setlocal

rem ============================================================
rem  YuanShe ToolKit · 一键停止前端 dev server（Vite, 5173）
rem  双击运行，或在任意终端执行；按端口结束进程，无需记住 PID
rem ============================================================

echo [YuanShe] 停止前端 dev server ...
set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo        结束进程 PID=%%a
  taskkill /PID %%a /F >nul 2>&1
)

if "%FOUND%"=="1" (
  echo [YuanShe] 已停止。（"YuanShe Dev Server" 窗口会随之自动关闭）
) else (
  echo [YuanShe] dev server 未在运行，无需停止。
)
