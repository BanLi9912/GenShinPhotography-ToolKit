import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { hexToRgb } from "../../../core/imaging/color";
import type { RgbHex } from "../../../core/imaging/stats";
import * as indexFile from "../index/indexFile";
import type { LibraryIndexItem } from "../index/indexFile";
import { searchItems, type SearchCriteria } from "../search/rank";
import * as vectorStore from "../search/vector/store";
import {
  imageQueryFloorOf,
  imageQueryHitsOf,
  IMAGE_QUERY_BATCH,
  IMAGE_QUERY_EMPTY_HINT,
} from "../search/imageQuery";
import { sortItems, takeItemsTextEdited, useLibraryStore, type BrowsePos, type SortKey } from "../store";
import { registerVisionDevHooks } from "../vision/devhooks";
import { saveVisionGlobal } from "../vision/settings";
import { scanLibraryGaps } from "../vision/gapScan";
import { confirmDialog } from "../../../ui/confirm";
import { toast } from "../../../ui/toast";
import { BatchPanel } from "./BatchPanel";
import { CrossHint, CrossResults } from "./CrossResults";
import { DetailView } from "./DetailView";
import { FilterBar } from "./FilterBar";
import { LibraryQuickList } from "./LibraryQuickList";
import { OverviewGrid } from "./OverviewGrid";
import { SearchBar } from "./SearchBar";
import { SettingsPanel } from "./SettingsPanel";
import { VisionWidget } from "./VisionWidget";
import "./LibraryPage.css";

/**
 * M3 参考图库主页（任务 M3.1/M3.2/M3.3）：
 * 空状态引导 / 授权与扫描进度 / 就绪总览网格 + 详情页。
 */

/**
 * 展示集签名（M3.6 浏览位置还原用）：条目数 + 首尾 id。
 * 还原滚动位置与"这份清单还是原来那份"必须同源——总高度由条目顺序和数量决定，
 * 换库/换筛选/换排序（含搜索态）后签名变化即不还原，避免把旧基准套到新清单上。
 * 取首尾而非全量拼接：滚动高频路径上零大字符串分配（全量 join 会每帧拼几万字符）。
 */
function viewSignature(ids: string[], total: number): string {
  return `${total}|${ids[0] ?? ""}|${ids[ids.length - 1] ?? ""}`;
}

/**
 * 浏览位置还原的最大重试帧数（M3.6）：网格总高由 ResizeObserver 异步量宽后才有，
 * 首帧设 scrollTop 会被钳成 0，故逐帧重试；约 1s 仍够不上（内容确实变短）就按钳后值落定。
 */
const MAX_RESTORE_TRIES = 60;
/**
 * 对齐后继续盯的帧数（M3.6）：网格上方元素（工具栏「扫描中/分析」读数行、筛选条、
 * 命中数）可能在挂载后一两帧才定型，高度一变同一像素值就落错内容——故对齐后不立即收工，
 * 连续这么多帧都对齐才算稳。约 6 帧 ≈ 100ms，短到不会跟用户抢滚动。
 */
const RESTORE_SETTLE_FRAMES = 6;

/**
 * 命中数行跨库段「跳转到该库结果块」时，目标块顶边距容器顶边的留白（px = `--space-3`）：
 * 不让库名标题贴着视口上沿。
 */
const CROSS_JUMP_MARGIN = 12;

/**
 * 取"视口顶部那张图"作浏览位置锚点（M3.6）：返回格子 id 与其顶边相对滚动容器顶边的偏移
 * （通常 ≤ 0，表示已滚过一部分）。用 offsetTop/offsetHeight（网格内坐标，便宜且不受滚动影响）
 * 测量，只在每次滚动事件里跑一遍。
 */
function captureAnchor(el: HTMLElement): {
  anchorId: string;
  anchorTop: number;
} {
  const grid = el.querySelector<HTMLElement>(".lib-grid");
  if (!grid) return { anchorId: "", anchorTop: 0 };
  // 网格顶边在"容器坐标系"里的位置（视口相对 + 当前滚动 = 与滚动无关的文档坐标）
  const gridDocTop =
    grid.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  let bestTop = Infinity;
  let bestId = "";
  for (const cell of grid.querySelectorAll<HTMLElement>("[data-cell-id]")) {
    const top = gridDocTop + cell.offsetTop;
    if (top + cell.offsetHeight <= el.scrollTop) continue; // 已完全滚出视口上方
    if (top < bestTop) {
      bestTop = top;
      bestId = cell.dataset.cellId ?? "";
    }
  }
  if (!bestId) return { anchorId: "", anchorTop: 0 };
  return { anchorId: bestId, anchorTop: bestTop - el.scrollTop };
}

/** 某个格子的顶边相对滚动容器可见区顶边的偏移（视口内偏移，局部量）；未渲染返回 null */
function cellViewTop(
  grid: HTMLElement,
  el: HTMLElement,
  id: string,
): number | null {
  for (const cell of grid.querySelectorAll<HTMLElement>("[data-cell-id]")) {
    if (cell.dataset.cellId !== id) continue;
    const gridDocTop =
      grid.getBoundingClientRect().top -
      el.getBoundingClientRect().top +
      el.scrollTop;
    return gridDocTop + cell.offsetTop - el.scrollTop;
  }
  return null;
}

/**
 * 抓一份完整的浏览位置快照（像素 + 展示集签名 + 锚点，全部来自同一瞬间）。
 *
 * `focusId` = 用户此刻正在看的那张图（详情页条目）。**优先锚定它**：它在视口内的偏移是个
 * 局部量，不受"网格上方元素高度变化 / 列宽重排"随深度累积的影响——用户口径「返回要能定位到
 * 送去分析的那张图」说的就是这个落点。拿不到才退回"视口最顶部那张格子"。
 */
function capturePos(el: HTMLElement, focusId?: string | null): BrowsePos {
  const ids = useLibraryStore.getState().visibleIds;
  const sig = viewSignature(ids, ids.length);
  const grid = el.querySelector<HTMLElement>(".lib-grid");
  if (grid && focusId) {
    const top = cellViewTop(grid, el, focusId);
    if (top !== null) {
      return { scrollTop: el.scrollTop, sig, anchorId: focusId, anchorTop: top };
    }
  }
  return {
    scrollTop: el.scrollTop,
    sig,
    ...captureAnchor(el),
  };
}

declare global {
  interface Window {
    /** 验收调试用（仅 dev）：注入 n 条假条目到展示层，0 恢复真实数据 */
    __ystkLibraryMock?: (n: number) => void;
    /** M3.4 验收：注入 20 条固定检索 fixture（展示层，不碰磁盘） */
    __ystkSearchFixture?: () => void;
    /** M3.4 验收：跑 searchItems 并返回命中 id 升序数组（向量引擎下先预热 query 向量，异步） */
    __ystkSearchTest?: (
      query: string,
      temperature: number,
      extra?: Partial<SearchCriteria>,
    ) => Promise<string[]>;
    /** M3.4 调试：返回命中明细（理由 + 字段），验收排障用 */
    __ystkSearchDebug?: (query: string, temperature: number) => unknown[];
    /** M3.4.3 验收：注入 8 条自然语言检索 fixture（展示层，不碰磁盘） */
    __ystkSearchNLFixture?: () => void;
    /** M3.4.5 验收（仅 dev）：向量引擎状态快照 { engine, ollamaOk, embedded, dirty, model } */
    __ystkVectorStatus?: () => {
      engine: string;
      ollamaOk: boolean;
      embedded: number;
      dirty: number;
      model: string;
      dims?: number;
    };
    /** M3.4.5 验收（仅 dev）：手动触发一轮 syncEmbeddings（store 当前 items），返回完成后的 stats */
    __ystkVectorSync?: () => Promise<{
      embedded: number;
      total: number;
      dirty: number;
      dims?: number;
    }>;
    /** M3.4.5 验收（仅 dev）：切引擎（"dict"|"vector"），落 idb 全局设置（向量模式附赠一轮 sync） */
    __ystkSetSearchEngine?: (mode: "dict" | "vector") => Promise<void>;
    /** M3.4.5 验收（仅 dev）：走当前装配返回「相关度降序」的命中 id（向量组 top5 判定用，不做排序） */
    __ystkVectorSearchIds?: (
      query: string,
      temperature: number,
      extra?: Partial<SearchCriteria>,
    ) => Promise<string[]>;
    /** M3.5.3.5 验收（仅 dev）：对 store 当前 items 跑缺口扫描，返回结构摘要 */
    __ystkGapScan?: () => {
      total: number;
      neverRunCount: number;
      fieldGapCount: number;
      sample: unknown[];
    };
    /** M3.2.2 一次性修复（仅 dev）：全量重置条目为未分析态，强制重跑 Pass A/B */
    __ystkReanalyzeAll?: () => void;
  }
}

