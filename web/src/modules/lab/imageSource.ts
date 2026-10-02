/**
 * 图像来源（任务 M4.1 + M4.2）：文件选择 / 拖入打开 + 程序生成示例图。
 * 像素本体常驻离屏 canvas（状态栏 RGB/HSL 读数与后续分析器共用同一来源）；
 * store 只放元信息与显示 URL。分析器经 getSampledImageData 取 ≤2048 缩样。
 */
import { rgbToHsl, luma } from "../../core/imaging/color";
import { useLabStore } from "./store";
import type { OverlayTool } from "./store";
import { buildDotGainLut } from "./dotgain";
import { applySaturationCheck, applySaturationHeat } from "./saturation";

/** 当前图像的离屏像素源（readPixel / readLuma 经此取数；始终为原图，不受预览影响） */
let pixelCtx: CanvasRenderingContext2D | null = null;
let pixelSize = { width: 0, height: 0 };
/** 当前显示 URL 的回收器（仅 objectURL 需要；dataURL 为 null） */
let revokeUrl: (() => void) | null = null;

/* ---- 色阶预览追踪（色阶专用即时预览，§2.4 可覆盖工具的覆盖层由 getOverlayImageUrl 统一生成） ---- */
/** 预览前的原始显示 URL（setSource 设置，首次预览时登记） */
let previewOriginalUrl: string | null = null;
/** 当前预览 objectURL 的回收器（null = 无预览或预览为 dataURL） */
let previewRevoke: (() => void) | null = null;

/* ---- 覆盖层缓存（每工具一槽：视口覆盖与面板反向预览可同时持有不同工具；换图统一清空） ---- */
const overlayCache = new Map<OverlayTool, { url: string; revoke: () => void }>();
let overlayInflight: Partial<Record<OverlayTool, Promise<string | null>>> = {};

/** 换图公共入口：登记像素源与显示 URL，回收上一张的 objectURL。换图即复位预览与覆盖缓存。 */
function setSource(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  name: string,
  url: string,
  revoke: (() => void) | null,
) {
  // 换图：回收预览 URL、清预览登记（预览态不复原——新图已载入）
  previewRevoke?.();
  previewRevoke = null;
  previewOriginalUrl = null;

  // 换图：清覆盖缓存
  overlayCache.forEach((e) => e.revoke());
  overlayCache.clear();
  overlayInflight = {};

  revokeUrl?.();
  pixelCtx = ctx;
  pixelSize = { width: canvas.width, height: canvas.height };
  revokeUrl = revoke;
  useLabStore
    .getState()
    .setImage({ name, width: canvas.width, height: canvas.height, url });
}

/** 读图像像素（状态栏读数）；无图像或越界返回 null。坐标为图像像素坐标 */
export function readPixel(
  x: number,
  y: number,
): { r: number; g: number; b: number; h: number; s: number; l: number } | null {
  if (
    !pixelCtx ||
    x < 0 ||
    y < 0 ||
    x >= pixelSize.width ||
    y >= pixelSize.height
  )
    return null;
  const d = pixelCtx.getImageData(x, y, 1, 1).data;
  const { h, s, l } = rgbToHsl(d[0], d[1], d[2]);
  return { r: d[0], g: d[1], b: d[2], h, s, l };
}

/** 原图全分辨率 ImageData（划线采样用）；无图返回 null。每次调用现场取数，调用方不得长缓存 */
export function getFullImageData(): ImageData | null {
  if (!pixelCtx) return null;
  return pixelCtx.getImageData(0, 0, pixelSize.width, pixelSize.height);
}

/** 源像素 canvas（导出合成用）；无图返回 null。只读借用，调用方不得修改其内容 */
export function getSourceCanvas(): HTMLCanvasElement | null {
  return pixelCtx ? pixelCtx.canvas : null;
}

/** 取单像素 Rec.601 luma（色阶拾取用）；无图或越界返回 null。坐标均为图像像素坐标 */
export function readLuma(x: number, y: number): number | null {
  if (
    !pixelCtx ||
    x < 0 ||
    y < 0 ||
    x >= pixelSize.width ||
    y >= pixelSize.height
  )
    return null;
  const d = pixelCtx.getImageData(x, y, 1, 1).data;
  return Math.round(luma(d[0], d[1], d[2]));
}

/**
 * 色阶全尺寸重映射预览（色阶专用即时预览；§2.4 可覆盖工具的覆盖层由 getOverlayImageUrl 统一生成）。
 * 从原图 pixelCtx 全尺寸取数 → LUT 映射 → JPEG（0.95）→ objectURL 更新显示。
 * 重复调用自动回收上一张预览 URL；换图时 setSource 统一回收。
 */
