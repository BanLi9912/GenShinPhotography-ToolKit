/**
 * M3.2 缩略图（规划 D2）：等比缩到最长边 ≤ 320 → WebP q80 → 原子写
 * `.ystk/thumbs/<id>.<ext>`；扩展名以实际 blob type 定（webp/png 回退）。
 * 2026-08-08 用户反馈：上限 320→640（偏糊）→ 960（横图在 2x 屏也够用），质量 q85。
 * 任一步失败返回 null（thumb 缺省不阻塞分析）。
 */
import { writeBlobAtomic } from "../../../core/storage/fsa";

/** 缩略图最长边上限（用户反馈后 320→640→960）；LibraryPage 按需取源时引用 */
export const THUMB_EDGE = 960;
const THUMB_QUALITY = 0.85;

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** 生成并写盘缩略图；返回 schema thumb 值（`thumbs/<id>.<ext>`，不含 `.ystk/` 前缀） */
export async function makeThumb(
  dir: FileSystemDirectoryHandle,
  bitmap: ImageBitmap,
  id: string,
): Promise<string | null> {
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    const scale = longest > THUMB_EDGE ? THUMB_EDGE / longest : 1;
    const tw = Math.max(1, Math.round(bitmap.width * scale));
    const th = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, tw, th);
    const blob = await canvasToBlob(canvas, "image/webp", THUMB_QUALITY);
    if (!blob) return null;
    const ext = blob.type === "image/png" ? "png" : "webp";
    const relPath = `.ystk/thumbs/${id}.${ext}`;
    await writeBlobAtomic(dir, relPath, blob);
    return `thumbs/${id}.${ext}`;
  } catch {
    return null;
  }
}
