/**
 * M3 文件树拆分（2026-11-18 任务卡 §4 B）：把一个**已登记**子目录连同后代生成独立图库索引。
 *
 * 干什么：只往子目录里写 `.ystk/index.json` + `.ystk/meta.json`（复用 fsa 的原子写），
 * 写前留「未完成标记」、写后回读核对、核对通过才清标记。
 * 不干什么：不搬/不复制原图，不碰父库记录，不写 thumbs / vectors.bin，不注册注册表、
 * 不 activateLibrary、不发识图或向量请求，也**不删任何文件**（唯一删除的是自己写的标记）。
 *
 * 为什么先标记后写：index.json 与 meta.json 之间被打断会留下「有索引无 meta」的半成品，
 * 一旦被当作新目录绑定就会走「无 meta → 初始化空索引」把索引覆盖成空。标记让绑定侧能识别
 * 并提示回原库继续；重试只恢复本次写过的那两个文件，别的文件一概不碰。
 */

import { readJsonFileEx, writeFileAtomic } from "../../../core/storage/fsa";
import { randomLibraryId } from "./binding";
import {
  createDefaultMeta,
  fnv1a,
  type LibraryIndexItem,
  type LibraryMeta,
  type LibrarySettings,
} from "./indexFile";

/** 未完成标记（写在**子库**的 .ystk 里；成功后删除） */
export const SPLIT_MARKER_NAME = ".split-in-progress.json";
export const SPLIT_MARKER_REL_PATH = `.ystk/${SPLIT_MARKER_NAME}`;

/** 子库 .ystk 里允许出现的条目（重试时只认这些，多出任何东西即停止） */
/** 标记文件的「刚被写过」窗口（ms）：这是跨页并发的近似互斥，不是真锁 */
const SPLIT_LOCK_WINDOW_MS = 10_000;

const OWNED_NAMES = new Set([
  SPLIT_MARKER_NAME,
  "index.json",
  "meta.json",
  "index.json.tmp",
  "meta.json.tmp",
]);

export interface SplitMarker {
  schemaVersion: 1;
  /** 本次生成的子库 id（重试沿用它，不重新生成） */
  libraryId: string;
  /** 来源库身份（仅诊断与防串用） */
  parentLibraryId: string;
  /** 父库里的目标目录（相对根、正斜杠） */
  targetPath: string;
  /** 本次生成的条数 */
  count: number;
  /** 快照指纹（判定「源数据已变化」） */
  fingerprint: string;
  createdAt: number;
}

/* ---- 纯函数（可单测：不碰 DOM / FSA） ---- */

/**
 * 目录路径规范化：去掉首尾与重复的 `/`。空路径、`.` / `..`、以 `.` 开头的段（`.ystk`
 * 及任何隐藏目录）一律视为非法 → null（调用方按「路径非法」中止，不做任何写入）。
 */
export function normalizeSplitPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw.trim() === "") return null; // 全空白不是路径（防止把空目录当目标）
  const parts = raw.split("/").filter((part) => part !== "");
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (part === "." || part === "..") return null;
    if (part.startsWith(".")) return null;
  }
  return parts.join("/");
}

/**
 * 后代选集：`画师/甲/…` 收全部层级，`画师/甲乙/…` **不**误收（前缀必须带 `/`）。
 * 入参是活动库的完整条目（不受当前搜索/星标/标签等展示筛选影响）。
 */
export function collectSubtreeItems(
  items: readonly LibraryIndexItem[],
  targetPath: string,
): LibraryIndexItem[] {
  const path = normalizeSplitPath(targetPath);
  if (!path) return [];
  const prefix = `${path}/`;
  return items.filter(
    (item) => typeof item.relPath === "string" && item.relPath.startsWith(prefix),
  );
}

/**
 * 子库记录：**复制原记录、只覆盖必须变的字段**——relPath 去掉开头的目标目录段；
 * thumb / pipelineVersion / analyzedAt 归零让本地管线重建缩略图与统计；
 * 其余（id、size、mtime、description、fields、extra、tags 含来源/置信度/顺序、note、
 * starred、visionAt、visionVersion 含 -1 与缺省）原样保留——不改写云端完成时间，
 * 因此「未识图」的条目搬过去仍然是未识图，不会被拆分洗白。
 */
export function remapItemForChild(
  item: LibraryIndexItem,
  targetPath: string,
): LibraryIndexItem | null {
  const path = normalizeSplitPath(targetPath);
  if (!path) return null;
  const prefix = `${path}/`;
  if (typeof item.relPath !== "string" || !item.relPath.startsWith(prefix)) return null;
  const relPath = item.relPath.slice(prefix.length);
  if (!relPath) return null;
  return {
    ...item,
    relPath,
    thumb: null,
    pipelineVersion: 0,
    analyzedAt: null,
  };
}

/** 快照指纹：条目相对路径（排序后）的 fnv1a；条数或路径任一变化都会变 */
export function subtreeFingerprint(items: readonly LibraryIndexItem[]): string {
  return fnv1a(items.map((item) => item.relPath).sort().join("\n"));
}