export function setLevelsPreview(black: number, white: number): void {
  if (!pixelCtx) return;
  const store = useLabStore.getState();
  if (!store.image) return;

  // 首次预览：登记原始 URL（不碰 revokeUrl——原图回收由 setSource 负责）
  if (previewOriginalUrl === null) {
    previewOriginalUrl = store.image.url;
  }

  // 回收上一张预览
  previewRevoke?.();
  previewRevoke = null;

  const { width, height } = pixelSize;

  // LUT：clamp(round((i - black) * 255 / (white - black)), 0, 255)
  const lut = new Uint8Array(256);
  const range = white - black;
  if (range > 0) {
    for (let i = 0; i < 256; i++) {
      const v = Math.round(((i - black) * 255) / range);
      lut[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  } else {
    // black == white → 全灰 128
    lut.fill(128);
  }

  const srcData = pixelCtx.getImageData(0, 0, width, height);
  const src = srcData.data;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const imgData = ctx.createImageData(width, height);
  const dst = imgData.data;

  for (let i = 0; i < src.length; i += 4) {
    dst[i] = lut[src[i]];
    dst[i + 1] = lut[src[i + 1]];
    dst[i + 2] = lut[src[i + 2]];
    dst[i + 3] = src[i + 3];
  }
  ctx.putImageData(imgData, 0, 0);

  // 预览有损 JPEG，原图像素不受影响
  canvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      previewRevoke = () => URL.revokeObjectURL(url);
      const img = useLabStore.getState().image;
      if (img) {
        // 直接用 setState 只更新 image URL，不走 setImage action
        // （setImage 会清空 levels/levelsPick，导致色阶 B/W 标线消失）
        useLabStore.setState({
          image: { name: img.name, width: img.width, height: img.height, url },
        });
      } else {
        // 生成期间已换图，回收
        URL.revokeObjectURL(url);
        previewRevoke = null;
      }
    },
    "image/jpeg",
    0.95,
  );
}

/** 清除色阶预览：恢复原图 URL、回收预览 objectURL */
export function clearLevelsPreview(): void {
  if (previewOriginalUrl === null) return;

  previewRevoke?.();
  previewRevoke = null;

  const store = useLabStore.getState();
  if (store.image) {
    store.setImage({
      name: store.image.name,
      width: store.image.width,
      height: store.image.height,
      url: previewOriginalUrl,
    });
  }
  previewOriginalUrl = null;
}

/**
 * 生成（或取缓存）指定工具的覆盖层显示 URL：从原图 pixelCtx 全尺寸取数 →
 * 逐像素 LUT → JPEG(0.95) → objectURL。缓存按工具单槽复用；换图自动失效。
 * 无图或该工具尚无覆盖实现返回 null。
 */
export async function getOverlayImageUrl(tool: OverlayTool): Promise<string | null> {
  if (!pixelCtx) return null;

  // 缓存命中
  const cached = overlayCache.get(tool);
  if (cached) return cached.url;

  // 防快速开关重复生成
  const inflight = overlayInflight[tool];
  if (inflight) return inflight;

  const { width, height } = pixelSize;

  const srcData = pixelCtx.getImageData(0, 0, width, height);
  const src = srcData.data;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const imgData = ctx.createImageData(width, height);
  const dst = imgData.data;

  // 按工具分发渲染算法
  if (tool === "dotgain") {
    const lut = buildDotGainLut();
    for (let i = 0; i < src.length; i += 4) {
      const v = lut[Math.min(255, Math.round(luma(src[i], src[i + 1], src[i + 2])))];
      dst[i] = v; dst[i + 1] = v; dst[i + 2] = v; dst[i + 3] = src[i + 3];
    }
  } else if (tool === "sat-check") {
    dst.set(src);
    applySaturationCheck(dst);
  } else if (tool === "sat-heat") {
    dst.set(src);
    applySaturationHeat(dst);
  } else {
    return null;
  }
  ctx.putImageData(imgData, 0, 0);

  // 竞态守卫：入口捕获 ctx，toBlob 回调里若已换图 → 回收、不写缓存
  const capturedCtx = pixelCtx;
  const promise = new Promise<string | null>((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) { resolve(null); return; }
        const url = URL.createObjectURL(blob);

        // 生成期间已换图 → 回收
        if (pixelCtx !== capturedCtx) {
          URL.revokeObjectURL(url);
          resolve(null);
          return;
        }

        // 写缓存（回收同工具旧 URL，不同工具不互踢）
        overlayCache.get(tool)?.revoke();
        overlayCache.set(tool, { url, revoke: () => URL.revokeObjectURL(url) });
        delete overlayInflight[tool];
        resolve(url);
      },
      "image/jpeg",
      0.95,
    );
  });

  overlayInflight[tool] = promise;
  return promise;
}

