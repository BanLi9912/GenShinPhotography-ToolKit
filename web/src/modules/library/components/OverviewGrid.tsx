/**
 * M3.3 总览虚拟瀑布网格：布局纯计算（无 onMeasured），只渲染视口窗口内的格，
 * 万级滚动不卡的验收依据。Thumb 迁入本文件并导出（DetailView 相似图横排复用）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { readFileBlob } from "../../../core/storage/fsa";
import { getEntry } from "../index/binding";
import type { LibraryIndexItem } from "../index/indexFile";
import type { SearchHit, ColorFilter } from "../search/rank";
import { pendingRotationsFor, rotatedDimsOf, useLibraryStore } from "../store";
import { confirmDialog } from "../../../ui/confirm";
import { LibraryCellOverlay } from "./LibraryCellOverlay";
import {
  computeColumnCount,
  GRID_EST_ASPECT,
  GRID_GAP,
} from "./gridLayout";
import {
  beginLibraryItemDrag,
  filesForItems,
  queueItemsToCanvas,
  sendItemsToLab,
  type SendOutRef,
} from "../sendOut";

const VIRTUAL_MARGIN = 1200;

/**
 * 缩略图（M3.3 重写）：网格只读缩略图、thumb 存在即显示（不再按格宽×DPR
 * 门槛筛选，见 load 注释）；IntersectionObserver 进场加载、objectURL 卸载
 * 回收、thumb 从无到有直接加载。
 */
export function Thumb({
  handle,
  relPath,
  alt,
  thumbRelPath,
  mtime,
}: {
  handle: FileSystemDirectoryHandle | undefined;
  relPath: string;
  alt: string;
  thumbRelPath: string | null;
  /** 条目 mtime：M3.7 旋转写盘后 thumb 同名重写（relPath 不变），靠它重跑加载换新图 */
  mtime: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const prevThumbRef = useRef<string | null>(thumbRelPath);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    let observer: IntersectionObserver | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let started = false;
    // 分析完成后 thumb 从无到有：直接加载（重渲染帧内 re-observe 的初始回调不可靠）
    const thumbAppeared = prevThumbRef.current === null && thumbRelPath !== null;
    prevThumbRef.current = thumbRelPath;

    const load = async () => {
      if (started || !handle) return;
      started = true;
      // 网格只读缩略图（M3.2.3）：原图回退在云盘环境等于每格几 MB 回源下载，
      // thumb 为 null 的格子逐格下载原图拖垮首屏（黑屏根因）——无 thumb =
      // 未分析/分析失败/损坏，保持占位等待 Pass A 或标记失败，不再读原图；
      // thumb 出现后经 items 刷新自动换上（thumbAppeared 直载机制）。
      // thumb 存在即显示：曾保留「thumb 短边 ≥ 格宽×DPR」宽度门槛，原图回退
      // 移除后该门槛只剩副作用——竖图/小图缩略图（长边 ≤960 时短边有限）在
      // 2x 屏或宽格下被挡成占位（用户反馈「有些图缩略图加载不出来」根因），
      // 故移除门槛、接受轻微放大；窄 thumb 远好于黑占位。
      // 连带：Thumb 被 DetailView 相似图横排复用，行为变更同生效（相似图格
      // 同样只读 thumb），属预期。
      if (!thumbRelPath) return; // 无缩略图：保持占位
      let file: File | null = null;
      try {
        file = await readFileBlob(handle, `.ystk/${thumbRelPath}`);
      } catch (err) {
        console.warn("[library] 缩略图读取失败", relPath, err);
      }
      if (!alive || !file) return;
      try {
        objectUrl = URL.createObjectURL(file);
      } catch {
        return; // 对象无法生成 URL（如损坏条目）：保持占位
      }
      setUrl(objectUrl);
    };

    const el = boxRef.current;
    if (!el || typeof IntersectionObserver === "undefined" || thumbAppeared) {
      void load();
    } else {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            observer?.disconnect();
            void load();
          }
        },
        { rootMargin: "600px 0px" },
      );
      observer.observe(el);
      // 兜底：挂载后短暂延迟若仍在视口内则直接加载（时序/环境差异下初始回调偶发不触发）
      fallbackTimer = setTimeout(() => {
        const rect = el.getBoundingClientRect();
        if (rect.top < window.innerHeight + 600 && rect.bottom > -600) {
          observer?.disconnect();
          void load();
        }
      }, 300);
    }

    return () => {
      alive = false;
      observer?.disconnect();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [handle, relPath, thumbRelPath, mtime]);

  return (
    <div ref={boxRef} className="lib-thumb">
      {url ? (
        <img
          className="lib-thumb__img"
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div className="lib-thumb__placeholder" aria-hidden="true" />
      )}
    </div>
  );
}

interface CellLayout {
  item: LibraryIndexItem;
  x: number;
  y: number;
  w: number;
  h: number;
}

