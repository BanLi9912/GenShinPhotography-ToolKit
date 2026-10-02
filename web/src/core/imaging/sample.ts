/**
 * decode / 缩样取数 helpers（M3.2，规划 D4）。
 * `sampleImageData` 与 M4 `imageSource.getSampledImageData` 同源算法（最长边等比、
 * drawImage + getImageData）——M3 主色与 M4 主色板一致性的验收依据。
 * canvas 用后即弃（函数内局部）：多图并发安全优先于省一次分配。
 */

/** Blob → ImageBitmap；解码失败上抛（队列捕获计失败） */
export async function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob);
}

/** 等比缩样：最长边 ≤ maxEdge 保持原尺寸，否则等比缩到最长边 = maxEdge */
export function sampleImageData(bitmap: ImageBitmap, maxEdge: number): ImageData {
  const { width, height } = bitmap;
  const scale = maxEdge / Math.max(width, height);
  const sw = scale >= 1 ? width : Math.round(width * scale);
  const sh = scale >= 1 ? height : Math.round(height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, sw, sh);
  return ctx.getImageData(0, 0, sw, sh);
}

/** 非等比拉伸到 edge×edge（pHash 用，经典做法不保持比例） */
export function squareImageData(bitmap: ImageBitmap, edge: number): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, edge, edge);
  return ctx.getImageData(0, 0, edge, edge);
}