/** 打开本地图片文件（文件选择 / 拖入共用入口）；非图片或解码失败返回 false */
export async function openImageFile(file: File): Promise<boolean> {
  if (!file.type.startsWith("image/")) return false;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片解码失败"));
      el.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("无法创建像素上下文");
    ctx.drawImage(img, 0, 0);
    setSource(canvas, ctx, file.name, url, () => URL.revokeObjectURL(url));
    return true;
  } catch {
    URL.revokeObjectURL(url);
    return false;
  }
}

/**
 * 加载示例图（空状态引导卡入口）：程序绘制的落日场景，不引外部资源。
 * 覆盖蓝天/暖调高光/低饱和近白/纯色区域，便于核对状态栏读数口径。
 */
export function openSampleImage(): void {
  const w = 1600;
  const h = 1000;
  const horizon = Math.round(h * 0.62);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  // 天空：深蓝 → 紫灰 → 橙 → 暖黄（近白低饱和区）
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#20305c");
  sky.addColorStop(0.5, "#6e4a68");
  sky.addColorStop(0.82, "#d96f3a");
  sky.addColorStop(1, "#f2c14e");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);

  // 太阳：光晕 + 本体
  const sunX = w * 0.62;
  const sunY = horizon - h * 0.1;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, 220);
  glow.addColorStop(0, "rgba(255, 238, 190, 1)");
  glow.addColorStop(0.35, "rgba(255, 180, 96, 0.8)");
  glow.addColorStop(1, "rgba(255, 150, 60, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(sunX - 220, sunY - 220, 440, 440);
  ctx.fillStyle = "#ffedb9";
  ctx.beginPath();
  ctx.arc(sunX, sunY, 64, 0, Math.PI * 2);
  ctx.fill();

  // 远山剪影
  ctx.fillStyle = "#39304e";
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(w * 0.16, horizon - 130);
  ctx.lineTo(w * 0.34, horizon - 40);
  ctx.lineTo(w * 0.52, horizon - 170);
  ctx.lineTo(w * 0.72, horizon - 60);
  ctx.lineTo(w * 0.88, horizon - 120);
  ctx.lineTo(w, horizon - 30);
  ctx.lineTo(w, horizon);
  ctx.closePath();
  ctx.fill();

  // 海面：暖橙 → 深紫
  const sea = ctx.createLinearGradient(0, horizon, 0, h);
  sea.addColorStop(0, "#b85c33");
  sea.addColorStop(0.4, "#5c3a52");
  sea.addColorStop(1, "#232038");
  ctx.fillStyle = sea;
  ctx.fillRect(0, horizon, w, h - horizon);

  // 太阳倒影带（高饱暖色碎条）
  ctx.fillStyle = "rgba(255, 190, 90, 0.55)";
  for (let i = 0; i < 26; i++) {
    const y = horizon + 10 + i * 13;
    const half = 30 + i * 4;
    const jitter = ((i * 37) % 23) - 11;
    ctx.fillRect(sunX - half + jitter, y, half * 2, 4);
  }

  setSource(
    canvas,
    ctx,
    "示例图 · 落日（程序生成）",
    canvas.toDataURL("image/jpeg", 0.92),
    null,
  );
}

/**
 * 缩样取数（任务 M4.2）：分析器统一入口，避免大图遍历（开发文档-M4 §5.3）。
 * @param maxEdge 缩样后最长边上限，默认 2048
 * @returns ImageData | null（无图返回 null）
 */
export function getSampledImageData(maxEdge = 2048): ImageData | null {
  if (!pixelCtx) return null;
  const { width, height } = pixelSize;
  if (width <= maxEdge && height <= maxEdge) {
    return pixelCtx.getImageData(0, 0, width, height);
  }
  // 等比缩小到最长边 = maxEdge
  const scale = maxEdge / Math.max(width, height);
  const sw = Math.round(width * scale);
  const sh = Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(pixelCtx.canvas, 0, 0, sw, sh);
  return ctx.getImageData(0, 0, sw, sh);
}
