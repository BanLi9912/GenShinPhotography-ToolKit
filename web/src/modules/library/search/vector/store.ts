/**
 * M3.4.5 向量轨 · 内存向量存储 + .ystk/vectors.bin 持久化 + 增量嵌入循环。
 *
 * 职责（任务卡 R3/R4）：
 * - 内存 Map<id,{hash,vec}>；增量脏位用 docHash 比对（R4 零侵入：不埋写入点，
 *   hash 不一致即重嵌；孤儿条目在 sync 时清理）。
 * - vectors.bin 与 index.json 同目录（.ystk/），二进制、原子写（tmp + 改名，
 *   策略同 indexFile 落盘）；header 模型 ≠ 当前设置模型 → 整库视为失效全量重嵌。
 * - syncEmbeddings：向量模式 + Ollama 在线时触发；扫传入的 items（常规 =
 *   indexFile.listItems()，dev fixture 场景 = 注入的展示层条目）；批 24 条嵌入、
 *   写完一批更新内存+进度；单批失败 warn 并跳过、连续 3 批失败中止本轮并把指示灯置红；
 *   全部完成后 debounce 1s 落盘。并发=1，重入直接返回进行中 Promise。
 * - 只持久化「id ∈ 活动图库磁盘索引」的向量——dev fixture（n01…/mock_…）只进内存，
 *   绝不污染真实库的 vectors.bin。
 * - 查询向量缓存最近 8 条（LRU）：搜索装配先 ensureQueryVector 预热，score 同步点积。
 */
import { getEntry } from "../../index/binding";
import * as indexFile from "../../index/indexFile";
import type { LibraryIndexItem } from "../../index/indexFile";
import { useLibraryStore } from "../../store";
import { loadVisionGlobal } from "../../vision/settings";
import { buildDoc, docHash } from "./doc";
import { checkOllama, embedTexts } from "./ollama";

/** UI 指示灯订阅的最小快照（纯监听器，不引 React） */
export interface VectorStatus {
  engine: "dict" | "vector";
  ollamaOk: boolean;
  checking: boolean;
  syncing: boolean;
  error?: string;
  ollamaModel?: string;
  /** 索引计数（最近一次 sync 的条目宇宙）：embedded / total；dirty = total - embedded */
  embedded: number;
  total: number;
  dirty: number;
  dims?: number;
  /** 每次状态变化 +1（UI useSyncExternalStore 触发重渲染用） */
  version: number;
}

interface VectorEntry {
  hash: string;
  vec: Float32Array;
}

const BATCH = 24;
const QUERY_CACHE_MAX = 8;
const MAGIC = "YSTV";
const FILE_VERSION = 1;
const FILE_RECORD_NAME = "vectors.bin";

/* ---- 模块态 ---- */
let vectors = new Map<string, VectorEntry>(); // id → 向量（文件载入 + 本次嵌入）
let engine: "dict" | "vector" = "dict";
let ollamaOk = false;
let ollamaModel = "";
let checking = false;
let syncing = false;
let lastError: string | undefined;
let dims = 0;
/** 最近一次 sync 的条目宇宙（统计用） */
let universeIds: string[] = [];
let embeddedCount = 0;
/** 内存数据对应的模型："" = 未载入；文件缺失/损坏/换模型 → 空库全量重嵌 */
let loadedModel = "";
let lastLibraryId = "";
let version = 0;
const listeners = new Set<() => void>();
const queryCache = new Map<string, Float32Array>(); // query → 归一化向量（LRU）

/** 状态快照（每次 bump 重建；useSyncExternalStore 需要稳定引用，否则无限重渲染） */
let statusCache: VectorStatus = {
  engine,
  ollamaOk,
  checking,
  syncing,
  embedded: 0,
  total: 0,
  dirty: 0,
  version,
};

function buildStatusCache(): VectorStatus {
  return {
    engine,
    ollamaOk,
    checking,
    syncing,
    error: lastError,
    ollamaModel: ollamaModel || undefined,
    embedded: embeddedCount,
    total: universeIds.length,
    dirty: Math.max(0, universeIds.length - embeddedCount),
    dims: dims || undefined,
    version,
  };
}

function bump(): void {
  version += 1;
  statusCache = buildStatusCache();
  for (const fn of listeners) fn();
}

