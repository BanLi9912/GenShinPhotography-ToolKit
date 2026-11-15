/**
 * 任务 M3.1 · `.ystk/meta.json` + `.ystk/index.json` 读写层。
 * schema 与写入策略按《2026-08-07-M3落地细节规划.md》§3 M3.1 钉死逐字落地。
 *
 * 写入策略（6 条，钉死）：
 * 1. 索引加载后全量驻留内存 Map<id, LibraryIndexItem>，所有读写走内存副本；
 * 2. 任何变更只改内存并标记 dirty；
 * 3. dirty 后 debounce 1000ms 合并落盘，整文件原子写（fsa.writeFileAtomic，
 *    tmp + move，move 缺失降级覆盖写）；落盘串行化对齐 canvas/persistence.ts；
 * 4. 扫描/批量进行中每 100 条变更兜底落盘一次（变更计数器到 100 立即触发并清零）；
 * 5. flush() 供切换图库/页面卸载强制调用；visibilitychange(hidden) 与
 *    beforeunload 做 best-effort flush（unload 阶段不承诺必达）；
 * 6. 不另设压实/分片流程（原子重写本身即压实）；
 * 7. 2026-09-17 数据丢失修复增补三条：**读失败防御**（激活时 index.json 读失败
 *    一律中止打开，绝不让空 Map 上线覆盖磁盘）；**外部变更哨兵**（激活后文件被
 *    外部改动则保存前发现即中止本次保存并提示刷新，保住用户的备份恢复流程）；
 *    **保存串行锁**（超时只结束等待，不放开写锁；成功后按变更版本确认快照）。
 */

import {
  readFileBlob,
  readJsonFile,
  readJsonFileEx,
  writeFileAtomic,
} from "../../../core/storage/fsa";
import { dismissToast, persistentToast } from "../../../ui/toast";
import type { RgbHex } from "../../../core/imaging/stats";

declare global {
  interface Window {
    /** 验收调试用：返回累计原子写次数（每次实际写盘 +1） */
    __ystkLibraryWriteCount: () => number;
    /** 验收调试用（仅 dev）：写合并测试的模块内钩子，避免控制台动态 import 产生新实例 */
    __ystkLibraryTest?: {
      createItem: (relPath: string, mtime: number, size: number) => LibraryIndexItem;
      upsertItem: (item: LibraryIndexItem) => void;
      getItemCount: () => number;
      getWriteCount: () => number;
      flush: () => Promise<void>;
    };
  }
}

/* ---- schema（规划 §3 M3.1 jsonc 逐字段；后续卡只加 key、不改已有 key） ---- */

/** 图库级设置（规划 D6）：M3.1 只落默认值，设置面板 M3.5 才做 */
export interface LibrarySettings {
  compression: "auto" | "high" | "original";
  presetId: string;
  /** 内置字段开关 + 用户自定义字段（M3.5 回填） */
  fieldConfig: Record<string, unknown>;
  /** 提示词开头覆盖（角色设定/观察流程，2026-09-26）；trim 后为空 = 用默认 TEMPLATE_HEAD */
  promptHead?: string;
  /** 提示词结尾覆盖（质量要求/示例/格式规则，2026-09-26）；trim 后为空 = 用默认 TEMPLATE_TAIL */
  promptTail?: string;
}

export interface LibraryMeta {
  schemaVersion: 1;
  libraryId: string;
  createdAt: number;
  updatedAt: number;
  stats: { files: number; analyzed: number };
  settings: LibrarySettings;
}

/** 自动/手动 tag（M3.3 起写回；本卡恒 []） */
export interface LibraryTag {
  text: string;
  source: "manual" | "auto";
  confidence?: number;
}

