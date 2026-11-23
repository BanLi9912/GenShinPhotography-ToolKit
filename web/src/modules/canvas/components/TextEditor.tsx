import { useEffect, useRef } from "react";
import type { ClipboardEvent as ReactClipboardEvent } from "react";
import { useCanvasStore, type HistoryHint, type TextElement } from "../store";
import { textEditorBridge, type EditorRange } from "./editorBridge";
import {
  applyStyleToRuns,
  domPointToTextOffset,
  runsToEditorHtml,
  runsToText,
  serializeEditor,
  textOffsetToDomPoint,
  type EditorStylePatch,
} from "./richText";

interface TextEditorProps {
  element: TextElement;
}

/**
 * 文本编辑覆盖层（任务 1.2）：在文本块屏幕位置覆盖一个 contentEditable。
 * 字号/颜色/对齐/行高与 Konva 节点逐项对齐，进出编辑视觉连续。
 * 局部样式（粗体/字号/颜色）经 textEditorBridge 作用于当前选区：
 * 序列化 DOM → 按选区偏移打补丁 → 重渲染编辑器并还原选区；
 * 折叠光标时粗体/颜色交给浏览器"输入态"（execCommand），新输入即生效；
 * 工具条输入框聚焦导致选区丢失时，由工具条传入显式区间（range）。
 * 失焦或 Ctrl+Enter 提交，Escape 放弃（还原编辑前样式）；空文本提交即移除。
 */
