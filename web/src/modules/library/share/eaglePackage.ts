/**
 * Eagle 导出包 → YSTK 条目（纯逻辑，可单测）。
 *
 * 对照 PicLibBridge 0.3.3 `Converter.ToYstk` 移植（不含 .bridge.zip 配套档案的反向恢复）。
 * PicLibBridge 即将弃用，本模块是 Eagle 导入的正式实现：
 * - 包结构：`pack.json`（folder 文件夹树 + images 列表）+ `<id>.info/<name>.<ext>` 原图；
 *   `metadata.json` 与 `_thumbnail.png` 是 Eagle 内部文件，不导入（缩略图从原图重建）。
 * - 路径：图片放进它第一个已知文件夹；包根文件夹本身就是图库根，不再多套一层；
 *   名为 `.ystk` 的文件夹改名为 `_.ystk`（扫描会跳过 `.ystk` 目录）；
 *   文件名按 Leaf 规则清洗，同名加「 (2)」。
 * - ID：相对路径的 8 位 FNV-1a，碰撞按 `#2`、`#3` 重算（与 YSTK 扫描一致）。
 * - 字段：annotation → description（与 YSTK 描述同义，不另留副本；识图会照常改写它，
 *   用户 2026-11-21 口径）；有效标签写
 *   source "manual"；url → extra[SOURCE_URL_EXTRA_KEY]（「原帖链接」）；palettes → colors（ratio / 100）；
 *   宽高 > 0 才写；基础统计留空交本地管线。
 * - 识图状态：注释、有效标签、来源三项齐全 → visionVersion 1 + visionAt；缺任一项 → 0 / null，
 *   YSTK 常规识图队列会把它列为待识图。
 *
 * 与 PicLibBridge 的差异（应用内导入更宽松，均在确认框里说明数量）：
 * - YSTK 不支持的格式（psd、mp4 等）跳过，而不是整包拒绝；
 * - 找不到原图的条目跳过，而不是整包拒绝。
 */

import type { LibraryIndexItem } from "../index/indexFile";
import { SOURCE_URL_EXTRA_KEY, fnv1a } from "../index/indexFile";
import { isImage } from "../index/scan";
import type { ImportIndexPlan, PackageImage, PackageLayout } from "./sharePackage";
import type { ZipEntry } from "./zip";

/** 已做过安全校验的包内文件（path 为正斜杠规范路径） */
export interface PackageFile {
  entry: ZipEntry;
  path: string;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 文件/目录名清洗（对照 Converter.Leaf）：控制字符与 `<>:"/\|?*` 换成 `_`，去首尾空白与
 * 结尾的点，最长 100，空则「未命名」，Windows 保留名前加 `_`。
 * 比原版多去一次结尾空格（「名字 .」去掉点后会剩结尾空格，Windows 目录名不允许）。
 */
export function eagleLeaf(raw: unknown): string {
  let s = [...String(raw ?? "")]
    .map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(ch) ? "_" : ch))
    .join("")
    .trim();
  s = s.replace(/[.\s]+$/, "");
  if (s.length > 100) s = s.slice(0, 100).replace(/[.\s]+$/, "");
  if (!s.trim()) s = "未命名";
  if (RESERVED.test(s.split(".")[0])) s = `_${s}`;
  return s;
}

/**
 * 文件夹名清洗：在 eagleLeaf 之外避开 `.ystk`（大小写不敏感，Windows 不区分大小写）。
 * YSTK 扫描会跳过任何叫 `.ystk` 的目录，图放进去就再也扫不到，增量扫描还会把这些
 * 条目当成「消失」从索引里删掉；所以改名为 `_.ystk`，条目 ID 也按改名后的路径计算。
 */
