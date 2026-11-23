/**
 * 分享包导入为新图库（FSA）。
 *
 * prepareImport：只读中央目录 + index.json / meta.json，识别结构与对位，不写盘。
 * createImportFolder：在用户选的上级目录里新建空目录（同名加「 (2)」，跨标签页加锁），
 *   并写入带随机凭证的未完成标记；绝不写进已有目录。
 * writeImport：核对凭证 → 并发解压原图与包内缩略图到 `.ystk/import-staging-<凭证>/`（3 路，
 *   大小 + CRC32 核对）→ 再核对凭证 → 逐个移到正式位置（每次移动前核对凭证）→ 删暂存 →
 *   index.json（回读核对）→ meta.json（回读核对）→ 清标记。任一步失败抛错，标记保留；
 *   调用方随后可用 removeImportFolder 删掉这个本次新建的目录（删前核对凭证）。
 */

import {
  readJsonFileEx,
  writeFileAtomic,
} from "../../../core/storage/fsa";
import { randomLibraryId } from "../index/binding";
import type { LibraryIndexItem, LibraryMeta } from "../index/indexFile";
import { findEaglePackRoot, planEagleImport } from "./eaglePackage";
import {
  IMPORT_MARKER_NAME,
  IMPORT_MARKER_REL_PATH,
  analyzeYstkFiles,
  collectPackageFiles,
  findYstkIndexes,
  buildImportedMeta,
  finalizeImportedItem,
  folderNameCandidate,
  planImportIndex,
  thumbBytesMatch,
  type ImportIndexPlan,
  type PackageLayout,
} from "./sharePackage";
import { readZipDirectory, readZipEntry, type ZipEntry } from "./zip";

/** 包内 JSON 上限（与 PicLibBridge 一致） */
const MAX_JSON_BYTES = 128 * 1024 * 1024;

export interface PreparedImport {
  file: File;
  layout: PackageLayout;
  plan: ImportIndexPlan;
  packageMeta: unknown;
}

async function readJsonEntry(file: File, entry: ZipEntry, label: string): Promise<unknown> {
  if (entry.size > MAX_JSON_BYTES) throw new Error(`${label} 过大（上限 128 MB）`);
  const bytes = await readZipEntry(file, entry);
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    throw new Error(`${label} 无法解析`);
  }
}

/**
 * 读包并核对结构（不写盘）；YSTK 分享包与 Eagle 导出包都走这里，产出同一种导入计划。
 * 不是可识别的包 / 损坏时抛出可读错误。
 */
export async function prepareImport(file: File): Promise<PreparedImport> {
  const entries = await readZipDirectory(file);
  const files = collectPackageFiles(entries);
  const eagle = findEaglePackRoot(files);
  if (eagle && findYstkIndexes(files).length === 0) {
    const pack = await readJsonEntry(file, eagle.pack.entry, "Eagle 包的 pack.json");
    const { layout, plan } = planEagleImport(files, eagle.pack, eagle.root, pack, file.name);
    return { file, layout, plan, packageMeta: null };
  }
  const layout = analyzeYstkFiles(files, file.name);
  const rawIndex = await readJsonEntry(file, layout.indexEntry, "分享包的 index.json");
  const plan = planImportIndex(rawIndex, layout.images, layout.thumbs);
  let packageMeta: unknown = null;
  if (layout.metaEntry) {
    try {
      packageMeta = await readJsonEntry(file, layout.metaEntry, "分享包的 meta.json");
    } catch {
      packageMeta = null; // meta 只提供图库设置，坏了用默认值，不拦导入
    }
  }
  return { file, layout, plan, packageMeta };
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}

/**
 * 本次导入的目标目录。token 是写进未完成标记的随机凭证：目录名可能被另一个导入
 * （另一个标签页）拿到同一个，凭证才能证明「这个目录里的东西是我写的」。
 */
export interface ImportFolder {
  dir: FileSystemDirectoryHandle;
  name: string;
  token: string;
  /**
   * 目标目录的独占锁（`.ystk/.import-lock` 上的独占写入流），导入全程持有、结束时释放。
   * 持有期间别的导入——包括 localhost / 127.0.0.1 这类不共享 Web Locks 的不同来源——
   * 都拿不到这把锁，只能换下一个目录名，所以不会有两个导入写进同一个目录。
   * null = 浏览器不支持独占写入（Chrome 121 以前）：此时目录名带 6 位随机后缀，本身就不会撞名。
   */
  lock: FileSystemWritableFileStream | null;
}

