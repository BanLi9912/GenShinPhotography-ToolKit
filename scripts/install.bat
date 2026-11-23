@echo off
rem ===================================================================
rem  YuanShe ToolKit · 一键安装脚本（install.bat）
rem
rem  用途：给"只发源码"的安装包一条一键安装路径。
rem    ① 环境探测（只读）：逐项打印 ?/? 与详情
rem    ② 必需组件确认（默认 N）→ ③ 安装（便携 Node + npm 依赖 + predev 自检）
rem    ④ 可选线 A · 纹理保全（Kim2091 SuperScale 1x + AnimeSharpV4 2x）
rem    ⑤ 可选线 B · CUGAN 3x/4x 六档（全自动：Python + venv/torch + 权重 + 本地转换）
rem    ⑥ 询问是否立即启动
rem
rem  参数模式：无参 = 交互全流程；/texture 只装纹理线；/cugan 只装 CUGAN 线；
rem            可组合（/texture /cugan）。参数模式跳过无关询问，但每条线的安装
rem            动作前仍要确认（默认 N）。设置面板「模块组件」即用参数模式调用。
rem            /clean 追加"转换完清掉 Python 工具链"（venv + 仓库内 pip 缓存 + 原始权重）；
rem            不带 /clean 时，只要本轮用过 venv，收尾会问一次（默认 N 不删）。
rem
rem  被面板调用时的形态（2026-09-17 A 审查裁定）：**后台运行、不弹窗口**——
rem    中间件用 `cmd.exe /c chcp 936 >nul && "…\install.bat" /<target>` 后台拉起本脚本，
rem    stdout/stderr 全量落 scripts\install-<target>.log；面板 toast 会把该日志路径带出来，
rem    完成后由用户在面板点「重新检测」看结果。故本脚本**不得**假设自己有可见窗口：
rem    提示语一律写"日志文件"与"手动启动方法"，不要写"本窗口/保持窗口开启"。
rem
rem  许可边界（PR-011，硬约束）：本脚本不内置、不转存、不自托管任何权重字节，
rem    只携带权利人官方渠道 URL（HuggingFace / ModelScope / GitHub Release）；
rem    每个最终用户从权利人处下载、本地转换、本地使用。
rem    · Kim2091（SuperScale 1x / AnimeSharpV4 2x）：CC BY-NC-SA 4.0，非商用、仅本地使用。
rem    · Real-CUGAN（bilibili）：上游 GitHub 无 LICENSE 文件，ModelScope 官方仓库含
rem      LICENSE，以其为准。
rem
rem  编码纪律：本文件必须 GBK + CRLF（同 start-web.bat / stop-web.bat）。
rem ===================================================================
setlocal EnableDelayedExpansion
if not defined YSTK_INSTALL_NOCP chcp 936 >nul 2>nul
title YuanShe ToolKit 安装脚本
rem YSTK_INSTALL_NOCP=1 供自动化测试用：中文提示固定 GBK，测试时控制台已按 GBK 解码，
rem 再 chcp 一次会让「重定向 stdin 喂 Y/N」读不到内容（实测），所以留这个开关。

rem ---- 顶部常量 ------------------------------------------------------
set "NODE_VER=24.18.0"
set "NODE_MIRROR=https://registry.npmmirror.com/-/binary/node"
set "NODE_OFFICIAL=https://nodejs.org/dist"
set "NPM_REGISTRY=https://registry.npmmirror.com"
rem Phase 0（2026-09-16）实测结论：huggingface.co 在部分网络不可达，官方镜像 hf-mirror.com
rem 可达且内容同源（同一仓库同一文件），故 HF 主源用镜像、回退官方域名。
set "HF_MIRROR=https://hf-mirror.com"
set "HF_OFFICIAL=https://huggingface.co"
rem Real-CUGAN 官方 ModelScope 渠道（权重 .pth；我们不自托管）
set "MS_BASE=https://www.modelscope.cn/models/bilibili/cv_bilibili_image-super-resolution/resolve/master/weights_v3"
rem Kim2091 官方 GitHub Release 渠道（原始 .safetensors；纹理线 Python 兜底用）
rem 实测（2026-09-16）：github.com 在部分网络不可达，先直连、失败再走两个公共 GitHub 代理回退。
set "KIM_RELEASE=https://github.com/Kim2091/Kim2091-Models/releases/download"
set "GH_PROXY1=https://ghproxy.net/"
set "GH_PROXY2=https://gh-proxy.com/"
rem 国内 PyPI 镜像（torch 除外——torch 优先走官方 CPU 源）
set "PIP_MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple"
rem 官方 whl/cpu 的国内镜像（上海交大，内容与官方一致：实测有 torch-2.14.0+cpu 的 win 轮子）
rem —— 官方源 download-r2.pytorch.org 抖的时候用它，装到的是同一个版本，不会降级。
set "PYTORCH_MIRROR=https://mirror.sjtu.edu.cn/pytorch-wheels/cpu/"

rem ---- 路径 ----------------------------------------------------------
rem 本脚本位于 <仓库根>\scripts\，仓库根 = 上一级
set "ROOT=%~dp0.."
pushd "%ROOT%" || (echo [错误] 无法进入仓库根目录：%ROOT% & pause & exit /b 1)
set "ROOT=%CD%"
set "WEBDIR=%ROOT%\web"
set "TOOLSDIR=%ROOT%\.tools"
set "NODEDIR=%TOOLSDIR%\node"
set "SHEETDIR=%WEBDIR%\scripts\convert-sr-models"
set "WEIGHTDIR=%SHEETDIR%\weights"
set "VENVDIR=%SHEETDIR%\.venv"
set "VENVPY=%VENVDIR%\Scripts\python.exe"
rem pip 缓存改落在仓库内（2026-09-17 用户需求：一次性转换后把工具链清干净）——
rem pip 默认缓存 %LOCALAPPDATA%\pip\cache（torch 轮子 ~124MB 就在里面），删 .venv 带不走它；
rem 指到本目录后，「清除转换工具链」一次 rm 就能把 venv + 缓存一起回收。目录已 gitignore。
set "PIPCACHE=%SHEETDIR%\.pip-cache"
set "SRMODELDIR=%WEBDIR%\sr-models"
set "ASSETDIR=%WEBDIR%\public\superres-assets"
set "LOGDIR=%ROOT%\scripts"
rem 转换链路启用标记（本轮真的建过/用过 venv 才在收尾问「要不要清掉」）
set "VENV_TOUCHED=0"

rem ---- 参数解析 ------------------------------------------------------
set "ONLY_TEXTURE=0"
set "ONLY_CUGAN=0"
set "HAS_PARAM=0"
set "WANT_CLEAN=0"
:parse_args
if "%~1"=="" goto args_done
if /i "%~1"=="/texture" (set "ONLY_TEXTURE=1" & set "HAS_PARAM=1" & shift & goto parse_args)
if /i "%~1"=="/cugan" (set "ONLY_CUGAN=1" & set "HAS_PARAM=1" & shift & goto parse_args)
rem /clean：转换做完后直接清掉 Python 转换工具链（venv + pip 缓存 + 原始权重），不再询问
if /i "%~1"=="/clean" (set "WANT_CLEAN=1" & set "HAS_PARAM=1" & shift & goto parse_args)
if /i "%~1"=="/?" goto usage
if /i "%~1"=="/help" goto usage
echo [错误] 未知参数：%~1
goto usage

