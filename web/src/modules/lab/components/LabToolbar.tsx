import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ChangeEvent as ReactChangeEvent } from "react";
import { useLocation } from "react-router-dom";
import { useLabStore, OVERLAY_SOURCE_TOOL } from "../store";
import type { LabTool } from "../store";
import { openImageFile } from "../imageSource";
import "./LabToolbar.css";

/* ---- 工具图标：stroke 风格内联 SVG，与 M1 SideToolbar 同款（不引图标库） ---- */

function HistogramIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 20v-8" />
      <path d="M12 20V4" />
      <path d="M18 20v-6" />
    </svg>
  );
}

function DotGainIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SaturationIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3c3.6 4.8 6 7.6 6 10.4a6 6 0 0 1-12 0C6 10.6 8.4 7.8 12 3z" />
    </svg>
  );
}

function FalseColorIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 16.5c2.5-2.2 4.5-2.2 7 0s4.5 2.2 7 0c.8-.7 1.5-1 2-1.1" />
      <path d="M7 11c1.6-1.4 3.4-1.4 5 0s3.4 1.4 5 0" />
      <path d="M12 5.5v.01" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="7" height="7" rx="1" />
      <rect x="13" y="4" width="7" height="7" rx="1" />
      <rect x="4" y="13" width="7" height="7" rx="1" />
      <rect x="13" y="13" width="7" height="7" rx="1" />
    </svg>
  );
}

function HarmonyIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 4v2.5" />
      <path d="M12 17.5V20" />
      <path d="M4 12h2.5" />
      <path d="M17.5 12H20" />
    </svg>
  );
}

function StrokeIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 19.5 10 8l5.5 7L20 5" />
      <circle cx="4.5" cy="19.5" r="1.6" />
      <circle cx="20" cy="5" r="1.6" />
    </svg>
  );
}

function CompareIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 外部导入（箭头向上出托盘，M1 DownloadIcon 的镜像） */
function ImportIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

/* 饱和度检查图标：水滴右半填充（PS 50% 灰明度基准） */
function SatCheckIcon() {
  const clipId = "sat-check-clip";
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <defs><clipPath id={clipId}><rect x="12" y="0" width="12" height="24" /></clipPath></defs>
      <path d="M12 3c3.6 4.8 6 7.6 6 10.4a6 6 0 0 1-12 0C6 10.6 8.4 7.8 12 3z" />
      <path d="M12 3c3.6 4.8 6 7.6 6 10.4a6 6 0 0 1-12 0C6 10.6 8.4 7.8 12 3z" fill="currentColor" stroke="none" clipPath={`url(#${clipId})`} />
    </svg>
  );
}

/* 饱和热力图标：简化火焰（外焰 + 内焰） */
function SatHeatIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21c3.6 0 6.5-2.9 6.5-6.5 0-3.4-2.5-6.2-6.5-11.5-4 5.3-6.5 8.1-6.5 11.5C5.5 18.1 8.4 21 12 21z" />
      <path d="M12 21c2 0 3.5-1.6 3.5-3.6 0-2.2-1.8-4.1-3.5-7.4-1.7 3.3-3.5 5.2-3.5 7.4C8.5 19.4 10 21 12 21z" />
    </svg>
  );
}

