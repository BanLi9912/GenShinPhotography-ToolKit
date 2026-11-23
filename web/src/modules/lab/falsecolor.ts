/**
 * 假彩色工具（任务 M4.6，开发文档-M4 §5.2）：明度 → 影视 False Color
 * 标准色带逐像素映射 + 明度直方图统计。
 * 色带方向（验收钉死）：暗部蓝紫系 → 中调绿 → 亮部橙红 → 削波品红警示。
 * LUT 可换：色标表独立常量，换带只改 FALSE_COLOR_STOPS。
 * 纯函数，无 React 依赖（模式对齐 dotgain.ts）。
 */
import { luma } from "../../core/imaging/color";

/* ---- 色带（影视 False Color 标准带，A 定稿 2026-10-02） ---- */

/**
 * 色标表：at = luma 0–255，rgb 为 8bit。相邻色标线性插值生成 256 级 LUT。
 * 依据：影视监视器 False Color 通行方向（暗部蓝紫/青 → 中调绿 → 亮部黄/橙/红，
 * 近削波品红警示、死黑保持黑）；演示 HTML 的演示带（蓝→青→绿→黄→红）为本带的
 * 近似子集，本带补全暗部紫端与削波品红端。
 */
export const FALSE_COLOR_STOPS: ReadonlyArray<{
  at: number;
  rgb: readonly [number, number, number];
}> = [
  { at: 0, rgb: [0, 0, 0] }, // 死黑
  { at: 18, rgb: [32, 0, 128] }, // 极暗部：深紫
  { at: 40, rgb: [43, 80, 214] }, // 暗部：蓝
  { at: 70, rgb: [0, 150, 200] }, // 偏暗：青
  { at: 100, rgb: [20, 160, 74] }, // 中偏暗：绿
  { at: 128, rgb: [126, 203, 47] }, // 中调：黄绿
  { at: 155, rgb: [217, 211, 32] }, // 中偏亮：黄
  { at: 180, rgb: [240, 140, 26] }, // 亮部：橙
  { at: 205, rgb: [227, 36, 23] }, // 高亮：红
  { at: 228, rgb: [176, 0, 110] }, // 近削波：品红
  { at: 246, rgb: [255, 0, 255] }, // 削波警示：高品红
];

/** 明度 LUT（256×3，行优先 RGB）；相邻色标线性插值，末色标延伸到 255 */
export function buildFalseColorLut(): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const last = FALSE_COLOR_STOPS[FALSE_COLOR_STOPS.length - 1];
  for (let i = 0; i < 256; i++) {
    // 末色标之后（削波警示段尾）保持末色标本色，不再插值
    // —— 末色标在 246，247–255 若落进首个区间会被插值回死黑附近，削波警示随之失效
    let s0 = FALSE_COLOR_STOPS[0];
    let s1 = last;
    if (i >= last.at) {
      s0 = last;
      s1 = last;
    } else {
      // 找到 i 所在的色标区间（stops 有序，线性扫描即可）
      for (let k = 0; k < FALSE_COLOR_STOPS.length - 1; k++) {
        const a = FALSE_COLOR_STOPS[k];
        const b = FALSE_COLOR_STOPS[k + 1];
        if (i >= a.at && i <= b.at) {
          s0 = a;
          s1 = b;
          break;
        }
      }
    }
    const span = s1.at - s0.at;
    const t = span > 0 ? (i - s0.at) / span : 0;
    lut[i * 3] = Math.round(s0.rgb[0] + (s1.rgb[0] - s0.rgb[0]) * t);
    lut[i * 3 + 1] = Math.round(s0.rgb[1] + (s1.rgb[1] - s0.rgb[1]) * t);
    lut[i * 3 + 2] = Math.round(s0.rgb[2] + (s1.rgb[2] - s0.rgb[2]) * t);
  }
  return lut;
}

/* ---- 明度直方图（与色带映射严格同源：同一个 luma） ---- */

export interface FalseColorHistogram {
  /** luma 0–255 共 256 bin */
  hist: Uint32Array;
  total: number;
}

/**
 * 明度分布；无图返回 null。取样统计（口径同 computeDotGainHistogram）。
 * 取数由调用方传入：本模块只做纯计算——若此处 import imageSource 取数，
 * 会与 imageSource → 本模块（色带 LUT）形成循环依赖，Vite 下该绑定会失效
 * （实测 computeFalseColorHistogram 恒返回 null，面板读数全为「—」）。
 */
export function computeFalseColorHistogram(imgData: ImageData | null): FalseColorHistogram | null {
  if (!imgData) return null;
  const hist = new Uint32Array(256);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    hist[Math.min(255, Math.round(luma(d[i], d[i + 1], d[i + 2])))]++;
  }
  return { hist, total: d.length / 4 };
}

/** 暗部占比（luma ≤ 40，即 ≤ 约 16%亮度） */
export function falseColorShadowPct(h: FalseColorHistogram): number {
  const n = h.hist.slice(0, 41).reduce((a, b) => a + b, 0);
  return (n / h.total) * 100;
}

/** 削波占比（luma ≥ 246，色带品红警示段） */
export function falseColorClipPct(h: FalseColorHistogram): number {
  const n = h.hist.slice(246).reduce((a, b) => a + b, 0);
  return (n / h.total) * 100;
}
