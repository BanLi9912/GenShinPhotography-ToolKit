import { useEffect, useReducer, useRef, useState } from "react";
import {
  FONT_SIZE_PRESETS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  useCanvasStore,
  type TextElement,
  type TextProps,
} from "../store";
import { applyStyleToRuns, queryRunsStyle, runsToText } from "./richText";
import { textEditorBridge } from "./editorBridge";
import { normalizeColor } from "./colorUtils";
import { ColorPicker } from "./ColorPicker";
import { TEXT_LINE_HEIGHT } from "./TextNode";
import { useCssToken } from "./useCssToken";

/** 工具条定位参数（px，屏幕坐标） */
const TOOLBAR_HEIGHT = 34;
const TOOLBAR_EST_WIDTH = 260;
const TOOLBAR_GAP = 8;

/**
 * 预设内容色：红橙黄绿蓝靛紫 + 白到黑灰阶。
 * 注意：这是用户内容的可选颜色，不是界面 token，故为固定值。
 */
const HUE_PRESETS = [
  "rgb(192, 68, 63)", // 红
  "rgb(217, 126, 54)", // 橙
  "rgb(212, 160, 23)", // 黄
  "rgb(78, 154, 81)", // 绿
  "rgb(58, 123, 213)", // 蓝
  "rgb(91, 91, 214)", // 靛
  "rgb(142, 68, 173)", // 紫
];
const GRAY_PRESETS = [
  "rgb(255, 255, 255)",
  "rgb(219, 219, 224)",
  "rgb(166, 166, 178)",
  "rgb(113, 113, 125)",
  "rgb(63, 63, 71)",
  "rgb(20, 20, 23)",
];

/* ---- 对齐图标：stroke 风格内联 SVG（同 SideToolbar 约定，不引图标库） ---- */

function AlignIcon({ align }: { align: TextProps["align"] }) {
  const segments: [number, number][] =
    align === "left"
      ? [
          [2, 14],
          [2, 10],
          [2, 12],
        ]
      : align === "center"
        ? [
            [3, 13],
            [5, 11],
            [4, 12],
          ]
        : [
            [2, 14],
            [6, 14],
            [4, 14],
          ];
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      {segments.map(([x1, x2], i) => (
        <line key={`${x1}-${x2}`} x1={x1} y1={4 + i * 4} x2={x2} y2={4 + i * 4} />
      ))}
    </svg>
  );
}

const ALIGN_OPTIONS: { value: TextProps["align"]; label: string }[] = [
  { value: "left", label: "左对齐" },
  { value: "center", label: "居中对齐" },
  { value: "right", label: "右对齐" },
];

function ColorSwatch({
  color,
  active,
  onPick,
}: {
  color: string;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`canvas-toolbar__swatch${active ? " is-active" : ""}`}
      style={{ background: color }}
      title={color}
      aria-label={color}
      onClick={onPick}
    />
  );
}

interface TextToolbarProps {
  element: TextElement;
  containerSize: { width: number; height: number };
}

/**
 * 文本悬浮工具条（任务 1.2）：字号（输入框键盘输入 + 预设弹层）/ 粗体 / 字体颜色（预设色板 + 自定义滑块取色）/ 对齐。
 * 作用域规则：编辑中有选区 → 仅选中部分；否则 → 整段文本（并同步块级缺省）。
 * 编辑中的作用域样式（粗体态/统一字号/统一色）以编辑器实时内容为准，
 * 打字与输入态样式未提交前 store 是旧的。
 * 编辑中点击工具条不退出编辑（根节点 mousedown 拦截 + 编辑器 blur 白名单；
 * 字号输入框例外，需获焦打字，其选区在 mousedown 时捕获、应用时按显式区间作用）。
 * 定位在选中文本块上方，上方放不下则移到下方；水平方向钳在画布区内。
 */