/** flyout 角标（饱和度 ▸，全左栏唯一） */
function FlyoutMark() {
  return (
    <svg
      className="lab-toolbar__flyout-mark"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

/* ---- 工具集（开发文档-M4 §2.2）：分隔线分组始终可见；compare 置灰占位 ---- */

interface LabToolDef {
  id: LabTool;
  name: string;
  desc: string;
  icon: ReactNode;
  ready: boolean;
  /** 招牌工具：accent 描边高亮 */
  star?: boolean;
  /** flyout 角标（子菜单 M4.5 接入，骨架期点击即选中） */
  flyout?: boolean;
}

const TOOLS: (LabToolDef | "divider")[] = [
  {
    id: "histogram",
    name: "直方图",
    desc: "RGB/明度分布，面板内含色阶与饱和度分布",
    icon: <HistogramIcon />,
    ready: true,
  },
  {
    id: "dotgain",
    name: "Dot Gain 20%",
    desc: "灰度校样视图（中间调压暗），可覆盖画面",
    icon: <DotGainIcon />,
    ready: true,
  },
  {
    id: "saturation",
    name: "饱和度",
    desc: "饱和度检查 / 饱和热力，可覆盖画面",
    icon: <SaturationIcon />,
    ready: true,
    flyout: true,
  },
  {
    id: "falsecolor",
    name: "假彩色",
    desc: "明度映射色带，曝光结构一眼可读，可覆盖画面",
    icon: <FalseColorIcon />,
    ready: true,
  },
  "divider",
  {
    id: "palette",
    name: "主色板",
    desc: "提取 5–8 主色，含占比与一键复制",
    icon: <PaletteIcon />,
    ready: true,
  },
  {
    id: "harmony",
    name: "色彩和谐",
    desc: "色轮落点与和谐结构判定",
    icon: <HarmonyIcon />,
    ready: true,
  },
  {
    id: "stroke",
    name: "划线取色",
    desc: "沿路径看颜色流动（招牌）",
    icon: <StrokeIcon />,
    ready: true,
    star: true,
  },
  "divider",
  {
    id: "compare",
    name: "对比模式",
    desc: "双图对比（P1，待建）",
    icon: <CompareIcon />,
    ready: false,
  },
];

/**
 * 壳级悬浮岛（M1 同款）：仅 /lab 路由滑入，切走向左收回；两岛接力时序由 AppShell 控制。
 * 按钮样式与 M1 SideToolbar 一致（纯图标、分隔线分组、hover/active 同款、title 出名称+说明）。
 * 底部动作区：外部导入（打开本地图片；/lab 下 Ctrl+V 粘贴剪贴板图片，见 LabPage）。
 */
export function LabToolbar({ toolbarOpen = true }: { toolbarOpen?: boolean }) {
  const { pathname } = useLocation();
  const onLab = pathname.startsWith("/lab");
  const tool = useLabStore((s) => s.tool);
  const overlay = useLabStore((s) => s.overlay);
  const satMode = useLabStore((s) => s.satMode);
  const setTool = useLabStore((s) => s.setTool);
  const setSatMode = useLabStore((s) => s.setSatMode);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 饱和度 flyout
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const flyoutAnchorRef = useRef<HTMLDivElement>(null);

  // 关闭 flyout 的外部点击
  const closeFlyout = useCallback(() => setFlyoutOpen(false), []);
  useEffect(() => {
    if (!flyoutOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (flyoutAnchorRef.current && !flyoutAnchorRef.current.contains(e.target as Node)) {
        closeFlyout();
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFlyout();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [flyoutOpen, closeFlyout]);

  // 岛收回 / 切路由时关 flyout
  useEffect(() => {
    if (!onLab || !toolbarOpen) setFlyoutOpen(false);
  }, [onLab, toolbarOpen]);

  // 外部导入：文件选择器打开本地图片（与空状态引导卡同一入口；清空 value 允许重复选同一文件）
  const handleImportPick = (e: ReactChangeEvent<HTMLInputElement>) => {
    const file = [...(e.target.files ?? [])].find((f) =>
      f.type.startsWith("image/"),
    );
    e.target.value = "";
    if (file) void openImageFile(file);
  };

  return (
    <aside className={`lab-toolbar${onLab && toolbarOpen ? " is-visible" : ""}`} aria-label="分析工具" aria-hidden={!onLab}>
      {TOOLS.map((t, i) =>
        t === "divider" ? (
          <span key={`divider-${i}`} className="lab-toolbar__divider" aria-hidden="true" />
        ) : t.flyout ? (
          <div key={t.id} className="lab-toolbar__flyout-anchor" ref={flyoutAnchorRef}>
            <button
              type="button"
              disabled={!t.ready}
              tabIndex={onLab ? 0 : -1}
              className={[
                "lab-toolbar__btn",
                tool === t.id ? "is-active" : "",
                t.star ? "is-star" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              title={`${t.name} · ${t.desc}`}
              aria-label={t.name}
              aria-pressed={tool === t.id}
              onClick={() => {
                if (!t.ready) return;
                if (tool !== "saturation") { setTool("saturation"); setFlyoutOpen(true); }
                else setFlyoutOpen(v => !v);
              }}
            >
              {t.icon}
              {overlay !== null && OVERLAY_SOURCE_TOOL[overlay] === t.id && <span className="lab-toolbar__overlay-mark" aria-hidden="true" />}
              <FlyoutMark />
            </button>
            {flyoutOpen && (
              <div className="lab-toolbar__flyout">
                <button
                  type="button"
                  className={`lab-toolbar__btn${satMode === "check" ? " is-active" : ""}`}
                  title="饱和度检查 · PS 50% 灰明度模式基准，可覆盖画面"
                  aria-label="饱和度检查"
                  onClick={() => { setSatMode("check"); setTool("saturation"); closeFlyout(); }}
                >
                  <SatCheckIcon />
                </button>
                <button
                  type="button"
                  className={`lab-toolbar__btn${satMode === "heat" ? " is-active" : ""}`}
                  title="饱和热力 · S 映射灰→橙→红叠层，可覆盖画面"
                  aria-label="饱和热力"
                  onClick={() => { setSatMode("heat"); setTool("saturation"); closeFlyout(); }}
                >
                  <SatHeatIcon />
                </button>
              </div>
            )}
          </div>
        ) : (
          <button
            key={t.id}
            type="button"
            disabled={!t.ready}
            tabIndex={onLab ? 0 : -1}
            className={[
              "lab-toolbar__btn",
              tool === t.id ? "is-active" : "",
              t.star ? "is-star" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            title={`${t.name} · ${t.desc}`}
            aria-label={t.name}
            aria-pressed={tool === t.id}
            onClick={() => {
              if (t.ready) setTool(t.id);
            }}
          >
            {t.icon}
            {overlay !== null && OVERLAY_SOURCE_TOOL[overlay] === t.id && <span className="lab-toolbar__overlay-mark" aria-hidden="true" />}
            {t.flyout && <FlyoutMark />}
          </button>
        ),
      )}
      <span className="lab-toolbar__divider" aria-hidden="true" />
      <button
        type="button"
        tabIndex={onLab ? 0 : -1}
        className="lab-toolbar__btn"
        title="外部导入 · 打开本地图片（支持 Ctrl+V 粘贴剪贴板图片）"
        aria-label="外部导入"
        onClick={() => fileInputRef.current?.click()}
      >
        <ImportIcon />
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        tabIndex={-1}
        aria-hidden="true"
        style={{ display: "none" }}
        onChange={handleImportPick}
      />
    </aside>
  );
}