/** 图库级设置深拷贝（fieldConfig / 预设 / 自定义提示词都在这里；不碰全局配置与密钥） */
export function cloneLibrarySettings(
  parent?: Partial<LibrarySettings>,
): LibrarySettings {
  const base: LibrarySettings = {
    compression: "auto",
    presetId: "photography",
    fieldConfig: {},
  };
  if (!parent) return base;
  let copy: Partial<LibrarySettings> = {};
  try {
    copy = JSON.parse(JSON.stringify(parent)) as Partial<LibrarySettings>;
  } catch {
    copy = {};
  }
  return {
    ...base,
    ...copy,
    fieldConfig: { ...base.fieldConfig, ...(copy.fieldConfig ?? {}) },
  };
}

/** 子库 meta：独立 libraryId / 新建时间 / schemaVersion 1 / files=N / analyzed=0 + 父库设置 */
export function buildChildMeta(
  libraryId: string,
  count: number,
  parentSettings?: Partial<LibrarySettings>,
  now = Date.now(),
): LibraryMeta {
  const meta = createDefaultMeta(libraryId);
  meta.createdAt = now;
  meta.updatedAt = now;
  meta.stats = { files: count, analyzed: 0 };
  meta.settings = cloneLibrarySettings(parentSettings);
  return meta;
}

/**
 * 文件树底部「拆分为独立图库…」的可见/禁用口径（纯函数，UI 只负责渲染）：
 * 「全部」与空树不显示；扫描/生成中禁用并给原因。
 */
export interface SplitActionState {
  visible: boolean;
  disabled: boolean;
  hint: string;
}

export function splitActionState(opts: {
  folderScope: string | null;
  treeEmpty: boolean;
  scanRunning: boolean;
  splitting: boolean;
}): SplitActionState {
  if (opts.folderScope == null || opts.treeEmpty) {
    return { visible: false, disabled: true, hint: "" };
  }
  if (opts.splitting) {
    return { visible: true, disabled: true, hint: "正在生成独立图库…" };
  }
  if (opts.scanRunning) {
    return { visible: true, disabled: true, hint: "扫描完成后可拆分" };
  }
  return { visible: true, disabled: false, hint: "" };
}

/* ---- 写盘（FSA）：新建 / 中断恢复 ---- */

