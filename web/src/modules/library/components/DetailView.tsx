/**
 * M3.3.2/M3.3.3 详情页覆盖层：portal 到 body 的全屏虚化覆盖层 + 左视觉右信息大卡。
 * 进入三段并行（遮罩 blur 渐变 + 详情卡入场 + FLIP transform 版，源为缩略图、
 * 原图就绪直换）、每卡 CardSlot 加载接口、遮罩点击/Esc 退出（无返回按钮）；
 * 进出不刷新、网格保持挂载由 LibraryPage 承接。
 * ←/→ 按当前排序顺序导航；相似图跳转不重播 FLIP。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { lumaHistogram, satHistogram } from "../../../core/imaging/histogram";
import { decodeImage, sampleImageData } from "../../../core/imaging/sample";
import { readFileBlob } from "../../../core/storage/fsa";
import { getEntry } from "../index/binding";
import { getSettings, SOURCE_URL_EXTRA_KEY } from "../index/indexFile";
import type { LibraryIndexItem } from "../index/indexFile";
import { findSimilar } from "../search/similar";
import { isGifPath, ROTATE_GIF_REJECT, spinBitmap } from "../rotate";
import { rotatedDimsOf, useLibraryStore } from "../store";
import { confirmDialog } from "../../../ui/confirm";
import { toast } from "../../../ui/toast";
import {
  beginLibraryItemDrag,
  filesForItems,
  queueItemsToCanvas,
  sendItemsToLab,
  type SendOutRef,
} from "../sendOut";
import { revealInFolder } from "./revealInFolder";
import { Thumb } from "./OverviewGrid";

const TONE_LABEL: Record<string, string> = {
  low: "低调",
  mid: "中调",
  high: "高调",
};

/** 内置语义字段中文名（基本信息卡；表序对齐 §7.1） */
const FIELD_LABELS: Record<string, string> = {
  subject: "主体",
  scene: "场景",
  lighting: "光线",
  angle: "视角",
  composition: "构图",
  shot: "景别",
  color_mood: "色彩倾向",
  mood_style: "情绪风格",
  content_type: "内容类型",
};

/** 来源网址：只认 http(s)（javascript:/file: 等一律不给打开按钮，按普通文字显示） */
function httpUrlOf(text: string): string | undefined {
  try {
    const url = new URL(text.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** 字段值格式化：字符串原样；top-k 数组 → "term 0.90 · term 0.07"；字符串数组 → " · " 连接 */
function formatFieldValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (!Array.isArray(v)) return "";
  return v
    .map((x) => {
      if (typeof x === "string") return x;
      const term = (x as { term?: unknown } | null)?.term;
      const conf = (x as { conf?: unknown } | null)?.conf;
      if (typeof term !== "string") return "";
      return typeof conf === "number" ? `${term} ${conf.toFixed(2)}` : term;
    })
    .filter(Boolean)
    .join(" · ");
}

/** 识图状态行时间：本地时间 YYYY-MM-DD HH:mm（M3.5.3 逐字口径） */
function formatVisionTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 详情页查看器（M3.3.4）：滚轮缩放系数与范围，口径同 M4 画布（光标锚定 0.1–4x） */
const VIEW_WHEEL_FACTOR = 0.002;const VIEW_MIN_ZOOM = 0.1;
const VIEW_MAX_ZOOM = 4;
/** 左右切换交叉淡出时长（ms）：新缩略图淡入期间读原图，就绪后直换覆盖 */
const SWITCH_FADE_MS = 180;
/** 切换内容加载兜底（新源既不触发 onLoad 也不触发 onError 的极端情况） */
const SWITCH_SAFETY_MS = 2000;

/** 按给定图盒尺寸计算 stage 内容盒适配视图（contain 等比居中；尺寸未知返回 null） */
function computeFitForDims(
  stage: HTMLDivElement,
  dims: { width: number | null; height: number | null },
): { x: number; y: number; zoom: number } | null {
  const cs = window.getComputedStyle(stage);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const contentW = stage.clientWidth - padLeft - (parseFloat(cs.paddingRight) || 0);
  const contentH = stage.clientHeight - padTop - (parseFloat(cs.paddingBottom) || 0);
  const w = dims.width ?? 0;
  const h = dims.height ?? 0;
  if (contentW <= 0 || contentH <= 0 || w <= 0 || h <= 0) return null;
  const zoom = Math.min(
    VIEW_MAX_ZOOM,
    Math.max(VIEW_MIN_ZOOM, Math.min(contentW / w, contentH / h)),
  );
  return {
    x: padLeft + (contentW - w * zoom) / 2,
    y: padTop + (contentH - h * zoom) / 2,
    zoom,
  };
}

/** 适配窗口图标（四角展开，口径同 M4 视口控制） */
function FitIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 9V4h5" />
      <path d="M15 4h5v5" />
      <path d="M20 15v5h-5" />
      <path d="M9 20H4v-5" />
    </svg>
  );
}

/**
 * 详情页旋转显示：由基准位图派生一张顺时针 90° 的位图，并生成可给 `<img>` 用的 URL。
 * 返回 `{ bitmap, url }`——bitmap 供后续连点复用/回收，url 供展示（旋转不落盘，
 * 原 objectURL 仍指向未旋转的磁盘文件，必须另起一个源）。
 */
async function spinBitmapDisplay(
  base: ImageBitmap,
): Promise<{ bitmap: ImageBitmap; url: string }> {
  const bitmap = await spinBitmap(base);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("2d context unavailable");
  }
  ctx.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  if (!blob) {
    bitmap.close();
    throw new Error("旋转显示源编码失败");
  }
  return { bitmap, url: URL.createObjectURL(blob) };
}

/** 顺时针旋转 90° 图标（M3.7 内存旋转；圆弧 + 箭头，风格同 FitIcon 线性口径） */
/** 顺时针旋转 90° 图标（M3.7 内存旋转；圆弧 + 箭头，风格同 FitIcon 线性口径） */
function RotateIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <polyline points="20 4 20 10 14 10" />
    </svg>
  );
}

