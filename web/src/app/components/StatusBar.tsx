import { useLocation } from "react-router-dom";
import { useCanvasStore } from "../../modules/canvas/api";
import { useLabStore } from "../../modules/lab/api";
import "./StatusBar.css";

/** 时间戳 → HH:MM:SS（本地时区；手动补零，不随系统区域设置变格式） */
function formatTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 光标读数显示值（图外/未开图统一显示"—"，开发文档-M4 §2.5） */
function formatPointer(pointer: {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
  h: number;
  s: number;
  l: number;
} | null) {
  if (!pointer) return { xy: "—, —", rgb: "—", hsl: "—" };
  return {
    xy: `${pointer.x}, ${pointer.y}`,
    rgb: `${pointer.r}, ${pointer.g}, ${pointer.b}`,
    hsl: `${Math.round(pointer.h)}°, ${Math.round(pointer.s)}%, ${Math.round(pointer.l)}%`,
  };
}

/**
 * 底部状态栏（§6.3）：提示 · 缩放 · 指针坐标 · 保存状态。
 * 缩放/指针接 M1 画布 store（仅画布路由下显示，世界坐标）；
 * 保存为上次自动保存成功时间（任务 1.5），本次会话尚未保存显示 —。
 * M4 实验室路由下（任务 M4.1）改显示：缩放 · 光标 x,y · RGB · HSL。
 * M3 图库路由下由 AppShell 整体不渲染（含 grid 行，2026-08-17 用户反馈）。
 */
export function StatusBar() {
  const { pathname } = useLocation();
  const onCanvas = pathname.startsWith("/canvas");
  const onLab = pathname.startsWith("/lab");
  const zoom = useCanvasStore((s) => s.viewport.zoom);
  const pointer = useCanvasStore((s) => s.pointer);
  const lastSavedAt = useCanvasStore((s) => s.lastSavedAt);
  const labZoom = useLabStore((s) => s.viewport.zoom);
  const labPointer = useLabStore((s) => s.pointer);
  const labReadout = formatPointer(labPointer);

  return (
    <footer className="statusbar">
      <span className="statusbar__hint">就绪</span>
      {onLab ? (
        <div className="statusbar__group">
          <span>
            缩放
            <span className="statusbar__value">{`${Math.round(labZoom * 100)}%`}</span>
          </span>
          <span>
            光标
            <span className="statusbar__value">{labReadout.xy}</span>
          </span>
          <span>
            RGB
            <span className="statusbar__value">{labReadout.rgb}</span>
          </span>
          <span>
            HSL
            <span className="statusbar__value">{labReadout.hsl}</span>
          </span>
        </div>
      ) : (
        <div className="statusbar__group">
          <span>
            缩放
            <span className="statusbar__value">
              {onCanvas ? `${Math.round(zoom * 100)}%` : "—"}
            </span>
          </span>
          <span>
            指针
            <span className="statusbar__value">
              {onCanvas && pointer
                ? `${Math.round(pointer.x)}, ${Math.round(pointer.y)}`
                : "—, —"}
            </span>
          </span>
          <span>
            保存
            <span className="statusbar__value">
              {lastSavedAt ? formatTime(lastSavedAt) : "—"}
            </span>
          </span>
        </div>
      )}
    </footer>
  );
}
