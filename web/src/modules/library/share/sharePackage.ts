/**
 * 分享包 · 纯逻辑（不碰 DOM / FSA，可单测）。
 *
 * 包结构与 PicLibBridge 的 YSTK ZIP 一致：
 *   <文件夹名>/图片…（保留子目录）
 *   <文件夹名>/.ystk/index.json, meta.json
 * Eagle 导出包（.eaglepack）的映射在 eaglePackage.ts，产出同一种导入计划。
 * 导出不带 thumbs/ 与 vectors.bin。导入时包里若有 `.ystk/thumbs/<id>.webp|png`（PicLibBridge
 * 的包、直接打包的图库）且与条目对得上，就沿用它，省掉重建（用户 2026-11-21 口径）；
 * vectors.bin 一律不导入：向量取决于本机嵌入模型，且含来源方私人备注的信息。
 *
 * 导出：条目复制原记录，相对路径改到导出目录为根；缩略图 / 基础统计归零交本地管线
 * 重算；**私人备注清空**（用户 2026-11-21 口径）；描述、字段、标签、来源、星标、识图
 * 状态原样保留。meta 用新 libraryId——沿用原 id 会让收件方（或同一浏览器）绑定时被
 * 当成原库「重新定位」。
 *
 * 导入：浏览器写盘无法设定文件修改时间，原图落盘后 mtime 都是「现在」。识图 pending
 * 判据是 `visionAt < mtime`，所以来源包里已识图完成的条目要把 visionAt 拨到不早于新
 * mtime，否则会全部重新排队扣费；来源里本来待识图的条目保持待识图。
 */

import {
  createDefaultMeta,
  type LibraryIndexItem,
  type LibraryMeta,
  type LibrarySettings,
} from "../index/indexFile";
import { isImage } from "../index/scan";
import { buildChildMeta, normalizeSplitPath } from "../index/splitFolder";
import { findEaglePackRoot, type PackageFile } from "./eaglePackage";
import { unsupportedReason, type ZipEntry } from "./zip";

/** 导出文件名后缀（与 PicLibBridge 的「<名>_YSTK.zip」一致） */
export const SHARE_ZIP_SUFFIX = "_YSTK.zip";
/** 导入未完成标记（写在新图库 .ystk 里；成功后删除） */
export const IMPORT_MARKER_NAME = ".import-in-progress.json";
export const IMPORT_MARKER_REL_PATH = `.ystk/${IMPORT_MARKER_NAME}`;

/* ---- 路径与名称 ---- */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const BAD_CHARS = /[<>:"|?*\\]/;

/**
 * 包内路径安全校验（对照 PicLibBridge PackageReader.Safe）：反斜杠视为分隔符；
 * 绝对路径、盘符、`.`/`..` 段、空段、以空格或点结尾的段、Windows 保留名与非法字符
 * 一律拒绝。合法时返回正斜杠规范路径（目录条目去掉结尾 /），否则 null。
 */
export function safePackagePath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(/\\/g, "/");
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (!s || s.startsWith("/")) return null;
  for (const seg of s.split("/")) {
    if (!isSafeSegment(seg)) return null;
  }
  return s;
}

