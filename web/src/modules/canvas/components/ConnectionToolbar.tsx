/**
 * M1 连接线悬浮工具条（任务 1.9）：仿 TextToolbar 模式，定位在曲线中点上方，
 * 提供颜色 4 档（自动/灰/红/蓝）与箭头 3 档（单向/双向/无）。
 */
import { useCanvasStore, type ConnectorElement } from "../store";
import { bezierMidpoint, connectorPoints, type Box } from "../connectorGeometry";

/** 定位常数（屏幕 px） */
const TOOLBAR_HEIGHT = 34;
const TOOLBAR_EST_WIDTH = 200;

/**
 * 内容色预设（与 TextToolbar.tsx 的 HUE_PRESETS / GRAY_PRESETS 一致）：
 * 灰/红/蓝（用户内容可选色，不是界面 token）。
 */
const COLOR_PRESETS = [
  { label: "自动（主题色）", value: null as string | null, swatch: "auto" },
  { label: "灰色", value: "rgb(113, 113, 125)", swatch: "rgb(113, 113, 125)" },
  { label: "红色", value: "rgb(192, 68, 63)", swatch: "rgb(192, 68, 63)" },
  { label: "蓝色", value: "rgb(58, 123, 213)", swatch: "rgb(58, 123, 213)" },
];

const ARROW_OPTIONS: {
  value: ConnectorElement["props"]["arrow"];
  label: string;
}[] = [
  { value: "end", label: "单向箭头" },
  { value: "both", label: "双端圆点" },
  { value: "none", label: "无样式" },
];

/* ---- 小图标内联 SVG ---- */

/** 单向箭头（→） */
function ArrowEndIcon() {
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
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="14 5 21 12 14 19" />
    </svg>
  );
}

/** 双端圆点（○—○） */
function ArrowBothIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="5" y1="12" x2="19" y2="12" />
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
    </svg>
  );
}

/** 无线头（⸺） */
function ArrowNoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  );
}

const ARROW_ICONS: Record<ConnectorElement["props"]["arrow"], JSX.Element> = {
  end: <ArrowEndIcon />,
  both: <ArrowBothIcon />,
  none: <ArrowNoneIcon />,
};

interface ConnectionToolbarProps {
  connector: ConnectorElement;
  getBox: (id: string) => Box | null;
  containerSize: { width: number; height: number };
}

/**
 * 连接线悬浮工具条：position:absolute 在 .canvas-page 内，
 * class 复用 canvas-toolbar 体系；位置 = 曲线中点上方 8px。
 */
export function ConnectionToolbar({
  connector: c,
  getBox,
  containerSize,
}: ConnectionToolbarProps) {
  const viewport = useCanvasStore((s) => s.viewport);
  const updateConnectorProps = useCanvasStore((s) => s.updateConnectorProps);

  const fromBox = getBox(c.props.fromId);
  const toBox = getBox(c.props.toId);
  if (!fromBox || !toBox) return null;

  const pts = connectorPoints(fromBox, toBox);
  const mid = bezierMidpoint(pts);
  const screenX = mid.x * viewport.zoom + viewport.x;
  const screenY = mid.y * viewport.zoom + viewport.y;

  const left = Math.min(
    Math.max(8, screenX - TOOLBAR_EST_WIDTH / 2),
    Math.max(8, containerSize.width - TOOLBAR_EST_WIDTH - 8),
  );
  // 上方 8px 放不下则放下方
  const top =
    screenY - TOOLBAR_HEIGHT - 8 >= 0
      ? screenY - TOOLBAR_HEIGHT - 8
      : screenY + 8;

  return (
    <div
      className="canvas-toolbar"
      style={{ left, top }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault();
      }}
    >
      {/* 颜色档 */}
      {COLOR_PRESETS.map(({ label, value, swatch }) => {
        const active =
          c.props.color === value ||
          (value === null && c.props.color === null);
        return (
          <button
            key={label}
            type="button"
            className={`canvas-toolbar__btn${active ? " is-active" : ""}`}
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() =>
              updateConnectorProps(c.id, { color: value })
            }
          >
            {swatch === "auto" ? (
              <span
                className="canvas-toolbar__swatch-preview"
                style={{
                  background: "var(--accent)",
                }}
              />
            ) : (
              <span
                className="canvas-toolbar__swatch-preview"
                style={{ background: swatch }}
              />
            )}
          </button>
        );
      })}
      <span className="canvas-toolbar__divider" aria-hidden="true" />
      {/* 箭头档 */}
      {ARROW_OPTIONS.map(({ value, label }) => {
        const active = c.props.arrow === value;
        return (
          <button
            key={value}
            type="button"
            className={`canvas-toolbar__btn${active ? " is-active" : ""}`}
            title={label}
            aria-label={label}
            aria-pressed={active}
            onClick={() =>
              updateConnectorProps(c.id, { arrow: value })
            }
          >
            {ARROW_ICONS[value]}
          </button>
        );
      })}
    </div>
  );
}
