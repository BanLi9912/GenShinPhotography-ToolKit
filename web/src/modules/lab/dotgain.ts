/**
 * Dot Gain 20% 工具（开发文档-M4 §5.2）：灰度化 + dot gain 特性曲线 LUT + 对照直方图统计。
 * 模型：Murray-Davies（50% 网点印刷后约 70%）+ 抛物线增益曲线 + 显示 gamma 2.2 编码。
 * 纯函数，无 React 依赖。
 */
import { luma } from "../../core/imaging/color";
import { getSampledImageData } from "./imageSource";

/* ---- LUT ---- */

/** dot gain 20% 特性曲线 LUT：输入灰度(0–255，显示值) → 校样灰度。中间调压暗 */
export function buildDotGainLut(): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const dot = 1 - i / 255;                             // 名义网点面积（白=0 黑=1）
    const gained = dot + 0.2 * 4 * dot * (1 - dot);      // 增益曲线：50% 处 +0.20，两端为 0
    lut[i] = Math.round(255 * Math.pow(1 - gained, 1 / 2.2)); // 反射率 → 显示编码
  }
  return lut;
}

/* ---- 对照直方图 ---- */

export interface DotGainHistogram {
  orig: Uint32Array;  // 原图 luma 256 bin
  proof: Uint32Array; // 校样（lut[luma]）256 bin
}

/** 原图 vs 校样灰度分布；无图返回 null。缓存由调用方 useMemo 负责 */
export function computeDotGainHistogram(): DotGainHistogram | null {
  const imgData = getSampledImageData();
  if (!imgData) return null;

  const lut = buildDotGainLut();
  const orig = new Uint32Array(256);
  const proof = new Uint32Array(256);
  const d = imgData.data;

  for (let i = 0; i < d.length; i += 4) {
    const li = Math.min(255, Math.round(luma(d[i], d[i + 1], d[i + 2])));
    orig[li]++;
    proof[lut[li]]++;
  }

  return { orig, proof };
}