function FolderIcon() {
  return (
    <svg
      className="lib-empty__icon"
      width="40"
      height="40"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

/** 分析预计剩余格式化：null（速度未知）→ —，<60s → N 秒，否则 N 分 */
function formatEta(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分`;
}

export function LibraryPage() {
  const phase = useLibraryStore((s) => s.phase);
  const libraries = useLibraryStore((s) => s.libraries);
  const current = useLibraryStore((s) => s.current);
  /** PR-007：跨库命中数（逐库带库名，与当前库命中并同一行显示） */
  const cross = useLibraryStore((s) => s.cross);
  const items = useLibraryStore((s) => s.items);
  const scan = useLibraryStore((s) => s.scan);
  const analysis = useLibraryStore((s) => s.analysis);
  const settingsOpen = useLibraryStore((s) => s.settingsOpen);
  const setSettingsOpen = useLibraryStore((s) => s.setSettingsOpen);
  const init = useLibraryStore((s) => s.init);
  const bindNewLibrary = useLibraryStore((s) => s.bindNewLibrary);
  const authorizeCurrent = useLibraryStore((s) => s.authorizeCurrent);
  const switchTo = useLibraryStore((s) => s.switchTo);
  const unbind = useLibraryStore((s) => s.unbind);
  const rescan = useLibraryStore((s) => s.rescan);
  const pauseScan = useLibraryStore((s) => s.pauseScan);
  const resumeScan = useLibraryStore((s) => s.resumeScan);
  const pauseAnalysis = useLibraryStore((s) => s.pauseAnalysis);
  const resumeAnalysis = useLibraryStore((s) => s.resumeAnalysis);
  const sortKey = useLibraryStore((s) => s.sortKey);
  const sortDir = useLibraryStore((s) => s.sortDir);
  const selectMode = useLibraryStore((s) => s.selectMode);
  const storeDetailId = useLibraryStore((s) => s.detailId);
  const setSort = useLibraryStore((s) => s.setSort);
  const setSelectMode = useLibraryStore((s) => s.setSelectMode);
  const setDetail = useLibraryStore((s) => s.setDetail);
  /** M3.7：单条旋转落盘入口（退出详情页/切图时按 `(id, turns)` 调用，见 onClose 与切图 effect） */
  const flushRotation = useLibraryStore((s) => s.flushRotation);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const imageQuery = useLibraryStore((s) => s.imageQuery);
  const temperature = useLibraryStore((s) => s.temperature);
  const activeTags = useLibraryStore((s) => s.activeTags);
  const tagMode = useLibraryStore((s) => s.tagMode);
  const toneFilter = useLibraryStore((s) => s.toneFilter);
  const warmthFilter = useLibraryStore((s) => s.warmthFilter);
  const colorFilter = useLibraryStore((s) => s.colorFilter);
  const folderScope = useLibraryStore((s) => s.folderScope);
  const starredOnly = useLibraryStore((s) => s.starredOnly);
  const filterOpen = useLibraryStore((s) => s.filterOpen);
  const searchFocused = useLibraryStore((s) => s.searchFocused);
  const setVisibleIds = useLibraryStore((s) => s.setVisibleIds);
  const saveBrowsePos = useLibraryStore((s) => s.saveBrowsePos);
  const browsePos = useLibraryStore((s) => s.browsePos);
  const savePreDetailPos = useLibraryStore((s) => s.savePreDetailPos);
  const preDetailPos = useLibraryStore((s) => s.preDetailPos);
  const setColorFilter = useLibraryStore((s) => s.setColorFilter);
  const setFilterOpen = useLibraryStore((s) => s.setFilterOpen);
  // 局部态供虚拟网格窗口计算（store 里的那份只用于跨路由还原视图）
  const [scrollTop, setScrollTop] = useState(0);
  /**
   * 跨路由返回不自动重开详情（M3.6 用户口径 2026-09-11）——返回就该落在瀑布流上。
   * 难点在时序：挂载首帧 store 里还带着上一次挂载遗留的 detailId，若等到 effect 里再清，
   * 详情覆盖层会先挂载再播 200ms 离场动画（用户会看到闪一下）。故首帧就把它当"没开详情"
   * 对待（本渲染内一律为 null），随后在 effect 里真正清掉 store，避免留下"开着但没显示"的脏状态。
   * 跨库搜索点开详情走 openEntry（页面没卸载）→ 不受影响。
   */
  const staleDetailOnMountRef = useRef(storeDetailId !== null);
  const detailId = staleDetailOnMountRef.current ? null : storeDetailId;
  /** 还原进行中：展示集 effect 在此期间不许写入（它先于还原的 layout effect 运行，否则冲 0） */
  const restorePendingRef = useRef(false);
  /** 本 ready 周期已处理过还原（成或不成都不再重试） */
  const restoreDoneRef = useRef(false);
  /** 还原定位期间隐藏网格（visibility）：避免用户看到"先画顶部再跳" */
  const [scrollBusy, setScrollBusy] = useState(false);
  const [mouseAtTop, setMouseAtTop] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [panelMounted, setPanelMounted] = useState(false);
  const [panelLeaving, setPanelLeaving] = useState(false);
  const [detailOrigin, setDetailOrigin] = useState<DOMRect | null>(null);
  const [detailMounted, setDetailMounted] = useState(false);
  const [detailLeaving, setDetailLeaving] = useState(false);
  /**
   * PR-007 跨图库**只读**查看态（用户口径"点击跨图库的图会强制加载对应图库、顶掉当前图库，
   * 能否实现只打开图，不跳转"）：只保存"看哪一库的哪一批命中里的第几张"，**不碰 store**
   * ——当前库、网格、滚动位置、检索条件全部原样保留。条目快照取自跨库结果组（引用复用，
   * 不复制），故检索条件变化导致跨库结果重算时，正在看的这批命中依然可翻页。
   */
  const [foreignView, setForeignView] = useState<{
    libraryId: string;
    libraryName: string;
    items: LibraryIndexItem[];
    index: number;
  } | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const gearRef = useRef<HTMLButtonElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const panelLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detailLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M3.4 检索管线：筛选 → 文本打分；有文本查询走 score 序，无查询保留排序
  const criteria = useMemo<SearchCriteria>(
    () => ({
      query: searchQuery,
      temperature,
      activeTags,
      tagMode,
      toneFilter,
      warmthFilter,
      colorFilter,
      folderScope,
      starredOnly,
    }),
    [
      searchQuery,
      temperature,
      activeTags,
      tagMode,
      toneFilter,
      warmthFilter,
      colorFilter,
      folderScope,
      starredOnly,
    ],
  );
  // M3.4.5 向量引擎：订阅向量 store 状态（engine/ollama/version），当前装配下
  // 引擎=向量 且 Ollama 在线 且 query 向量已缓存 → 语义计分器（否则 undefined，
  // 词典模式与现状逐字节一致）。query 向量预热由下方 effect 在 searchQuery 变化时异步发起。
  const vectorStatus = useSyncExternalStore(
    vectorStore.subscribeVectorStatus,
    vectorStore.getVectorStatus,
  );
  // version 变化（自检/嵌入/索引完成）也要重算：向量就绪后搜索结果须刷新
  const semantic = vectorStore.semanticFor(searchQuery);
  void vectorStatus.version; // 受控状态戳：嵌入完成 bump 后本组件重渲染 → semanticFor 重新求值
  const searched = useMemo(
    () => searchItems(items, criteria, semantic),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- semantic 对象模块级稳定，仅其就绪性影响结果
    [items, criteria, semantic, vectorStatus.version],
  );
  /**
   * 以图搜图（2026-09-24，同口径 2026-09-26 修订）：伪目标（色彩/轮廓/影调三路）
   * 在**筛选器幸存集**上跑相似排序；与文本轨互斥（imageQuery 存在时本轨接管网格）。
   * 阈值随温度档位走（`imageQueryFloorOf`），**条数不在此处截断**——全量留在 memo 里，
   * 首屏只展示前 `visibleCount` 张、底部「加载更多」每批 +24；跨库图片轨吃同一份
   * 全量结果（`CrossResults` 分组内自带 12 张预览/展开，见该文件）。
   */
  const imageSearched = useMemo(() => {
    if (!imageQuery) return null;
    const filtered = searchItems(items, { ...criteria, query: "" }, undefined);
    return imageQueryHitsOf(
      filtered.items,
      imageQuery.patch,
      imageQueryFloorOf(temperature),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- criteria 各字段已列于 searched 的依赖（temperature 另列，它决定图片轨阈值），此处对象引用稳定即可
  }, [imageQuery, items, criteria, temperature]);
  /**
   * 图片轨首屏展示张数（2026-09-26 用户口径：首屏 24、底部「加载更多」每批 +24）。
   * 换图 / 改温度档 / 改筛选器后重置回一批——阈值变了还挂着上一档"已加载 200 张"
   * 会让首屏形同虚设。
   */
  const [visibleCount, setVisibleCount] = useState(IMAGE_QUERY_BATCH);
  useEffect(() => {
    setVisibleCount(IMAGE_QUERY_BATCH);
  }, [imageQuery, temperature, criteria]);
  /** 图片轨：阈值内全量命中（截断只发生在上面的 visibleCount 切片） */
  const imageHitItems = imageSearched?.items ?? null;
  /**
   * 点色直达结果（2026-08-10 反馈，2026-08 改版）：
   * Ctrl/⌘ 点击 = 加入取色行托盘（去重、保留其余托盘）；
   * 普通点击 = 清空全部取色托盘，仅以此色在取色行搜索（替换）。
   * PR-007 后续：主网格与跨图库格子**共用本回调**（用户口径"所有图片的 UI 都一致"），
   * 所以提成具名函数而不是内联传参。
   */
  const handleSwatchPick = (hex: string, additive: boolean) => {
    const h = hex.toLowerCase();
    if (additive && colorFilter) {
      setColorFilter(
        colorFilter.row.colors.includes(h)
          ? colorFilter
          : {
              ...colorFilter,
              row: {
                ...colorFilter.row,
                colors: [...colorFilter.row.colors, h],
              },
            },
      );
    } else {
      setColorFilter({
        mode: "and",
        row: { mode: "or", colors: [h] },
        hi: { mode: "or", colors: [] },
        lo: { mode: "or", colors: [] },
      });
    }
    setFilterOpen(false);
    pageRef.current?.scrollTo({ top: 0 });
  };

  /**
   * 跨图库格子点击 → **只读打开该图**（PR-007 后续，用户口径"只打开图，不跳转"）：
   * 不动 store（不 `switchTo` / 不 `setPendingDetailId`），只把"哪一库、哪批命中、第几张"
   * 交给详情覆盖层只读渲染；当前库与网格位置全程不变。`origin` 用于与主网格一致的 FLIP 入场。
   */
  const openForeign = (
    libraryId: string,
    libraryName: string,
    items: LibraryIndexItem[],
    itemId: string,
    origin: DOMRect | null,
  ) => {
    const index = items.findIndex((i) => i.id === itemId);
    if (index < 0) return;
    setDetailOrigin(origin);
    setForeignView({ libraryId, libraryName, items, index });
  };

  /**
   * 命中数行的跨库段点击 → 跳到该库结果块（PR-007 后续，用户口径"把所有跨图库搜索的文本
   * 分别做成按钮，点击跳转到对应搜索位置"）。`.lib-page` 即滚动容器，按目标块的文档偏移
   * 直接定位（与浏览位置还原同一套坐标算法：块顶 - 容器顶 + 当前滚动）；瞬时跳转、
   * 不播动画（对齐既有 `scrollTo({ top })` 口径）。
   */
  const scrollToCrossGroup = (libraryId: string) => {
    const page = pageRef.current;
    if (!page) return;
    const target = page.querySelector<HTMLElement>(
      `[data-cross-group="${libraryId}"]`,
    );
    if (!target) return;
    const top =
      target.getBoundingClientRect().top -
      page.getBoundingClientRect().top +
      page.scrollTop;
    page.scrollTo({ top: Math.max(0, top - CROSS_JUMP_MARGIN) });
  };

  const hasQuery = searchQuery.trim() !== "";
  /** 取色筛选激活 = 三托盘至少一色（模式可预设，空托盘不算激活） */
  const colorFilterActive =
    (colorFilter?.row.colors.length ?? 0) +
      (colorFilter?.hi.colors.length ?? 0) +
      (colorFilter?.lo.colors.length ?? 0) >
    0;
  const searchActive =
    hasQuery ||
    imageQuery != null ||
    activeTags.length > 0 ||
    toneFilter.length > 0 ||
    warmthFilter.length > 0 ||
    colorFilterActive ||
    folderScope != null ||
    starredOnly;
  const gridItems = useMemo(
    () =>
      imageSearched
        ? imageSearched.items.slice(0, visibleCount)
        : hasQuery
          ? searched.items
          : sortItems(searched.items, sortKey, sortDir),
    [imageSearched, visibleCount, hasQuery, searched.items, sortKey, sortDir],
  );
  /**
   * 图片轨显示张数（命中数行用）：**阈值内全量**，与「加载更多」按钮的"还有 N 张"
   * 同源（`全量 = 已展示 + 还有`），两处永远对得上。文本轨/无查询时即展示集本身。
   */
  const imageShownCount = imageSearched ? (imageHitItems?.length ?? 0) : gridItems.length;
  /** 图片轨还有没展示完的命中（底部「加载更多」按钮据此显隐） */
  const imageMoreCount = imageHitItems
    ? imageHitItems.length - gridItems.length
    : 0;
  // M3.4.2 R4：展示集（筛选/搜索/文件夹/排序后的 gridItems）同步进 store.visibleIds——
  // 多选「全选」与页面真实显示对齐（BatchPanel 仍调 selectAll，不清筛选后已选集）。
  // M3.6：同一处把「浏览位置快照」整体写进 store（像素 + 签名 + 锚点必须同源，
  // 否则会按旧清单的基准还原新清单）；还原尚未跑（本 effect 先于还原的 layout effect）
  // 或非 ready 态（无网格节点）时不写，否则会把刚存下的位置冲成 0，等于没记。
  useEffect(() => {
    const ids = gridItems.map((i) => i.id);
    setVisibleIds(ids);
    const el = pageRef.current;
    if (el && !restorePendingRef.current) saveBrowsePos(capturePos(el));
  }, [gridItems, setVisibleIds, saveBrowsePos]);

  /**
   * 跨路由返回不自动重开详情（M3.6 用户口径 2026-09-11）：首帧已把遗留的 detailId 当成
   * "没开详情"（见 staleDetailOnMountRef），这里把 store 里的那份真正清掉并解除屏蔽；
   * 之后用户自己打开详情（null → 有值）行为照旧。
   */
  useEffect(() => {
    if (!staleDetailOnMountRef.current) return;
    staleDetailOnMountRef.current = false;
    setDetail(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载时跑一次
  }, []);

  /**
   * 「打开详情前的瀑布流位置」快照（M3.6）：
   * - 无 → 有：用户刚要打开详情，此刻网格位置就是"打开前的瀑布流"，记下来；
   * - 有 → 无 **且详情是本次挂载里打开的**：用户正常关掉详情继续浏览，快照作废
   *   （免得以后被误用）。跨路由离开（送去分析/送去画布）不走"关闭"分支，快照留用；
   *   而挂载时清掉遗留 detailId 造成的那次 id→null 不是用户关闭，**绝不能顺手清快照**，
   *   否则正好把返回时要用的那份抹掉——故用 openedHereRef 区分。
   */
  const prevDetailForPosRef = useRef(detailId);
  const openedDetailHereRef = useRef(false);
  useEffect(() => {
    const prev = prevDetailForPosRef.current;
    prevDetailForPosRef.current = detailId;
    if (prev === detailId) return;
    const el = pageRef.current;
    if (!prev && detailId && el) {
      openedDetailHereRef.current = true;
      // 锚定"用户点开的那张图"：它的视口内偏移不随深度累积，返回时能精确落回它
      savePreDetailPos(capturePos(el, detailId));
      return;
    }
    if (prev && !detailId && openedDetailHereRef.current) savePreDetailPos(null);
  }, [detailId, savePreDetailPos]);

  /**
   * M3.7 旋转落盘：详情页内旋转只改内存（**不写 store**，否则瀑布流网格会跟着重排——
   * 用户 2026-09-12 报「旋转的时候主界面也跟着动」）。累计次数由详情页经 `onItemTurns`
   * 报到这里，退出/切图时按 `(id, turns)` 交给 store 的 `flushRotation` 一次性写盘。
   */
  const [pendingRotation, setPendingRotation] = useState<{
    id: string;
    turns: number;
  } | null>(null);
  const pendingRotationRef = useRef<{ id: string; turns: number } | null>(null);
  /** 在渲染期取值，保证 `onClose` 闭包（取自最近一次渲染）读到的最新 */
  const pendingNow = pendingRotationRef.current ?? pendingRotation;
  /** 落盘当前待写旋转并清账（返回是否真的写了盘） */
  const flushRotationNow = () => {
    const pending = pendingRotationRef.current;
    pendingRotationRef.current = null;
    setPendingRotation(null);
    if (!pending || pending.turns % 4 === 0) return Promise.resolve(false);
    return flushRotation(pending.id, pending.turns);
  };
  /**
   * 切图（←/→ 或相似图跳转）：把上一张的待写旋转落盘——不落盘的话，上一张的 `<img>` 源
   * 会随换图被回收，而内存里的累计次数还挂着，展示与磁盘状态就对不上了。
   * 退出详情页的落盘在 onClose 里做。
   */
  const prevRotateFlushRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevRotateFlushRef.current;
    prevRotateFlushRef.current = detailId;
    if (prev && detailId && prev !== detailId) void flushRotationNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flushRotationNow 为每次渲染重建的薄封装
  }, [detailId, flushRotation]);

  // 挂载：恢复注册表/最近图库；卸载：强制落盘当前索引（写入策略 5）+ 向量文件
  useEffect(() => {
    void init();
    void vectorStore.refreshSettings();
    return () => {
      void indexFile.flush();
      void vectorStore.flushVectors();
    };
  }, [init]);

  /**
   * 瀑布流浏览位置还原（M3.6）：跨路由（送去分析/送去画布）本组件被卸载，
   * `.lib-page` 滚动节点与 scrollTop 局部态一起丢，回来就停在最上方。
   *
   * **定位主依据是"那张图"（锚点 id），不是像素值**——像素值只是个初跳猜测：
   * ① 瀑布流是虚拟滚动，只渲染视口附近的格子，目标格子一开始不在 DOM 里，得先跳过去；
   * ② 跳的落点用三重猜测（存下的像素 → 锚点在展示集中的序号比例 → 邻近探针），不押注单一来源；
   * ③ 目标格子一进 DOM，就用它的 `offsetTop`（布局定型后实测）反算
   *    `scrollTop = 锚点当前位置 − 锚点原偏移`——网格上方元素高度变化、列宽重算全被吸收；
   * ④ 对齐后连续 RESTORE_SETTLE_FRAMES 帧都对得上才收工；期间网格 `visibility: hidden`，
   *    避免"先画顶部再跳"。
   *
   * ⚠️ 曾经的两个坑（都已修，改动时勿回退）：
   * - 锚点没渲染时**不能直接 finish**（那样下面的精修永远跑不到，等于只做像素还原）；
   * - **不能拿"展示集签名不一致"当静默放弃的理由**：签名只是像素值的可信度检查，锚点 id 自带
   *   唯一性、位置又是实测的，压根不需要签名——用它当闸门会导致"还原根本没发生"，
   *   表现成"每张图返回都停在同一个地方（顶部）"。
   */
  useLayoutEffect(() => {
    if (phase !== "ready") {
      restoreDoneRef.current = false; // 进扫描态后重新就绪允许再还原一次
      restorePendingRef.current = false;
      return;
    }
    if (restoreDoneRef.current || restorePendingRef.current) return; // 已处理 / 还原循环在跑
    // 展示集取自 store（非响应式读取）：visibleIds 在上文展示集 effect 里已同步，
    // 订阅它只会给滚动中的每次写入都换来一次本组件重渲染。它同时提供"锚点排第几"。
    const ids = useLibraryStore.getState().visibleIds;
    const sig = viewSignature(ids, ids.length);
    /**
     * 快照选择：①「打开详情前的瀑布流位置」（用户口径：返回就落回这里，它在覆盖层出现前
     * 测得）；②最近一次滚动位置，兜底。有锚点 id 即可用（位置实测）；没有锚点 id 时才要求
     * 像素值可信（>0 且签名一致），否则无从定位。
     */
    const usable = (p: BrowsePos | null): BrowsePos | null => {
      if (!p) return null;
      if (p.anchorId) return p;
      return p.scrollTop > 0 && p.sig === sig ? p : null;
    };
    const pre = usable(preDetailPos);
    const saved = pre ?? usable(browsePos);
    if (!saved) {
      // 真正无从定位（无锚点且无可信像素）：不还原，也不拦展示集 effect 写入
      restoreDoneRef.current = true;
      restorePendingRef.current = false;
      setScrollBusy(false);
      return;
    }
    if (pre) savePreDetailPos(null); // 一次性消费，避免以后被误用
    const el = pageRef.current;
    if (!el) return; // 网格尚未挂载，本帧不处理（等下一次 render 再试）
    restorePendingRef.current = true;
    setScrollBusy(true); // 定位期间先藏网格（layout 阶段设，首帧绘制前生效）
    /** 锚点在展示集中的序号（瀑布流按比例估算落点用）；-1 = 不在当前展示集 */
    const anchorIndex = saved.anchorId ? ids.indexOf(saved.anchorId) : -1;
    let tries = 0;
    let settle = 0;
    /** 上一帧的容器总高：连续两帧不变才算"布局定型"（列宽/上方行高变过就不能定案） */
    let prevScrollHeight = -1;
    let stableFrames = 0;
    /** 定位探针：锚点格子还没进 DOM 时，按顺序逐个试（每帧一个） */
    const probes: number[] = [];
    const pushProbe = (v: number | null) => {
      if (v == null) return;
      if (v < 0) return;
      if (probes.some((p) => Math.abs(p - v) < 2)) return;
      probes.push(v);
    };
    pushProbe(saved.scrollTop > 0 ? saved.scrollTop : null);
    let lastSet = -1;
    const finish = (_via: string) => {
      restorePendingRef.current = false;
      restoreDoneRef.current = true;
      setScrollBusy(false);
    };
    /** 锚点格子当前在容器坐标系里的顶边（与当前滚动无关）；还没进 DOM 返回 null */
    const anchorDocTop = (node: HTMLElement): { top: number } | null => {
      if (!saved.anchorId) return null;
      const grid = node.querySelector<HTMLElement>(".lib-grid");
      if (!grid) return null;
      for (const cell of grid.querySelectorAll<HTMLElement>("[data-cell-id]")) {
        if (cell.dataset.cellId !== saved.anchorId) continue;
        const gridDocTop =
          grid.getBoundingClientRect().top -
          node.getBoundingClientRect().top +
          node.scrollTop;
        return { top: gridDocTop + cell.offsetTop };
      }
      return null; // 锚点还没进渲染窗口
    };
    const apply = () => {
      const node = pageRef.current;
      if (!node) {
        finish("无容器");
        return;
      }
      // 用户自己往下滚了（本循环只做小幅纠正/探针跳转）：立刻收工，不抢滚动
      if (lastSet >= 0 && node.scrollTop - lastSet > 1200) {
        finish("用户接管");
        return;
      }
      const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
      // 布局定型判定：容器总高连续两帧不变，才认为"列宽/上方行高都定了"
      const stable = node.scrollHeight === prevScrollHeight;
      prevScrollHeight = node.scrollHeight;
      stableFrames = stable ? stableFrames + 1 : 0;
      const anchor = anchorDocTop(node);
      if (anchor) {
        // 锚点已在 DOM 里：按它实测位置精修（这一步才是准的）
        const target = anchor.top - saved.anchorTop;
        if (target > maxScroll) {
          // 锚点已渲染 ⇒ 容器总高已定型，target 放不下就是内容确实变短：按钳后值落定
          node.scrollTop = maxScroll;
          lastSet = node.scrollTop;
          setScrollTop(node.scrollTop);
          finish("内容变短·钳后落定");
          return;
        }
        if (Math.abs(node.scrollTop - target) > 0.5) {
          node.scrollTop = target;
          lastSet = node.scrollTop;
          setScrollTop(node.scrollTop);
        }
        const aligned = Math.abs(node.scrollTop - target) <= 1;
        // **布局定型后才允许定案**：容器宽是 ResizeObserver 异步量的，早对齐可能对在"旧布局"上
        //（列宽差一点点，越往下累积越偏——实测"上方准、往下就偏"就是这个）
        settle = aligned && stableFrames >= 2 ? settle + 1 : 0;
        if (aligned && stableFrames >= 2 && settle >= RESTORE_SETTLE_FRAMES) {
          finish("锚点对齐");
          return;
        }
      } else if (!saved.anchorId) {
        // 没有锚点 id（那一刻网格没渲染任何格子）：只能按像素落定
        node.scrollTop = Math.min(saved.scrollTop, maxScroll);
        lastSet = node.scrollTop;
        setScrollTop(node.scrollTop);
        finish("无锚点·像素落定");
        return;
      } else {
        // 锚点还没进 DOM：换个落点把它的渲染窗口带出来。探针顺序：
        // 存下的像素 → 按"锚点排第几 / 共几条"折算总高（瀑布流近似线性）→ 其邻近位置
        if (probes.length === 0 && anchorIndex >= 0 && maxScroll > 0) {
          const ratio = Math.round((anchorIndex / Math.max(1, ids.length)) * maxScroll);
          pushProbe(ratio);
          pushProbe(ratio + 1200);
          pushProbe(ratio - 1200);
          pushProbe(ratio + 2400);
          pushProbe(ratio - 2400);
        }
        // 只有真的用上了才出队——容器还没高时不能把探针白白丢掉
        const next = probes[0];
        if (next != null && next <= maxScroll) {
          probes.shift();
          node.scrollTop = next;
          lastSet = node.scrollTop;
          setScrollTop(node.scrollTop);
        }
        if (probes.length === 0 && tries > MAX_RESTORE_TRIES) {
          finish("找不到锚点·像素落定");
          return;
        }
      }
      if (tries < MAX_RESTORE_TRIES) {
        tries += 1;
        requestAnimationFrame(apply);
        return;
      }
      // 兜底：帧数用尽仍没对到锚点，按像素值落定
      node.scrollTop = Math.min(saved.scrollTop, Math.max(0, maxScroll));
      setScrollTop(node.scrollTop);
      finish("超帧·像素落定");
    };
    apply();
  }, [phase, browsePos, preDetailPos, gridItems.length, savePreDetailPos]);

  // M3.4.5 向量引擎生命周期：
  // - 切到向量模式（含首启即向量）→ 立即 sync 一轮（R4.2 触发点 1）；
  // - 每 30s 自检（页面可见时），Ollama 由红转绿 → sync（R4.2 触发点 2 + R6.2 指示灯刷新）；
  // - 搜索框聚焦 / 识图队列空闲 → 节流 30s sync（R4.2 触发点 3/4）；
  // - searchQuery 变化 → 预热 query 向量（R6.1，缓存命中不重嵌）。
  const prevEngineRef = useRef(vectorStatus.engine);
  const prevOllamaOkRef = useRef(vectorStatus.ollamaOk);
  const lastAutoSyncRef = useRef(0);
  const prevVisionRunningRef = useRef(false);

  /** 自动 sync（节流 30s；force 跳过节流，用于模式切换即时触发） */
  const maybeSync = (force = false): void => {
    const st = vectorStore.getVectorStatus();
    if (st.engine !== "vector" || !st.ollamaOk) return;
    const now = Date.now();
    if (!force && now - lastAutoSyncRef.current < 30_000) return;
    lastAutoSyncRef.current = now;
    void vectorStore.syncEmbeddings(useLibraryStore.getState().items);
  };

  useEffect(() => {
    const nowEngine = vectorStatus.engine;
    if (nowEngine === "vector" && prevEngineRef.current !== "vector") {
      void vectorStore.selfCheckOllama().then(() => maybeSync(true));
    }
    prevEngineRef.current = nowEngine;
  }, [vectorStatus.engine]);

  useEffect(() => {
    if (vectorStatus.engine !== "vector") return;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      void vectorStore.selfCheckOllama().then(() => {
        const st = vectorStore.getVectorStatus();
        if (st.ollamaOk && !prevOllamaOkRef.current) maybeSync(true); // 红→绿
        prevOllamaOkRef.current = st.ollamaOk;
      });
    };
    tick();
    const timer = window.setInterval(tick, 30_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- maybeSync 引用最新状态戳
  }, [vectorStatus.engine]);

  // 搜索框聚焦（节流 30s）与识图队列空闲 → sync
  const visionRunning = useLibraryStore((s) => s.vision.running);
  useEffect(() => {
    const curVisionRunning = visionRunning;
    if (searchFocused) maybeSync();
    if (prevVisionRunningRef.current && !curVisionRunning) maybeSync();
    prevVisionRunningRef.current = curVisionRunning;
  }, [searchFocused, visionRunning]);

  // 编辑出口检测（2026-09 用户口径）：退出多选 / 关闭详情页时，若本次**真改过** tag/备注/描述
  // （store 脏标记）才触发一轮 force sync——让改动立刻可向量搜索。单纯进出编辑界面不触发
  // （零开销，不跑全库比对）；词典模式 / Ollama 离线由 maybeSync 内部守卫自动忽略。
  const prevSelectModeRef = useRef(selectMode);
  const prevDetailIdRef = useRef(detailId);
  useEffect(() => {
    const leftMultiSelect = prevSelectModeRef.current && !selectMode;
    const leftDetail = !!prevDetailIdRef.current && !detailId;
    prevSelectModeRef.current = selectMode;
    prevDetailIdRef.current = detailId;
    if ((leftMultiSelect || leftDetail) && takeItemsTextEdited()) maybeSync(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- maybeSync 引用最新状态戳
  }, [selectMode, detailId]);

  // query 向量预热：向量模式 + Ollama 在线 + 有文本查询 → 异步嵌入并缓存（LRU 8 条）
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) return;
    const st = vectorStore.getVectorStatus();
    if (st.engine !== "vector" || !st.ollamaOk) return;
    void vectorStore.ensureQueryVector(q);
  }, [searchQuery, vectorStatus.engine, vectorStatus.ollamaOk]);

  // 切库：向量内存与 query 缓存随库清空（防串库），切换后向量模式自动补一轮 sync
  const libraryId = current?.libraryId ?? null;
  const prevLibraryIdRef = useRef(libraryId);
  useEffect(() => {
    if (libraryId !== prevLibraryIdRef.current) {
      prevLibraryIdRef.current = libraryId;
      vectorStore.onLibraryChanged();
      if (vectorStatus.engine === "vector") void vectorStore.syncEmbeddings(useLibraryStore.getState().items);
    }
  }, [libraryId, vectorStatus.engine]);

  // 悬浮岛显隐：向下滚收起；只有滚回顶部才从上方滑出；鼠标移到页面上方也显示
  // M3.6：同一监听里把浏览位置实时存进 store（局部态只喂虚拟网格，store 那份供跨路由还原）。
  // 注意：**卸载清理里不能读 el.scrollTop**——React 先在 mutation 阶段把节点摘出文档，
  // 之后才跑 passive cleanup，脱离文档的节点 scrollTop 恒为 0，一读就把正确位置冲成 0。
  // 滚动事件每次都存，已足够留住位置，故清理不再回写。
  useEffect(() => {
    const el = pageRef.current;
    if (!el || phase !== "ready") return;
    const onScroll = () => {
      const st = useLibraryStore.getState();
      setScrollTop(el.scrollTop);
      st.saveBrowsePos({
        scrollTop: el.scrollTop,
        sig: viewSignature(st.visibleIds, st.visibleIds.length),
        ...captureAnchor(el),
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [phase]);

  useEffect(() => {
    const onMouseMove = (event: MouseEvent) => {
      // 热区覆盖工具栏两行全高（顶栏 48 + 工具栏约 124），保证收起后
      // 鼠标移到「高级筛选」等按钮位置也能恢复工具栏（2026-08 用户反馈）
      setMouseAtTop(event.clientY <= 176);
    };
    window.addEventListener("mousemove", onMouseMove);
    return () => window.removeEventListener("mousemove", onMouseMove);
  }, []);

  // 视口高度供虚拟网格用（窗口 resize 时更新）
  useEffect(() => {
    const measure = () => {
      const el = pageRef.current;
      if (el) setViewportHeight(el.clientHeight);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [phase]);

  // Esc 层级：编辑小窗 > 选择集 > 多选模式 > 详情（编辑小窗自理并 stopPropagation；
  // 详情分支 setDetail(null) 后走离场动画：200ms 播完由挂载 effect 卸载）
  //
  // 2026-09-17 修复「跨图库只读详情页按 Esc 无反应」：只读查看态存在 LibraryPage 的组件态
  // `foreignView` 里，**从不写 store.detailId**，而原分支只判 `st.detailId` → 只读详情页
  // Esc 落空（同 openForeign 的设计：不切库、不动 store）。故详情分支改为二者任一即关闭，
  // 语义与 onClose 的 `if (foreignView) … else setDetail(null)` 保持一致。
  useEffect(() => {
    if (phase !== "ready") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (document.querySelector(".lib-edit")) return;
      const st = useLibraryStore.getState();
      if (st.selectedIds.size > 0) st.clearSelection();
      else if (st.selectMode) st.setSelectMode(false);
      else if (foreignView) {
        setForeignView(null);
        setDetailOrigin(null);
      } else if (st.detailId) st.setDetail(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // foreignView 进出才重建监听（开关详情各一次，代价可忽略），换图不动它
  }, [phase, foreignView]);

  // 多选小窗动画挂载：进入立即挂载（弹出动画），退出先播收回动画再卸载
  useEffect(() => {
    if (selectMode) {
      if (panelLeaveTimer.current) {
        clearTimeout(panelLeaveTimer.current);
        panelLeaveTimer.current = null;
      }
      setPanelMounted(true);
      setPanelLeaving(false);
      return;
    }
    if (!panelMounted) return;
    setPanelLeaving(true);
    panelLeaveTimer.current = setTimeout(() => {
      panelLeaveTimer.current = null;
      setPanelMounted(false);
      setPanelLeaving(false);
    }, 200);
    return () => {
      if (panelLeaveTimer.current) clearTimeout(panelLeaveTimer.current);
    };
  }, [selectMode, panelMounted]);

  // 详情覆盖层动画挂载：进入立即挂载（FLIP 由 DetailView 承接），
  // 退出先播离场动画再卸载；期间网格保持挂载（浏览位置保留的依据）
  // PR-007：跨图库只读查看共用本覆盖层挂载（detailId 与 foreignView 任一存在即挂载）
  useEffect(() => {
    if (detailId || foreignView) {
      if (detailLeaveTimer.current) {
        clearTimeout(detailLeaveTimer.current);
        detailLeaveTimer.current = null;
      }
      setDetailMounted(true);
      setDetailLeaving(false);
      return;
    }
    if (!detailMounted) return;
    setDetailLeaving(true);
    detailLeaveTimer.current = setTimeout(() => {
      detailLeaveTimer.current = null;
      setDetailMounted(false);
      setDetailLeaving(false);
      setDetailOrigin(null);
    }, 200);
    return () => {
      if (detailLeaveTimer.current) clearTimeout(detailLeaveTimer.current);
    };
  }, [detailId, foreignView, detailMounted]);

  if (phase === "unsupported") {
    return (
      <div className="lib-page">
        <div className="lib-empty">
          <div className="lib-empty__card">
            <FolderIcon />
            <h2 className="lib-empty__title">当前浏览器不支持本地文件夹绑定</h2>
            <p className="lib-empty__hint">
              需要 Chromium 系浏览器（如 Chrome / Edge）。
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "need-permission") {
    return (
      <div className="lib-page">
        <div className="lib-empty">
          <div className="lib-empty__card">
            <FolderIcon />
            <h2 className="lib-empty__title">需要重新授权</h2>
            <p className="lib-empty__hint">
              浏览器需要重新授权才能访问「{current?.name}」文件夹。
            </p>
            <button
              type="button"
              className="lib-empty__btn lib-empty__btn--primary"
              onClick={() => void authorizeCurrent()}
            >
              重新授权
            </button>
            <button
              type="button"
              className="lib-empty__btn"
              onClick={() => void bindNewLibrary()}
            >
              重新定位目录
            </button>
            <LibraryQuickList />
          </div>
        </div>
      </div>
    );
  }

  if (phase === "missing") {
    return (
      <div className="lib-page">
        <div className="lib-empty">
          <div className="lib-empty__card">
            <FolderIcon />
            <h2 className="lib-empty__title">图库目录不可访问</h2>
            <p className="lib-empty__hint">
              找不到「{current?.name ?? ""}」的文件夹（可能已被移动、重命名或断开）。
              重新定位到该文件夹的新位置可保留索引与标签；无法找回时也可移除该绑定。
            </p>
            <button
              type="button"
              className="lib-empty__btn lib-empty__btn--primary"
              onClick={() => void bindNewLibrary()}
            >
              重新定位目录
            </button>
            <button
              type="button"
              className="lib-empty__btn"
              onClick={() => {
                if (!current) return;
                void confirmDialog({
                  title: "移除绑定",
                  message:
                    "确定移除「" +
                    current.name +
                    "」的绑定？磁盘上的图片与 .ystk 索引不会被删除。",
                  confirmText: "移除",
                  danger: true,
                }).then((ok) => {
                  if (ok) void unbind(current.libraryId);
                });
              }}
            >
              移除绑定
            </button>
            <LibraryQuickList />
          </div>
        </div>
      </div>
    );
  }

  if (phase === "unbound") {
    return (
      <div className="lib-page">
        <div className="lib-empty">
          <div className="lib-empty__card">
            <FolderIcon />
            <h2 className="lib-empty__title">绑定本地文件夹开始建立图库</h2>
            <p className="lib-empty__hint">
              索引随文件夹走（.ystk/），不会移动或修改你的图片。
            </p>
            <button
              type="button"
              className="lib-empty__btn lib-empty__btn--primary"
              onClick={() => void bindNewLibrary()}
            >
              绑定本地文件夹
            </button>
            <LibraryQuickList
              onRemove={(lib) => {
                void confirmDialog({
                  title: "移除绑定",
                  message:
                    "确定移除该图库的绑定？磁盘上的图片与 .ystk 索引不会被删除。",
                  confirmText: "移除",
                  danger: true,
                }).then((ok) => {
                  if (ok) void unbind(lib.libraryId);
                });
              }}
            />
          </div>
        </div>
      </div>
    );
  }

  if (phase === "binding" || phase === "scanning") {
    const progressPct =
      scan.total > 0
        ? Math.min(100, Math.round((scan.done / scan.total) * 100))
        : 0;
    return (
      <div className="lib-page">
        <div className="lib-empty">
          <div className="lib-empty__card">
            <h2 className="lib-empty__title">
              {phase === "binding"
                ? "正在准备图库…"
                : `正在扫描「${current?.name ?? ""}」`}
            </h2>
            <div className="lib-scan__readout">
              {scan.total > 0 ? (
                <>
                  {scan.done} / {scan.total} 张 · {scan.perSecond} 张/秒
                </>
              ) : (
                <>
                  已扫描 {scan.done} 张 · {scan.perSecond} 张/秒
                </>
              )}
            </div>
            {scan.total > 0 && (
              <div className="lib-scan__track">
                <div
                  className="lib-scan__bar"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            )}
            {phase === "scanning" && (
              <div className="lib-scan__actions">
                {scan.paused ? (
                  <button
                    type="button"
                    className="lib-empty__btn lib-empty__btn--primary"
                    onClick={resumeScan}
                  >
                    继续
                  </button>
                ) : (
                  <button type="button" className="lib-empty__btn" onClick={pauseScan}>
                    暂停
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // 收起阈值 = 100px：轻微滚动不收起，滚到 100px 即让位给内容；
  // 高级筛选/识图设置展开期间不收起（保证搜索行按钮/设置面板始终可点可读，
  // 面板锚在工具栏下方，工具栏收起会带跑面板；见 design.md §7.9）
  // 搜索框聚焦期间不收起（M3.4 修复 2026-08：点击搜索框输入时搜索栏保持伸出）
  // （2026-08 用户反馈两轮：24px 太敏感点不到高级筛选 → 120px → 定稿 100px）
  const toolbarCollapsed =
    !filterOpen && !settingsOpen && !searchFocused && scrollTop >= 100 && !mouseAtTop;

  return (
    <div className="lib-page" ref={pageRef}>
      <div
        ref={toolbarRef}
        className={"lib-toolbar" + (toolbarCollapsed ? " is-collapsed" : "")}
      >
        <div className="lib-toolbar__row">
          <div className="lib-toolbar__info">
            <span className="lib-toolbar__name">{current?.name ?? "参考图库"}</span>
            <span className="lib-toolbar__count">
              {current?.itemCount ?? 0} 张
            </span>
          </div>
          <div className="lib-toolbar__actions">
            {phase === "ready" && scan.running && (
              <div className="lib-analysis">
                <span className="lib-analysis__readout">
                  扫描中 {scan.done} 张
                </span>
              </div>
            )}
            {analysis.running && (
              <div className="lib-analysis">
                <span className="lib-analysis__readout">
                  {analysis.stage === "thumbs" ? "缩略图" : "分析"}{" "}
                  {analysis.done}/{analysis.total} · {analysis.perSecond} 张/秒 ·
                  约 {formatEta(analysis.etaSeconds)}
                  {analysis.failed > 0 ? ` · ${analysis.failed} 张失败` : ""}
                </span>
                {analysis.paused ? (
                  <button
                    type="button"
                    className="lib-toolbar__btn"
                    onClick={resumeAnalysis}
                  >
                    继续
                  </button>
                ) : (
                  <button
                    type="button"
                    className="lib-toolbar__btn"
                    onClick={pauseAnalysis}
                  >
                    暂停
                  </button>
                )}
              </div>
            )}
            <button
              type="button"
              className={
                "lib-toolbar__btn" + (selectMode ? " lib-toolbar__btn--primary" : "")
              }
              title="多选模式（Ctrl+点击图片也可进入）"
              onClick={() => setSelectMode(!selectMode)}
            >
              多选
            </button>
            <select
              className="lib-toolbar__select"
              aria-label="排序方式"
              value={sortKey}
              onChange={(e) => setSort(e.target.value as SortKey, sortDir)}
            >
              <option value="mtime">时间</option>
              <option value="name">文件名</option>
              <option value="luma">明度</option>
              <option value="sat">饱和度</option>
            </select>
            <button
              type="button"
              className="lib-toolbar__btn"
              title={sortDir === "asc" ? "升序" : "降序"}
              onClick={() =>
                setSort(sortKey, sortDir === "asc" ? "desc" : "asc")
              }
            >
              {sortDir === "asc" ? "↑" : "↓"}
            </button>
            <select
              className="lib-toolbar__select"
              aria-label="切换图库"
              value={current?.libraryId ?? ""}
              onChange={(e) => void switchTo(e.target.value)}
            >
              {libraries.map((lib) => (
                <option key={lib.libraryId} value={lib.libraryId}>
                  {lib.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="lib-toolbar__btn"
              onClick={() => void rescan()}
            >
              重新扫描
            </button>
            <button
              type="button"
              className="lib-toolbar__btn lib-toolbar__btn--primary"
              onClick={() => void bindNewLibrary()}
            >
              绑定新图库
            </button>
            <button
              ref={gearRef}
              type="button"
              className={
                "lib-toolbar__btn lib-toolbar__btn--gear" +
                (settingsOpen ? " is-active" : "")
              }
              aria-label="识图设置"
              title="识图设置"
              onClick={() => setSettingsOpen(!settingsOpen)}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
              </svg>
            </button>
          </div>
        </div>
        <SearchBar />
      </div>
      <FilterBar />
      <SettingsPanel toolbarRef={toolbarRef} />
      <VisionWidget />
      <CrossHint />
      {searchActive && (hasQuery || imageQuery) && (
        /* 命中数行（用户 2026-09-15 口径）：当前库命中 + 各跨库命中**同一行**、逐库带库名，
           不再另起"其它图库还有 N 张"的指引行；跨库关闭时只剩当前库一段。
           跨库段是**跳转按钮**（跳到该库结果块）；0 命中的库没有可跳目标，仍是纯文本。
           2026-09-26 用户口径两处修订：① 图片轨命中段不再显示"以图搜图"字样，只报张数
           （当前库名同理不显示）；② 该行只在**检索轨**（文本 query / 图片 query）激活时出现
           ——只勾筛选器时不再多这一行（旧行为是 searchActive 即显示）。
           图片轨命中数取**阈值内全量**（`imageHitItems`）而非已展示切片（`gridItems`）——
           否则"24 张命中"与下方按钮"还有 12 张"两处对不上（用户 2026-09-26 指出）。 */
        <div className="lib-search__summary">
          <span className="lib-search__hit lib-search__hit--current">
            {hasQuery && !imageQuery ? `${current?.name ?? "当前图库"} ` : ""}
            {imageShownCount} 张命中
          </span>
          {cross.groups.map((g) =>
            g.totalHits > 0 ? (
              <button
                key={g.libraryId}
                type="button"
                className="lib-search__hit lib-search__hit--link"
                title={`跳到「${g.name}」的结果`}
                onClick={() => scrollToCrossGroup(g.libraryId)}
              >
                {g.name} {g.totalHits} 张命中
              </button>
            ) : (
              <span key={g.libraryId} className="lib-search__hit">
                {g.name} {g.totalHits} 张命中
              </span>
            ),
          )}
        </div>
      )}
      {searchActive && gridItems.length === 0 ? (
        <div className="lib-search__empty">
          {imageQuery ? IMAGE_QUERY_EMPTY_HINT : "没有匹配的图片"}
        </div>
      ) : (
      <>
      <OverviewGrid
        items={gridItems}
        scrollTop={scrollTop}
        viewportHeight={viewportHeight}
        hidden={scrollBusy}
        hits={imageSearched ? imageSearched.hits : hasQuery ? searched.hits : undefined}
        colorFilter={colorFilter}
        temperature={temperature}
        onSwatchPick={handleSwatchPick}
        onOpen={(id, rect) => {
          setDetailOrigin(rect);
          setDetail(id);
        }}
      />
      {imageQuery != null && imageMoreCount > 0 && (
        <div className="lib-search__more-wrap">
          <button
            type="button"
            className="lib-search__more"
            onClick={() => setVisibleCount((n) => n + IMAGE_QUERY_BATCH)}
          >
            加载更多（还有 {imageMoreCount} 张）
          </button>
        </div>
      )}
      </>
      )}
      {/* PR-007：跨库结果块移到当前库网格**下方**（分组瀑布流；格子 UI 与主网格同一份覆盖层）；
          点格子**只读打开该图**（不切库、不跳转），见 openForeign */}
      <CrossResults onSwatchPick={handleSwatchPick} onOpenForeign={openForeign} />
      {panelMounted && <BatchPanel leaving={panelLeaving} />}
      {detailMounted && (
        <DetailView
          items={gridItems}
          leaving={detailLeaving}
          origin={detailOrigin}
          foreign={
            foreignView
              ? {
                  libraryId: foreignView.libraryId,
                  libraryName: foreignView.libraryName,
                  items: foreignView.items,
                  index: foreignView.index,
                  onIndex: (index) =>
                    setForeignView((v) => (v ? { ...v, index } : v)),
                }
              : null
          }
          onItemTurns={(id, count) => {
            const next = { id, turns: count };
            pendingRotationRef.current = next;
            /* 同步进 state：`onClose` 闭包取自**最近一次渲染**，只写 ref 它读到的会是旧值 */
            setPendingRotation(next);
          }}
          onClose={() => {
            // PR-007：只读查看关闭 = 只清 foreignView（store 全程未被改动，无需复位）
            if (foreignView) {
              setForeignView(null);
              setDetailOrigin(null);
              return;
            }
            // M3.7：退出详情页 = 旋转落盘时机（详情页内只做内存旋转）。
            // 先 setDetail(null) 让离场动画立刻起步，落盘在后台跑完（写盘 + 重生成
            // 缩略图 → items 的 mtime 变化触发网格 Thumb 重读，即"缩略图与网格同步"）。
            setDetail(null);
            if (!pendingNow || pendingNow.turns % 4 === 0) return;
            void flushRotationNow().then((written: boolean) => {
              if (written) toast("已旋转并保存原图");
            });
          }}
        />
      )}
    </div>
  );
}

/* eslint-disable no-console -- dev 验收钩子 */
if (import.meta.env.DEV) {
  /**
   * 验收 mock（仅 dev）：注入 n 条假条目到 store.items 展示层，
   * 严禁触碰 indexFile/磁盘；0 恢复真实数据。
   */
  window.__ystkLibraryMock = (n: number) => {
    if (n <= 0) {
      useLibraryStore.setState({
        items: indexFile.listItems(),
        detailId: null,
        selectedIds: new Set<string>(),
        selectMode: false,
      });
      return;
    }
    const pool = ["人像", "夜景", "街拍", "风光", "建筑", "静物", "抽象", "黑白"];
    const now = Date.now();
    const yearMs = 365 * 24 * 3600 * 1000;
    const rand = (min: number, max: number) =>
      min + Math.floor(Math.random() * (max - min + 1));
    const hex = (v: number) => v.toString(16).padStart(2, "0");
    const mock: LibraryIndexItem[] = Array.from({ length: n }, (_, i) => {
      const tags: LibraryIndexItem["tags"] = [];
      const tagCount = rand(0, 4);
      for (let t = 0; t < tagCount; t += 1) {
        const text = pool[rand(0, pool.length - 1)];
        if (!tags.some((x) => x.text === text)) {
          tags.push({ text, source: "manual" });
        }
      }
      const colors = Array.from({ length: 6 }, () => ({
        hex: `#${hex(rand(0, 255))}${hex(rand(0, 255))}${hex(rand(0, 255))}`,
        ratio: 1 / 6,
      }));
      return {
        id: `mock_${i}`,
        relPath: `mock/图片_${String(i).padStart(4, "0")}.jpg`,
        mtime: now - rand(0, yearMs),
        size: rand(100000, 5000000),
        width: rand(200, 4000),
        height: rand(200, 4000),
        meanLuma: rand(0, 1000) / 10,
        meanSat: rand(0, 1000) / 10,
        tone: (["low", "mid", "high"] as const)[rand(0, 2)],
        hiColor: { r: 255, g: 255, b: 255, hex: "#ffffff" },
        loColor: { r: 0, g: 0, b: 0, hex: "#000000" },
        phash: Math.floor(Math.random() * 0xffffffffffffffff)
          .toString(16)
          .padStart(16, "0"),
        colors,
        description: "",
        fields: {},
        extra: {},
        tags,
        note: "",
        starred: Math.random() < 0.1,
        analyzedAt: now,
        pipelineVersion: 3,
        thumb: null,
      };
    });
    useLibraryStore.setState({
      items: mock,
      detailId: null,
      selectedIds: new Set<string>(),
      selectMode: false,
      // 无绑定图库的诊断场景也要出网格：直接把阶段顶到 ready（仅 dev 钩子，不碰持久层）
      phase: "ready",
    });
    console.log(`[library] mock ${n} 条注入展示层`);
  };

  /**
   * M3.4 验收 fixture（20 条，逐字钉死，任务卡 §4.12）：
   * 行 = [id, relPath, tags, note, tone, meanLuma, meanSat, colors[[hex,ratio]…], hiHex, loHex]
   */
  const FIXTURE_ROWS: Array<
    [
      string,
      string,
      string[],
      string,
      "low" | "mid" | "high",
      number,
      number,
      Array<[string, number]>,
      string,
      string,
    ]
  > = [
    ["f01", "portrait/红裙人像.jpg", ["人像"], "studio 红裙", "mid", 62, 55, [["#d23c3c", 0.6], ["#f2e4d8", 0.4]], "#fff5ee", "#3a1f1f"],
    ["f02", "portrait/窗边少女.png", ["人像", "逆光"], "", "high", 78, 40, [["#f5e9d0", 0.7], ["#c98850", 0.3]], "#fffaf0", "#6b4a2a"],
    ["f03", "portrait/蓝调肖像.jpg", ["人像", "肖像"], "冷调", "mid", 45, 60, [["#2b5fd9", 0.5], ["#1a1f2e", 0.5]], "#dfe8ff", "#10131f"],
    ["f04", "portrait/猫与少女.jpg", ["人像", "猫"], "小猫入镜", "mid", 60, 50, [["#e8b04b", 0.6], ["#4a3b2c", 0.4]], "#fff2dd", "#2a2118"],
    ["f05", "night/霓虹街口.jpg", ["夜景", "霓虹"], "", "low", 22, 65, [["#d92bd0", 0.4], ["#131324", 0.6]], "#f5d9f2", "#0d0d1a"],
    ["f06", "night/城市夜色.jpg", ["夜景", "城市"], "夜拍", "low", 25, 55, [["#3b6fd9", 0.5], ["#0d1020", 0.5]], "#c9d9f2", "#0a0d18"],
    ["f07", "night/雨夜反光.jpg", ["夜景", "雨"], "雨夜", "low", 28, 50, [["#4a90d9", 0.5], ["#1c2438", 0.5]], "#cfe0f2", "#11182a"],
    ["f08", "night/星空营地.jpg", ["星空", "夜景"], "银河可见", "low", 15, 45, [["#232a4d", 0.7], ["#d9d9d9", 0.3]], "#e8ecf5", "#0a1a4d"],
    ["f09", "night/river/江边晚风.jpg", [], "傍晚江边", "low", 35, 40, [["#d9825f", 0.6], ["#2e2a3a", 0.4]], "#f2ddc9", "#1a1626"],
    ["f10", "street/清晨扫街.jpg", ["街拍"], "", "mid", 55, 35, [["#8c7a5f", 0.6], ["#3a3a3a", 0.4]], "#e8e0d2", "#24211c"],
    ["f11", "street/巷口咖啡馆.jpg", ["街拍", "咖啡馆"], "", "mid", 50, 45, [["#6b4a2f", 0.5], ["#d9c8a9", 0.5]], "#f2e8d8", "#241a12"],
    ["f12", "street/雨中行人.jpg", ["街拍", "雨"], "下雨天", "mid", 48, 40, [["#5f7d8c", 0.6], ["#2f3a42", 0.4]], "#d2dde5", "#1a2126"],
    ["f13", "landscape/雪山日出.jpg", ["风光", "山"], "", "high", 80, 45, [["#d9e2f2", 0.6], ["#8ca6c9", 0.4]], "#f5f9ff", "#3a4a63"],
    ["f14", "landscape/海边黄昏.jpg", ["风光", "海"], "海景", "mid", 58, 60, [["#f2a65f", 0.6], ["#7d5f8c", 0.4]], "#ffe8cc", "#2a2135"],
    ["f15", "landscape/梯田春色.jpg", ["风光"], "春天", "high", 75, 55, [["#7dd95f", 0.6], ["#3f7d3a", 0.4]], "#eef7e0", "#1f331d"],
    ["f16", "landscape/沙漠孤树.jpg", ["风光", "剪影"], "夕阳", "mid", 52, 50, [["#d9a05f", 0.7], ["#4d3a2a", 0.3]], "#f2dcc0", "#241b12"],
    ["f17", "misc/黑白糖果.jpg", ["黑白", "静物"], "", "mid", 50, 10, [["#d9d9d9", 0.5], ["#3a3a3a", 0.5]], "#f2f2f2", "#1a1a1a"],
    ["f18", "misc/建筑线条.jpg", ["建筑", "黑白"], "", "high", 82, 8, [["#f2f2f2", 0.5], ["#1a1a1a", 0.5]], "#ffffff", "#0d0d0d"],
    ["f19", "misc/办公桌.jpg", ["静物"], "咖啡杯", "mid", 57, 35, [["#c9b18c", 0.6], ["#5f4d3a", 0.4]], "#efe6d5", "#2a211a"],
    ["f20", "misc/傍晚天台.jpg", ["城市"], "夜色渐浓", "mid", 44, 45, [["#8c5fd9", 0.5], ["#2a1f3a", 0.5]], "#d9ccf2", "#161021"],
  ];

  const toRgbHex = (hex: string): RgbHex => {
    const rgb = hexToRgb(hex) ?? { r: 0, g: 0, b: 0 };
    return { r: rgb.r, g: rgb.g, b: rgb.b, hex };
  };

  const fixtureItems = (): LibraryIndexItem[] =>
    FIXTURE_ROWS.map((row, i) => {
      const [id, relPath, tags, note, tone, meanLuma, meanSat, colors, hiHex, loHex] =
        row;
      const mtime = 1_800_000_000_000 - i * 86_400_000;
      return {
        id,
        relPath,
        mtime,
        size: 1_000_000,
        width: 800,
        height: 600,
        meanLuma,
        meanSat,
        tone,
        hiColor: toRgbHex(hiHex),
        loColor: toRgbHex(loHex),
        phash: null,
        colors: colors.map(([hex, ratio]) => ({ hex, ratio })),
        description: "",
        fields: {},
        extra: {},
        tags: tags.map((text) => ({ text, source: "manual" as const })),
        note,
        starred: false,
        analyzedAt: mtime,
        pipelineVersion: 3,
        thumb: null,
      };
    });

  window.__ystkSearchFixture = () => {
    useLibraryStore.setState({
      items: fixtureItems(),
      detailId: null,
      selectedIds: new Set<string>(),
      selectMode: false,
    });
    console.log("[library] 检索 fixture 20 条注入");
  };

  window.__ystkSearchTest = async (query, temperature, extra) => {
    const criteria: SearchCriteria = {
      query,
      temperature,
      activeTags: extra?.activeTags ?? [],
      tagMode: extra?.tagMode ?? "and",
      toneFilter: extra?.toneFilter ?? [],
      warmthFilter: extra?.warmthFilter ?? [],
      colorFilter: extra?.colorFilter ?? null,
      folderScope: extra?.folderScope ?? null,
      starredOnly: extra?.starredOnly ?? false,
    };
    // M3.4.5 向量引擎：走当前装配——引擎=向量时先预热 query 向量再跑（幂等，LRU 缓存）
    const st = vectorStore.getVectorStatus();
    if (st.engine === "vector" && st.ollamaOk) {
      await vectorStore.ensureQueryVector(query);
    }
    const res = searchItems(
      useLibraryStore.getState().items,
      criteria,
      vectorStore.semanticFor(query),
    );
    const ids = res.items.map((item) => item.id).sort();
    console.log(`[library] searchTest "${query}" t=${temperature}`, JSON.stringify(ids));
    return ids;
  };

  window.__ystkSearchDebug = (query, temperature) => {
    const criteria: SearchCriteria = {
      query,
      temperature,
      activeTags: [],
      tagMode: "and",
      toneFilter: [],
      warmthFilter: [],
      colorFilter: null,
      folderScope: null,
      starredOnly: false,
    };
    const res = searchItems(
      useLibraryStore.getState().items,
      criteria,
      vectorStore.semanticFor(query),
    );
    return res.items.map((item) => ({
      id: item.id,
      reasons: res.hits.get(item.id)?.reasons ?? [],
      tags: item.tags.map((t) => t.text),
      base: item.relPath.split("/").pop(),
      note: item.note,
      desc: item.description,
      subject: String(item.fields.subject ?? ""),
    }));
  };

  // M3.4.3 R3 自然语言 fixture：8 条（id/relPath/tags/subject/scene/description，逐字钉死）
  const NL_FIXTURE_ROWS: Array<
    [string, string, string[], string, string, string]
  > = [
    ["n01", "nl/傍晚教室.jpg", ["教室", "少女"], "捧热茶的蓝发少女", "傍晚教室", "傍晚的教室里，蓝发少女捧着热茶坐在窗边，侧逆光勾出暖金轮廓，氛围安静治愈。"],
    ["n02", "nl/雨夜街道.jpg", ["夜景", "雨"], "雨夜街道霓虹倒影", "城市夜景", "雨夜的城市街道，霓虹灯在积水路面投下彩色倒影，行人撑伞匆匆走过。"],
    ["n03", "nl/雪山日出.jpg", ["风光", "雪山"], "雪山日出", "高山", "清晨的雪山之巅，第一缕阳光染红雪顶，云海在脚下翻涌。"],
    ["n04", "nl/沙漠孤树.jpg", ["风光", "剪影"], "沙漠孤树剪影", "沙漠黄昏", "黄昏沙漠里一棵孤独的树，夕阳把天空烧成橙红色，树的剪影立在沙丘上。"],
    ["n05", "nl/璃月港夜景.jpg", ["原神", "夜景"], "璃月港灯火", "璃月港", "璃月港的夜晚，万家灯火倒映在海面上，远处天衡山隐约可见。"],
    ["n06", "nl/咖啡馆.jpg", ["咖啡馆", "静物"], "拿铁拉花", "咖啡馆", "街角咖啡馆的木桌上，一杯拿铁的拉花是片叶子，午后阳光斜照进来。"],
    ["n07", "nl/键盘猫.jpg", ["猫", "日常"], "趴在键盘上的猫", "书桌", "一只橘猫趴在机械键盘上睡觉，屏幕的光照在它身上，尾巴垂在桌边。"],
    ["n08", "nl/技能特效.jpg", ["原神", "战斗"], "技能蓝光爆发", "深境螺旋", "角色释放元素爆发，蓝色光效充满画面，敌人被冻结在半空。"],
  ];
  window.__ystkSearchNLFixture = () => {
    const base = 1_800_000_000_000;
    const items: LibraryIndexItem[] = NL_FIXTURE_ROWS.map(
      ([id, relPath, tags, subject, scene, description], i) => ({
        id,
        relPath,
        mtime: base - i * 86_400_000,
        size: 1_000_000,
        width: 800,
        height: 600,
        meanLuma: 50,
        meanSat: 40,
        tone: "mid" as const,
        hiColor: toRgbHex("#e8e0d2"),
        loColor: toRgbHex("#24211c"),
        phash: null,
        colors: [{ hex: "#8c7a5f", ratio: 1 }],
        description,
        fields: { subject, scene },
        extra: {},
        tags: tags.map((text) => ({ text, source: "manual" as const })),
        note: "",
        starred: false,
        analyzedAt: base - i * 86_400_000,
        pipelineVersion: 3,
        thumb: null,
      }),
    );
    useLibraryStore.setState({
      items,
      detailId: null,
      selectedIds: new Set<string>(),
      selectMode: false,
    });
    console.log("[library] 自然语言 fixture 8 条注入");
  };

  // M3.4.5 向量引擎 dev 钩子（R6.3）：状态快照 / 手动 sync / 切引擎
  window.__ystkVectorStatus = () => {
    const st = vectorStore.getVectorStatus();
    return {
      engine: st.engine,
      ollamaOk: st.ollamaOk,
      embedded: st.embedded,
      dirty: st.dirty,
      model: st.ollamaModel ?? "",
      dims: st.dims,
    };
  };

  window.__ystkVectorSync = async () => {
    await vectorStore.syncEmbeddings(useLibraryStore.getState().items);
    const st = vectorStore.getVectorStatus();
    return {
      embedded: st.embedded,
      total: st.total,
      dirty: st.dirty,
      dims: st.dims,
    };
  };

  window.__ystkSetSearchEngine = async (mode) => {
    await saveVisionGlobal({ searchEngine: mode });
    await vectorStore.refreshSettings();
    if (mode === "vector") {
      // 与设置面板 patchVectorConfig 同口径：自检通过后触发一轮 sync
      await vectorStore.selfCheckOllama();
      if (vectorStore.getVectorStatus().ollamaOk) {
        await vectorStore.syncEmbeddings(useLibraryStore.getState().items);
      }
    }
  };

  window.__ystkVectorSearchIds = async (query, temperature, extra) => {
    const criteria: SearchCriteria = {
      query,
      temperature,
      activeTags: extra?.activeTags ?? [],
      tagMode: extra?.tagMode ?? "and",
      toneFilter: extra?.toneFilter ?? [],
      warmthFilter: extra?.warmthFilter ?? [],
      colorFilter: extra?.colorFilter ?? null,
      folderScope: extra?.folderScope ?? null,
      starredOnly: extra?.starredOnly ?? false,
    };
    const st = vectorStore.getVectorStatus();
    if (st.engine === "vector" && st.ollamaOk) {
      await vectorStore.ensureQueryVector(query);
    }
    const res = searchItems(
      useLibraryStore.getState().items,
      criteria,
      vectorStore.semanticFor(query),
    );
    return res.items.map((item) => item.id); // 相关度降序（向量组 top5 判定用）
  };

  /**
   * M3.2.2 一次性修复钩子（仅 dev）：全量重置条目并重载——修复两阶段拆分
   * （M3.2.1）之前的陈旧 thumb/尺寸：裁切/外部修改过但 mtime 已不再变化的
   * 条目，扫描的 mtime 重置分支（scan.ts:104-117）不会再触发，须此钩子
   * 强制重跑 Pass A/B。重载后缓存先行（R7）直接出网格，Pass A 全量重跑，
   * 渐进恢复。
   */
  window.__ystkReanalyzeAll = () => {
    const items = indexFile.listItems();
    for (const item of items) {
      indexFile.updateItem(item.id, {
        pipelineVersion: 0,
        thumb: null,
        width: null,
        height: null,
        analyzedAt: null,
      });
    }
    console.log(`[library] 已重置 ${items.length} 条，重新加载触发全量重分析`);
    location.reload();
  };

  // M3.5.3.5 验收（仅 dev）：缺口扫描摘要（store 当前 items + 本库字段配置）
  window.__ystkGapScan = () => {
    const res = scanLibraryGaps(
      useLibraryStore.getState().items,
      indexFile.getSettings().fieldConfig,
    );
    return {
      total: res.gaps.length,
      neverRunCount: res.neverRunCount,
      fieldGapCount: res.fieldGapCount,
      sample: res.gaps.slice(0, 5),
    };
  };

  registerVisionDevHooks();
  // M3.5.3.6 验收：识图任务帧是纯内存态（无磁盘夹具可造），CDP 脚本需要直接注入/读取
  useLibraryStore.getState().mountVisionTestStore();
}
