import type { CuganScale, DenoiseLevel, SuperResBackend } from "./store";
import type { SuperResWorkerRequest, SuperResWorkerResponse } from "./workerProtocol";

/**
 * 超分（superres）引擎：两条生产分支。
 * - 超分线 `runSuperRes`：Real-CUGAN 2x/3x/4x 放大（含边缘去锯齿 smoothEdges）；
 * - 纹理保全线 `runTextureRestore`：1x-SuperScale 抗锯齿 → AnimeSharpV4 2x → 可选回缩原尺寸（不跑 smoothEdges）。
 * 两分支共用可组合的 `runModelPass`（单模型：逐 tile 推理 → 拼块 → 输出 canvas），
 * 归一化由各模型的 `ModelDef.out01` 决定（自转 [0,1] ×255，upscalejs 2x [0,255] ×1）。
 */

/** 画布上限：输出任一边超过即拒绝推理（4K×4 远超此值） */
const MAX_CANVAS_EDGE = 16384;

/**
 * 模型定义：驱动归一化、拼块倍率与 tile 尺寸。
 * - `scale`：输出倍率（SuperScale 抗锯齿 = 1，即输出尺寸不变）；
 * - `tile`：tile 输入边长（upscalejs 2x 固定输入 200 不可变；动态模型用 400 提升 GPU 利用率）；
 * - `out01`：true = 输出为 [0,1] 原始范围，写像素需 ×255（全部自转模型，
 *   `convert.py:154` 明确"不乘 255"；RCAN 无 mean-shift、SPAN norm=False 均原始范围，
 *   可能含负值/超 1，由写 Uint8ClampedArray 的自然 clamp 吸收）；
 *   false = 输出已 [0,255]（upscalejs 2x 五档，现网正常为证）。输入侧全部统一 /255。
 */
interface ModelDef {
  file: string; // 完整基名（不含 .onnx）
  scale: 1 | 2 | 3 | 4;
  tile: number;
  out01: boolean;
}

/**
 * 倍率/档位 → CUGAN 模型定义（对应 public/superres-assets/models/*.onnx）。
 * 2x 五档（upscalejs 现成，固定 200×200 输入、输出 [0,255]，tile 不可变）；
 * 3x/4x 各三档（官方 .pth 自转，动态 H/W、输出 [0,1]，tile 400）。
 */
const MODEL_FILES: Record<CuganScale, Partial<Record<DenoiseLevel, ModelDef>>> = {
  2: {
    none: { file: "up2x-latest-no-denoise", scale: 2, tile: 200, out01: false },
    d1: { file: "up2x-latest-denoise1x", scale: 2, tile: 200, out01: false },
    d2: { file: "up2x-latest-denoise2x", scale: 2, tile: 200, out01: false },
    d3: { file: "up2x-latest-denoise3x", scale: 2, tile: 200, out01: false },
  },
  3: {
    none: { file: "up3x-latest-no-denoise", scale: 3, tile: 400, out01: true },
    conservative: { file: "up3x-latest-conservative", scale: 3, tile: 400, out01: true },
    d3: { file: "up3x-latest-denoise3x", scale: 3, tile: 400, out01: true },
  },
  4: {
    none: { file: "up4x-latest-no-denoise", scale: 4, tile: 400, out01: true },
    conservative: { file: "up4x-latest-conservative", scale: 4, tile: 400, out01: true },
    d3: { file: "up4x-latest-denoise3x", scale: 4, tile: 400, out01: true },
  },
};

/** 纹理保全线：1x-SuperScale 抗锯齿（动态，输出 [0,1]） */
const SUPERSCALE_DEF: ModelDef = { file: "superscale-1x", scale: 1, tile: 400, out01: true };
/** 纹理保全线：AnimeSharpV4 标准版 2x（动态，输出 [0,1]） */
const ANIMESHARP_DEF: ModelDef = { file: "animesharpv4-2x", scale: 2, tile: 400, out01: true };

