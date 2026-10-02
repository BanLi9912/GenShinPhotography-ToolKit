@echo off
setlocal EnableDelayedExpansion

rem ============================================================
rem  YuanShe ToolKit · 导出「只含源码」的分享包
rem
rem  为什么要有这个脚本：
rem    手工"右键压缩整个文件夹"会把 .tools（便携 Node、验收截图、浏览器
rem    profile）、node_modules、模型权重、本地图库登记表一起打进去——
rem    那些东西既没必要，还可能带隐私。本脚本只导出 git 已跟踪的文件。
rem
rem  依赖：git（本脚本用 git archive 决定"什么算源码"）
rem ============================================================

rem 仓库根目录（本脚本位于 scripts\ 下）
for %%i in ("%~dp0..") do set "ROOT=%%~fi"

rem 输出目录：优先用仓库的上一级，不可写则退到 %TEMP%
set "OUTDIR=%ROOT%\.."
set "PROBE=%OUTDIR%\.ystk-write-probe.tmp"
echo probe> "%PROBE%" 2>nul
if not exist "%PROBE%" set "OUTDIR=%TEMP%"
del "%PROBE%" >nul 2>nul

rem 固定文件名：重复运行会覆盖上一次的包（避免在同级目录堆一串同名文件）
set "ZIP=%OUTDIR%\YuanSheToolKit-src.zip"

echo [YuanShe] 导出只含源码的分享包 ...
echo   仓库：%ROOT%
echo   输出：%ZIP%

where git >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 git。本脚本用 git archive 决定导出内容 ^(只含已跟踪文件^)，
  echo        请先安装 git，或在装有 git 的机器上导出。
  pause
  exit /b 1
)

if exist "%ZIP%" del "%ZIP%"
git -C "%ROOT%" archive --format=zip -o "%ZIP%" HEAD web scripts README.md LICENSE .gitignore .gitattributes
if errorlevel 1 (
  echo [错误] 导出失败：请确认仓库里已有提交 ^(git log 能看到至少一条^)。
  pause
  exit /b 1
)
if not exist "%ZIP%" (
  echo [错误] 导出命令结束但没有产出 zip 文件。
  pause
  exit /b 1
)

for %%f in ("%ZIP%") do set "ZSIZE=%%~zf"
set /a ZMB=!ZSIZE!/1048576
for /f "tokens=1 delims=." %%k in ("!ZSIZE!") do set "ZKB=%%k"
set /a ZKB=!ZKB!/1024

echo.
echo [完成] 分享包已生成：
echo        %ZIP%
echo        体积约 !ZMB! MB ^(!ZKB! KB^)
echo.
echo 包内只有源码与说明文档：web\ 与 scripts\ 两棵树 + README.md +
echo LICENSE + .gitignore/.gitattributes。不含：开发历史 ^(.git^)、
echo 便携 Node ^(.tools^)、依赖 ^(node_modules^)、模型权重、本地数据。
echo 朋友拿到后解压到任意目录，运行 scripts\install.bat 即可。
