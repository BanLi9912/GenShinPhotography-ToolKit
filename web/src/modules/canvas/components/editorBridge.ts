import type { HistoryHint, StyleRun } from "../store";
import type { EditorStylePatch } from "./richText";

/** 编辑器选区的纯文本偏移（start ≤ end） */
export interface EditorRange {
  start: number;
  end: number;
}

/**
 * 编辑态富文本操作桥：悬浮工具条经此调用编辑器方法
 * （TextEditor 挂载时注册、每次渲染刷新，卸载清空；非编辑态为 null）。
 * applyStyle 作用于编辑器当前选区；传入 range 则用显式区间
 * （字号输入框聚焦时编辑器选区已丢，由工具条事先捕获后传入），
 * 折叠光标的处理见 TextEditor。
 * getSelectionOffsets 返回当前选区的纯文本偏移（供工具条激活态判断）；
 * getContent 返回编辑器实时内容（打字/输入态样式未提交前 store 是旧的）。
 */
export const textEditorBridge: {
  current: {
    applyStyle: (
      patch: EditorStylePatch,
      range?: EditorRange,
      history?: HistoryHint,
    ) => void;
    getSelectionOffsets: () => EditorRange | null;
    getContent: () => { runs: StyleRun[]; text: string };
    /** 焦点交还编辑器并还原选区（工具条输入框取消输入时用） */
    focusEditor: (range: EditorRange | null) => void;
  } | null;
} = { current: null };