const INIT_TIMEOUT_MS = 120_000;
const TILE_TIMEOUT_MS = 120_000;

/**
 * 输出后处理：边缘去锯齿（对高对比邻域做类双边平滑）。
 * 带通式处理：邻域对比低于 minDist 的材质/纹理区直接跳过（不被磨平），
 * 只对中高对比的锯齿边缘做平滑；档位越高越激进。
 */
const EDGE_SMOOTH: Record<
  DenoiseLevel,
  { passes: number; minDist: number; range: number; amount: number }
> = {
  // 沿用原始三档强度（conservative 0.3 / balanced 0.4 / max 0.5）：
  // none/d1/conservative 归入最轻档 0.3，d2 归 balanced 0.4，d3 归 max 0.5
  none: { passes: 1, minDist: 10, range: 48, amount: 0.3 },
  d1: { passes: 1, minDist: 10, range: 48, amount: 0.3 },
  d2: { passes: 1, minDist: 10, range: 64, amount: 0.4 },
  d3: { passes: 1, minDist: 10, range: 80, amount: 0.5 },
  conservative: { passes: 1, minDist: 10, range: 48, amount: 0.3 },
};

export interface SuperResProgress {
  percent: number;
  phase: string;
  backend: SuperResBackend | null;
  /** WebGPU 实际使用的适配器名称（如 NVIDIA GeForce RTX 3070 / SwiftShader；无则空） */
  adapter?: string;
}

export interface SuperResRunOptions {
  onProgress?: (progress: SuperResProgress) => void;
  signal?: AbortSignal;
  /** 纹理保全线回缩原尺寸开关（默认开）；超分线忽略本字段 */
  restoreOriginalSize?: boolean;
  /** 超分线抗锯齿前置开关（默认关）：先用 1x-SuperScale 抗锯齿修复一遍再进 CUGAN 超分；纹理保全线忽略 */
  antialias?: boolean;
}

export interface SuperResOutcome {
  url: string;
  width: number;
  height: number;
}

let activeBackend: SuperResBackend = "wasm";

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError");
}

async function webgpuProbe(): Promise<{ ok: boolean; name: string }> {
  const gpu = (
    navigator as Navigator & {
      gpu?: {
        requestAdapter?: (options?: { powerPreference?: "high-performance" | "low-power" | "default" }) => Promise<unknown>;
      };
    }
  ).gpu;
  if (!gpu?.requestAdapter) return { ok: false, name: "" };
  try {
    // 与 worker 内 ORT 建 WebGPU EP 的偏好保持一致：请求独显（high-performance），
    // 使探测到的 adapter 名即实际推理用卡。
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return { ok: false, name: "" };
    let name = "";
    const infoFn = (
      adapter as {
        requestAdapterInfo?: () => Promise<{ description?: string; device?: string }>;
      }
    ).requestAdapterInfo;
    if (typeof infoFn === "function") {
      try {
        const info = await infoFn.call(adapter);
        name = info?.description || info?.device || "";
      } catch {
        /* 部分环境不暴露适配器信息，忽略 */
      }
    }
    return { ok: true, name };
  } catch {
    return { ok: false, name: "" };
  }
}

/** 单个推理 Worker 会话：独立 ORT 上下文，WebGPU 失败不会污染 WASM 回退 */
class OrtWorkerSession {
  private worker: Worker;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  ready: Promise<SuperResBackend>;

