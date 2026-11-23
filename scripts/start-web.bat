@echo off
setlocal EnableDelayedExpansion

rem ============================================================
rem  YuanShe ToolKit · 一键启动前端 dev server（Vite, 5173）
rem  双击运行，或在任意终端执行；自动使用 .tools\node 便携运行时
rem ============================================================

rem 仓库根目录（本脚本位于 scripts\ 下）
for %%i in ("%~dp0..") do set "ROOT=%%~fi"
set "NODE_DIR=%ROOT%\.tools\node"

echo [YuanShe] 启动前端 dev server ...

rem 1. 检查便携 Node.js 运行时
if not exist "%NODE_DIR%\node.exe" (
  echo [错误] 未找到便携 Node.js：%NODE_DIR%
  echo        请恢复 .tools\node，或自行安装 Node.js 并加入 PATH 后重试。
  pause
  exit /b 1
)

rem 2. 已在运行：直接退出（参数 /nobrowser 跳过打开浏览器）
curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:5173/ 2>nul | findstr "^2" >nul
if not errorlevel 1 (
  echo [YuanShe] dev server 已在运行：http://localhost:5173
  if not "%1"=="/nobrowser" start "" "http://localhost:5173"
  exit /b 0
)

rem 3. 新窗口启动（窗口最小化；关闭该窗口等同于停止服务）
start "YuanShe Dev Server" /min cmd /c "cd /d %ROOT%\web && set PATH=%NODE_DIR%;%PATH% && npm run dev"

rem 4. 等待就绪（最多 30 秒；curl 带 2s 超时，每 5 秒打一次进度）
set /a TRIES=0
:wait
ping -n 2 127.0.0.1 >nul
curl -s -o nul --max-time 2 http://localhost:5173/ 2>nul
if not errorlevel 1 goto ready
set /a TRIES+=1
set /a MOD=!TRIES! %% 5
if !MOD! EQU 0 echo [YuanShe] 等待就绪（!TRIES!/30）...
if !TRIES! GEQ 30 (
  echo [错误] 30 秒内未能启动，请查看任务栏 "YuanShe Dev Server" 窗口内的日志。
  exit /b 1
)
goto wait

:ready
echo [YuanShe] 已启动：http://localhost:5173
echo           提示：任务栏的 "YuanShe Dev Server" 窗口保持运行即服务在线，关闭它即停止。
if not "%1"=="/nobrowser" start "" "http://localhost:5173"