:usage
echo.
echo 用法：install.bat [/texture] [/cugan] [/clean]
echo   无参数      交互全流程（必需组件 + 两条可选线逐条询问）
echo   /texture    只装可选线 A「纹理保全」
echo   /cugan      只装可选线 B「CUGAN 3x/4x」
echo   /texture /cugan  两条可选线都装
echo   /clean      转换做完后清掉 Python 转换工具链（venv + pip 缓存 + 原始权重）
echo               ——可选模型是一次性转换，之后运行不再需要 Python；
echo                 代价：以后要再装可选模型得重下 ~1.3GB 工具链
echo.
echo 注意：任何安装动作前都会再次确认（默认 N，回车即取消）。
pause
popd
exit /b 1

:args_done
rem 参数模式：只装被点名的线；无参数：全流程
set "WANT_TEXTURE=1"
set "WANT_CUGAN=1"
set "WANT_REQUIRED=1"
if "%HAS_PARAM%"=="1" (
  set "WANT_REQUIRED=0"
  if "%ONLY_TEXTURE%"=="1" (set "WANT_TEXTURE=1") else (set "WANT_TEXTURE=0")
  if "%ONLY_CUGAN%"=="1" (set "WANT_CUGAN=1") else (set "WANT_CUGAN=0")
)

echo ===================================================================
echo  YuanShe ToolKit · 安装脚本
echo  仓库：%ROOT%
if "%HAS_PARAM%"=="1" echo  模式：参数模式（只装点名的可选线，安装动作前仍会确认）
if "%WANT_CLEAN%"=="1" echo  附加：转换完成后清除 Python 转换工具链（/clean）
echo ===================================================================
echo.

rem ===================================================================
rem  ① 环境探测（只读）
rem ===================================================================
echo [① 环境探测]

rem --- 1. Windows / x64 ---
set "ARCH=%PROCESSOR_ARCHITECTURE%"
set "PLATFORM_OK=1"
if /i not "%ARCH%"=="AMD64" set "PLATFORM_OK=0"
if /i "%ARCH%"=="x86" if defined PROCESSOR_ARCHITEW6432 set "PLATFORM_OK=1"
if "%PLATFORM_OK%"=="1" (
  echo   [√] 系统架构：Windows / %ARCH%
) else (
  echo   [×] 系统架构：%ARCH%（仅提供 Windows x64 的便携 Node 便携包）
  echo       本脚本无法在此架构继续，请手动安装 Node 20.19.0 或 22.12.0 以上版本后运行 npm install。
  popd
  pause
  exit /b 1
)

