/**
 * 应用内确认对话框渲染器（ui/confirm.ts 的 React 壳）：挂应用壳（AppShell）。
 * 玻璃浮层惯例（design.md §7.10）：遮罩淡入 + 面板位移淡入，退场反向；
 * Esc = 取消，初始焦点在取消钮（安全默认，Enter 即取消）。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  settleConfirm,
  subscribeConfirm,
  type ConfirmState,
} from "./confirm";
import "./confirm.css";

export function ConfirmHost() {
  const [state, setState] = useState<ConfirmState | null>(null);
  useEffect(() => subscribeConfirm(setState), []);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 打开时焦点给取消钮 + 捕获阶段挂 Esc/Tab 拦截（模态语义）：
  // 底层（详情页 Esc 关覆盖层等 window 冒泡监听）不得响应；
  // Tab 在框内两钮间循环，不逃逸到背景
  useEffect(() => {
    if (!state || state.leaving) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        settleConfirm(false);
      } else if (e.key === "Tab") {
        const btns = panelRef.current?.querySelectorAll("button");
        if (!btns || btns.length === 0) return;
        const first = btns[0];
        const last = btns[btns.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [state]);

  if (!state) return null;
  // portal 到 body：详情覆盖层等 body 级浮层在 #root(isolation:isolate) 之外，
  // 不 portal 会困在 #root 层叠上下文内压不过它们（同 DetailView 惯例）
  return createPortal(
    <div
      className={"ystk-confirm" + (state.leaving ? " is-leaving" : "")}
      role="alertdialog"
      aria-modal="true"
      aria-label={state.title}
    >
      <div
        className="ystk-confirm__mask"
        onMouseDown={() => settleConfirm(false)}
      />
      <div className="ystk-confirm__panel" ref={panelRef}>
        <h3 className="ystk-confirm__title">{state.title}</h3>
        <p className="ystk-confirm__msg">{state.message}</p>
        <div className="ystk-confirm__btns">
          <button
            ref={cancelRef}
            type="button"
            className="ystk-confirm__btn"
            onClick={() => settleConfirm(false)}
          >
            {state.cancelText ?? "取消"}
          </button>
          <button
            type="button"
            className={
              "ystk-confirm__btn ystk-confirm__btn--primary" +
              (state.danger ? " is-danger" : "")
            }
            onClick={() => settleConfirm(true)}
          >
            {state.confirmText ?? "确定"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
