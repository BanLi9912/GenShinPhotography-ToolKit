/**
 * 分享包导出（FSA）：按 planExport 逐张读原图写进 ZIP，最后写 index.json / meta.json。
 *
 * 写入走另存为对话框拿到的文件句柄：Chromium 的可写流先写临时交换文件、close 才提交，
 * 中途失败调用 abort() 就不会留下半个 ZIP；对话框本身建出的空文件在失败后尽力删掉。
 * 索引里有、磁盘上找不到的原图不写进包（索引同步剔除），完成后报告数量。
 */

import { readFileBlob } from "../../../core/storage/fsa";
import { randomLibraryId } from "../index/binding";
import type { LibraryIndexItem, LibrarySettings } from "../index/indexFile";
import { buildShareMeta, planExport } from "./sharePackage";
import { ZipWriter } from "./zip";

export interface ExportSharePackageOptions {
  /** 当前图库根目录 */
  dir: FileSystemDirectoryHandle;
  /** 已落盘且与内存一致的完整条目快照 */
  items: readonly LibraryIndexItem[];
  /** null = 整个图库 */
  folderScope: string | null;
  libraryName: string;
  settings?: Partial<LibrarySettings>;
  target: FileSystemFileHandle;
  onProgress?: (done: number, total: number) => void;
  /** 期间切库 → true，立即中止（不提交文件） */
  isStale?: () => boolean;
}

export interface ExportSharePackageResult {
  rootName: string;
  count: number;
  /** 索引里有、磁盘上找不到的原图 */
  missing: number;
  /** 路径无法安全写进 ZIP 而跳过 */
  skipped: number;
  bytes: number;
}

const encoder = new TextEncoder();

/** 导出计划的根目录名（另存为对话框的建议文件名要在选文件之前就算出来） */
export function exportRootName(
  items: readonly LibraryIndexItem[],
  folderScope: string | null,
  libraryName: string,
): { rootName: string; count: number } {
  const plan = planExport(items, folderScope, libraryName);
  return { rootName: plan.rootName, count: plan.entries.length };
}

/** 另存为对话框已建出的空文件：导出没写成时尽力删掉 */
export async function discardEmptyFile(target: FileSystemFileHandle): Promise<void> {
  try {
    const file = await target.getFile();
    if (file.size === 0 && typeof target.remove === "function") await target.remove();
  } catch {
    /* 清理失败不影响错误上报 */
  }
}

export async function exportSharePackage(
  opts: ExportSharePackageOptions,
): Promise<ExportSharePackageResult> {
  const plan = planExport(opts.items, opts.folderScope, opts.libraryName);
  if (plan.entries.length === 0) throw new Error("这个范围里没有已登记的图片");

  const writable = await opts.target.createWritable({ keepExistingData: false });
  try {
    const zip = new ZipWriter({ write: (chunk) => writable.write(chunk) });
    const root = plan.rootName;
    const exported: LibraryIndexItem[] = [];
    let missing = 0;
    let done = 0;
    const total = plan.entries.length;
    opts.onProgress?.(0, total);
    for (const entry of plan.entries) {
      if (opts.isStale?.()) throw new Error("图库已切换，导出已取消");
      const file = await readFileBlob(opts.dir, entry.sourceRelPath);
      if (!file) {
        missing += 1;
      } else {
        const bytes = new Uint8Array(await file.arrayBuffer());
        await zip.addFile(`${root}/${entry.item.relPath}`, bytes, file.lastModified);
        // 索引记实际文件的时间与大小：与收件方解压出的原图对得上
        exported.push({ ...entry.item, mtime: file.lastModified, size: file.size });
      }
      done += 1;
      opts.onProgress?.(done, total);
    }
    if (exported.length === 0) throw new Error("范围内的原图在磁盘上都找不到，未生成分享包");

    const now = Date.now();
    const meta = buildShareMeta(randomLibraryId(), exported.length, opts.settings, now);
    await zip.addFile(`${root}/.ystk/index.json`, encoder.encode(JSON.stringify(exported, null, 2)), now);
    await zip.addFile(`${root}/.ystk/meta.json`, encoder.encode(JSON.stringify(meta, null, 2)), now);
    await zip.finish();
    await writable.close();
    return {
      rootName: root,
      count: exported.length,
      missing,
      skipped: plan.skipped,
      bytes: zip.bytesWritten,
    };
  } catch (err) {
    await writable.abort().catch(() => undefined);
    await discardEmptyFile(opts.target);
    throw err;
  }
}
