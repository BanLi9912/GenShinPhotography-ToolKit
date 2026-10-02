/**
 * 任务 M3.1 · M3 参考图库 zustand store。
 * 图库注册表/当前图库/绑定与扫描状态/扫描进度；持久化编排在
 * index/（binding / indexFile / scan），本文件只做状态与流程接线。
 * M3.3.1 多选模式：selectMode 独立开关，退出模式必清选择集。
 */

import { create } from "zustand";
import { ensurePermission, isFsaSupported } from "../../core/storage/fsa";
import { toast } from "../../ui/toast";
import * as binding from "./index/binding";
import * as indexFile from "./index/indexFile";
import { startScan, type ScanProgress } from "./index/scan";
import { makeThumb } from "./pipeline/thumbs";
import {
  runAnalysisQueue,
  type AnalysisProgress,
  type AnalysisStage,
} from "./pipeline/queue";
import { writeRotatedFile } from "./rotate";
import type { AnalysisPatch } from "./pipeline/basicAnalysis";
import type { LibraryIndexItem, LibraryTag } from "./index/indexFile";
import type { LibraryRegistryEntry, LibrarySummary } from "./index/binding";
import type { ColorFilter, SearchHit } from "./search/rank";
import {
  abortVisionRun,
  dequeueVisionItem,
  enqueueVisionItems,
  isVisionPending,
  runVisionQueue,
} from "./vision/queue";
import { VISION_VERSION } from "./vision/analyze";
import type {
  VisionQueueCost,
  VisionQueueError,
  VisionQueueProgress,
  VisionTask,
} from "./vision/queue";
import { loadVisionGlobal } from "./vision/settings";

export type Warmth = "warm" | "cool" | "neutral";
export type Tone = "low" | "mid" | "high";

/** 批量识图确认请求（BatchPanel 快照后转交识图面板；确认/取消后置 null） */
export interface VisionBatchRequest {
  /** 请求时选中的条目 id 快照（退出多选后仍可引用） */
  ids: string[];
  /** 其中待识图（isVisionPending）条数，确认区展示用 */
  pendingCount: number;
  /** 请求时间戳（防串用） */
  at: number;
}

export type LibraryPhase =
  | "idle"
  | "unsupported"
  | "unbound"
  | "need-permission"
  | "binding"
  | "scanning"
  | "ready"
  | "missing";

export interface ScanState {
  total: number;
  done: number;
  perSecond: number;
  paused: boolean;
  running: boolean;
}

export interface AnalysisState {
  /** 分析阶段（M3.2.1 两阶段）：thumbs = Pass A 缩略图先行，stats = Pass B 统计 */
  stage: AnalysisStage;
  total: number;
  done: number;
  perSecond: number;
  etaSeconds: number | null;
  paused: boolean;
  running: boolean;
  failed: number;
}

export type SortKey = "mtime" | "name" | "luma" | "sat";
export type SortDir = "asc" | "desc";

/**
 * 瀑布流浏览位置快照（M3.6）：一次滚动瞬间的一组同源值。
 * - `scrollTop`：`.lib-page` 的滚动像素（没有可用锚点时的兜底）；
 * - `sig`：展示集签名（条目数 + 首尾 id），换库/换筛选/换排序后不还原；
 * - `anchorId` / `anchorTop`：视口顶部那张图的 id 与其顶边相对容器顶边的偏移。
 *   还原以锚点为准——网格上方元素高度变化（工具栏读数行、筛选条、命中数）时，
 *   纯像素会落错内容，锚点则能把同一张图摆回同一视觉位置（LibraryPage 还原时校正）。
 */
export interface BrowsePos {
  scrollTop: number;
  sig: string;
  anchorId: string;
  anchorTop: number;
}

/**
 * 排序（M3.3）：mtime 按时间、name 按 relPath、luma/sat 按分析值；
 * null 值一律排最后（与升降序无关）；不 mutate 入参。
 */
export function sortItems(
  items: LibraryIndexItem[],
  sortKey: SortKey,
  sortDir: SortDir,
): LibraryIndexItem[] {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    const av =
      sortKey === "mtime"
        ? a.mtime
        : sortKey === "name"
          ? a.relPath
          : sortKey === "luma"
            ? a.meanLuma
            : a.meanSat;
    const bv =
      sortKey === "mtime"
        ? b.mtime
        : sortKey === "name"
          ? b.relPath
          : sortKey === "luma"
            ? b.meanLuma
            : b.meanSat;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (sortKey === "name") return (av as string).localeCompare(bv as string) * dir;
    return ((av as number) - (bv as number)) * dir;
  });
}

/**
 * M3.5.3.6 重试失败项清单（当前仅「全库」范围）：任务帧非空 → 帧内 failed 任务 id
 * （帧序）＋ 帧外全部 visionVersion===-1 条目 id（图库序）；帧失（刷新后）→ 全库 -1
 * 条目 id。`countRetryVisionFailed` 与 `retryVisionFailed` 都吃本清单，计数与
 * 实际重试项永远一致（此前计数与执行各写一遍遍历，是漂移隐患）。
 */
export function retryVisionFailedIds(): string[] {
  const vision = useLibraryStore.getState().vision;
  if (vision.tasks.length > 0) {
    const frameIds = new Set(vision.tasks.map((t) => t.id));
    const inFrame = vision.tasks
      .filter((t) => t.status === "failed")
      .map((t) => t.id);
    const outside = indexFile
      .listItems()
      .filter((i) => (i.visionVersion ?? 0) === -1 && !frameIds.has(i.id))
      .map((i) => i.id);
    return [...inFrame, ...outside];
  }
  return indexFile
    .listItems()
    .filter((i) => (i.visionVersion ?? 0) === -1)
    .map((i) => i.id);
}

/**
 * M3.5.3.4 重试失败项范围计数（当前仅「全库」范围，UI confirm 用，与 retryVisionFailed
 * 执行口径一致）：清单见 `retryVisionFailedIds`（M3.5.3.6 起两者同源），本函数只取长度。
 */
export function countRetryVisionFailed(): number {
  return retryVisionFailedIds().length;
}

/**
 * 待识图确认口径拆分（2026-09-03 用户反馈）：图库待处理分两类——
 * pending = 可自动识图数（未识图/版本旧/文件已修改；不含 -1——失败项只经
 * 「重试失败项」手动跑，不随「开始识图」自动跑，防自动重跑死循环）；
 * failed = 识图失败跳过数（visionVersion === -1）。
 * 判据与队列内部非 resume 构建的 pending 过滤一致（queue.ts），供两处使用：
 * ①「存在待识图」是否弹确认的判定（只认 pending>0，否则确认后空跑落到
 * 「没有待识图的条目」提示——2026-09-03 现象）；②确认文案分列
 * 「几个未识图 / 几个失败」。入参数组由调用方喂（store 判定用 indexFile，
 * 展示层用 store.items），避免两套口径漂移。
 */
export function countVisionTodoOf(
  items: readonly LibraryIndexItem[],
): { pending: number; failed: number } {
  const ids = visionTodoIdsOf(items);
  return { pending: ids.pending.length, failed: ids.failed.length };
}

/**
 * M3.5.3.6 待识图确认清单（与 `countVisionTodoOf` 同源，供小窗确认视图逐行列出）：
 * pending = 可自动识图项 id（未识图/版本旧/文件已修改，不含 -1），
 * failed = 识图失败跳过项 id（visionVersion === -1）。
 * 计数与清单必须是同一次遍历的产物——否则「待确认 N 张」与列出的行数会对不上。
 */
export function visionTodoIdsOf(items: readonly LibraryIndexItem[]): {
  pending: string[];
  failed: string[];
} {
  const pending: string[] = [];
  const failed: string[] = [];
  for (const it of items) {
    if ((it.visionVersion ?? 0) === -1) {
      failed.push(it.id);
    } else if (
      (it.visionVersion ?? 0) < VISION_VERSION ||
      (it.visionAt ?? 0) < it.mtime
    ) {
      pending.push(it.id);
    }
  }
  return { pending, failed };
}

const IDLE_SCAN: ScanState = {
  total: 0,
  done: 0,
  perSecond: 0,
  paused: false,
  running: false,
};

const IDLE_ANALYSIS: AnalysisState = {
  stage: "thumbs",
  total: 0,
  done: 0,
  perSecond: 0,
  etaSeconds: null,
  paused: false,
  running: false,
  failed: 0,
};

const IDLE_VISION: VisionQueueProgress & { blockedReason: string | null } = {
  total: 0,
  done: 0,
  failed: 0,
  running: false,
  cost: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, amount: 0 },
  tasks: [],
  errors: [],
  blockedReason: null,
  abortReason: null, // M3.5.3.4 中止原因（内存态，不进 schema；新一轮启动复位）
};

/** 跨图库搜索偏好（PR-007：用户偏好持久化；key 前缀对齐 ystk-lib-search-history） */
const CROSS_SEARCH_KEY = "ystk-lib-cross-search";

