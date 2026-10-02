/**
 * M3.2.1 · Pass A 原图尺寸嗅探（纯函数零依赖）。
 * 用途：Pass A 需在解码前拿到原图尺寸，以计算 `createImageBitmap` 的
 * resizeWidth/resizeHeight 双参（等比缩到 ≤960；只给一个会拉伸）。
 * 只读 blob 前 64KB（`blob.slice(0, 65536)`），按魔数分派手写解析：
 * - jpeg：`FFD8` 起逐段（段 = FF + 标记 + 2 字节大端长度），命中 SOF0–15
 *   （`FFC0–FFCF`，排除 C4/C8/CC）→ 高 = 段内偏移 5–6、宽 = 7–8（大端）；
 *   同时解析 APP1 EXIF 的 Orientation（0x0112）：5–8 为横存竖图（需旋转 90/270°），
 *   返回的 width/height **已按显示方向调换**，并附 `orientation` 供 Pass A 旋转回正
 *   （`createImageBitmap` 不应用 EXIF 旋转，而 `<img>` 显示应用——不调换必横竖错乱）；
 * - png：`89 50 4E 47` 签名 → IHDR 固定位：宽 = 字节 16–19、高 = 20–23（大端）；
 * - webp：`RIFF????WEBP` → `VP8X`（宽 = 24–26 24bit 小端 +1、高 = 27–29 +1）/
 *   `VP8 `（有损，定位 `9D 01 2A` 起始码后 宽/高 各 2 字节小端 &0x3FFF）/
 *   `VP8L`（`2F` 签名后 4 字节位打包）。
 * 支持格式之外 / 截断 / 字段越界 / 任何异常 → 返回 **null**：调用方（queue.ts
 * Pass A）回退全解码取尺寸，本函数永不抛错。
 */

function u16be(d: Uint8Array, o: number): number {
  return ((d[o] << 8) | d[o + 1]) & 0xffff;
}

/**
 * 解析 TIFF 块的 Orientation（tag 0x0112，SHORT type）：支持 II/MM 字节序、
 * IFD0 条目扫描（12 字节/条）；tag 缺失/类型异常/越界 → null（不阻断尺寸嗅探）。
 * 返回 1–8；非标准值按 1 处理（调用方只对 5–8 调换/旋转）。
 */
function parseTiffOrientation(t: Uint8Array): number | null {
  if (t.length < 12) return null;
  const little = t[0] === 0x49 && t[1] === 0x49;
  const big = t[0] === 0x4d && t[1] === 0x4d;
  if (!little && !big) return null;
  const rd16 = (o: number): number => {
    if (little) return (t[o] | (t[o + 1] << 8)) & 0xffff;
    return ((t[o] << 8) | t[o + 1]) & 0xffff;
  };
  const rd32 = (o: number): number => {
    if (little) {
      return (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16) | (t[o + 3] << 24)) >>> 0;
    }
    return (((t[o] << 24) | (t[o + 1] << 16) | (t[o + 2] << 8) | t[o + 3]) >>> 0);
  };
  if (rd16(2) !== 0x2a) return null;
  const ifd0 = rd32(4);
  if (ifd0 + 2 > t.length) return null;
  const count = rd16(ifd0);
  if (count === 0 || ifd0 + 2 + count * 12 + 2 > t.length) return null;
  for (let i = 0; i < count; i++) {
    const e = ifd0 + 2 + i * 12;
    if (rd16(e) !== 0x0112) continue; // Orientation
    const type = rd16(e + 2);
    if (type !== 3) return null; // SHORT
    const value = rd16(e + 8); // count=1 时值直接内嵌
    return value >= 1 && value <= 8 ? value : 1;
  }
  return null;
}

/** 扫描 JPEG 段找 APP1 EXIF，返回 Orientation（1–8）或 null（无/解析失败） */
function sniffJpegOrientation(d: Uint8Array): number | null {
  let o = 2;
  while (o + 4 <= d.length) {
    if (d[o] !== 0xff) return null;
    const marker = d[o + 1];
    if (marker === 0xff) {
      o += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2;
      continue;
    }
    if (marker === 0xd9) return null;
    const segLen = u16be(d, o + 2);
    if (segLen < 2 || o + 2 + segLen > d.length) return null;
    if (
      marker === 0xe1 &&
      segLen >= 14 &&
      d[o + 4] === 0x45 && // "Exif\0\0"
      d[o + 5] === 0x78 &&
      d[o + 6] === 0x69 &&
      d[o + 7] === 0x66 &&
      d[o + 8] === 0x00 &&
      d[o + 9] === 0x00
    ) {
      return parseTiffOrientation(d.subarray(o + 10, o + 2 + segLen));
    }
    o += 2 + segLen;
  }
  return null;
}

export interface SniffDims {
  width: number;
  height: number;
  /** EXIF Orientation（1–8）；5–8 = 横存竖图，width/height 已调换为显示方向 */
  orientation?: number;
}