export interface LibraryIndexItem {
  id: string;
  relPath: string;
  mtime: number;
  size: number;
  width: number | null;
  height: number | null;
  meanLuma: number | null;
  meanSat: number | null;
  tone: "low" | "mid" | "high" | null;
  hiColor: RgbHex | null;
  loColor: RgbHex | null;
  phash: string | null;
  colors: Array<{ hex: string; ratio: number; name?: string }>;
  description: string;
  /** M3.5 语义字段：subject/scene/lighting/angle/color_mood/mood_style/content_type */
  fields: Record<string, unknown>;
  /** 用户自定义字段（M3.5） */
  extra: Record<string, unknown>;
  tags: LibraryTag[];
  note: string;
  starred: boolean;
  analyzedAt: number | null;
  /** 分析管线版本：-1 = 跳过标记（解码失败），0 = 未分析，≥1 = 已按对应版本分析 */
  pipelineVersion: number;
  /** M3.5 云端识图：完成时间 ms；undefined/null = 未识图 */
  visionAt?: number | null;
  /** M3.5 识图版本：0/undefined = 未跑，≥1 = 成功版本，-1 = 跳过标记（语义对齐 pipelineVersion） */
  visionVersion?: number;
  thumb: string | null;
}

/** 建 meta 默认值（settings 默认值照抄规划：compression auto / presetId photography / fieldConfig {}） */
export function createDefaultMeta(libraryId: string): LibraryMeta {
  const now = Date.now();
  return {
    schemaVersion: 1,
    libraryId,
    createdAt: now,
    updatedAt: now,
    stats: { files: 0, analyzed: 0 },
    settings: {
      compression: "auto",
      presetId: "photography",
      fieldConfig: {},
    },
  };
}

/* ---- FNV-1a（32 位，手写不引库） ---- */

/**
 * fnv1a(text) 8 位 hex。
 * - 条目 id：fnv1a(relPath)（碰撞由 makeItem 追加 "#2"/"#3" 兜底）；
 * - 向量轨文档 hash（M3.4.5 doc.ts docHash 复用本函数，不抄第二份实现）。
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/* ---- 活动图库内存态（一次只驻留一个图库） ---- */

let activeDir: FileSystemDirectoryHandle | null = null;
let activeMeta: LibraryMeta | null = null;
let indexMap: Map<string, LibraryIndexItem> | null = null;
/** 活动图库代次：activate/deactivate 时 +1，scan.ts 用它防跨库误写 */
let generation = 0;
/**
 * 外部变更哨兵（F2）：激活/上次保存时 index.json 的 stat 快照，与 activeDir 同生命周期。
 * 保存前重新 stat 与之比对，不符即说明文件被外部改写（恢复备份/他处编辑），中止本次保存。
 * null = 无哨兵（新图库首次写之前），守卫不生效。
 */
let indexSentinel: { size: number; lastModified: number } | null = null;
/** 哨兵触发提示只弹首次，防连环保存刷屏（F2） */
let sentinelToastShown = false;
/** 变更版本：只确认本次快照；写盘期间的新编辑仍保持 dirty。 */
let revision = 0;

