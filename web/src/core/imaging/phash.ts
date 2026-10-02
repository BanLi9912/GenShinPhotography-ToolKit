/**
 * pHash（M3.2，口径钉死）：32×32 luma 灰度阵 → 二维 DCT-II → 左上 8×8 系数
 * （去 DC 取 63 个 AC 中位数）→ 64 位行优先位串 → 16 位小写 hex。
 * 余弦表/α 系数模块级预计算；不引库。Hamming 距离供 M3.3 相似图复用。
 */
import { luma } from "./color";

const DCT_SIZE = 32;

/** α(0)=√(1/2)，余为 1 */
const ALPHA: number[] = (() => {
  const arr: number[] = [];
  for (let u = 0; u < DCT_SIZE; u++) arr.push(u === 0 ? Math.sqrt(1 / 2) : 1);
  return arr;
})();

/** cosTable[u][x] = cos((2x+1)uπ/64)，模块级预计算 */
const COS: number[][] = (() => {
  const table: number[][] = [];
  for (let u = 0; u < DCT_SIZE; u++) {
    const row: number[] = [];
    for (let x = 0; x < DCT_SIZE; x++) {
      row.push(Math.cos(((2 * x + 1) * u * Math.PI) / 64));
    }
    table.push(row);
  }
  return table;
})();

/** 4-bit popcount 表（Hamming 距离用） */
const POPCOUNT: number[] = (() => {
  const arr: number[] = [];
  for (let i = 0; i < 16; i++) {
    arr.push((i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
  }
  return arr;
})();

/** 计算 pHash；入参 = squareImageData(bitmap, 32) */
export function computePhash(imgData32: ImageData): string {
  const { width, height, data } = imgData32;
  const p: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      row.push(Math.round(luma(data[i], data[i + 1], data[i + 2])));
    }
    p.push(row);
  }

  // 左上 8×8 系数（C(u,v) = (2/32)·α(u)α(v)·ΣΣ p·cos·cos）
  const coeff: number[][] = [];
  for (let v = 0; v < 8; v++) {
    const row: number[] = [];
    for (let u = 0; u < 8; u++) {
      let sum = 0;
      for (let y = 0; y < DCT_SIZE; y++) {
        for (let x = 0; x < DCT_SIZE; x++) {
          sum += p[y][x] * COS[u][x] * COS[v][y];
        }
      }
      row.push((2 / DCT_SIZE) * ALPHA[u] * ALPHA[v] * sum);
    }
    coeff.push(row);
  }

  const ac: number[] = [];
  for (let v = 0; v < 8; v++) {
    for (let u = 0; u < 8; u++) {
      if (u === 0 && v === 0) continue;
      ac.push(coeff[v][u]);
    }
  }
  ac.sort((a, b) => a - b);
  const median = ac[31];

  // 64 位按 8×8 行优先；(0,0) 恒 0，其余 = 系数 > 中位数；每 4 位转 1 hex
  let hex = "";
  for (let v = 0; v < 8; v++) {
    let bits = "";
    for (let u = 0; u < 8; u++) {
      bits += v === 0 && u === 0 ? "0" : coeff[v][u] > median ? "1" : "0";
    }
    for (let g = 0; g < 2; g++) {
      hex += parseInt(bits.slice(g * 4, g * 4 + 4), 2).toString(16);
    }
  }
  return hex;
}

/** 两个 16-hex pHash 串的 Hamming 距离（逐 nibble 异或 popcount） */
export function hammingHex(a: string, b: string): number {
  let dist = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dist += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return dist;
}
