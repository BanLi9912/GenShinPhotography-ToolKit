@echo off
setlocal EnableDelayedExpansion

rem ============================================================
rem  YuanShe ToolKit · 一键启动前端 dev server（Vite, 5173）
rem  双击运行，或在任意终端执行。
rem  运行时优先用仓库内便携 .tools\node（由 install.bat 装好）；
rem  没有便携运行时就回退系统 PATH 里的 Node.js。
rem ============================================================

rem 仓库根目录（本脚本位于 scripts\ 下）
for %%i in ("%~dp0..") do set "ROOT=%%~fi"
set "NODE_DIR=%ROOT%\.tools\node"
set "NODE_EXE="
set "NODE_MODE="

echo [YuanShe] 启动前端 dev server ...

rem 1. 选运行时：便携优先，回退系统 Node（要求 ^20.19.0 或 ^>=22.12.0）
if exist "%NODE_DIR%\node.exe" (
  set "NODE_EXE=%NODE_DIR%\node.exe"
  set "NODE_MODE=便携运行时"
) else (
  for /f "delims=" %%p in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%p"
  )
  if defined NODE_EXE set "NODE_MODE=系统 Node（PATH）"
)

if not defined NODE_EXE (
  echo [错误] 没找到可用的 Node.js：便携运行时 %NODE_DIR%\node.exe 不存在，系统 PATH 里也没有 node。
  echo        请任选其一：
  echo          1^) 运行 scripts\install.bat 装仓库内便携运行时（推荐，不改系统环境）；
  echo          2^) 自行安装 Node.js ^20.19.0 或 ^22.12.0 以上版本并加入 PATH。
  pause
  exit /b 1
)

rem 版本合格线：主版本 20 需次版本 >= 19；21 不合格；22 需次版本 >= 12；23 及以上合格
set "NODE_VER="
set "NODE_MAJ="
set "NODE_MIN="
for /f "tokens=1,2 delims=." %%a in ('"%NODE_EXE%" -v 2^>nul') do (
  set "NODE_VER=%%a.%%b"
  set "NODE_MAJ=%%a"
  set "NODE_MIN=%%b"
)
set "NODE_MAJ=!NODE_MAJ:v=!"
set "NODE_OK=0"
if !NODE_MAJ! EQU 20 if !NODE_MIN! GEQ 19 set "NODE_OK=1"
if !NODE_MAJ! GEQ 22 set "NODE_OK=1"
if "!NODE_OK!"=="0" (
  echo [错误] Node.js 版本不合格：!NODE_VER! ^(需要 ^20.19.0 或 ^>=22.12.0^)
  echo        来源：!NODE_EXE!
  echo        请升级 Node.js，或运行 scripts\install.bat 装合格的便携运行时。
  pause
  exit /b 1
)
echo [YuanShe] 运行时：!NODE_MODE! !NODE_VER! ——!NODE_EXE!

rem 2. 已在运行：直接退出（参数 /nobrowser 跳过打开浏览器）
curl -s -o nul -w "%%{http_code}" --max-time 2 http://localhost:5173/ 2>nul | findstr "^2" >nul
if not errorlevel 1 (
  echo [YuanShe] dev server 已在运行：http://localhost:5173
  if not "%1"=="/nobrowser" start "" "http://localhost:5173"
  exit /b 0
)

rem 3. 新窗口启动（窗口最小化；关闭该窗口等同于停止服务）
if exist "%NODE_DIR%\node.exe" (
  start "YuanShe Dev Server" /min cmd /c "cd /d %ROOT%\web && set PATH=%NODE_DIR%;%PATH% && npm run dev"
) else (
  start "YuanShe Dev Server" /min cmd /c "cd /d %ROOT%\web && npm run dev"
)

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
