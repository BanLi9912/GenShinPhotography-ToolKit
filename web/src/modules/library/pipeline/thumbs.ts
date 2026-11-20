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
  // 在飞计数：清理靠它避开「文件已写、thumb 字段还没更新」的空窗（见 sweepOrphanThumbs）
  inflightWrites += 1;
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
  } finally {
    inflightWrites -= 1;
  }
}
/* ---- 孤儿缩略图回收（2026-11-18 任务卡 §4 A） ---- */

/** 工具自己生成的缩略图文件名（8 位十六进制 id + .webp/.png）；别的命名一律不动 */
export const THUMB_FILE_NAME_RE = /^[0-9a-f]{8}\.(?:webp|png)$/i;

/**
 * 在飞缩略图写次数：文件已落盘、`thumb` 字段还没更新（updateItem 未调用）的那段空窗
 * 里，这个文件在索引里是「无引用」的。清理必须等它归零，否则会误删刚写好的缩略图。
 */
let inflightWrites = 0;

export function thumbWritesInflight(): number {
  return inflightWrites;
}

export interface ThumbGcReport {
  /** done = 正常跑完；missing-dir = 没有 thumbs 目录（不创建）；stale = 库代次变了；
   *  busy = 索引又变脏/有在飞写入，主动停手（候选留给下次完整扫描） */
  status: "done" | "missing-dir" | "stale" | "busy";
  /** 符合工具命名格式的文件数（= 参与判定的候选） */
  candidates: number;
  /** 真正删掉的文件数 */
  deleted: number;
  /** 仍被索引引用的文件数（保留） */
  kept: number;
  /** 判定为孤儿但太新、本次放过（下次再收） */
  skippedFresh: number;
  /** 删除时已不存在（视为已收敛） */
  gone: number;
  /** 删除失败（权限/占用等；保留待下次） */
  failures: { name: string; reason: string }[];
}

export interface ThumbGcOptions {
  /** 被有效 thumb 引用的文件名（小写）；来自**已成功保存**的索引 */
  refs: ReadonlySet<string>;
  /** 库代次/身份变了 → true：立刻停手，后面候选一律不再判也不再删 */
  isStale: () => boolean;
  /** 索引又变脏或有在飞缩略图写 → true：本批不删（交给下次） */
  isBusy?: () => boolean;
  /** 刚生成的文件至少放这么久再判孤儿（默认 10s；防「文件已写、thumb 未更新」空窗） */
  minAgeMs?: number;
  /** 每批处理条数（每批让出一次主线程） */
  batchSize?: number;
  now?: () => number;
}

const THUMB_GC_MIN_AGE_MS = 10_000;
const THUMB_GC_BATCH = 50;

/**
 * 回收 `.ystk/thumbs/` 里没有索引引用的正式缩略图（历史残留 + 本次移走的图）。
 *
 * 只做三件事，其余一概不碰：① 只枚举 thumbs **第一层**；② 只认工具命名格式
 * （8 位 hex + .webp/.png，覆盖同 id 遗留的另一个扩展名）；③ 只删**无引用**的普通文件。
 * 子目录、原图、向量、备份、其他命名的文件都不在射程内；thumbs 不存在直接结束，
 * 绝不为清理而建目录。单个删除失败只记一条并继续（保留待下次），文件已消失视为已收敛。
 */
export async function sweepOrphanThumbs(
  dir: FileSystemDirectoryHandle,
  opts: ThumbGcOptions,
): Promise<ThumbGcReport> {
  const report: ThumbGcReport = {
    status: "done",
    candidates: 0,
    deleted: 0,
    kept: 0,
    skippedFresh: 0,
    gone: 0,
    failures: [],
  };
  let thumbs: FileSystemDirectoryHandle;
  try {
    const ystk = await dir.getDirectoryHandle(".ystk");
    thumbs = await ystk.getDirectoryHandle("thumbs");
  } catch {
    report.status = "missing-dir"; // 没有就是没有：不创建、不报错
    return report;
  }

  // 先收集名字再删（不在遍历过程中改目录内容，行为与浏览器实现无关）
  const names: string[] = [];
  for await (const entry of thumbs.values()) {
    if (entry.kind === "file") names.push(entry.name);
  }

  const now = (opts.now ?? Date.now)();
  const minAge = opts.minAgeMs ?? THUMB_GC_MIN_AGE_MS;
  const batchSize = opts.batchSize ?? THUMB_GC_BATCH;
  let handled = 0;

  for (const name of names) {
    if (opts.isStale()) {
      report.status = "stale";
      return report;
    }
    if (!THUMB_FILE_NAME_RE.test(name)) continue; // 别的命名不是本工具的产物
    report.candidates += 1;
    if (opts.refs.has(name.toLowerCase())) {
      report.kept += 1;
      continue;
    }
    if (opts.isBusy?.()) {
      report.status = "busy";
      return report;
    }
    let lastModified = 0;
    try {
      const file = await (await thumbs.getFileHandle(name)).getFile();
      lastModified = file.lastModified;
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        report.gone += 1; // 已经没了 = 已收敛
        continue;
      }
      report.failures.push({ name, reason: String(err) });
      continue;
    }
    if (now - lastModified < minAge) {
      report.skippedFresh += 1; // 刚写出来的先放过（可能在等 updateItem）
      continue;
    }
    try {
      await thumbs.removeEntry(name);
      report.deleted += 1;
    } catch (err) {
      if (err instanceof DOMException && err.name === "NotFoundError") {
        report.gone += 1;
      } else {
        report.failures.push({ name, reason: String(err) });
      }
    }
    handled += 1;
    if (handled % batchSize === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (opts.isStale()) {
        report.status = "stale";
        return report;
      }
    }
  }

  const tail =
    report.failures.length > 0
      ? ` · 失败 ${report.failures.length}（${report.failures[0].name}：${report.failures[0].reason}）`
      : "";
  console.log(
    `[library] 缩略图回收：候选 ${report.candidates} · 已删 ${report.deleted} · 保留 ${report.kept} · 刚生成放过 ${report.skippedFresh} · 已消失 ${report.gone}${tail}`,
  );
  return report;
}
