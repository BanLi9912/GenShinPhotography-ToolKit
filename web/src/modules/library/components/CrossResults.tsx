/**
 * M3.4 跨图库结果（PR-007 反馈重构；2026-09-15 用户会话内直令修订两处展示口径）：
 * 开关（设置中心 M3 分区，持久化偏好）开启且检索/筛选激活时，只读遍历其它已授权图库
 * （ensureEntryPermission(query-only) + indexFile.peekItems，不触激活态），同一 criteria
 * 跑 searchItems。结果写入 store（cross 内存态）：LibraryPage 的命中数行（当前库 + 各库，
 * 同一行、带库名）与 CrossResults（网格下方结果块）共读。
 *
 * 反馈口径（PR-007 裁定 + 用户 2026-09-15 修订）：
 * - active 时容器永远渲染：loading / 无命中 / 全部未授权 三态不再静默；
 * - **命中数不再单独起一行指引**，改为与当前库命中合并成一行、逐库带库名
 *   （用户口径："把本图库的命中和其他图库命中放在同一行，把具体图库名显示出来"）；
 * - 每组图片**沿用主网格的瀑布流**（同一列数断点、同一最短列逐个放置算法、同一
 *   格子/缩略图样式），不再做一套带文件名/库名底栏的自造卡片（用户口径："图片显示
 *   方式沿用瀑布流，不要单独做一个莫名其妙的UI"）；组标题只写库名；
 * - 每组默认 12 张，可一次展开全部、可收起（防大结果集把其它库推太深）；
 * - **并行加载（F5，2026-09-17）**：各库同时读取（原先串行，一个库卡住会拖死整体），
 *   每库完成即"渐进发布"到 store，逐库 15s 超时（对齐落盘护栏口径）——超时/读失败
 *   的库进 failed 名单并在结果区显示"已跳过"，其余库照常出结果。
 * - **图片轨跨库（2026-09-26 用户口径"跨图库搜索需要加上"）**：以图搜图态（`imageQuery`）
 *   下同一套并行/渐进/失败名单机制照跑，只是每库把 `searchItems` 换成
 *   `findSimilarWith(伪目标, 筛选幸存集, 温度档阈值, ∞)`——与当前库图片轨**同一阈值、
 *   同一排序口径**；组内命中理由/分数由伪 hits 提供，格子与结果块 UI 不变。
 *   （文本 query 与图片 query 天然互斥，同一时刻只有一条轨在跑。）
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as binding from "../index/binding";
import * as indexFile from "../index/indexFile";
import type { LibraryIndexItem } from "../index/indexFile";
import { searchItems, type ColorFilter, type SearchCriteria } from "../search/rank";
import {
  imageQueryFloorOf,
  imageQueryHitsOf,
  IMAGE_QUERY_EMPTY_HINT,
} from "../search/imageQuery";
import { IDLE_CROSS, useLibraryStore, type CrossGroup } from "../store";
import { computeColumnCount, GRID_EST_ASPECT, GRID_GAP } from "./gridLayout";
import { LibraryCellOverlay } from "./LibraryCellOverlay";
import { Thumb } from "./OverviewGrid";

/** 每组默认显示张数（PR-007 定稿） */
const CROSS_PREVIEW_COUNT = 12;