export function subscribeVectorStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 返回稳定引用快照（bump 时才换新对象） */
export function getVectorStatus(): VectorStatus {
  return statusCache;
}

export function getEngine(): "dict" | "vector" {
  return engine;
}

/* ---- 设置同步 ---- */

/** 最近一次 refreshSettings 看到的模型（换模型 → 内存/查询缓存失效，整库重嵌） */
let lastSettingsModel = "";

/** 读全局设置刷新 engine 快照并通知订阅方；模型变化 → 内存/查询缓存全失效 */
export async function refreshSettings(): Promise<void> {
  try {
    const g = await loadVisionGlobal();
    if (g.ollamaModel !== lastSettingsModel && lastSettingsModel !== "") {
      vectors = new Map();
      queryCache.clear();
      loadedModel = "";
      lastError = undefined;
      bump();
    }
    engine = g.searchEngine;
    lastSettingsModel = g.ollamaModel;
    bump();
  } catch {
    /* idb 读取失败维持现状 */
  }
}

/* ---- 查询向量缓存（R6.1：最近 8 条 LRU） ---- */

function cacheQueryVector(query: string, vec: Float32Array): void {
  queryCache.delete(query);
  queryCache.set(query, vec);
  while (queryCache.size > QUERY_CACHE_MAX) {
    const oldest = queryCache.keys().next().value;
    if (oldest === undefined) break;
    queryCache.delete(oldest);
  }
}

/** 为 query 取/预热向量：命中缓存立即 true；否则嵌入并缓存（幂等）。缓存键 = trim 后 query。 */
export async function ensureQueryVector(query: string): Promise<boolean> {
  const q = query.trim();
  if (!q) return false;
  if (queryCache.has(q)) return true;
  if (engine !== "vector" || !ollamaOk) return false;
  try {
    const g = await loadVisionGlobal();
    const vecs = await embedTexts(g.ollamaEndpoint, g.ollamaModel, [q]);
    if (!vecs[0]) return false;
    cacheQueryVector(q, vecs[0]);
    dims = vecs[0].length;
    bump();
    return true;
  } catch (err) {
    console.warn("[library] 查询向量嵌入失败", err);
    return false;
  }
}

/** 单条目语义分（rank.ts 每 item 调一次）：query 向量或条目向量缺失 → null（不参与向量轨） */
export function semanticScore(query: string, item: LibraryIndexItem): number | null {
  const qv = queryCache.get(query);
  if (!qv) return null;
  const entry = vectors.get(item.id);
  if (!entry) return null;
  // 两向量均在 embedTexts 内 L2 归一化，点积即余弦
  const n = Math.min(qv.length, entry.vec.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += qv[i] * entry.vec[i];
  return dot;
}

/* ---- .ystk/vectors.bin（二进制布局见任务卡 R3.2，全部小端） ---- */

function activeDirHandle(): FileSystemDirectoryHandle | null {
  const current = useLibraryStore.getState().current;
  if (!current?.libraryId) return null;
  const entry = getEntry(current.libraryId);
  return entry?.handle ?? null;
}

/** 8 位 ASCII（id/hash 均为 8 hex；短于 8 右侧补空格占位） */
function to8(v: string): Uint8Array {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i += 1) out[i] = (v.charCodeAt(i) || 0x20) & 0xff;
  return out;
}

