/**
 * 任务 M3.1 · File System Access API 封装（M3 规划 D3）。
 * 只封装浏览器能力：目录选择 / 权限续期 / JSON 读写 / 原子写 / 目录遍历。
 * 绑定、扫描、索引读写等业务逻辑在 modules/library/index/ 各文件，不在本文件。
 */

/*
 * TS lib.dom 缺少数个 FSA 声明（环境实测），在此集中补齐：
 * showDirectoryPicker / queryPermission / requestPermission / move / values。
 * 只补缺失项；lib 已有的 createWritable、getFileHandle 等不再重复声明。
 */
declare global {
  interface Window {
    showDirectoryPicker(options?: {
      mode?: "read" | "readwrite";
    }): Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemHandle {
    queryPermission?(desc: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
    requestPermission?(desc: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
    /** Chrome 104+；缺失时走 writeFileAtomic 的降级覆盖写分支 */
    move?(name: string): Promise<void>;
  }
  interface FileSystemDirectoryHandle {
    values(): AsyncIterableIterator<FileSystemDirectoryHandle | FileSystemFileHandle>;
  }
}

/** FSA 能力检测：无 showDirectoryPicker 的浏览器无法绑定本地文件夹 */
export function isFsaSupported(): boolean {
  return typeof window.showDirectoryPicker === "function";
}

/** 打开系统目录选择器（必须由用户手势触发）；用户取消返回 null，其余异常上抛 */
export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await window.showDirectoryPicker({ mode: "readwrite" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/**
 * 权限续期：先 query，未 granted 且 request 为真时再 request。
 * queryPermission 未实现（Firefox 等）时按 granted 处理——本应用仅支持
 * Chromium 系，此处防御性兼容。
 */
export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  request: boolean,
): Promise<PermissionState> {
  if (typeof handle.queryPermission !== "function") return "granted";
  const state = await handle.queryPermission({ mode: "readwrite" });
  if (state === "granted" || !request) return state;
  if (typeof handle.requestPermission !== "function") return state;
  return handle.requestPermission({ mode: "readwrite" });
}

/** 读 JSON 的三种结局：missing = 文件不存在；ok = 读到并解析成功；error = 其余一切失败 */
export type JsonReadResult<T> =
  | { status: "missing" }
  | { status: "ok"; value: T }
  | { status: "error"; error: unknown };

/**
 * 严格读 JSON（F1 专用）：区分三种结局——missing（文件不存在，合法的新图库）/ ok /
 * error（权限、IO、JSON 损坏等一切其他失败）。读取失败绝不可与"不存在"混同，
 * 否则调用方会把"读不到"当"没有"从而用空数据覆盖磁盘（2026-09-17 识图丢失根因）。
 * 下钻与解析逻辑同 readJsonFile（各自独立实现，避免改动既有调用点的行为）。
 */
export async function readJsonFileEx<T>(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<JsonReadResult<T>> {
  const parts = relPath.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) return { status: "error", error: new Error(`非法路径：${relPath}`) };
  try {
    let current = dir;
    for (const part of parts) current = await current.getDirectoryHandle(part);
    const file = await current.getFileHandle(name);
    return { status: "ok", value: JSON.parse(await (await file.getFile()).text()) as T };
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return { status: "missing" };
    }
    return { status: "error", error: err };
  }
}

/**
 * 读 JSON 文件：按 `/` 逐段下钻目录，末段取文件并 JSON.parse。
 * 文件不存在或 JSON 写坏/半截时返回 null（按未初始化处理）。
 * 注意：本函数的"失败 = null"语义只适合可容忍缺失的调用点（meta/设置等）；
 * 索引文件的读失败必须与"不存在"区分，用 readJsonFileEx。
 */
export async function readJsonFile<T>(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<T | null> {
  const result = await readJsonFileEx<T>(dir, relPath);
  return result.status === "ok" ? result.value : null;
}

/** 读文件为 File（缩略图/详情大图用）：路径不存在返回 null，其余异常上抛由调用方兜底 */
export async function readFileBlob(
  dir: FileSystemDirectoryHandle,
  relPath: string,
): Promise<File | null> {
  const parts = relPath.split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  if (!name) return null;
  try {
    let current = dir;
    for (const part of parts) current = await current.getDirectoryHandle(part);
    const file = await current.getFileHandle(name);
    return await file.getFile();
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}

/** 原子提交（规划 D2/D3 钉死）：写 `<name>.tmp` → move 覆盖；move 缺失/失败降级覆盖写 */
async function commitAtomic(
  parent: FileSystemDirectoryHandle,
  name: string,
  write: (writable: FileSystemWritableFileStream) => Promise<void>,
): Promise<void> {
  const tmp = await parent.getFileHandle(`${name}.tmp`, { create: true });

  /** 清除 tmp 残留（M3.2.1 R8）：tmp 从不是合法产物——move 成功是唯一会
   * 带走 tmp 的分支，降级覆盖写/写失败时无人删除；已不存在或被占用则忽略 */
  async function removeTmpQuietly(): Promise<void> {
    try {
      await parent.removeEntry(tmp.name);
    } catch {
      /* 已不存在或被占用，忽略 */
    }
  }

  try {
    const tmpWritable = await tmp.createWritable();
    await write(tmpWritable);
    await tmpWritable.close();
  } catch (err) {
    // 写入失败：先清 tmp 再原样上抛（createWritable 未关闭的场景靠浏览器 GC）
    await removeTmpQuietly();
    throw err;
  }

  /** 降级覆盖写（规划钉死分支）：直接写目标文件 */
  async function overwriteTarget(): Promise<void> {
    const target = await parent.getFileHandle(name, { create: true });
    const targetWritable = await target.createWritable();
    await write(targetWritable);
    await targetWritable.close();
  }

  if (typeof tmp.move === "function") {
    try {
      await tmp.move(name);
    } catch {
      // 部分引擎拒绝覆盖已存在的目标（move 仅保证重命名原子性），
      // 此时降级为直接覆盖写；不影响数据正确性，只少一次原子替换
      try {
        await overwriteTarget();
      } finally {
        await removeTmpQuietly();
      }
    }
  } else {
    try {
      await overwriteTarget();
    } finally {
      await removeTmpQuietly();
    }
  }
}

/**
 * 原子写文本（M3.1）：tmp + move，move 缺失（Chrome <104）时降级为直接覆盖写。
 */
export async function writeFileAtomic(
  dir: FileSystemDirectoryHandle,
  relPath: string,
  text: string,
): Promise<void> {
  const parts = relPath.split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  if (!name) return;
  let parent = dir;
  for (const part of parts) {
    parent = await parent.getDirectoryHandle(part, { create: true });
  }
  await commitAtomic(parent, name, (writable) => writable.write(text));
}

/** 原子写 Blob（M3.2 缩略图用）：策略同 writeFileAtomic（tmp + move，缺失/失败降级覆盖写） */
export async function writeBlobAtomic(
  dir: FileSystemDirectoryHandle,
  relPath: string,
  blob: Blob,
): Promise<void> {
  const parts = relPath.split("/").filter(Boolean);
  const name = parts.pop() ?? "";
  if (!name) return;
  let parent = dir;
  for (const part of parts) {
    parent = await parent.getDirectoryHandle(part, { create: true });
  }
  await commitAtomic(parent, name, (writable) => writable.write(blob));
}

/**
 * 递归遍历目录，跳过 `.ystk` 目录；产出相对路径（统一正斜杠）+ mtime + size。
 * 不读文件内容、不过滤扩展名（过滤在 scan.ts，职责分离）。
 */
export async function* walkDirectory(
  root: FileSystemDirectoryHandle,
): AsyncGenerator<{ relPath: string; mtime: number; size: number }> {
  async function* walk(
    dir: FileSystemDirectoryHandle,
    prefix: string,
  ): AsyncGenerator<{ relPath: string; mtime: number; size: number }> {
    for await (const handle of dir.values()) {
      const relPath = prefix ? `${prefix}/${handle.name}` : handle.name;
      if (handle.kind === "directory") {
        if (handle.name === ".ystk") continue;
        yield* walk(handle as FileSystemDirectoryHandle, relPath);
      } else {
        const file = await (handle as FileSystemFileHandle).getFile();
        yield { relPath, mtime: file.lastModified, size: file.size };
      }
    }
  }
  yield* walk(root, "");
}
