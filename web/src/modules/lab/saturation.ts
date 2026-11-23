/**
 * 饱和度分析工具（开发文档-M4 §5.1/§5.2）：S 直方图已由 histogram.ts 负责；
 * 本文件实现 flyout 两项可覆盖渲染算法——饱和度检查（PS 50% 灰明度基准）+
 * 饱和热力（仅 S 映射灰→橙→红叠层）。
 * 纯函数，无 React 依赖。S 唯一来源 colorUtils.rgbToHsl。
 */
import { rgbToHsl, luma } from "../../core/imaging/color";

/* ---- 饱和度检查（PS 50% 纯灰 + 明度混合模式基准） ---- */

/**
 * 饱和度检查（就地改写 RGBA 缓冲区）：保持色相/饱和度，Rec.601 luma 归一到 128。
 * 色度向量 d = pixel - luma 平移到灰点 128；越界时按比例 k 整体压缩 d（hue-preserving
 * 裁剪：只降饱和不改色相），luma 精确保持 128。
 */
export function applySaturationCheck(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const L = luma(r, g, b);
    const dr = r - L;
    const dg = g - L;
    const db = b - L;

    // hue-preserving 裁剪：计算最大可缩放因子 k
    let k = 1;
    if (dr > 0) k = Math.min(k, 127 / dr);
    else if (dr < 0) k = Math.min(k, 128 / (-dr));
    if (dg > 0) k = Math.min(k, 127 / dg);
    else if (dg < 0) k = Math.min(k, 128 / (-dg));
    if (db > 0) k = Math.min(k, 127 / db);
    else if (db < 0) k = Math.min(k, 128 / (-db));

    data[i]     = Math.round(Math.max(0, Math.min(255, 128 + k * dr)));
    data[i + 1] = Math.round(Math.max(0, Math.min(255, 128 + k * dg)));
    data[i + 2] = Math.round(Math.max(0, Math.min(255, 128 + k * db)));
    // alpha 不动
  }
}

/* ---- 饱和热力 ---- */

/** 热力色带：S 0–100 → RGB。低饱和灰(128,128,128) → 橙(255,138,31) → 高饱和红(255,59,48) */
export function buildSatHeatRamp(): Uint8Array {
  const ramp = new Uint8Array(101 * 3);
  for (let i = 0; i < 101; i++) {
    const t = i / 100;
    const off = i * 3;
    if (t <= 0.5) {
      // 灰 → 橙
      const s = t / 0.5;
      ramp[off]     = Math.round(128 + (255 - 128) * s);
      ramp[off + 1] = Math.round(128 + (138 - 128) * s);
      ramp[off + 2] = Math.round(128 + (31 - 128) * s);
    } else {
      // 橙 → 红
      const s = (t - 0.5) / 0.5;
      ramp[off]     = Math.round(255);
      ramp[off + 1] = Math.round(138 + (59 - 138) * s);
      ramp[off + 2] = Math.round(31 + (48 - 31) * s);
    }
  }
  return ramp;
}

/** 热力叠层混合比：65% 色带 + 35% 原图（不糊图） */
export const SAT_HEAT_MIX = 0.65;

/**
 * 饱和热力（就地改写 RGBA 缓冲区）：s = rgbToHsl().s → 色带，
 * 按 SAT_HEAT_MIX 与原图混合。
 */
export function applySaturationHeat(data: Uint8ClampedArray): void {
  const ramp = buildSatHeatRamp();
  const t = SAT_HEAT_MIX;
  const invT = 1 - t;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const { s } = rgbToHsl(r, g, b);
    const si = Math.min(100, Math.max(0, Math.round(s)));
    const off = si * 3;
    data[i]     = Math.round(ramp[off] * t + r * invT);
    data[i + 1] = Math.round(ramp[off + 1] * t + g * invT);
    data[i + 2] = Math.round(ramp[off + 2] * t + b * invT);
  }
}
