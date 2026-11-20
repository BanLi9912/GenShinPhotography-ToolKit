/**
 * 任务 M3.1 · 图库绑定/恢复/权限续期/重绑定对位。
 * 句柄注册表存 IndexedDB `libraries` 表（可结构化克隆）；.ystk 磁盘文件
 * 由 indexFile.ts 读写。本文件只做注册表与绑定流程，不 import store
 * （store.ts 编排流程，避免循环依赖）。
 */

import {
  ensurePermission,
  pickDirectory,
  readJsonFile,
  writeFileAtomic,
} from "../../../core/storage/fsa";
import { getDB, LIBRARIES_STORE } from "../../../core/storage/idb";
import { createDefaultMeta, type LibraryMeta } from "./indexFile";

/** 注册表记录（idb 直存；句柄可结构化克隆） */
export interface LibraryRegistryEntry {
  libraryId: string;
  name: string;
  /** FSA 不暴露完整路径，取目录名作提示 */
  pathHint: string;
  handle: FileSystemDirectoryHandle;
  createdAt: number;
  lastOpenedAt: number;
}

/** UI 摘要（无 handle）；itemCount 来自各库 meta.json 的 stats.files，读不到为 null */
export interface LibrarySummary {
  libraryId: string;
  name: string;
  pathHint: string;
  createdAt: number;
  lastOpenedAt: number;
  /** 图片数（meta.json stats.files）；未授权/目录失联读不到 meta 时为 null */
  itemCount: number | null;
}

/** 内存注册表（句柄只在内存 + idb，不进 zustand，避免无谓重渲染） */
const registry = new Map<string, LibraryRegistryEntry>();

/** 新图库 id（`lib_` + 8 位十六进制）；拆分生成的子库沿用同一格式 */
export function randomLibraryId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `lib_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** 从 idb 载入注册表（init 时调用一次；重复调用幂等覆盖） */
export async function loadRegistry(): Promise<void> {
  const db = await getDB();
  const rows = await db.getAll(LIBRARIES_STORE);
  registry.clear();
  for (const row of rows as LibraryRegistryEntry[]) {
    if (row && typeof row.libraryId === "string") {
      registry.set(row.libraryId, row);
    }
  }
}

async function persistRegistry(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(LIBRARIES_STORE, "readwrite");
  await tx.store.clear();
  for (const entry of registry.values()) {
    await tx.store.put(entry, entry.libraryId);
  }
  await tx.done;
}

export function listSummaries(): LibrarySummary[] {
  return [...registry.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((entry) => ({
      libraryId: entry.libraryId,
      name: entry.name,
      pathHint: entry.pathHint,
      createdAt: entry.createdAt,
      lastOpenedAt: entry.lastOpenedAt,
      itemCount: null,
    }));
}

/** 补齐各库图片数（读 meta.json 的 stats.files，不打开图库/不扫盘） */
export async function refreshSummaries(): Promise<LibrarySummary[]> {
  const summaries = listSummaries();
  await Promise.all(
    summaries.map(async (summary) => {
      const entry = registry.get(summary.libraryId);
      if (!entry) return;
      const meta = await readJsonFile<LibraryMeta>(
        entry.handle,
        ".ystk/meta.json",
      );
      if (meta && typeof meta.stats?.files === "number") {
        summary.itemCount = meta.stats.files;
      }
    }),
  );
  return summaries;
}

export function getEntry(libraryId: string): LibraryRegistryEntry | undefined {
  return registry.get(libraryId);
}

/** 更新最近打开时间（打开成功后调用） */
export async function touchLastOpened(libraryId: string): Promise<void> {
  const entry = registry.get(libraryId);
  if (!entry) return;
  entry.lastOpenedAt = Date.now();
  await persistRegistry();
}

/**
 * 绑定新文件夹：
 * - 已有 `.ystk/meta.json` → 按 libraryId 对位；注册表已有同 id → 更新句柄
 *   （重新绑定同库，不重复登记）；没有 → 补登记。
 * - 没有 meta.json → 生成新 libraryId，创建 meta.json + 空 index.json 并登记。
 * 用户取消返回 null。
 */
export async function bindNewLibrary(): Promise<LibraryRegistryEntry | null> {
  const handle = await pickDirectory();
  if (!handle) return null;

  const meta = await readJsonFile<LibraryMeta>(handle, ".ystk/meta.json");
  const existingId =
    meta && typeof meta.libraryId === "string" ? meta.libraryId : null;

  if (!existingId) {
    // 拆分半成品（2026-11-18 任务卡 §4 B6）：.ystk 里只有未完成标记、还没有 meta.json。
    // 此时绝不能走下面「无 meta → 生成新 id + 写空索引」——那会把已经写好的 index.json
    // 当成不存在，直接覆盖成 []。识别出来就停手，让用户回原图库继续拆分。
    const marker = await readJsonFile<{ targetPath?: string; count?: number }>(
      handle,
      ".ystk/.split-in-progress.json",
    );
    if (marker) {
      throw new Error(
        `这个目录里有一次未完成的图库拆分（${marker.count ?? 0} 张，目录「${marker.targetPath ?? "?"}」）。` +
          "请回到原图库再点一次「拆分为独立图库…」把它写完，不要在这里绑定（否则会生成空索引覆盖它）。",
      );
    }
  }

  if (existingId) {
    const existing = registry.get(existingId);
    if (existing) {
      const updated: LibraryRegistryEntry = {
        ...existing,
        handle,
        lastOpenedAt: Date.now(),
      };
      registry.set(existingId, updated);
      await persistRegistry();
      return updated;
    }
    const entry: LibraryRegistryEntry = {
      libraryId: existingId,
      name: handle.name,
      pathHint: handle.name,
      handle,
      createdAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    registry.set(existingId, entry);
    await persistRegistry();
    return entry;
  }

  const libraryId = randomLibraryId();
  const metaDoc = createDefaultMeta(libraryId);
  await writeFileAtomic(
    handle,
    ".ystk/meta.json",
    JSON.stringify(metaDoc, null, 2),
  );
  await writeFileAtomic(handle, ".ystk/index.json", "[]");
  const entry: LibraryRegistryEntry = {
    libraryId,
    name: handle.name,
    pathHint: handle.name,
    handle,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
  };
  registry.set(libraryId, entry);
  await persistRegistry();
  return entry;
}

/** 权限续期（授权按钮必须由用户手势触发）；granted 返回 true */
export async function ensureEntryPermission(
  entry: LibraryRegistryEntry,
  request: boolean,
): Promise<boolean> {
  return (await ensurePermission(entry.handle, request)) === "granted";
}

/** 移除注册表记录；不删磁盘 `.ystk`（解绑 ≠ 删除索引） */
export async function unbindLibrary(libraryId: string): Promise<void> {
  registry.delete(libraryId);
  await persistRegistry();
}