function sniffJpeg(d: Uint8Array): SniffDims | null {
  if (d[0] !== 0xff || d[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= d.length) {
    if (d[o] !== 0xff) return null; // 段边界破坏（截断/非标准流）
    const marker = d[o + 1];
    if (marker === 0xff) {
      o += 1; // 填充字节
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2; // 无长度段（RST/TEM 等）
      continue;
    }
    if (marker === 0xd9) return null; // EOI：SOF 之前结束，无尺寸
    const segLen = u16be(d, o + 2);
    if (segLen < 2 || o + 2 + segLen > d.length) return null;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      // SOF0–15：段 = FF 标记 长度(2) 精度(1) 高(2) 宽(2)…
      if (o + 9 > d.length) return null;
      const height = u16be(d, o + 5);
      const width = u16be(d, o + 7);
      if (width > 0 && height > 0) {
        const orientation = sniffJpegOrientation(d);
        // 横存竖图（5–8）：按显示方向调换宽高，附 orientation 供 Pass A 旋转回正
        if (orientation !== null && orientation >= 5) {
          return { width: height, height: width, orientation };
        }
        return orientation ? { width, height, orientation } : { width, height };
      }
      return null;
    }
    o += 2 + segLen;
  }
  return null;
}

function sniffPng(d: Uint8Array): SniffDims | null {
  // 签名 89 50 4E 47 0D 0A 1A 0A + IHDR（首块）：宽 16–19、高 20–23（大端）
  if (d.length < 24) return null;
  if (
    d[0] !== 0x89 ||
    d[1] !== 0x50 ||
    d[2] !== 0x4e ||
    d[3] !== 0x47 ||
    d[4] !== 0x0d ||
    d[5] !== 0x0a ||
    d[6] !== 0x1a ||
    d[7] !== 0x0a
  ) {
    return null;
  }
  if (d[12] !== 0x49 || d[13] !== 0x48 || d[14] !== 0x44 || d[15] !== 0x52) {
    return null; // 非 IHDR 首块（异常流）
  }
  const width = ((d[16] << 24) | (d[17] << 16) | (d[18] << 8) | d[19]) >>> 0;
  const height = ((d[20] << 24) | (d[21] << 16) | (d[22] << 8) | d[23]) >>> 0;
  if (width > 0 && height > 0) return { width, height };
  return null;
}

function sniffWebp(d: Uint8Array): SniffDims | null {
  if (d.length < 30) return null;
  if (d[0] !== 0x52 || d[1] !== 0x49 || d[2] !== 0x46 || d[3] !== 0x46) return null; // "RIFF"
  if (d[8] !== 0x57 || d[9] !== 0x45 || d[10] !== 0x42 || d[11] !== 0x50) return null; // "WEBP"
  const fourcc = String.fromCharCode(d[12], d[13], d[14], d[15]);
  if (fourcc === "VP8X") {
    // 扩展格式：宽/高 = 24bit 小端字段 + 1
    const width = 1 + (d[24] | (d[25] << 8) | (d[26] << 16));
    const height = 1 + (d[27] | (d[28] << 8) | (d[29] << 16));
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  if (fourcc === "VP8 ") {
    // 有损：定位 9D 01 2A 起始码，其后的宽/高各 2 字节小端 &0x3FFF
    for (let i = 12; i + 7 <= d.length; i++) {
      if (d[i] === 0x9d && d[i + 1] === 0x01 && d[i + 2] === 0x2a) {
        const width = (d[i + 3] | (d[i + 4] << 8)) & 0x3fff;
        const height = (d[i + 5] | (d[i + 6] << 8)) & 0x3fff;
        if (width > 0 && height > 0) return { width, height };
        return null;
      }
    }
    return null;
  }
  if (fourcc === "VP8L") {
    // 无损：2F 签名后 4 字节大端位打包（每值 14 bit + 1）
    if (d[20] !== 0x2f) return null;
    const b0 = d[21];
    const b1 = d[22];
    const b2 = d[23];
    const b3 = d[24];
    const width = 1 + (b0 | ((b1 & 0x3f) << 8));
    const height = 1 + (((b1 & 0xc0) >> 6) | (b2 << 2) | ((b3 & 0x0f) << 10));
    if (width > 0 && height > 0) return { width, height };
    return null;
  }
  return null;
}

/**
 * 嗅探 blob 原图尺寸：只读前 64KB 按魔数分派；返回 null = 格式不支持或
 * 头部不完整，调用方回退全解码（本函数永不抛错）。
 * jpeg 附带 EXIF Orientation（5–8 时 width/height 已调换为显示方向）。
 */
export async function sniffDimensions(
  blob: Blob,
): Promise<SniffDims | null> {
  try {
    const buf = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
    if (buf.length < 24) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) return sniffJpeg(buf);
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return sniffPng(buf);
    }
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return sniffWebp(buf);
    }
    return null;
  } catch {
    return null;
  }
}