/** 读取跨图库搜索偏好（隐私模式/配额满时静默回落到关闭） */
function readCrossPref(): boolean {
  try {
    return localStorage.getItem(CROSS_SEARCH_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * PR-007：跨库搜索结果内存态（CrossResults 计算写入，CrossHint/CrossResults/命中数行共读；不持久化）。
 * 之所以提升到 store：命中数行在当前库网格**上方**、结果块在**下方**，两处需要同一份数据。
 */
export interface CrossGroup {
  libraryId: string;
  name: string;
  /** 该库总命中数（可为 0：该库被搜索但无命中——命中数行照实显示，结果区跳过不渲染） */
  totalHits: number;
  items: LibraryIndexItem[];
  hits: Map<string, SearchHit>;
}

export interface CrossState {
  loading: boolean;
  groups: CrossGroup[];
  unauthorized: Array<{ libraryId: string; name: string }>;
  /** F5：本次检索读取失败/超时的图库（结果区提示"已跳过"，不再静默） */
  failed: Array<{ libraryId: string; name: string }>;
}

export const IDLE_CROSS: CrossState = {
  loading: false,
  groups: [],
  unauthorized: [],
  failed: [],
};

/** 检索状态复位快照（openEntry/switchTo/unbind/清空全部共用） */
const CLEARED_SEARCH = {
  searchQuery: "",
  temperature: 3,
  activeTags: [] as string[],
  tagMode: "and" as const,
  toneFilter: [] as Tone[],
  warmthFilter: [] as Warmth[],
  colorFilter: null as ColorFilter | null,
  starredOnly: false,
  folderScope: null as string | null,
  filterOpen: false,
  /** 搜索框聚焦态：聚焦时工具栏不收起，保证输入中搜索栏保持伸出（M3.4 修复 2026-08） */
  searchFocused: false,
  pendingDetailId: null as string | null,
  imageQuery: null as { url: string; patch: AnalysisPatch } | null,
};

/**
 * 以图搜图 objectURL 回收（2026-09-24 任务卡 §4.3⑤）：CLEARED_SEARCH 复位快照
 * 只把 imageQuery 置 null，**不负责 revoke**——凡「含 ...CLEARED_SEARCH 的 set」
 * 或直接写 imageQuery 的复位路径，都必须先调本函数，否则 objectURL 泄漏。
 */
function revokeImageQuery(s: { imageQuery: { url: string; patch: AnalysisPatch } | null }): void {
  if (s.imageQuery) URL.revokeObjectURL(s.imageQuery.url);
}

/**
 * M3.4.5 文本编辑脏标记：条目文字（tag/备注/描述）被**实际改动**时置位；
 * LibraryPage 在「退出多选 / 关闭详情页」的退出沿读取并消费——只有编辑过才触发一轮
 * 向量增量同步，单纯进出编辑界面零开销（不触发全库比对）。
 */
let textEditedFlag = false;

/** 置位（文本真实变化时由编辑动作调用） */
export function markItemsTextEdited(): void {
  textEditedFlag = true;
}

/**
 * M3.7 待写旋转计数（内存态，不进 schema）：id → 顺时针 90° 次数（取模 4）。
 * 详情页里 `rotateItem` 只改内存与这个计数，退出详情页时 `flushPendingRotations`
 * 一次性读到累计值落盘——连点 N 次只重编码一次，用户口径 2026-09-12。
 */
const pendingRotations = new Map<string, number>();

/** 落盘互斥（同一时刻只跑一轮 flush；期间新来的旋转留到下一轮，不丢计数） */
let flushing = false;

/** 读某条目待落盘的累计旋转次数（详情页重开时据此恢复展示朝向） */
export function pendingRotationsFor(id: string): number {
  return pendingRotations.get(id) ?? 0;
}

/**
 * 条目的**展示朝向**尺寸（M3.7）：基数 = 条目 width/height（恒为磁盘朝向），
 * 累计转数为奇数时宽高互换。详情页图盒、网格格子都该用这个值，而不是 item.width/height——
 * 旋转只在内存里累计，磁盘文件与缩略图要等退出详情页落盘后才跟着变。
 */
export function rotatedDimsOf(
  item: { width: number | null; height: number | null },
  turns: number,
): { width: number | null; height: number | null } {
  if (((turns % 4) + 4) % 4 % 2 === 0) {
    return { width: item.width, height: item.height };
  }
  return { width: item.height, height: item.width };
}

/** 读取并复位；返回本次是否发生过文本编辑（供退出沿消费） */
export function takeItemsTextEdited(): boolean {
  const v = textEditedFlag;
  textEditedFlag = false;
  return v;
}

/** tags 是否真的变了（长度或逐项 text/source 差异） */
function tagsChanged(prev: LibraryTag[], next: LibraryTag[]): boolean {
  if (prev.length !== next.length) return true;
  for (let i = 0; i < prev.length; i += 1) {
    if (prev[i].text !== next[i].text || prev[i].source !== next[i].source) {
      return true;
    }
  }
  return false;
}

interface LibraryState {
  /** 注册表摘要（无 handle；itemCount 来自 meta.json stats.files） */
  libraries: LibrarySummary[];
  current: { libraryId: string; name: string; itemCount: number } | null;
  /** 当前图库条目（ready 占位列表渲染用；不做分析字段展示） */
  items: LibraryIndexItem[];
  phase: LibraryPhase;
  scan: ScanState;
  analysis: AnalysisState;
  /** 排序状态（M3.3） */
  sortKey: SortKey;
  sortDir: SortDir;
  /** 多选集合（每次更新 new Set 替换，不原地 mutate） */
  selectedIds: ReadonlySet<string>;
  /** M3.4.2 R4 当前展示集条目 id（筛选/搜索/文件夹/排序后的 gridItems；LibraryPage 同步，全选用） */
  visibleIds: string[];
  /**
   * 瀑布流浏览位置快照（M3.6）：跨路由（送去分析/送去画布）时 LibraryPage 会被卸载，
   * 局部 state 与滚动 DOM 一起丢，只有 store 活着，故位置存这里。
   * **只记像素不够**——网格上方元素（工具栏「扫描中/分析」读数行、筛选条、命中数）高度
   * 会变，同一像素值会落到不同内容上（表现为"位置偏上/偏下"）；故连"视口顶部那张图
   * （锚点）"一起记，还原时按锚点定位。不持久化、不进 idb。
   */
  browsePos: BrowsePos | null;
  /**
   * 「打开详情前的瀑布流位置」快照（M3.6 用户口径 2026-09-11）：用户点开某张图的那一刻
   * 网格所在的位置。返回图库时（详情不再自动重开）优先按它还原——它是**详情覆盖层出现之前**
   * 测到的，天然不受覆盖层带来的任何布局变化影响，比"最近一次滚动位置"可靠。
   * 一次性消费：还原取用后即清空；正常关掉详情（页面没卸载）也清空，免得以后被误用。
   */
  preDetailPos: BrowsePos | null;
  /** 多选模式开关（M3.3.1）：true 时格子勾选框常显、点格切换选中不开详情 */
  selectMode: boolean;
  /** 详情页当前条目 id；null = 总览 */
  detailId: string | null;
  /** 检索/筛选状态（M3.4）：切换/解绑图库时整体清空 */
  searchQuery: string;
  /**
   * 以图搜图（2026-09-24）：粘贴图同口径特征 + 展示 objectURL。
   * 与 searchQuery 互斥（设置图片即清文本，输入文本即清图片）；
   * 不持久化、不进 schema；objectURL 由本 store 负责回收。
   */
  imageQuery: { url: string; patch: AnalysisPatch } | null;
  setImageQuery: (patch: AnalysisPatch, url: string) => void;
  clearImageQuery: () => void;
  temperature: number; // 0–5，默认 3
  activeTags: string[];
  tagMode: "and" | "or";
  toneFilter: Tone[];
  warmthFilter: Warmth[];
  colorFilter: ColorFilter | null;
  /** 仅标星筛选（搜索行星标按钮；清空全部/切库时复位） */
  starredOnly: boolean;
  folderScope: string | null;
  /** 跨图库搜索开关（PR-007：用户偏好，持久化于 localStorage，不在 CLEARED_SEARCH 内） */
  crossLibrary: boolean;
  /** 跨库结果内存态（PR-007：CrossResults 计算写入；不持久化、不进复位快照） */
  cross: CrossState;
  filterOpen: boolean;
  /** 搜索框聚焦态：true 时工具栏不收起（M3.4 修复 2026-08） */
  searchFocused: boolean;
  /** 跨库点击后待打开的详情（切库扫描完成后自动开） */
  pendingDetailId: string | null;
  /** 识图队列状态（M3.5.2；blockedReason = 守卫拦截原因，null 正常） */
  vision: VisionQueueProgress & { blockedReason: string | null };
  /** 小窗被用户关闭（M3.5.2.1）；下一轮启动自动复位 */
  visionDismissed: boolean;
  /**
   * 新图库识图确认态：打开新图库且识图总开关开启时，
   * 分析完成后不自动跑队列，弹小窗让用户确认/取消
   */
  visionPending: boolean;
  /** 设置面板开关（M3.5.2） */
  settingsOpen: boolean;
  /** 识图小窗展开态（store 化：批量识图请求确认时强制展开） */
  visionWidgetOpen: boolean;
  /** 批量识图确认请求（BatchPanel 快照；确认/取消后置 null） */
  visionBatchRequest: VisionBatchRequest | null;
  init: () => Promise<void>;
  bindNewLibrary: () => Promise<void>;
  authorizeCurrent: () => Promise<void>;
  switchTo: (libraryId: string) => Promise<void>;
  unbind: (libraryId: string) => Promise<void>;
  rescan: () => Promise<void>;
  pauseScan: () => void;
  resumeScan: () => void;
  pauseAnalysis: () => void;
  resumeAnalysis: () => void;
  setSort: (key: SortKey, dir: SortDir) => void;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  setSelectMode: (on: boolean) => void;
  selectAll: () => void;
  /** M3.4.2 R4：LibraryPage 同步展示集 id（gridItems） */
  setVisibleIds: (ids: string[]) => void;
  /** M3.6：整体覆盖浏览位置快照（一次滚动的像素位置 + 展示集签名 + 顶部锚点，必须同源） */
  saveBrowsePos: (pos: BrowsePos) => void;
  /** M3.6：「打开详情前的瀑布流位置」快照；传 null 即清空（正常关详情 / 已被还原消费） */
  savePreDetailPos: (pos: BrowsePos | null) => void;
  enterSelectWith: (id: string) => void;
  setDetail: (id: string | null) => void;
  setSearchQuery: (query: string) => void;
  setTemperature: (temperature: number) => void;
  toggleActiveTag: (text: string) => void;
  setTagMode: (mode: "and" | "or") => void;
  setToneFilter: (value: Tone) => void;
  setWarmthFilter: (value: Warmth) => void;
  setColorFilter: (filter: ColorFilter | null) => void;
  setStarredOnly: (on: boolean) => void;
  setFolderScope: (scope: string | null) => void;
  setCrossLibrary: (on: boolean) => void;
  setFilterOpen: (open: boolean) => void;
  setSearchFocused: (focused: boolean) => void;
  clearSearchAndFilters: () => void;
  setPendingDetailId: (id: string | null) => void;
  /** M3.5.3.6 仅 dev：把 store 实例挂到 window.__ystkStore（CDP 验收脚本注入/读取识图帧用） */
  mountVisionTestStore: () => void;
  startVisionQueue: () => Promise<void>;
  abortVisionQueue: () => void;
  setSettingsOpen: (open: boolean) => void;
  dismissVisionWidget: () => void;
  /** 确认开始识图（新图库弹窗确认按钮）；M3.5.3.6 可传确认清单里被 ✕ 移出的 id（不跑） */
  confirmVisionLaunch: (excludeIds?: readonly string[]) => void;
  /** 取消本轮识图（新图库弹窗取消按钮/小窗关闭钮） */
  cancelVisionLaunch: () => void;
  retryVisionFailed: () => Promise<void>;
  /** 全库重跑：itemIds = 当前全部条目（无视 visionVersion 与 -1，已成功的也重跑扣费） */
  rerunVisionAll: () => Promise<void>;
  /** 单图重新识图（按图库压缩档位，不强制原图）：running 中 → 插队（priority）；非 running → 单图重跑 */
  reanalyzeVisionItem: (id: string) => Promise<void>;
  /** 从本轮队列移除一个 waiting 任务（running/done/failed 忽略）：运行中转发 queue 就地
   *  移除，已收尾（帧留存）则在 store 帧上删并重算 total（M3.5.3.6） */
  dequeueVisionTask: (id: string) => void;
  /** 多选批量识图：选中集经 isVisionPending 过滤后入队/启动（已完成跳过不重复扣费） */
  enqueueVisionBatch: (ids: string[]) => Promise<void>;
  /** M3.5.3.5 缺口全部入队：按给定 ids 一律重跑（无视 visionVersion 与 -1——
   *  字段不全但已识图（visionVersion≥1）的条目也必须重跑，故不能复用 enqueueVisionBatch
   *  的 isVisionPending 过滤；语义同 runVisionBatch("all")：running → 尾部追加，否则 launchVision） */
  enqueueGapRerun: (ids: string[]) => Promise<void>;
  /** 批量识图请求：快照选中集 + 退出多选 + 展开识图面板（确认在面板内做） */
  requestVisionBatch: (ids: string[]) => void;
  /** 取消批量识图确认 */
  clearVisionBatchRequest: () => void;
  /** 面板内执行批量识图：pending = 仅未完成项；all = 全部重识（含已完成，仍非原图） */
  runVisionBatch: (mode: "pending" | "all") => Promise<void>;
  /** 识图小窗展开/收起 */
  setVisionWidgetOpen: (open: boolean) => void;
  addTag: (ids: string[], text: string) => void;
  removeTag: (ids: string[], text: string) => void;
  /** 拖动调整 tag 顺序（编辑小窗）：整体替换 tags 数组 */
  reorderTags: (id: string, tags: LibraryTag[]) => void;
  setStarred: (ids: string[], starred: boolean) => void;
  /**
   * M3.7 详情页旋转（顺时针 90°）：**只改内存**——按调用方给的旋转后尺寸更新条目
   * （详情页图盒与网格格子随之重排），旋转次数记进 `pendingRotations`，等退出详情页时
   * 才由 `flushPendingRotations` 一次性落盘（用户口径 2026-09-12）。无返回值 —— 内存操作
   * 不会失败，写盘失败在 flush 处报。
   */
  rotateItem: (
    id: string,
    dims: { width: number | null; height: number | null },
  ) => void;
  /**
   * 落盘所有待写旋转（退出详情页 / 切图时调用）：逐条读原图 → 按累计次数一次转到位 →
   * 原子写回 → 重生成缩略图 → 同步索引记账。写盘成功的条目返回 id 列表（调用方按需提示）。
   * 注意：M3.7 内存旋转已改为**不写 store**，故本方法的待转表通常为空；单条落盘走 `flushRotation`。
   */
  flushPendingRotations: () => Promise<string[]>;
  /** M3.7 单条旋转落盘（内存旋转的落盘入口）：见实现注释 */
  flushRotation: (id: string, turns: number) => Promise<boolean>;
  setNote: (ids: string[], note: string) => void;
  /** 描述覆盖写（详情页描述文本框） */
  setDescription: (ids: string[], description: string) => void;
}

let initialized = false;

/**
 * 识图运行封装（startVisionQueue / retryVisionFailed / 自动串联共用）：
 * 启动即复位上轮 errors/blockedReason 并置 running；进度全程落 store；
 * 守卫拦截时 blockedReason 写回 vision（UI 据其显示红字/小窗）。
 * notifyEmpty（默认 false）：手动触发且本轮无待处理条目（如全部 -1 跳过）时，
 * 写一条「没有待识图的条目」提示进 blockedReason——否则又是零反馈黑洞
 * （自动串联不提示，避免每次重扫都弹窗）。
 */
async function launchVision(opts?: {
  itemIds?: string[];
  notifyEmpty?: boolean;
  /** 整轮强制原图（M3.5.3 单图重跑用）；priority 插队条目不受此影响、一律原图 */
  forceOriginal?: boolean;
  /** M3.5.3.4 续跑（继续识图/重试失败项）：tasks 沿用旧帧、done/failed/成本/errors 全继承 */
  resume?: {
    tasks: VisionTask[];
    cost: VisionQueueCost;
    errors: VisionQueueError[];
  };
}): Promise<void> {
  if (useLibraryStore.getState().vision.running) return;
  const current = useLibraryStore.getState().current;
  const entry = current ? binding.getEntry(current.libraryId) : undefined;
  if (!entry) return;
  useLibraryStore.setState({
    visionDismissed: false,
    // 续跑：保留旧任务帧（total/计数/成本/errors 在 runVisionQueue 首帧上报前不闪失、
    // 守卫拦截也不丢帧）；开新轮：按现状复位 IDLE。均复位 abortReason（新一轮/续跑起点）
    vision: opts?.resume
      ? {
          ...useLibraryStore.getState().vision,
          running: true,
          blockedReason: null,
          abortReason: null,
        }
      : { ...IDLE_VISION, running: true },
  });
  try {
    const result = await runVisionQueue(
      entry.handle,
      {
        onProgress: (p) =>
          useLibraryStore.setState({
            vision: { ...p, running: true, blockedReason: null },
          }),
      },
      opts,
    );
    useLibraryStore.setState((s) => {
      let blocked = result.blockedReason;
      if (!blocked && opts?.notifyEmpty && s.vision.total === 0) {
        const skipped = indexFile
          .listItems()
          .filter((i) => i.visionVersion === -1).length;
        blocked =
          skipped > 0
            ? `没有待识图的条目（${skipped} 张识图失败，可点「重试失败项」重跑）`
            : "没有待识图的条目";
      }
      return {
        vision: { ...s.vision, running: false, blockedReason: blocked },
      };
    });
  } catch (err) {
    console.error("[library] 识图队列异常", err);
  } finally {
    useLibraryStore.setState((s) => ({
      vision: { ...s.vision, running: false },
      items: indexFile.listItems(),
    }));
  }
}

/** 扫描尾部：等扫描结束（含收尾落盘）后刷新条目与计数，置 ready */
async function finishScan(
  entry: LibraryRegistryEntry,
  opts?: {
    /** 打开新图库路径：识图总开关开启时不自动跑，改弹小窗确认（重扫不弹） */
    askVisionConfirm?: boolean;
  },
): Promise<void> {
  try {
    await startScan(entry.handle, {
      onProgress: (progress: ScanProgress) =>
        useLibraryStore.setState({ scan: { ...progress, running: true } }),
      isPaused: () => useLibraryStore.getState().scan.paused,
    });
  } catch (err) {
    // 目录缺失/移动/断开：句柄可能仍持「授权」但 IO 全挂——置 missing 态，
    // 让用户「重新定位目录」（bindNewLibrary 按 meta.libraryId 对位）或移除绑定
    console.error("[library] 扫描失败（目录可能已不可访问）", err);
    const st = useLibraryStore.getState();
    if (st.current?.libraryId !== entry.libraryId) return;
    useLibraryStore.setState({
      phase: "missing",
      scan: { ...st.scan, running: false },
    });
    return;
  }
  const state = useLibraryStore.getState();
  // 扫描期间已切换/解绑图库则不再覆盖状态（indexFile 代次守卫已停扫）
  if (state.current?.libraryId !== entry.libraryId) return;
  useLibraryStore.setState({
    items: indexFile.listItems(),
    current: {
      ...state.current,
      itemCount: indexFile.getItemCount(),
    },
    scan: { ...state.scan, running: false },
    analysis: { ...IDLE_ANALYSIS, running: true },
    phase: "ready",
  });

  // 跨库点击：目标库扫描完成后自动打开该图详情（存在才开，否则只清 pending）
  const pending = state.pendingDetailId;
  if (pending) {
    useLibraryStore.setState({
      detailId: indexFile.getItem(pending) ? pending : null,
      pendingDetailId: null,
    });
  }

  // 分析后台跑：不 await，phase 保持 ready；完成/异常时刷新条目并复位 running
  let lastItemsRefresh = 0;
  void runAnalysisQueue(entry.handle, {
    onProgress: (progress: AnalysisProgress) => {
      const patch: Partial<LibraryState> = {
        analysis: { ...progress, running: true },
      };
      // 渐进回填 thumb/统计，网格随分析进度可见：2s 时间闸刷新 items
      // （虚拟网格下重渲染可接受；扫描期间不刷）
      const now = Date.now();
      if (now - lastItemsRefresh >= 2000) {
        lastItemsRefresh = now;
        patch.items = indexFile.listItems();
      }
      useLibraryStore.setState(patch);
    },
    isPaused: () => useLibraryStore.getState().analysis.paused,
  })
    .then(async ({ failed }) => {
      const st = useLibraryStore.getState();
      // 分析期间已切换/解绑图库则不再覆盖状态（indexFile 代次守卫已停队列）
      if (st.current?.libraryId !== entry.libraryId) return;
      useLibraryStore.setState({
        items: indexFile.listItems(),
        analysis: { ...st.analysis, running: false, failed },
      });
      // 打开新图库（启动恢复/绑定/切换/重授权）且识图总开关开启：存在待识图条目时按
      // 「新增图片自动识图」开关分流（2026-08-23 用户反馈：此路径此前无视该开关）——
      // 开 → 不询问，静默自动识图（与重扫口径一致）；关 → 弹小窗等用户确认/取消；
      // 全部已识图（无待处理）不弹确认，但小窗显示「任务已完成」完成态
      // （避免「173/173 还问确认」的空弹，也避免面板直接消失——2026-08-21 用户反馈）；
      // 总开关关闭时维持原静默串联（守卫拦截不弹窗）
      const global = await loadVisionGlobal();
      if (opts?.askVisionConfirm) {
        if (global.enabled) {
          const all = indexFile.listItems();
          // M3.5.3.4+ 待处理口径拆分（2026-09-03 用户反馈）：pending = 可自动识图、
          // failed = 识图失败(-1)。「开始识图」只跑 pending——失败项只经
          // 「重试失败项」手动跑。故仅 pending>0 才弹开始确认（否则确认后空跑
          // 落「没有待识图的条目」提示，此前确认框与实际动作口径不一致的 bug）；
          // 仅剩失败项时不弹确认，直接以失败提示态呈现（重试入口同 blocked 分支）
          const { pending: todoCount, failed: failedCount } =
            countVisionTodoOf(all);
          if (todoCount > 0) {
            if (!global.autoRecognizeNew) {
              // 进入确认态前清残留 blockedReason（失败提示态/已取消等旧提示让位，
              // 否则确认行与 error 行同屏——2026-09-03 用户反馈）
              useLibraryStore.setState({
                visionPending: true,
                visionDismissed: false,
                vision: {
                  ...useLibraryStore.getState().vision,
                  blockedReason: null,
                },
              });
              return;
            }
            // 开关开：不询问，落到下方 launchVision 静默自动识图
          } else if (failedCount > 0) {
            useLibraryStore.setState({
              visionPending: false,
              visionDismissed: false,
              vision: {
                ...IDLE_VISION,
                blockedReason: `没有待识图的条目（${failedCount} 张识图失败，可点「重试失败项」重跑）`,
              },
            });
            return;
          } else if (all.length > 0) {
            // 全部已识图：小窗置完成态（total=图库张数、done=全部成功），不空跑
            useLibraryStore.setState({
              visionPending: false,
              visionDismissed: false,
              vision: {
                total: all.length,
                done: all.length,
                failed: 0,
                running: false,
                cost: { promptTokens: 0, completionTokens: 0, cachedTokens: 0, amount: 0 },
                tasks: [],
                errors: [],
                blockedReason: null,
              },
            });
            return;
          }
        }
      }
      // 基础分析完成后自动识图（默认开，静默串联：守卫/空跑均不弹小窗，避免每次重扫打扰）。
      // 「新增图片自动识图」关闭时：存在待识图条目（新增/修改）改弹小窗手动确认，
      // 口径与打开新图库一致；识图运行中不叠加确认态（未识新图可待下轮或手动触发回收）
      if (global.enabled && !global.autoRecognizeNew) {
        // 口径同 askVisionConfirm：只认可自动识图数（不含 -1 失败项——失败项不随
        // 「开始识图」自动跑，此处只负责新增/改动条目的确认弹窗）
        const { pending: todoCount } = countVisionTodoOf(indexFile.listItems());
        if (todoCount > 0 && !useLibraryStore.getState().vision.running) {
          // 同 askVisionConfirm：清残留 blockedReason（失败提示态/已取消等）让位确认行
          useLibraryStore.setState({
            visionPending: true,
            visionDismissed: false,
            vision: {
              ...useLibraryStore.getState().vision,
              blockedReason: null,
            },
          });
        }
        return;
      }
      void launchVision();
    })
    .catch((err) => {
      console.error("[library] 分析队列异常", err);
      const st = useLibraryStore.getState();
      if (st.current?.libraryId !== entry.libraryId) return;
      useLibraryStore.setState({
        analysis: { ...st.analysis, running: false },
      });
    });
}

/**
 * 清扫历史原子写 tmp 残留（M3.2.1 R8，2026-08-25 用户反馈：thumbs 目录大量
 * .tmp）。tmp 从不是合法产物（commitAtomic 的 move 成功是唯一正常带走它的
 * 分支），降级覆盖写/写失败时残留。只删 `.ystk/thumbs/` 下 `*.tmp` 与
 * `.ystk` 根下 `index.json.tmp` / `meta.json.tmp` 两个具名文件；不递归、
 * 不碰其他目录；单个失败忽略，整体异常 console.warn 封顶。fire-and-forget，
 * 在分析队列启动前执行，无并发冲突。
 */
async function cleanupTmpResidue(dir: FileSystemDirectoryHandle): Promise<void> {
  try {
    const ystk = await dir.getDirectoryHandle(".ystk");
    try {
      const thumbs = await ystk.getDirectoryHandle("thumbs");
      for await (const entry of thumbs.values()) {
        if (entry.kind === "file" && entry.name.endsWith(".tmp")) {
          try {
            await thumbs.removeEntry(entry.name);
          } catch {
            /* 已不存在或被占用，忽略 */
          }
        }
      }
    } catch {
      /* thumbs 目录不存在，跳过 */
    }
    // `.ystk` 根级只删两个具名 tmp，避免误伤
    for (const name of ["index.json.tmp", "meta.json.tmp"]) {
      try {
        await ystk.removeEntry(name);
      } catch {
        /* 已不存在或被占用，忽略 */
      }
    }
  } catch (err) {
    console.warn("[library] tmp 残留清扫跳过", err);
  }
}

/** 打开图库：激活索引 → 缓存分流（优先直接出网格/否则阻塞扫描）→ 全量扫描 */
async function openEntry(
  entry: LibraryRegistryEntry,
  opts?: { askVisionConfirm?: boolean },
): Promise<void> {
  // 切库/打开前中止旧库识图并复位 vision 状态（双保险，代次守卫已兜）；
  // M3.5.3.4 中止原因逐字透传（小窗显示「已中止 · 切换或打开图库」）
  abortVisionRun("切换或打开图库");
  await indexFile.activateLibrary(entry.handle, entry.libraryId);
  void binding.touchLastOpened(entry.libraryId);
  // 历史 tmp 残留一次性清扫：不 await、不阻塞打开
  void cleanupTmpResidue(entry.handle);
  // 跨库点击的 pendingDetailId 要撑到 finishScan 消费（开详情），不能随检索状态清掉
  const pendingId = useLibraryStore.getState().pendingDetailId;
  // 缓存先行（M3.2.1 R7）：索引已有条目 → 直接 ready 出网格，扫描转后台增量
  const cached = indexFile.getItemCount() > 0;
  // 以图搜图 objectURL 必须随复位回收（CLEARED_SEARCH 只置 null）
  revokeImageQuery(useLibraryStore.getState());
  useLibraryStore.setState({
    current: {
      libraryId: entry.libraryId,
      name: entry.name,
      itemCount: indexFile.getItemCount(),
    },
    items: indexFile.listItems(),
    selectedIds: new Set<string>(),
    visibleIds: [],
    selectMode: false,
    ...CLEARED_SEARCH,
    pendingDetailId: pendingId,
    phase: cached ? "ready" : "scanning",
    scan: { ...IDLE_SCAN, running: true },
    analysis: IDLE_ANALYSIS,
    vision: IDLE_VISION,
    visionDismissed: false,
    visionPending: false,
    settingsOpen: false,
    visionWidgetOpen: false,
    visionBatchRequest: null,
  });
  if (cached) {
    // 跨库搜索点击：条目已在缓存 → 详情立即打开，不等后台扫描
    if (pendingId && indexFile.getItem(pendingId)) {
      useLibraryStore.setState({
        detailId: pendingId,
        pendingDetailId: null,
      });
    }
    // 扫描转后台增量：不 await（finishScan 尾部会再置 ready/items/analysis，
    // 幂等无害）；后台扫描不提供暂停，scan.paused 恒 false
    void finishScan(entry, opts);
    return;
  }
  await finishScan(entry, opts);
}

/**
 * 激活失败后的恢复（2026-09-17 A 审查打回项，F1 配套）：
 *
 * `switchTo` / `bindNewLibrary` 在 `openEntry` 之前都会 `await indexFile.deactivateLibrary()`
 * （旧库落盘 + 激活内存态清空）。若目标库的 `activateLibrary` 因 F1（索引读失败中止打开）
 * 抛错，只 toast 不切库会留下**僵尸激活态**——store 的 current/items 还显示旧库（看着正常），
 * 但 indexFile 内存态已空，此后任何编辑经 `upsertItem`/`updateItem` 都是静默 no-op，
 * 刷新即丢。故两个 catch 都必须 best-effort 把原库重新激活回来。
 *
 * 重激活走完整 `openEntry`（重新激活索引 + 起扫描），状态机随之自洽。
 * 重激活也失败时明确让用户刷新，不静默。
 */
async function recoverActiveLibrary(
  entryAfterFailure: LibraryRegistryEntry,
): Promise<"none" | "recovered" | "failed"> {
  const prev = useLibraryStore.getState().current;
  if (!prev || prev.libraryId === entryAfterFailure.libraryId) return "none";
  const prevEntry = binding.getEntry(prev.libraryId);
  if (!prevEntry) return "none";
  try {
    await openEntry(prevEntry, { askVisionConfirm: false });
    return "recovered";
  } catch (err) {
    console.error("[library] 原图库重新激活失败", err);
    return "failed";
  }
}
export const useLibraryStore = create<LibraryState>()((set, get) => ({
  libraries: [],
  current: null,
  items: [],
  phase: "idle",
  scan: IDLE_SCAN,
  analysis: IDLE_ANALYSIS,
  vision: IDLE_VISION,
  visionDismissed: false,
  visionPending: false,
  settingsOpen: false,
  visionWidgetOpen: false,
  visionBatchRequest: null,
  sortKey: "mtime",
  sortDir: "desc",
  selectedIds: new Set<string>(),
  visibleIds: [],
  browsePos: null,
  preDetailPos: null,
  selectMode: false,
  detailId: null,
  ...CLEARED_SEARCH,
  /** PR-007：跨图库搜索为用户偏好——初值取自 localStorage，且不随切库/解绑/清空复位 */
  crossLibrary: readCrossPref(),
  cross: IDLE_CROSS,

  /** 页面挂载调用（幂等）：能力检测 → 恢复注册表 → 自动打开最近图库 */
  init: async () => {
    if (initialized) return;
    initialized = true;
    if (!isFsaSupported()) {
      set({ phase: "unsupported" });
      return;
    }
    await binding.loadRegistry();
    set({ libraries: await binding.refreshSummaries() });
    const latest = get().libraries.reduce<LibrarySummary | null>(
      (best, lib) =>
        !best || lib.lastOpenedAt > best.lastOpenedAt ? lib : best,
      null,
    );
    if (!latest) {
      set({ phase: "unbound" });
      return;
    }
    const entry = binding.getEntry(latest.libraryId);
    if (!entry) {
      set({ phase: "unbound" });
      return;
    }
    const granted = await binding.ensureEntryPermission(entry, true);
    if (!granted) {
      set({
        current: {
          libraryId: entry.libraryId,
          name: entry.name,
          itemCount: 0,
        },
        phase: "need-permission",
      });
      return;
    }
    // F1：索引读失败中止打开时兜住——回到 unbound（常驻库列表 PR-005 可手动重开，天然重试入口）
    try {
      await openEntry(entry, { askVisionConfirm: true });
    } catch (err) {
      console.error("[library] 打开图库失败", err);
      toast(err instanceof Error ? err.message : String(err));
      set({ phase: "unbound" });
    }
  },

  /** 绑定新文件夹（按钮 = 用户手势入口） */
  bindNewLibrary: async () => {
    set({ phase: "binding" });
    let entry: LibraryRegistryEntry | null = null;
    try {
      entry = await binding.bindNewLibrary();
      if (!entry) {
        // 用户取消：回到原有状态（missing 态保持——取消重新定位仍停留在错误提示页）
        set((s) => ({
          phase: s.phase === "missing" ? "missing" : s.current ? "ready" : "unbound",
        }));
        return;
      }
      set({ libraries: await binding.refreshSummaries() });
      await openEntry(entry, { askVisionConfirm: true });
    } catch (err) {
      // F1：openEntry 的索引读失败中止与绑定本身的异常同款处理——toast 提示 + 回原 phase；
      // 旧库同样已在 openEntry 内被 deactivate，故 best-effort 重新激活（同 switchTo）
      console.error("[library] 绑定失败", err);
      toast(err instanceof Error ? err.message : String(err));
      set((s) => ({
        phase: s.phase === "missing" ? "missing" : s.current ? "ready" : "unbound",
      }));
      // 绑定本身失败（entry 尚未拿到）时无需重激活——此时还没人 deactivate 旧库
      if (entry && (await recoverActiveLibrary(entry)) === "failed") {
        toast("当前图库状态异常，请刷新页面");
      }
    }
  },

  /** need-permission 态的「重新授权」（必须由用户手势触发） */
  authorizeCurrent: async () => {
    const entry = get().current
      ? binding.getEntry(get().current!.libraryId)
      : undefined;
    if (!entry) return;
    // 取原始 PermissionState（binding.ensureEntryPermission 折叠成 boolean 会丢
    // denied / prompt 之别）：denied = 浏览器已记住拒绝，requestPermission 不再弹
    // 提示，须指引改走「重新定位目录」；prompt = 用户刚关掉提示，重试即可（PR-006）
    const state = await ensurePermission(entry.handle, true);
    if (state !== "granted") {
      toast(
        state === "denied"
          ? "未获得授权：浏览器已记住本次拒绝。请改用「重新定位目录」，或在浏览器站点设置中允许访问后重试。"
          : "未获得授权：请重试，并在浏览器提示中选择「允许」。",
      );
      return;
    }
    // 重新授权后进入图库同样走识图确认（2026-08-21 用户反馈：启动/进入图库不得直接开跑）
    await openEntry(entry, { askVisionConfirm: true });
  },

  /** 切换图库：先落盘卸载当前库，再打开目标库 */
  switchTo: async (libraryId: string) => {
    if (get().current?.libraryId === libraryId) return;
    await indexFile.deactivateLibrary();
    const entry = binding.getEntry(libraryId);
    if (!entry) return;
    const granted = await binding.ensureEntryPermission(entry, true);
    if (!granted) {
      revokeImageQuery(get()); // 以图搜图 objectURL 随复位回收（CLEARED_SEARCH 只置 null）
      set({
        current: {
          libraryId: entry.libraryId,
          name: entry.name,
          itemCount: 0,
        },
        items: [],
        selectedIds: new Set<string>(),
        selectMode: false,
        ...CLEARED_SEARCH,
        scan: IDLE_SCAN,
        analysis: IDLE_ANALYSIS,
        vision: IDLE_VISION,
        visionDismissed: false,
        visionPending: false,
        settingsOpen: false,
        visionWidgetOpen: false,
        visionBatchRequest: null,
        phase: "need-permission",
      });
      return;
    }
    // F1：目标库索引读失败会抛错中止打开——此处兜住：不切库，并把**原库重新激活**。
    // 前面的 deactivateLibrary 已把激活内存态清空，若不重激活，current 仍指向旧库而
    // indexFile 内存态为空 → 后续编辑静默 no-op、刷新即丢（2026-09-17 A 审查打回项）。
    try {
      await openEntry(entry, { askVisionConfirm: true });
    } catch (err) {
      console.error("[library] 打开图库失败", err);
      toast(err instanceof Error ? err.message : String(err));
      if ((await recoverActiveLibrary(entry)) === "failed") {
        toast("当前图库状态异常，请刷新页面");
      }
    }
  },

  /** 解绑：仅移除注册表记录，不删磁盘 `.ystk` */
  unbind: async (libraryId: string) => {
    const isCurrent = get().current?.libraryId === libraryId;
    if (isCurrent) {
      abortVisionRun("解绑图库"); // M3.5.3.4 中止原因逐字透传（小窗显示「已中止 · 解绑图库」）
      await indexFile.deactivateLibrary();
    }
    await binding.unbindLibrary(libraryId);
    set((s) => {
      // 解绑当前库：以图搜图 objectURL 随复位回收（CLEARED_SEARCH 只置 null）
      if (isCurrent) revokeImageQuery(s);
      return {
        libraries: s.libraries.filter((lib) => lib.libraryId !== libraryId),
        ...(isCurrent
          ? {
              current: null,
              items: [],
              selectedIds: new Set<string>(),
              selectMode: false,
              ...CLEARED_SEARCH,
              scan: IDLE_SCAN,
              analysis: IDLE_ANALYSIS,
              vision: IDLE_VISION,
              visionDismissed: false,
              visionPending: false,
              settingsOpen: false,
              visionWidgetOpen: false,
              visionBatchRequest: null,
              phase: "unbound",
            }
          : {}),
      };
    });
  },

  /** 当前图库重新扫描（增量比对）：重扫后台化（M3.2.3），不再跳阻塞扫描页 */
  rescan: async () => {
    const entry = get().current
      ? binding.getEntry(get().current!.libraryId)
      : undefined;
    if (!entry) return;
    // 后台重扫：phase 保持 ready、网格不动；尾部 setState 幂等，与 openEntry
    // 缓存路径同款注释口径（不 await）；后台扫描不提供暂停，scan.paused 恒 false
    set({ scan: { ...IDLE_SCAN, running: true } });
    void finishScan(entry);
  },

  pauseScan: () => set((s) => ({ scan: { ...s.scan, paused: true } })),
  resumeScan: () => set((s) => ({ scan: { ...s.scan, paused: false } })),
  pauseAnalysis: () =>
    set((s) => ({ analysis: { ...s.analysis, paused: true } })),
  resumeAnalysis: () =>
    set((s) => ({ analysis: { ...s.analysis, paused: false } })),

  setSort: (key, dir) => set({ sortKey: key, sortDir: dir }),

  toggleSelect: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),

  clearSelection: () => set({ selectedIds: new Set<string>() }),

  /** M3.4.2 R4：LibraryPage 同步当前展示集（gridItems）id——全选对齐可见集 */
  setVisibleIds: (ids: string[]) => set({ visibleIds: ids }),

  /** M3.6：整体覆盖浏览位置快照（滚动监听高频调用；值与锚点必须来自同一瞬间） */
  saveBrowsePos: (pos) => set({ browsePos: pos }),

  /** M3.6：「打开详情前的瀑布流位置」快照（null = 清空） */
  savePreDetailPos: (pos) => set({ preDetailPos: pos }),

  /** 多选模式开关：退出即清空选择集（钉死）；进入不动选择集 */
  setSelectMode: (on) =>
    set({
      selectMode: on,
      ...(on ? {} : { selectedIds: new Set<string>() }),
    }),

  /** 全选当前可见条目（筛选/搜索/文件夹/排序后的展示集；M3.4.2 R4 修复：不再全库） */
  selectAll: () =>
    set({ selectedIds: new Set(get().visibleIds) }),

  /** Ctrl+点击格快捷入口：进多选并切换本格选中（一次 setState 避免中间态） */
  enterSelectWith: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectMode: true, selectedIds: next };
    }),

  /** 打开详情不清选择集（M3.3 约束） */
  setDetail: (id) => set({ detailId: id }),

  setSearchQuery: (query) => set({ searchQuery: query }),

  /** 互斥口径：设图片即清文本（SearchBar 的 store→输入框同步机制会自动清空输入框文本） */
  setImageQuery: (patch, url) =>
    set((s) => {
      revokeImageQuery(s);
      return { imageQuery: { url, patch }, searchQuery: "" };
    }),
  clearImageQuery: () =>
    set((s) => {
      revokeImageQuery(s);
      return { imageQuery: null };
    }),

  setTemperature: (temperature) => set({ temperature }),

  /** tag 云点选：同文本切换选中/取消 */
  toggleActiveTag: (text) =>
    set((s) => ({
      activeTags: s.activeTags.includes(text)
        ? s.activeTags.filter((t) => t !== text)
        : [...s.activeTags, text],
    })),

  setTagMode: (mode) => set({ tagMode: mode }),

  /** 明度/冷暖 chip 多选切换（同值再点取消） */
  setToneFilter: (value) =>
    set((s) => ({
      toneFilter: s.toneFilter.includes(value)
        ? s.toneFilter.filter((v) => v !== value)
        : [...s.toneFilter, value],
    })),

  setWarmthFilter: (value) =>
    set((s) => ({
      warmthFilter: s.warmthFilter.includes(value)
        ? s.warmthFilter.filter((v) => v !== value)
        : [...s.warmthFilter, value],
    })),

  setColorFilter: (filter) => set({ colorFilter: filter }),
  setStarredOnly: (on) => set({ starredOnly: on }),
  setFolderScope: (scope) => set({ folderScope: scope }),
  /** PR-007：跨图库搜索开关即改即存（localStorage；写入失败静默，不影响本次会话） */
  setCrossLibrary: (on) => {
    try {
      localStorage.setItem(CROSS_SEARCH_KEY, on ? "1" : "0");
    } catch {
      // 隐私模式/配额满：静默失败，仅本次会话生效
    }
    set({ crossLibrary: on });
  },
  setFilterOpen: (open) => set({ filterOpen: open }),
  setSearchFocused: (focused) => set({ searchFocused: focused }),
  /** 清空检索/筛选（含以图搜图态与其 objectURL 回收） */
  clearSearchAndFilters: () =>
    set((s) => {
      revokeImageQuery(s);
      return { ...CLEARED_SEARCH };
    }),
  setPendingDetailId: (id) => set({ pendingDetailId: id }),

  /** M3.5.3.6 验收钩子（仅 dev）：把 store 实例交给 CDP 实测脚本——
   *  识图任务帧是纯内存态，无法经磁盘夹具构造，只能由脚本直接注入/读取
   *  （小窗自身不依赖这些钩子，行为与线上一致）。mount 在 LibraryPage dev 块。 */
  mountVisionTestStore: () => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __ystkStore?: unknown }).__ystkStore =
      useLibraryStore;
  },

  /** 启动/继续识图队列（M3.5.2/2.1 + M3.5.3.4 续跑）：running 中直接 return；
   *  上轮任务帧仍在且存在 waiting → resume 续跑（waiting 续跑、done/failed/计数/
   *  成本/errors 全继承、total 不变）；帧已失（刷新后/全新）→ 按现状开新轮。
   *  异常 console.error 不抛出 */
  startVisionQueue: async () => {
    const v = get().vision;
    if (v.tasks.length > 0 && v.tasks.some((t) => t.status === "waiting")) {
      await launchVision({
        resume: { tasks: v.tasks, cost: v.cost, errors: v.errors },
        notifyEmpty: true,
      });
      return;
    }
    await launchVision({ notifyEmpty: true });
  },

  /** 中止本轮识图（abort 进行中请求 + 队列退出）；中止原因逐字透传（小窗显示「已中止 · 手动中止」） */
  abortVisionQueue: () => {
    abortVisionRun("手动中止");
  },

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  /** 关闭识图小窗（不清数据；下轮启动自动复位） */
  dismissVisionWidget: () => set({ visionDismissed: true }),

  /** 确认开始识图（新图库/重扫确认弹窗）：确认后把「可自动识图 + 识图失败(-1)」整批
   *  交给队列一次跑干净（2026-09-03 用户口径——此前只跑未识图、失败项另走重试，
   *  确认文案与行为不符）；经 itemIds 注入（该口径无视版本与 -1），列表只含上述两类，
   *  已成功且未过期的条目不入列不重复扣费。仅自动静默路径（autoRecognizeNew=true）仍
   *  不碰失败项——防断网/故障期反复自动重试烧钱（见 queue 内部 pending 排除 -1）。
   *  M3.5.3.6：`excludeIds` = 确认清单里被 ✕ 移出的行——口径仍由本函数现算（不信任 UI 传
   *  来的全集），只在遍历时跳过这些 id，故「移出队列」不会因图库期间变化而误伤其它条目。 */
  confirmVisionLaunch: (excludeIds) => {
    const skip = excludeIds && excludeIds.length > 0 ? new Set(excludeIds) : null;
    const ids: string[] = [];
    for (const it of indexFile.listItems()) {
      const v = it.visionVersion ?? 0;
      if (
        v === -1 ||
        v < VISION_VERSION ||
        (it.visionAt ?? 0) < it.mtime
      ) {
        if (skip?.has(it.id)) continue;
        ids.push(it.id);
      }
    }
    set({ visionPending: false });
    void launchVision({ itemIds: ids, notifyEmpty: true });
  },

  /** 取消本轮识图（新图库弹窗取消按钮）：小窗以「未启动」态保留
   * （blockedReason = 已取消本次识图，可再点「开始识图」回收）；dismiss 关闭仍走原通道 */
  cancelVisionLaunch: () =>
    set({
      visionPending: false,
      visionDismissed: false,
      vision: { ...IDLE_VISION, blockedReason: "已取消本次识图" },
    }),

  /** 重试识图失败项（M3.5.3.4 全库范围 + 续跑；confirm 放 UI 层，张数经
   *  countRetryVisionFailed 与执行口径一致）：
   *  任务帧仍在 → 帧内 failed 任务不可变置回 waiting（清 error）＋ 帧外全部
   *  visionVersion===-1 条目追加为 waiting 任务（尾部，并入 tasks 数组）→ 全部重试条目
   *  updateItem 预清仅作用于无有效结果的重试条目（-1/未跑 → visionVersion: 0、
   *  visionAt: null 清 -1 防重标记与失败时间）；已有成功结果的条目（手动重跑失败
   *  仍保留身份，见 queue 终败口径）不预清 →
   *  resume 续跑（done/failed/
   *  计数/成本/errors 全继承）；帧已失（刷新后）→ itemIds = 全库 -1 条目开新轮。 */
  retryVisionFailed: async () => {
    const vision = get().vision;
    if (vision.tasks.length > 0) {
      // 重试清单与 confirm 计数同源（M3.5.3.6）：帧内 failed + 帧外 -1。
      // 用清单而非自行重遍历，保证「确认清单列出的行」与「实际重试的条目」一致
      const retryIds = retryVisionFailedIds();
      if (retryIds.length === 0) return; // 帧内无 failed 且帧外无 -1：无可重试项
      const merged: VisionTask[] = vision.tasks.map((t) =>
        t.status === "failed"
          ? {
              id: t.id,
              relPath: t.relPath,
              status: "waiting",
              ...(t.forceOriginal ? { forceOriginal: true } : {}),
            }
          : t,
      );
      // 帧外 -1 条目按清单顺序追加尾部
      const frameIdSet = new Set(vision.tasks.map((t) => t.id));
      for (const id of retryIds) {
        if (frameIdSet.has(id)) continue;
        const it = indexFile.getItem(id);
        if (it) {
          merged.push({ id: it.id, relPath: it.relPath, status: "waiting" });
        }
      }
      // 预清只对「无有效识图结果」的项（-1/未跑）做；已有成功结果（visionVersion>=1）
      // 的项（手动重跑失败、身份仍保留）不预清——重试成功由 analyze 覆盖新结果、
      // 再失败也不降级（口径同 queue 终败分支）
      for (const id of retryIds) {
        const cur = indexFile.getItem(id);
        if (!cur || (cur.visionVersion ?? 0) < 1) {
          indexFile.updateItem(id, { visionVersion: 0, visionAt: null });
        }
      }
      await launchVision({
        resume: {
          tasks: merged,
          cost: vision.cost,
          errors: vision.errors,
        },
        notifyEmpty: true,
      });
      return;
    }
    const ids = indexFile
      .listItems()
      .filter((i) => (i.visionVersion ?? 0) === -1)
      .map((i) => i.id);
    if (ids.length === 0) return;
    await launchVision({ itemIds: ids, notifyEmpty: true });
  },

  /** 全库重跑：itemIds = 当前全部条目（无视 visionVersion 与 -1，已成功的也重跑扣费）；
   * running 中直接 return 由 launchVision 守卫兜；confirm 放 UI 层（不在 store 弹窗） */
  rerunVisionAll: async () => {
    await launchVision({
      itemIds: indexFile.listItems().map((i) => i.id),
      notifyEmpty: true,
    });
  },

  /** 单图重新识图（2026-08-23 用户口径：按图库压缩档位，不强制原图）：
   * running 中 → 插队（priority 插到游标处）；非 running → 单图重跑 */
  reanalyzeVisionItem: async (id: string) => {
    if (get().vision.running) {
      enqueueVisionItems([id], { priority: true });
      return;
    }
    await launchVision({ itemIds: [id] });
  },

  /**
   * 从本轮队列移除一个 waiting 任务（running/done/failed 忽略）。
   * M3.5.3.6 两段式（修复「中止后 ✕ 删除静默失效」）：
   * ① 队列在跑（activeRun 存在）→ 转发 `dequeueVisionItem`（queue 内按 cursor 就地移除）；
   * ② 队列已收尾（中止/正常跑完/预算暂停后 activeRun 已置 null，但任务帧还留在 store 里）
   *    → 在 store 帧上做不可变删除，只认 waiting（done/failed/running 忽略，口径同 queue），
   *    `total` 随帧重算为剩余任务数，done/failed 计数不动（帧内任务状态本身没变）。
   *    **在飞（running）任务任何时刻都删不掉**：已发出的 API 请求无法取消，只能整体中止
   *    （`abortVisionQueue`）——这是设计口径，不是缺陷。
   * 目标不是 waiting、帧不存在、或两段都没命中 → 静默返回。
   */
  dequeueVisionTask: (id) => {
    if (get().vision.running) {
      dequeueVisionItem(id);
      return;
    }
    set((s) => {
      const target = s.vision.tasks.find((t) => t.id === id);
      if (!target || target.status !== "waiting") return {};
      const tasks = s.vision.tasks.filter((t) => t.id !== id);
      return { vision: { ...s.vision, tasks, total: tasks.length } };
    });
  },

  /**
   * 多选批量识图（M3.5.3.2）：ids 经 isVisionPending 过滤（indexFile.getItem 取条目；
   * 含 -1 失败项——批量识图覆盖失败重试；已识图完成的跳过，不重复扣费）；
   * 过滤后为空直接 return（UI 侧已置灰，双保险）；
   * running 中 → enqueueVisionItems 尾部追加（常规档位，不设 forceOriginal——
   * 规划 §6「批量原图重分析」不做，批量一律走图库压缩档位）；非 running → launchVision
   * （itemIds 口径无视版本与 -1，自动覆盖失败重试）。
   */
  enqueueVisionBatch: async (ids: string[]) => {
    const filtered = ids.filter((id) => {
      const item = indexFile.getItem(id);
      return item !== undefined && isVisionPending(item);
    });
    if (filtered.length === 0) return;
    if (get().vision.running) {
      enqueueVisionItems(filtered, { priority: false });
      return;
    }
    await launchVision({ itemIds: filtered, notifyEmpty: true });
  },

  /** M3.5.3.5 缺口全部入队：ids 全部重跑（含 visionVersion≥1 的字段不全条目——它们经
   *  isVisionPending 判定为「不待处理」，但字段缺失仍须识图补齐，故不套该过滤）；
   *  running → 尾部追加（常规档位非原图，同批量口径）；非 running → launchVision
   *  （itemIds 口径无视版本与 -1，queue.ts forceIds 分支）。 */
  enqueueGapRerun: async (ids: string[]) => {
    const existing = ids.filter((id) => indexFile.getItem(id) !== undefined);
    if (existing.length === 0) return;
    if (get().vision.running) {
      enqueueVisionItems(existing, { priority: false });
      return;
    }
    await launchVision({ itemIds: existing, notifyEmpty: true });
  },

  /** 批量识图请求（2026-08-22 用户改版：确认从批量面板移到识图面板）：
   * 快照选中集与未完成计数 → 退出多选（setSelectMode(false) 会清选择集，故先快照）→
   * 展开识图面板，由面板内「识别未完成项 / 识别全部 / 取消」做最终确认。 */
  requestVisionBatch: (ids) => {
    const pendingCount = ids.filter((id) => {
      const item = indexFile.getItem(id);
      return item !== undefined && isVisionPending(item);
    }).length;
    set({
      visionBatchRequest: { ids: [...ids], pendingCount, at: Date.now() },
      selectMode: false,
      selectedIds: new Set<string>(),
      visionWidgetOpen: true,
    });
  },

  clearVisionBatchRequest: () => set({ visionBatchRequest: null }),

  /** 面板内执行批量识图：pending = 仅未完成项（isVisionPending 过滤，含 -1 失败重试）；
   * all = 选中集全部重识（含已完成与 -1，仍按图库压缩档位非原图——规划 §6 批量原图不做）。
   * running 中 → 尾部追加；非 running → launchVision itemIds 口径（无视版本与 -1）。 */
  runVisionBatch: async (mode) => {
    const req = get().visionBatchRequest;
    if (!req) return;
    set({ visionBatchRequest: null });
    if (mode === "pending") {
      await get().enqueueVisionBatch(req.ids);
      return;
    }
    const ids = req.ids.filter((id) => indexFile.getItem(id) !== undefined);
    if (ids.length === 0) return;
    if (get().vision.running) {
      enqueueVisionItems(ids, { priority: false });
      return;
    }
    await launchVision({ itemIds: ids, notifyEmpty: true });
  },

  setVisionWidgetOpen: (open) => set({ visionWidgetOpen: open }),

  /** 批量加 tag：trim 去空、同文本去重置顶尾；末尾同步展示层 */
  addTag: (ids, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    for (const id of ids) {
      const item = indexFile.getItem(id);
      if (!item) continue;
      const tags = [
        ...item.tags.filter((t) => t.text !== trimmed),
        { text: trimmed, source: "manual" as const },
      ];
      if (tagsChanged(item.tags, tags)) markItemsTextEdited();
      indexFile.updateItem(id, { tags });
    }
    // 编辑低频，全量换数组可接受（展示层同步）
    set({ items: indexFile.listItems() });
  },

  /** 批量删 tag：按文本精确匹配，不分 source */
  removeTag: (ids, text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    for (const id of ids) {
      const item = indexFile.getItem(id);
      if (!item) continue;
      const tags = item.tags.filter((t) => t.text !== trimmed);
      if (tagsChanged(item.tags, tags)) markItemsTextEdited();
      indexFile.updateItem(id, { tags });
    }
    set({ items: indexFile.listItems() });
  },

  /** 拖动调整 tag 顺序（编辑小窗）：整体替换 tags 数组并同步展示层 */
  reorderTags: (id, tags) => {
    const item = indexFile.getItem(id);
    if (item && tagsChanged(item.tags, tags)) markItemsTextEdited();
    indexFile.updateItem(id, { tags });
    set({ items: indexFile.listItems() });
  },

  setStarred: (ids, starred) => {
    for (const id of ids) {
      indexFile.updateItem(id, { starred });
    }
    set({ items: indexFile.listItems() });
  },

  /**
   * M3.7 旋转（用户口径 2026-09-12 定稿：详情页内纯内存、退出详情页才落盘）。
   *
   * 内存阶段只做一件事：**累计次数 +1**。像素与磁盘文件此刻都没动，所以：
   * - 手感即时（无解码/重编码等待），连点 N 次只写一次盘（转满 4 次净零则不写）；
   * - 详情页大图由 DetailView 按基准位图派生旋转显示；网格格子朝向由
   *   `rotatedDimsOf(item, 待转次数)` 给出——**条目自身的 width/height 保持磁盘朝向不动**，
   *   这一点是关键：列表缩略图/图盒/候选排序都读 item 的宽高，若在这里把宽高改成
   *   "展示朝向"，就会与仍在磁盘上的旧文件（以及未更新的缩略图）互相矛盾。
   *
   * 未做（按用户口径）：**不重算 pHash**——旋转是同像素转置，phash 字段保留旧签名；
   * 不写 meanLuma/meanSat/tone/colors/hiColor/loColor（同理，像素值分布未变）。
   * visionAt/analyzedAt 也不在内存阶段写：留到 flush 真正改盘时一起拨（这样
   * 「visionAt ≥ mtime」在文件真被改写的那一刻才成立，识图 pending 判据全程不误判）。
   */
  rotateItem: (id) => {
    if (!indexFile.getItem(id)) return;
    pendingRotations.set(id, (pendingRotations.get(id) ?? 0) + 1);
    // 条目本身不动（仍是磁盘朝向）；只推一次 items 让订阅方（详情页/网格）按新累计次数重算朝向
    set({ items: indexFile.listItems() });
  },

  /**
   * 落盘待写旋转：读原图 → 一次转到累计角度 → 原子写回 → 重生成缩略图 → 同步记账。
   *
   * **识图红线**（本卡唯一要守的不变量）：识图 pending 判据是 `(visionAt ?? 0) < mtime`
   * （vision/queue.ts 非 resume 分支、countVisionTodoOf 同口径）。旋转把文件改小了/改大了
   * 都会让 mtime 变大，故此处把 visionAt 拨到写盘时刻，让该式不成立；visionVersion 与
   * description/fields/tags/extra 一律不碰（画面只是同像素转置，语义字段仍成立），
   * 因此不需要（也不许）新增「防重识」专用字段。
   * mtime/size 取重读回来的真实值——扫描两级失效判定（size 变才重分析）与
   * `visionAt ≥ mtime` 都靠它成立，重扫即判「无变化」。
   */
  flushPendingRotations: async () => {
    const done: string[] = [];
    // 已有一轮在跑：等它收尾（它收尾时会再扫一遍 map，把期间新记的旋转一起带走），
    // 然后直接返回 —— 不做并发写，也不丢计数
    if (flushing) {
      while (flushing) await new Promise((resolve) => setTimeout(resolve, 40));
      return done;
    }
    const current = get().current;
    const dir = current ? binding.getEntry(current.libraryId)?.handle : undefined;
    if (!dir || pendingRotations.size === 0) return done;
    flushing = true;
    try {
      // 循环而非单趟快照：一轮里新记的旋转（flush 期间用户又点了旋转）也被带走
      while (pendingRotations.size > 0) {
        const id = pendingRotations.keys().next().value as string;
        const count = pendingRotations.get(id) ?? 0;
        pendingRotations.delete(id);
        const item = indexFile.getItem(id);
        if (!item) continue;
        try {
          if (((count % 4) + 4) % 4 === 0) continue; // 转满 4 次回到原向：盘上文件无需改写
          const rotated = await writeRotatedFile(dir, item.relPath, count);
          if (!rotated) continue;
          const { file, bitmap } = rotated;
          try {
            const thumb = await makeThumb(dir, bitmap, id);
            indexFile.updateItem(id, {
              width: bitmap.width,
              height: bitmap.height,
              // 缩略图生成失败（返回 null）时保留原 thumb：画面会旧一帧，但绝不置空
              // （置空会让重扫的 Pass A 候选把这张图当成未分析重跑）
              thumb: thumb ?? item.thumb,
              mtime: file.lastModified,
              size: file.size,
              analyzedAt: Date.now(),
              visionAt: Date.now(),
            });
            done.push(id);
          } finally {
            bitmap.close();
          }
        } catch (err) {
          // 含 GIF 拒绝（文案由 UI 层拦截给出）与解码/写盘失败
          console.warn("[library] 旋转写盘失败", item.relPath, err);
        }
      }
      set({ items: indexFile.listItems() });
      return done;
    } finally {
      flushing = false;
    }
  },

  /**
   * M3.7 单条旋转落盘（**内存旋转的落盘入口**）：把详情页里累计的 `turns` 一次性写进磁盘原图。
   *
   * 为什么需要它：内存旋转阶段**不能写 store**（写了 `set({items})` 会让瀑布流网格立刻按新
   * 宽高重排——用户 2026-09-12 报「旋转的时候主界面也跟着动」）。于是累计次数由 DetailView/
   * LibraryPage 本地持有，落盘时用本方法把 `(id, turns)` 一起交进来，不再依赖全局的待转表。
   *
   * 语义与 `flushPendingRotations` 的记账完全一致（净零跳过 / 缩略图重生成 / `visionAt` 拨到
   * 写盘时刻以化解识图 pending 判据 / pHash 与识图字段不动）；写盘成功才 `set({ items })`，
   * 网格在**退出详情页之后**才更新。返回是否真的写了盘。
   */
  flushRotation: async (id, turns) => {
    if (((turns % 4) + 4) % 4 === 0) return false; // 净零：盘上文件无需改写
    const current = get().current;
    const dir = current ? binding.getEntry(current.libraryId)?.handle : undefined;
    if (!dir) return false;
    const item = indexFile.getItem(id);
    if (!item) return false;
    try {
      const rotated = await writeRotatedFile(dir, item.relPath, turns);
      if (!rotated) return false;
      const { file, bitmap } = rotated;
      try {
        const thumb = await makeThumb(dir, bitmap, id);
        indexFile.updateItem(id, {
          width: bitmap.width,
          height: bitmap.height,
          // 缩略图生成失败（返回 null）时保留原 thumb：画面会旧一帧，但绝不置空
          // （置空会让重扫的 Pass A 候选把这张图当成未分析重跑）
          thumb: thumb ?? item.thumb,
          mtime: file.lastModified,
          size: file.size,
          analyzedAt: Date.now(),
          visionAt: Date.now(),
        });
      } finally {
        bitmap.close();
      }
      set({ items: indexFile.listItems() });
      return true;
    } catch (err) {
      // 含 GIF 拒绝（文案由 UI 层拦截给出）与解码/写盘失败
      console.warn("[library] 旋转写盘失败", item.relPath, err);
      return false;
    }
  },

  /** 批量备注 = 覆盖写（不是追加） */
  setNote: (ids, note) => {
    for (const id of ids) {
      const item = indexFile.getItem(id);
      if (!item) continue;
      if (item.note !== note) markItemsTextEdited();
      indexFile.updateItem(id, { note });
    }
    set({ items: indexFile.listItems() });
  },

  /** 描述覆盖写（详情页描述文本框） */
  setDescription: (ids, description) => {
    for (const id of ids) {
      const item = indexFile.getItem(id);
      if (!item) continue;
      if (item.description !== description) markItemsTextEdited();
      indexFile.updateItem(id, { description });
    }
    set({ items: indexFile.listItems() });
  },
}));
