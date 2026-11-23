/**
 * 图库索引备份装配（app 层，2026-09-24 任务卡「图库索引备份」）：
 * 定时（默认 10 分钟，可设 5/10/30/60 档）与手动对注册表中**权限 granted**
 * 的图库逐个检查 `.ystk` 核心索引文件（meta.json / index.json / vectors.bin，
 * 不含 thumbs——可从原图重建，用户 2026-09-24 口径）的 mtime/size 变更，
 * 有变更即读文件内容 base64 后交 dev server 中间件写入仓库根
 * devdata/backup/<libraryId>/latest/（覆盖式只留一代，用户口径）。
 * - 变更检测：浏览器 FSA 取三个文件的 lastModified/size → POST check →
 *   Node 与 manifest.json 比对；比对保守（size 或 mtime 任一变即算变更，
 *   宁可多拷一代也不漏备份）
 * - 串行锁防重叠（定时与手动共用）；单库失败不中断其他库（console.warn
 *   上报，开发者日志开着时自动入库）
 * - dev server 不可达：静默失败，状态行提示；主程序不受影响
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { readFileBlob } from "../core/storage/fsa";
import {
  ensureEntryPermission,
  getEntry,
  listSummaries,
} from "../modules/library/api";

/** 参与备份的 .ystk 根级文件（相对 .ystk/；与中间件白名单一致） */
const BACKUP_FILES = ["meta.json", "index.json", "vectors.bin"] as const;

interface BackupSettingsState {
  enabled: boolean;
  /** 间隔档（分钟）：5 / 10 / 30 / 60 */
  intervalMin: number;
  /** 上次成功跑完一轮的时间（epoch ms，null = 尚未跑过） */
  lastAt: number | null;
  /** 上次结果摘要（状态行展示） */
  lastResult: string | null;
}

/** 初始态显式标注：否则字面量类型会被推成窄类型，与 setState 冲突 */
const INITIAL: BackupSettingsState = {
  enabled: false,
  intervalMin: 10,
  lastAt: null,
  lastResult: null,
};

export const useBackupStore = create<BackupSettingsState>()(
  persist(() => ({ ...INITIAL }), { name: "ystk-backup" }),
);

/* ---- FSA 元数据（不读内容：File.size/lastModified 是元数据） ---- */

async function statYstkFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<{ path: string; mtime: number; size: number } | null> {
  try {
    const ystk = await dir.getDirectoryHandle(".ystk");
    const file = await (await ystk.getFileHandle(name)).getFile();
    return { path: name, mtime: file.lastModified, size: file.size };
  } catch {
    return null; // 文件不存在（如未开向量的库没有 vectors.bin）
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 单库备份结果：dir 仅在有变更时带回（= 中间件实际落盘目录名，库本名或回退 libId） */
interface BackupOutcome {
  status: "updated" | "unchanged" | "skipped" | "failed";
  dir?: string;
}

/** 单库备份：检查 → 有变更则提交 */
async function backupOneLibrary(libraryId: string): Promise<BackupOutcome> {
  const entry = getEntry(libraryId);
  if (!entry) return { status: "skipped" };
  if (!(await ensureEntryPermission(entry, false))) return { status: "skipped" };

  const files: Array<{ path: string; mtime: number; size: number }> = [];
  for (const name of BACKUP_FILES) {
    const stat = await statYstkFile(entry.handle, name);
    if (stat) files.push(stat);
  }
  if (files.length === 0) return { status: "skipped" }; // 连 meta.json 都没有：异常库，跳过

  // ① check：把清单交给中间件与 manifest 比对（带库名——备份目录名用库本名）
  const checkRes = await fetch("/api/backup/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ libraryId, name: entry.name, files }),
  });
  if (!checkRes.ok) throw new Error(`POST /api/backup/check → ${checkRes.status}`);
  const check = (await checkRes.json()) as { ok?: boolean; changed?: boolean; dir?: string };
  if (!check.ok || !check.changed) return { status: "unchanged" };
  // 记住本库实际落盘的目录名（供状态行展示）
  if (typeof check.dir === "string") dirs.set(libraryId, check.dir);

  // ② commit：读内容 base64 提交（只传有清单的文件）
  const payloads: Array<{ path: string; base64: string }> = [];
  for (const f of files) {
    const blob = await readFileBlob(entry.handle, `.ystk/${f.path}`);
    if (!blob) throw new Error(`读取 ${f.path} 失败（检查时存在）`);
    payloads.push({ path: f.path, base64: await blobToBase64(blob) });
  }
  const commitRes = await fetch("/api/backup/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      libraryId,
      name: entry.name,
      files: payloads,
      manifest: files,
    }),
  });
  if (!commitRes.ok) throw new Error(`POST /api/backup/commit → ${commitRes.status}`);
  const commit = (await commitRes.json()) as { ok?: boolean };
  if (!commit.ok) throw new Error("commit 返回失败");
  return { status: "updated", dir: dirs.get(libraryId) ?? entry.name };
}

/* ---- 调度（setTimeout 链：间隔档可动态改） ---- */

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** 本库实际落盘目录名（devdata/backup/<dir>；取库本名，清洗不可用时回退 libraryId） */
const dirs = new Map<string, string>();

export function runBackup(manual: boolean): Promise<void> {
  if (running) {
    if (manual) void import("../ui/toast").then(({ toast }) => toast("备份进行中"));
    return Promise.resolve();
  }
  running = true;
  return (async () => {
    let updated = 0;
    let unchanged = 0;
    let skipped = 0;
    let failed = 0;
    const updatedDirs: string[] = [];
    // 逐库串行：避免大文件并发占内存
    for (const summary of listSummaries()) {
      try {
        const r = await backupOneLibrary(summary.libraryId);
        if (r.status === "updated") {
          updated += 1;
          if (r.dir) updatedDirs.push(r.dir);
        } else if (r.status === "unchanged") unchanged += 1;
        else if (r.status === "skipped") skipped += 1;
        else failed += 1;
      } catch (err) {
        failed += 1;
        console.warn("[backup] 图库备份失败", summary.name, err);
      }
    }
    const parts = [`更新 ${updated} · 无变化 ${unchanged}`];
    if (skipped > 0) parts.push(`跳过 ${skipped}（未授权/无索引）`);
    if (failed > 0) parts.push(`失败 ${failed}`);
    // 有实际落盘时把库名目录列出来，方便直接去 devdata/backup/ 找
    if (updatedDirs.length > 0) parts.push(`写入 ${updatedDirs.join("、")}`);
    useBackupStore.setState({ lastAt: Date.now(), lastResult: parts.join(" · ") });
    if (manual) {
      const { toast } = await import("../ui/toast");
      toast(failed > 0 ? `备份完成（有失败项）：${parts.join(" · ")}` : `备份完成：${parts.join(" · ")}`);
    }
    running = false;
  })().catch(() => {
    running = false;
  });
}

function scheduleNext(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const { enabled, intervalMin } = useBackupStore.getState();
  if (!enabled) return;
  timer = setTimeout(() => {
    timer = null;
    void runBackup(false).then(scheduleNext);
  }, intervalMin * 60_000);
}

/** 设置行开关打开沿 / 间隔档切换共用：重排下一次调度 */
export function restartBackupTimer(): void {
  scheduleNext();
}

/** main.tsx 渲染前调用：开关已开则恢复调度 */
export function initBackup(): void {
  if (useBackupStore.getState().enabled) scheduleNext();
}

/** 设置行开关关闭沿 */
export function stopBackup(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
