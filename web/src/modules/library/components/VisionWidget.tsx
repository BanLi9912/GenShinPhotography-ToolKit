/**
 * M3.5.3.1 识图小窗（右下角，单容器两档：常显 header 行 + 展开 body）：
 * header 行 = 状态点 + 文本 +（运行中中止钮）+ chevron，整行点击展开/收起；
 * 贴底 2px 进度条常显（展开不重复）；body 操作按状态收敛为至多 2 钮（主/次）。
 * M3.5.3.2 升级为逐任务队列：header 一行整合状态+计数+金额（toFixed(2)）；
 * body 改为队列管理——任务列表（waiting/running/done/failed 状态点、waiting 可 ✕ 移出、
 * failed 行红字错误） + 操作分支 + 关闭 foot。
 * M3.5.3.4：中止态 header 带原因（已中止 · abortReason）；小窗设置入口全部移除（设置由
 * 工具栏齿轮进入）；「重试失败项」升级 split 钮 + 范围小菜单（上翻、portal 到 body）。
 * 显示条件：未 dismiss 且（running 或 total>0 或 blockedReason 或 visionPending 或
 * visionBatchRequest 批量确认中）；空闲从未跑过不渲染。
 * M3.5.3.2+ 批量识图改版（2026-08-22 用户口径）：确认从批量面板移到本面板——
 * visionBatchRequest 非空时显示批量确认区（识别未完成项 / 识别全部 / 取消）；
 * 展开态由 store 的 visionWidgetOpen 承担（BatchPanel 可强制展开）。
 * M3.5.3.6：四处确认（新增图片 / 批量识图两个选项 / 重试失败项 / 全部重跑）统一改为
 * 先展示待确认任务清单（QueueConfirmView，行可点开详情）再落确认，不再走纯文字
 * confirmDialog；**新增图片待识图态直接展开该清单**（不再只给「N 张未识图」计数，
 * 确认/取消就在清单底部，用户在确认前即可逐张查看）；任务列表行与缺口行整行可点开
 * 详情；非运行态下 ✕ 删除由 store 帧删除承担。
 * z-index 18：网格之上、设置浮层 19 之下（详情覆盖层打开时被盖住可接受）。
 * 2026-10-24（用户口径）：参考图库工具栏不再有动态信息——「扫描图库」「缩略图/分析」的
 * 进度读数（含速度/预计剩余/失败数）与分析的暂停/继续一并迁到本小窗：收起态 header 一行
 * 短读数 + 贴底 2px 进度条（认当前活动：识图队列运行中 → 图库任务 → 识图静态值），展开态
 * body 顶部给全文读数与暂停/继续。工具栏读数会随数字跳动改导航栏宽度，小窗定宽不受影响。
 * 2026-11-19（用户口径）：图库任务进度优先级提到**最高**——扫描/分析在跑时 header 文本、
 * 状态点、贴底进度条一律只认任务（压过批量确认/待识图确认/识图中/blocked/完成态）；否则
 * 「待识图确认」态下点「重新扫描」，整个扫描期都看不见读数。
 * errors 只活在本轮内存（刷新即失，不落盘——禁区见任务卡 §5）。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  retryVisionFailedIds,
  useLibraryStore,
  visionTodoIdsOf,
} from "../store";
import { getSettings, getItem } from "../index/indexFile";
import {
  scanLibraryGaps,
  type GapScanResult,
} from "../vision/gapScan";

/** 「重试失败项」split 钮范围选项（M3.5.3.4；当前仅「全库」，数组驱动预留如「本轮」） */
const RETRY_SCOPES = [{ id: "all", label: "全库" }] as const;

/** 分析预计剩余格式化：null（速度未知）→ —，<60s → N 秒，否则 N 分
 *  （2026-10-24 从 LibraryPage 原样搬入：图库任务读数已迁到本小窗） */
