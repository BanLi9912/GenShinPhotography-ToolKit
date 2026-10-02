/**
 * M3.2 单图基础分析编排（规划 D4）：尺寸 / 主色 6 色（HEX+占比+色名）/
 * 平均明度/平均饱和度/明暗倾向/高光暗部代表色 / pHash / 缩略图。
 * 色彩空间不落字段：web 解码统一 sRGB，schema 无此 key（规划 §5 不加 key）。
 */
import { colorName } from "../../../core/imaging/color";
import { extractPaletteFromImageData } from "../../../core/imaging/palette";
import { computePhash } from "../../../core/imaging/phash";
import { sampleImageData, squareImageData } from "../../../core/imaging/sample";
import {
  hiLoColors,
  meanLumaSat,
  toneOf,
  type RgbHex,
} from "../../../core/imaging/stats";

/**
 * 分析管线版本：算法变更 +1，旧条目因 pipelineVersion < 当前值自动重跑
 * （v3：缩略图 960/q85；v4：影调判定按分区曝光法校准，中调收窄为 40–60）
 */
export const PIPELINE_VERSION = 4;

export interface AnalysisPatch {
  width: number;
  height: number;
  meanLuma: number;
  meanSat: number;
  tone: "low" | "mid" | "high";
  hiColor: RgbHex | null;
  loColor: RgbHex | null;
  phash: string;
  colors: Array<{ hex: string; ratio: number; name: string }>;
  analyzedAt: number;
  pipelineVersion: number;
}

/** 单图全部分析（bitmap 为原图；64×64 缩样只做一次） */
export function analyzeImage(bitmap: ImageBitmap): AnalysisPatch {
  const sample = sampleImageData(bitmap, 64);
  const { meanLuma, meanSat } = meanLumaSat(sample);
  const { hi, lo } = hiLoColors(sample);
  const palette = extractPaletteFromImageData(sample, 6);

  return {
    width: bitmap.width,
    height: bitmap.height,
    meanLuma,
    meanSat,
    tone: toneOf(meanLuma),
    hiColor: hi,
    loColor: lo,
    phash: computePhash(squareImageData(bitmap, 32)),
    colors: palette.map((c) => ({
      hex: c.hex,
      ratio: Number(c.p.toFixed(3)),
      name: colorName(c.r, c.g, c.b),
    })),
    analyzedAt: Date.now(),
    pipelineVersion: PIPELINE_VERSION,
  };
}
