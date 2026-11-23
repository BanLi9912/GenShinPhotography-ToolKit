/**
 * M3.3.1 多选批量小窗（BatchPanel）：右侧浮动面板承载全部批量操作。
 * 收起/展开/拖宽交互为代码移植自 M4 分析面板 dock（LabPage.tsx:66-173，
 * 架构铁律禁止 import modules/lab 内部，故复制适配并注明出处）。
 * 宽度 localStorage 持久化（ystk-lib-batchpanel-width，clamp 240–480）；
 * collapsed 不持久化，每次进多选模式默认展开。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLibraryStore } from "../store";
import { isVisionPending } from "../vision/queue";
import { toast } from "../../../ui/toast";
import { filesForItems, queueItemsToCanvas, type SendOutRef } from "../sendOut";

const PANEL_STORAGE_KEY = "ystk-lib-batchpanel-width";
const DEFAULT_WIDTH = 300;
const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
/** 一次送去画布的张数上限（任务 M3.6 R5.2；超出截断并提示） */
const SEND_TO_CANVAS_LIMIT = 50;

/** 读取持久化宽度；缺失/非法/异常一律回退默认（参考 lab/store.ts:106-132） */
function loadPanelWidth(): number {
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return DEFAULT_WIDTH;
    const value = Number(raw);
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) {
      return Math.round(value);
    }
    return DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

/** 写回持久化（try/catch：隐私模式等写入失败不写崩） */
function savePanelWidth(width: number): void {
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, String(width));
  } catch {
    /* 写入失败静默忽略 */
  }
}

/** 面板内联输入：input + 确认按钮，Enter 确认（自 LibraryPage.tsx 迁入） */
function BatchInput({
  placeholder,
  label,
  disabled,
  onConfirm,
}: {
  placeholder: string;
  label: string;
  disabled?: boolean;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const confirm = () => {
    onConfirm(value);
    setValue("");
  };
  return (
    <div className="lib-batchpanel__item">
      <input
        className="lib-batchpanel__input"
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") confirm();
        }}
      />
      <button
        type="button"
        className="lib-toolbar__btn"
        disabled={disabled}
        onClick={confirm}
      >
        {label}
      </button>
    </div>
  );
}

