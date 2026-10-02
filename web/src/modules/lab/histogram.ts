/**
 * 直方图统计（开发文档-M4 §5.2/§5.3）：纯函数，无 React 依赖。
 * 单趟循环统计 R/G/B/L 256 bin + 死黑/死白计数（luma ≤5/≥250）。
 * 口径：luma 走 colorUtils 的 Rec.601 luma()；缩样经 getSampledImageData。
 */

import { getSampledImageData } from "./imageSource";
import { luma, rgbToHsl } from "../../core/imaging/color";

export interface HistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array; // 各 256 bin
  total: number; // 参与统计的像素数
  deadBlack: number; // luma ≤ 5 占比（0–1）
  deadWhite: number; // luma ≥ 250 占比（0–1）
}

/** 计算直方图；无图返回 null。缓存由调用方 useMemo 负责 */
export function computeHistogram(maxEdge?: number): HistogramData | null {
  const img = getSampledImageData(maxEdge);
  if (!img) return null;

  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  let deadBlack = 0;
  let deadWhite = 0;
  const total = img.width * img.height;
  const data = img.data;

  for (let i = 0; i < data.length; i += 4) {
    const ri = data[i];
    const gi = data[i + 1];
    const bi = data[i + 2];
    r[ri] += 1;
    g[gi] += 1;
    b[bi] += 1;
    const li = Math.round(luma(ri, gi, bi));
    l[Math.min(255, li)] += 1;
    if (li <= 5) deadBlack += 1;
    if (li >= 250) deadWhite += 1;
  }

  return { r, g, b, l, total, deadBlack: deadBlack / total, deadWhite: deadWhite / total };
}

/** 饱和度分布（开发文档-M4 §5.1/§5.2：HSL S 0–100，101 bin） */
export interface SaturationData {
  hist: Uint32Array; // 101 bin（bin = round(s)，S 0–100）
  mean: number;      // 平均 S（0–100）
  total: number;
}

/** 计算饱和度分布；无图返回 null。纯函数，缓存由调用方 useMemo 负责 */
export function computeSaturationHistogram(maxEdge?: number): SaturationData | null {
  const img = getSampledImageData(maxEdge);
  if (!img) return null;

  const hist = new Uint32Array(101);
  let sum = 0;
  const total = img.width * img.height;
  const data = img.data;

  for (let i = 0; i < data.length; i += 4) {
    const { s } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const bin = Math.min(100, Math.round(s));
    hist[bin] += 1;
    sum += s;
  }

  return { hist, mean: sum / total, total };
}