export function CrossResults({
  onSwatchPick,
  onOpenForeign,
}: {
  /** 点色直达结果：与主网格**共用同一个回调**（LibraryPage 提供），保证格子 UI 与交互一致 */
  onSwatchPick?: (hex: string, additive: boolean) => void;
  /**
   * 点跨库格子 → 只读打开该图（不切库、不跳转）。由 LibraryPage 提供；未提供时退回
   * 旧行为（切到该库 + pendingDetailId），以兼容其他挂载点。
   */
  onOpenForeign?: (
    libraryId: string,
    libraryName: string,
    items: LibraryIndexItem[],
    itemId: string,
    origin: DOMRect | null,
  ) => void;
} = {}) {
  const crossLibrary = useLibraryStore((s) => s.crossLibrary);
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
  const libraries = useLibraryStore((s) => s.libraries);
  const current = useLibraryStore((s) => s.current);
  const switchTo = useLibraryStore((s) => s.switchTo);
  const setPendingDetailId = useLibraryStore((s) => s.setPendingDetailId);
  const cross = useLibraryStore((s) => s.cross);
  const [authTick, setAuthTick] = useState(0);

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

  const anyFilter =
    activeTags.length > 0 ||
    toneFilter.length > 0 ||
    warmthFilter.length > 0 ||
    (colorFilter != null &&
      (colorFilter.row.colors.length > 0 ||
        colorFilter.hi.colors.length > 0 ||
        colorFilter.lo.colors.length > 0)) ||
    folderScope != null ||
    starredOnly;
  /** 有没有"其它图库"可搜（单库时整体不激活，由设置中心置灰拦截） */
  const hasOthers = libraries.some(
    (lib) => lib.libraryId !== current?.libraryId,
  );
  /**
   * 图片轨激活（2026-09-26）：粘贴图存在且跨库开关开、有其它图库可搜。
   * 文本档与图片档互斥（store 层 setImageQuery 清 searchQuery、输入文本清 imageQuery），
   * 故两者不会同时 active；判据仍套 filters-first 的 same 口径（筛选器在伪目标侧不适用，
   * 图片轨只吃"筛选幸存集"这一步，与当前库一致）。
   */
  const active =
    crossLibrary &&
    (imageQuery != null || searchQuery.trim() !== "" || anyFilter) &&
    hasOthers;

  useEffect(() => {
    if (!active) {
      useLibraryStore.setState({ cross: IDLE_CROSS });
      return;
    }
    let alive = true;
    useLibraryStore.setState({
      cross: { loading: true, groups: [], unauthorized: [], failed: [] },
    });
    // 图片轨阈值按温度档位现算一次（图片态下不随文本 criteria 变化，循环外取即可）
    const floor = imageQueryFloorOf(temperature);
    void (async () => {
      /** 逐库读取超时（对齐 SAVE_TIMEOUT_MS 口径）：只放弃等待，后台读仍是无害只读 */
      const PEEK_TIMEOUT_MS = 15_000;
      const results = new Map<string, CrossGroup>();
      const unauth: Array<{ libraryId: string; name: string }> = [];
      const failed: Array<{ libraryId: string; name: string }> = [];
      /** 渐进发布：每库完成即更新 store；组序固定按 libraries 顺序（命中数行与结果块稳定） */
      const publish = (loading: boolean) => {
        if (!alive) return;
        const groups = libraries
          .filter((l) => results.has(l.libraryId))
          .map((l) => results.get(l.libraryId)!);
        useLibraryStore.setState({
          cross: { loading, groups, unauthorized: [...unauth], failed: [...failed] },
        });
      };
      await Promise.all(
        libraries
          .filter((lib) => lib.libraryId !== current?.libraryId)
          .map(async (lib) => {
            try {
              const entry = binding.getEntry(lib.libraryId);
              if (!entry) return;
              const granted = await binding.ensureEntryPermission(entry, false);
              if (!granted) {
                // PR-007 修复：chip 记 id 而非 name（同名库不再错位）
                unauth.push({ libraryId: lib.libraryId, name: lib.name });
                publish(true);
                return;
              }
              const peeked = await Promise.race([
                indexFile.peekItems(entry.handle),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("peek timeout")), PEEK_TIMEOUT_MS),
                ),
              ]);
              const res = imageQuery
                ? imageQueryHitsOf(peeked, imageQuery.patch, floor)
                : searchItems(peeked, criteria);
              // 0 命中也入组：命中数行要如实显示每个库各中多少（结果区渲染时跳过）
              results.set(lib.libraryId, {
                libraryId: lib.libraryId,
                name: lib.name,
                totalHits: res.items.length,
                items: res.items,
                hits: res.hits,
              });
              publish(true);
            } catch {
              // 读超时/读失败：该库进失败名单（只影响本库，其余库结果照常出现）
              failed.push({ libraryId: lib.libraryId, name: lib.name });
              publish(true);
            }
          }),
      );
      // alive 已置 false（criteria 变化/组件卸载）时 publish 全部短路，终态也不发布
      publish(false);
    })();
    return () => {
      alive = false;
    };
  }, [active, libraries, current?.libraryId, criteria, authTick, imageQuery, temperature]);

  if (!active) return null;

  const authorize = async (libraryId: string) => {
    const entry = binding.getEntry(libraryId);
    if (!entry) return;
    await binding.ensureEntryPermission(entry, true);
    setAuthTick((t) => t + 1);
  };

  /**
   * 打开跨库条目：**默认只读打开**（不切当前库、不跳转）；仅在调用方没给 onOpenForeign
   * 时退回"切库 + pendingDetailId"的旧链路。
   */
  const openItem = (
    libraryId: string,
    libraryName: string,
    items: LibraryIndexItem[],
    itemId: string,
    origin: DOMRect | null,
  ) => {
    if (onOpenForeign) {
      onOpenForeign(libraryId, libraryName, items, itemId, origin);
      return;
    }
    setPendingDetailId(itemId);
    void switchTo(libraryId);
  };

  /** 只有真命中的库才出结果块（0 命中的库止于上方命中数行） */
  const hitGroups = cross.groups.filter((g) => g.totalHits > 0);

  return (
    <div className="lib-cross">
      {cross.loading && <p className="lib-cross__status">正在搜索其它图库…</p>}
      {!cross.loading &&
        hitGroups.length === 0 &&
        cross.unauthorized.length === 0 &&
        cross.failed.length === 0 && (
          <p className="lib-cross__status">
            {imageQuery ? IMAGE_QUERY_EMPTY_HINT : "其它图库无命中"}
          </p>
        )}
      {cross.failed.length > 0 && (
        <p className="lib-cross__status">
          以下图库读取超时或失败，已跳过：{cross.failed.map((f) => f.name).join("、")}
        </p>
      )}
      {hitGroups.map((group) => (
        <CrossGroupSection
          key={group.libraryId}
          group={group}
          colorFilter={colorFilter}
          temperature={temperature}
          onSwatchPick={onSwatchPick}
          openItem={openItem}
        />
      ))}
      {!cross.loading && cross.unauthorized.length > 0 && (
        <div className="lib-cross__unauth">
          <p className="lib-cross__status">
            以下图库未授权，点击授权后加入搜索：
          </p>
          {cross.unauthorized.map((u) => (
            <button
              key={u.libraryId}
              type="button"
              className="lib-cross__unauth-chip"
              onClick={() => void authorize(u.libraryId)}
            >
              {u.name}（未授权）
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 单库结果块：组标题（库名）+ 瀑布流（口径同主网格：最短列逐个放置 + Thumb + 同一份格子覆盖层） */
function CrossGroupSection({
  group,
  colorFilter,
  temperature,
  onSwatchPick,
  openItem,
}: {
  group: CrossGroup;
  colorFilter: ColorFilter | null;
  temperature: number;
  onSwatchPick?: (hex: string, additive: boolean) => void;
  openItem: (
    libraryId: string,
    libraryName: string,
    items: LibraryIndexItem[],
    itemId: string,
    origin: DOMRect | null,
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [columnCount, setColumnCount] = useState<number>(computeColumnCount);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 列数随窗口宽度变化（口径同主网格）
  useEffect(() => {
    const onResize = () => setColumnCount(computeColumnCount());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 容器宽度实测（ResizeObserver，与主网格同法）
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width > 0) setContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const shown = useMemo(
    () => (expanded ? group.items : group.items.slice(0, CROSS_PREVIEW_COUNT)),
    [expanded, group.items],
  );

  /**
   * 瀑布流布局纯计算（逐条放当前最矮列，口径同 OverviewGrid 主网格）。
   * 截断到前 12 张时前 12 张坐标与全量一致（逐条顺序放置），故"展开"是纯追加、不重排。
   * 朝向用条目自身的 width/height（跨库条目不参与当前库的内存旋转态）。
   */
  const { cells, totalHeight } = useMemo(() => {
    if (containerWidth <= 0) {
      return { cells: [] as FlowCell[], totalHeight: 0 };
    }
    const cols = columnCount;
    const colW = (containerWidth - (cols - 1) * GRID_GAP) / cols;
    const heights = new Array<number>(cols).fill(0);
    const layout: FlowCell[] = [];
    for (const item of shown) {
      let minIdx = 0;
      for (let i = 1; i < cols; i += 1) {
        if (heights[i] < heights[minIdx]) minIdx = i;
      }
      const h =
        item.width != null && item.height != null && item.width > 0
          ? colW * (item.height / item.width)
          : colW * GRID_EST_ASPECT;
      layout.push({
        item,
        x: minIdx * (colW + GRID_GAP),
        y: heights[minIdx],
        w: colW,
        h,
      });
      heights[minIdx] += h + GRID_GAP;
    }
    return { cells: layout, totalHeight: Math.max(0, ...heights) - GRID_GAP };
  }, [shown, columnCount, containerWidth]);

  const handle = binding.getEntry(group.libraryId)?.handle;

  return (
    <section className="lib-cross__group" data-cross-group={group.libraryId}>
      <h3 className="lib-cross__title">{group.name}</h3>
      <div
        ref={rootRef}
        className="lib-cross__flow"
        style={{ height: totalHeight }}
      >
        {cells.map(({ item, x, y, w, h }) => {
          const hit = group.hits.get(item.id);
          return (
            <div
              key={item.id}
              className="lib-cell"
              style={{
                position: "absolute",
                left: x,
                top: y,
                width: w,
                height: h,
              }}
              title={hit?.reasons.join(" · ") ?? item.relPath}
              onClick={(event) =>
                openItem(
                  group.libraryId,
                  group.name,
                  group.items,
                  item.id,
                  event.currentTarget.getBoundingClientRect(),
                )
              }
            >
              <Thumb
                handle={handle}
                relPath={item.relPath}
                alt={item.relPath}
                thumbRelPath={item.thumb}
                mtime={item.mtime}
              />
              {/* 色板/标签/命中理由/星标：与主网格同一份覆盖层（用户口径"所有图片的 UI 都一致"） */}
              <LibraryCellOverlay
                item={item}
                hit={hit}
                colorFilter={colorFilter}
                temperature={temperature}
                onSwatchPick={onSwatchPick}
              />
            </div>
          );
        })}
      </div>
      {group.totalHits > CROSS_PREVIEW_COUNT && (
        <button
          type="button"
          className="lib-cross__toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded
            ? `收起（回到 ${CROSS_PREVIEW_COUNT} 张）`
            : `显示全部 ${group.totalHits} 张`}
        </button>
      )}
    </section>
  );
}

/** 瀑布流格子（局部类型：与主网格 CellLayout 同形，只少旋转态） */
interface FlowCell {
  item: LibraryIndexItem;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 跨库检索进行中的加载提示（网格上方）；命中数由 LibraryPage 的命中数行（逐库带库名）显示 */
export function CrossHint() {
  const loading = useLibraryStore((s) => s.cross.loading);
  if (!loading) return null;
  return <p className="lib-cross-hint">正在搜索其它图库…</p>;
}