function from8(u8: Uint8Array, start: number): string {
  let s = "";
  for (let i = 0; i < 8; i += 1) {
    const c = u8[start + i];
    if (c === 0x20 || c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

function encodeVectors(
  entries: Array<{ id: string; hash: string; vec: Float32Array }>,
  model: string,
): Blob {
  const modelBytes = new TextEncoder().encode(model);
  const dim = entries[0]?.vec.length ?? dims ?? 0;
  const headerSize = 4 + 2 + 2 + 4 + 1 + modelBytes.length;
  const recSize = 8 + 8 + dim * 4;
  const buf = new ArrayBuffer(headerSize + entries.length * recSize);
  const dv = new DataView(buf);
  let off = 0;
  for (let i = 0; i < 4; i += 1) dv.setUint8(off + i, MAGIC.charCodeAt(i));
  off += 4;
  dv.setUint16(off, FILE_VERSION, true); off += 2;
  dv.setUint16(off, dim, true); off += 2;
  dv.setUint32(off, entries.length, true); off += 4;
  dv.setUint8(off, modelBytes.length); off += 1;
  for (const b of modelBytes) { dv.setUint8(off, b); off += 1; }
  for (const { id, hash, vec } of entries) {
    const idb = to8(id);
    const hb = to8(hash);
    for (let i = 0; i < 8; i += 1) { dv.setUint8(off, idb[i]); off += 1; }
    for (let i = 0; i < 8; i += 1) { dv.setUint8(off, hb[i]); off += 1; }
    for (let i = 0; i < dim; i += 1) { dv.setFloat32(off, vec[i] ?? 0, true); off += 4; }
  }
  return new Blob([buf], { type: "application/octet-stream" });
}

/** 解析 vectors.bin；magic/版本/dims 不合法或 header 模型 ≠ 期望 → null（调用方 warn + 空库） */
async function decodeVectors(
  file: File,
  expectedModel: string,
): Promise<{ entries: Array<{ id: string; hash: string; vec: Float32Array }>; dim: number } | null> {
  try {
    const buf = await file.arrayBuffer();
    if (buf.byteLength < 13) return null;
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    let off = 0;
    for (let i = 0; i < 4; i += 1) {
      if (String.fromCharCode(dv.getUint8(off + i)) !== MAGIC[i]) return null;
    }
    off += 4;
    if (dv.getUint16(off, true) !== FILE_VERSION) return null;
    off += 2;
    const dim = dv.getUint16(off, true);
    off += 2;
    if (dim === 0) return null;
    const count = dv.getUint32(off, true);
    off += 4;
    const nameLen = dv.getUint8(off);
    off += 1;
    if (off + nameLen > buf.byteLength) return null;
    const model = new TextDecoder().decode(u8.subarray(off, off + nameLen));
    off += nameLen;
    if (model !== expectedModel) return null; // 换模型 → 整库失效
    const recSize = 8 + 8 + dim * 4;
    if (off + count * recSize > buf.byteLength) return null;
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const id = from8(u8, off); off += 8;
      const hash = from8(u8, off); off += 8;
      const vec = new Float32Array(dim);
      for (let d = 0; d < dim; d += 1) { vec[d] = dv.getFloat32(off, true); off += 4; }
      if (id) entries.push({ id, hash, vec });
    }
    return { entries, dim };
  } catch {
    return null;
  }
}

/** 读 .ystk/vectors.bin；不存在/只读失败 → null（不抛） */
async function readVectorsFile(): Promise<File | null> {
  const dir = activeDirHandle();
  if (!dir) return null;
  try {
    const ystk = await dir.getDirectoryHandle(".ystk");
    const fh = await ystk.getFileHandle(FILE_RECORD_NAME);
    return await fh.getFile();
  } catch {
    return null;
  }
}

/** 内存数据从磁盘载入（模型匹配才采纳）；载入后 loadedModel 置当前模型（无论成败，只试一次） */
async function loadFromDisk(model: string): Promise<void> {
  if (loadedModel === model) return;
  vectors = new Map();
  queryCache.clear();
  const file = await readVectorsFile();
  if (!file) {
    loadedModel = model;
    return;
  }
  const parsed = await decodeVectors(file, model);
  if (!parsed) {
    console.warn(`[library] vectors.bin 缺失/损坏/模型不匹配（${model}），按空库起步全量重嵌`);
  } else {
    vectors = new Map(parsed.entries.map((e) => [e.id, { hash: e.hash, vec: e.vec }]));
    dims = parsed.dim;
  }
  loadedModel = model;
  bump();
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistChain: Promise<void> = Promise.resolve();

/** 落盘（内部 debounce 1s + 串行链）：只写 id ∈ 活动图库磁盘索引 的条目 */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistChain = persistChain.then(() => persistNow()).catch(() => {});
  }, 1000);
}

