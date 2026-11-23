/**
 * 主色提取（任务 M4.9）：委托 core/imaging（规划 D4 上移），签名不变。
 * 唯一数据入口仍是 imageSource.getSampledImageData；算法与 M3 图库共用。
 */
import {
  extractPaletteFromImageData,
  type PaletteColor,
} from "../../core/imaging/palette";
import { getSampledImageData } from "./imageSource";

export type { PaletteColor };

/** median-cut 主色（默认 6 色）；无图返回 null */
export function extractPalette(count = 6): PaletteColor[] | null {
  const imgData = getSampledImageData(64);
  if (!imgData) return null;
  return extractPaletteFromImageData(imgData, count);
}