function formatEta(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.round(seconds / 60)} 分`;
}

/** M3.5.3.6 小窗内确认视图请求（四处确认共用：新增图片/批量识图/重试失败项/全部重跑） */
type QueueConfirmRequest = {
  title: string;
  ids: string[];
  confirmText: string;
  onConfirm: () => void;
};

export function VisionWidget() {
  const vision = useLibraryStore((s) => s.vision);
  const visionDismissed = useLibraryStore((s) => s.visionDismissed);
  const visionPending = useLibraryStore((s) => s.visionPending);
  const visionBatchRequest = useLibraryStore((s) => s.visionBatchRequest);
  const visionWidgetOpen = useLibraryStore((s) => s.visionWidgetOpen);
  const setVisionWidgetOpen = useLibraryStore((s) => s.setVisionWidgetOpen);
  const dismissVisionWidget = useLibraryStore((s) => s.dismissVisionWidget);
  const confirmVisionLaunch = useLibraryStore((s) => s.confirmVisionLaunch);
  const cancelVisionLaunch = useLibraryStore((s) => s.cancelVisionLaunch);
  const startVisionQueue = useLibraryStore((s) => s.startVisionQueue);
  const retryVisionFailed = useLibraryStore((s) => s.retryVisionFailed);
  const abortVisionQueue = useLibraryStore((s) => s.abortVisionQueue);
  const dequeueVisionTask = useLibraryStore((s) => s.dequeueVisionTask);
  const runVisionBatch = useLibraryStore((s) => s.runVisionBatch);
  const clearVisionBatchRequest = useLibraryStore((s) => s.clearVisionBatchRequest);
  const items = useLibraryStore((s) => s.items);
  const rerunVisionAll = useLibraryStore((s) => s.rerunVisionAll);
  const enqueueGapRerun = useLibraryStore((s) => s.enqueueGapRerun);
  /** 图库本地任务进度（扫描 / 分析）：2026-10-24 从参考图库工具栏迁入本小窗——
   *  工具栏读数随数字跳动会改导航栏宽度，小窗定宽（240/300px）+ 文本 ellipsis 不会抖 */
  const scan = useLibraryStore((s) => s.scan);
  const analysis = useLibraryStore((s) => s.analysis);
  const pauseAnalysis = useLibraryStore((s) => s.pauseAnalysis);
  const resumeAnalysis = useLibraryStore((s) => s.resumeAnalysis);

  const { running, total, done, failed, cost, errors, blockedReason, tasks, abortReason } =
    vision;
  /** 图库本地任务（扫描优先）：分析队列在扫描收尾后才启动（store.ts finishScan），
   *  两者实际不会同时跑，这里只是防御性优先顺序 */
  const jobKind: "scan" | "analysis" | null = scan.running
    ? "scan"
    : analysis.running
      ? "analysis"
      : null;
  /** 任务进度百分比（total 未知时 0，读数照常显示已处理张数） */
  const jobPct =
    jobKind === "scan"
      ? scan.total > 0
        ? Math.min(100, Math.round((scan.done / scan.total) * 100))
        : 0
      : jobKind === "analysis"
        ? analysis.total > 0
          ? Math.min(100, Math.round((analysis.done / analysis.total) * 100))
          : 0
        : 0;
  /** 收起态 header 短读数（240px 内放得下；全文见 jobDetail） */
  const jobPill =
    jobKind === "scan"
      ? scan.total > 0
        ? `扫描图库 ${scan.done}/${scan.total}`
        : `扫描图库 · 已扫 ${scan.done} 张`
      : jobKind === "analysis"
        ? `${analysis.stage === "thumbs" ? "缩略图" : "分析"} ${analysis.done}/${analysis.total}` +
          (analysis.paused ? " · 已暂停" : "")
        : "";
  /** 展开态全文读数（文案逐字沿用原工具栏读数：速度 / 预计剩余 / 失败数） */
  const jobDetail =
    jobKind === "scan"
      ? `${
          scan.total > 0
            ? `扫描图库 ${scan.done}/${scan.total} 张`
            : `扫描图库 · 已扫 ${scan.done} 张`
        } · ${scan.perSecond} 张/秒`
      : jobKind === "analysis"
        ? `${analysis.stage === "thumbs" ? "缩略图" : "分析"} ${analysis.done}/${analysis.total} · ${
            analysis.perSecond
          } 张/秒 · 约 ${formatEta(analysis.etaSeconds)}` +
          (analysis.failed > 0 ? ` · ${analysis.failed} 张失败` : "") +
          (analysis.paused ? " · 已暂停" : "")
        : "";
  /** 「重试失败项」split 钮（M3.5.3.4）：范围小菜单开合/锚点（2026-09-03 用户口径：
   *  范围选项显示在主钮下方——改为普通下拉，不再上翻） */
  const [retryMenuOpen, setRetryMenuOpen] = useState(false);
  const [retryScopeId, setRetryScopeId] = useState<string>(RETRY_SCOPES[0].id);
  const [retryMenuPos, setRetryMenuPos] = useState<{
    top: number;
    right: number;
  } | null>(null);
  const retrySplitRef = useRef<HTMLDivElement | null>(null);
  const retryMenuRef = useRef<HTMLDivElement | null>(null);
  /** M3.5.3.5 扫描缺口结果视图：null = 不在缺口视图（常态）；非空 = 显示结果清单 */
  const [gapResult, setGapResult] = useState<GapScanResult | null>(null);
  /** M3.5.3.6 确认清单视图：null = 不在确认环节；非空 = 展示待确认任务清单
   *  （新增图片/批量识图两个选项/重试失败项/全部重跑四处共用同一个视图） */
  const [queueConfirm, setQueueConfirm] = useState<QueueConfirmRequest | null>(
    null,
  );
  /** M3.5.3.3：任务列表滚动容器（running 行自动保持可视用） */
  const tasksListRef = useRef<HTMLDivElement | null>(null);
  /** 图库已识图条数（visionVersion >= 1；-1 失败不计） */
  const visionCount = items.filter((i) => (i.visionVersion ?? 0) >= 1).length;
  /** 图库内存在 -1 跳过标记（识图失败）条目：给「重试失败项」提供回落通道 */
  const hasSkipped = items.some((i) => i.visionVersion === -1);
  /** M3.5.3.6 待识图确认明细（与清单同源：计数与列出的行永远一致）。
   *  2026-09-03 用户反馈的「分列几个未识图/几个失败」由 failed 长度保留 */
  const visionTodoIds = useMemo(() => visionTodoIdsOf(items), [items]);
  /** M3.5.3.6 待识图清单里被 ✕ 移出本轮的行（只影响本次确认，不动图库/索引）；
   *  确认环节结束（确认/取消）与切换图库时清空 */
  const [excludedIds, setExcludedIds] = useState<ReadonlySet<string>>(() => new Set());
  /** 待识图确认队列 = 待识图项 − 已移出项（状态行计数、清单行、确认按钮文案三者同源） */
  const pendingIds = useMemo(
    () => visionTodoIds.pending.filter((id) => !excludedIds.has(id)),
    [visionTodoIds, excludedIds],
  );
  /** 本轮任务全部完成且无失败（2026-08-21 用户反馈口径：完成态绿点/绿文本/绿进度条）。
   *  jobKind 非空时本轮尚未收工（重扫/重分析中），不显示完成态绿色 */
  const allDoneOk =
    jobKind === null &&
    !running &&
    !blockedReason &&
    !visionPending &&
    total > 0 &&
    done + failed === total &&
    failed === 0;
  /** 「重试失败项」显示条件（errors 本轮内存或 -1 跳过标记，回落通道） */
  const canRetry = errors.length > 0 || hasSkipped;
  /** 预算限额暂停态（blockedReason 由预算触发）——blocked 分支主操作文案用「继续识图」 */
  const budgetBlocked =
    typeof blockedReason === "string" &&
    blockedReason.startsWith("已达本轮预算上限");
  /** M3.5.3.3：列表 = 未完成（running/waiting/failed）全量，done 行不渲染（header 已有
   *  计数与失败数，done 逐行无信息增量）；全量简单 DOM、不做虚拟化（数百~数千行可接受） */
  const visibleTasks = tasks.filter((t) => t.status !== "done");
  // 2026-10-24：扫描/分析运行中也要显示（进度已从工具栏迁到这里）
  const visible =
    !visionDismissed &&
    (jobKind !== null ||
      running ||
      total > 0 ||
      blockedReason !== null ||
      visionPending ||
      visionBatchRequest !== null);
  // 新图库识图确认 / 批量识图确认：自动展开详情（确认按钮在 body 操作区）
  useEffect(() => {
    if (visionPending || visionBatchRequest !== null) setVisionWidgetOpen(true);
  }, [visionPending, visionBatchRequest, setVisionWidgetOpen]);

  // 确认环节结束（pending 落下）即清空「已移出」排除集，避免污染下一轮确认
  useEffect(() => {
    if (!visionPending) setExcludedIds((prev) => (prev.size === 0 ? prev : new Set()));
  }, [visionPending]);

  // 范围菜单外点/Esc 关闭（点菜单项自身由 onClick 关闭；pointerdown 在菜单/按钮内不关）
  useEffect(() => {
    if (!retryMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (
        retrySplitRef.current?.contains(target) ||
        retryMenuRef.current?.contains(target)
      ) {
        return;
      }
      setRetryMenuOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRetryMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [retryMenuOpen]);

  // M3.5.3.3：running 行自动保持可视——每次任务推进（tasks 引用更新）把列表拉回首个
  // running 行；用户手动滚动会被下一次推进打断，接受（进度跟随优先）
  useEffect(() => {
    const el = tasksListRef.current?.querySelector(".lib-vw__task.is-running");
    el?.scrollIntoView({ block: "nearest" });
  }, [tasks]);

  if (!visible) return null;

  /** 贴底 2px 进度条读数：当前图库任务（扫描/分析）→ 识图队列运行中 → 识图队列静态值。
   *  2026-11-19 顺序与 header 文本一致：任务在跑就只画任务进度，不出现「文本说任务、
   *  条子却画识图」的错配 */
  const pct =
    jobKind !== null
      ? jobPct
      : running
        ? total > 0
          ? Math.min(100, Math.round((done / total) * 100))
          : 0
        : total > 0
          ? Math.min(100, Math.round((done / total) * 100))
          : 0;

  // header 文本（M3.5.3.2 §4.4 逐字表：一行整合状态+计数+金额；金额 toFixed(2)）
  const amount = cost.amount.toFixed(2);
  let pillText: ReactNode;
  if (jobKind !== null) {
    // 2026-11-19 用户口径：图库任务进度优先级**最高**，高于一切提示/确认态。此前它排在
    // 批量确认、待识图确认、识图中之后，于是「新图库待识图确认」态下点「重新扫描」，整个
    // 扫描期 header 都停在「待识图确认」、读数根本看不见
    pillText = jobPill;
  } else if (visionBatchRequest !== null) {
    pillText = `批量识图待确认 · ${visionBatchRequest.ids.length} 张`;
  } else if (visionPending) {
    pillText = "待识图确认";
  } else if (running) {
    pillText = `识图中 ${done}/${total} · ¥${amount}`;
  } else if (blockedReason) {
    pillText = "识图未启动";
  } else if (done + failed < total) {
    // M3.5.3.4：中止态带原因（「已中止 · <abortReason>」）；无原因维持现状文案
    pillText = abortReason
      ? `已中止 · ${abortReason}`
      : `已中止 ${done}/${total} · ¥${amount}`;
  } else if (failed > 0) {
    pillText = (
      <>
        已识图 {visionCount}/{items.length} · 失败{" "}
        <span className="is-error">{failed}</span> · ¥{amount}
      </>
    );
  } else {
    pillText = `已识图 ${visionCount}/${items.length} · ¥${amount}`;
  }

  // 状态点：图库任务在跑 → 脉动（同 header 文本的最高优先）；批量确认/新库 pending 无类
  // （accent）/ 识图运行中脉动 / 失败或 blocked 红 / 其余绿
  const dotCls =
    jobKind !== null
      ? " is-running"
      : visionBatchRequest !== null || visionPending
        ? ""
        : running
          ? " is-running"
          : failed > 0 || blockedReason
            ? " is-error"
            : " is-ok";

  /**
   * M3.5.3.6 确认清单行数据：id → 文件名（title = 完整 relPath）+ 状态点类。
   * 「任务已不在图库」的 id（条目被删/移出）整行跳过，避免确认清单列出打不开的幽灵行。
   */
  const confirmRows = (ids: string[]) =>
    ids.flatMap((id) => {
      const it = getItem(id);
      if (!it) return [];
      const v = it.visionVersion ?? 0;
      const cls =
        v === -1
          ? "is-failed"
          : v >= 1 && (it.visionAt ?? 0) >= it.mtime
            ? "is-done"
            : "is-waiting";
      return [
        {
          id,
          name: it.relPath.split("/").pop() ?? it.relPath,
          fullPath: it.relPath,
          cls,
        },
      ];
    });

  /** 行点击开详情（任务行/缺口行/确认清单行共用）：条目已不在图库则不可点 */
  const openDetailOf = (id: string) => {
    if (!getItem(id)) return;
    useLibraryStore.getState().setDetail(id);
  };

  /** 打开一处确认清单（四处确认统一入口；确认动作由调用方闭包携带） */
  const openQueueConfirm = (
    title: string,
    ids: string[],
    confirmText: string,
    onConfirm: () => void,
  ) => setQueueConfirm({ title, ids, confirmText, onConfirm });

  /** 全部重跑：确认清单 = 全部条目（M3.5.3.6 起不再走纯文字对话框） */
  const handleRerunAll = () => {
    if (vision.running) return;
    const allIds = useLibraryStore.getState().items.map((i) => i.id);
    openQueueConfirm(
      "全库重跑识图",
      allIds,
      `确定重跑（${allIds.length}）`,
      // 执行时现取 id（清单只读、期间图库可能变化），文案与清单展示的张数一致即可
      () => void rerunVisionAll(),
    );
  };

  /** 「重试失败项」主钮：确认清单 = 帧内 failed + 帧外 -1（与计数同源） */
  const handleRetryFailed = () => {
    if (vision.running) return;
    const ids = retryVisionFailedIds();
    openQueueConfirm("重试识图失败项", ids, `确定重试（${ids.length}）`, () =>
      void retryVisionFailed(),
    );
  };

  /** 批量识图确认（M3.5.3.6）：两个选项各自先列清单——pending = 未完成子集，all = 全部 */
  const openBatchConfirm = (mode: "pending" | "all") => {
    const req = useLibraryStore.getState().visionBatchRequest;
    if (!req) return;
    const ids =
      mode === "pending"
        ? visionTodoIdsOf(
            req.ids.flatMap((id) => {
              const it = getItem(id);
              return it ? [it] : [];
            }),
          ).pending
        : req.ids;
    openQueueConfirm(
      mode === "pending" ? "批量识图 · 识别未完成项" : "批量识图 · 识别全部",
      ids,
      mode === "pending"
        ? `识别未完成项（${ids.length}）`
        : `识别全部（${ids.length}）`,
      () => void runVisionBatch(mode),
    );
  };

  /**
   * M3.5.3.5 扫描缺口：同步扫 store 当前 items（纯内存，毫秒级），结果进组件 state
   * （不落盘、不改条目），并切到缺口结果视图。
   */
  const handleGapScan = () => {
    const result = scanLibraryGaps(useLibraryStore.getState().items, getSettings().fieldConfig);
    setGapResult(result);
  };

  /** 缺口「全部入队」：按缺口 id 一律重跑（含字段不全但 visionVersion≥1 的条目——
   *  enqueueGapRerun 语义；入队/启动后视图随 running 态自然切回） */
  const handleGapEnqueue = () => {
    if (!gapResult || gapResult.gaps.length === 0) return;
    setGapResult(null);
    void enqueueGapRerun(gapResult.gaps.map((g) => g.id));
  };

  /** 「返回」：回完成终态视图（清缺口结果，不触发识图） */
  const handleGapBack = () => setGapResult(null);

  /** 打开范围菜单：下拉锚定（菜单顶边贴 split 下缘 +4、右缘对齐 split 右缘 ▾ 所在侧；
   *  范围选项位于主钮下方——2026-09-03 用户口径，不再上翻）。
   *  右缘用 visualViewport 尺寸计算（fixed 以视觉视口为含块——缩放/滚动条环境下与
   *  innerWidth 有偏差，直接量 rect 会错位） */
  const openRetryMenu = () => {
    const el = retrySplitRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const width = vv?.width ?? window.innerWidth;
    setRetryMenuPos({
      top: rect.bottom + 4,
      right: width - rect.right,
    });
    setRetryMenuOpen(true);
  };

  /** 「重试失败项」split 钮（主钮 = 当前范围执行（全库），▾ 展开范围小菜单）——
   *  blockedReason 回落态（帧失、全库 -1）与失败终态帧两处复用同一 JSX */
  const retrySplit = (
    <div
      ref={retrySplitRef}
      className="lib-vw__split"
      style={{ display: "flex", flex: 1, minWidth: 0 }}
    >
      <button
        type="button"
        className="lib-vw__action lib-vw__action--primary lib-vw__split-main"
        style={{
          borderRadius: "var(--radius-sm) 0 0 var(--radius-sm)",
        }}
        onClick={handleRetryFailed}
      >
        重试失败项
      </button>
      <button
        type="button"
        className="lib-vw__action lib-vw__action--primary lib-vw__split-arrow"
        style={{
          flex: "0 0 26px",
          width: 26,
          padding: 0,
          marginLeft: -1,
          borderRadius: "0 var(--radius-sm) var(--radius-sm) 0",
        }}
        title="选择重试范围"
        aria-label="选择重试范围"
        aria-haspopup="menu"
        aria-expanded={retryMenuOpen}
        onClick={openRetryMenu}
      >
        <span aria-hidden="true">▾</span>
      </button>
    </div>
  );

  return (
    <div className={"lib-vw" + (visionWidgetOpen ? " is-open" : "")}>
      {/* header 行 = 收起态全貌（常显）；整行点击展开/收起；内部按钮 stopPropagation */}
      <div
        className="lib-vw__head"
        onClick={() => setVisionWidgetOpen(!visionWidgetOpen)}
      >
        <span className={"lib-vw__dot" + dotCls} aria-hidden="true" />
        <span className={"lib-vw__text" + (allDoneOk ? " is-ok" : "")}>
          {pillText}
        </span>
        {/* 图库分析进行中：暂停/继续（原来在工具栏读数旁，2026-10-24 随读数迁入；
            点钮不触发展开/收起，故 stopPropagation） */}
        {jobKind === "analysis" && (
          <button
            type="button"
            className="lib-vw__icon-btn"
            title={analysis.paused ? "继续分析" : "暂停分析"}
            aria-label={analysis.paused ? "继续分析" : "暂停分析"}
            onClick={(e) => {
              e.stopPropagation();
              if (analysis.paused) resumeAnalysis();
              else pauseAnalysis();
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              {analysis.paused ? (
                <path d="M8 5v14l11-7z" />
              ) : (
                <>
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </>
              )}
            </svg>
          </button>
        )}
        {running && (
          <button
            type="button"
            className="lib-vw__icon-btn"
            title="中止（已完成条目不会重跑）"
            aria-label="中止识图"
            onClick={(e) => {
              e.stopPropagation();
              abortVisionQueue();
            }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
        )}
        <svg
          className={"lib-vw__chevron" + (visionWidgetOpen ? " is-up" : "")}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>
      {/* 贴 header 行底缘的常显进度条（2px；收起态也有进度指示，展开不重复第二个） */}
      <div className="lib-vw__bar">
        <span
          className={allDoneOk ? "is-ok" : ""}
          style={{ width: `${pct}%` }}
        />
      </div>
      {/* body = 展开态内容（常挂载：grid-template-rows 0fr/1fr + opacity 双向过渡才能播
          收起动效——条件卸载无法退场，故不以 visionWidgetOpen 卸载；收起态 visibility 隐藏移出
          可聚焦/可读树，功能逻辑与显示条件不受影响） */}
      <div className="lib-vw__body" aria-hidden={!visionWidgetOpen}>
        <div className="lib-vw__body-clip">
          <div className="lib-vw__body-inner">
            {/* 图库任务进度（扫描 / 分析；2026-10-24 从工具栏读数迁入）：收起态看 header
                短读数 + 贴底细条，展开态在这里看全文（速度/预计剩余/失败数）并能停/继续。
                扫描不提供暂停：后台重扫不支持（store.ts rescan 注释） */}
            {jobKind !== null && (
              <div className="lib-vw__job">
                <span className="lib-vw__job-text" title={jobDetail}>
                  {jobDetail}
                </span>
                {jobKind === "analysis" && (
                  <button
                    type="button"
                    className="lib-vw__text-btn"
                    onClick={analysis.paused ? resumeAnalysis : pauseAnalysis}
                  >
                    {analysis.paused ? "继续" : "暂停"}
                  </button>
                )}
              </div>
            )}
            {/* M3.5.3.5 扫描缺口结果视图：缺口视图时替换常态内容（任务/操作区），
                底部按钮「全部入队 + 返回」；foot「关闭」仍常显 */}
            {gapResult === null ? (
              <>
            {/* 新增图片确认（M3.5.3.6）：待识图态**直接复用识图小窗的队列 UI**
                （`.lib-vw__tasks` + 状态点/文件名/✕，与运行中队列逐字同构、同一套样式），
                确认前即可逐张查看、整行点击开详情、waiting 行可 ✕ 直接移出待跑集；
                确认/取消按钮沿用原操作区（不再另造一套「确认清单」外观） */}
            {visionPending && (
              <>
                <div className="lib-vw__status">
                  存在待识图的图片（{pendingIds.length} 张未识图
                  {visionTodoIds.failed.length > 0
                    ? ` · ${visionTodoIds.failed.length} 张识图失败`
                    : ""}
                  ），是否开始识图？
                </div>
                <div className="lib-vw__tasks">
                  {/* 清单 = 未识图项（可 ✕ 移出）＋ 识图失败项（-1，红点、无 ✕）
                      两者都列，才与状态行的「N 张未识图 · M 张识图失败」计数对得上
                      （卡：计数与实际张数必须一致）；确认时两类都入队 */}
                  {confirmRows([...pendingIds, ...visionTodoIds.failed]).map((r) => (
                    <div
                      className={"lib-vw__task is-clickable " + r.cls}
                      key={r.id}
                      onClick={() => openDetailOf(r.id)}
                    >
                      <span className="lib-vw__task-dot" aria-hidden="true" />
                      <span className="lib-vw__task-name" title={r.fullPath}>
                        {r.name}
                      </span>
                      {/* 队列管理（卡 §1.3：✕ 只在 waiting 行）：确认前即可把不想跑的图移出
                          待跑集。只记"本次确认不跑"的排除集（excludedIds），不动图库/索引；
                          confirmVisionLaunch 执行时现取口径，剔除后自然不入队（等价"移出队列"） */}
                      {r.cls === "is-waiting" && (
                        <button
                          type="button"
                          className="lib-vw__task-remove"
                          title="移出队列"
                          aria-label="移出队列"
                          onClick={(e) => {
                            e.stopPropagation();
                            setExcludedIds((prev) => new Set(prev).add(r.id));
                          }}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                  {pendingIds.length === 0 && (
                    <div className="lib-vw__tasks-more">没有待识图的条目</div>
                  )}
                </div>
              </>
            )}
            {/* 错误/提示行与确认行互斥：确认态（pending）或批量确认时不渲染残留
                blockedReason，避免两行同屏（2026-09-03 用户反馈） */}
            {!visionPending && visionBatchRequest === null && blockedReason && (
              <div className="lib-vw__status is-error">{blockedReason}</div>
            )}
            {/* 批量识图确认区（2026-08-22 用户改版：确认从批量面板移到这里）。
                M3.5.3.6：两个选项都不再直接执行，各自先展开对应清单（未完成子集 / 全部），
                清单里再落确认——与新增图片/重试失败项/全部重跑四处口径统一 */}
            {visionBatchRequest !== null && queueConfirm === null && (
              <div className="lib-vw__batch">
                <div className="lib-vw__batch-title">
                  批量识图 · 选中 {visionBatchRequest.ids.length} 张
                </div>
                <div className="lib-vw__batch-desc">
                  其中 {visionBatchRequest.pendingCount} 张未完成识图；按图库压缩档位
                  （非原图），产生 API 调用费用
                </div>
                <div className="lib-vw__actions">
                  <button
                    type="button"
                    className="lib-vw__action lib-vw__action--primary"
                    onClick={() => openBatchConfirm("pending")}
                  >
                    识别未完成项（{visionBatchRequest.pendingCount}）
                  </button>
                  <button
                    type="button"
                    className="lib-vw__action"
                    title="已完成条目也会重跑并产生费用"
                    onClick={() => openBatchConfirm("all")}
                  >
                    识别全部（{visionBatchRequest.ids.length}）
                  </button>
                  <button
                    type="button"
                    className="lib-vw__action"
                    onClick={clearVisionBatchRequest}
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
            {/* 任务列表（M3.5.3.2 队列管理）：本轮 tasks 非空时显示。
                M3.5.3.3：内容 = 未完成全量滚动（done 不渲染），无 cap 提示。
                M3.5.3.6：确认环节由清单视图承担，本列表让位（避免两处列表同屏）；
                R3 起整行可点 → 打开该图详情页，✕ 删除钮 stopPropagation 不触发行点击 */}
            {queueConfirm === null && !visionPending && tasks.length > 0 && (
              <div className="lib-vw__tasks" ref={tasksListRef}>
                {visibleTasks.map((t) => (
                  <div
                    className={
                      "lib-vw__task is-" +
                      t.status +
                      (getItem(t.id) ? " is-clickable" : "")
                    }
                    key={t.id}
                    onClick={() => openDetailOf(t.id)}
                  >
                    <span className="lib-vw__task-dot" aria-hidden="true" />
                    <span className="lib-vw__task-name" title={t.relPath}>
                      {t.relPath.split("/").pop()}
                    </span>
                    {t.status === "failed" && (
                      <span className="lib-vw__task-error" title={t.error}>
                        {t.error}
                      </span>
                    )}
                    {t.status === "waiting" && (
                      <button
                        type="button"
                        className="lib-vw__task-remove"
                        title="移出队列"
                        aria-label="移出队列"
                        onClick={(e) => {
                          e.stopPropagation();
                          dequeueVisionTask(t.id);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {/* M3.5.3.3 完成收口：无未完成任务时列表区弱字提示（复用弱字样式类） */}
                {visibleTasks.length === 0 && (
                  <div className="lib-vw__tasks-more">本轮任务已全部完成</div>
                )}
              </div>
            )}
            {/* M3.5.3.6 确认清单视图：四处确认（新增图片/批量识图两选项/重试失败项/全部重跑）
                统一先列清单再确认；确认/取消后各自回落到原视图 */}
            {queueConfirm !== null && (
              <QueueConfirmView
                title={queueConfirm.title}
                rows={confirmRows(queueConfirm.ids)}
                confirmText={queueConfirm.confirmText}
                onConfirm={() => {
                  const act = queueConfirm.onConfirm;
                  setQueueConfirm(null);
                  act();
                }}
                onCancel={() => setQueueConfirm(null)}
                onOpenDetail={openDetailOf}
              />
            )}
            {/* 操作区：批量确认进行中（visionBatchRequest 非空）只保留 running 中止钮，
                其余启动/继续/重试/全部重跑分支让位给批量确认区，避免两区按钮混杂。
                M3.5.3.6：确认清单一展开，启动类按钮一并让位（清单底部自带「确认/取消」），
                避免同一屏出现两套互相矛盾的按钮。新增图片态**保留本区**——队列 UI 在上方，
                确认/取消就是这一对按钮（与原 pending 态口径一致，只是上方多了队列） */}
            {queueConfirm === null && (visionBatchRequest === null || running) && (
              <div className="lib-vw__actions">
                {visionPending ? (
                <>
                  <button
                    type="button"
                    className="lib-vw__action lib-vw__action--primary"
                    onClick={() => confirmVisionLaunch([...excludedIds])}
                  >
                    确认开始识图（{pendingIds.length}）
                  </button>
                  <button
                    type="button"
                    className="lib-vw__action"
                    onClick={() => {
                      setExcludedIds(new Set());
                      cancelVisionLaunch();
                    }}
                  >
                    取消
                  </button>
                </>
              ) : running ? (
                <button
                  type="button"
                  className="lib-vw__action lib-vw__action--primary"
                  onClick={abortVisionQueue}
                >
                  中止识图
                </button>
              ) : blockedReason ? (
                // M3.5.3.4：小窗设置入口全部移除（设置由工具栏齿轮进入）。
                // 2026-08-31 用户反馈修复：blocked 提示「可点重试失败项」时必须真给出该入口——
                // 帧失（刷新后）全库 -1 回落态下 blockedReason 分支原本只有「开始识图」；
                // canRetry 为真时：开始识图在上、重试失败项 split 独占下一整行（2026-09-03 用户口径）
                canRetry ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "var(--space-2)",
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <button
                      type="button"
                      className="lib-vw__action"
                      onClick={() => void startVisionQueue()}
                    >
                      {budgetBlocked ? "继续识图" : "开始识图"}
                    </button>
                    <div style={{ display: "flex", width: "100%" }}>
                      {retrySplit}
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="lib-vw__action lib-vw__action--primary"
                    onClick={() => void startVisionQueue()}
                  >
                    {budgetBlocked ? "继续识图" : "开始识图"}
                  </button>
                )
              ) : done + failed < total ? (
                <>
                  <button
                    type="button"
                    className="lib-vw__action lib-vw__action--primary"
                    onClick={() => void startVisionQueue()}
                  >
                    继续识图
                  </button>
                  <button
                    type="button"
                    className="lib-vw__action"
                    onClick={handleRerunAll}
                  >
                    全部重跑
                  </button>
                </>
              ) : failed > 0 ? (
                canRetry ? (
                  <>
                    {/* M3.5.3.4 「重试失败项」split 钮（复用 retrySplit JSX） + 全部重跑 */}
                    {retrySplit}
                    <button
                      type="button"
                      className="lib-vw__action"
                      onClick={handleRerunAll}
                    >
                      全部重跑
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="lib-vw__action lib-vw__action--primary"
                    onClick={handleRerunAll}
                  >
                    全部重跑
                  </button>
                )
              ) : (
                <>
                  {/* M3.5.3.5 扫描缺口：与「全部重跑」并列（完成终态；扫全库按本库字段配置
                      筛未识图/字段不全，纯本地只读秒出） */}
                  <button
                    type="button"
                    className="lib-vw__action lib-vw__action--primary"
                    onClick={handleRerunAll}
                  >
                    全部重跑
                  </button>
                  <button
                    type="button"
                    className="lib-vw__action"
                    onClick={handleGapScan}
                  >
                    扫描缺口
                  </button>
                </>
              )}
              </div>
            )}
              </>
              ) : (
              <>
                <div className="lib-vw__status">
                  缺口 {gapResult.gaps.length} 项（未识图 {gapResult.neverRunCount}
                  {" · "}字段不全 {gapResult.fieldGapCount}）
                </div>
                {gapResult.gaps.length === 0 ? (
                  <div className="lib-vw__tasks-more">全库识图数据完整</div>
                ) : (
                  <div className="lib-vw__tasks">
                    {gapResult.gaps.map((g) => (
                      <div
                        className={
                          "lib-vw__task" + (getItem(g.id) ? " is-clickable" : "")
                        }
                        key={g.id}
                        onClick={() => openDetailOf(g.id)}
                      >
                        <span className="lib-vw__task-name" title={g.relPath}>
                          {g.relPath.split("/").pop()}
                        </span>
                        <span
                          title={g.missing.join("、")}
                          style={{
                            flexShrink: 0,
                            maxWidth: "55%",
                            color: "var(--text-2)",
                            fontFamily: "inherit",
                            fontSize: "var(--text-xs)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {g.missing.join("、")}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="lib-vw__actions">
                  <button
                    type="button"
                    className="lib-vw__action lib-vw__action--primary"
                    disabled={gapResult.gaps.length === 0}
                    style={
                      gapResult.gaps.length === 0 ? { opacity: 0.45 } : undefined
                    }
                    onClick={handleGapEnqueue}
                  >
                    全部入队
                  </button>
                  <button
                    type="button"
                    className="lib-vw__action"
                    onClick={handleGapBack}
                  >
                    返回
                  </button>
                </div>
              </>
              )}
            <div className="lib-vw__foot">
              {/* M3.5.3.4：foot 设置入口移除（设置由工具栏齿轮进入），foot 只留「关闭」 */}
              <button
                type="button"
                className="lib-vw__text-btn"
                title="关闭识图小窗"
                onClick={() => {
                  if (visionPending) cancelVisionLaunch();
                  else dismissVisionWidget();
                }}
              >
                关闭
              </button>
            </div>
            {/* 范围菜单：portal 到 body（.lib-vw 含 backdrop-filter + overflow:hidden，
                会裁切 fixed 后代）——下拉（选项在主钮下方），视觉沿用既有玻璃浮层 menu 类 */}
            {retryMenuOpen &&
              queueConfirm === null &&
              retryMenuPos &&
              createPortal(
                <div
                  ref={retryMenuRef}
                  className="lib-cell__menu"
                  style={{
                    top: retryMenuPos.top,
                    right: retryMenuPos.right,
                  }}
                  role="menu"
                  aria-label="重试范围"
                >
                  {RETRY_SCOPES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={s.id === retryScopeId}
                      onClick={() => {
                        setRetryScopeId(s.id);
                        setRetryMenuOpen(false);
                      }}
                    >
                      {s.id === retryScopeId && (
                        <span
                          aria-hidden="true"
                          style={{
                            color: "var(--accent)",
                            fontWeight: 600,
                          }}
                        >
                          ✓{" "}
                        </span>
                      )}
                      {s.label}
                    </button>
                  ))}
                </div>,
                document.body,
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** 确认清单行（由 `confirmRows` 组装；行数据与状态点类都在那里定型） */
type QueueConfirmRow = {
  id: string;
  name: string;
  fullPath: string;
  cls: string;
};

/**
 * M3.5.3.6 确认清单视图（小窗内局部组件，四处确认共用）：
 * 标题行含张数 → 可滚清单（行 = 状态点 + 文件名，整行点击打开详情页，清单保留以便返回继续
 * 审查）→ 底部「确认文案（含 N）」+「取消」。
 * 不用全局 `ui/confirm` 扩展：它只支持纯文本、且 z-200 会盖住详情页 z-40——小窗内自建视图
 * 既与本面板既有确认区风格一致，也避开层级问题。千级清单（全部重跑）按 M3.5.3.3 同口径
 * 全量渲染 + 容器滚动，不引虚拟化。
 */
function QueueConfirmView({
  title,
  rows,
  confirmText,
  onConfirm,
  onCancel,
  onOpenDetail,
}: {
  title: string;
  rows: QueueConfirmRow[];
  confirmText: string;
  onConfirm: () => void;
  onCancel: () => void;
  onOpenDetail: (id: string) => void;
}) {
  return (
    <div className="lib-vw__batch">
      <div className="lib-vw__batch-title">
        {title} · 待确认 {rows.length} 张
      </div>
      {rows.length === 0 ? (
        <div className="lib-vw__tasks-more">没有待确认的条目</div>
      ) : (
        <div className="lib-vw__tasks lib-vw__tasks--confirm">
          {rows.map((r) => (
            <div
              className={"lib-vw__task is-clickable " + r.cls}
              key={r.id}
              title={r.fullPath}
              onClick={() => onOpenDetail(r.id)}
            >
              <span className="lib-vw__task-dot" aria-hidden="true" />
              <span className="lib-vw__task-name" title={r.fullPath}>
                {r.name}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="lib-vw__actions">
        <button
          type="button"
          className="lib-vw__action lib-vw__action--primary"
          onClick={onConfirm}
        >
          {confirmText}
        </button>
        <button type="button" className="lib-vw__action" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
