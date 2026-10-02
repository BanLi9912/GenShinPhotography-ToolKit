/**
 * 任务 M3.7 · 详情页旋转写盘的纯管线（内存旋转 + 落盘工具）。
 *
 * 语义（2026-09-12 用户口径定稿）：顺时针 90°，**直接改写磁盘原图**（Win 图片查看器语义，
 * 无撤销、无副本）。但写盘时机后移——详情页里只做内存旋转（`spinBitmap`，可连点累计），
 * 退出详情页时才由 store.flushPendingRotations 一次性落盘，避免每点一下都重编码一次大图。
 *
 * 编码取舍（A 卡内钉死）：JPG q0.92 / WebP q0.95 重编码（有损，肉眼不可辨，与 Win 查看器
 * 同级）、PNG 无损；EXIF 方向随位图烘焙进像素、不保留；GIF 一律拒绝。
 * 本文件只做像素与磁盘，不碰索引（记账在 store）、不碰识图字段。
 */
import { readFileBlob, writeBlobAtomic } from "../../core/storage/fsa";

/** GIF 拒绝文案（详情页 toast 与管线守卫共用同一份口径） */
export const ROTATE_GIF_REJECT = "动图不支持旋转";

/**
 * 是否动图（拒绝名单）：MIME 优先，扩展名兜底（个别环境 File.type 为空）。
 * 用途有二：详情页点击前拦截（要精确 toast 文案）、管线内兜底守卫。
 */
export function isGifFile(file: File, relPath: string): boolean {
  if (file.type === "image/gif") return true;
  return relPath.toLowerCase().endsWith(".gif");
}

/** 扩展名判定版（详情页只有 relPath，读文件前就要拦住 GIF——省一次读盘 + 精确文案） */
export function isGifPath(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".gif");
}

/** 输出编码档位：MIME 按原文件类型三档（见文件头取舍） */
function outputEncodingFor(
  type: string,
): { mime: string; quality: number | undefined } {
  if (type === "image/jpeg") return { mime: "image/jpeg", quality: 0.92 };
  if (type === "image/webp") return { mime: "image/webp", quality: 0.95 };
  // png 无损（quality 默认）；其余类型（含 File.type 为空的兜底）同样落 PNG 无损
  return { mime: "image/png", quality: undefined };
}

/** canvas → Blob（封装口径同 pipeline/thumbs 的 canvasToBlob） */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number | undefined,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * 顺时针旋转 90°（单次）：画布按旋转后尺寸建（宽 = 原高、高 = 原宽），
 * 平移到远角 + 顺时针 90° 后绘制。几何已用 4×2 已知朝向图实测（红→顶行、
 * 蓝→底行、左上角标记→右上角）。
 *
 * 调用方拥有返回位图，用完自行 `close()`。
 */
export async function spinBitmap(bitmap: ImageBitmap): Promise<ImageBitmap> {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.height;
  canvas.height = bitmap.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.translate(bitmap.height, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(bitmap, 0, 0);
  return createImageBitmap(canvas);
}

/**
 * 顺时针旋转 90° × count（详情页连点累计，落盘时一次转到位）。
 * count 取模 4；count % 4 === 0 时返回原图（调用方自行判定是否还需写盘）。
 * 中途产物逐个 close，只留最新一张位图（大图不驻留多张）。
 */
export async function spinBitmapBy(
  bitmap: ImageBitmap,
  count: number,
): Promise<ImageBitmap> {
  let current = bitmap;
  let owned = false; // current 是否为本次内部产物（需要负责 close）
  for (let i = 0; i < ((count % 4) + 4) % 4; i++) {
    const next = await spinBitmap(current);
    if (owned) current.close();
    current = next;
    owned = true;
  }
  return current;
}

/**
 * 读磁盘原图 → 顺时针旋转 count 次 → 原子写回 → 重读新文件。
 *
 * 返回 `{ file, bitmap }`：`file` = 重读回来的新磁盘文件（拿真实 lastModified/size 记账）、
 * `bitmap` = 旋转后位图（调用方复用给缩略图，不必二次解码原图；所有权交给调用方）。
 *
 * count % 4 === 0 时**不写盘**，原样返回磁盘文件与解码位图（旋转量归零即无改动）。
 * 读不到文件返 null（条目已被移走）；GIF 抛「动图不支持旋转」（调用方转 toast）；
 * 其余异常（解码/写盘失败）上抛由调用方兜底。
 */
export async function writeRotatedFile(
  dir: FileSystemDirectoryHandle,
  relPath: string,
  count: number,
): Promise<{ file: File; bitmap: ImageBitmap } | null> {
  const file = await readFileBlob(dir, relPath);
  if (!file) return null;
  if (isGifFile(file, relPath)) throw new Error(ROTATE_GIF_REJECT);

  const decoded = await createImageBitmap(file);
  const turns = ((count % 4) + 4) % 4;
  if (turns === 0) return { file, bitmap: decoded };

  const rotated = await spinBitmapBy(decoded, turns);
  decoded.close();

  const { mime, quality } = outputEncodingFor(file.type);
  const canvas = document.createElement("canvas");
  canvas.width = rotated.width;
  canvas.height = rotated.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    rotated.close();
    throw new Error("2d context unavailable");
  }
  ctx.drawImage(rotated, 0, 0);
  const blob = await canvasToBlob(canvas, mime, quality);
  if (!blob) {
    rotated.close();
    throw new Error("旋转编码失败");
  }

  await writeBlobAtomic(dir, relPath, blob);
  // 重读新文件：索引里的 mtime/size 必须与磁盘真实值一致（扫描比对与识图
  // pending 判定都读这两个字段）
  const written = await readFileBlob(dir, relPath);
  if (!written) {
    rotated.close();
    return null;
  }
  return { file: written, bitmap: rotated };
}
