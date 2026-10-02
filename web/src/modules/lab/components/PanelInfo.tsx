/**
 * ⓘ 说明按钮（任务 M4.2.1 / M4.4.1）：名称行右侧，点击 toggle 说明浮层。
 * 浮层经 createPortal 渲染到 document.body（fixed 定位跟随按钮），脱离 .lab-output
 * 的 backdrop root，使 backdrop-filter 采样整个场景——磨砂与分析面板糊画布观感一致。
 * 内容由调用方 lines 数组逐行渲染；点浮层外或 Esc 关闭；面板滚动/窗口 resize 实时跟随。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface PanelInfoButtonProps {
  lines: string[];
}

export function PanelInfoButton({ lines }: PanelInfoButtonProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number; maxHeight: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // 计算浮层定位：按钮底部 + 6px，右对齐按钮右缘；
  // maxHeight 限制在按钮下方可用视口内（底部抽屉等近底按钮不至于溢出屏幕），超出则内部滚动
  const calcPos = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const top = Math.round(rect.bottom + 6);
    setPos({
      top,
      right: Math.round(window.innerWidth - rect.right),
      maxHeight: Math.max(120, Math.round(window.innerHeight - top - 12)),
    });
  }, []);

  // 打开/关闭时重算位置；挂 scroll（capture）与 resize 跟随
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    calcPos();
    document.addEventListener("scroll", calcPos, true);  // capture: scroll 不冒泡
    window.addEventListener("resize", calcPos);
    return () => {
      document.removeEventListener("scroll", calcPos, true);
      window.removeEventListener("resize", calcPos);
    };
  }, [open, calcPos]);

  // 点外关闭（按钮与浮层任一命中即忽略）+ Esc
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="lab-info">
      <button
        ref={btnRef}
        type="button"
        className="lab-info__btn"
        title="说明"
        aria-label="说明"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
      </button>
      {open && pos &&
        createPortal(
          <div ref={popRef} className="lab-info__popover" style={{ top: pos.top, right: pos.right, maxHeight: pos.maxHeight }}>
            {lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