function describeFsError(err: unknown, path: string): string {
  if (err instanceof DOMException) {
    if (err.name === "NotFoundError") {
      return `没有找到原图目录「${path}」。拆分不会新建目录，请先在文件资源管理器里建好并扫描一次`;
    }
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      return `没有权限读写「${path}」。请在图库目录授权里重新允许后再试`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/** 逐级打开父库里的既有子目录（不 create）；不存在/无权限分别给可读原因 */
async function openChildDir(
  parentDir: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  let current = parentDir;
  let walked = "";
  for (const part of path.split("/")) {
    walked = walked ? `${walked}/${part}` : part;
    try {
      current = await current.getDirectoryHandle(part);
    } catch (err) {
      throw new Error(describeFsError(err, walked));
    }
  }
  return current;
}

/** 子库 .ystk 现状：是否存在、条目名、未完成标记（含标记文件的 mtime，判「另一个页面正在写」） */
async function inspectChildYstk(child: FileSystemDirectoryHandle): Promise<{
  exists: boolean;
  names: string[];
  marker: SplitMarker | null;
  markerMtime: number;
}> {
  let ystk: FileSystemDirectoryHandle;
  try {
    ystk = await child.getDirectoryHandle(".ystk");
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") {
      return { exists: false, names: [], marker: null, markerMtime: 0 };
    }
    throw new Error(describeFsError(err, ".ystk"));
  }
  const names: string[] = [];
  for await (const entry of ystk.values()) names.push(entry.name);
  const markerRead = await readJsonFileEx<SplitMarker>(
    child,
    SPLIT_MARKER_REL_PATH,
  );
  const marker = markerRead.status === "ok" ? markerRead.value : null;
  let markerMtime = 0;
  if (marker) {
    try {
      markerMtime = (await (await ystk.getFileHandle(SPLIT_MARKER_NAME)).getFile())
        .lastModified;
    } catch {
      markerMtime = 0; // 读不到 mtime 就按「不是正在写」处理（重试路径仍可用）
    }
  }
  return { exists: true, names, marker, markerMtime };
}

export interface SplitIntoLibraryOptions {
  parentDir: FileSystemDirectoryHandle;
  parentLibraryId: string;
  /** 父库里的目标目录（相对根、正斜杠） */
  targetPath: string;
  /** 活动库完整条目（父库口径的快照，调用方已确认与磁盘索引一致） */
  items: readonly LibraryIndexItem[];
  parentSettings?: Partial<LibrarySettings>;
  /** 期间换库 / 索引状态变化 → true，立刻停止且不留半成品标记之外的写入 */
  isStale?: () => boolean;
}

export interface SplitIntoLibraryResult {
  libraryId: string;
  count: number;
}

/**
 * 生成独立图库：标记 → 写 index.json → 回读核对 → 写 meta.json → 回读核对 → 清标记。
 * 任一步失败都保留标记（下次重试只重写这两个文件）；不删、不改任何既有文件。
 */
export async function splitIntoLibrary(
  opts: SplitIntoLibraryOptions,
): Promise<SplitIntoLibraryResult> {
  const path = normalizeSplitPath(opts.targetPath);
  if (!path) throw new Error(`目录路径不合法：${opts.targetPath}`);
  const region = collectSubtreeItems(opts.items, path);
  const childItems: LibraryIndexItem[] = [];
  for (const item of region) {
    const mapped = remapItemForChild(item, path);
    if (mapped) childItems.push(mapped);
  }
  if (childItems.length === 0) {
    throw new Error(`「${path}」下没有已登记的图片，无需拆分`);
  }
  const count = childItems.length;
  const fingerprint = subtreeFingerprint(childItems);

  const child = await openChildDir(opts.parentDir, path);
  const before = await inspectChildYstk(child);

  let libraryId = randomLibraryId();
  if (before.exists) {
    const marker = before.marker;
    const resumable =
      marker != null &&
      marker.parentLibraryId === opts.parentLibraryId &&
      marker.targetPath === path;
    if (!resumable) {
      throw new Error(
        `「${path}」里已经有 .ystk（可能已是独立图库），不会覆盖它。请换一个目录，或先在别处处理掉它`,
      );
    }
    // 跨页并发（同一目标两个标签页）没有真正的锁：用「标记刚被写过」当近似互斥——
    // 另一个页面正在写时标记的 mtime 就在秒级以内，此时拒绝，不当成可恢复的半成品。
    if (before.markerMtime > 0 && Date.now() - before.markerMtime < SPLIT_LOCK_WINDOW_MS) {
      throw new Error(
        `「${path}」正在生成中（另一个页面在写，或上一次刚刚中断），请等几秒再试`,
      );
    }
    if (marker.fingerprint !== fingerprint || marker.count !== count) {
      throw new Error(
        `「${path}」的登记内容已经变化（上一次未完成的拆分为 ${marker.count} 张），请重新发起一次拆分`,
      );
    }
    const extra = before.names.filter((name) => !OWNED_NAMES.has(name));
    if (extra.length > 0) {
      throw new Error(
        `「${path}」的 .ystk 里还有别的文件（${extra.slice(0, 3).join("、")}），无法确认是本工具写的，已停止（不会删任何文件）`,
      );
    }
    libraryId = marker.libraryId;
  }

  if (opts.isStale?.()) {
    throw new Error("图库已切换或索引已更新，拆分已取消（未写入任何文件）");
  }

  const ystk = await child.getDirectoryHandle(".ystk", { create: true });
  const marker: SplitMarker = {
    schemaVersion: 1,
    libraryId,
    parentLibraryId: opts.parentLibraryId,
    targetPath: path,
    count,
    fingerprint,
    createdAt: Date.now(),
  };
  // 先落标记：万一下面被打断，绑定侧能识别「这是没写完的拆分」而不是当成新目录初始化
  await writeFileAtomic(ystk, SPLIT_MARKER_NAME, JSON.stringify(marker, null, 2));

  await writeFileAtomic(child, ".ystk/index.json", JSON.stringify(childItems, null, 2));
  const indexBack = await readJsonFileEx<LibraryIndexItem[]>(child, ".ystk/index.json");
  if (indexBack.status !== "ok" || !Array.isArray(indexBack.value)) {
    throw new Error("写回的 index.json 读不出来，已停止（标记保留，可重试）");
  }
  const written = indexBack.value;
  const same =
    written.length === count &&
    written.every(
      (item, i) => item && item.relPath === childItems[i].relPath && item.id === childItems[i].id,
    );
  if (!same) {
    throw new Error(
      `写回的 index.json 与快照不一致（期望 ${count} 条，读到 ${written.length} 条），已停止（标记保留，可重试）`,
    );
  }

  const meta = buildChildMeta(libraryId, count, opts.parentSettings);
  await writeFileAtomic(child, ".ystk/meta.json", JSON.stringify(meta, null, 2));
  const metaBack = await readJsonFileEx<LibraryMeta>(child, ".ystk/meta.json");
  if (metaBack.status !== "ok") {
    throw new Error("写回的 meta.json 读不出来，已停止（标记保留，可重试）");
  }
  const metaOk =
    metaBack.value.libraryId === libraryId &&
    metaBack.value.stats?.files === count &&
    JSON.stringify(metaBack.value.settings) === JSON.stringify(meta.settings);
  if (!metaOk) {
    throw new Error("写回的 meta.json 与预期不一致，已停止（标记保留，可重试）");
  }

  if (opts.isStale?.()) {
    throw new Error("图库已切换或索引已更新，拆分已停止（标记保留，可重试）");
  }

  // 两个 JSON 都核对通过才清标记：清标记本身就是「这次拆分真的完成了」的唯一凭证
  try {
    await ystk.removeEntry(SPLIT_MARKER_NAME);
  } catch {
    /* 已不存在，忽略 */
  }
  return { libraryId, count };
}