export function eagleFolderLeaf(raw: unknown): string {
  const leaf = eagleLeaf(raw);
  return leaf.toLowerCase() === ".ystk" ? `_${leaf}` : leaf;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * 文件夹 id → 相对路径（对照 Converter.Folders：遍历 folder 与 folders 两种根）。
 *
 * 同一层的两个 Eagle 文件夹，名字清洗后可能变成同一个目录名：`.ystk` 与 `_.ystk`、
 * `A` 与 `a`（Windows 不分大小写）、`x:y` 与 `x_y`……不处理就会被合并成一个目录，
 * 原来的分类丢失。所以按文件夹在树里出现的顺序，给同级的后来者加「 (2)」「 (3)」，
 * 每个文件夹 ID 都对应自己的目录。
 */
export function eagleFolderPaths(pack: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  /** 每个父目录下已用的子目录名（小写） */
  const usedByParent = new Map<string, Set<string>>();
  const siblingName = (parent: string, raw: unknown): string => {
    let used = usedByParent.get(parent);
    if (!used) {
      used = new Set();
      usedByParent.set(parent, used);
    }
    const base = eagleFolderLeaf(raw);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${base} (${n})`;
    used.add(name.toLowerCase());
    return name;
  };
  const walk = (node: unknown, parent: string, depth: number) => {
    if (!isObject(node)) return;
    if (depth > 64) throw new Error("Eagle 包的文件夹层级过深");
    const path = parent + siblingName(parent, node.name);
    const id = str(node.id);
    if (id) {
      if (result.has(id)) throw new Error("Eagle 包里有重复的文件夹 ID");
      result.set(id, path);
    }
    if (Array.isArray(node.children)) for (const c of node.children) walk(c, `${path}/`, depth + 1);
  };
  walk(pack.folder, "", 0);
  if (Array.isArray(pack.folders)) for (const n of pack.folders) walk(n, "", 0);
  return result;
}

/** 同名去重：`a/b.jpg` 已用 → `a/b (2).jpg`（大小写不敏感，Windows 文件名口径） */
function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path.toLowerCase())) {
    used.add(path.toLowerCase());
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const hasExt = dot > slash + 1;
  const stem = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : "";
  for (let i = 2; ; i += 1) {
    const next = `${stem} (${i})${ext}`;
    if (!used.has(next.toLowerCase())) {
      used.add(next.toLowerCase());
      return next;
    }
  }
}

/** YSTK 条目 ID：fnv1a(relPath)，碰撞按 `#2`、`#3` 重算（与 indexFile.makeId 同规则） */
function allocateId(relPath: string, used: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const id = fnv1a(n === 1 ? relPath : `${relPath}#${n}`);
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
  }
}

function hex2(v: unknown): string {
  return Math.min(255, Math.max(0, Math.trunc(num(v)))).toString(16).padStart(2, "0");
}

/** Eagle 包根：恰好一个 pack.json 时返回其所在前缀（如 `""` 或 `行間/`），否则 null */
export function findEaglePackRoot(files: readonly PackageFile[]): { root: string; pack: PackageFile } | null {
  const packs = files.filter((f) => {
    const p = f.path.toLowerCase();
    return (p === "pack.json" || p.endsWith("/pack.json")) && !p.includes(".piclibbridge/");
  });
  if (packs.length !== 1) return null;
  const pack = packs[0];
  return { root: pack.path.slice(0, pack.path.length - "pack.json".length), pack };
}

export interface EaglePlan {
  layout: PackageLayout;
  plan: ImportIndexPlan;
}

/**
 * 由 pack.json 生成导入计划。返回的 layout.images 的 relPath 是**落盘目标路径**，entry 指向
 * 包内原图——writeImport 按这个对应关系解压，后续流程与 YSTK 分享包完全一致。
 */
export function planEagleImport(
  files: readonly PackageFile[],
  packFile: PackageFile,
  root: string,
  pack: unknown,
  fileName: string,
  now = Date.now(),
): EaglePlan {
  if (!isObject(pack) || !Array.isArray(pack.images)) {
    throw new Error("Eagle 包的 pack.json 结构异常（没有图片列表）");
  }
  const byLower = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const folders = eagleFolderPaths(pack);
  // 根文件夹名取 eagleFolderPaths 分配的结果，去掉根前缀时两边才是同一个名字
  const rootFolderName = isObject(pack.folder) && str(pack.folder.name).trim()
    ? (folders.get(str(pack.folder.id)) ?? eagleFolderLeaf(pack.folder.name))
    : null;
  const stem = fileName.replace(/\.[^.]*$/, "");
  const rootName = rootFolderName ?? eagleLeaf(stem);

  const eagleIds = new Set<string>();
  const usedPaths = new Set<string>();
  const usedIds = new Set<string>();
  const sources = new Set<string>();
  const images: PackageImage[] = [];
  const items: LibraryIndexItem[] = [];
  const unsupportedExts = new Set<string>();
  let unsupported = 0;
  let dropped = 0;

  for (const raw of pack.images) {
    if (!isObject(raw)) throw new Error("Eagle 包的 pack.json 里有结构不合法的图片记录");
    const eid = str(raw.id).trim();
    if (!eid || eid.includes("/") || eid.includes("\\") || eid === "." || eid === "..") {
      throw new Error("Eagle 包里有缺失或不合法的图片 ID");
    }
    if (eagleIds.has(eid.toLowerCase())) throw new Error(`Eagle 包里有重复的图片 ID：${eid}`);
    eagleIds.add(eid.toLowerCase());

    const ext = str(raw.ext);
    const name = str(raw.name);
    if (!/^[A-Za-z0-9]{1,16}$/.test(ext) || !isImage(`x.${ext}`)) {
      unsupported += 1;
      if (ext) unsupportedExts.add(ext.toLowerCase());
      continue;
    }

    // 原图：先找 `<id>.info/<name>.<ext>`，找不到再在 `<id>.info/` 里找唯一的同扩展名非缩略图文件
    const infoDir = `${root}${eid}.info/`.toLowerCase();
    let source = byLower.get(`${infoDir}${name}.${ext}`.toLowerCase());
    if (!source) {
      const candidates = files.filter((f) => {
        const p = f.path.toLowerCase();
        return p.startsWith(infoDir) && p.endsWith(`.${ext.toLowerCase()}`) && !p.includes("_thumbnail.");
      });
      if (candidates.length === 1) source = candidates[0];
    }
    if (!source) {
      dropped += 1;
      continue;
    }
    if (sources.has(source.path.toLowerCase())) {
      throw new Error(`Eagle 包里有多条记录指向同一张原图：${source.path}`);
    }
    sources.add(source.path.toLowerCase());
    const declaredSize = num(raw.size);
    if (declaredSize > 0 && source.entry.size !== declaredSize) {
      throw new Error(`Eagle 原图大小与 pack.json 不符：${name}.${ext}`);
    }

    // 目录：第一个已知文件夹；包根文件夹即图库根
    let folder = "";
    if (Array.isArray(raw.folders)) {
      for (const f of raw.folders) {
        const hit = folders.get(str(f));
        if (hit !== undefined) {
          folder = hit;
          break;
        }
      }
    }
    if (rootFolderName) {
      const lower = folder.toLowerCase();
      const prefix = rootFolderName.toLowerCase();
      if (lower === prefix) folder = "";
      else if (lower.startsWith(`${prefix}/`)) folder = folder.slice(prefix.length + 1);
    }
    const relPath = uniquePath(`${folder ? `${folder}/` : ""}${eagleLeaf(name)}.${ext}`, usedPaths);
    const id = allocateId(relPath, usedIds);

    const tags = Array.isArray(raw.tags)
      ? raw.tags
          .filter((t): t is string => typeof t === "string" && t.trim() !== "")
          .map((text) => ({ text, source: "manual" as const }))
      : [];
    const colors = Array.isArray(raw.palettes)
      ? raw.palettes.flatMap((p) => {
          if (!isObject(p) || !Array.isArray(p.color) || p.color.length < 3) return [];
          return [{
            hex: `#${hex2(p.color[0])}${hex2(p.color[1])}${hex2(p.color[2])}`,
            ratio: num(p.ratio) / 100,
            name: "",
          }];
        })
      : [];
    const annotation = str(raw.annotation);
    const url = str(raw.url);
    const extra: Record<string, unknown> = {};
    if (url.trim()) extra[SOURCE_URL_EXTRA_KEY] = url;
    const width = num(raw.width);
    const height = num(raw.height);
    const complete = annotation.trim() !== "" && tags.length > 0 && url.trim() !== "";

    items.push({
      id,
      relPath,
      // 落盘后由 finalizeImportedItem 换成实际文件时间；0 让「已识图」判定只看 visionAt
      mtime: 0,
      size: source.entry.size,
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
      meanLuma: null,
      meanSat: null,
      tone: null,
      hiColor: null,
      loColor: null,
      phash: null,
      colors,
      description: annotation,
      fields: {},
      extra,
      tags,
      note: "",
      starred: false,
      analyzedAt: null,
      pipelineVersion: 0,
      visionVersion: complete ? 1 : 0,
      visionAt: complete ? now : null,
      thumb: null,
    });
    images.push({ entry: source.entry, relPath });
  }
  if (images.length === 0) {
    throw new Error(
      unsupported > 0
        ? `Eagle 包里没有 YSTK 支持的图片（不支持的格式：${[...unsupportedExts].join("、")}）`
        : "Eagle 包里没有可导入的图片",
    );
  }

  // 不导入的文件：Eagle 内部文件（metadata.json、缩略图、未采用的 .info 内容）不计入提示；
  // 包根之外或与图片无关的文件计为非图片文件
  let ignored = 0;
  let internalSkipped = 0;
  for (const f of files) {
    if (f === packFile || sources.has(f.path.toLowerCase())) continue;
    const p = f.path.toLowerCase();
    if (p.startsWith(root.toLowerCase()) && /\.info\//.test(p.slice(root.length))) internalSkipped += 1;
    else ignored += 1;
  }

  return {
    layout: {
      format: "eagle",
      rootPrefix: root,
      rootName,
      indexEntry: packFile.entry,
      metaEntry: null,
      images,
      thumbs: new Map(),
      hasVectors: false,
      internalSkipped,
      ignored,
      unsupported,
      unsupportedExts: [...unsupportedExts].sort(),
    },
    plan: { items, thumbEntries: new Map(), thumbsUnused: 0, dropped, unindexed: 0 },
  };
}
