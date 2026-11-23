/**
 * M3.5.1 云端识图 · 图片压缩三档（D6 图库级，对齐 LibrarySettings.compression）。
 * auto = 最长边 1024、high = 1536：decodeImage → 等比缩放 canvas → toBlob(jpeg 0.85) → data URL；
 * original 不解码，File 直接转 base64 data URL。data URL 一律 FileReader.readAsDataURL。
 */

import { decodeImage } from "../../../core/imaging/sample";

export type CompressionTier = "auto" | "high" | "original";

export interface CompressedImage {
  dataUrl: string;
  bytes: number;
  width: number;
  height: number;
}

const TIER_MAX_EDGE: Record<Exclude<CompressionTier, "original">, number> = {
  auto: 1024,
  high: 1536,
};

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader 读取失败"));
    reader.readAsDataURL(blob);
  });
}

export async function compressForVision(
  file: File,
  tier: CompressionTier,
): Promise<CompressedImage> {
  if (tier === "original") {
    // 不解码，直接转 base64；file.type 为空时以 image/jpeg 包装（保证 data URL 带 mime）
    const source = file.type
      ? file
      : new File([file], file.name, { type: "image/jpeg" });
    const dataUrl = await readAsDataUrl(source);
    // 原始档不解码：尺寸未知记 0（成本/提示层不依赖）
    return { dataUrl, bytes: file.size, width: 0, height: 0 };
  }

  const bitmap = await decodeImage(file);
  try {
    const { width, height } = bitmap;
    const maxEdge = TIER_MAX_EDGE[tier];
    const scale = maxEdge / Math.max(width, height);
    const w = scale >= 1 ? width : Math.round(width * scale);
    const h = scale >= 1 ? height : Math.round(height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("canvas 转 JPEG 失败"))),
        "image/jpeg",
        0.85,
      );
    });
    const dataUrl = await readAsDataUrl(blob);
    return { dataUrl, bytes: blob.size, width: w, height: h };
  } finally {
    // 解码位图用完立即释放（照 pipeline/queue.ts 的释放惯例）
    bitmap.close();
  }
}