export function TextToolbar({ element: el, containerSize }: TextToolbarProps) {
  const viewport = useCanvasStore((s) => s.viewport);
  const editingId = useCanvasStore((s) => s.editingId);
  const updateTextProps = useCanvasStore((s) => s.updateTextProps);
  const themeColor = useCssToken("--text-1", "#1c1c20");

  const [colorOpen, setColorOpen] = useState(false);
  const [sizeOpen, setSizeOpen] = useState(false);
  /** 字号输入框草稿：null = 未在输入（显示作用域统一字号） */
  const [sizeDraft, setSizeDraft] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const sizeWrapRef = useRef<HTMLDivElement>(null);
  // 字号输入框获焦会夺走编辑器选区：mousedown 先捕获，应用时按显式区间作用
  const savedRangeRef = useRef<{ start: number; end: number } | null>(null);
  // 编辑中选区变化时刷新激活态（选区变化不触发 store 更新）
  const [, forceRefresh] = useReducer((x: number) => x + 1, 0);

  const editing = editingId === el.id;
  // 编辑中以编辑器实时内容为准；非编辑态用 store
  const live = editing ? textEditorBridge.current?.getContent() : null;
  const baseRuns = live ? live.runs : el.props.runs;
  const fullText = live ? live.text : runsToText(el.props.runs);

  // 作用域：编辑中有非折叠选区 → 选区；否则整段
  const selection = editing
    ? textEditorBridge.current?.getSelectionOffsets()
    : null;
  const hasSelection =
    selection !== null &&
    selection !== undefined &&
    selection.start !== selection.end;
  const scope = hasSelection
    ? selection
    : { start: 0, end: fullText.length };
  const scopeStyle = queryRunsStyle(
    baseRuns,
    scope.start,
    scope.end,
    el.props.fontSize,
  );

  // 编辑中监听选区变化（光标移动/框选时刷新按钮激活态）
  useEffect(() => {
    if (!editing) return;
    document.addEventListener("selectionchange", forceRefresh);
    return () => document.removeEventListener("selectionchange", forceRefresh);
  }, [editing]);

  // 色彩弹出层：点外部关闭
  useEffect(() => {
    if (!colorOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        colorButtonRef.current?.contains(target)
      )
        return;
      setColorOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [colorOpen]);

  // 字号预设弹层：点外部关闭
  useEffect(() => {
    if (!sizeOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (sizeWrapRef.current?.contains(e.target as Node)) return;
      setSizeOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, [sizeOpen]);

  /** 点击瞬间编辑器的非折叠选区（null = 整段作用域） */
  const currentSelection = () => {
    const sel = textEditorBridge.current?.getSelectionOffsets();
    return sel && sel.start !== sel.end ? sel : null;
  };

  // 字号：钳制后按作用域应用；编辑中有选区（含输入框捕获的显式区间）
  // → 仅选中部分；否则整段并同步块级缺省。
  // 作用域必须在应用前锁定：applyStyle 整段路径会全选文本，事后再读选区会误判
  const applyFontSize = (value: number) => {
    setSizeDraft(null);
    if (!Number.isFinite(value) || value <= 0) return;
    const size = Math.min(
      MAX_FONT_SIZE,
      Math.max(MIN_FONT_SIZE, Math.round(value)),
    );
    if (editing) {
      const range = savedRangeRef.current ?? currentSelection() ?? undefined;
      textEditorBridge.current?.applyStyle({ fontSize: size }, range, {
        label: "调整字号",
      });
      if (!range)
        updateTextProps(el.id, { fontSize: size }, { label: "调整字号" }); // 整段作用域才同步块级缺省
    } else {
      updateTextProps(
        el.id,
        {
          fontSize: size,
          runs: applyStyleToRuns(el.props.runs, 0, fullText.length, {
            fontSize: size,
          }),
        },
        { label: "调整字号" },
      );
    }
    savedRangeRef.current = null;
  };

  const handleBold = () => {
    const next = !scopeStyle.allBold;
    if (editing) {
      textEditorBridge.current?.applyStyle({ bold: next }, undefined, {
        label: "切换粗体",
      });
      return;
    }
    updateTextProps(
      el.id,
      {
        runs: applyStyleToRuns(el.props.runs, 0, fullText.length, {
          bold: next,
        }),
      },
      { label: "切换粗体" },
    );
  };

  const handleColor = (color: string | null) => {
    const normalized = color === null ? null : normalizeColor(color);
    // 取色拖动逐帧回调：按元素合并为一个撤销步
    const history = { label: "文本颜色", coalesce: `color:${el.id}` };
    if (editing) {
      // 作用域在应用前锁定（同 applyFontSize）
      const selectionScoped = currentSelection() !== null;
      textEditorBridge.current?.applyStyle(
        { color: normalized },
        undefined,
        history,
      );
      if (!selectionScoped)
        updateTextProps(el.id, { color: normalized }, history); // 整段作用域才同步块级缺省
      return;
    }
    updateTextProps(
      el.id,
      {
        color: normalized,
        runs: applyStyleToRuns(el.props.runs, 0, fullText.length, {
          color: normalized,
        }),
      },
      history,
    );
  };

  const previewColor =
    scopeStyle.color ?? el.props.color ?? themeColor;

  // 字号输入框显示值：作用域统一字号；混合时留空显占位
  const uniformSize = scopeStyle.fontSize;

  // 世界坐标 → 屏幕坐标；块高按行数 × 最大字号估算（仅供"放下方"定位）
  const maxRunSize = el.props.runs.reduce(
    (max, r) => Math.max(max, r.fontSize ?? el.props.fontSize),
    el.props.fontSize,
  );
  const screenX = el.transform.x * viewport.zoom + viewport.x;
  const screenY = el.transform.y * viewport.zoom + viewport.y;
  const blockHeight =
    fullText.split("\n").length * maxRunSize * TEXT_LINE_HEIGHT * viewport.zoom;
  const left = Math.min(
    Math.max(8, screenX),
    Math.max(8, containerSize.width - TOOLBAR_EST_WIDTH - 8),
  );
  const top =
    screenY - TOOLBAR_HEIGHT - TOOLBAR_GAP >= 0
      ? screenY - TOOLBAR_HEIGHT - TOOLBAR_GAP
      : screenY + blockHeight + TOOLBAR_GAP;

  // 字号预设弹层贴近画布底边时向上翻出（向下会被画布 overflow 裁掉）
  const sizePopoverUp =
    top + TOOLBAR_HEIGHT + 6 + 210 > containerSize.height;

  return (
    <div
      className="canvas-toolbar"
      style={{ left, top }}
      onMouseDown={(e) => {
        // 编辑中保持编辑器焦点与选区；input 例外（字号输入框需获焦打字）
        if ((e.target as HTMLElement).tagName !== "INPUT") e.preventDefault();
      }}
    >
      <div ref={sizeWrapRef} className="canvas-toolbar__size-wrap">
        <input
          className="canvas-toolbar__size-input"
          value={sizeDraft ?? (uniformSize !== null ? String(uniformSize) : "")}
          placeholder="—"
          title="字号（键盘输入，回车应用；编辑中选中部分文字可只改选中部分）"
          aria-label="字号"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          onMouseDown={() => {
            // 输入框获焦会夺走编辑器选区，先捕获供应用时按显式区间作用
            savedRangeRef.current = editing ? currentSelection() : null;
          }}
          onFocus={(e) => e.target.select()} // 获焦全选，输入即替换当前值
          onChange={(e) => setSizeDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyFontSize(Number(sizeDraft));
            } else if (e.key === "Escape") {
              e.preventDefault();
              const range = savedRangeRef.current;
              savedRangeRef.current = null;
              setSizeDraft(null);
              if (editing) textEditorBridge.current?.focusEditor(range);
              else (e.target as HTMLElement).blur();
            }
          }}
          onBlur={() => {
            savedRangeRef.current = null;
            setSizeDraft(null);
          }}
        />
        <button
          type="button"
          className="canvas-toolbar__btn"
          title="预设字号"
          aria-label="预设字号"
          aria-expanded={sizeOpen}
          onClick={() => setSizeOpen((open) => !open)}
        >
          ▾
        </button>
        {sizeOpen && (
          <div
            className={`canvas-toolbar__popover canvas-toolbar__size-popover${
              sizePopoverUp ? " canvas-toolbar__popover--up" : ""
            }`}
          >
            {FONT_SIZE_PRESETS.map((size) => (
              <button
                key={size}
                type="button"
                className={`canvas-toolbar__size-option${
                  uniformSize === size ? " is-active" : ""
                }`}
                onClick={() => {
                  applyFontSize(size);
                  setSizeOpen(false);
                }}
              >
                {size}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="canvas-toolbar__divider" aria-hidden="true" />
      <button
        type="button"
        className={`canvas-toolbar__btn${scopeStyle.allBold ? " is-active" : ""}`}
        title="粗体（编辑中选中部分文字可只加粗选中部分，Ctrl+B）"
        aria-label="粗体"
        aria-pressed={scopeStyle.allBold}
        onClick={handleBold}
      >
        <strong>B</strong>
      </button>
      <div className="canvas-toolbar__color-wrap">
        <button
          ref={colorButtonRef}
          type="button"
          className="canvas-toolbar__btn"
          title="字体颜色（预设 + 自定义）"
          aria-label="字体颜色"
          aria-expanded={colorOpen}
          onClick={() => setColorOpen((open) => !open)}
        >
          <span
            className="canvas-toolbar__swatch-preview"
            style={{ background: previewColor }}
          />
        </button>
        {colorOpen && (
          <div ref={popoverRef} className="canvas-toolbar__popover">
            <div className="canvas-toolbar__swatches">
              {HUE_PRESETS.map((color) => (
                <ColorSwatch
                  key={color}
                  color={color}
                  active={scopeStyle.color === color}
                  onPick={() => handleColor(color)}
                />
              ))}
            </div>
            <div className="canvas-toolbar__swatches">
              {GRAY_PRESETS.map((color) => (
                <ColorSwatch
                  key={color}
                  color={color}
                  active={scopeStyle.color === color}
                  onPick={() => handleColor(color)}
                />
              ))}
            </div>
            <ColorPicker color={previewColor} onChange={handleColor} />
            <button
              type="button"
              className="canvas-toolbar__auto"
              onClick={() => handleColor(null)}
            >
              <span
                className="canvas-toolbar__swatch-preview"
                style={{ background: themeColor }}
              />
              自动（跟随主题）
            </button>
          </div>
        )}
      </div>
      <span className="canvas-toolbar__divider" aria-hidden="true" />
      {ALIGN_OPTIONS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          className={`canvas-toolbar__btn${
            el.props.align === value ? " is-active" : ""
          }`}
          title={label}
          aria-label={label}
          aria-pressed={el.props.align === value}
          onClick={() =>
            updateTextProps(el.id, { align: value }, { label: "文本对齐" })
          }
        >
          <AlignIcon align={value} />
        </button>
      ))}
    </div>
  );
}