  constructor(modelFile: string, preferWebgpu: boolean) {
    this.worker = new Worker(
      new URL("./superres.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (e: MessageEvent<SuperResWorkerResponse>) =>
      this.handleMessage(e.data);
    this.worker.onerror = (e) =>
      this.failAll(new Error(e.message || "推理 Worker 异常"));
    this.ready = this.request(
      "init",
      { type: "init", model: modelFile, preferWebgpu },
      INIT_TIMEOUT_MS,
    ) as Promise<SuperResBackend>;
  }

  private handleMessage(msg: SuperResWorkerResponse): void {
    const key =
      msg.type === "ready" || (msg.type === "error" && msg.id === undefined)
        ? "init"
        : `tile:${msg.id}`;
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    if (msg.type === "ready") {
      // init 请求解析出后端字符串（webgpu/wasm），而非整条消息对象
      p.resolve(msg.backend);
    } else if (msg.type === "error") {
      p.reject(new Error(msg.message));
    } else {
      p.resolve(msg);
    }
  }

  private request<T>(
    key: string,
    payload: SuperResWorkerRequest,
    timeoutMs: number,
    transfer?: Transferable[],
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        this.timers.delete(key);
        reject(new Error("推理超时，请重试"));
      }, timeoutMs);
      this.timers.set(key, timer);
      this.pending.set(key, {
        resolve: (value) => {
          const t = this.timers.get(key);
          if (t) clearTimeout(t);
          this.timers.delete(key);
          resolve(value as T);
        },
        reject: (reason) => {
          const t = this.timers.get(key);
          if (t) clearTimeout(t);
          this.timers.delete(key);
          reject(reason);
        },
      });
      this.worker.postMessage(payload, transfer ?? []);
    });
  }

  async runTile(
    id: number,
    inputBuffer: ArrayBuffer,
    w: number,
    h: number,
  ): Promise<{ data: Float32Array; outW: number; outH: number }> {
    const res = (await this.request(
      `tile:${id}`,
      { type: "run", id, buffer: inputBuffer, w, h },
      TILE_TIMEOUT_MS,
      [inputBuffer],
    )) as { buffer: ArrayBuffer; outW: number; outH: number };
    return {
      data: new Float32Array(res.buffer),
      outW: res.outW,
      outH: res.outH,
    };
  }

  private failAll(error: Error): void {
    for (const key of Array.from(this.pending.keys())) {
      const p = this.pending.get(key);
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.pending.delete(key);
      this.timers.delete(key);
      p?.reject(error);
    }
  }

  terminate(): void {
    this.worker.terminate();
    this.failAll(new Error("已取消"));
  }
}

function loadImage(srcUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = srcUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("PNG 编码失败"));
    }, "image/png");
  });
}

/**
 * 带通类双边平滑：
 * - 邻域对比 < minDist：视为材质/纹理细节，原样保留；
 * - 邻域对比落在 [minDist, range]：按颜色相似度加权平均，弱化阶梯/锯齿；
 * - 强边缘（对比 > range）：权重趋零，基本保留。
 */
function smoothEdges(
  imageData: ImageData,
  params: { passes: number; minDist: number; range: number; amount: number },
): void {
  const { width, height } = imageData;
  const data = imageData.data;
  for (let pass = 0; pass < params.passes; pass++) {
    const src = new Uint8ClampedArray(data);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const r = src[i];
        const g = src[i + 1];
        const b = src[i + 2];
        let sumR = r;
        let sumG = g;
        let sumB = b;
        let total = 1;
        let maxDist = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const j = (yy * width + xx) * 4;
            const dist = Math.max(
              Math.abs(src[j] - r),
              Math.abs(src[j + 1] - g),
              Math.abs(src[j + 2] - b),
            );
            if (dist > maxDist) maxDist = dist;
            const weight =
              Math.max(0, 1 - dist / params.range) *
              (dx !== 0 && dy !== 0 ? 0.707 : 1);
            sumR += src[j] * weight;
            sumG += src[j + 1] * weight;
            sumB += src[j + 2] * weight;
            total += weight;
          }
        }
        if (maxDist < params.minDist) continue;
        const blend = params.amount;
        data[i] = r + (sumR / total - r) * blend;
        data[i + 1] = g + (sumG / total - g) * blend;
        data[i + 2] = b + (sumB / total - b) * blend;
      }
    }
  }
}