/** 取 index.json 的 stat 快照（F2 哨兵用）；文件不存在返回 null，其余异常上抛由调用方判定 */
async function statIndexFile(
  dir: FileSystemDirectoryHandle,
): Promise<{ size: number; lastModified: number } | null> {
  try {
    // 逐段下钻（OPFS 不接受 "a/b" 形式的文件名，必须拿目录句柄再取文件）
    const ystk = await dir.getDirectoryHandle(".ystk");
    const file = await (await ystk.getFileHandle("index.json")).getFile();
    return { size: file.size, lastModified: file.lastModified };
  } catch (err) {
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}

/* ---- 落盘状态（写入策略） ---- */

let dirty = false;
/** 自上次落盘以来的内存变更条数（每 100 条兜底落盘） */
let changeCount = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveChain: Promise<void> = Promise.resolve();
let savePending = false;
let retryCount = 0;
let saveBlocked = false;
const RETRY_DELAYS = [2000, 5000, 10000];
const SAVE_TOAST = "library-save";
/** 实际原子写次数（index + meta 各计一次；供验收 console 断言） */
let writeCount = 0;
let bestEffortBound = false;

/**
 * 15s 只结束调用方等待，不放开磁盘写锁；旧写真正结束前不启动另一轮。
 * 成功/失败均清理超时定时器，失败保留 dirty；禁止带未保存内容切库。
 */
const SAVE_TIMEOUT_MS = 15_000;

function enqueueSave(): void {
  if (savePending || saveBlocked || !dirty) return;
  savePending = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    let failed = false;
    try {
      await save();
      retryCount = 0;
    } catch (err) {
      failed = true;
      console.error("[library] 索引落盘失败", err);
      persistentToast(SAVE_TOAST, "图库尚未保存成功，内容仍在内存中，请勿关闭页面。", {
        label: "重试保存",
        run: () => {
          retryCount = 0;
          persistentToast(SAVE_TOAST, "正在重试保存图库，请勿关闭页面…");
          void flush();
        },
      });
    } finally {
      clearTimeout(timeout);
      savePending = false;
      if (dirty && !saveBlocked) {
        if (!failed) scheduleSave();
        else if (retryCount < RETRY_DELAYS.length) scheduleSave(RETRY_DELAYS[retryCount++]);
      }
    }
  })();
  saveChain = Promise.race([
    operation,
    new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        console.error("[library] 索引落盘超时（>15s），仍在等待磁盘写入，未启动并发保存");
        persistentToast(SAVE_TOAST, "图库保存耗时较长，仍在等待磁盘。请勿关闭页面或切换图库。");
        resolve();
      }, SAVE_TIMEOUT_MS);
    }),
  ]);
}

function scheduleSave(delay = 1000): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    enqueueSave();
  }, delay);
}

/** 变更登记：标记 dirty + 防抖 + 每 100 条兜底落盘（写入策略 2/3/4） */
function markChanged(): void {
  changeCount += 1;
  revision += 1;
  dirty = true;
  if (!saveTimer && !savePending && !saveBlocked) scheduleSave();
  if (changeCount >= 100) void flush();
}

async function save(): Promise<void> {
  if (!activeDir || !indexMap || !activeMeta) return;
  const dir = activeDir;
  const savedRevision = revision;
  changeCount = 0;
  const items = [...indexMap.values()];
  activeMeta.stats.files = items.length;
  activeMeta.stats.analyzed = items.filter(
    (item) =>
      typeof item.pipelineVersion === "number" && item.pipelineVersion >= 1,
  ).length;
  activeMeta.updatedAt = Date.now();
  // 同一时刻捕获 index/meta，await 期间的编辑交下一轮保存。
  const indexText = JSON.stringify(items, null, 2);
  const metaText = JSON.stringify(activeMeta, null, 2);

  // F2 外部变更哨兵：写前 stat 与哨兵比对，不符即中止本次保存（index 与 meta 都不写），
  // 否则会把用户刚恢复的备份整份覆盖回内存旧态（RC2）。stat 自身失败按"无法判定"
  // 处理——跳过守卫照常保存（宁可冒险也不让守卫故障堵死正常保存）。
  try {
    const current = await statIndexFile(dir);
    if (indexSentinel !== null && current !== null) {
      const changed =
        current.size !== indexSentinel.size ||
        current.lastModified !== indexSentinel.lastModified;
      if (changed) {
        saveBlocked = true;
        console.error(
          "[library] index.json 已在外部被修改，已暂停索引保存以防覆盖（一致恢复：刷新可载入恢复内容；不一致的孤儿条目会被扫描清理）",
          { sentinel: indexSentinel, current },
        );
        if (!sentinelToastShown) {
          sentinelToastShown = true;
          // 尾句口径（A 2026-09-17 裁定，PR-013 选 C）：刷新只对"一致恢复"有效——
          // 备份里引用、而图库文件夹当下没有的条目会被打开时的扫描按"消失"清掉，
          // 故必须把"需同一时期"说清楚，不能让用户以为刷新万能。
          persistentToast(SAVE_TOAST,
            "检测到索引文件被外部修改，已暂停保存。若你刚恢复备份，请刷新页面载入恢复内容（备份需与图库文件夹为同一时期，不一致的条目会被扫描清理）",
          );
        }
        return;
      }
    }
  } catch (err) {
    console.warn("[library] 索引外部变更哨兵读取失败，跳过本次守卫照常保存", err);
  }

  await writeFileAtomic(dir, ".ystk/index.json", indexText);
  writeCount += 1;
  // 自己写的变更要被哨兵认账：写成功后重取 stat 更新哨兵
  try {
    indexSentinel = await statIndexFile(dir);
  } catch (err) {
    console.warn("[library] 索引外部变更哨兵更新失败，下次保存跳过守卫", err);
    indexSentinel = null;
  }

  await writeFileAtomic(dir, ".ystk/meta.json", metaText);
  writeCount += 1;
  dirty = revision !== savedRevision;
  if (!dirty) dismissToast(SAVE_TOAST);
}