function isSafeSegment(seg: string): boolean {
  if (seg === "" || seg === "." || seg === "..") return false;
  if (seg.endsWith(" ") || seg.endsWith(".")) return false;
  if (BAD_CHARS.test(seg) || WINDOWS_RESERVED.test(seg)) return false;
  for (const ch of seg) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** 文件夹名清洗（导出根目录名 / 导入新建目录名）：非法字符换成 -，空则「图库」 */
export function sanitizeFolderName(raw: string): string {
  const cleaned = [...String(raw ?? "")]
    .map((ch) => {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) return "";
      return /[<>:"/\\|?*]/.test(ch) ? "-" : ch;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .replace(/[.\s]+$/, "")
    .replace(/^\.+/, "");
  if (!cleaned || WINDOWS_RESERVED.test(cleaned)) return "图库";
  return cleaned;
}

/** 同名目录已存在时的候选名：名称、名称 (2)、名称 (3)… */
export function folderNameCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base} (${n})`;
}

/* ---- 导出 ---- */

export interface ExportPlanEntry {
  /** 原图在当前图库中的相对路径（读文件用） */
  sourceRelPath: string;
  /** 写进分享包的条目（relPath 已相对导出根） */
  item: LibraryIndexItem;
}

export interface ExportPlan {
  /** 包内根目录名（也是建议文件名的主体） */
  rootName: string;
  entries: ExportPlanEntry[];
  /** 路径无法安全写进 ZIP 而跳过的条目数 */
  skipped: number;
}

/** 分享用条目：复制原记录，只改必须变的字段（见文件头） */
export function toSharedItem(item: LibraryIndexItem, relPath: string): LibraryIndexItem {
  return {
    ...item,
    relPath,
    note: "",
    thumb: null,
    pipelineVersion: 0,
    analyzedAt: null,
  };
}

/**
 * 导出计划：folderScope 为 null 时导出整个图库（根目录名取图库名），否则导出该目录
 * 及其子目录（路径去掉目录前缀，根目录名取目录末段）。入参是完整条目，不受展示筛选影响。
 */
export function planExport(
  items: readonly LibraryIndexItem[],
  folderScope: string | null,
  libraryName: string,
): ExportPlan {
  let rootName: string;
  let prefix = "";
  if (folderScope == null) {
    rootName = sanitizeFolderName(libraryName);
  } else {
    const path = normalizeSplitPath(folderScope);
    if (!path) throw new Error(`目录路径不合法：${folderScope}`);
    prefix = `${path}/`;
    rootName = sanitizeFolderName(path.split("/").pop() ?? path);
  }
  const entries: ExportPlanEntry[] = [];
  let skipped = 0;
  for (const item of items) {
    if (!item || typeof item.relPath !== "string" || typeof item.id !== "string") continue;
    if (prefix && !item.relPath.startsWith(prefix)) continue;
    const relPath = item.relPath.slice(prefix.length);
    if (!relPath || safePackagePath(relPath) !== relPath) {
      skipped += 1;
      continue;
    }
    entries.push({ sourceRelPath: item.relPath, item: toSharedItem(item, relPath) });
  }
  entries.sort((a, b) => (a.item.relPath < b.item.relPath ? -1 : a.item.relPath > b.item.relPath ? 1 : 0));
  return { rootName, entries, skipped };
}

/** 分享包 meta：新 libraryId，图库设置照搬（不含全局配置与密钥） */
export function buildShareMeta(
  libraryId: string,
  count: number,
  settings?: Partial<LibrarySettings>,
  now = Date.now(),
): LibraryMeta {
  return buildChildMeta(libraryId, count, settings, now);
}

/* ---- 导入：识别包结构 ---- */

export interface PackageImage {
  entry: ZipEntry;
  /** 相对图库根的路径（正斜杠） */
  relPath: string;
}

export interface PackageLayout {
  /** 来源格式：YSTK 分享包，或 Eagle 导出包（由 eaglePackage.planEagleImport 生成） */
  format: "ystk" | "eagle";
  /** 包内图库根前缀（如 `行間/`；根在包顶层时为空串） */
  rootPrefix: string;
  /** 建议的新图库目录名 */
  rootName: string;
  indexEntry: ZipEntry;
  metaEntry: ZipEntry | null;
  images: PackageImage[];
  /** 包内根 `.ystk/thumbs/` 下的文件（键 = 小写文件名）；是否采用由 planImportIndex 决定 */
  thumbs: Map<string, ZipEntry>;
  /** 是否带语义向量（`.ystk/vectors.bin`；不导入，由本机模型重新生成） */
  hasVectors: boolean;
  /** 其余不导入的图库内部文件数（嵌套 .ystk、.ystk 里的其它文件） */
  internalSkipped: number;
  /** 不导入的非图片文件数（图库目录外的文件、非图片格式） */
  ignored: number;
  /** YSTK 不支持的图片格式条数（仅 Eagle 包：psd、mp4 等跳过不导入） */
  unsupported: number;
  /** 上面那些条目的扩展名（小写、去重） */
  unsupportedExts: string[];
}

function stemOf(fileName: string): string {
  let stem = fileName.replace(/\.[^.]*$/, "");
  if (stem.toLowerCase().endsWith("_ystk")) stem = stem.slice(0, -5);
  return stem;
}

/** 包内文件清单：逐条做路径安全与可读性校验（目录条目略过），不安全即整包拒绝 */
export function collectPackageFiles(entries: readonly ZipEntry[]): PackageFile[] {
  const files: PackageFile[] = [];
  for (const entry of entries) {
    const path = safePackagePath(entry.name);
    if (path === null) throw new Error(`包里有不安全或不受支持的路径：${entry.name}`);
    if (entry.isDirectory) continue;
    const reason = unsupportedReason(entry);
    if (reason) throw new Error(`包里有无法读取的条目（${reason}）：${entry.name}`);
    files.push({ entry, path });
  }
  return files;
}

/** 包内的 YSTK 图库索引（任意层级的 `.ystk/index.json`） */
export function findYstkIndexes(files: readonly PackageFile[]): PackageFile[] {
  return files.filter((f) => {
    const p = f.path.toLowerCase();
    return p === ".ystk/index.json" || p.endsWith("/.ystk/index.json");
  });
}

/** 识别 YSTK 分享包：恰好一个 `.ystk/index.json`；路径不安全、加密等给可读原因抛出 */
export function analyzePackage(entries: readonly ZipEntry[], fileName: string): PackageLayout {
  return analyzeYstkFiles(collectPackageFiles(entries), fileName);
}

export function analyzeYstkFiles(files: readonly PackageFile[], fileName: string): PackageLayout {
  const indexes = findYstkIndexes(files);
  if (indexes.length === 0) {
    throw new Error("没有找到图库索引（.ystk/index.json），也不是 Eagle 导出包");
  }
  if (indexes.length > 1) {
    throw new Error(`包里有 ${indexes.length} 个图库索引，一次只能导入一个图库`);
  }
  if (findEaglePackRoot(files)) {
    throw new Error("包里同时有 YSTK 图库和 Eagle 的 pack.json，无法判断该按哪种格式导入");
  }
  const indexEntry = indexes[0];
  const rootPrefix = indexEntry.path.slice(0, indexEntry.path.length - ".ystk/index.json".length);

  let metaEntry: ZipEntry | null = null;
  const images: PackageImage[] = [];
  const thumbs = new Map<string, ZipEntry>();
  const seen = new Set<string>();
  let hasVectors = false;
  let internalSkipped = 0;
  let ignored = 0;
  for (const f of files) {
    if (f === indexEntry) continue;
    if (!f.path.startsWith(rootPrefix)) {
      ignored += 1;
      continue;
    }
    const rel = f.path.slice(rootPrefix.length);
    const relLower = rel.toLowerCase();
    if (relLower === ".ystk/meta.json") {
      metaEntry = f.entry;
      continue;
    }
    if (relLower === ".ystk/vectors.bin") {
      hasVectors = true;
      continue;
    }
    const thumbMatch = /^\.ystk\/thumbs\/([^/]+)$/.exec(relLower);
    if (thumbMatch) {
      thumbs.set(thumbMatch[1], f.entry);
      continue;
    }
    // 任意层级的 .ystk 内容都不当原图：扫描本来就跳过 .ystk
    if (rel.split("/").some((seg) => seg.toLowerCase() === ".ystk")) {
      internalSkipped += 1;
      continue;
    }
    if (!isImage(rel)) {
      ignored += 1;
      continue;
    }
    // Windows 文件名不分大小写：只差大小写的两个路径落盘会互相覆盖
    const key = rel.toLowerCase();
    if (seen.has(key)) throw new Error(`分享包里有只差大小写的重复路径：${rel}`);
    seen.add(key);
    images.push({ entry: f.entry, relPath: rel });
  }
  if (images.length === 0) throw new Error("分享包里没有可导入的图片");

  const rootSeg = rootPrefix.replace(/\/$/, "").split("/").pop() ?? "";
  const rootName = sanitizeFolderName(rootSeg || stemOf(fileName));
  return {
    format: "ystk",
    rootPrefix,
    rootName,
    indexEntry: indexEntry.entry,
    metaEntry,
    images,
    thumbs,
    hasVectors,
    internalSkipped,
    ignored,
    unsupported: 0,
    unsupportedExts: [],
  };
}

/* ---- 导入：索引条目 ---- */

/** 缺字段的条目按 schema 默认值补齐（PicLibBridge 的包字段齐全，这里只防手工改过的包） */
function defaultItem(id: string, relPath: string): LibraryIndexItem {
  return {
    id,
    relPath,
    mtime: 0,
    size: 0,
    width: null,
    height: null,
    meanLuma: null,
    meanSat: null,
    tone: null,
    hiColor: null,
    loColor: null,
    phash: null,
    colors: [],
    description: "",
    fields: {},
    extra: {},
    tags: [],
    note: "",
    starred: false,
    analyzedAt: null,
    pipelineVersion: 0,
    thumb: null,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function normalizeImportedItem(
  raw: Record<string, unknown>,
  relPath: string,
): LibraryIndexItem {
  const base = defaultItem(String(raw.id), relPath);
  const item = { ...base, ...raw, id: base.id, relPath } as LibraryIndexItem;
  if (!Array.isArray(item.colors)) item.colors = [];
  if (!Array.isArray(item.tags)) item.tags = [];
  if (!isPlainObject(item.fields)) item.fields = {};
  if (!isPlainObject(item.extra)) item.extra = {};
  if (typeof item.description !== "string") item.description = "";
  if (typeof item.note !== "string") item.note = "";
  item.starred = item.starred === true;
  if (!Number.isFinite(item.mtime)) item.mtime = 0;
  if (!Number.isFinite(item.size)) item.size = 0;
  if (!Number.isFinite(item.pipelineVersion)) item.pipelineVersion = 0;
  // 缩略图先置空：只有 planImportIndex 核对过包里确有对应文件才会填回
  item.thumb = null;
  return item;
}

/** 包内缩略图上限（工具生成的最长边 960 的 WebP 通常几十 KB） */
const MAX_THUMB_BYTES = 4 * 1024 * 1024;

/** 正数尺寸（导入缩略图时必须有：基础分析不重跑缩略图那一遍，就不会再补原图宽高） */
function hasDimensions(item: LibraryIndexItem): boolean {
  return (
    typeof item.width === "number" && item.width > 0 &&
    typeof item.height === "number" && item.height > 0
  );
}

/**
 * 条目能否沿用包里的缩略图：索引里写的是 `thumbs/<本条 id>.webp|png`、包里确有这个文件、
 * 大小合理、条目带原图宽高。返回规范化后的 thumb 值，不满足返回 null（打开后重新生成）。
 */
export function pickPackageThumb(
  raw: Record<string, unknown>,
  item: LibraryIndexItem,
  thumbs: ReadonlyMap<string, ZipEntry>,
): { thumb: string; entry: ZipEntry } | null {
  if (typeof raw.thumb !== "string" || !hasDimensions(item)) return null;
  const m = /^thumbs\/([0-9a-f]{8})\.(webp|png)$/i.exec(raw.thumb.trim());
  if (!m || m[1].toLowerCase() !== item.id.toLowerCase()) return null;
  const name = `${m[1]}.${m[2]}`.toLowerCase();
  const entry = thumbs.get(name);
  if (!entry || entry.size === 0 || entry.size > MAX_THUMB_BYTES) return null;
  return { thumb: `thumbs/${name}`, entry };
}

/** 缩略图文件头核对：扩展名与实际格式一致（WebP = RIFF…WEBP，PNG = 8 字节签名） */
export function thumbBytesMatch(thumb: string, bytes: Uint8Array): boolean {
  if (thumb.endsWith(".webp")) {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    );
  }
  if (thumb.endsWith(".png")) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= 8 && sig.every((b, i) => bytes[i] === b);
  }
  return false;
}

export interface ImportIndexPlan {
  items: LibraryIndexItem[];
  /** 沿用包内缩略图的条目：id → 包内文件（写盘时再核对文件头，不符就改回重新生成） */
  thumbEntries: Map<string, ZipEntry>;
  /** 包里有、但对不上任何条目的缩略图（不导入） */
  thumbsUnused: number;
  /** 索引里有、包里找不到原图的条目（丢弃） */
  dropped: number;
  /** 包里有原图、索引里没有的文件（照样解压，扫描时按新图登记） */
  unindexed: number;
}

/** 解析包内 index.json 并与原图、缩略图清单对位；ID / 路径重复视为损坏的包 */
export function planImportIndex(
  raw: unknown,
  images: readonly PackageImage[],
  thumbs: ReadonlyMap<string, ZipEntry> = new Map(),
): ImportIndexPlan {
  if (!Array.isArray(raw)) throw new Error("分享包的 index.json 结构异常（不是数组）");
  const byLower = new Map(images.map((img) => [img.relPath.toLowerCase(), img.relPath]));
  const usedPaths = new Set<string>();
  const ids = new Set<string>();
  const items: LibraryIndexItem[] = [];
  const thumbEntries = new Map<string, ZipEntry>();
  let dropped = 0;
  for (const row of raw) {
    if (!isPlainObject(row) || typeof row.id !== "string" || typeof row.relPath !== "string" || !row.id) {
      throw new Error("分享包的 index.json 里有结构不合法的条目");
    }
    const safe = safePackagePath(row.relPath);
    const actual = safe === null ? undefined : byLower.get(safe.toLowerCase());
    if (!actual) {
      dropped += 1;
      continue;
    }
    if (ids.has(row.id)) throw new Error(`分享包的 index.json 里有重复 ID：${row.id}`);
    const key = actual.toLowerCase();
    if (usedPaths.has(key)) throw new Error(`分享包的 index.json 里有重复路径：${actual}`);
    ids.add(row.id);
    usedPaths.add(key);
    const item = normalizeImportedItem(row, actual);
    const picked = pickPackageThumb(row, item, thumbs);
    if (picked) {
      item.thumb = picked.thumb;
      thumbEntries.set(item.id, picked.entry);
    }
    items.push(item);
  }
  return {
    items,
    thumbEntries,
    thumbsUnused: thumbs.size - thumbEntries.size,
    dropped,
    unindexed: images.length - items.length,
  };
}

/** 来源包里这条是否已识图完成（与队列 pending 判据的时间部分同口径） */
export function wasVisionDone(item: LibraryIndexItem): boolean {
  return (
    (item.visionVersion ?? 0) >= 1 &&
    typeof item.visionAt === "number" &&
    item.visionAt >= item.mtime
  );
}

/**
 * 识过图、但之后原图又被改过（visionAt 早于原 mtime）→ 应当重新识图。
 * 只有这一类的「待识图」取决于时间：未识图（visionAt 为空）、识图失败（-1）、
 * 版本过旧都与 mtime 无关，换了 mtime 也不会变。
 */
function isVisionStale(item: LibraryIndexItem): boolean {
  return (
    (item.visionVersion ?? 0) >= 1 &&
    typeof item.visionAt === "number" &&
    item.visionAt < item.mtime
  );
}

/**
 * 落盘后定稿：mtime/size 取实际文件；thumbWritten = 包内缩略图已核对并写盘，否则 thumb
 * 置空交本地管线重新生成。
 *
 * 识图状态按**来源里的分类**保持不变（分类在换 mtime 之前判定）：
 * - 已完成：visionAt 上调到不早于新 mtime，不会重新排队；
 * - 改过图待重识：visionAt 压到新 mtime 之前。否则来源设备时钟偏快时，旧 visionAt 可能
 *   晚于本机写盘时间，条目会被误判为已完成；
 * - 其余（未识图、失败、版本旧）：原样保留。
 */
export function finalizeImportedItem(
  item: LibraryIndexItem,
  written: { mtime: number; size: number },
  thumbWritten = false,
): LibraryIndexItem {
  let visionAt = item.visionAt ?? null;
  if (wasVisionDone(item)) {
    visionAt = Math.max(item.visionAt as number, written.mtime);
  } else if (isVisionStale(item)) {
    visionAt = Math.min(item.visionAt as number, written.mtime - 1);
  }
  return {
    ...item,
    mtime: written.mtime,
    size: written.size,
    thumb: thumbWritten ? item.thumb : null,
    visionAt,
  };
}

/**
 * 导入的识图状态摘要：待识图与识图失败分开说（失败项不会随「开始识图」自动重跑，
 * 要用「重试失败项」），两者都为 0 才说「均已识图」。
 */
export function visionSummary(pending: number, failed: number): string {
  const parts: string[] = [];
  if (pending > 0) parts.push(`${pending} 张待识图`);
  if (failed > 0) parts.push(`${failed} 张识图失败`);
  return parts.length > 0 ? parts.join("、") : "均已识图";
}

/** 导入后的 meta：新 libraryId；设置取包内 meta（缺失/损坏用默认值） */
export function buildImportedMeta(
  libraryId: string,
  count: number,
  packageMeta: unknown,
  now = Date.now(),
): LibraryMeta {
  const settings = isPlainObject(packageMeta) && isPlainObject(packageMeta.settings)
    ? (packageMeta.settings as Partial<LibrarySettings>)
    : undefined;
  const meta = settings ? buildChildMeta(libraryId, count, settings, now) : createDefaultMeta(libraryId);
  meta.createdAt = now;
  meta.updatedAt = now;
  meta.stats = { files: count, analyzed: 0 };
  return meta;
}
