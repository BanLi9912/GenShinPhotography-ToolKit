import { useCallback, useEffect, useRef, useState } from "react";
import { openImageFile } from "../imageSource";
import { useLabStore } from "../store";
import { LabPanel } from "./LabPanel";
import { LabViewport } from "./LabViewport";
import { StrokeDrawer } from "./StrokeDrawer";
import "./LabPage.css";

/** 目标为可编辑控件时不拦截粘贴（输入框内正常粘贴） */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
}

/**
 * M4 图像分析实验室页面（开发文档-M4 §2.1 版面骨架）：
 * 视口全宽 · 输出区为悬浮于视口之上的圆角浮层面板（可调宽/收起）；
 * 左侧工具栏为壳级悬浮岛，见 AppShell；顶栏/状态栏在应用壳。
 * 文件选择入口在空状态引导卡与左岛外部导入按钮；/lab 下支持 Ctrl+V 粘贴。
 */
export function LabPage() {
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const panel = useLabStore((s) => s.panel);
  const setPanelWidth = useLabStore((s) => s.setPanelWidth);
  const setPanelCollapsed = useLabStore((s) => s.setPanelCollapsed);
  const tool = useLabStore((s) => s.tool);
  const strokes = useLabStore((s) => s.strokes);
  const activeStrokeId = useLabStore((s) => s.activeStrokeId);
  const activeStroke = strokes.find(l => l.id === activeStrokeId);
  const drawerVisible = tool === "stroke" && !!(activeStroke?.visible && activeStroke.samples.length > 1);

  // 阻止浏览器默认拖放行为
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Ctrl+V 粘贴剪贴板图片
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const file = [...(e.clipboardData?.items ?? [])]
        .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
        .map((it) => it.getAsFile())
        .find((f): f is File => f !== null);
      if (!file) return;
      e.preventDefault();
      void openImageFile(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  /* ---- 面板手柄交互 ---- */

  const dragRef = useRef<{ startX: number; startW: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const [resizing, setResizing] = useState(false);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.stopPropagation();
      dragRef.current = { startX: e.clientX, startW: panel.width, moved: false };
      suppressClickRef.current = false;

      const onWinMove = (ev: PointerEvent) => {
        if (!dragRef.current || !containerRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        if (Math.abs(dx) < 6) return;
        dragRef.current.moved = true;
        setResizing(true);
        const rect = containerRef.current.getBoundingClientRect();
        const newW = rect.right - 12 - ev.clientX;
        setPanelWidth(Math.max(280, Math.min(720, Math.round(newW))));
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
    [panel.width, setPanelWidth],
  );

  const onHandleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setPanelCollapsed(!panel.collapsed);
  }, [panel.collapsed, setPanelCollapsed]);

  const isCollapsed = panel.collapsed;

  return (
    <div
      ref={containerRef}
      className={`lab-page${drawerVisible ? " has-stroke-drawer" : ""}`}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current += 1;
        setDragOver(true);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragOver(false);
        const file = [...e.dataTransfer.files].find((f) =>
          f.type.startsWith("image/"),
        );
        if (file) void openImageFile(file);
      }}
    >
      <LabViewport panelRight={isCollapsed ? 12 : panel.width + 24} panelResizing={resizing} />
      <LabPanel />
      <StrokeDrawer visible={drawerVisible} />
      {/* 面板 dock 层（手柄不放 .lab-output 内，收起滑出不带走） */}
      <div className="lab-dock">
        {isCollapsed ? (
          <button
            type="button"
            className="lab-dock__handle"
            style={{ right: 12, opacity: 1, pointerEvents: "auto" }}
            title="展开分析面板"
            aria-label="展开分析面板"
            onClick={() => setPanelCollapsed(false)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
          </button>
        ) : (
          <div
            className={`lab-dock__zone${resizing ? " is-resizing" : ""}`}
            style={{ right: panel.width + 12 }}
            onPointerDown={onHandlePointerDown}
          >
            <button
              type="button"
              className="lab-dock__handle"
              title="收起面板（按住拖动调宽）"
              aria-label="收起面板"
              onClick={onHandleClick}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          </div>
        )}
      </div>
      {dragOver && (
        <div className="lab-page__drop" aria-hidden="true">
          <span className="lab-page__drop-text">松开以打开图片</span>
        </div>
      )}
    </div>
  );
}
