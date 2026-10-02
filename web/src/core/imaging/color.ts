/**
 * core/imaging 色彩换算：M4 上移（规划 D4），全应用唯一实现，禁止各处自算。
 * RGB↔HSL↔HEX 与 luma（Rec.601）自 `modules/lab/colorUtils.ts` 逐字上移（含注释）；
 * S 取 W3C HSL 的 S，与明度解耦（口径验收：纯灰 = 0、纯色 = 1、近白接近 0）。
 */

/** RGB（0–255）→ HSL（h 0–360，s/l 0–100） */
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
  const l = (max + min) / 2;
  const d = max - min;

  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

/** HSL（h 0–360，s/l 0–100）→ RGB（0–255 整数四舍五入），与 rgbToHsl 互逆（往返误差 ≤1） */
export function hslToRgb(
  h: number,
  s: number,
  l: number,
): { r: number; g: number; b: number } {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ln - c / 2;

  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (h < 60) { rn = c; gn = x; bn = 0; }
  else if (h < 120) { rn = x; gn = c; bn = 0; }
  else if (h < 180) { rn = 0; gn = c; bn = x; }
  else if (h < 240) { rn = 0; gn = x; bn = c; }
  else if (h < 300) { rn = x; gn = 0; bn = c; }
  else { rn = c; gn = 0; bn = x; }

  return {
    r: Math.round((rn + m) * 255),
    g: Math.round((gn + m) * 255),
    b: Math.round((bn + m) * 255),
  };
}

/** RGB（0–255）→ HEX 小写 "#rrggbb" */
export function rgbToHex(r: number, g: number, b: number): string {
  const hex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** HEX → RGB（0–255）；支持 "#rgb"/"#rrggbb"、可容忍省略 "#"；非法输入返回 null */
export function hexToRgb(
  hex: string,
): { r: number; g: number; b: number } | null {
  let h = hex.trim();
  if (h.startsWith("#")) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

/**
 * Rec.601 luma：`0.299R + 0.587G + 0.114B`（0–255）。
 * 开发文档-M4 §5.2 唯一点名的 luma 口径，直方图 L 通道、死黑/死白判定、
 * 饱和度检查视图等全部共用此函数。
 */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 12 色相桶中心（每桶 30°，边界 ±15°）：红(0) 橙(30) 黄(60) … 品红(330) */
const HUE_BUCKETS: Array<[number, string]> = [
  [0, "红"],
  [30, "橙"],
  [60, "黄"],
  [90, "黄绿"],
  [120, "绿"],
  [150, "青绿"],
  [180, "青"],
  [210, "钴蓝"],
  [240, "蓝"],
  [270, "蓝紫"],
  [300, "紫"],
  [330, "品红"],
];

/** 主色色名（M3.2 口径钉死）：灰阶按明度分段，非灰阶取最近色相桶 + 明度前缀 */
export function colorName(r: number, g: number, b: number): string {
  const { h, s, l } = rgbToHsl(r, g, b);

  if (s < 12) {
    if (l < 12) return "黑";
    if (l < 30) return "深灰";
    if (l < 70) return "灰";
    if (l < 88) return "浅灰";
    return "白";
  }

  let name = "红";
  let best = Infinity;
  for (const [center, label] of HUE_BUCKETS) {
    const dist = Math.min(Math.abs(h - center), 360 - Math.abs(h - center));
    if (dist < best) {
      best = dist;
      name = label;
    }
  }

  if (l < 25) return `深${name}`;
  if (l > 80) return `浅${name}`;
  return name;
}

/** CIE Lab（D65/2°）：sRGB 0–255 → {L, a, b}；色板点色搜索的距离空间（M3.4） */
export function rgbToLab(
  r: number,
  g: number,
  b: number,
): { L: number; a: number; b: number } {
  const lin = (c: number) => {
    const s = c / 255;
    return s > 0.04045 ? Math.pow((s + 0.055) / 1.055, 2.4) : s / 12.92;
  };
  const rl = lin(r);
  const gl = lin(g);
  const bl = lin(b);
  // D65 矩阵（Xn=95.047 / Yn=100 / Zn=108.883）
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) * 100;
  const y = (rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175) * 100;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) * 100;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 95.047);
  const fy = f(y / 100);
  const fz = f(z / 108.883);
  return {
    L: 116 * fy - 16,
    a: 500 * (fx - fy),
    b: 200 * (fy - fz),
  };
}

/** CIE76 色差：Lab 欧氏距离 */
export function labDistance(
  x: { L: number; a: number; b: number },
  y: { L: number; a: number; b: number },
): number {
  const dl = x.L - y.L;
  const da = x.a - y.a;
  const db = x.b - y.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}