export function TextEditor({ element: el }: TextEditorProps) {
  const viewport = useCanvasStore((s) => s.viewport);
  const updateTextProps = useCanvasStore((s) => s.updateTextProps);
  const removeElements = useCanvasStore((s) => s.removeElements);
  const setSelectedIds = useCanvasStore((s) => s.setSelectedIds);
  const setEditingId = useCanvasStore((s) => s.setEditingId);

  const rootRef = useRef<HTMLDivElement>(null);
  // blur 与 Escape/Ctrl+Enter 可能相继触发，提交/放弃只做一次
  const doneRef = useRef(false);
  // 编辑前的样式快照（Escape 放弃时还原；编辑中工具条动作会实时写 store）
  const originalRef = useRef({
    runs: el.props.runs,
    fontSize: el.props.fontSize,
    color: el.props.color,
  });

  /** 当前选区的纯文本偏移（start ≤ end；不在编辑器内返回 null） */
  const getSelectionOffsets = (): { start: number; end: number } | null => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;
    const anchor = domPointToTextOffset(
      root,
      selection.anchorNode!,
      selection.anchorOffset,
      el.props.fontSize,
    );
    const focus = domPointToTextOffset(
      root,
      selection.focusNode!,
      selection.focusOffset,
      el.props.fontSize,
    );
    if (anchor === null || focus === null) return null;
    return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
  };

  /** 把选区还原到给定的文本偏移 */
  const restoreSelection = (start: number, end: number) => {
    const root = rootRef.current;
    const selection = window.getSelection();
    if (!root || !selection) return;
    const a = textOffsetToDomPoint(root, start, el.props.fontSize);
    const b = textOffsetToDomPoint(root, end, el.props.fontSize);
    selection.setBaseAndExtent(a.node, a.offset, b.node, b.offset);
  };

  /**
   * 工具条样式动作：作用于当前选区；传入 range 时用显式区间（调用后焦点交还编辑器）。
   * 折叠光标时粗体/颜色走浏览器"输入态"（execCommand），新输入即生效。
   * 整段改字号时块级缺省随即将变为新值，重渲染的 em 基准直接用新值，
   * 否则局部字号 span 相对旧基准换算、再随块级新字号二次放大。
   */
  const applyStyle = (
    patch: EditorStylePatch,
    range?: EditorRange,
    history?: HistoryHint,
  ) => {
    const root = rootRef.current;
    if (!root) return;
    const offsets = range ?? getSelectionOffsets();
    const hasSelection = offsets !== null && offsets.start !== offsets.end;
    if (range === undefined && !hasSelection && patch.bold !== undefined) {
      root.focus();
      document.execCommand("bold");
      return;
    }
    if (
      range === undefined &&
      !hasSelection &&
      patch.color !== undefined &&
      patch.color !== null
    ) {
      root.focus();
      document.execCommand("foreColor", false, patch.color);
      return;
    }
    const { runs, text } = serializeEditor(root, el.props.fontSize);
    const start = hasSelection ? offsets.start : 0;
    const end = hasSelection ? offsets.end : text.length;
    const next = applyStyleToRuns(runs, start, end, patch);
    const nextBase =
      !hasSelection && patch.fontSize !== undefined
        ? patch.fontSize
        : el.props.fontSize;
    root.innerHTML = runsToEditorHtml(next, nextBase);
    if (range !== undefined) root.focus();
    restoreSelection(start, end);
    updateTextProps(el.id, { runs: next }, history);
  };

  /** 编辑器实时内容（打字/输入态样式先于 store，工具条激活态以此为准） */
  const getContent = () => {
    const root = rootRef.current;
    if (!root) return { runs: el.props.runs, text: runsToText(el.props.runs) };
    return serializeEditor(root, el.props.fontSize);
  };

  /** 焦点交还编辑器并按需还原选区（工具条输入框取消输入时用） */
  const focusEditor = (range: EditorRange | null) => {
    const root = rootRef.current;
    if (!root) return;
    root.focus();
    if (range) restoreSelection(range.start, range.end);
  };

  // 挂载：注入初始 HTML（runs → 行 div + 样式 span），光标落到末尾
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    root.innerHTML = runsToEditorHtml(el.props.runs, el.props.fontSize);
    document.execCommand("styleWithCSS", false, "false"); // 输入态产出 <b>/<font> 而非内联样式
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    root.focus();
    // 仅在挂载时初始化一次（编辑期间 DOM 归浏览器与 applyStyle 管）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 工具条桥随每次渲染刷新：闭包始终拿到当前 props（如块级字号变更后的新值）
  useEffect(() => {
    textEditorBridge.current = {
      applyStyle,
      getSelectionOffsets,
      getContent,
      focusEditor,
    };
    return () => {
      textEditorBridge.current = null;
    };
  });

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const root = rootRef.current;
    const serialized = root
      ? serializeEditor(root, el.props.fontSize)
      : { runs: el.props.runs, text: runsToText(el.props.runs) };
    const trimmedText = serialized.text.replace(/\s+$/, "");
    const trimmedRuns =
      trimmedText.length === serialized.text.length
        ? serialized.runs
        : applyStyleToRuns(serialized.runs, 0, trimmedText.length, {});
    if (commit && trimmedText.length > 0) {
      updateTextProps(el.id, { runs: trimmedRuns }, { label: "编辑文本" });
      setSelectedIds([el.id]); // 提交后保持选中，方便立刻用悬浮条调样式
    } else if (commit) {
      removeElements([el.id]); // 提交空文本 → 移除
    } else {
      // 放弃：还原编辑前样式；新建即放弃 → 移除
      const original = originalRef.current;
      if (runsToText(original.runs).length === 0) removeElements([el.id]);
      else
        updateTextProps(el.id, {
          runs: original.runs,
          fontSize: original.fontSize,
          color: original.color,
        });
    }
    setEditingId(null);
  };

  // 只接受纯文本粘贴，避免外部富文本把样式/图片带进编辑器
  const handlePaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (text) document.execCommand("insertText", false, text);
  };

  return (
    <div
      ref={rootRef}
      className="canvas-editor"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="编辑文本"
      spellCheck={false}
      onPaste={handlePaste}
      onBlur={(e) => {
        // 焦点移到悬浮工具条不算退出编辑（空文本也能先用工具条调格式）
        if (
          e.relatedTarget instanceof HTMLElement &&
          e.relatedTarget.closest(".canvas-toolbar")
        )
          return;
        finish(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          finish(true);
        }
      }}
      style={{
        left: el.transform.x * viewport.zoom + viewport.x,
        // Konva 侧同为 CSS 行盒模型（layoutTextBlock），原点直接对齐即不错位
        top: el.transform.y * viewport.zoom + viewport.y,
        fontSize: el.props.fontSize * viewport.zoom,
        color: el.props.color ?? undefined, // undefined → CSS 走 --text-1 随主题
        textAlign: el.props.align,
        minWidth: 120 * viewport.zoom,
      }}
    />
  );
}