/**
 * 强制落盘（写入策略 5）：取消未决防抖后立即写；调用方可 await 等待完成。
 * 页面隐藏/关闭的 best-effort 监听在 activateLibrary 内注册一次。
 */
export function flush(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirty) enqueueSave();
  return saveChain;
}

/** 生成条目 id（fnv1a(relPath)；与内存已有 id 碰撞时追加 "#2" 兜底） */
function makeId(relPath: string): string {
  let id = fnv1a(relPath);
  let n = 2;
  while (indexMap?.has(id) ?? false) {
    id = fnv1a(`${relPath}#${n}`);
    n += 1;
  }
  return id;
}

/** 新建条目：本卡只填 id/relPath/mtime/size，其余一律 null/空/0（规划 schema） */
export function createItem(
  relPath: string,
  mtime: number,
  size: number,
): LibraryIndexItem {
  return {
    id: makeId(relPath),
    relPath,
    mtime,
    size,
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

/** 当前活动图库代次（scan.ts 跨库守卫用） */
export function currentGeneration(): number {
  return generation;
}

/**
 * 载入图库到内存（打开/切换时调用）：读 meta + index，全量驻留 Map。
 * meta 缺失/损坏按未初始化处理（内存造默认值，与磁盘原值不同才标 dirty）；
 * **index 读失败（F1）直接抛错中止打开**，绝不拿空 Map 上线覆盖磁盘。
 */
export async function activateLibrary(
  dir: FileSystemDirectoryHandle,
  libraryId: string,
): Promise<void> {
  await deactivateLibrary();
  activeDir = dir;
  generation += 1;
  sentinelToastShown = false; // 新一次激活重新允许弹首次提示（F2）

  // F1：先取 meta（宽松读，默认值兜底）+ index（严格读），两者都读完才提交模块态。
  // index 读失败必须抛错中止——若把"读不到"当"没有"，空 Map 会上线并 dirty，
  // 1s 后全量覆盖写把磁盘上的识图信息清空（2026-09-17 丢失根因 RC1）。
  const meta = await readJsonFile<LibraryMeta>(dir, ".ystk/meta.json");
  const rawIndex = await readJsonFileEx<LibraryIndexItem[]>(dir, ".ystk/index.json");
  if (rawIndex.status === "error") {
    activeDir = null;
    generation += 1;
    throw new Error(
      `索引文件读取失败，已中止打开以防止覆盖（原因：${String(rawIndex.error)}）。若刚恢复备份请直接重试；反复失败请检查磁盘`,
    );
  }

  const nextMeta =
    meta && typeof meta.libraryId === "string"
      ? { ...createDefaultMeta(meta.libraryId), ...meta }
      : createDefaultMeta(libraryId);
  activeMeta = nextMeta;

  // F2 脏标记收紧：meta 归一化结果与磁盘原值深比对，有差异才 dirty。
  // 原为无条件 dirty=true（注释"重写一次无害"）——该假设已被 RC2 证伪：
  // 激活即重写会把用户激活前刚恢复的 index.json 覆盖回内存旧态。
  const metaChanged =
    meta === null || JSON.stringify(nextMeta) !== JSON.stringify(meta);
  if (metaChanged) markChanged();

  const rawItems = rawIndex.status === "ok" ? rawIndex.value : [];
  indexMap = new Map();
  for (const item of rawItems ?? []) {
    if (item && typeof item.id === "string" && typeof item.relPath === "string") {
      indexMap.set(item.id, item);
    }
  }
  if (rawIndex.status === "missing") {
    dirty = true; // 新图库：无索引文件，首次落盘补写
  } else {
    // F2 哨兵：记录激活时读到的 index.json 快照（missing 时为 null，首写后建立）
    try {
      indexSentinel = await statIndexFile(dir);
    } catch (err) {
      console.warn("[library] 索引外部变更哨兵建立失败，本次激活跳过守卫", err);
      indexSentinel = null;
    }
  }

  if (!bestEffortBound) {
    bestEffortBound = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flush();
    });
    window.addEventListener("pagehide", () => {
      // best-effort：unload 阶段异步写可能被打断，不承诺必达
      void flush();
    });
  }
}