export function OverviewGrid({
  items,
  scrollTop,
  viewportHeight,
  onOpen,
  hits,
  onSwatchPick,
  colorFilter,
  temperature,
  hidden,
}: {
  items: LibraryIndexItem[];
  scrollTop: number;
  viewportHeight: number;
  onOpen: (id: string, rect: DOMRect) => void;
  hits?: Map<string, SearchHit>;
  /** 色块点击：additive=true（Ctrl/⌘ 点击）加入取色行；否则替换全部取色 */
  onSwatchPick?: (hex: string, additive: boolean) => void;
  colorFilter?: ColorFilter | null;
  /** 搜索温度：命中图钉的 Lab 阈值随温度缩放（与筛选引擎一致） */
  temperature?: number;
  /** M3.6：还原浏览位置期间临时隐藏（visibility，不占位不变）——避免"先画顶部再跳" */
  hidden?: boolean;
}) {
  const selectedIds = useLibraryStore((s) => s.selectedIds);
  const selectMode = useLibraryStore((s) => s.selectMode);
  const toggleSelect = useLibraryStore((s) => s.toggleSelect);
  const enterSelectWith = useLibraryStore((s) => s.enterSelectWith);
  const reanalyzeVisionItem = useLibraryStore((s) => s.reanalyzeVisionItem);
  const current = useLibraryStore((s) => s.current);
  const navigate = useNavigate();
  const [containerWidth, setContainerWidth] = useState(0);
  const [columnCount, setColumnCount] = useState<number>(computeColumnCount);
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * 格子右键菜单（M3.5.3）：仅「重新识图（原图）」单项，只对右键所在单张生效
   * （无视多选集——规划口径：不支持批量）；本地 state，不进 store。
   */
  const [menu, setMenu] = useState<{
    item: LibraryIndexItem;
    x: number;
    y: number;
  } | null>(null);
  const [menuLeaving, setMenuLeaving] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeMenu = () => {
    if (menuLeaveTimerRef.current) {
      clearTimeout(menuLeaveTimerRef.current);
      menuLeaveTimerRef.current = null;
    }
    if (!menu) return;
    setMenuLeaving(true);
    menuLeaveTimerRef.current = setTimeout(() => {
      menuLeaveTimerRef.current = null;
      setMenu(null);
      setMenuLeaving(false);
    }, 200);
  };

  // 菜单关闭：外部 mousedown / Esc（stopPropagation 不冒泡到页面级 Esc 层）/ 页面滚动
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // capture 阶段拦截：先于页面级 window Esc 层（清选择集/关详情），stopPropagation 不冒泡
        e.stopPropagation();
        closeMenu();
      }
    };
    const onScroll = () => closeMenu();
    window.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeMenu 为稳定闭包
  }, [menu]);
  useEffect(
    () => () => {
      if (menuLeaveTimerRef.current) clearTimeout(menuLeaveTimerRef.current);
    },
    [],
  );

  /**
   * 右键菜单项（单项）：按图库压缩档位重新识图（2026-08-23 用户口径，
   * 不强制原图），确认走应用内对话框（ui/confirm，非浏览器消息）；
   * 先关菜单再弹框，避免菜单浮在对话框下。
   */
  const handleMenuReanalyze = () => {
    if (!menu) return;
    const basename = menu.item.relPath.split("/").pop() ?? menu.item.relPath;
    const id = menu.item.id;
    closeMenu();
    void confirmDialog({
      title: "重新识图",
      message: `将按图库设置中的图片尺寸重新识图「${basename}」，产生一次 API 调用费用。`,
      confirmText: "确定识图",
    }).then((ok) => {
      if (ok) void reanalyzeVisionItem(id);
    });
  };

  /**
   * 右键菜单「送去分析 / 送去画布」（任务 M3.6）：与详情页同一送出链路
   * （sendOut.ts），只对右键所在单张生效、无视多选集；先关菜单再动作，
   * 避免菜单浮在跳转后的页面上。
   */
  const sendRefFor = (item: LibraryIndexItem): SendOutRef | null =>
    current ? { libraryId: current.libraryId, relPath: item.relPath } : null;

  const handleMenuSendToLab = () => {
    if (!menu) return;
    const ref = sendRefFor(menu.item);
    closeMenu();
    if (!ref) return;
    void filesForItems([ref]).then((files) =>
      sendItemsToLab(files[0] ?? null, navigate),
    );
  };

  const handleMenuSendToCanvas = () => {
    if (!menu) return;
    const ref = sendRefFor(menu.item);
    closeMenu();
    if (!ref) return;
    void filesForItems([ref]).then((files) =>
      queueItemsToCanvas(files, navigate),
    );
  };

  /**
   * 缩略图拖拽送出（R4）：拖的条目在多选集合内且多选 >1 时带走全部选中项
   * （与批量面板口径一致），否则仅该条目；payload 只带条目标识（见 sendOut.ts）。
   */
  const handleCellDragStart = (
    e: React.DragEvent<HTMLDivElement>,
    item: LibraryIndexItem,
  ) => {
    if (!current) return;
    const multi =
      selectedIds.size > 1 && selectedIds.has(item.id) && !selectMode;
    const refs: SendOutRef[] = multi
      ? items
          .filter((i) => selectedIds.has(i.id))
          .map((i) => ({ libraryId: current.libraryId, relPath: i.relPath }))
      : [{ libraryId: current.libraryId, relPath: item.relPath }];
    beginLibraryItemDrag(e.dataTransfer, refs, {
      el: e.currentTarget,
      fileName: item.relPath.split("/").pop() ?? "图片",
    });
  };

  // 列数随窗口宽度变化
  useEffect(() => {
    const onResize = () => setColumnCount(computeColumnCount());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // 容器宽度实测（ResizeObserver，比 window resize 准）
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

  // 布局纯计算：逐条放当前最矮列，记录绝对坐标与总高
  const { cells, totalHeight } = useMemo(() => {
    if (containerWidth <= 0) return { cells: [] as CellLayout[], totalHeight: 0 };
    const cols = columnCount;
    const colW = (containerWidth - (cols - 1) * GRID_GAP) / cols;
    const heights = new Array<number>(cols).fill(0);
    const layout: CellLayout[] = [];
    for (const item of items) {
      let minIdx = 0;
      for (let i = 1; i < cols; i += 1) {
        if (heights[i] < heights[minIdx]) minIdx = i;
      }
      const w = colW;
      // M3.7：格子朝向用「展示朝向」（基数 ± 待落盘旋转次数）——详情页里旋转是内存态，
      // 网格要立刻跟着横竖互换；条目自身 width/height 恒为磁盘朝向，不能直接拿来算高
      const shown = rotatedDimsOf(item, pendingRotationsFor(item.id));
      const h =
        shown.width != null && shown.height != null && shown.width > 0
          ? colW * (shown.height / shown.width)
          : colW * GRID_EST_ASPECT;
      layout.push({
        item,
        x: minIdx * (colW + GRID_GAP),
        y: heights[minIdx],
        w,
        h,
      });
      heights[minIdx] += h + GRID_GAP;
    }
    return {
      cells: layout,
      totalHeight: Math.max(0, ...heights) - GRID_GAP,
    };
  }, [items, columnCount, containerWidth]);

  // 虚拟化：只渲染窗口 ±1200px 内的格
  const visible = useMemo(() => {
    const from = scrollTop - VIRTUAL_MARGIN;
    const to = scrollTop + viewportHeight + VIRTUAL_MARGIN;
    return cells.filter((c) => c.y + c.h >= from && c.y <= to);
  }, [cells, scrollTop, viewportHeight]);

  const handle = current ? getEntry(current.libraryId)?.handle : undefined;

  return (
    <div
      ref={rootRef}
      className={"lib-grid" + (selectMode ? " is-selectmode" : "")}
      style={{
        position: "relative",
        height: totalHeight,
        // 还原期间整块隐藏：visibility 不改变布局（总高/格子坐标照常可测），只挡视觉
        visibility: hidden ? "hidden" : undefined,
      }}
    >
      {visible.map(({ item, x, y, w, h }) => {
        const selected = selectedIds.has(item.id);
        const hit = hits?.get(item.id);
        return (
          <div
            key={item.id}
            className={"lib-cell" + (selected ? " is-selected" : "")}
            /* M3.6：格子带条目 id，LibraryPage 的浏览位置还原以"视口顶部那张图"作锚点校正 */
            data-cell-id={item.id}
            style={{ position: "absolute", left: x, top: y, width: w, height: h }}
            draggable={!selectMode}
            onDragStart={(event) => handleCellDragStart(event, item)}
            onContextMenu={(event) => {
              // 右键菜单：只对右键所在的单张生效，无视多选集（不支持批量）
              event.preventDefault();
              setMenu({ item, x: event.clientX, y: event.clientY });
            }}
            onClick={(event) => {
              if (selectMode) {
                toggleSelect(item.id);
              } else if (event.ctrlKey || event.metaKey) {
                enterSelectWith(item.id);
              } else {
                onOpen(item.id, event.currentTarget.getBoundingClientRect());
              }
            }}
          >
            <Thumb
              handle={handle}
              relPath={item.relPath}
              alt={item.relPath}
              thumbRelPath={item.thumb}
              mtime={item.mtime}
            />
            {/* 色板/标签/命中理由/星标：与跨图库结果块共用的同一份覆盖层 */}
            <LibraryCellOverlay
              item={item}
              hit={hit}
              colorFilter={colorFilter}
              temperature={temperature}
              onSwatchPick={onSwatchPick}
            />
            {/* 勾选框仅多选模式渲染（M3.3.1：常态不显示，Ctrl+点击可进入模式） */}
            {selectMode && (
              <button
                type="button"
                className={"lib-cell__check" + (selected ? " is-checked" : "")}
                aria-label="选择"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleSelect(item.id);
                }}
              >
                {selected ? "✓" : ""}
              </button>
            )}
          </div>
        );
      })}
      {menu && (
        <div
          ref={menuRef}
          className={"lib-cell__menu" + (menuLeaving ? " is-leaving" : "")}
          style={{ top: menu.y, left: menu.x }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={handleMenuReanalyze}>
            重新识图
          </button>
          <button type="button" onClick={handleMenuSendToLab}>
            送去分析
          </button>
          <button type="button" onClick={handleMenuSendToCanvas}>
            送去画布
          </button>
        </div>
      )}
    </div>
  );
}
