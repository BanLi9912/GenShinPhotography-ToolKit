import { useEffect, useRef } from "react";
import { useCanvasStore } from "../store";
import "./HistoryPanel.css";

/** 时间戳 → HH:MM:SS（本地时区，与状态栏保存时间同格式） */
function formatTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

interface HistoryPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 操作历史面板（灵动岛式悬浮小窗，随侧边工具栏"历史"按钮弹出）：
 * 列出撤销栈里可回到的状态（最旧在上）——首行是栈底"初始状态"（点击撤销全部），
 * 其后每行为"该操作完成后的状态"（标签/时间取产生该状态的那一步）；
 * "当前状态"为分界高亮，其下灰显的是可重做操作。
 * 点击条目一步跳转到该状态（见 store.jumpHistory）。
 */
export function HistoryPanel({ open, onClose }: HistoryPanelProps) {
  const past = useCanvasStore((s) => s.past);
  const future = useCanvasStore((s) => s.future);
  const jumpHistory = useCanvasStore((s) => s.jumpHistory);
  const currentRef = useRef<HTMLDivElement>(null);

  // 打开时滚动到"当前状态"（长历史时直接定位最新操作）
  useEffect(() => {
    if (open) currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  const tabIndex = open ? 0 : -1;
  const empty = past.length === 0 && future.length === 0;

  return (
    <div
      className={`history-panel${open ? " is-open" : ""}`}
      aria-hidden={!open}
      aria-label="操作历史"
    >
      <div className="history-panel__header">
        <span>操作历史</span>
        <button
          type="button"
          className="history-panel__close"
          onClick={onClose}
          tabIndex={tabIndex}
          aria-label="关闭"
        >
          ×
        </button>
      </div>
      <div className="history-panel__list">
        {empty ? (
          <div className="history-panel__empty">暂无操作记录</div>
        ) : (
          <>
            {past.map((entry, i) => {
              // 第 i 行 = 撤销栈里第 i 个可回到的状态：i = 0 是栈底（初始状态），
              // i ≥ 1 是第 i 步操作完成后的状态（标签/时间取产生它的 past[i-1]）。
              // 栈顶那条（= 当前状态本身）不单独成行，由"当前状态"分界代表。
              const step = i === 0 ? null : past[i - 1];
              return (
                <button
                  key={`${entry.at}-${i}`}
                  type="button"
                  className="history-panel__item"
                  tabIndex={tabIndex}
                  title={
                    step
                      ? `跳转到「${step.label}」之后`
                      : `回到初始状态（撤销全部 ${past.length} 步）`
                  }
                  onClick={() => jumpHistory(i - past.length)}
                >
                  <span>{step ? step.label : "初始状态"}</span>
                  <span className="history-panel__time">
                    {step ? formatTime(step.at) : ""}
                  </span>
                </button>
              );
            })}
            <div ref={currentRef} className="history-panel__current">
              当前状态
            </div>
            {[...future].reverse().map((entry, j) => (
              <button
                key={`${entry.at}-${j}`}
                type="button"
                className="history-panel__item history-panel__item--future"
                tabIndex={tabIndex}
                title={`重做「${entry.label}」`}
                onClick={() => jumpHistory(j + 1)}
              >
                <span>{entry.label}</span>
                <span className="history-panel__time">
                  {formatTime(entry.at)}
                </span>
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