/**
 * 单模型 pass：建 session → 逐 tile 推理拼块（倍率/归一化/tile 尺寸取 `def`）→ 返回输出 canvas。
 * - tile 边长取 `def.tile`：upscalejs 2x 固定输入 200 不可变，动态模型用 400（GPU 利用率 + 边界开销）；
 *   引擎将 tile 边缘全量 padding 成整 tile 尺寸，兼容固定输入模型；
 * - 输出尺寸以模型输出张量 dims 为准（`def.scale` 仅用于倍率上限与拼块定位，防御错配）；
 * - 上限守卫沿用 16384，触发即抛错（不进推理）；
 * - 调用方提供进度 slot（start/end 映射到全局 0–100）与阶段文案前缀。
 */
async function runModelPass(
  srcCanvas: HTMLCanvasElement,
  def: ModelDef,
  preferWebgpu: boolean,
  report: (percent: number, phase: string) => void,
  slot: { start: number; end: number; phasePrefix: string },
  signal?: AbortSignal,
): Promise<HTMLCanvasElement> {
  const width = srcCanvas.width;
  const height = srcCanvas.height;
  const scale = def.scale;
  const tile = def.tile;
  const outW = width * scale;
  const outH = height * scale;
  if (outW > MAX_CANVAS_EDGE || outH > MAX_CANVAS_EDGE) {
    throw new Error(`输出 ${outW}×${outH} 超出画布上限，请改用更低倍率`);
  }

  const session = new OrtWorkerSession(def.file, preferWebgpu);
  try {
    const backend = await session.ready;
    activeBackend = backend;
    assertNotAborted(signal);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = outW;
    outCanvas.height = outH;
    const outCtx = outCanvas.getContext("2d");
    if (!outCtx) throw new Error("无法创建画布");
    const outImage = outCtx.createImageData(outW, outH);
    const outPixels = outImage.data;
    // 归一化：自转模型输出 [0,1] ×255，upscalejs 2x 已 [0,255] ×1；写 Uint8ClampedArray 自然 clamp
    const outScale = def.out01 ? 255 : 1;
    const tilePx = tile * tile;

    const cols = Math.ceil(width / tile);
    const rows = Math.ceil(height / tile);
    const total = cols * rows;
    let done = 0;
    let tileId = 0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        assertNotAborted(signal);
        const sx = c * tile;
        const sy = r * tile;
        const tw = Math.min(tile, width - sx);
        const th = Math.min(tile, height - sy);

        const tileCanvas = document.createElement("canvas");
        tileCanvas.width = tile;
        tileCanvas.height = tile;
        const tileCtx = tileCanvas.getContext("2d", {
          willReadFrequently: true,
        });
        if (!tileCtx) throw new Error("无法创建画布");
        tileCtx.drawImage(srcCanvas, sx, sy, tw, th, 0, 0, tw, th);
        const tileData = tileCtx.getImageData(0, 0, tile, tile).data;

        const input = new Float32Array(3 * tilePx);
        for (let i = 0, p = 0; i < tileData.length; i += 4, p++) {
          input[p] = tileData[i] / 255;
          input[tilePx + p] = tileData[i + 1] / 255;
          input[2 * tilePx + p] = tileData[i + 2] / 255;
        }
        const { data: outTensor, outW: tileOutW, outH: tileOutH } =
          await session.runTile(tileId, input.buffer, tile, tile);
        tileId += 1;

        // 输出尺寸以模型输出张量为准；防御模型文件错配
        const tileOut = tile * scale;
        if (tileOutW !== tileOut || tileOutH !== tileOut) {
          throw new Error(
            `模型输出 ${tileOutW}×${tileOutH} 与预期 ${tileOut}×${tileOut} 不符（模型文件错配）`,
          );
        }
        const plane = tileOut * tileOut;

        const dx = sx * scale;
        const dy = sy * scale;
        const copyW = tw * scale;
        const copyH = th * scale;
        for (let y = 0; y < copyH; y++) {
          const srcRow = y * tileOut;
          const dstRow = (dy + y) * outW + dx;
          for (let x = 0; x < copyW; x++) {
            const s = srcRow + x;
            const d = (dstRow + x) * 4;
            outPixels[d] = outTensor[s] * outScale;
            outPixels[d + 1] = outTensor[plane + s] * outScale;
            outPixels[d + 2] = outTensor[2 * plane + s] * outScale;
            outPixels[d + 3] = 255;
          }
        }

        done += 1;
        report(
          slot.start + Math.round(((slot.end - slot.start) * done) / total),
          `${slot.phasePrefix} ${done}/${total}`,
        );
      }
    }

    assertNotAborted(signal);
    outCtx.putImageData(outImage, 0, 0);
    return outCanvas;
  } finally {
    session.terminate();
  }
}

