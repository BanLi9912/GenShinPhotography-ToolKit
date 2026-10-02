# 图像超分（superres）

导航栏工具「图像超分」，本地推理，图片全程在本机浏览器处理，不上传任何服务。
两条生产分支：

```
超分线：Real-CUGAN 2x/3x/4x（倍率 + 降噪档）→ smoothEdges 边缘去锯齿 → 输出放大图
纹理保全线：1x-SuperScale 抗锯齿 → AnimeSharpV4 2x →（可选）回缩原尺寸 → 输出
```

- 推理：`onnxruntime-web`（1.27），运行在独立 Web Worker 内；
  **WebGPU 优先，失败时换一个全新 Worker 回退 WASM**（避免 ORT `initWasm` 状态被 GPU 失败污染）；
  dev 下由 `vite.config.ts` 的 `serveSuperResOrtJs` 中间件直接返回 ORT 胶水 `.mjs`，
  避免 Vite 拦截 /public 文件的动态 import；
- 选图后点「开始」启动，按 tile 分块推理并回报真实进度，可随时取消；
- 模型与 ORT 运行时由 `predev` / `prebuild`（`scripts/copy-superres-assets.mjs`）
  从 node_modules 复制到 `public/superres-assets/`，不入库。

## 推理设备与选卡（PR-008 防崩口径，2026-10-02 改口径）

- 设置区「推理设备」两档，**默认「GPU（核显优先）」**：WebGPU 适配器按 **`low-power`**
  请求（主线程探针与 worker 内 ORT 同偏好）——混合显卡笔记本走核显，**有意避开独显**：
  部分 N 卡驱动的 WebGPU 实现在**模型上载期**会打崩 GPU 进程，整页重载丢状态（PR-008，
  2026-10-02 日志实锤复发过一次）；档位**跨会话持久化**（localStorage `ystk-superres`），
  防崩设置不会因刷新而丢。
- **「仅 CPU」档**：完全不建 WebGPU（连 `requestAdapter` 探针都不发），任何机器上都不可能
  触发 WebGPU 崩溃，代价是慢数倍——GPU 也不稳的机器的逃生口。
- **无「高性能（独显）」档**：等于给崩溃留门，不做；性能敏感场景将来另议。
- **单独显台式机（无核显）**：`low-power` 仍会落到那张独显，崩溃风险不变——若复现崩溃请改「仅 CPU」
  （WebGPU 标准无枚举/点名物理卡能力，JS 无法强制指定物理显卡）。
- **进度区卡名 = worker 自报的实际推理用卡**（worker 内读 ORT 建 EP 用的 adapter，
  `adapter.info` 新 API / `requestAdapterInfo` 兜底）：显示空说明浏览器未暴露适配器信息；
  GPU 软失败回退 CPU（WASM）时进度区显示 `CPU · WASM`。
- **GPU 软失败不再静默**：回退 CPU 时 `console.warn("[superres] GPU 路径失败，回退 CPU（WASM）")`，
  开发者日志开着时自动入库，下次排查有据可依。

## tile 尺寸

| 模型系 | tile 输入 | 说明 |
|--------|-----------|------|
| upscalejs 2x 五档 | 200×200 | 固定输入模型，拒收其他尺寸，不可变 |
| 自转 3x/4x / SuperScale / AnimeSharpV4 | 400×400 | 动态 H/W，放大 tile 提升 GPU 利用率并减少边界开销 |

## 超分线（Real-CUGAN）

| 倍率 | 档位 | 模型文件（`public/superres-assets/models/`） |
|------|------|---------------------------------------------|
| 2x   | 无降噪 / 1x / 2x / 3x 降噪 | `up2x-latest-no-denoise` / `denoise1x` / `denoise2x` / `denoise3x` |
| 3x   | 无降噪 / 保守 / 3x 降噪 | `up3x-latest-no-denoise` / `conservative` / `denoise3x` |
| 4x   | 无降噪 / 保守 / 3x 降噪 | `up4x-latest-no-denoise` / `conservative` / `denoise3x` |

- **2x**：`upscalejs@0.2.0` 包内转换产物，输入固定 200×200（tile 全量 padding 兼容）、输出 400×400；
  另有 `up2x-latest-conservative.onnx` 权重保留在资产但**不接 UI**；
- **3x/4x**：B 站 Real-CUGAN 官方 `.pth` 自转的动态 H/W ONNX（任意尺寸可跑）；
- 档位之上叠「边缘去锯齿」smoothEdges（类双边平滑，带通式：只处理中高对比边缘）；
- 输出恒为放大结果，尺寸 = 原图 × 倍率；任一边超过 16384 提示改用更低倍率；
- **抗锯齿预处理开关**（`antialias`）：开启后先用 1x-SuperScale 对原图抗锯齿修复一遍再进 CUGAN 超分，
  进度两段（`抗锯齿 1/2`、`超分 2/2`），与纹理保全线独立；
- 「超分后压缩回原分辨率」开关：放大处理后再高质量缩回原尺寸（锐化增强），文件名带 `_restored`。

## 纹理保全线（SuperScale → AnimeSharpV4）

- pass 1：1x-SuperScale 抗锯齿（输出尺寸不变）；pass 2：AnimeSharpV4 2x 超分；
  **不跑 smoothEdges**（AnimeSharpV4 本身克制，决策单 §12）；
- 回缩开关（`restoreOriginalSize`，默认开）：开 = 输出原尺寸（分辨率不变的降噪锐化），关 = 2 倍；
  上限守卫对 2 倍输出同样生效；
- 耗时由 AnimeSharpV4 主导（SR.0 基准：SwiftShader WebGPU 3.45s/tile、WASM 15.7s/tile，无头单线程）；
  tile 已放大到 400，dGPU 下效率更高；
- **AnimeSharpV4 Fast 变体**（RCAN PixelUnshuffle，约 95% 质量、快 4–6 倍）已立项，转换受阻
  （venv 已删需重建 + 权重网络下载慢）暂缓，落地后再接「质量/快速」档；
  结果文件名 `_texture.png` / `_texture_restored.png`。

## 归一化口径（SR.2 裁决）

| 模型系 | 输入归一 | 输出范围 | 引擎处理 |
|--------|----------|----------|----------|
| upscalejs 2x 五档 | /255 | [0,255] | 直写（`out01=false`） |
| 自转 3x/4x / AnimeSharpV4 / SuperScale | /255 | [0,1]（SPAN 可能负/超 1） | ×255（`out01=true`），写 Uint8ClampedArray 自然 clamp |

- 输入侧全部统一 /255；输出侧由各模型的 `ModelDef.out01` 决定是否 ×255；
- 来源：自转模型 `convert.py:154` 明确"不乘 255"（RCAN 无 mean-shift、SPAN norm=False 均原始范围）。

## 权重来源与许可证

- 3x/4x：B 站 Real-CUGAN 官方权重自转（CUNet，`scripts/convert-sr-models/`），无 LICENSE 文件；
- 2x：`upscalejs` 包内转换产物；
- AnimeSharpV4（RCAN）与 SuperScale（SPAN）为 Kim2091 系列，`scripts/convert-sr-models/` 自转，
  **CC BY-NC-SA 4.0**；AnimeSharpV4 FP32 约 64MB，**Fast 变体**（同许可证）转换暂缓，见上节。

## 模型与工具链

- 自转模型转换脚本：`web/scripts/convert-sr-models/`（torch→ONNX，opset 19，动态 H/W，输入输出 `input_1`/`output_1`）。
