/**
 * 明度直方图（任务 M3.3.2，library 详情页专用）。
 * M4 的 RGB 直方图在 lab 内不动、两口径互不引用；
 * luma 口径统一走 ./color（Rec.601），禁止此处另算。
 */
import { luma, rgbToHsl } from "./color";

/**
 * 逐像素按 luma(r,g,b)（0–255）映射到 bins 个等分桶，返回各桶计数数组。
 * 桶 i 覆盖 [i*256/bins, (i+1)*256/bins)，255 归入最后一桶。
 */
export function lumaHistogram(imgData: ImageData, bins = 32): number[] {
  const counts = new Array<number>(bins).fill(0);
  const step = 256 / bins;
  const { data } = imgData;
  for (let i = 0; i < data.length; i += 4) {
    const value = luma(data[i], data[i + 1], data[i + 2]);
    const bucket = Math.min(bins - 1, Math.floor(value / step));
    counts[bucket] += 1;
  }
  return counts;
}

/**
 * 饱和度直方图：逐像素取 W3C HSL 的 S（0–100，与 meanSat 同口径），
 * 映射到 bins 个等分桶，返回各桶计数数组。详情页叠加曲线用，与 lumaHistogram 同源同 bins。
 */
export function satHistogram(imgData: ImageData, bins = 32): number[] {
  const counts = new Array<number>(bins).fill(0);
  const step = 100 / bins;
  const { data } = imgData;
  for (let i = 0; i < data.length; i += 4) {
    const { s } = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    const bucket = Math.min(bins - 1, Math.floor(s / step));
    counts[bucket] += 1;
  }
  return counts;
}
