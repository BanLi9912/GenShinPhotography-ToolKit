/**
 * median-cut 主色（M4.9 落地版上移，规划 D4）；M4 主色板与 M3 图库共用此实现。
 * 纯函数：入参为 ImageData，调用方负责缩样。
 */
import { rgbToHex, rgbToHsl } from "./color";

export interface PaletteColor {
  r: number; g: number; b: number;
  hex: string;
  h: number; s: number; l: number;
  /** 占比 0–1 */
  p: number;
}

/**
 * median-cut 主色提取（移植演示 :522-545）：切盒评分 = 最大通道极差 × 盒内像素数，
 * 沿极差最大通道中位数切分，逐盒取均值；最多产出 count 色。
 */
export function extractPaletteFromImageData(
  imgData: ImageData,
  count = 6,
): PaletteColor[] {
  const { width, height, data } = imgData;
  const px: number[][] = [];
  for (let i = 0; i < width * height; i++) {
    px.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  }

  const boxes: number[][][] = [px];
  while (boxes.length < count) {
    let bi = -1;
    let bs = -1;
    boxes.forEach((bx, i) => {
      if (bx.length < 2) return;
      const rng = channelRange(bx);
      const score = Math.max(rng[0], rng[1], rng[2]) * bx.length;
      if (score > bs) { bs = score; bi = i; }
    });
    if (bi < 0) break;

    const bx = boxes[bi];
    const rng = channelRange(bx);
    const ch = rng.indexOf(Math.max(rng[0], rng[1], rng[2]));
    bx.sort((a, b) => a[ch] - b[ch]);
    const mid = bx.length >> 1;
    boxes.splice(bi, 1, bx.slice(0, mid), bx.slice(mid));
  }

  const total = width * height;
  return boxes
    .map((bx) => {
      let r = 0, g = 0, b = 0;
      for (const p of bx) { r += p[0]; g += p[1]; b += p[2]; }
      r /= bx.length; g /= bx.length; b /= bx.length;
      const { h, s, l } = rgbToHsl(r, g, b);
      const rr = Math.round(r), gg = Math.round(g), bb = Math.round(b);
      return {
        r: rr, g: gg, b: bb,
        hex: rgbToHex(rr, gg, bb),
        h, s, l,
        p: bx.length / total,
      };
    })
    .sort((a, b) => b.p - a.p)
    .slice(0, count);
}

/** 三通道极差（[r, g, b]），median-cut 切盒评分用 */
function channelRange(bx: number[][]): [number, number, number] {
  const rng: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    let mn = 255;
    let mx = 0;
    for (const p of bx) {
      mn = Math.min(mn, p[c]);
      mx = Math.max(mx, p[c]);
    }
    rng[c] = mx - mn;
  }
  return rng;
}