/** 独占锁文件名（在导入目录的 .ystk 下；导入结束后删除） */
const IMPORT_LOCK_NAME = ".import-lock";

/** 锁冲突：同一文件上已有别人的独占写入流（MDN：createWritable 抛 NoModificationAllowedError） */
function isLockConflict(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NoModificationAllowedError";
}

/**
 * 浏览器是否真的支持独占写入（Chrome 121+）。在用户选的上级目录里建一个临时探测文件，
 * 以独占模式打开后再开第二个写入流：第二个被锁冲突拒绝 = 支持；也能打开 = 浏览器忽略了
 * exclusive 参数。探测完删掉临时文件。其余错误（权限、磁盘）原样抛出。
 */
async function supportsExclusiveWrite(parent: FileSystemDirectoryHandle): Promise<boolean> {
  const name = `.ystk-lock-probe-${randomToken()}`;
  const handle = await parent.getFileHandle(name, { create: true });
  try {
    const first = await handle.createWritable({ mode: "exclusive" });
    try {
      const second = await handle.createWritable();
      await second.abort().catch(() => undefined);
      return false;
    } catch (err) {
      if (isLockConflict(err)) return true;
      throw err;
    } finally {
      await first.abort().catch(() => undefined);
    }
  } finally {
    await parent.removeEntry(name).catch(() => undefined);
  }
}

/**
 * 在目标目录上占独占锁：只有锁冲突才算「目录被别的导入占着」（taken），其余错误
 * （磁盘写入故障等）原样抛出，不能当成被占用去换名重试。
 */
async function acquireFolderLock(
  dir: FileSystemDirectoryHandle,
): Promise<{ status: "held"; lock: FileSystemWritableFileStream } | { status: "taken" }> {
  const ystk = await dir.getDirectoryHandle(".ystk", { create: true });
  const handle = await ystk.getFileHandle(IMPORT_LOCK_NAME, { create: true });
  try {
    return { status: "held", lock: await handle.createWritable({ mode: "exclusive" }) };
  } catch (err) {
    if (isLockConflict(err)) return { status: "taken" };
    throw err;
  }
}

/** 不支持独占写入时的目录名：6 位随机后缀，两个导入不可能选到同一个名字 */
function suffixedName(baseName: string): string {
  return `${baseName} · ${randomToken().slice(0, 6)}`;
}

/**
 * 锁文件本身，或 Chrome 为它的写入流在旁边建的交换文件（`.import-lock.crswap`，重名时
 * 可能是 `.import-lock.1.crswap`）。本地文件系统上，写入流打开期间交换文件一直存在。
 */
function isLockArtifact(name: string): boolean {
  return name === IMPORT_LOCK_NAME ||
    (name.startsWith(`${IMPORT_LOCK_NAME}.`) && name.endsWith(".crswap"));
}