async function persistNow(): Promise<void> {
  const dir = activeDirHandle();
  const model = loadedModel;
  if (!dir || !model) return;
  const diskIds = new Set(indexFile.listItems().map((i) => i.id));
  const entries: Array<{ id: string; hash: string; vec: Float32Array }> = [];
  for (const [id, entry] of vectors) {
    if (diskIds.has(id)) entries.push({ id, hash: entry.hash, vec: entry.vec });
  }
  try {
    const blob = encodeVectors(entries, model);
    const ystk = await dir.getDirectoryHandle(".ystk", { create: true });
    const tmp = await ystk.getFileHandle(`${FILE_RECORD_NAME}.tmp`, { create: true });
    const writable = await tmp.createWritable();
    await writable.write(blob);
    await writable.close();
    if (typeof tmp.move === "function") {
      try {
        await tmp.move(FILE_RECORD_NAME);
      } catch {
        const target = await ystk.getFileHandle(FILE_RECORD_NAME, { create: true });
        const tw = await target.createWritable();
        await tw.write(blob);
        await tw.close();
        try { await ystk.removeEntry(tmp.name); } catch { /* 忽略 */ }
      }
    } else {
      const target = await ystk.getFileHandle(FILE_RECORD_NAME, { create: true });
      const tw = await target.createWritable();
      await tw.write(blob);
      await tw.close();
      try { await ystk.removeEntry(tmp.name); } catch { /* 忽略 */ }
    }
  } catch (err) {
    console.warn("[library] vectors.bin 落盘失败（保留已有文件）", err);
  }
}

/** 强制落盘（页面隐藏/CDP 断言用）：取消未决防抖后立即写 */
export function flushVectors(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistChain = persistChain.then(() => persistNow()).catch(() => {});
  return persistChain;
}

/* ---- 增量嵌入循环（R3.4） ---- */

/** 统计 embedded/total（universeIds 中 hash 命中向量内存的条数） */
function recount(itemsById: Map<string, LibraryIndexItem>): void {
  let embedded = 0;
  for (const id of universeIds) {
    const item = itemsById.get(id);
    const entry = vectors.get(id);
    if (item && entry && entry.hash === docHash(item)) embedded += 1;
  }
  embeddedCount = embedded;
}

let syncRunning: Promise<void> | null = null;

/**
 * 增量嵌入循环：扫 items，docHash 与已存不一致/缺向量的进待嵌队列，批 24 条嵌入，
 * 写完一批更新内存 + 进度（bump 通知 UI）；全部完成后 debounce 1s 落盘。
 * 并发=1，重入直接返回进行中 Promise；嵌入期间搜索不阻塞（未嵌入条目语义分 = null）。
 */