/** 饱和度-像素数曲线：与直方图柱状区分，Catmull-Rom 平滑为三次贝塞尔 path */
function SatCurve({ counts }: { counts: number[] }) {
  const { lineD, areaD } = useMemo(() => {
    const max = Math.max(...counts, 1);
    const pts = counts.map((count, i) => ({
      x: i * 10 + 5,
      y: 76 - (count / max) * 72,
    }));
    const line = pts
      .map((p, i) => {
        if (i === 0) return `M ${p.x} ${p.y}`;
        const p0 = pts[Math.max(0, i - 2)];
        const p1 = pts[i - 1];
        const p2 = p;
        const p3 = pts[Math.min(pts.length - 1, i + 1)];
        const c1x = p1.x + (p2.x - p0.x) / 6;
        const c1y = p1.y + (p2.y - p0.y) / 6;
        const c2x = p2.x - (p3.x - p1.x) / 6;
        const c2y = p2.y - (p3.y - p1.y) / 6;
        return `C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
      })
      .join(" ");
    return {
      lineD: line,
      areaD: `M ${pts[0].x} 80 L ${pts[0].x} ${pts[0].y} ${line.slice(1)} L ${pts[pts.length - 1].x} 80 Z`,
    };
  }, [counts]);
  return (
    <>
      <path className="lib-detail__hist-area" d={areaD} />
      <path className="lib-detail__hist-curve" d={lineD} />
    </>
  );
}

/**
 * 信息卡统一加载接口（M3.3.3）：卡壳始终渲染并 stagger 入场，
 * 内容未就绪时播卡内骨架（通用 shimmer 或同构骨架节点），
 * 就绪后内容以 150ms 淡入替换。
 */
function CardSlot({
  label,
  delay,
  ready,
  skeleton,
  skeletonHeight,
  children,
}: {
  label: string;
  delay: number;
  ready: boolean;
  skeleton?: React.ReactNode;
  skeletonHeight?: number;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="lib-detail__card" style={{ animationDelay: `${delay}ms` }}>
      <span className="lib-detail__label">{label}</span>
      {ready ? (
        <div className="lib-detail__card-body">{children}</div>
      ) : skeleton !== undefined ? (
        /* 同构骨架：包在 card-body 内，与内容同 gap/图例/高度，替换时零抽动 */
        <div className="lib-detail__card-body">{skeleton}</div>
      ) : (
        <div
          className="lib-detail-skeleton"
          style={{ height: skeletonHeight }}
          role="status"
          aria-label={`正在加载${label}`}
        />
      )}
    </div>
  );
}

/** 直方图卡图例：骨架与最终内容共用同一 markup，保证占位与内容逐像素等高 */
function HistogramLegend({ item }: { item: LibraryIndexItem }) {
  return (
    <div className="lib-detail__legend">
      <span className="lib-detail__legend-item">
        <span className="lib-detail__legend-bar" aria-hidden="true" />
        明度直方图 · 平均明度{" "}
        <span className="lib-detail__legend-value">
          {item.meanLuma} · {TONE_LABEL[item.tone ?? "mid"] ?? "中调"}
        </span>
      </span>
      <span className="lib-detail__legend-item">
        <span className="lib-detail__legend-line" aria-hidden="true" />
        饱和度曲线 · 平均饱和度{" "}
        <span className="lib-detail__legend-value">{item.meanSat}</span>
      </span>
    </div>
  );
}

/**
 * 直方图卡同构骨架（M3.3.3 打回修复）：真实图例行 + 96px 动态柱区，
 * 与最终内容总高逐像素一致；32 根柱波浪脉动为加载反馈（详情动画不随
 * reduced-motion 禁用，见 LibraryPage.css reduce 块注释）。
 */
function HistogramSkeleton({ item }: { item: LibraryIndexItem }) {
  return (
    <>
      <HistogramLegend item={item} />
      <div
        className="lib-detail__hist-skeleton"
        role="status"
        aria-label="正在加载明度直方图"
      >
        {Array.from({ length: 32 }, (_, i) => (
          <span
            key={i}
            className="lib-detail__hist-skeleton-bar"
            style={{
              left: `${(i * 10 + 1.5) / 3.2}%`,
              width: `${7 / 3.2}%`,
              animationDelay: `${i * 40}ms`,
            }}
          />
        ))}
      </div>
    </>
  );
}

/**
 * 编辑二级小窗：tag 管理（含拖动排序）/ 描述 / 备注 / 标星；
 * Esc 只关小窗（stopPropagation 捕获）；关闭（Esc/遮罩/关闭钮）前自动保存描述与备注。
 */
function EditDialog({
  item,
  onClose,
}: {
  item: LibraryIndexItem;
  onClose: () => void;
}) {
  const addTag = useLibraryStore((s) => s.addTag);
  const removeTag = useLibraryStore((s) => s.removeTag);
  const reorderTags = useLibraryStore((s) => s.reorderTags);
  const setStarred = useLibraryStore((s) => s.setStarred);
  const setNote = useLibraryStore((s) => s.setNote);
  const setDescription = useLibraryStore((s) => s.setDescription);
  const [tagInput, setTagInput] = useState("");
  const [note, setNoteValue] = useState(item.note);
  const [desc, setDescValue] = useState(item.description);
  /** 拖拽排序态（HTML5 DnD，同 FilterBar 取色托盘的组件状态传递口径） */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  /** 挤开效果：悬停目标 tag 的哪一侧让出插入空位（空位宽 = 被拖 tag 的实测宽度） */
  const [gap, setGap] = useState<{ at: number; side: "left" | "right" } | null>(
    null,
  );
  const gapWidthRef = useRef(0);
  const tagRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setNoteValue(item.note);
  }, [item.note]);

  useEffect(() => {
    setDescValue(item.description);
  }, [item.description]);

  /**
   * 保存描述：覆盖写落盘 + 底部轻提示（ui/toast，同图库注册表口径）。
   * 值没变就跳过写盘（避免白写一轮索引），提示照给——用户点保存总要看到回执。
   */
  const saveDesc = () => {
    if (desc !== item.description) setDescription([item.id], desc);
    toast("描述保存成功");
  };

  /** 保存备注：覆盖写落盘 + 底部轻提示（同上，未改动只提示不写盘） */
  const saveNote = () => {
    if (note !== item.note) setNote([item.id], note);
    toast("备注保存成功");
  };

  /**
   * 关闭出口（Esc / 遮罩 / 关闭钮共用）：先把文本框里未落盘的内容写回再关。
   * Esc 关闭不触发 blur，不做这步会丢刚敲进去的描述/备注（2026-09 用户口径：
   * 关闭编辑页自动保存描述与备注）；未改动的字段跳过，不白写一轮索引。
   */
  const closeWithAutoSave = useCallback(() => {
    if (desc !== item.description) setDescription([item.id], desc);
    if (note !== item.note) setNote([item.id], note);
    onClose();
  }, [
    desc,
    note,
    item.id,
    item.description,
    item.note,
    setDescription,
    setNote,
    onClose,
  ]);

  // Esc 只关小窗；LibraryPage 的全局 Esc 见 `.lib-edit` 存在则让位
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeWithAutoSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeWithAutoSave]);

  const confirmTag = () => {
    if (!tagInput.trim()) return;
    addTag([item.id], tagInput);
    setTagInput("");
  };

  /** 拖动落点重排：源移出后插入目标位（整体替换 tags 数组落盘） */
  const moveTag = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return;
    const next = [...item.tags];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    reorderTags(item.id, next);
  };

  /** 清空拖拽态（落点/结束/离窗共用） */
  const clearDrag = () => {
    setDragIndex(null);
    setOverIndex(null);
    setGap(null);
  };

  /**
   * 指针所在插入槽位的指示线锚点（tag 索引 + 侧向）：
   * - 指针在某 tag 框内 → 该 tag 的落点语义（from < i → 槽 i+1，锚 i:right；from > i → 槽 i，锚 i:left）；
   * - 指针在空隙 → 按最近 tag 归入其左/右槽位。相邻 tag 之间的空隙是一个槽位，锚点由
   *   拖拽方向决定（from < 槽 → 左 tag:right；from > 槽 → 右 tag:left）——空隙全程
   *   同槽，最近 tag 在中点处翻转不影响结果，指示线不抽搐（用户反馈 2026-08-22
   *   「拖动的时候会抽搐，边界太敏感」：旧实现按最近中心解析，中点即翻转边界）；
   * - 锚点 = 被拖 tag 自身（拖进自己相邻槽位 = 不动）→ 返回 null（无指示线）。
   */
  const slotAt = (x: number, y: number): { at: number; side: "left" | "right" } | null => {
    const row = tagRowRef.current;
    if (!row || dragIndex === null) return null;
    const nodes = Array.from(
      row.querySelectorAll<HTMLElement>(".lib-detail__tag"),
    );
    const n = nodes.length;
    if (n === 0) return null;
    for (let i = 0; i < n; i += 1) {
      const r = nodes[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        if (i === dragIndex) return null; // 自身：不动
        return i > dragIndex
          ? { at: i, side: "right" }
          : { at: i, side: "left" };
      }
    }
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    nodes.forEach((node, i) => {
      const r = node.getBoundingClientRect();
      const dx = r.left + r.width / 2 - x;
      const dy = r.top + r.height / 2 - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    const rb = nodes[best].getBoundingClientRect();
    // 左/上侧 → 槽 best；右/下侧 → 槽 best+1；槽 s 的锚：from < s → (s-1):right，from > s → s:left
    const before = x < rb.left || y < rb.top;
    const slot = before ? best : best + 1;
    const anchor = dragIndex < slot ? slot - 1 : slot;
    if (anchor === dragIndex) return null; // 自身相邻槽位：不动
    return {
      at: anchor,
      side: dragIndex < slot ? "right" : "left",
    };
  };

  /** 落位空位 ghost 的容器内坐标（绝对定位，不参与布局——旧的 margin 挤开会推动
   *  行尾 tag 换行、下方排版跟着动，用户反馈 2026-08-22「拖动时下面的排版跟随移动，
   *  还会导致抽搐」） */
  const gapSlotRect = (): {
    left: number;
    top: number;
    width: number;
    height: number;
  } | null => {
    if (!gap) return null;
    const row = tagRowRef.current;
    const node = row?.querySelectorAll<HTMLElement>(".lib-detail__tag")[gap.at];
    if (!row || !node) return null;
    const rr = row.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const w = gapWidthRef.current;
    return {
      left: (gap.side === "right" ? r.right : r.left - w) - rr.left,
      top: r.top - rr.top,
      width: w,
      height: r.height,
    };
  };

  /** 落位空位 ghost 位置（渲染一次，避免 JSX 内重复计算） */
  const gapRect = gapSlotRect();

  return (
    <div className="lib-edit">
      <div className="lib-edit__mask" onClick={closeWithAutoSave} />
      <div className="lib-edit__card" role="dialog" aria-label="编辑">
        <header className="lib-edit__header">
          <h2 className="lib-edit__title">编辑</h2>
          <button
            type="button"
            className="lib-toolbar__btn"
            onClick={closeWithAutoSave}
          >
            关闭
          </button>
        </header>

        <div className="lib-edit__section">
          <span className="lib-edit__label">
            标签{" "}
            <span className="lib-edit__hint">
              （带标识的前 3 个显示在主界面，拖动调整顺序）
            </span>
          </span>
          <div
            ref={tagRowRef}
            className="lib-edit__tags"
            onDragOver={(e) => {
              if (dragIndex === null) return;
              // 整行合法落点：空隙/行尾释放不丢单（dragover 不 preventDefault 则 drop 被禁止）
              e.preventDefault();
              // 显示跟随指针（空隙也是合法悬停区）：按槽位模型解析指示线锚点——
              // 空隙全程同槽，指针微抖不翻转（对比旧「最近中心」在中点处来回跳）
              const slot = slotAt(e.clientX, e.clientY);
              if (slot === null) {
                setOverIndex((cur) => (cur === null ? cur : null));
                setGap((cur) => (cur === null ? cur : null));
                return;
              }
              setOverIndex((cur) => (cur === slot.at ? cur : slot.at));
              setGap((cur) =>
                cur?.at === slot.at && cur.side === slot.side ? cur : slot,
              );
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setOverIndex(null);
              setGap(null);
            }}
            onDrop={(e) => {
              if (dragIndex === null) return;
              e.preventDefault();
              // 落点 = 显示的插入位（gap 指示线所在 tag；无指示线 = 自身旁 = 不动）。
              // 显示即落点：gap 由同指针位置的 onDragOver 维护，二者恒一致。
              const to = gap ? gap.at : dragIndex;
              moveTag(dragIndex, to);
              clearDrag();
            }}
          >
            {item.tags.map((t, i) => {
              const gapSide = gap && gap.at === i ? gap.side : null;
              return (
                <span
                  key={`${t.text}-${t.source}`}
                  className={
                    "lib-detail__tag" +
                    (t.source === "auto" ? " is-auto" : "") +
                    (dragIndex === i ? " is-dragging" : "") +
                    (overIndex === i && dragIndex !== i ? " is-over" : "") +
                    (gapSide ? ` has-gap-${gapSide}` : "")
                  }
                  draggable
                  title={
                    t.source === "auto"
                      ? "识图生成 · 拖动调整顺序"
                      : "拖动调整顺序"
                  }
                  onDragStart={(e) => {
                    setDragIndex(i);
                    gapWidthRef.current = e.currentTarget.offsetWidth;
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", t.text);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (overIndex !== i) setOverIndex(i);
                    // 指示线：悬停处按插入方向落位（右移=落在该 tag 后，左移=落其前）；
                    // 悬停自身清空指示线（显示 = 落点：落自身 = 不动，不残留旧 gap）
                    if (dragIndex !== null) {
                      setGap(
                        dragIndex === i
                          ? null
                          : { at: i, side: i > dragIndex ? "right" : "left" },
                      );
                    }
                  }}
                  onDragLeave={(e) => {
                    // 移到子元素（图形标识/文字/×）不算离开，避免高亮闪烁
                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                    setOverIndex((cur) => (cur === i ? null : cur));
                    setGap((cur) => (cur?.at === i ? null : cur));
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation(); // 容器兜底 drop 不重复解析
                    if (dragIndex !== null) moveTag(dragIndex, i);
                    clearDrag();
                  }}
                  onDragEnd={clearDrag}
                >
                  {i < 3 && (
                    /* 图形标识：该 tag 会显示在主界面缩略图下（前 3 个，随拖动实时变化） */
                    <svg
                      className="lib-edit__tag-grid-mark"
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20.59 13.41 12 22l-8.59-8.59A2 2 0 0 1 2.83 12V4a2 2 0 0 1 2-2h8a2 2 0 0 1 1.41.59l8.59 8.59a2 2 0 0 1 0 2.82z" />
                      <circle cx="7.5" cy="7.5" r="1.2" fill="currentColor" stroke="none" />
                    </svg>
                  )}
                  {t.text}
                  <button
                    type="button"
                    className="lib-detail__tag-remove"
                    aria-label={`删除标签 ${t.text}`}
                    onClick={() => removeTag([item.id], t.text)}
                  >
                    ×
                  </button>
                </span>
              );
            })}
            {/* 落位空位 ghost：虚线框标出插入槽位（绝对定位，不推动布局） */}
            {gapRect && (
              <span
                className="lib-edit__gap"
                style={gapRect}
                aria-hidden="true"
              />
            )}
          </div>
          <div className="lib-batchbar__item">
            <input
              className="lib-batchbar__input"
              placeholder="新标签"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmTag();
              }}
            />
            <button type="button" className="lib-toolbar__btn" onClick={confirmTag}>
              加标签
            </button>
          </div>
        </div>

        <div className="lib-edit__section">
          <span className="lib-edit__label">描述（覆盖写）</span>
          <textarea
            className="lib-edit__note"
            value={desc}
            onChange={(e) => setDescValue(e.target.value)}
            onBlur={() => setDescription([item.id], desc)}
          />
          <button
            type="button"
            className="lib-toolbar__btn"
            onClick={saveDesc}
          >
            保存描述
          </button>
        </div>

        <div className="lib-edit__section">
          <span className="lib-edit__label">备注（覆盖写）</span>
          <textarea
            className="lib-edit__note"
            value={note}
            onChange={(e) => setNoteValue(e.target.value)}
            onBlur={() => setNote([item.id], note)}
          />
          <button
            type="button"
            className="lib-toolbar__btn"
            onClick={saveNote}
          >
            保存备注
          </button>
        </div>

        <div className="lib-edit__section">
          <button
            type="button"
            className="lib-toolbar__btn"
            onClick={() => setStarred([item.id], !item.starred)}
          >
            {item.starred ? "取消标星" : "标星"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 详情右上图标按钮：32px 方钮 + 内联 SVG（对齐 FolderIcon 线宽先例） */
function IconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={"lib-detail__iconbtn" + (className ? ` ${className}` : "")}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** FLIP 克隆层/终位矩形（只读数值，避免依赖 DOMRect 全字段） */
interface FlipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 跨图库**只读**查看语境（PR-007 后续，用户口径"点击跨图库的图会强制加载对应图库，
 * 顶掉当前图库，能否实现只打开图，不跳转"）：
 * - 打开时**完全不动 store**（不 `switchTo`、不 `setDetail`、不碰 `pendingDetailId`），
 *   当前库、网格、滚动位置、检索条件全部原样保留；
 * - 图片经目标库句柄直读（`getEntry(libraryId).handle` + `readFileBlob`），只读不写；
 * - ←/→ 与相似图的取值域是该库的命中条目（`items`），不跨回当前库；
 * - **一切写入口在只读模式下不渲染**：标星 / 编辑 / 旋转 / 重新识图 / 送出（这三条都绑
 *   当前库语义，用户明确要求"这三个都不动，绑定本库是对的"）；「在文件夹中打开」是只读
 *   动作，按其所属库 id 正常可用。
 */
export interface ForeignView {
  libraryId: string;
  libraryName: string;
  /** 该库命中条目（←/→ 与相似图的取值域） */
  items: LibraryIndexItem[];
  /** 当前展示第几张（0 基） */
  index: number;
  onIndex: (index: number) => void;
}

export function DetailView({
  items,
  leaving,
  origin,
  onClose,
  onItemTurns,
  foreign = null,
}: {
  items: LibraryIndexItem[];
  leaving: boolean;
  origin: DOMRect | null;
  onClose: () => void;
  /**
   * 内存旋转累计次数变化回调（M3.7）：**只往上报数，不写 store**。
   * 旋转若写 store（`rotateItem` → `set({items})`），瀑布流网格会立刻按新宽高重排——实测被转
   * 那一格当场由 670px 变 172px，即用户报的「旋转的时候主界面也跟着动」。次数由 LibraryPage
   * 持有（它与落盘时机同处一层），退出详情页时按 `(id, turns)` 一次性写盘。
   */
  onItemTurns: (itemId: string, turns: number) => void;
  /** 跨图库只读查看（见 `ForeignView`）；非空即进入只读模式 */
  foreign?: ForeignView | null;
}) {
  /** 只读（跨图库查看）模式：条目与句柄取自 `foreign`，写入口一律不渲染 */
  const ro = foreign != null;
  const detailId = useLibraryStore((s) => s.detailId);
  const setDetail = useLibraryStore((s) => s.setDetail);
  const setStarred = useLibraryStore((s) => s.setStarred);
  const addTag = useLibraryStore((s) => s.addTag);
  const reanalyzeVisionItem = useLibraryStore((s) => s.reanalyzeVisionItem);
  const allItems = useLibraryStore((s) => s.items);
  const current = useLibraryStore((s) => s.current);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  /** M3.7 旋转中（派生旋转位图的短暂窗口：派生期间禁用按钮防重入） */
  const [rotating, setRotating] = useState(false);
  /** 「送出」下拉展开态（2026-09-11 用户反馈：原「送去分析/送去画布/送去排版」
   *  三枚按钮收成一枚触发器，悬停或聚焦后在下方展开下拉选目的地） */
  const [sendOpen, setSendOpen] = useState(false);
  /** 选词转 tag 浮钮（M3.5.3）：选区文本 + 锚点（fixed 屏幕坐标）；null = 隐藏 */
  const [tagify, setTagify] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  /** 浮钮退场动画态（--motion-fast 后卸载） */
  const [tagifyLeaving, setTagifyLeaving] = useState(false);
  const descRef = useRef<HTMLParagraphElement | null>(null);
  const tagifyBtnRef = useRef<HTMLButtonElement | null>(null);
  const tagifyLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 当前展示源（thumb 或原图 objectURL；换图时保留旧图直到新缩略图就绪） */
  const [displaySrc, setDisplaySrc] = useState<string | null>(null);
  /** 未旋转的原图基准位图（旋转显示由它派生；随加载 effect 重跑替换，换图时释放） */
  const baseBitmapRef = useRef<ImageBitmap | null>(null);
  /** 基准位图归属的条目 id：同一张图重跑 effect 不关它（旋转要一直用同一张基准） */
  const baseBitmapOwnerRef = useRef<string | null>(null);
  /** 当前展示的旋转后位图（连点产生的中间产物，替换时 close） */
  const rotatedRef = useRef<ImageBitmap | null>(null);
  /** 旋转显示源的 objectURL（旋转时替换并回收旧的） */
  const rotatedUrlRef = useRef<string | null>(null);
  /** 展示源所属条目的原图尺寸（图盒固定为原图尺寸，避免换图时旧图盒跳动） */
  const [displayDims, setDisplayDims] = useState<{
    width: number | null;
    height: number | null;
  }>({ width: null, height: null });
  /**
   * 图盒尺寸的 **ref 镜像**（与上面的 state 同一次提交内同步写入）——适配计算的唯一依据。
   * 为什么必须有它：`onLoad` 触发时 React 可能还没把新的 `width/height` 属性刷到 DOM 上，
   * 此刻读 `img.clientWidth` 拿到的是**旧朝向的盒子**。M3.7 内存旋转把 400x200 换成 200x400
   * 时正是这个时序：onLoad 用旧盒重算 fit，把旋转提交时为 200x400 算好的居中 transform
   * 覆盖掉 → 图按横向比例放大后溢出 stage 被裁、看起来"旋转后不居中/只转了一次"。
   */
  const displayDimsRef = useRef<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  /**
   * **本条目的内存旋转累计次数**（本地态，M3.7 修正）：**不再写进 store**。
   *
   * 为什么必须本地化：`rotateItem` 会 `set({ items })`，网格随之重算格子宽高——实测旋转
   * 那一刻被转的那一格高度当场由 670px 变成 168px（400x200 转 90° 后按 200x400 重算），
   * 即**详情页盖着的时候主界面也在跟着动**（用户 2026-09-12 报「为什么旋转的时候主界面也跟着动」）。
   * 内存旋转只该改"屏幕上这张"，磁盘、索引、网格都属于落盘后才更新的世界。
   *
   * 生命周期：打开/切图归零；每次点击 +1；退出详情页由 LibraryPage 调 `flushPendingRotations`
   * 落盘（落盘会写 `mtime`，本 ref 随之归零，重开详情从新文件的朝向起算）。
   */
  const turnsRef = useRef(0);
  /** 当前展示源已计入的累计旋转次数（用于判断"这次重跑是不是内存旋转"） */
  const displayTurnsRef = useRef(0);
  /**
   * **当前 view（transform）是按哪个图盒算出来的**（`"宽x高"` 键）。图盒朝向变了就必须重算
   * 适配——`<img>` 元素是被复用的（换源只改 src/width/height，不重新挂载），所以 `onLoad`
   * 每次都会触发，但 `viewInitializedRef` 早已为 true；光靠"首次加载才 fit"会漏掉**盒尺寸变化**
   * 这一次（M3.7 内存旋转 400x200 → 200x400 正是这种情况：图转了、盒子也换了，view 还停在
   * 旧盒的 fit 上 → 图按横向比例放大后溢出 stage 被裁，看起来"没居中/只转了一次"）。
   */
  const viewDimsKeyRef = useRef<string>("");
  const dimsKeyOf = (d: { width: number | null; height: number | null }) =>
    `${d.width ?? "?"}x${d.height ?? "?"}`;
  /** 大图读取状态：loading（骨架屏）→ ready / failed（失败时信息卡仍显示索引数据） */
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed">(
    "loading",
  );
  const [hist, setHist] = useState<{ luma: number[]; sat: number[] } | null>(
    null,
  );
  /** 直方图解码/计算失败：与「未分析」同显示，但避免骨架屏永久转圈 */
  const [histFailed, setHistFailed] = useState(false);
  /** 覆盖层入场态：双 rAF 后加 .is-entered，触发遮罩 blur/卡片入场过渡 */
  const [entered, setEntered] = useState(false);
  const [flipRect, setFlipRect] = useState<FlipRect | null>(null);
  /** FLIP 克隆层固定位（origin；transform 过渡到终位） */
  const [flipOrigin, setFlipOrigin] = useState<FlipRect | null>(null);
  const urlRef = useRef<string | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  /** 当前条目宽高（索引优先于 imgRef.naturalWidth，原图可能未解码） */
  const itemDimsRef = useRef<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  /** 离场卸载期间 detailId 已置空，用最后条目 ref 保住渲染内容 */
  const lastItemRef = useRef<LibraryIndexItem | null>(null);
  /** FLIP 只在 overlay 首次挂载播一次（键盘导航/相似图跳转不重播） */
  const flipPlayedRef = useRef(false);
  const flipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 查看器（M3.3.4）：图片解码后才启用；滚轮缩放（光标锚定）＋ 空格拖拽平移，口径同 M4 画布 */
  const [view, setView] = useState<{ x: number; y: number; zoom: number }>({
    x: 0,
    y: 0,
    zoom: 1,
  });
  const [imgLoaded, setImgLoaded] = useState(false);
  const [panning, setPanning] = useState(false);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  /** onLoad 只初始化一次适配位（thumb→原图直换不重置用户视图） */
  const viewInitializedRef = useRef(false);
  const imgLoadedRef = useRef(false);
  imgLoadedRef.current = imgLoaded;
  /** 换图交叉淡出（M3.3.4 迭代）：旧图冻结原视图淡出，新缩略图淡入期间读原图 */
  const [prevSrc, setPrevSrc] = useState<string | null>(null);
  const [prevView, setPrevView] = useState<{
    x: number;
    y: number;
    zoom: number;
  } | null>(null);
  const [prevDims, setPrevDims] = useState<{
    width: number | null;
    height: number | null;
  } | null>(null);
  const [switching, setSwitching] = useState(false);
  /** 新源解码完成（is-fading）：交叉淡出动画只在这一刻启动 */
  const [fading, setFading] = useState(false);
  const displayRef = useRef<string | null>(null);
  /** 已创建但尚未展示的 URL（换图取消/中途导航），下一次展示提交时统一回收 */
  const heldRef = useRef<string[]>([]);
  /** 淡出中的旧图 URL：淡出结束才回收 */
  const fadingRef = useRef<string | null>(null);
  /** 换图后首个展示提交做交叉淡出（原图就绪直换不再淡出） */
  const navTransitionRef = useRef(false);
  const switchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchSafetyRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const switchingRef = useRef(false);
  switchingRef.current = switching;
  const viewRef = useRef(view);
  viewRef.current = view;
  /** 上一个条目的原图尺寸（换图瞬间捕获，用于淡出中的旧图保持原盒） */
  const prevItemDimsRef = useRef<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  const prevIdRef = useRef<string | null>(null);
  const oldDimsForFadeRef = useRef<{
    width: number | null;
    height: number | null;
  }>({ width: null, height: null });

  // M3.4.2 R1：条目解析用全量 allItems（相似图可跳到当前筛选集外的条目——props items
  // 是筛选后 gridItems，find 会落空）；←/→ 导航顺序仍按 props items（下方 index 逻辑不动）
  // PR-007：只读模式下条目取自 foreign.items（当前库 items 与之无关，也不写 lastItemRef）
  const item = ro
    ? (foreign.items[foreign.index] ?? null)
    : (allItems.find((i) => i.id === detailId) ?? lastItemRef.current);
  if (!ro && item) lastItemRef.current = item;
  const handle = ro
    ? getEntry(foreign.libraryId)?.handle
    : current
      ? getEntry(current.libraryId)?.handle
      : undefined;
  const itemId = item?.id ?? null;
  const relPath = item?.relPath ?? null;
  // itemId 变化瞬间：捕获上一个条目的尺寸（切换淡出的旧图要用原盒）
  if (prevIdRef.current !== itemId) {
    if (prevIdRef.current != null) {
      oldDimsForFadeRef.current = prevItemDimsRef.current;
    }
    prevIdRef.current = itemId;
  }
  itemDimsRef.current = {
    width: item?.width ?? null,
    height: item?.height ?? null,
  };
  prevItemDimsRef.current = itemDimsRef.current;

  /** 切换淡出结束：卸旧图、回收旧 URL、解锁查看器（缩放/平移就绪） */
  const finishSwitchFade = useCallback(() => {
    if (switchSafetyRef.current) {
      clearTimeout(switchSafetyRef.current);
      switchSafetyRef.current = null;
    }
    switchTimerRef.current = null;
    setSwitching(false);
    setFading(false);
    setPrevSrc(null);
    setPrevView(null);
    setPrevDims(null);
    if (fadingRef.current) {
      URL.revokeObjectURL(fadingRef.current);
      fadingRef.current = null;
    }
    setImgLoaded(true);
  }, []);

  /**
   * 新源解码完成（onLoad/onError）后启动交叉淡出：
   * 解码前新图保持隐藏（opacity 0）、旧图保持显示——杜绝“旧内容进新盒”的压扁/拉长帧
   */
  const startSwitchFade = useCallback(() => {
    if (switchTimerRef.current) return;
    if (switchSafetyRef.current) {
      clearTimeout(switchSafetyRef.current);
      switchSafetyRef.current = null;
    }
    setFading(true);
    switchTimerRef.current = setTimeout(finishSwitchFade, SWITCH_FADE_MS);
  }, [finishSwitchFade]);

  /**
   * 提交新展示源（复用打开详情页的读取链路）：
   * - 换图后首个提交（新缩略图）→ 旧图冻结原视图交叉淡出，期间原图在读取；
   * - 原图就绪 → 直换覆盖（不做二次淡出，与 M3.3.3「原图直换」口径一致）；
   * - 未展示的挂起 URL 在本次提交时统一回收。
   *
   * `dims`（M3.7）：覆盖图盒尺寸。默认取 itemDimsRef（当前条目的索引尺寸），但**内存旋转**
   * 时新源的朝向与索引尺寸尚未同帧——旋转发生在 store 更新之前，此刻 itemDimsRef 还是旧方向，
   * 用它会把竖图塞进横盒（letterbox 缩小 + 图盒不跟随）。故旋转提交时显式传入旋转后尺寸。
   */
  const commitDisplay = useCallback(
    (
      next: string,
      dims?: { width: number | null; height: number | null },
      turns?: number,
    ) => {
      const boxDims = dims ?? itemDimsRef.current;
      // 展示源已计入的累计旋转次数：显式传入（旋转路径）或沿用当前值（换图/加载路径，
      // 由加载 effect 起跑时同步）
      const boxTurns = turns ?? displayTurnsRef.current;
      displayTurnsRef.current = boxTurns;
      for (const u of heldRef.current) URL.revokeObjectURL(u);
      heldRef.current = [];
      const prev = displayRef.current;
      if (prev && prev !== next) {
        if (navTransitionRef.current) {
          // 新条目首个展示提交：立即按索引尺寸算新 fit 并切换 view——
          // 否则新图先按上一张的视图渲染、解码完成才挪到中间（慢读时可见一帧错位）
          const stage = stageRef.current;
          if (stage) {
            const f = computeFitForDims(stage, boxDims);
            if (f) {
              viewDimsKeyRef.current = dimsKeyOf(boxDims);
              setView(f);
            }
          }
          fadingRef.current = prev;
          setPrevSrc(prev);
          setPrevView(viewRef.current);
          setPrevDims({ ...oldDimsForFadeRef.current });
          setSwitching(true);
          // 内容加载兜底：正常由新源 onLoad/onError 触发 startSwitchFade
          if (switchSafetyRef.current) clearTimeout(switchSafetyRef.current);
          switchSafetyRef.current = setTimeout(finishSwitchFade, SWITCH_SAFETY_MS);
        } else {
          URL.revokeObjectURL(prev);
        }
      }
      navTransitionRef.current = false;
      displayRef.current = next;
      setDisplaySrc(next);
      displayDimsRef.current = { ...boxDims };
      setDisplayDims({ ...boxDims });
    },
    [finishSwitchFade],
  );

  // 加载链路（M3.3.3/迭代）：与打开详情页同一套——thumb 与原图两路并行、
  // 直方图同步计算；换图时旧图保留显示，新 thumb 就绪后交叉淡出（期间读原图）
  useEffect(() => {
    let alive = true;
    if (!handle || !itemId || !relPath) return;
    /**
     * 本条目已累计的内存旋转次数。**只为兼容两种进入方式**：正常打开时为 0（上一次的旋转
     * 已在退出详情页时落盘，落盘改写 mtime 会让 ref 归零）；同一会话内若上次落盘失败留下残值，
     * 这里据它把图盒朝向摆对，不会把"屏幕朝向"和"磁盘朝向"弄反。
     */
    const turnsAtInit = turnsRef.current;
    /* 本 effect 起跑即代表"展示源归本 effect 管"，同步基准 */
    displayTurnsRef.current = turnsAtInit;
    /**
     * 本次重跑是否由「纯内存旋转」引起：内存旋转**不再写 store**（写了会让主界面跟着重排），
     * 故本 effect 也不会因旋转而重跑——正常路径下这里恒为 false。
     * 保留该判据只为兜住"旋转路径已提交新源、本 effect 恰好也重跑（如 mtime 变化）"的竞态：
     * 那种情况下异步链路带回的是磁盘内容，不能覆盖旋转后的画面。
     */
    const rotationOnly = displayTurnsRef.current !== turnsAtInit;
    displayTurnsRef.current = turnsAtInit;
    // 上一张的旋转显示位图随换图释放（基准位图不在这里清：旋转会让本 effect 重跑，
    // 清空后到异步解码完成之间若用户再点旋转，守卫会因基准位图为空而静默吞掉点击——
    // 表现就是「打开详情只能转一次」。基准位图的释放交给下面的解码路径按 itemId 对位关闭）
    rotatedRef.current?.close();
    rotatedRef.current = null;
    rotatedUrlRef.current = null;
    setLoadState("loading");
    setHist(null);
    setHistFailed(false);
    let thumbUrl: string | null = null;
    let thumbCommitted = false;
    let objectUrl: string | null = null;
    void (async () => {
      // 纯内存旋转引发的重跑：**不提交任何加载结果**（源/盒/视图都已由旋转路径定稿）；
      // 基准位图也不必重取——`baseBitmapRef` 里那张未旋转的位图正是后续旋转要用的基准
      if (rotationOnly) return;
      // 路 1：缩略图（读不到/无 thumb 保持 null，原图兜底）
      if (item?.thumb) {
        try {
          const thumbFile = await readFileBlob(handle, `.ystk/${item.thumb}`);
          if (alive && thumbFile) {
            thumbUrl = URL.createObjectURL(thumbFile);
            commitDisplay(thumbUrl);
            thumbCommitted = true;
          }
        } catch {
          // thumb 读取失败保持 null
        }
      }
      // 路 2：原图 + 直方图/饱和度
      try {
        const file = await readFileBlob(handle, relPath);
        if (!alive || !file) {
          if (alive) setLoadState("failed");
          return;
        }
        objectUrl = URL.createObjectURL(file);
        urlRef.current = objectUrl;
        commitDisplay(objectUrl);
        setLoadState("ready");
        // M3.7 旋转：留一张未旋转的「基准位图」在内存里——点旋转时由它派生旋转后画面，
        // 退出详情页才落盘（用户口径 2026-09-12）。基准位图随本 effect 重跑（换图/mtime 变）替换
        try {
          const bitmap = await decodeImage(file);
          if (!alive) {
            bitmap.close();
            return;
          }
          // 解码期间用户又点了旋转：累计次数已变，旋转路径自己提交过新源/新尺寸，
          // 这里不能再按 init 时的朝向覆盖（否则图与盒子又错开）
          if (turnsRef.current !== turnsAtInit) return;
          // 换到别的条目才关旧基准位图（同一张图因 mtime 变触发本 effect 重跑时，
          // 旧基准位图正好是"未旋转的那张"——关掉它会把正在用的基准也扔掉）
          if (baseBitmapOwnerRef.current && baseBitmapOwnerRef.current !== itemId) {
            baseBitmapRef.current?.close();
          }
          baseBitmapRef.current = bitmap;
          baseBitmapOwnerRef.current = itemId;
          // 图盒朝向 = 磁盘基数 ± 本条目内存旋转次数（ref 与 state 同处写入，
          // 保证 fitView 立刻按同一盒子算，见 displayDimsRef 注释）
          const boxDims = rotatedDimsOf(itemDimsRef.current, turnsAtInit);
          displayDimsRef.current = { ...boxDims };
          setDisplayDims(boxDims);
          const imgData = sampleImageData(bitmap, 64);
          setHist({
            luma: lumaHistogram(imgData, 32),
            sat: satHistogram(imgData, 32),
          });
        } catch {
          if (alive) setHistFailed(true);
        }
      } catch {
        if (alive) setLoadState("failed");
      }
    })();
    return () => {
      alive = false;
      urlRef.current = null;
      // 已创建但未展示的 URL 交给 held，由下一次展示提交（或卸载）统一回收；
      // 已展示的 URL 由 commitDisplay 在替换时回收，换图期间旧图必须保持有效
      if (thumbUrl && !thumbCommitted) heldRef.current.push(thumbUrl);
      if (objectUrl && displayRef.current !== objectUrl) heldRef.current.push(objectUrl);
    };
    // item?.mtime：M3.7 旋转写盘后原图/缩略图同名重写，靠 mtime 变化重跑本 effect 换新图
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commitDisplay 为稳定闭包
  }, [handle, itemId, relPath, item?.thumb, item?.mtime]);

  // 换图（←/→ / 相似图跳转）：旧图保留显示（不重置 view/display），
  // 查看器立即锁定（就绪前禁用缩放/平移），等新缩略图就绪后交叉淡出
  useEffect(() => {
    setImgLoaded(false);
    setPanning(false);
    panRef.current = null;
    viewInitializedRef.current = false;
    /* M3.7：换条目 → 内存旋转累计归零（上一张的旋转已在 LibraryPage 的切图 flush 里落盘）。
       同时清"当前 view 是按哪个盒算的"，让新条目的首个 fit 必定执行 */
    turnsRef.current = 0;
    displayTurnsRef.current = 0;
    viewDimsKeyRef.current = "";
    navTransitionRef.current = true;
    // 取消进行中的淡出（快速连续切换）：旧淡出源立即回收，当前展示保留
    if (switchTimerRef.current) {
      clearTimeout(switchTimerRef.current);
      switchTimerRef.current = null;
    }
    if (switchSafetyRef.current) {
      clearTimeout(switchSafetyRef.current);
      switchSafetyRef.current = null;
    }
    if (fadingRef.current) {
      URL.revokeObjectURL(fadingRef.current);
      fadingRef.current = null;
    }
    setSwitching(false);
    setFading(false);
    setPrevSrc(null);
    setPrevView(null);
    setPrevDims(null);
  }, [itemId]);

  /* M3.7：落盘旋转会改写 mtime（同名文件重写）——那一刻内存旋转已落进磁盘，
     累计次数随之归零，加载 effect 按新文件的真实朝向重新摆盒子 */
  useEffect(() => {
    turnsRef.current = 0;
    viewDimsKeyRef.current = "";
  }, [itemId, item?.mtime]);

  // 卸载（关闭详情）：回收展示/挂起/淡出中的全部 objectURL
  useEffect(() => {
    return () => {
      if (displayRef.current) URL.revokeObjectURL(displayRef.current);
      if (fadingRef.current) URL.revokeObjectURL(fadingRef.current);
      for (const u of heldRef.current) URL.revokeObjectURL(u);
      heldRef.current = [];
    };
  }, []);

  /** 内容盒适配视图：整图可见并居中（口径同 M4 fitToContainer；初始态与 FLIP 终位一致） */
  const fitView = useCallback((): { x: number; y: number; zoom: number } | null => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!stage || !img) return null;
    // 以「图盒尺寸」为准，且**取 ref 而不是 DOM 实测**：`onLoad` 触发时新的 width/height
    // 属性可能还没刷进 DOM，读 clientWidth 会拿到旧朝向的盒子（M3.7 旋转后不居中的根因）。
    // ref 由 commitDisplay 与 setDisplayDims 同一次提交写入，恒为"当前展示源"的盒子。
    const dims = displayDimsRef.current;
    // 展示源尚无盒尺寸（首帧）时退回当前源自然尺寸，最后才退回索引尺寸
    return computeFitForDims(stage, {
      width: dims.width ?? img.clientWidth ?? img.naturalWidth ?? itemDimsRef.current.width,
      height: dims.height ?? img.clientHeight ?? img.naturalHeight ?? itemDimsRef.current.height,
    });
  }, []);

  // 滚轮缩放：光标锚定，缩放前后光标下像素不动（React onWheel 为 passive，原生监听）
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!imgLoadedRef.current || switchingRef.current) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((prev) => {
        const newZoom = Math.min(
          VIEW_MAX_ZOOM,
          Math.max(VIEW_MIN_ZOOM, prev.zoom * Math.exp(-e.deltaY * VIEW_WHEEL_FACTOR)),
        );
        if (newZoom === prev.zoom) return prev;
        const wx = (px - prev.x) / prev.zoom;
        const wy = (py - prev.y) / prev.zoom;
        return { x: px - wx * newZoom, y: py - wy * newZoom, zoom: newZoom };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  /** 1:1 实际像素：以内容盒中心为锚切换（口径同 M4 zoomToActual） */
  const zoomToActual = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const cs = window.getComputedStyle(stage);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const contentW = stage.clientWidth - padLeft - (parseFloat(cs.paddingRight) || 0);
    const contentH = stage.clientHeight - padTop - (parseFloat(cs.paddingBottom) || 0);
    const cx = padLeft + contentW / 2;
    const cy = padTop + contentH / 2;
    setView((prev) => {
      const wx = (cx - prev.x) / prev.zoom;
      const wy = (cy - prev.y) / prev.zoom;
      return { x: cx - wx, y: cy - wy, zoom: 1 };
    });
  };

  /** 适配窗口：整图可见并居中 */
  const fitNow = () => {
    const f = fitView();
    if (f) setView(f);
  };

  /**
   * 拖拽平移：图片已解码且非切换期即可按住鼠标拖动（仅左侧 stage 生效，指针捕获）。
   * M3.6：指针捕获会抑制大图上的原生 dragstart（送去画布的拖拽送出），故按下点
   * 落在大图本体时不起平移——空白/信纸区（stage）行为不变仍可平移。
   */
  const handleStagePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !imgLoaded || switching) return;
    if (imgRef.current && e.target === imgRef.current) return;
    panRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: view.x,
      originY: view.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setPanning(true);
  };

  const handleStagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || e.pointerId !== pan.pointerId) return;
    setView((prev) => ({
      x: pan.originX + (e.clientX - pan.startX),
      y: pan.originY + (e.clientY - pan.startY),
      zoom: prev.zoom,
    }));
  };

  const handleStagePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== e.pointerId) return;
    panRef.current = null;
    setPanning(false);
  };

  // 进入三段并行：挂载后双 rAF 加 .is-entered（与 FLIP 同帧启动），
  // 遮罩 blur 渐变 + 详情卡 opacity/scale 入场由 CSS 过渡承接
  useEffect(() => {
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  /**
   * ←/→ 按当前导航域换图（编辑小窗时不响应）。
   *
   * 2026-09-17 修复「跨图库只读详情页快捷键切图无效」：
   * - 门闸原写 `if (!detailId || !item || editing) return`，而跨库只读查看**全程不写 store**
   *   （`foreignView` 是 LibraryPage 的组件态，`detailId` 恒为 null）→ 只读详情页 ←/→ 完全无响应；
   * - 导航域原写死 `items`（当前库的网格集），只读模式应走该库的命中集 `foreign.items`，
   *   换图走 `goToItem` → `foreign.onIndex`（与相似图格子跳转同一条换图入口）。
   *
   * 位置：必须在 `if (!item) return` **之前**（否则每次渲染的 hook 数不一致，违反 hooks 规则；
   * 原实现即置于该 return 之后）。故此处按 `foreign`/`items` 就地取导航域，不引用 `item`。
   */
  useEffect(() => {
    if (editing) return;
    // 导航域 = 详情页实际展示的那一批：只读模式是外库本批命中（foreign.items），
    // 普通模式是 LibraryPage 传来的 items（已按当前检索/排序整理过的网格集）——
    // 注意**不能用 store 的 items**：那是未过滤全集，会让 ←/→ 跳到看不见的图上。
    const domain = foreign ? foreign.items : items;
    const current = foreign
      ? (foreign.items[foreign.index] ?? null)
      : (items.find((i) => i.id === detailId) ?? null);
    if (!current || domain.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const idx = domain.findIndex((i) => i.id === current.id);
      if (idx < 0) return;
      const next =
        e.key === "ArrowRight"
          ? domain[(idx + 1) % domain.length]
          : domain[(idx - 1 + domain.length) % domain.length];
      if (foreign) foreign.onIndex(domain.indexOf(next));
      else setDetail(next.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [foreign, items, detailId, editing, setDetail]);

  // 选词转 tag（M3.5.3）：描述卡内划词 → 浮钮；关闭条件 = 外部 mousedown / Esc（stopPropagation，不冒泡到页面级 Esc 层）/ item 变化
  useEffect(() => {
    if (!tagify) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (descRef.current?.contains(t)) return;
      if (tagifyBtnRef.current?.contains(t)) return;
      closeTagify();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // capture 阶段拦截：先于 LibraryPage 的 window Esc 层（详情关闭），stopPropagation 不冒泡
        e.stopPropagation();
        closeTagify();
      }
    };
    window.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeTagify 为稳定闭包
  }, [tagify]);
  useEffect(() => {
    setTagify(null); // 左右切图后浮钮不残留
  }, [item?.id]);
  useEffect(
    () => () => {
      if (tagifyLeaveTimerRef.current) clearTimeout(tagifyLeaveTimerRef.current);
    },
    [],
  );

  /** 打开浮钮（新选区）：取消进行中的退场动画 */
  const openTagify = (next: { text: string; x: number; y: number }) => {
    if (tagifyLeaveTimerRef.current) {
      clearTimeout(tagifyLeaveTimerRef.current);
      tagifyLeaveTimerRef.current = null;
    }
    setTagifyLeaving(false);
    setTagify(next);
  };

  /** 关闭浮钮：先播退场（fade + 下移 4px，--motion-fast）再卸载 */
  const closeTagify = () => {
    if (tagifyLeaveTimerRef.current) {
      clearTimeout(tagifyLeaveTimerRef.current);
      tagifyLeaveTimerRef.current = null;
    }
    if (!tagify) return;
    setTagifyLeaving(true);
    tagifyLeaveTimerRef.current = setTimeout(() => {
      tagifyLeaveTimerRef.current = null;
      setTagify(null);
      setTagifyLeaving(false);
    }, 120);
  };

  /** 描述卡划词：非折叠且选区锚点在容器内 → 定位浮钮；否则关闭 */
  const handleDescMouseUp = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      closeTagify();
      return;
    }
    const container = descRef.current;
    if (!container || !container.contains(sel.anchorNode)) {
      closeTagify();
      return;
    }
    const text = sel.toString().trim();
    if (!text) {
      closeTagify();
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    openTagify({
      text,
      x: rect.left + rect.width / 2,
      y: rect.top - 36,
    });
  };

  /** 浮钮禁用原因（null = 可点）：>30 字符 / 与该图既有 tag 重复（不分 source） */
  const tagifyDisabled = tagify && item
    ? tagify.text.length > 30
      ? "标签最长 30 字符"
      : item.tags.some((t) => t.text === tagify.text)
        ? "已是标签"
        : null
    : null;

  /**
   * 详情页「重新识图」（2026-08-23 用户口径）：按图库压缩档位（不强制原图），
   * 确认走应用内对话框（ui/confirm，非浏览器消息），确认后走 store 插队/单图重跑。
   */
  const handleReanalyze = () => {
    if (!item) return;
    const basename = item.relPath.split("/").pop() ?? item.relPath;
    void confirmDialog({
      title: "重新识图",
      message: `将按图库设置中的图片尺寸重新识图「${basename}」，产生一次 API 调用费用。`,
      confirmText: "确定识图",
    }).then((ok) => {
      if (ok) void reanalyzeVisionItem(item.id);
    });
  };

  /**
   * 详情页「旋转」（M3.7，用户口径 2026-09-12 定稿）：顺时针 90° **只在内存里转**——
   * 立刻以基准位图派生旋转后画面替换展示，并把累计次数写进 store（网格格子尺寸随之
   * 横竖互换）；**磁盘原图此刻不动**，等退出详情页时由 LibraryPage 调
   * `flushPendingRotations` 一次性落盘（连点 N 次只重编码一次）。
   *
   * 累计朝向取自 `displayDimsRef`（本组件"当前屏幕上这张"的尺寸），**不是**旋转那一刻的
   * `item.width/height`：store 更新要等下一次渲染才回到本组件，而旋转是连续的——用 item
   * 会在连点时轮流算错方向（第一次点后 item 尚未刷新，第二次又从旧朝向派生）。
   * 本组件展示尺寸与 store 尺寸由同一次点击一起更新，故这里以展示尺寸为准。
   *
   * 直方图不重算：旋转不改变像素值分布（同像素转置），沿用加载时的读数。
   * GIF 在点击处先拦（读盘前给出精确文案）；基准位图未就绪（图还在加载）时按钮禁用。
   */
  const handleRotate = () => {
    if (!item || rotating || !baseBitmapRef.current) return;
    if (isGifPath(item.relPath)) {
      toast(ROTATE_GIF_REJECT);
      return;
    }
    const base = baseBitmapRef.current;
    setRotating(true);
    void spinBitmapDisplay(base)
      .then(({ bitmap, url }) => {
        const oldUrl = rotatedUrlRef.current;
        rotatedRef.current?.close();
        rotatedRef.current = bitmap;
        rotatedUrlRef.current = url;
        if (oldUrl) URL.revokeObjectURL(oldUrl);
        /**
         * **基准位图前移到本次结果**（连点累计的关键）：`spinBitmap` 只转 90°，
         * 且只读不消耗基准位图。若基准位图始终停在最初那张（未旋转的原图），
         * 第二次点击会再把"原图"转 90° → 屏幕上永远是同一个画面、却把累计次数记成 2；
         * 退出详情页按 2 次落盘，磁盘就与屏幕对不上了。
         * 旧基准位图（上一张的展示前身）此刻可以安全释放：新结果已经由 `bitmap` 接管展示。
         */
        if (baseBitmapRef.current && baseBitmapRef.current !== bitmap) {
          baseBitmapRef.current.close();
        }
        baseBitmapRef.current = bitmap;
        // 尺寸取"实际要显示的这张"（基准转 90° 的结果），不取渲染态 state：
        // 连点时 store 更新要等下一次渲染才回到本组件，读 state 会算错朝向。
        // 第三个参数告知"本展示源已计入的累计次数"，加载 effect 据此识别竞态
        const nextDims = { width: bitmap.width, height: bitmap.height };
        turnsRef.current += 1;
        commitDisplay(url, nextDims, turnsRef.current);
        onItemTurns(item.id, turnsRef.current); // 上报 (id, 累计次数) 给 LibraryPage（落盘时机在那里）
        /* 注意：**不调 `rotateItem`**——它 `set({ items })` 会让瀑布流网格立刻按新宽高重排
           （实测被转那一格当场 670px→172px，即"旋转时主界面也跟着动"）。内存旋转只改屏幕，
           落盘与网格刷新留到退出详情页的 `flushPendingRotations`。 */
      })
      .catch((err) => {
        console.warn("[library] 旋转（内存）失败", item?.relPath, err);
        toast("旋转失败");
      })
      .finally(() => setRotating(false));
  };

  /**
   * 详情页「在文件夹中打开」（2026-09-08 用户需求）：弹出系统资源管理器并单击
   * 选中该图。浏览器拿不到绝对路径，交由 dev server 中间件反查后 explorer /select
   * （口径与失败提示见 components/revealInFolder.ts）。
   */
  const handleRevealInFolder = () => {
    // PR-007：只读模式下按**条目所属库**反查路径（该动作只读，跨库照常可用）
    const owner = ro
      ? { libraryId: foreign.libraryId, name: foreign.libraryName }
      : current
        ? { libraryId: current.libraryId, name: current.name }
        : null;
    if (!item || !owner) return;
    void revealInFolder({
      libraryId: owner.libraryId,
      libraryName: owner.name,
      relPath: item.relPath,
    }).then((result) => {
      if (!result.ok) toast(result.error ?? "在文件夹中打开失败");
    });
  };

  /**
   * 送出链路（任务 M3.6）：详情页当前条目 → M4 送去分析 / M1 送去画布；
   * 「送去排版」依赖 M2 后续项，只留置灰占位（无 handler）。
   * 取 File 与跳转口径统一在 sendOut.ts，本组件只管入口。
   */
  const outRef: SendOutRef | null =
    !ro && current && item
      ? { libraryId: current.libraryId, relPath: item.relPath }
      : null;

  const handleSendToLab = () => {
    if (!outRef) return;
    void filesForItems([outRef]).then((files) =>
      sendItemsToLab(files[0] ?? null, navigate),
    );
  };

  const handleSendToCanvas = () => {
    if (!outRef) return;
    void filesForItems([outRef]).then((files) =>
      queueItemsToCanvas(files, navigate),
    );
  };

  /**
   * 送出下拉的 Esc 分层关闭：capture 阶段拦截并 stopPropagation，
   * 避免连带触发 LibraryPage 的 window Esc（关掉整个详情）——口径同 tagify 浮钮。
   */
  useEffect(() => {
    if (!sendOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setSendOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [sendOpen]);

  /**
   * 大图拖拽送出（R4）：与网格缩略图同一 payload 口径——拖的条目在多选集合内
   * 且多选 >1 时带走全部选中项，否则仅当前条目。
   */
  const handleImageDragStart = (e: React.DragEvent<HTMLImageElement>) => {
    if (!outRef) return;
    const view = useLibraryStore.getState();
    const multi =
      view.selectedIds.size > 1 && view.selectedIds.has(item?.id ?? "");
    const refs: SendOutRef[] = multi
      ? allItems
          .filter((i) => view.selectedIds.has(i.id))
          .map((i) => ({ libraryId: outRef.libraryId, relPath: i.relPath }))
      : [outRef];
    beginLibraryItemDrag(e.dataTransfer, refs, {
      el: e.currentTarget,
      fileName: item?.relPath.split("/").pop() ?? "图片",
    });
  };

  // 相似图：多信号加权（M3.3.5，普通模式用 store 全量 items，不按排序）
  // PR-007：只读模式在**该库的命中条目**里找相似（取值域与 ←/→ 一致）
  const similar = useMemo(
    () => (item ? findSimilar(item, ro ? foreign.items : allItems) : []),
    [item, allItems, ro, foreign],
  );

  // 相似图条滚轮 → 横向滚动（2026-08-23 用户口径）：悬停相似图框时滚轮不再滚动
  // 详情页/页面，改滚相似图条；仅当条可横向滚动时接管（不可滚则放行不劫持）。
  // React onWheel 为 passive、preventDefault 无效，沿用原生监听口径（同滚轮缩放）。
  const similarRef = useRef<HTMLDivElement | null>(null);
  const hasSimilar = similar.length > 0;
  useEffect(() => {
    const el = similarRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth) return;
      if (e.deltaY === 0 && e.deltaX === 0) return;
      e.preventDefault();
      const factor =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
      el.scrollLeft += (e.deltaY + e.deltaX) * factor;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasSimilar]);

  /** 基本信息行：内置语义字段（§7.1 表序）+ 自定义字段（extra，label 取 fieldConfig） */
  const basicRows = useMemo(() => {
    if (!item) return [];
    /** url：来源网址行（http(s) 才给），渲染成单行只读框 + 打开按钮 */
    const rows: Array<{ label: string; value: string; url?: string }> = [];
    for (const [key, label] of Object.entries(FIELD_LABELS)) {
      const text = formatFieldValue(item.fields[key]);
      if (text) rows.push({ label, value: text });
    }
    const custom =
      (getSettings().fieldConfig as {
        custom?: Array<{ key: string; label: string }>;
      }).custom ?? [];
    const customLabels = new Map(custom.map((c) => [c.key, c.label]));
    for (const [key, v] of Object.entries(item.extra)) {
      const text = formatFieldValue(v);
      if (!text) continue;
      const url = key === SOURCE_URL_EXTRA_KEY ? httpUrlOf(text) : undefined;
      rows.push({ label: customLabels.get(key) ?? key, value: text, url });
    }
    return rows;
  }, [item]);

  /** FLIP 动画结束：卸克隆层（transitionend 优先，320ms 兜底） */
  const finishFlip = () => {
    if (flipTimerRef.current) {
      clearTimeout(flipTimerRef.current);
      flipTimerRef.current = null;
    }
    setFlipRect(null);
    setFlipOrigin(null);
  };

  // FLIP 进入动画（M3.3.3 transform 版）：克隆层固定在 origin，双 rAF 后
  // 写入 translate(dx,dy) scale(s) 过渡；仅 overlay 首次挂载且 origin 非空时播
  useEffect(() => {
    if (!origin || flipPlayedRef.current) return;
    flipPlayedRef.current = true;
    setFlipOrigin({
      left: origin.left,
      top: origin.top,
      width: origin.width,
      height: origin.height,
    });
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const stage = stageRef.current;
        if (!stage) {
          finishFlip();
          return;
        }
        const cs = window.getComputedStyle(stage);
        // 用 offsetLeft/offsetTop（不受卡片入场 scale 变换影响）量 stage 布局位，
        // 目标位 = 内容盒内按 contain 语义等比居中的图矩形
        const padLeft = parseFloat(cs.paddingLeft) || 0;
        const padTop = parseFloat(cs.paddingTop) || 0;
        const contentW = stage.clientWidth - padLeft - (parseFloat(cs.paddingRight) || 0);
        const contentH =
          stage.clientHeight - padTop - (parseFloat(cs.paddingBottom) || 0);
        const img = imgRef.current;
        let ar = 1;
        const dims = itemDimsRef.current;
        if (dims.width && dims.height && dims.width > 0 && dims.height > 0) {
          ar = dims.width / dims.height;
        } else if (img && img.naturalWidth > 0 && img.naturalHeight > 0) {
          ar = img.naturalWidth / img.naturalHeight;
        } else if (origin.width > 0 && origin.height > 0) {
          ar = origin.width / origin.height;
        }
        let w = Math.max(1, contentW);
        let h = w / ar;
        if (h > contentH) {
          h = Math.max(1, contentH);
          w = h * ar;
        }
        // 入场期间卡片带 scale 变换会成为 stage 的 offsetParent，
        // offsetLeft/Top 是布局坐标（不受自身 transform 影响），
        // 叠加卡片相对 overlay 的 offset 即得视口布局位（overlay fixed 于视口原点）
        const cardEl = stage.parentElement;
        const stageLeft = (cardEl ? cardEl.offsetLeft : 0) + stage.offsetLeft;
        const stageTop = (cardEl ? cardEl.offsetTop : 0) + stage.offsetTop;
        setFlipRect({
          left: stageLeft + padLeft + (contentW - w) / 2,
          top: stageTop + padTop + (contentH - h) / 2,
          width: w,
          height: h,
        });
        flipTimerRef.current = setTimeout(finishFlip, 320);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (flipTimerRef.current) {
        clearTimeout(flipTimerRef.current);
        flipTimerRef.current = null;
      }
      // StrictMode（dev 双跑）下首轮 effect 被 cleanup 取消后，
      // 允许第二轮重新播 FLIP；正常完成后不触发 cleanup，导航不重播
      flipPlayedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finishFlip 为稳定闭包
  }, [origin]);

  if (!item) {
    return createPortal(
      <div className="lib-detail-overlay" onClick={onClose}>
        <p className="lib-detail__muted">条目不存在</p>
      </div>,
      document.body,
    );
  }

  const fileName = item.relPath.split("/").pop() ?? item.relPath;
  const analyzed = item.meanLuma != null && item.meanSat != null;
  /** 当前展示源（thumb 或原图；换图时保留旧图直到新缩略图交叉淡出） */
  const imageSrc = displaySrc;
  /** ←/→ 与相似图的导航域：只读模式是该库的命中条目，否则是当前筛选集 */
  const navItems = ro ? foreign.items : items;
  const prevIdx =
    navItems.length > 0
      ? (navItems.findIndex((i) => i.id === item.id) - 1 + navItems.length) %
        navItems.length
      : -1;
  const nextIdx =
    navItems.length > 0
      ? (navItems.findIndex((i) => i.id === item.id) + 1) % navItems.length
      : -1;
  /**
   * 换图入口（←/→ 与相似图格子共用）：只读模式在 foreign.items 内换 index（不碰 store），
   * 普通模式照旧 `setDetail(id)`。
   */
  const goToItem = (id: string) => {
    if (ro) {
      const i = foreign.items.findIndex((x) => x.id === id);
      if (i >= 0) foreign.onIndex(i);
      return;
    }
    setDetail(id);
  };

  return createPortal(
    <div
      className={
        "lib-detail-overlay" +
        (leaving ? " is-leaving" : "") +
        (entered ? " is-entered" : "") +
        (flipOrigin ? " is-flipping" : "")
      }
      onClick={onClose}
    >
      <div className="lib-detail-card" onClick={(e) => e.stopPropagation()}>
        <div
          className={
            "lib-detail-stage" +
            (imgLoaded ? " has-image" : "") +
            (panning ? " is-panning" : "") +
            (switching ? " is-switching" : "") +
            (fading ? " is-fading" : "")
          }
          ref={stageRef}
          onPointerDown={handleStagePointerDown}
          onPointerMove={handleStagePointerMove}
          onPointerUp={handleStagePointerUp}
          onPointerCancel={handleStagePointerUp}
        >
          {imageSrc ? (
            <>
              <img
                ref={imgRef}
                className="lib-detail__img"
                src={imageSrc}
                alt={fileName}
                width={displayDims.width ?? undefined}
                height={displayDims.height ?? undefined}
                draggable={!ro && imgLoaded && !switching}
                onDragStart={handleImageDragStart}
                onLoad={() => {
                  /* 图片解码完成：首次加载初始化适配位；thumb→原图直换不重置用户视图；
                     但**图盒朝向变了必须重算**（M3.7 旋转 400x200→200x400）——`<img>` 是复用
                     节点，onLoad 每次都会来，不能只看 viewInitializedRef（那只覆盖"首次"） */
                  const boxDims = displayDimsRef.current;
                  const key = dimsKeyOf(boxDims);
                  if (!viewInitializedRef.current || viewDimsKeyRef.current !== key) {
                    viewInitializedRef.current = true;
                    const f = fitView();
                    if (f) {
                      viewDimsKeyRef.current = key;
                      setView(f);
                    }
                  }
                  // 切换期：解码完成才启动交叉淡出（淡出播完才算就绪）；打开/原图直换直接就绪
                  if (switching) startSwitchFade();
                  else setImgLoaded(true);
                }}
                onError={() => {
                  // 新源解码失败：尽快结束切换态（内容加载兜底同口径）
                  if (switching) startSwitchFade();
                }}
                style={{
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
                }}
              />
              {prevSrc && prevView && prevDims && (
                /* 切换淡出中的旧图：冻结旧视图/旧盒，淡出结束后卸载并回收 URL */
                <img
                  className="lib-detail__img lib-detail__img--prev"
                  src={prevSrc}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  width={prevDims.width ?? undefined}
                  height={prevDims.height ?? undefined}
                  style={{
                    transform: `translate(${prevView.x}px, ${prevView.y}px) scale(${prevView.zoom})`,
                  }}
                />
              )}
            </>
          ) : loadState === "failed" ? (
            <div className="lib-detail__error">图片加载失败</div>
          ) : (
            <div
              className="lib-detail__loading"
              role="status"
              aria-label="正在加载图片"
            />
          )}
          <span className="lib-detail__name">{fileName}</span>
          {imgLoaded && !switching && (
            <div
              className="lib-detail__view-controls"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="lib-detail__view-ctrl"
                title="适配窗口"
                aria-label="适配窗口"
                onClick={fitNow}
              >
                <FitIcon />
              </button>
              <button
                type="button"
                className="lib-detail__view-ctrl lib-detail__view-ctrl--text"
                title="实际像素（1:1）"
                aria-label="实际像素"
                onClick={zoomToActual}
              >
                1:1
              </button>
              {/* PR-007：旋转直接改写**当前库**原图文件，跨库只读查看下不渲染 */}
              {!ro && (
                <button
                  type="button"
                  className="lib-detail__view-ctrl"
                  title="顺时针旋转 90°（直接改写原图文件）"
                  aria-label="顺时针旋转 90°"
                  disabled={rotating}
                  style={
                    rotating ? { opacity: 0.5, cursor: "default" } : undefined
                  }
                  onClick={handleRotate}
                >
                  <RotateIcon />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="lib-detail-side">
          <div className="lib-detail__actions">
            <IconButton
              label="上一张"
              onClick={() => prevIdx >= 0 && goToItem(navItems[prevIdx].id)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </IconButton>
            <IconButton
              label="下一张"
              onClick={() => nextIdx >= 0 && goToItem(navItems[nextIdx].id)}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </IconButton>
            {/* PR-007：标星写的是当前库索引，跨库只读查看下不渲染 */}
            {!ro && (
              <IconButton
                label={item.starred ? "取消标星" : "标星"}
                className={item.starred ? "is-starred" : undefined}
                onClick={() => setStarred([item.id], !item.starred)}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill={item.starred ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                </svg>
              </IconButton>
            )}
            <IconButton label="在文件夹中打开" onClick={handleRevealInFolder}>
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {/* 文件夹 + 放大镜（定位语义） */}
                <path d="M3 7a2 2 0 0 1 2-2h3.6l1.6 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                <circle cx="11" cy="13.5" r="3" />
                <path d="M13.1 15.6 15.5 18" />
              </svg>
            </IconButton>
            {/* PR-007：识图重跑入的是当前库队列，跨库只读查看下不渲染 */}
            {!ro && (
              <IconButton label="重新识图" onClick={handleReanalyze}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {/* 循环箭头（两箭头首尾相接，Feather refresh-cw 线型） */}
                  <path d="M23 4v6h-6" />
                  <path d="M1 20v-6h6" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                </svg>
              </IconButton>
            )}
            {/* PR-007：编辑（tag/备注/描述/标星）写的是当前库索引，跨库只读查看下不渲染 */}
            {!ro && (
              <IconButton label="编辑" onClick={() => setEditing(true)}>
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25z" />
                  <path d="M20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                </svg>
              </IconButton>
            )}
            {/* 送出链路（任务 M3.6；2026-09-11 用户反馈：原「送去分析/送去画布/送去排版」
                三枚按钮收成一枚触发器，悬停或聚焦后在下方展开下拉选目的地。
                菜单常驻 DOM、由 .is-open 切 opacity/位移/visibility，进出场同一组过渡，
                故无需卸载编排。
                PR-007：送出按当前库组 ref，跨库只读查看下不渲染（用户口径：绑定本库是对的） */}
            {!ro && (
            <div
              className={"lib-detail__send" + (sendOpen ? " is-open" : "")}
              onMouseEnter={() => setSendOpen(true)}
              onMouseLeave={() => setSendOpen(false)}
              onFocus={() => setSendOpen(true)}
              onBlur={(e) => {
                // 焦点移出「触发器 + 菜单」整块才收起（菜单项之间 Tab 不收起）
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                  setSendOpen(false);
                }
              }}
            >
              <button
                type="button"
                className="lib-detail__iconbtn"
                aria-label="送出"
                aria-haspopup="menu"
                aria-expanded={sendOpen}
                onClick={() => setSendOpen(true)}
              >
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {/* 托盘 + 右上斜出箭头（送出语义，取代原三枚各自的目的地图标） */}
                  <path d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
                  <path d="M14 4h6v6" />
                  <path d="M20 4 11 13" />
                </svg>
              </button>
              <div className="lib-detail__send-menu" role="menu">
                <button type="button" role="menuitem" onClick={handleSendToLab}>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {/* 折线图（分析语义） */}
                    <path d="M3 3v18h18" />
                    <path d="M7 15l4-5 3 3 5-7" />
                  </svg>
                  送去分析
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={handleSendToCanvas}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {/* 方框 + 右上投放箭头（落图语义） */}
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M9 15l6-6" />
                    <path d="M15 9h-4M15 9v4" />
                  </svg>
                  送去画布
                </button>
                <button type="button" role="menuitem" disabled>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    {/* 三栏版式（排版语义） */}
                    <rect x="3" y="4" width="18" height="16" rx="2" />
                    <path d="M9 4v16M15 4v16" />
                  </svg>
                  送去排版
                </button>
              </div>
            </div>
            )}
          </div>

          {/* 每卡统一加载接口（M3.3.3）：卡壳常驻 stagger 入场，未就绪卡内播加载骨架（shimmer / 柱波浪） */}
          <CardSlot
            label="明度直方图"
            delay={0}
            ready={hist !== null || histFailed || !analyzed}
            skeleton={<HistogramSkeleton item={item} />}
          >
            {hist && analyzed ? (
              <>
                <HistogramLegend item={item} />
                <svg
                  className="lib-detail__hist"
                  viewBox="0 0 320 80"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label="明度直方图与饱和度曲线"
                >
                  {(() => {
                    const max = Math.max(...hist.luma, 1);
                    return hist.luma.map((count, i) => {
                      const h = count > 0 ? Math.max(1.5, (count / max) * 72) : 0.5;
                      return (
                        <rect
                          key={i}
                          x={i * 10 + 1.5}
                          y={80 - h}
                          width={7}
                          height={h}
                          rx={1}
                        />
                      );
                    });
                  })()}
                  <SatCurve counts={hist.sat} />
                </svg>
              </>
            ) : (
              <p className="lib-detail__muted">尚未分析</p>
            )}
          </CardSlot>

          <CardSlot label="色板" delay={50} ready skeletonHeight={72}>
            {item.colors.length > 0 ? (
              <div className="lib-detail__swatches">
                {item.colors.map((c) => (
                  <span
                    key={c.hex}
                    className="lib-detail__swatch"
                    style={{
                      flexGrow: Math.max(0.01, c.ratio * 100),
                      background: c.hex,
                    }}
                    title={`${c.hex} · ${(c.ratio * 100).toFixed(1)}%${c.name ? ` · ${c.name}` : ""}`}
                  />
                ))}
              </div>
            ) : (
              <p className="lib-detail__muted">尚未分析</p>
            )}
            {(item.hiColor || item.loColor) && (
              <div className="lib-detail__hilo">
                {item.hiColor && (
                  <span
                    className="lib-detail__hilo-block"
                    style={{ background: item.hiColor.hex }}
                    title={`高光 ${item.hiColor.hex}`}
                  >
                    高光
                  </span>
                )}
                {item.loColor && (
                  <span
                    className="lib-detail__hilo-block"
                    style={{ background: item.loColor.hex }}
                    title={`暗部 ${item.loColor.hex}`}
                  >
                    暗部
                  </span>
                )}
              </div>
            )}
          </CardSlot>

          <CardSlot label="基本信息" delay={75} ready skeletonHeight={140}>
            {basicRows.length > 0 ? (
              <div className="lib-detail__basic">
                {basicRows.map((r) =>
                  r.url ? (
                    <div key={r.label} className="lib-detail__basic-row lib-detail__basic-row--url">
                      <span className="lib-detail__basic-label">{r.label}</span>
                      <span className="lib-detail__url">
                        <input
                          className="lib-detail__url-field"
                          type="text"
                          readOnly
                          value={r.value}
                          title={r.value}
                          aria-label={r.label}
                          onFocus={(e) => e.currentTarget.select()}
                          // ←/→ 留给框内移动光标，不冒泡到详情页的切图快捷键
                          onKeyDown={(e) => {
                            if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.stopPropagation();
                          }}
                        />
                        <button
                          type="button"
                          className="lib-detail__url-open"
                          title="在新标签页打开"
                          aria-label={`在新标签页打开${r.label}`}
                          onClick={() => window.open(r.url, "_blank", "noopener,noreferrer")}
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
                            <path d="M14 4h6v6" />
                            <path d="M20 4 10 14" />
                            <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
                          </svg>
                        </button>
                      </span>
                    </div>
                  ) : (
                    <div key={r.label} className="lib-detail__basic-row">
                      <span className="lib-detail__basic-label">{r.label}</span>
                      <span className="lib-detail__basic-value">{r.value}</span>
                    </div>
                  ),
                )}
              </div>
            ) : (
              <p className="lib-detail__muted">尚无识图信息</p>
            )}
          </CardSlot>

          <CardSlot label="标签" delay={100} ready skeletonHeight={48}>
            {item.tags.length > 0 ? (
              <div className="lib-detail__tags">
                {item.tags.map((t) => (
                  <span
                    key={`${t.text}-${t.source}`}
                    className={
                      "lib-detail__tag" + (t.source === "auto" ? " is-auto" : "")
                    }
                    title={t.source === "auto" ? "识图生成" : undefined}
                  >
                    {t.text}
                  </span>
                ))}
              </div>
            ) : (
              <p className="lib-detail__muted">无标签</p>
            )}
            <div className="lib-detail__vision-status">
              {item.visionVersion === -1
                ? item.visionAt
                  ? `识图失败 · ${formatVisionTime(item.visionAt)}`
                  : "识图失败"
                : item.visionAt
                  ? `已识图 · ${formatVisionTime(item.visionAt)}`
                  : "未识图"}
            </div>
          </CardSlot>

          <CardSlot label="描述" delay={125} ready skeletonHeight={88}>
            {/* 纯展示模型返回文本（用户反馈 2026-08-17）；编辑入口在编辑小窗。
                划词可转标签（M3.5.3）：容器 mousedown/click stopPropagation 防误关详情 */}
            <p
              ref={descRef}
              className="lib-detail__note-preview"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onMouseUp={handleDescMouseUp}
            >
              {item.description || "无描述"}
            </p>
            {/* PR-007：「+ 转为标签」写当前库索引，跨库只读查看下不渲染 */}
            {tagify && !ro && (
              <button
                ref={tagifyBtnRef}
                type="button"
                className={
                  "lib-detail__tagify" +
                  (tagifyLeaving ? " is-leaving" : "") +
                  (tagifyDisabled ? " is-disabled" : "")
                }
                style={{ top: tagify.y, left: tagify.x }}
                title={tagifyDisabled ?? undefined}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (tagifyDisabled) return;
                  addTag([item.id], tagify.text);
                  window.getSelection()?.removeAllRanges();
                  closeTagify();
                }}
              >
                + 转为标签
              </button>
            )}
          </CardSlot>

          <CardSlot label="备注" delay={175} ready skeletonHeight={48}>
            <p className="lib-detail__note-preview">{item.note || "无备注"}</p>
          </CardSlot>

          <CardSlot label="相似图" delay={225} ready skeletonHeight={128}>
            {similar.length > 0 ? (
              <div className="lib-detail__similar" ref={similarRef}>
                {similar.map((s) => (
                  <button
                    key={s.item.id}
                    type="button"
                    className="lib-detail__similar-cell"
                    aria-label={`相似：${s.reasons.join(" · ")}`}
                    onClick={() => goToItem(s.item.id)}
                  >
                    <Thumb
                      handle={handle}
                      relPath={s.item.relPath}
                      alt={s.item.relPath}
                      thumbRelPath={s.item.thumb}
                      mtime={s.item.mtime}
                    />
                    {/* 悬停浮层：直接显示相似命中原因（2026-08-23 用户口径，
                        样式对齐主界面格子底栏浮层） */}
                    <span
                      className="lib-detail__similar-reasons"
                      aria-hidden="true"
                    >
                      {s.reasons.join(" · ")}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="lib-detail__muted">暂无相似图</p>
            )}
          </CardSlot>

        </div>
      </div>

      {flipOrigin && (
        <div
          className="lib-detail__flip"
          style={{
            left: flipOrigin.left,
            top: flipOrigin.top,
            width: flipOrigin.width,
            height: flipOrigin.height,
            transform: flipRect
              ? `translate(${flipRect.left - flipOrigin.left}px, ${flipRect.top - flipOrigin.top}px) scale(${flipRect.width / Math.max(1, flipOrigin.width)})`
              : "none",
          }}
          onTransitionEnd={(e) => {
            if (e.propertyName === "transform") {
              finishFlip();
            }
          }}
        >
          {imageSrc ? (
            <img src={imageSrc} alt="" />
          ) : (
            <div className="lib-detail__flip-placeholder" aria-hidden="true" />
          )}
        </div>
      )}

      {editing && !ro && (
        /* 编辑小窗固定层不向覆盖层冒泡：点小窗遮罩只关小窗、不关详情 */
        <div className="lib-detail__edit-layer" onClick={(e) => e.stopPropagation()}>
          <EditDialog item={item} onClose={() => setEditing(false)} />
        </div>
      )}
    </div>,
    document.body,
  );
}