/** 目录里是否只有 `.ystk/`，且其中只有锁文件及其交换文件（刚建好、刚占锁时应当如此） */
async function holdsOnlyLock(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const entry of dir.values()) {
    if (entry.name !== ".ystk" || entry.kind !== "directory") return false;
  }
  try {
    const ystk = await dir.getDirectoryHandle(".ystk");
    for await (const entry of ystk.values()) {
      if (!isLockArtifact(entry.name)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/**
 * 分配目录时初始化失败的清理。**只有确定是本次写的文件才按名字删**：
 * - owned：本次持有独占锁（别人写不进来），或者这是不支持独占写入时本次新建的随机后缀
 *   目录。不是 owned（例如打开锁时就出了磁盘错误、根本没拿到锁），目录里的标记和锁文件
 *   可能属于正握着锁的另一个导入，一律不按名字删；
 * - markerStarted：本次已开始写未完成标记，才可能有自己的标记及其临时文件。
 * 之后放锁（锁文件只在本次持锁时才删）。
 *
 * **目录本身（外层目录与 .ystk）一律保留**，哪怕可能是空的：浏览器在本地文件系统上没有
 * 「只删目录」的操作——按名字的 removeEntry 和目录句柄的 remove() 都会删掉该路径上的
 * 普通文件（Codex 核对 Chromium 源码确认），检查与删除之间若被同步程序换成同名文件，
 * 删目录就会误删它。异常后留下一个空目录，代价远小于误删。
 */
async function discardFailedInit(
  dir: FileSystemDirectoryHandle,
  lock: FileSystemWritableFileStream | null,
  state: { owned: boolean; markerStarted: boolean },
): Promise<void> {
  if (state.owned && state.markerStarted) {
    try {
      const ystk = await dir.getDirectoryHandle(".ystk");
      for (const own of [IMPORT_MARKER_NAME, `${IMPORT_MARKER_NAME}.tmp`]) {
        await ystk.removeEntry(own).catch(() => undefined);
      }
    } catch {
      /* .ystk 不存在或不是目录：没有本次的标记可删 */
    }
  }
  if (lock) {
    await lock.abort().catch(() => undefined);
    await removeLockFile(dir);
  }
}

async function removeLockFile(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const ystk = await dir.getDirectoryHandle(".ystk");
    await ystk.removeEntry(IMPORT_LOCK_NAME);
  } catch {
    /* 已不存在，忽略 */
  }
}

/** 释放独占锁并删掉锁文件（导入完成或失败清理时调用；可重复调用） */
async function releaseFolderLock(folder: ImportFolder): Promise<void> {
  const lock = folder.lock;
  if (!lock) return;
  folder.lock = null;
  await lock.abort().catch(() => undefined);
  await removeLockFile(folder.dir);
}

interface ImportMarker {
  schemaVersion: 1;
  token: string;
  /** 来源包文件名与图片数（绑定侧拒绝绑定半成品时显示给用户） */
  source: string;
  count: number;
  createdAt: number;
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 同一标签页内的兜底串行（浏览器没有 Web Locks 时用） */
let localLockChain: Promise<unknown> = Promise.resolve();

/**
 * 跨标签页串行：同一来源的所有 YSTK 标签页共用一把锁（Web Locks API），
 * 不支持时退回本标签页内串行。只包住「选目录名 → 建目录 → 写标记」这一小段。
 */
async function withFolderLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks && typeof locks.request === "function") {
    return locks.request("ystk-share-import-folder", fn) as Promise<T>;
  }
  const run = localLockChain.then(fn, fn);
  localLockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function isEmptyDirectory(dir: FileSystemDirectoryHandle): Promise<boolean> {
  for await (const _entry of dir.values()) return false;
  return true;
}

/**
 * 新建导入目录并立刻写入带凭证的未完成标记。名称被目录或文件占用就换「名称 (n)」；
 * 建出来的目录不是空的（被别人抢先建了），也换下一个名字。
 *
 * 两层锁：Web Locks 让同一来源的标签页依次分配（不同来源之间不共享）；目录里的独占写入锁
 * 按文件路径管理，跨来源也生效（作者在 Chrome 中实测 localhost / 127.0.0.1 共享），导入全程
 * 持有。浏览器不支持独占写入时改用带随机后缀的目录名。凭证核对保留为纵深防护。
 */
export async function createImportFolder(
  parent: FileSystemDirectoryHandle,
  baseName: string,
  info: { source: string; count: number },
): Promise<ImportFolder> {
  return withFolderLock(async () => {
    // 支持独占写入：用「名称」「名称 (2)」这样的名字，靠锁保证不会两个导入同用一个目录；
    // 不支持（Chrome 121 以前）：没有锁可依靠，改用带随机后缀的名字，从构造上避免撞名
    const exclusive = await supportsExclusiveWrite(parent);
    /** 拿到锁后发现目录里有意外内容而跳过的次数（见下方刹车） */
    let foreignSkips = 0;
    for (let n = 1; n <= 999; n += 1) {
      // 刹车：「拿到锁却发现意外内容」正常情况下极少发生。连续发生说明判断出了问题，宁可停下
      // 报错，也不能一个接一个地建出大量文件夹。放在异常清理范围之外，报错不会触发删除。
      if (foreignSkips >= 3) {
        throw new Error(
          "导入目录分配异常：连续多次在新建的文件夹里发现意外内容，已停止，没有继续新建文件夹",
        );
      }
      const name = exclusive ? folderNameCandidate(baseName, n) : suffixedName(baseName);
      let taken = true;
      try {
        await parent.getDirectoryHandle(name);
      } catch (err) {
        if (isNotFound(err)) taken = false;
        else if (!(err instanceof DOMException && err.name === "TypeMismatchError")) throw err;
      }
      if (taken) continue;
      const dir = await parent.getDirectoryHandle(name, { create: true });
      if (!(await isEmptyDirectory(dir))) continue;
      let lock: FileSystemWritableFileStream | null = null;
      let markerStarted = false;
      // 从建好空目录到交出目录之间出错，调用方拿不到锁、也不知道这个目录：在这里自己收拾。
      // 只有持锁（或随机后缀目录）时，目录里的东西才确定是本次的，见 discardFailedInit。
      try {
        if (exclusive) {
          const locked = await acquireFolderLock(dir);
          if (locked.status === "taken") continue; // 另一个导入正握着这个目录，不动它
          lock = locked.lock;
          // 拿到锁后再确认目录里只有锁文件：防止本次抢占被拖得太久，另一个导入已经在这里写完
          if (!(await holdsOnlyLock(dir))) {
            await lock.abort().catch(() => undefined);
            lock = null;
            await removeLockFile(dir);
            // 目录保留不删（原因见 discardFailedInit）；刹车保证这种情况最多出现 3 次
            foreignSkips += 1;
            continue;
          }
        }
        const token = randomToken();
        const marker: ImportMarker = {
          schemaVersion: 1,
          token,
          source: info.source,
          count: info.count,
          createdAt: Date.now(),
        };
        // 先落标记：中途断掉时，绑定侧能认出这是没写完的导入，而不是当成新目录初始化空索引
        markerStarted = true;
        await writeFileAtomic(dir, IMPORT_MARKER_REL_PATH, JSON.stringify(marker, null, 2));
        return { dir, name, token, lock };
      } catch (err) {
        await discardFailedInit(dir, lock, {
          owned: lock !== null || !exclusive,
          markerStarted,
        });
        throw err;
      }
    }
    throw new Error(`「${baseName}」的同名目录太多，请换一个位置`);
  });
}

/** 目录里的未完成标记是否仍是本次导入写的 */
async function ownsFolder(folder: ImportFolder): Promise<boolean> {
  try {
    const marker = await readJsonFileEx<ImportMarker>(folder.dir, IMPORT_MARKER_REL_PATH);
    return marker.status === "ok" && marker.value?.token === folder.token;
  } catch {
    return false;
  }
}

/** 核对所有权，不是本次导入的目录就停止（不删、不再写任何文件） */
async function assertOwnsFolder(folder: ImportFolder): Promise<void> {
  if (!(await ownsFolder(folder))) {
    throw new ImportFolderTakenError(folder.name);
  }
}

/** 目标目录被另一个导入占用：调用方不能删除它 */
export class ImportFolderTakenError extends Error {
  constructor(name: string) {
    super(`「${name}」同时被另一个导入使用，本次导入已停止，没有删除其中任何文件`);
    this.name = "ImportFolderTakenError";
  }
}

/**
 * 删除本次导入新建的目录（只在导入失败时调用）。删除前核对未完成标记里的凭证：
 * 凭证对不上说明目录里还有别的导入写的文件，只删本次自己的暂存子目录，其余一律不动。
 */
export async function removeImportFolder(
  parent: FileSystemDirectoryHandle,
  folder: ImportFolder,
): Promise<"removed" | "not-owned" | "failed"> {
  // 先放锁：写入流开着时浏览器可能拒绝删除锁文件所在的目录
  await releaseFolderLock(folder);
  if (!(await ownsFolder(folder))) {
    await removeStaging(folder);
    return "not-owned";
  }
  try {
    await parent.removeEntry(folder.name, { recursive: true });
    return "removed";
  } catch (err) {
    console.warn("[library] 清理未完成的导入目录失败", err);
    return "failed";
  }
}

export interface WriteImportOptions {
  prepared: PreparedImport;
  /** createImportFolder 返回的目录（已写好带凭证的未完成标记） */
  folder: ImportFolder;
  onProgress?: (done: number, total: number) => void;
}

export interface WriteImportResult {
  libraryId: string;
  /** 写进索引的条目 */
  items: LibraryIndexItem[];
  /** 解压的原图总数（含索引外的图片） */
  images: number;
  /** 沿用了包内缩略图的条目数 */
  thumbs: number;
}

/* ---- 写盘提速：并发池 / 目录句柄缓存 / 直接写 ---- */

/** 同时处理的文件数：IO 等待可以重叠；解压与 CRC 在主线程，开到 4 收益小、更易卡顿 */
const IMPORT_CONCURRENCY = 3;
/** 同时驻留内存的文件字节上限（遇到大图自动少并发；单个超限的文件照样单独处理） */
const MAX_INFLIGHT_BYTES = 256 * 1024 * 1024;

/**
 * 有界并发：同时最多 limit 个、合计不超过 maxBytes（至少放行一个）。
 * 任一任务失败就不再开始新任务，**等已开始的任务全部结束**后再抛出第一个错误——调用方随后会删掉
 * 导入目录，不能让还在写的任务在删除之后继续落盘。
 */
export async function runPool<T>(
  items: readonly T[],
  sizeOf: (item: T) => number,
  worker: (item: T) => Promise<void>,
  limit = IMPORT_CONCURRENCY,
  maxBytes = MAX_INFLIGHT_BYTES,
): Promise<void> {
  const running = new Set<Promise<void>>();
  let inflightBytes = 0;
  let failure: { error: unknown } | null = null;
  for (const item of items) {
    const bytes = Math.max(0, sizeOf(item));
    while (
      failure === null &&
      running.size > 0 &&
      (running.size >= limit || inflightBytes + bytes > maxBytes)
    ) {
      await Promise.race(running);
    }
    if (failure !== null) break;
    inflightBytes += bytes;
    const task: Promise<void> = worker(item)
      .catch((error: unknown) => {
        failure ??= { error };
      })
      .finally(() => {
        inflightBytes -= bytes;
        running.delete(task);
      });
    running.add(task);
  }
  await Promise.all(running);
  if (failure !== null) throw (failure as { error: unknown }).error;
}

/**
 * 目录句柄缓存（按相对路径，"" = 根）：每个目录只逐级打开/创建一次。缓存的是**打开中的
 * Promise**，并发写同一新目录的几张图只会发起一次创建。
 */
function directoryCache(
  root: FileSystemDirectoryHandle,
): (path: string) => Promise<FileSystemDirectoryHandle> {
  const cache = new Map<string, Promise<FileSystemDirectoryHandle>>([["", Promise.resolve(root)]]);
  const get = (path: string): Promise<FileSystemDirectoryHandle> => {
    let hit = cache.get(path);
    if (!hit) {
      const slash = path.lastIndexOf("/");
      const parentPath = slash < 0 ? "" : path.slice(0, slash);
      const name = path.slice(slash + 1);
      hit = get(parentPath).then((parent) => parent.getDirectoryHandle(name, { create: true }));
      cache.set(path, hit);
    }
    return hit;
  };
  return get;
}

/**
 * 写新文件并读回（导入目录是本次新建的，不需要临时文件 + 改名）：Chromium 的可写流本身
 * 先写交换文件、close 才替换，单个文件不会出现写了一半的状态；整次导入失败时目录整个删除。
 * 读回直接用这次的文件句柄，不再从根目录逐级查找。
 */
async function writeNewFile(
  dirOf: (path: string) => Promise<FileSystemDirectoryHandle>,
  relPath: string,
  data: Uint8Array<ArrayBuffer>,
): Promise<{ handle: FileSystemFileHandle; file: File }> {
  const slash = relPath.lastIndexOf("/");
  const parent = await dirOf(slash < 0 ? "" : relPath.slice(0, slash));
  const handle = await parent.getFileHandle(relPath.slice(slash + 1), { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (err) {
    await writable.abort().catch(() => undefined);
    throw err;
  }
  return { handle, file: await handle.getFile() };
}

/* ---- 暂存与发布：解压期间不往正式位置写任何原图 ---- */

/**
 * 暂存子目录：`<导入目录>/.ystk/import-staging-<凭证>/`。
 *
 * 为什么要暂存：Web Locks 在不同来源（localhost 与 127.0.0.1）之间不共享，两个导入在极端
 * 情况下可能拿到同一个导入目录。解压耗时最长，如果直接写正式位置，一方就可能覆盖另一方
 * 的同名原图。暂存目录名里带本次的随机凭证，别的导入不会写到这里；又在 `.ystk` 里，扫描
 * 会跳过它，半成品不会进索引。
 *
 * 为什么不整个目录改名：本地文件系统上浏览器只支持移动文件、不支持移动目录，所以发布时
 * 逐个文件移到正式位置，每次移动前都核对凭证。
 */
function stagingName(token: string): string {
  return `import-staging-${token}`;
}

async function openStaging(folder: ImportFolder): Promise<FileSystemDirectoryHandle> {
  const ystk = await folder.dir.getDirectoryHandle(".ystk", { create: true });
  return ystk.getDirectoryHandle(stagingName(folder.token), { create: true });
}

/** 删掉本次导入的暂存子目录（名字带本次凭证，只可能是自己的） */
async function removeStaging(folder: ImportFolder): Promise<void> {
  try {
    const ystk = await folder.dir.getDirectoryHandle(".ystk");
    await ystk.removeEntry(stagingName(folder.token), { recursive: true });
  } catch {
    /* 不存在或已删，忽略 */
  }
}

/**
 * 快速所有权核对（发布阶段每移动一个文件前调用）：缓存 `.ystk` 目录句柄，每次重新取标记
 * 文件——标记被别的导入原子替换后，旧的文件句柄未必指向新内容。
 */
function ownershipCheck(folder: ImportFolder): () => Promise<boolean> {
  let ystk: Promise<FileSystemDirectoryHandle> | null = null;
  return async () => {
    try {
      ystk ??= folder.dir.getDirectoryHandle(".ystk");
      const marker = await (await (await ystk).getFileHandle(IMPORT_MARKER_NAME)).getFile();
      return (JSON.parse(await marker.text()) as Partial<ImportMarker>).token === folder.token;
    } catch {
      return false;
    }
  };
}

/**
 * 把暂存文件移到正式位置并返回落盘后的文件。浏览器不支持跨目录移动（或移动失败）时，
 * 退回「读出来再写一份」；暂存目录最后整个删除。
 */
async function publishFile(
  staged: FileSystemFileHandle,
  destOf: (path: string) => Promise<FileSystemDirectoryHandle>,
  relPath: string,
): Promise<File> {
  const slash = relPath.lastIndexOf("/");
  const parent = await destOf(slash < 0 ? "" : relPath.slice(0, slash));
  const name = relPath.slice(slash + 1);
  if (typeof staged.move === "function") {
    try {
      await staged.move(parent, name);
      return (await parent.getFileHandle(name)).getFile();
    } catch (err) {
      console.warn("[library] 跨目录移动不可用，改为复制", relPath, err);
    }
  }
  const data = new Uint8Array(await (await staged.getFile()).arrayBuffer());
  return (await writeNewFile(destOf, relPath, data)).file;
}

export async function writeImport(opts: WriteImportOptions): Promise<WriteImportResult> {
  const { file, layout, plan, packageMeta } = opts.prepared;
  const { folder } = opts;
  const dir = folder.dir;
  const libraryId = randomLibraryId();
  const total = layout.images.length;

  // 未完成标记已由 createImportFolder 写好；这里先确认目录仍归本次导入所有
  await assertOwnsFolder(folder);

  /* 1. 解压到暂存子目录（耗时最长的一步，不碰正式位置） */
  const stageOf = directoryCache(await openStaging(folder));
  /** 正式相对路径 → 暂存文件；thumbOf 标出哪些是缩略图（缩略图发布失败不拦导入） */
  const staged = new Map<string, { handle: FileSystemFileHandle; size: number; thumbOf?: string }>();
  opts.onProgress?.(0, total);
  let done = 0;
  await runPool(layout.images, (image) => image.entry.size, async (image) => {
    const data = await readZipEntry(file, image.entry);
    const { handle, file: back } = await writeNewFile(stageOf, image.relPath, data);
    if (back.size !== data.length) throw new Error(`写入后核对失败：${image.relPath}`);
    staged.set(image.relPath, { handle, size: data.length });
    done += 1;
    opts.onProgress?.(done, total);
  });

  // 包内缩略图：同样先进暂存。缩略图是可选产物——读不出、文件头与扩展名不符、写失败
  // 都只让这一条改回「打开后重新生成」，不拦整次导入。
  const thumbJobs = plan.items.flatMap((item) => {
    const entry = plan.thumbEntries.get(item.id);
    return entry && item.thumb ? [{ item, thumb: item.thumb, entry }] : [];
  });
  await runPool(thumbJobs, (job) => job.entry.size, async ({ item, thumb, entry }) => {
    try {
      const data = await readZipEntry(file, entry);
      if (!thumbBytesMatch(thumb, data)) {
        console.warn("[library] 包内缩略图格式与扩展名不符，改为重新生成", thumb);
        return;
      }
      const relPath = `.ystk/${thumb}`;
      const { handle } = await writeNewFile(stageOf, relPath, data);
      staged.set(relPath, { handle, size: data.length, thumbOf: item.id });
    } catch (err) {
      console.warn("[library] 包内缩略图导入失败，改为重新生成", thumb, err);
    }
  });

  /* 2. 发布：逐个移到正式位置，每次移动前核对凭证，不归自己就立刻停（不覆盖别人的文件） */
  const owns = ownershipCheck(folder);
  if (!(await owns())) throw new ImportFolderTakenError(folder.name);
  const destOf = directoryCache(dir);
  const written = new Map<string, { mtime: number; size: number }>();
  const thumbsWritten = new Set<string>();
  await runPool([...staged], ([, s]) => s.size, async ([relPath, s]) => {
    if (!(await owns())) throw new ImportFolderTakenError(folder.name);
    try {
      const final = await publishFile(s.handle, destOf, relPath);
      if (final.size !== s.size) throw new Error(`发布后核对失败：${relPath}`);
      if (s.thumbOf) thumbsWritten.add(s.thumbOf);
      else written.set(relPath, { mtime: final.lastModified, size: final.size });
    } catch (err) {
      if (!s.thumbOf) throw err;
      console.warn("[library] 包内缩略图发布失败，改为重新生成", relPath, err);
    }
  });
  await removeStaging(folder);

  const items = plan.items.map((item) => {
    const stat = written.get(item.relPath);
    if (!stat) throw new Error(`索引条目没有对应的原图：${item.relPath}`);
    return finalizeImportedItem(item, stat, thumbsWritten.has(item.id));
  });

  // 写索引前再核对一次：万一另一个导入也写进了这个目录，绝不能用本次的索引盖掉它
  await assertOwnsFolder(folder);
  await writeFileAtomic(dir, ".ystk/index.json", JSON.stringify(items, null, 2));
  const indexBack = await readJsonFileEx<LibraryIndexItem[]>(dir, ".ystk/index.json");
  if (
    indexBack.status !== "ok" ||
    !Array.isArray(indexBack.value) ||
    indexBack.value.length !== items.length ||
    !indexBack.value.every(
      (row, i) => row && row.id === items[i].id && row.relPath === items[i].relPath,
    )
  ) {
    throw new Error("写回的 index.json 与预期不一致，导入已停止");
  }

  const meta = buildImportedMeta(libraryId, items.length, packageMeta);
  await writeFileAtomic(dir, ".ystk/meta.json", JSON.stringify(meta, null, 2));
  const metaBack = await readJsonFileEx<LibraryMeta>(dir, ".ystk/meta.json");
  if (metaBack.status !== "ok" || metaBack.value.libraryId !== libraryId) {
    throw new Error("写回的 meta.json 与预期不一致，导入已停止");
  }

  // 两个 JSON 都核对通过、目录仍归本次导入所有才清标记：清标记本身就是
  // 「这次导入真的完成了」的凭证
  await assertOwnsFolder(folder);
  try {
    const ystk = await dir.getDirectoryHandle(".ystk");
    await ystk.removeEntry(IMPORT_MARKER_NAME);
  } catch {
    /* 已不存在，忽略 */
  }
  await releaseFolderLock(folder);
  return { libraryId, items, images: total, thumbs: thumbsWritten.size };
}