/** 卸载图库：先落盘再清内存（切换/页面卸载时由调用方保证顺序） */
export async function deactivateLibrary(): Promise<void> {
  await flush();
  if (hasPendingSave()) {
    throw new Error("当前图库尚未保存成功，已取消切换或解绑。请先处理保存提示，避免丢失修改。");
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  activeDir = null;
  activeMeta = null;
  indexMap = null;
  indexSentinel = null;
  saveBlocked = false;
  retryCount = 0;
  generation += 1;
}

/** 失败时保留的活动图库不能通过重新激活从磁盘覆盖。 */
export function hasPendingSave(): boolean {
  return dirty || savePending;
}

export function listItems(): LibraryIndexItem[] {
  return indexMap ? [...indexMap.values()] : [];
}

/**
 * 只读读取指定图库的 index.json（跨图库搜索专用）：不触碰内存 Map / 代次 /
 * dirty / 写计数。文件缺失/解析失败/非数组均返回 []。
 */
export async function peekItems(
  handle: FileSystemDirectoryHandle,
): Promise<LibraryIndexItem[]> {
  try {
    const file = await readFileBlob(handle, ".ystk/index.json");
    if (!file) return [];
    const parsed: unknown = JSON.parse(await file.text());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is LibraryIndexItem =>
        !!x && typeof x.id === "string" && typeof x.relPath === "string",
    );
  } catch {
    return [];
  }
}

export function getItem(id: string): LibraryIndexItem | undefined {
  return indexMap?.get(id);
}

export function getItemCount(): number {
  return indexMap?.size ?? 0;
}

/** 读当前图库设置（M3.5）：未激活图库时返回 createDefaultMeta 的默认 settings 副本 */
export function getSettings(): LibrarySettings {
  const settings = activeMeta
    ? activeMeta.settings
    : createDefaultMeta("").settings;
  return { ...settings };
}

/** 改当前图库设置（M3.5）：浅合并进 activeMeta.settings，标 dirty 走既有 debounce 落盘 */
export function updateSettings(patch: Partial<LibrarySettings>): void {
  if (!activeMeta) return;
  activeMeta.settings = { ...activeMeta.settings, ...patch };
  markChanged();
}

/** 新增或整条替换（写内存 + 登记变更） */
export function upsertItem(item: LibraryIndexItem): void {
  indexMap?.set(item.id, item);
  markChanged();
}

/** 局部更新（后续卡回填分析字段时复用；不改 id/relPath 结构） */
export function updateItem(
  id: string,
  patch: Partial<Omit<LibraryIndexItem, "id">>,
): void {
  const map = indexMap;
  if (!map) return;
  const item = map.get(id);
  if (!item) return;
  map.set(id, { ...item, ...patch });
  markChanged();
}

/** 删除条目（扫描消失/解绑时） */
export function removeItem(id: string): void {
  if (!indexMap?.delete(id)) return;
  markChanged();
}

/** 验收调试：当前会话累计原子写次数 */
export function getWriteCount(): number {
  return writeCount;
}

window.__ystkLibraryWriteCount = () => writeCount;

if (import.meta.env.DEV) {
  window.__ystkLibraryTest = {
    createItem,
    upsertItem,
    getItemCount,
    getWriteCount,
    flush,
  };
}