rem --- 2. 仓库根所在盘剩余空间 ---
rem 用 PowerShell 的 PSDrive.Free（不用 CIM/WMI：部分机器与受限环境里 Get-CimInstance 会被拒绝）
set "DRIVE=%ROOT:~0,2%"
set "FREEGB=?"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "[math]::Round((Get-Item '%DRIVE%\').PSDrive.Free/1GB,1)" 2^>nul`) do set "FREEGB=%%A"
echo   [i]  %DRIVE% 剩余空间：%FREEGB% GB
for /f "delims=." %%N in ("%FREEGB%") do set "FREEGB_INT=%%N"
set "SPACE_LOW=0"
if %FREEGB_INT% GEQ 0 if %FREEGB_INT% LSS 2 set "SPACE_LOW=1"
if "%SPACE_LOW%"=="1" echo        [警告] 低于 2GB，必需组件（约 330MB）可能装不下

rem --- 3. 工具可用性 ---
set "HAS_CURL=0"
set "HAS_TAR=0"
set "HAS_PS=0"
set "HAS_WINGET=0"
where curl.exe >nul 2>nul && set "HAS_CURL=1"
where tar.exe >nul 2>nul && set "HAS_TAR=1"
where powershell.exe >nul 2>nul && set "HAS_PS=1"
where winget.exe >nul 2>nul && set "HAS_WINGET=1"
if "%HAS_CURL%"=="1" (echo   [√] curl：可用（下载主通道）) else (echo   [×] curl：不可用（回退 PowerShell 下载）)
if "%HAS_TAR%"=="1" (echo   [√] tar：可用（解压主通道）) else (echo   [×] tar：不可用（回退 PowerShell 解压）)
if "%HAS_PS%"=="1" (echo   [√] PowerShell：可用) else (echo   [×] PowerShell：不可用（下载/解压回退通道受限）)
if "%HAS_WINGET%"=="1" (echo   [√] winget：可用（可选线 B 自动装 Python 用）) else (echo   [×] winget：不可用（可选线 B 回退 python.org 静默安装包）)
if "%HAS_CURL%%HAS_PS%"=="00" (
  echo   [×] 既无 curl 也无 PowerShell，无法下载任何组件。
  popd
  pause
  exit /b 1
)

rem --- 4. 系统 Node（PATH）---
set "SYSNODE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined SYSNODE set "SYSNODE=%%N"
if defined SYSNODE (
  for /f "delims=" %%V in ('node -v 2^>nul') do set "SYSNODE_VER=%%V"
  echo   [i]  系统 Node：!SYSNODE_VER!  （!SYSNODE!）
  echo       本脚本不使用系统 Node，统一用仓库内便携运行时 .tools\node
) else (
  echo   [i]  系统 Node：未安装（本脚本用仓库内便携运行时，无需系统 Node）
)

rem --- 5. 便携 Node ---
set "NODE_OK=0"
set "NODE_NOW="
if exist "%NODEDIR%\node.exe" (
  for /f "delims=" %%V in ('"%NODEDIR%\node.exe" -v 2^>nul') do set "NODE_NOW=%%V"
  if defined NODE_NOW (
    set "NV=!NODE_NOW:v=!"
    for /f "tokens=1,2 delims=." %%A in ("!NV!") do (
      set "NMAJ=%%A"
      set "NMIN=%%B"
    )
    if !NMAJ!==20 if !NMIN! GEQ 19 set "NODE_OK=1"
    if !NMAJ!==21 set "NODE_OK=0"
    if !NMAJ!==22 if !NMIN! GEQ 12 set "NODE_OK=1"
    if !NMAJ! GTR 22 set "NODE_OK=1"
  )
)
if "%NODE_OK%"=="1" (
  rem 注意：echo 文本里禁止出现 ^( ) ^> ^< ^& ^| 这类组合（cmd 解析优先级会把括号当成命令块）
  echo   [√] 便携 Node：!NODE_NOW!  ——版本合格，要求 ^20.19.0 或 ^>=22.12.0
) else (
  if defined NODE_NOW (
    echo   [×] 便携 Node：!NODE_NOW!  ——版本不合格，要求 ^20.19.0 或 ^>=22.12.0
  ) else (
    echo   [×] 便携 Node：未安装  ——%NODEDIR%\node.exe 不存在
  )
  echo       缺它 start-web.bat / stop-web.bat 无法启动（两脚本硬依赖 .tools\node）
)

rem --- 6. npm 依赖 ---
set "DEPS_OK=1"
set "DEPS_MISSING="
for %%P in (vite onnxruntime-web upscalejs) do (
  if exist "%WEBDIR%\node_modules\%%P\package.json" echo   [√] npm 依赖：%%P 已就位
  if not exist "%WEBDIR%\node_modules\%%P\package.json" echo   [×] npm 依赖：%%P 缺失
  if not exist "%WEBDIR%\node_modules\%%P\package.json" set "DEPS_OK=0"
  if not exist "%WEBDIR%\node_modules\%%P\package.json" set "DEPS_MISSING=!DEPS_MISSING! %%P"
)

rem --- 7. 超分 2x 资产 ---
set "ASSET2X_OK=1"
set "ASSET2X_MISSING="
for %%F in (up2x-latest-no-denoise.onnx up2x-latest-denoise1x.onnx up2x-latest-denoise2x.onnx up2x-latest-denoise3x.onnx up2x-latest-conservative.onnx) do (
  if not exist "%ASSETDIR%\models\%%F" (set "ASSET2X_OK=0" & set "ASSET2X_MISSING=!ASSET2X_MISSING! %%F")
)
for %%F in (ort.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm ort-wasm-simd-threaded.jsep.mjs ort-wasm-simd-threaded.jsep.wasm) do (
  if not exist "%ASSETDIR%\js\%%F" (set "ASSET2X_OK=0" & set "ASSET2X_MISSING=!ASSET2X_MISSING! %%F")
)
if "%ASSET2X_OK%"=="1" (
  echo   [√] 超分 2x 资产：public\superres-assets 齐备（predev 生成）
) else (
  echo   [×] 超分 2x 资产：缺!ASSET2X_MISSING!
  echo       装完 npm 依赖后由 npm run predev 自动生成
)

rem --- 8. 系统 Python（可选线 B 用）---
set "PYEXE="
set "PY_VER="
for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if defined PYEXE (
  for /f "tokens=2" %%V in ('python --version 2^>^&1') do set "PY_VER=%%V"
)
set "PY_OK=0"
if defined PY_VER (
  for /f "tokens=1,2 delims=." %%A in ("!PY_VER!") do (set "PYMAJ=%%A" & set "PYMIN=%%B")
  if !PYMAJ! GEQ 3 if !PYMIN! GEQ 10 set "PY_OK=1"
)
if "%PY_OK%"=="1" (
  echo   [√] 系统 Python：!PY_VER!  （!PYEXE!，可选线 B 直接复用）
) else (
  if defined PY_VER (
    echo   [×] 系统 Python：!PY_VER!  ——版本过低，需要 3.10 或更高
  ) else (
    echo   [×] 系统 Python：未安装
  )
  echo       仅可选线 B（CUGAN 3x/4x 权重转换）需要；应用运行本身不需要 Python
)

rem --- 9. 转换 venv（可选线 B 用）---
set "VENV_OK=0"
if exist "%VENVPY%" (
  "%VENVPY%" -c "import torch" >nul 2>nul && set "VENV_OK=1"
)
if "%VENV_OK%"=="1" (
  echo   [√] 转换 venv：%VENVDIR%（torch 可导入）
) else (
  if exist "%VENVPY%" (
    echo   [×] 转换 venv：存在但 torch 不可导入
  ) else (
    echo   [×] 转换 venv：未创建
  )
  echo       仅可选线 B 需要（隔离环境，不装系统 Python 包）
)

rem --- 10. 已有权重 / 产物 ---
echo   [i]  已有原始权重（%WEIGHTDIR%）：
set "W_COUNT=0"
if exist "%WEIGHTDIR%" for %%F in ("%WEIGHTDIR%\*.pth" "%WEIGHTDIR%\*.safetensors") do (
  if exist "%%~fF" (set /a W_COUNT+=1 & echo        %%~nxF)
)
if "%W_COUNT%"=="0" echo        （无）
echo   [i]  已有超分产物（%SRMODELDIR%）：
set "M_COUNT=0"
if exist "%SRMODELDIR%" for %%F in ("%SRMODELDIR%\*.onnx") do (set /a M_COUNT+=1 & echo        %%~nxF)
if "%M_COUNT%"=="0" echo        （无）

rem --- 11. Ollama（可选，指引不代装）---
rem 纪律：echo 文本里绝不出现半角右括号——单行 if ... (echo ...) else (echo ...) 会被它提前闭合
rem 括号块（开发期踩过：报"命令语法不正确"后整段中断）。这里改用 errorlevel 分支，最稳。
where ollama.exe >nul 2>nul
if not errorlevel 1 echo   [i]  Ollama：已安装，向量搜索可用
if errorlevel 1 echo   [i]  Ollama：未安装，不装则向量搜索自动回落词典引擎，不影响其它功能

rem --- 12. Chromium 浏览器 ---
set "BROWSER="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=Chrome"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=Chrome"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=Edge"
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=Edge"
if defined BROWSER (
  echo   [√] Chromium 浏览器：!BROWSER!（图库绑定用 FSA，需 Chromium 系 + localhost）
) else (
  echo   [×] Chromium 浏览器：未在常见路径找到 Chrome/Edge
  echo       图库绑定（选择文件夹）只支持 Chromium 系浏览器，请自行安装（本脚本不代装）
)
echo.

rem ===================================================================
rem  ② 必需组件汇总确认
rem ===================================================================
set "NEED_REQUIRED=0"
if "%NODE_OK%"=="0" set "NEED_REQUIRED=1"
if "%DEPS_OK%"=="0" set "NEED_REQUIRED=1"

if "%WANT_REQUIRED%"=="0" goto skip_required_block
if "%NEED_REQUIRED%"=="0" (
  echo [② 必需组件] 全部已就绪（便携 Node + npm 依赖），无需安装。
  goto after_required
)

echo [② 必需组件] 待安装：
if "%NODE_OK%"=="0" echo     · 便携 Node.js %NODE_VER%（→ .tools\node，解压即用，不改系统 PATH）
if "%DEPS_OK%"=="0" echo     · web 目录 npm 依赖（约 330MB，含超分 2x 权重来源 upscalejs）
echo   下载源：镜像优先（registry.npmmirror.com），失败回退官方源
echo   预计耗时：视网速 3-15 分钟
set "ANS="
set /p "ANS=确认开始安装必需组件？(Y/N，直接回车 = N): "
if /i not "!ANS!"=="Y" (
  echo   已跳过必需组件安装。
  goto after_required
)
call :do_required
:after_required
if "%WANT_REQUIRED%"=="0" echo [② 必需组件] 参数模式：跳过（脚本只负责点名的可选线）。

:skip_required_block
echo.

rem ===================================================================
rem  ④ 可选线 A · 纹理保全（SuperScale 1x + AnimeSharpV4 2x）
rem ===================================================================
if "%WANT_TEXTURE%"=="0" goto skip_texture
echo [④ 可选线 A] 纹理保全：1x-SuperScale（抗锯齿）+ AnimeSharpV4 2x（纹理锐化）
set "TEX_HAVE=0"
set "TEX_NEED=0"
if exist "%SRMODELDIR%\superscale-1x.onnx" (set /a TEX_HAVE+=1) else (set "TEX_NEED=1")
if exist "%SRMODELDIR%\animesharpv4-2x.onnx" (set /a TEX_HAVE+=1) else (set "TEX_NEED=1")
if "%TEX_NEED%"=="0" (
  echo   两个模型已就位（%SRMODELDIR%），跳过。
  goto after_texture
)
echo   现状：已就位 %TEX_HAVE%/2
echo   来源：模型作者 Kim2091 的官方渠道（HuggingFace 官方 safetensors / GitHub Release）
echo         允许证：CC BY-NC-SA 4.0（非商用；仅本地使用，请勿再分发）
echo   体积：约 33MB 原始权重（另需 Python 转换工具链，首次约 200MB；已装则复用）
echo   流程：两个模型都在本地转换（作者未提供可直接用的 ONNX），convert.py 自带数值校验
echo   预计耗时：3-10 分钟（含首次装转换工具链）
set "ANS="
set /p "ANS=确认安装纹理保全线？(Y/N，直接回车 = N): "
if /i not "!ANS!"=="Y" (
  echo   已跳过纹理保全线。
  goto after_texture
)
call :do_texture
:after_texture
if "%WANT_TEXTURE%"=="1" echo.
:skip_texture

rem ===================================================================
rem  ⑤ 可选线 B · CUGAN 3x/4x（全自动，含 Python）
rem ===================================================================
if "%WANT_CUGAN%"=="0" goto skip_cugan
echo [⑤ 可选线 B] CUGAN 3x/4x 六档（no-denoise / denoise3x / conservative × 3x、4x）
set "CU_HAVE=0"
set "CU_NEED=0"
for %%F in (up3x-latest-no-denoise up3x-latest-denoise3x up3x-latest-conservative up4x-latest-no-denoise up4x-latest-denoise3x up4x-latest-conservative) do (
  if exist "%SRMODELDIR%\%%F.onnx" (set /a CU_HAVE+=1) else (set "CU_NEED=1")
)
if "%CU_NEED%"=="0" (
  echo   六档模型已就位（%SRMODELDIR%），跳过。
  goto after_cugan
)
echo   现状：已就位 %CU_HAVE%/6
echo   流程：装 Python（已装则跳过）→ 建隔离 venv + torch CPU → 官方渠道下载 6 个 .pth
echo         → 本地转换，convert.py 自带 onnx.checker 校验 + 与 PyTorch 数值对照，max abs diff 小于 1e-3
echo   来源：权重来自 bilibili 官方 ModelScope 渠道；本地转换、本地使用
echo   体积：约 1GB+（torch CPU 轮子约 200MB + 依赖 + 权重约 60MB）
echo   耗时：10-30 分钟（取决于网速与 CPU）
echo   注：转换只在装可选模型时跑一次，与应用日常运行无关
set "ANS="
set /p "ANS=确认安装 CUGAN 3x/4x 线？(Y/N，直接回车 = N): "
if /i not "!ANS!"=="Y" (
  echo   已跳过 CUGAN 3x/4x 线。
  goto after_cugan
)
call :do_cugan
:after_cugan
if "%WANT_CUGAN%"=="1" echo.
:skip_cugan

rem ===================================================================
rem  ⑥ 完成后：可选清理转换工具链 → 可选启动
rem ===================================================================
echo ===================================================================
echo  安装流程结束。
echo ===================================================================

rem ---- 可选：清除 Python 转换工具链（2026-09-17 用户需求）----
rem 可选模型是"一次性转换"：转换完成后再也不需要 Python。这里把工具链回收掉，
rem 回收对象三块：.venv（~1.3GB）+ 仓库内 pip 缓存（~170MB）+ 原始权重（~69MB，重下很便宜）。
rem 只在本轮真的用过 venv 时询问；/clean 参数则跳过询问直接清。
if "%WANT_CLEAN%"=="1" (
  rem R4（2026-09-24）：/clean 语义 = 用户明确要求清，不再受 VENV_TOUCHED 门槛限制——
  rem "上次会话装的工具链、这次单独跑 /clean" 是合法用法（子过程对不存在目录已各打 [跳过]，幂等）。
  call :clean_toolchain
) else (
  if "%VENV_TOUCHED%"=="1" (
    call :toolchain_size
    echo.
    echo [⑥ 可选清理] Python 转换工具链只用于"把官方权重转成 onnx"，本机转换已完成：
    echo     · .venv（torch/onnx 工具链）约 !VENV_MB! MB
    echo     · 仓库内 pip 缓存            —— 随 .venv 一起清
    echo     · 原始权重（weights）约 !WT_MB! MB
    echo   清掉后运行工具箱完全不受影响（引擎只读 public\superres-assets 里的 onnx）。
    echo   代价：以后若还要装别的可选模型，得重新下 ~1.3GB 工具链。
    set "ANS="
    set /p "ANS=现在清除 Python 转换工具链？(Y/N，直接回车 = N): "
    if /i "!ANS!"=="Y" (
      call :clean_toolchain
    ) else (
      echo   已保留转换工具链（以后不会再用到，可随时手动删：!VENVDIR!）
    )
  )
)

set "ANS="
set /p "ANS=现在启动 YuanShe ToolKit 开发服务器？(Y/N，直接回车 = N): "
if /i "!ANS!"=="Y" (
  echo   正在调用 scripts\start-web.bat …
  call "%ROOT%\scripts\start-web.bat"
) else (
  rem 参数模式（面板后台调用）下 stdin 已关闭，这里必然走到本分支——提示写"手动启动
  rem 方法"，不要写"本窗口"之类（面板不弹窗口，A 审查 2026-09-17 裁定）。
  echo   手动启动方法：双击 scripts\start-web.bat（或在命令行执行）
)
popd
endlocal
echo.
pause
exit /b 0

rem ===================================================================
rem  子过程
rem ===================================================================

rem ---------------------------------------------------------------
rem ③ 安装必需组件：便携 Node + npm 依赖 + predev 自检
rem ---------------------------------------------------------------
:do_required
rem --- 便携 Node ---
if "%NODE_OK%"=="1" (
  echo   [跳过] 便携 Node 已就位：!NODE_NOW!
  goto req_npm
)
if exist "%NODEDIR%\node.exe" (
  echo   [替换] 现有便携 Node 版本不合格，旧目录改名为 .tools\node.old
  if exist "%TOOLSDIR%\node.old" rd /s /q "%TOOLSDIR%\node.old"
  move "%NODEDIR%" "%TOOLSDIR%\node.old" >nul
) else (
  if exist "%NODEDIR%" (
    echo   [清理] .tools\node 存在但没有 node.exe（多为上次中断残留），删除后重装 …
    rd /s /q "%NODEDIR%"
  )
)
if not exist "%TOOLSDIR%" mkdir "%TOOLSDIR%"
set "NODEZIP=%TOOLSDIR%\node-v%NODE_VER%-win-x64.zip"
set "NODE_GOT=0"

echo   [下载] 便携 Node v%NODE_VER%（镜像主 → 官方回退）
if "%HAS_CURL%"=="1" (
  call :dl "%NODE_MIRROR%/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip" "%NODEZIP%" && set "NODE_GOT=1"
  if "!NODE_GOT!"=="0" (
    echo         镜像失败，回退官方源 nodejs.org …
    call :dl "%NODE_OFFICIAL%/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip" "%NODEZIP%" && set "NODE_GOT=1"
  )
) else (
  call :psdl "%NODE_MIRROR%/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip" "%NODEZIP%" && set "NODE_GOT=1"
  if "!NODE_GOT!"=="0" call :psdl "%NODE_OFFICIAL%/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip" "%NODEZIP%" && set "NODE_GOT=1"
)
if "!NODE_GOT!"=="0" (
  echo   [失败] 便携 Node 下载失败（镜像与官方源都不可达）。
  echo          可手动下载 https://nodejs.org/dist/v%NODE_VER%/node-v%NODE_VER%-win-x64.zip
  echo          解压后把 node-v%NODE_VER%-win-x64 目录改名为 node 放进 %TOOLSDIR%
  goto req_fail
)
for %%S in ("%NODEZIP%") do set "NODEZIPSIZE=%%~zS"
if !NODEZIPSIZE! LSS 20000000 (
  echo   [失败] 下载包异常 ——!NODEZIPSIZE! 字节，小于 20MB，删除后请重跑本脚本
  del /q "%NODEZIP%" >nul 2>nul
  goto req_fail
)
echo         已下载：!NODEZIPSIZE! 字节

echo   [解压] Node 便携包 …
set "EXTRACTED=%TOOLSDIR%\node-v%NODE_VER%-win-x64"
if exist "%EXTRACTED%" rd /s /q "%EXTRACTED%"
if "%HAS_TAR%"=="1" (
  tar -xf "%NODEZIP%" -C "%TOOLSDIR%"
) else (
  if "%HAS_PS%"=="1" (
    powershell -NoProfile -Command "Expand-Archive -LiteralPath '%NODEZIP%' -DestinationPath '%TOOLSDIR%' -Force"
  ) else (
    echo   [失败] 无 tar 也无 PowerShell，无法解压。
    goto req_fail
  )
)
if not exist "%EXTRACTED%\node.exe" (
  echo   [失败] 解压后未找到 %EXTRACTED%\node.exe
  goto req_fail
)
move "%EXTRACTED%" "%NODEDIR%" >nul
if errorlevel 1 (echo   [失败] Node 目录就位失败 & goto req_fail)
del /q "%NODEZIP%" >nul 2>nul
for /f "delims=" %%V in ('"%NODEDIR%\node.exe" -v 2^>nul') do set "NODE_NOW=%%V"
echo         便携 Node 就位：!NODE_NOW!（%NODEDIR%）

:req_npm
rem --- npm 依赖 ---
if "%DEPS_OK%"=="1" (
  echo   [跳过] npm 依赖已齐备（vite / onnxruntime-web / upscalejs）
  goto req_predev
)
echo   [安装] npm 依赖（约 330MB；必须含 devDependencies：超分 2x 权重来源 upscalejs 在 devDependencies）
pushd "%WEBDIR%"
set "NPM_OK=0"
echo         源：%NPM_REGISTRY%
call "%NODEDIR%\npm.cmd" install --registry=%NPM_REGISTRY% --no-audit --no-fund
if not errorlevel 1 set "NPM_OK=1"
if "%NPM_OK%"=="0" (
  echo         镜像安装失败，回退 npm 默认源重试 …
  call "%NODEDIR%\npm.cmd" install --no-audit --no-fund
  if not errorlevel 1 set "NPM_OK=1"
)
popd
if "%NPM_OK%"=="0" (
  echo   [失败] npm install 失败（镜像与默认源都失败）。请在 web 目录手动执行：
  echo          "%NODEDIR%\npm.cmd" install
  goto req_fail
)
echo         npm 依赖安装完成

:req_predev
echo   [自检] npm run predev（复制 ORT 运行时与 2x 权重到 public\superres-assets）
pushd "%WEBDIR%"
call "%NODEDIR%\npm.cmd" run predev
set "PREDEV_RC=%errorlevel%"
popd
if not "%PREDEV_RC%"=="0" (
  echo   [失败] npm run predev 失败（退出码 %PREDEV_RC%）
  goto req_fail
)
set "ASSET2X_OK=1"
for %%F in (up2x-latest-no-denoise.onnx ort.min.mjs) do (
  if not exist "%ASSETDIR%\models\%%F" if not exist "%ASSETDIR%\js\%%F" set "ASSET2X_OK=0"
)
if "%ASSET2X_OK%"=="1" (
  echo         超分 2x 资产已就位
) else (
  echo   [警告] predev 跑完但 public\superres-assets 仍不完整，请看上面的输出排查
)
echo   必需组件安装完成。
exit /b 0

:req_fail
echo.
echo   必需组件未装完。请按上面的提示处理后重跑本脚本（已装好的部分会自动跳过）。
exit /b 1

rem ---------------------------------------------------------------
rem ④ 纹理保全线：官方 safetensors + 本地 Python 转换（Phase 0 判定：无可用官方 ONNX）
rem ---------------------------------------------------------------
:do_texture
rem web\sr-models 是转换/下载产物的落点；纯净导出包里还没有这个目录（predev 只建 public 侧），
rem 不先建目录 curl 会以 "client returned ERROR on write"（23）失败（实测踩过）。
if not exist "%SRMODELDIR%" mkdir "%SRMODELDIR%"

rem ===================================================================
rem Phase 0 实测结论（2026-09-16，B 实测，详见任务卡回执）：
rem   ① Kim2091 官方 HF 仓库 Kim2091/2x-AnimeSharpV4 确有 ONNX（fp16/op17，
rem      license: cc-by-nc-sa-4.0），文件能下、ORT 1.27 两个后端都能**加载**；
rem   ② 但它把输入张量声明成 fp16：现有引擎喂 float32 直接被拒
rem      （Unexpected input data type. Actual: (tensor(float)) , expected: (tensor(float16))）；
rem      改喂 fp16 后 WASM 能跑通（与自转 fp32 偏差 max|Δ|=0.0309 → ×255 约 7.9 级，
rem      均值 0.075 级，可用），但 **WebGPU 后端崩**（[Conv] kernel failed）；
rem   ③ Kim2091 名下 7 个 HF 仓库已逐个核对，**没有 1x-SuperScale 的官方 ONNX**。
rem 结论：纹理线整条走 **Python 本地转换**（与 CUGAN 线共用 venv；权重仍来自权利人官方
rem   渠道：AnimeSharpV4 走 HF 的 .safetensors，SuperScale 走 GitHub Release 的 .safetensors）。
rem 将来若给 worker 加了输入 dtype 适配层（fp16 张量喂 fp16 模型）且 WebGPU 崩溃问题
rem   解决，可把下面标着【快路径】的注释放开、改走 HF ONNX 直下。
rem ===================================================================

rem --- AnimeSharpV4 2x：官方 .safetensors + 本地转换 ---
if exist "%SRMODELDIR%\animesharpv4-2x.onnx" (
  echo   [跳过] animesharpv4-2x.onnx 已存在
  goto tex_superscale
)
call :ensure_venv
if errorlevel 1 (
  echo   纹理线未装完：Python 工具链不可用。
  exit /b 1
)
if exist "%WEIGHTDIR%\2x-AnimeSharpV4_RCAN.safetensors" (
  echo   [跳过] 已有原始权重 2x-AnimeSharpV4_RCAN.safetensors
  goto tex_anime_convert
)
echo   [下载] AnimeSharpV4 2x 原始权重（作者官方 safetensors，约 31MB，HuggingFace 渠道）
call :hf_dl "Kim2091/2x-AnimeSharpV4" "2x-AnimeSharpV4_RCAN.safetensors" "%WEIGHTDIR%\2x-AnimeSharpV4_RCAN.safetensors" 30000000
if errorlevel 1 (
  echo   [失败] AnimeSharpV4 原始权重下载失败。
  echo          手动下载后放到：%WEIGHTDIR%\2x-AnimeSharpV4_RCAN.safetensors
  echo          下载地址：%HF_OFFICIAL%/Kim2091/2x-AnimeSharpV4/resolve/main/2x-AnimeSharpV4_RCAN.safetensors
  exit /b 1
)
:tex_anime_convert
echo   [转换] animesharpv4-2x.onnx ——convert.py rcan2x，自带数值对照 max abs diff 小于 1e-3
call :convert rcan2x "%WEIGHTDIR%\2x-AnimeSharpV4_RCAN.safetensors" "%SRMODELDIR%\animesharpv4-2x.onnx"
if errorlevel 1 exit /b 1

rem 【快路径·当前禁用】HF 官方 ONNX 直下（fp16/op17）——因输入 dtype 与 WebGPU 兼容性问题停用：
rem call :hf_dl "Kim2091/2x-AnimeSharpV4" "2x-AnimeSharpV4_RCAN_fp16_op17.onnx" "%SRMODELDIR%\animesharpv4-2x.onnx" 30000000

:tex_superscale
rem --- SuperScale 1x：作者未在 HF 分发 ONNX → 官方 safetensors + 本地转换 ---
if exist "%SRMODELDIR%\superscale-1x.onnx" (
  echo   [跳过] superscale-1x.onnx 已存在
  goto tex_finish
)
echo   [转换] 1x-SuperScale：作者未分发官方 ONNX，走官方 safetensors + 本地 Python 转换
call :ensure_venv
if errorlevel 1 (
  echo   纹理线未装完：Python 工具链不可用。
  exit /b 1
)
call :gh_dl "1x-SuperScale/1x-SuperScale_SPAN.safetensors" "%WEIGHTDIR%\1x-SuperScale_SPAN.safetensors" 5000000
if errorlevel 1 (
  echo   [失败] 1x-SuperScale 原始权重下载失败（GitHub Release 与代理都不可达）。
  echo          手动下载后放到：%WEIGHTDIR%\1x-SuperScale_SPAN.safetensors
  echo          下载地址：%KIM_RELEASE%/1x-SuperScale/1x-SuperScale_SPAN.safetensors
  exit /b 1
)
echo   [转换] superscale-1x.onnx ——convert.py span1x，自带数值对照 max abs diff 小于 1e-3
call :convert span1x "%WEIGHTDIR%\1x-SuperScale_SPAN.safetensors" "%SRMODELDIR%\superscale-1x.onnx"
if errorlevel 1 exit /b 1

:tex_finish
call :predev_refresh
echo   纹理保全线安装完成。
exit /b 0

rem ---------------------------------------------------------------
rem ⑤ CUGAN 3x/4x 线：Python + venv/torch + 权重 + 本地转换
rem ---------------------------------------------------------------
:do_cugan
call :ensure_python
if errorlevel 1 (
  echo   CUGAN 线未装完：Python 不可用。
  exit /b 1
)
call :ensure_venv
if errorlevel 1 (
  echo   CUGAN 线未装完：venv/依赖安装失败。
  exit /b 1
)
call :ensure_weights
if errorlevel 1 (
  echo   CUGAN 线未装完：权重下载失败。
  exit /b 1
)
call :convert_cugan
if errorlevel 1 (
  echo   CUGAN 线未装完：模型转换失败。
  exit /b 1
)
call :predev_refresh
echo   CUGAN 3x/4x 线安装完成。
exit /b 0

rem --- Python：系统有合格 Python 则跳过，否则 winget → python.org 用户级静默安装 ---
:ensure_python
if "%PY_OK%"=="1" (
  echo   [跳过] 系统 Python 已合格：!PY_VER!
  exit /b 0
)
echo   [安装] Python 3.12（可选线 B 需要；已装则跳过）
if "%HAS_WINGET%"=="1" (
  echo         方式：winget install --scope user Python.Python.3.12
  winget install --scope user --accept-package-agreements --accept-source-agreements Python.Python.3.12
  if not errorlevel 1 (
    call :refresh_python
    if "!PY_OK!"=="1" (echo         Python 就位：!PY_VER! & exit /b 0)
  )
  echo         winget 安装未生效，回退 python.org 官方安装包 …
)
if "%HAS_CURL%"=="0" if "%HAS_PS%"=="0" (
  echo   [失败] 无下载工具，无法自动装 Python。
  goto py_manual
)
set "PYINST=%TEMP%\ystk-python-3.12-amd64.exe"
call :dl "https://www.python.org/ftp/python/3.12.10/python-3.12.10-amd64.exe" "%PYINST%" || goto py_manual
echo         静默安装（仅当前用户，免管理员）…
"%PYINST%" /quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1
del /q "%PYINST%" >nul 2>nul
call :refresh_python
if "!PY_OK!"=="1" (echo         Python 就位：!PY_VER! & exit /b 0)

:py_manual
echo   [失败] 自动安装 Python 失败。请手动安装 Python 3.10+：
echo          https://www.python.org/downloads/windows/
echo          安装时勾选 "Add python.exe to PATH"，装好后重跑本脚本。
exit /b 1

rem 重扫 PATH 里的 python（winget/python.org 装完当前进程 PATH 可能未刷新）
:refresh_python
set "PYEXE="
set "PY_VER="
set "PY_OK=0"
set "PATH=%LOCALAPPDATA%\Programs\Python\Python312;%LOCALAPPDATA%\Programs\Python\Python312\Scripts;%LOCALAPPDATA%\Programs\Python\Python311;%PATH%"
for /f "delims=" %%P in ('where python.exe 2^>nul') do if not defined PYEXE set "PYEXE=%%P"
if defined PYEXE for /f "tokens=2" %%V in ('python --version 2^>^&1') do set "PY_VER=%%V"
if defined PY_VER (
  for /f "tokens=1,2 delims=." %%A in ("!PY_VER!") do (set "PYMAJ=%%A" & set "PYMIN=%%B")
  if !PYMAJ! GEQ 3 if !PYMIN! GEQ 10 set "PY_OK=1"
)
exit /b 0

rem --- venv + 依赖（torch 必须走官方 CPU 源）---
rem 注意：依赖检查（import torch）与依赖安装必须分开——
rem 早期写法把「venv 已存在」直接 exit /b 0，导致新建的 venv 跳过后续 pip 步骤（实测踩过）。
:ensure_venv
if not "%PY_OK%"=="1" (
  echo   [失败] 没有可用的 Python ——版本需 3.10 或更高，当前没有找到合格解释器
  exit /b 1
)
if "%VENV_OK%"=="1" (
  echo   [跳过] 转换 venv 已就位，torch 可导入
  set "VENV_TOUCHED=1"
  exit /b 0
)
pushd "%SHEETDIR%"
rem pip 缓存落到仓库内（默认是 %LOCALAPPDATA%\pip\cache，删 venv 带不走 torch 轮子）
set "PIP_CACHE_DIR=%PIPCACHE%"
if not exist "%PIPCACHE%" mkdir "%PIPCACHE%"
rem R1（2026-09-24 异常 2）：判据从「python.exe 存在」改为「探测 venv 真可用」——
rem 中断残留的半成品 venv（只有 python.exe、没有 pyvenv.cfg）会让 pip 报
rem No pyvenv.cfg file 且三级源全灭（实测卡点）。半成品的唯一来源是中断，
rem 重试必须自愈：探测失败 → 删目录重建，不报错人工处理。
if exist "%VENVDIR%" (
  "%VENVPY%" -c "import sys" >nul 2>&1
  if errorlevel 1 (
    echo   [重建] 检测到损坏/不完整的 venv（多为上次中断残留），自动重建 …
    rd /s /q "%VENVDIR%" >nul 2>&1
  )
)
if exist "%VENVPY%" goto venv_deps
echo   [创建] 隔离 venv：%VENVDIR%
python -m venv .venv
if not exist "%VENVPY%" (
  popd
  echo   [失败] venv 创建失败：%VENVPY%
  exit /b 1
)

:venv_deps
echo   [升级] pip（镜像主 → 官方回退）
".venv\Scripts\python.exe" -m pip install --upgrade pip --index-url %PIP_MIRROR% >nul 2>nul
if errorlevel 1 ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul 2>nul

rem --- torch：官方 CPU 源主 + 国内镜像回退 + 快失败（2026-09-17 实测补强）---
rem 为什么这么写：实测遇到 download-r2.pytorch.org 读超时，pip 默认会「15s 超时 × 5 次重试」
rem 静默重试好几分钟，用户看到的就是**卡住不动、没有任何输出**（已复现）。
rem 故：① 每次尝试都带 --timeout/--retries，失败得快；② 官方源不成 → 上海交大镜像
rem （与官方 whl/cpu 同内容，装到同一个 +cpu 版本，不降级）；③ 仍不成 → 清华 PyPI 兜底。
echo   [安装] torch（CPU 版，官方源 download.pytorch.org/whl/cpu，约 200MB，耗时数分钟）
echo          只装 CPU 轮子（CUDA 大包本项目用不到）；下载有进度条显示，长时间无进展会自动换源
set "TORCH_OK=0"
echo          [1/3] 官方 CPU 源 …
".venv\Scripts\python.exe" -m pip install torch --index-url https://download.pytorch.org/whl/cpu --timeout 30 --retries 2 --progress-bar on
if not errorlevel 1 set "TORCH_OK=1"
if "%TORCH_OK%"=="0" (
  echo          [2/3] 官方源不可用，换上海交大镜像（同版本 +cpu 轮子）…
  ".venv\Scripts\python.exe" -m pip install torch --index-url %PYTORCH_MIRROR% --timeout 30 --retries 2 --progress-bar on
  if not errorlevel 1 set "TORCH_OK=1"
)
if "%TORCH_OK%"=="0" (
  echo          [3/3] 仍失败，最后试清华 PyPI（Windows 上该轮子也是 CPU 版）…
  ".venv\Scripts\python.exe" -m pip install torch --index-url %PIP_MIRROR% --timeout 30 --retries 2 --progress-bar on
  if not errorlevel 1 set "TORCH_OK=1"
)
if "%TORCH_OK%"=="0" (
  popd
  echo   [失败] torch 三个源都装不上（多为网络问题）。可手动重试：
  echo          cd /d "%SHEETDIR%"
  echo          .venv\Scripts\python.exe -m pip install torch --index-url %PYTORCH_MIRROR%
  exit /b 1
)
echo   [安装] 其余转换依赖（requirements.txt；镜像主 → 官方回退）
".venv\Scripts\python.exe" -m pip install -r requirements.txt --index-url %PIP_MIRROR% --timeout 30 --retries 2 --progress-bar off
if errorlevel 1 (
  echo          镜像失败，回退官方 PyPI …
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt --timeout 30 --retries 2 --progress-bar off
  if errorlevel 1 (popd & echo   [失败] requirements.txt 安装失败 & exit /b 1)
)
popd
"%VENVPY%" -c "import torch" >nul 2>nul
if errorlevel 1 (echo   [失败] 依赖装完但 import torch 失败 & exit /b 1)
set "VENV_OK=1"
set "VENV_TOUCHED=1"
echo         venv 就位：%VENVDIR%
exit /b 0

rem --- 权重下载（ModelScope 官方渠道）---
:ensure_weights
if not exist "%WEIGHTDIR%" mkdir "%WEIGHTDIR%"
set "CU_W_MISSING=0"
for %%F in (up3x-latest-no-denoise up3x-latest-denoise3x up3x-latest-conservative up4x-latest-no-denoise up4x-latest-denoise3x up4x-latest-conservative) do (
  if exist "%WEIGHTDIR%\%%F.pth" (
    call :size_ok "%WEIGHTDIR%\%%F.pth" 1000000
    if errorlevel 1 (
      set "CU_W_MISSING=1"
      del /q "%WEIGHTDIR%\%%F.pth" >nul 2>nul
    )
  ) else (
    set "CU_W_MISSING=1"
  )
)
if "%CU_W_MISSING%"=="0" (
  echo   [跳过] 6 个 .pth 权重已就位
  exit /b 0
)
echo   [下载] Real-CUGAN 官方权重（ModelScope：bilibili/cv_bilibili_image-super-resolution）
for %%F in (up3x-latest-no-denoise up3x-latest-denoise3x up3x-latest-conservative up4x-latest-no-denoise up4x-latest-denoise3x up4x-latest-conservative) do (
  if exist "%WEIGHTDIR%\%%F.pth" (
    echo         [跳过] %%F.pth
  ) else (
    echo         [下载] %%F.pth
    call :dl "%MS_BASE%/%%F.pth" "%WEIGHTDIR%\%%F.pth"
    if errorlevel 1 (
      echo   [失败] %%F.pth 下载失败（ModelScope 渠道）
      exit /b 1
    )
    call :size_ok "%WEIGHTDIR%\%%F.pth" 1000000
    if errorlevel 1 (
      echo   [失败] %%F.pth 体积异常，已删除，请重跑
      del /q "%WEIGHTDIR%\%%F.pth" >nul 2>nul
      exit /b 1
    )
  )
)
exit /b 0

rem --- 6 条转换命令（convert.py 自带 <1e-3 数值对照）---
:convert_cugan
for %%F in (up3x-latest-no-denoise up3x-latest-denoise3x up3x-latest-conservative up4x-latest-no-denoise up4x-latest-denoise3x up4x-latest-conservative) do (
  if exist "%SRMODELDIR%\%%F.onnx" (
    echo   [跳过] %%F.onnx 已存在
  ) else (
    set "SC=cugan4x"
    echo %%F | findstr /b /c:"up3x" >nul && set "SC=cugan3x"
    call :convert !SC! "%WEIGHTDIR%\%%F.pth" "%SRMODELDIR%\%%F.onnx" || exit /b 1
  )
)
exit /b 0

rem ---------------------------------------------------------------
rem 通用辅助
rem ---------------------------------------------------------------

rem :toolchain_size —— 量出 .venv 与 weights 的体积（MB），供清理询问里如实报数
rem 用 PowerShell 递归求和；量不到记 0，不阻断流程。
:toolchain_size
set "VENV_MB=0"
set "WT_MB=0"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "if (Test-Path -LiteralPath '%VENVDIR%') { [math]::Round((Get-ChildItem -LiteralPath '%VENVDIR%' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB) } else { 0 }" 2^>nul`) do set "VENV_MB=%%A"
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "if (Test-Path -LiteralPath '%WEIGHTDIR%') { [math]::Round((Get-ChildItem -LiteralPath '%WEIGHTDIR%' -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum/1MB) } else { 0 }" 2^>nul`) do set "WT_MB=%%A"
exit /b 0

rem :clean_toolchain —— 清掉 Python 转换工具链（.venv + 仓库内 pip 缓存 + 原始权重）
rem 保留：web\sr-models\*.onnx（产物）与 public\superres-assets（引擎运行时要读的）
:clean_toolchain
echo.
echo   [清理] 删除 Python 转换工具链 …
set "CL_NONE=1"
if exist "%VENVDIR%" set "CL_NONE=0"
if exist "%PIPCACHE%" set "CL_NONE=0"
if exist "%WEIGHTDIR%\*.pth" set "CL_NONE=0"
if exist "%WEIGHTDIR%\*.safetensors" set "CL_NONE=0"
if exist "%VENVDIR%" (
  rd /s /q "%VENVDIR%"
  if exist "%VENVDIR%" (echo         [警告] .venv 删除失败（可能被占用），请手动删：%VENVDIR%) else (echo         [√] 已删 .venv)
) else (
  echo         [跳过] .venv 不存在
)
if exist "%PIPCACHE%" (
  rd /s /q "%PIPCACHE%"
  if exist "%PIPCACHE%" (echo         [警告] pip 缓存删除失败，请手动删：%PIPCACHE%) else (echo         [√] 已删 pip 缓存（%PIPCACHE%）)
) else (
  echo         [跳过] pip 缓存不存在
)
if exist "%WEIGHTDIR%" (
  rem 只删原始权重文件，不动 weights 目录本身（转换脚本按该目录找权重）
  del /q "%WEIGHTDIR%\*.pth" >nul 2>nul
  del /q "%WEIGHTDIR%\*.safetensors" >nul 2>nul
  echo         [√] 已删原始权重（.pth / .safetensors）
) else (
  echo         [跳过] weights 目录不存在
)
echo         [保留] 转换产物：%SRMODELDIR%\*.onnx（运行时要用，未删）
rem R4：三块（.venv / pip 缓存 / weights 权重文件）本就不存在时，如实说明"没东西可清"
if "%CL_NONE%"=="1" echo         未发现可清理的 Python 工具链（可能已清理过）
echo   [清理] 完成 —— 工具箱运行不受影响；以后要再装可选模型，重跑本脚本会自动重建工具链
exit /b 0

rem :convert <模式> <输入权重> <输出 onnx>  —— 调 convert.py 并校验退出码/产物
rem PYTHONIOENCODING=utf-8 是必需的：日志被重定向到文件时 Python 的 stdout 是 cp936，
rem 而 convert.py / torch.onnx 会打印 ? 这类符号 → UnicodeEncodeError 直接把转换打断
rem （实测踩过：torch.onnx 导出成功后在 _success() 打印 ? 时崩）。设成 utf-8 后不再报错，
rem 代价只是 python 自己的输出在 GBK 控制台里显示为乱码（不影响产物与校验）。
:convert
echo   [转换] %~1 %~nx2 → %~nx3
for %%D in ("%~3") do if not exist "%%~dpD" mkdir "%%~dpD"
set "PYTHONIOENCODING=utf-8"
pushd "%SHEETDIR%"
".venv\Scripts\python.exe" convert.py %~1 "%~2" "%~3"
set "CV_RC=%errorlevel%"
popd
if not "%CV_RC%"=="0" (
  echo   [失败] 转换失败（模式 %~1，退出码 %CV_RC%）。完整命令：
  echo          cd /d "%SHEETDIR%"
  echo          .venv\Scripts\python.exe convert.py %~1 "%~2" "%~3"
  exit /b 1
)
if not exist "%~3" (
  echo   [失败] 转换命令退出码 0 但产物不存在：%~3
  exit /b 1
)
exit /b 0

rem :predev_refresh —— 装完可选模型后刷新 public 资产
:predev_refresh
echo   [自检] npm run predev（把新模型复制到 public\superres-assets\models）
pushd "%WEBDIR%"
call "%NODEDIR%\npm.cmd" run predev
set "PD_RC=%errorlevel%"
popd
if not "%PD_RC%"=="0" (
  echo   [警告] predev 退出码 %PD_RC%，资产可能未刷新
  exit /b 1
)
set "MISS=0"
set "ONNX_N=0"
if exist "%SRMODELDIR%" for %%F in ("%SRMODELDIR%\*.onnx") do (
  set /a ONNX_N+=1
  if not exist "%ASSETDIR%\models\%%~nxF" set "MISS=1"
)
if "%MISS%"=="1" (
  echo   [警告] 有模型未出现在 public\superres-assets\models，请检查上面输出
) else (
  echo         资产已同步（%ONNX_N% 个 .onnx 全部就位）
)
exit /b 0

rem :hf_dl <仓库> <文件> <目标路径> <最小字节>  —— HF 镜像主 → 官方回退
rem   仓库与文件分开传参：本地目录分隔符反斜杠不能被 %%~nx 之外的拼接逻辑吃掉。
:hf_dl
set "HFREPO=%~1"
set "HFFILE=%~2"
set "HFDEST=%~3"
set "HFMIN=%~4"
call :dl "%HF_MIRROR%/%HFREPO%/resolve/main/%HFFILE%" "%HFDEST%"
if errorlevel 1 (
  echo         hf-mirror.com 失败，回退官方 huggingface.co …
  call :dl "%HF_OFFICIAL%/%HFREPO%/resolve/main/%HFFILE%" "%HFDEST%"
  if errorlevel 1 (
    echo   [失败] 两个 HF 源都不可达：%HFREPO%/%HFFILE%
    exit /b 1
  )
)
call :size_ok "%HFDEST%" %HFMIN%
if errorlevel 1 (
  echo   [失败] 下载体积异常：%HFDEST%
  del /q "%HFDEST%" >nul 2>nul
  exit /b 1
)
exit /b 0

rem :gh_dl <release 路径，如 1x-SuperScale/1x-SuperScale_SPAN.safetensors> <目标> <最小字节>
rem   GitHub Release 直连 → 两个公共代理回退
:gh_dl
set "GHREL=%~1"
set "GHDEST=%~2"
set "GHMIN=%~3"
call :dl "%KIM_RELEASE%/%GHREL%" "%GHDEST%"
if errorlevel 1 (
  echo         github.com 直连失败，回退公共代理 ghproxy.net …
  call :dl "%GH_PROXY1%https://github.com/Kim2091/Kim2091-Models/releases/download/%GHREL%" "%GHDEST%"
)
if errorlevel 1 (
  echo         回退公共代理 gh-proxy.com …
  call :dl "%GH_PROXY2%https://github.com/Kim2091/Kim2091-Models/releases/download/%GHREL%" "%GHDEST%"
)
if errorlevel 1 (
  echo   [失败] GitHub Release 直连与两个代理都不可达：%GHREL%
  exit /b 1
)
call :size_ok "%GHDEST%" %GHMIN%
if errorlevel 1 (
  echo   [失败] 下载体积异常：%GHDEST%
  del /q "%GHDEST%" >nul 2>nul
  exit /b 1
)
exit /b 0

rem :dl <url> <目标文件>  —— curl 优先，PowerShell 兜底；成功 exit /b 0
:dl
set "DLURL=%~1"
set "DLDEST=%~2"
set "DLOK=0"
if "%HAS_CURL%"=="1" (
  curl.exe -fL --max-time 1800 --connect-timeout 20 --retry 2 -o "%DLDEST%.part" "%DLURL%"
  if not errorlevel 1 set "DLOK=1"
)
if "!DLOK!"=="0" if "%HAS_PS%"=="1" (
  powershell -NoProfile -Command "try { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%DLURL%' -OutFile '%DLDEST%.part' -TimeoutSec 1800 -UseBasicParsing } catch { exit 1 }"
  if not errorlevel 1 set "DLOK=1"
)
if "!DLOK!"=="0" (
  del /q "%DLDEST%.part" >nul 2>nul
  exit /b 1
)
if exist "%DLDEST%" del /q "%DLDEST%" >nul 2>nul
move "%DLDEST%.part" "%DLDEST%" >nul
exit /b 0

:psdl
set "DLURL=%~1"
set "DLDEST=%~2"
powershell -NoProfile -Command "try { $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%DLURL%' -OutFile '%DLDEST%.part' -TimeoutSec 1800 -UseBasicParsing } catch { exit 1 }"
if errorlevel 1 (del /q "%DLDEST%.part" >nul 2>nul & exit /b 1)
if exist "%DLDEST%" del /q "%DLDEST%" >nul 2>nul
move "%DLDEST%.part" "%DLDEST%" >nul
exit /b 0

rem :size_ok <文件> <最小字节>  —— 存在且大于阈值
:size_ok
if not exist "%~1" exit /b 1
for %%S in ("%~1") do set "SZ=%%~zS"
if !SZ! GTR %~2 exit /b 0
exit /b 1