function imageToCanvas(img: HTMLImageElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(img, 0, 0);
  return canvas;
}

export interface SuperResParams {
  scale: CuganScale;
  denoise: DenoiseLevel;
}

/**
 * 超分线（Real-CUGAN 多倍率 2x/3x/4x）。
 * 输出恒为放大结果，尺寸 = 原图 × scale；任一边超过画布上限即拒绝，提示改用更低倍率。
 * antialias 开 = 先用 1x-SuperScale 抗锯齿修复一遍再进 CUGAN 超分（进度两段：抗锯齿 1/2、超分 2/2）；
 * restoreOriginalSize 开 = 放大处理后再高质量压缩回原尺寸（锐化增强），基准仍是原图尺寸，与 aa 前置无关。
 * GPU 尝试独立 Worker，失败换全新 Worker 回退 WASM。
 */
export async function runSuperRes(
  srcUrl: string,
  params: SuperResParams,
  options: SuperResRunOptions = {},
): Promise<SuperResOutcome> {
  const { onProgress, signal, restoreOriginalSize = false, antialias = false } = options;
  const { scale, denoise } = params;
  const def = MODEL_FILES[scale][denoise];
  if (!def) throw new Error(`倍率 ${scale}x 无此降噪档：${denoise}`);
  const img = await loadImage(srcUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const outW = width * def.scale;
  const outH = height * def.scale;
  if (outW > MAX_CANVAS_EDGE || outH > MAX_CANVAS_EDGE) {
    throw new Error(`输出 ${outW}×${outH} 超出画布上限，请改用更低倍率`);
  }
  const srcCanvas = imageToCanvas(img);

  const gpuProbe = await webgpuProbe();
  const gpuOk = gpuProbe.ok;
  assertNotAborted(signal);
  const report = (percent: number, phase: string) =>
    onProgress?.({ percent, phase, backend: activeBackend, adapter: gpuProbe.name });

  report(2, "检测 GPU…");

  // 推理链：aa 开 = SuperScale 1x 抗锯齿前置 → CUGAN 超分；关 = 单段 CUGAN。
  // WebGPU→WASM 回退包整条链（GPU 跑链失败 → 全链换 WASM 重跑）。
  const runChain = (preferWebgpu: boolean) => {
    if (!antialias) {
      return runModelPass(
        srcCanvas,
        def,
        preferWebgpu,
        report,
        { start: 4, end: 92, phasePrefix: "分块推理" },
        signal,
      );
    }
    return runModelPass(
      srcCanvas,
      SUPERSCALE_DEF,
      preferWebgpu,
      report,
      { start: 4, end: 14, phasePrefix: "抗锯齿 1/2 · 分块推理" },
      signal,
    ).then((aaCanvas) =>
      runModelPass(
        aaCanvas,
        def,
        preferWebgpu,
        report,
        { start: 14, end: 92, phasePrefix: "超分 2/2 · 分块推理" },
        signal,
      ),
    );
  };

  let outCanvas: HTMLCanvasElement | undefined;
  if (gpuOk) {
    report(2, "加载模型（GPU）…");
    try {
      outCanvas = await runChain(true);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  if (!outCanvas) {
    report(3, "GPU 不可用，改用 CPU（WASM）");
    outCanvas = await runChain(false);
  }

  assertNotAborted(signal);
  report(94, "边缘平滑…");
  const outCtx = outCanvas.getContext("2d");
  if (!outCtx) throw new Error("无法创建画布");
  const outImage = outCtx.getImageData(0, 0, outCanvas.width, outCanvas.height);
  smoothEdges(outImage, EDGE_SMOOTH[denoise]);
  outCtx.putImageData(outImage, 0, 0);

  let finalCanvas = outCanvas;
  let finalW = outCanvas.width;
  let finalH = outCanvas.height;
  if (restoreOriginalSize) {
    report(96, "压缩回原分辨率…");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(outCanvas, 0, 0, width, height);
    finalCanvas = canvas;
    finalW = width;
    finalH = height;
  }

  report(97, "合成输出…");
  report(98, "编码 PNG…");
  const blob = await canvasToBlob(finalCanvas);
  report(100, "完成");
  return {
    url: URL.createObjectURL(blob),
    width: finalW,
    height: finalH,
  };
}

/**
 * 纹理保全线：1x-SuperScale 抗锯齿 → AnimeSharpV4 2x → 可选回缩原尺寸。
 * - 不跑 smoothEdges（AnimeSharpV4 本身克制，决策单 §12）；
 * - restoreOriginalSize 开 = 输出原尺寸（降噪锐化），关 = 2 倍；
 * - 两 pass 各自独立 session；上限守卫对 2 倍输出同样生效。
 */
export async function runTextureRestore(
  srcUrl: string,
  options: SuperResRunOptions = {},
): Promise<SuperResOutcome> {
  const { onProgress, signal, restoreOriginalSize = true } = options;
  const img = await loadImage(srcUrl);
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  const srcCanvas = imageToCanvas(img);

  const gpuProbe = await webgpuProbe();
  const gpuOk = gpuProbe.ok;
  assertNotAborted(signal);
  const report = (percent: number, phase: string) =>
    onProgress?.({ percent, phase, backend: activeBackend, adapter: gpuProbe.name });

  report(2, "检测 GPU…");

  // pass 1：SuperScale 抗锯齿（0–10%）
  let pass1: HTMLCanvasElement | undefined;
  const runPass1 = (preferWebgpu: boolean) =>
    runModelPass(
      srcCanvas,
      SUPERSCALE_DEF,
      preferWebgpu,
      report,
      { start: 0, end: 10, phasePrefix: "抗锯齿 1/2 · 分块推理" },
      signal,
    );
  if (gpuOk) {
    report(2, "加载模型（GPU）…");
    try {
      pass1 = await runPass1(true);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  if (!pass1) {
    report(3, "GPU 不可用，改用 CPU（WASM）");
    pass1 = await runPass1(false);
  }

  // pass 2：AnimeSharpV4 2x（10–95%），输入为 pass1 输出 canvas
  let pass2: HTMLCanvasElement | undefined;
  const runPass2 = (preferWebgpu: boolean) =>
    runModelPass(
      pass1,
      ANIMESHARP_DEF,
      preferWebgpu,
      report,
      { start: 10, end: 95, phasePrefix: "超分 2/2 · 分块推理" },
      signal,
    );
  if (gpuOk) {
    report(10, "加载模型（GPU）…");
    try {
      pass2 = await runPass2(true);
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  if (!pass2) {
    report(11, "GPU 不可用，改用 CPU（WASM）");
    pass2 = await runPass2(false);
  }

  assertNotAborted(signal);
  let finalCanvas = pass2;
  let finalW = pass2.width;
  let finalH = pass2.height;
  if (restoreOriginalSize) {
    report(96, "压缩回原分辨率…");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(pass2, 0, 0, width, height);
    finalCanvas = canvas;
    finalW = width;
    finalH = height;
  }

  report(98, "编码 PNG…");
  const blob = await canvasToBlob(finalCanvas);
  report(100, "完成");
  return {
    url: URL.createObjectURL(blob),
    width: finalW,
    height: finalH,
  };
}
