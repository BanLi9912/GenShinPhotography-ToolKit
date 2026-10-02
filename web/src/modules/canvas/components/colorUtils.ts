/**
 * 色彩工具：颜色解析与 RGB/HSV/HSL 互转。
 * 文本颜色统一以 rgb(r, g, b) 字符串存储（界面不出现 HEX 编码）。
 */

/** 任意 CSS 颜色 → "rgb(r, g, b)"（借 canvas fillStyle 的解析能力） */
export function normalizeColor(input: string): string {
  const ctx = getSharedContext();
  ctx.fillStyle = "#000"; // 先归位：非法值不会改变 fillStyle
  ctx.fillStyle = input;
  const value = ctx.fillStyle;
  if (value.startsWith("#")) {
    return `rgb(${parseInt(value.slice(1, 3), 16)}, ${parseInt(
      value.slice(3, 5),
      16,
    )}, ${parseInt(value.slice(5, 7), 16)})`;
  }
  return value; // 已是 rgb()/rgba() 形式
}

/** 解析 "rgb(r, g, b)" / "#rrggbb" 为分量；失败回退黑色 */
export function parseColor(input: string): {
  r: number;
  g: number;
  b: number;
} {
  const normalized = normalizeColor(input);
  const match = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(normalized);
  if (!match) return { r: 0, g: 0, b: 0 };
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  };
}

export interface Hsv {
  h: number; // 0–360
  s: number; // 0–100
  v: number; // 0–100
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  return {
    h,
    s: max === 0 ? 0 : (d / max) * 100,
    v: max * 100,
  };
}

export function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
  const sn = s / 100;
  const vn = v / 100;
  const c = vn * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = vn - c;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (h < 60) [rn, gn, bn] = [c, x, 0];
  else if (h < 120) [rn, gn, bn] = [x, c, 0];
  else if (h < 180) [rn, gn, bn] = [0, c, x];
  else if (h < 240) [rn, gn, bn] = [0, x, c];
  else if (h < 300) [rn, gn, bn] = [x, 0, c];
  else [rn, gn, bn] = [c, 0, x];
  return {
    r: Math.round((rn + m) * 255),
    g: Math.round((gn + m) * 255),
    b: Math.round((bn + m) * 255),
  };
}

export function rgbToHsl(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  if (h < 0) h += 360;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

let sharedContext: CanvasRenderingContext2D | null = null;
function getSharedContext(): CanvasRenderingContext2D {
  if (!sharedContext)
    sharedContext = document.createElement("canvas").getContext("2d");
  if (!sharedContext) throw new Error("无法创建颜色解析用 canvas");
  return sharedContext;
}
