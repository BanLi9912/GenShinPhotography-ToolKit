/**
 * 轻提示渲染器（ui/toast.ts 的 React 壳）：挂应用壳（AppShell），
 * fixed 定位不参与布局；空列表不渲染。
 * portal 到 body：同 confirm.tsx，避免困在 #root(isolation:isolate) 层叠上下文。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getToastItems, subscribeToast, type ToastItem } from "./toast";
import "./toast.css";

export function Toaster() {
  const [list, setList] = useState<ToastItem[]>(getToastItems);
  useEffect(() => subscribeToast(setList), []);
  if (list.length === 0) return null;
  return createPortal(
    <div className="ystk-toast" role="status" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={"ystk-toast__item" + (t.leaving ? " is-leaving" : "")}
        >
          {t.text}
          {t.action && (
            <button type="button" className="ystk-toast__action" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