export function BatchPanel({ leaving = false }: { leaving?: boolean }) {
  const selectedIds = useLibraryStore((s) => s.selectedIds);
  const addTag = useLibraryStore((s) => s.addTag);
  const removeTag = useLibraryStore((s) => s.removeTag);
  const setNote = useLibraryStore((s) => s.setNote);
  const setStarred = useLibraryStore((s) => s.setStarred);
  const selectAll = useLibraryStore((s) => s.selectAll);
  const clearSelection = useLibraryStore((s) => s.clearSelection);
  const setSelectMode = useLibraryStore((s) => s.setSelectMode);
  const requestVisionBatch = useLibraryStore((s) => s.requestVisionBatch);
  const items = useLibraryStore((s) => s.items);
  const current = useLibraryStore((s) => s.current);
  const navigate = useNavigate();
  const [panelW, setPanelW] = useState(loadPanelWidth);
  const [collapsed, setCollapsed] = useState(false);
  const selectedArray = [...selectedIds];
  const hasSelection = selectedArray.length > 0;
  /** 选中集中仍未识图（含 -1 失败重试）的条数：已识图完成的不计（不重复扣费） */
  const itemById = new Map(items.map((i) => [i.id, i]));
  const pendingSelected = selectedArray.filter((id) => {
    const item = itemById.get(id);
    return item !== undefined && isVisionPending(item);
  }).length;

  /**
   * 批量识图（2026-08-22 用户改版：不在本面板拦截确认）：
   * 快照选中集转交识图面板确认（识别未完成项 / 识别全部 / 取消），
   * 并退出多选模式；确认前不入队，不产生费用。
   */
  const handleBatchVision = () => {
    if (selectedArray.length === 0) return;
    requestVisionBatch(selectedArray);
  };

  /**
   * 批量「送去画布」（任务 M3.6 R5.2）：选中项按展示顺序取原图 File → M1 待收队列
   * → 跳 /canvas；一次上限 50 张，超出截断并提示（先提示再送，不静默丢）。 
   */
  const handleBatchSendToCanvas = () => {
    if (!current || selectedArray.length === 0) return;
    const picked = selectedArray.slice(0, SEND_TO_CANVAS_LIMIT);
    if (selectedArray.length > SEND_TO_CANVAS_LIMIT) {
      toast(`一次最多送 50 张，已截断为前 ${SEND_TO_CANVAS_LIMIT} 张`);
    }
    const refs: SendOutRef[] = picked.map((id) => ({
      libraryId: current.libraryId,
      relPath: itemById.get(id)?.relPath ?? "",
    })).filter((r) => r.relPath !== "");
    void filesForItems(refs).then((files) =>
      queueItemsToCanvas(files, navigate),
    );
  };

  /* ---- 批量操作轻提示（2026-08-23 用户要求：给操作反馈） ----
     计数口径：加 tag/备注/标星作用于全部选中；删 tag 先数选中的存在数，
     不存在时如实提示，不谎报成功。 */

  const handleAddTag = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast("请输入要添加的标签");
      return;
    }
    addTag(selectedArray, trimmed);
    toast(`已为 ${selectedArray.length} 张图添加标签「${trimmed}」`);
  };

  const handleRemoveTag = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      toast("请输入要删除的标签");
      return;
    }
    const hit = selectedArray.filter(
      (id) => itemById.get(id)?.tags.some((t) => t.text === trimmed) ?? false,
    ).length;
    removeTag(selectedArray, trimmed);
    toast(
      hit > 0
        ? `已从 ${hit} 张图删除标签「${trimmed}」`
        : `选中图中没有标签「${trimmed}」`,
    );
  };

  const handleSetNote = (value: string) => {
    setNote(selectedArray, value);
    toast(
      value.trim()
        ? `已为 ${selectedArray.length} 张图写入备注`
        : `已清除 ${selectedArray.length} 张图的备注`,
    );
  };

  const handleStar = (starred: boolean) => {
    setStarred(selectedArray, starred);
    toast(`已为 ${selectedArray.length} 张图${starred ? "标星" : "取消标星"}`);
  };

  // 宽度变化落盘（每次变更整值写一次，量级极小）
  useEffect(() => {
    savePanelWidth(panelW);
  }, [panelW]);

  /* ---- dock 手柄交互（移植自 LabPage.tsx:66-108） ---- */

  const dragRef = useRef<{
    startX: number;
    startW: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [resizing, setResizing] = useState(false);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      dragRef.current = { startX: e.clientX, startW: panelW, moved: false };
      suppressClickRef.current = false;

      const onWinMove = (ev: PointerEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        if (Math.abs(dx) < 6) return;
        dragRef.current.moved = true;
        setResizing(true);
        const newW = window.innerWidth - 12 - ev.clientX;
        setPanelW(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(newW))));
      };

      const onWinUp = () => {
        window.removeEventListener("pointermove", onWinMove);
        suppressClickRef.current = dragRef.current?.moved ?? false;
        dragRef.current = null;
        setResizing(false);
      };

      window.addEventListener("pointermove", onWinMove);
      window.addEventListener("pointerup", onWinUp, { once: true });
    },
    [panelW],
  );

  const onHandleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setCollapsed((c) => !c);
  }, []);

  return (
    <>
      <div
        className={
          "lib-batchpanel" +
          (collapsed ? " is-collapsed" : "") +
          (leaving ? " is-leaving" : "")
        }
        style={{ width: panelW }}
        role="dialog"
        aria-label="批量管理面板"
      >
        <div className="lib-batchpanel__header">
          <span className="lib-batchpanel__title">批量管理</span>
          <span className="lib-batchpanel__count">
            已选 {selectedArray.length} 张
          </span>
        </div>
        <div className="lib-batchpanel__ops">
          <BatchInput
            placeholder="标签文本"
            label="加 tag"
            disabled={!hasSelection}
            onConfirm={handleAddTag}
          />
          <BatchInput
            placeholder="标签文本"
            label="删 tag"
            disabled={!hasSelection}
            onConfirm={handleRemoveTag}
          />
          <BatchInput
            placeholder="备注内容"
            label="备注"
            disabled={!hasSelection}
            onConfirm={handleSetNote}
          />
          <div className="lib-batchpanel__row">
            <button
              type="button"
              className="lib-toolbar__btn"
              disabled={!hasSelection}
              onClick={() => handleStar(true)}
            >
              标星
            </button>
            <button
              type="button"
              className="lib-toolbar__btn"
              disabled={!hasSelection}
              onClick={() => handleStar(false)}
            >
              取消标星
            </button>
          </div>
          {/* M3.5.3.2+ 批量识图：点击转交识图面板确认（识别未完成项/识别全部），
              确认前不入队；有选中即可点（2026-08-22 用户口径放宽） */}
          <div className="lib-batchpanel__row">
            <button
              type="button"
              className="lib-toolbar__btn"
              disabled={!hasSelection}
              title={
                !hasSelection
                  ? undefined
                  : "转交识图面板确认：识别未完成项（默认）或识别全部"
              }
              onClick={handleBatchVision}
            >
              批量识图{hasSelection ? `（${pendingSelected}）` : ""}
            </button>
          </div>
          {/* 批量送画布（任务 M3.6 R5.2）：上限 50 张/次，超出截断并提示 */}
          <div className="lib-batchpanel__row">
            <button
              type="button"
              className="lib-toolbar__btn"
              disabled={!hasSelection}
              title={
                hasSelection
                  ? `把选中图送到 M1 灵感画布（一次最多 ${SEND_TO_CANVAS_LIMIT} 张）`
                  : undefined
              }
              onClick={handleBatchSendToCanvas}
            >
              送去画布
            </button>
          </div>
          <div className="lib-batchpanel__row">
            <button
              type="button"
              className="lib-toolbar__btn"
              onClick={selectAll}
            >
              全选
            </button>
            <button
              type="button"
              className="lib-toolbar__btn"
              disabled={!hasSelection}
              onClick={clearSelection}
            >
              清除选择
            </button>
          </div>
          <button
            type="button"
            className="lib-toolbar__btn lib-toolbar__btn--primary"
            onClick={() => setSelectMode(false)}
          >
            完成
          </button>
        </div>
      </div>
      {/* dock 手柄层（移植自 LabPage.tsx:143-173；手柄不放面板内，收起滑出不带走） */}
      <div
        className={"lib-batchpanel__dock" + (leaving ? " is-leaving" : "")}
      >
        {collapsed ? (
          <button
            type="button"
            className="lib-batchpanel__handle"
            style={{ right: 12, opacity: 1, pointerEvents: "auto" }}
            title="展开批量面板"
            aria-label="展开批量面板"
            onClick={() => setCollapsed(false)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        ) : (
          <div
            className={`lib-batchpanel__zone${resizing ? " is-resizing" : ""}`}
            style={{ right: panelW + 12 }}
            onPointerDown={onHandlePointerDown}
          >
            <button
              type="button"
              className="lib-batchpanel__handle"
              title="收起批量面板（按住拖动调宽）"
              aria-label="收起批量面板"
              onClick={onHandleClick}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
          </div>
        )}
      </div>
    </>
  );
}
