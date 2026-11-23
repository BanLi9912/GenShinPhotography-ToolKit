# convert-sr-models · 超分模型权重转换工具链（SR.0）

把 Real-CUGAN（CUNet）、2x-AnimeSharpV4（RCAN）、1x-SuperScale（SPAN）官方 PyTorch 权重
转换为浏览器可用的 ONNX（opset 17 / FP32 / 高宽动态），产物统一放 `web/sr-models/`。

> 隔离环境：本目录是独立 Python venv 工作区，不装系统包、不引运行时 Python。
> 原始权重 / venv / ONNX 产物一律**不入 git**（见 `web/.gitignore`）。

## 1. 环境准备

```powershell
cd web/scripts/convert-sr-models
python -m venv .venv
.venv\Scripts\python -m pip install --upgrade pip
# torch 走官方 CPU 源（PyPI 的 Windows torch 为 CPU 版：实测 torch-2.14.0-cp312-cp312-win_amd64.whl
# 124.1MB，2026-09-24；Linux 才默认 CUDA 大包）——CPU 源仍为首选，体积与版本可控，其余走默认镜像
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python -m pip install -r requirements.txt
```

## 2. 权重获取（官方来源）

| 模型 | 来源 | 文件 |
|---|---|---|
| Real-CUGAN 2x 五档 | `node_modules/upscalejs/dist/models/up2x-latest-*.onnx`（官方 ONNX 转换产物，**无需自转**） | conservative / no-denoise / denoise1x / denoise2x / denoise3x |
| Real-CUGAN 3x 三档 | bilibili 官方 ModelScope：`bilibili/cv_bilibili_image-super-resolution`，路径 `weights_v3/` | `up3x-latest-{conservative,denoise3x,no-denoise}.pth` |
| Real-CUGAN 4x 三档 | 同上 | `up4x-latest-{conservative,denoise3x,no-denoise}.pth` |
| 2x-AnimeSharpV4（RCAN，非 Fast） | Kim2091 GitHub Release `2x-AnimeSharpV4` | `2x-AnimeSharpV4_RCAN.safetensors` |
| 1x-SuperScale（SPAN） | Kim2091 GitHub Release `1x-SuperScale` | `1x-SuperScale_SPAN.safetensors`（+ `SPAN_S_finetune.yml` 训练配置参考） |

ModelScope 下载示例：

```powershell
curl.exe -sL -o weights/up3x-latest-conservative.pth `
  "https://www.modelscope.cn/models/bilibili/cv_bilibili_image-super-resolution/resolve/master/weights_v3/up3x-latest-conservative.pth"
```

## 3. 转换命令

```powershell
$py = ".venv\Scripts\python.exe"
$script = "convert.py"
$raw = "weights"          # 原始权重放本目录 weights/ 下
$out = "..\..\sr-models"  # ONNX 产物放 web/sr-models/

& $py $script cugan3x "$raw\up3x-latest-no-denoise.pth"    "$out\up3x-latest-no-denoise.onnx"
& $py $script cugan3x "$raw\up3x-latest-denoise3x.pth"     "$out\up3x-latest-denoise3x.onnx"
& $py $script cugan3x "$raw\up3x-latest-conservative.pth"  "$out\up3x-latest-conservative.onnx"
& $py $script cugan4x "$raw\up4x-latest-no-denoise.pth"    "$out\up4x-latest-no-denoise.onnx"
& $py $script cugan4x "$raw\up4x-latest-denoise3x.pth"     "$out\up4x-latest-denoise3x.onnx"
& $py $script cugan4x "$raw\up4x-latest-conservative.pth"  "$out\up4x-latest-conservative.onnx"
& $py $script rcan2x "$raw\2x-AnimeSharpV4_RCAN.safetensors" "$out\animesharpv4-2x.onnx"
& $py $script span1x "$raw\1x-SuperScale_SPAN.safetensors"   "$out\superscale-1x.onnx"
```

`convert.py` 每次导出后自动做：`onnx.checker.check_model` 校验 + onnxruntime(CPU) 与 torch
数值对照（max abs diff < 1e-3 才算通过）+ 输入输出名/动态维度打印。

## 4. 冒烟验证

1. `npm run predev`（或 `prebuild`）把 `web/sr-models/*.onnx` 与 upscalejs 2x 五档、ORT 运行时复制到 `web/public/superres-assets/`；
2. 打开 `http://localhost:5173/superres-assets/smoke.html`：逐模型 WASM/WebGPU 双后端加载 +
   200×200 tile 推理（输出形状与单 tile 耗时）+ 201×203 非对齐摸底，结果渲染在页面与 console.table。

## 5. 许可证（务必阅读）

- **Real-CUGAN**（bilibili/ailab）：官方仓库**无 LICENSE 文件**（GitHub API 确认 404）；官方 README
  未给出明确商用授权，商用分发需自行确认。ModelScope 官方仓库含 `LICENSE` 文件，以该文件为准。
- **2x-AnimeSharpV4 / 1x-SuperScale**（Kim2091）：**CC BY-NC-SA 4.0（非商用）**。
  权重仅本地使用，**不入 git、不随包分发、不上传任何外部服务**。

## 6. 与运行时链路的关系

- 复制：`web/scripts/copy-superres-assets.mjs` 会把 `web/sr-models/*.onnx` 与 upscalejs 2x 五档、
  ORT WASM 一并复制到 `public/superres-assets/`（predev/prebuild 自动执行）。
- SR.1/SR.2 将按本目录产出的文件名、输入输出名（`input_1` / `output_1`）与动态维度接入 worker/store/UI。
- 输入/输出数值范围：CUGAN 系与 RCAN/SPAN 的归一化约定不同（`convert.py` 会打印摸底值），
  接入运行时前需在 SR.1 用真实图片对照 PyTorch 参考输出确认。
