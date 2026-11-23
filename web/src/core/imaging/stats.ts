/**
 * M3.2 基础统计（口径钉死）：输入均为 64×64 缩样 ImageData（管线内只缩一次）。
 */
import { luma, rgbToHex, rgbToHsl } from "./color";

export interface RgbHex {
  r: number;
  g: number;
  b: number;
  hex: string;
}

/** 全像素 Rec.601 luma 均值（÷255×100）与全像素 HSL s 均值；各保留 1 位小数（0–100） */
export function meanLumaSat(imgData: ImageData): { meanLuma: number; meanSat: number } {
  const { width, height, data } = imgData;
  const n = width * height;
  let lsum = 0;
  let ssum = 0;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    lsum += luma(r, g, b);
    ssum += rgbToHsl(r, g, b).s;
  }
  return {
    meanLuma: Math.round((lsum / n / 255) * 100 * 10) / 10,
    meanSat: Math.round((ssum / n) * 10) / 10,
  };
}

/**
 * 明暗倾向（分区曝光法，用户校准 2026-08-09）：中调以 5 区（18% 灰 ≈ sRGB 50）
 * 为锚点收窄到 40–60；<40 低调（对应 1–3 区）、>60 高调（对应 7–9 区）。
 */
export function toneOf(meanLuma: number): "low" | "mid" | "high" {
  if (meanLuma < 40) return "low";
  if (meanLuma > 60) return "high";
  return "mid";
}

/**
 * 高光/暗部代表色：luma ≥ P85 像素均值 = hi，≤ P15 = lo；
 * 某侧像素数 < 16 时降级为该侧最亮/最暗 16 像素均值（排序后取尾/首）。
 */
export function hiLoColors(
  imgData: ImageData,
): { hi: RgbHex | null; lo: RgbHex | null } {
  const { width, height, data } = imgData;
  const n = width * height;
  if (n === 0) return { hi: null, lo: null };

  const rows: Array<{ l: number; r: number; g: number; b: number }> = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    rows[i] = { l: luma(r, g, b), r, g, b };
  }
  rows.sort((a, b) => a.l - b.l);

  const hiThreshold = rows[Math.floor((n - 1) * 0.85)].l;
  const loThreshold = rows[Math.floor((n - 1) * 0.15)].l;
  let hiPixels = rows.filter((p) => p.l >= hiThreshold);
  let loPixels = rows.filter((p) => p.l <= loThreshold);
  if (hiPixels.length < 16) hiPixels = rows.slice(-16);
  if (loPixels.length < 16) loPixels = rows.slice(0, 16);

  const mean = (
    arr: Array<{ r: number; g: number; b: number }>,
  ): RgbHex => {
    let r = 0, g = 0, b = 0;
    for (const p of arr) { r += p.r; g += p.g; b += p.b; }
    const rr = Math.round(r / arr.length);
    const gg = Math.round(g / arr.length);
    const bb = Math.round(b / arr.length);
    return { r: rr, g: gg, b: bb, hex: rgbToHex(rr, gg, bb) };
  };

  return { hi: mean(hiPixels), lo: mean(loPixels) };
}