export function syncEmbeddings(items: LibraryIndexItem[]): Promise<void> {
  if (syncRunning) return syncRunning;
  syncRunning = (async () => {
    try {
      await refreshSettings();
      const g = await loadVisionGlobal();
      if (engine !== "vector") {
        bump();
        return;
      }
      // 自检（红→绿 由调用方负责触发 sync；这里幂等再查一次）
      checking = true;
      bump();
      const check = await checkOllama(g.ollamaEndpoint, g.ollamaModel);
      checking = false;
      ollamaOk = check.ok;
      ollamaModel = check.ok ? (check.modelName ?? g.ollamaModel) : "";
      if (!check.ok) {
        lastError = check.error;
        syncing = false;
        bump();
        return;
      }
      lastError = undefined;
      syncing = true;
      bump();
      await loadFromDisk(g.ollamaModel);

      // 换库守卫：lastLibraryId 变化 → 内存重读（空库则全量重嵌）
      const libraryId = useLibraryStore.getState().current?.libraryId ?? "";
      if (libraryId !== lastLibraryId) {
        loadedModel = "";
        await loadFromDisk(g.ollamaModel);
        lastLibraryId = libraryId;
      }

      // 统计宇宙：buildDoc 非空条目
      const itemsById = new Map(items.map((i) => [i.id, i]));
      universeIds = items.filter((it) => buildDoc(it).trim().length > 0).map((it) => it.id);
      recount(itemsById);

      // 孤儿清理（R4 优先后者：内存有而 items/磁盘索引均无 → 删）
      const itemIds = new Set(items.map((i) => i.id));
      const diskIds = new Set(indexFile.listItems().map((i) => i.id));
      for (const id of [...vectors.keys()]) {
        if (!itemIds.has(id) && !diskIds.has(id)) vectors.delete(id);
      }

      // 待嵌队列
      const queue: Array<{ item: LibraryIndexItem }> = [];
      for (const item of items) {
        if (!buildDoc(item).trim()) continue;
        const hash = docHash(item);
        const existing = vectors.get(item.id);
        if (!existing || existing.hash !== hash) queue.push({ item });
      }

      // 分批嵌入
      let failStreak = 0;
      for (let i = 0; i < queue.length; i += BATCH) {
        if (failStreak >= 3) {
          lastError = `连续 ${failStreak} 批嵌入失败，本轮中止`;
          console.warn(`[library] 连续 ${failStreak} 批嵌入失败，中止本轮 sync`);
          syncing = false;
          ollamaOk = false;
          bump();
          return;
        }
        const chunk = queue.slice(i, i + BATCH);
        try {
          const docs = chunk.map((c) => buildDoc(c.item));
          const vecs = await embedTexts(g.ollamaEndpoint, g.ollamaModel, docs);
          chunk.forEach((c, k) => {
            if (vecs[k]) {
              vectors.set(c.item.id, { hash: docHash(c.item), vec: vecs[k] });
              dims = vecs[k].length;
            }
          });
          failStreak = 0;
        } catch (err) {
          failStreak += 1;
          console.warn(`[library] 批 ${Math.floor(i / BATCH) + 1} 嵌入失败，跳过该批（${err instanceof Error ? err.message : String(err)}）`);
        }
        recount(itemsById);
        bump(); // 每批更新进度（黄「索引中…」期间嵌入式计数逐步上升）
      }

      syncing = false;
      ollamaOk = true;
      recount(itemsById);
      bump();
      schedulePersist();
    } catch (err) {
      console.warn("[library] syncEmbeddings 异常", err);
      syncing = false;
      ollamaOk = false;
      lastError = err instanceof Error ? err.message : String(err);
      bump();
    } finally {
      syncRunning = null;
    }
  })();
  return syncRunning;
}

/** 单次自检（库页 30s 定时 / 搜索框聚焦时调用），红→绿后由调用方触发 sync */
export async function selfCheckOllama(): Promise<void> {
  await refreshSettings();
  const g = await loadVisionGlobal();
  checking = true;
  bump();
  const check = await checkOllama(g.ollamaEndpoint, g.ollamaModel);
  checking = false;
  ollamaOk = check.ok;
  ollamaModel = check.ok ? (check.modelName ?? g.ollamaModel) : "";
  lastError = check.ok ? undefined : check.error;
  bump();
}

/** 查询向量是否已缓存（同步判断；向量轨装配只在缓存命中时启用，避免 NL 轨被误停） */
export function hasQueryVector(query: string): boolean {
  return queryCache.has(query.trim());
}

/** 语义计分器（rank.ts 第三参）：query/条目向量任一缺失返回 null（该条不参与向量轨） */
export const semanticScorer = {
  score(query: string, item: LibraryIndexItem): number | null {
    return semanticScore(query.trim(), item);
  },
};

/**
 * 当前搜索装配下的语义计分器：引擎=向量 且 Ollama 在线 且 query 向量已缓存才返回
 * （词典模式 / 离线 / 向量未就绪一律 undefined——保证词典模式行为与现状逐字节一致，
 * 且不因语义轨未就绪而误停 NL 轨）。
 */
export function semanticFor(query: string): { score(query: string, item: LibraryIndexItem): number | null } | undefined {
  if (engine !== "vector" || !ollamaOk) return undefined;
  if (!queryCache.has(query.trim())) return undefined;
  return semanticScorer;
}

/** 图库切换/卸载时由调用方调用：内存向量与查询缓存清空（数据随库，避免串库） */
export function onLibraryChanged(): void {
  vectors = new Map();
  queryCache.clear();
  loadedModel = "";
  universeIds = [];
  embeddedCount = 0;
  lastLibraryId = "";
  bump();
}

/* ---- best-effort 落盘（页面隐藏/关闭，参照 indexFile 策略） ---- */
let hideBound = false;
function bindHideFlush(): void {
  if (hideBound || typeof document === "undefined") return;
  hideBound = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushVectors();
  });
  window.addEventListener("pagehide", () => {
    void flushVectors();
  });
}
bindHideFlush();
