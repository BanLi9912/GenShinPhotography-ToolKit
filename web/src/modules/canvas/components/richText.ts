import type { StyleRun } from "../store";
import { normalizeColor } from "./colorUtils";

/**
 * 富文本核心库：样式段（StyleRun）的运算、排版测量、编辑器序列化与选区映射。
 * 文本块模型 = StyleRun[]（文字 + 局部样式），块级 fontSize/color 为缺省。
 * Konva 侧按 run 自定义绘制（Konva.Text 不支持局部样式）；
 * 编辑侧用 contentEditable，DOM ↔ 模型经本文件互转。
 */

/** 局部样式补丁：作用于一个字符区间；undefined 键不动，bold/color 可显式清除 */
export interface EditorStylePatch {
  bold?: boolean;
  fontSize?: number;
  /** string 覆盖；null 清除局部色（回到块级缺省） */
  color?: string | null;
}

/** 纯文本（各段拼接，\n 分行） */
export function runsToText(runs: StyleRun[]): string {
  return runs.map((r) => r.text).join("");
}

/** 规整：去掉空段、布尔/数值键归一、相邻同样式段合并；至少保留一个空段 */
export function normalizeRuns(runs: StyleRun[]): StyleRun[] {
  const out: StyleRun[] = [];
  for (const run of runs) {
    const clean: StyleRun = { text: run.text };
    if (run.bold) clean.bold = true;
    if (run.fontSize) clean.fontSize = run.fontSize;
    if (run.color) clean.color = run.color;
    if (clean.text.length === 0) continue;
    const last = out[out.length - 1];
    if (
      last &&
      last.bold === clean.bold &&
      last.fontSize === clean.fontSize &&
      last.color === clean.color
    ) {
      last.text += clean.text;
    } else {
      out.push(clean);
    }
  }
  return out.length > 0 ? out : [{ text: "" }];
}

/** 在 [start, end) 区间应用样式补丁（切割 → 应用 → 规整），返回新数组 */
export function applyStyleToRuns(
  runs: StyleRun[],
  start: number,
  end: number,
  patch: EditorStylePatch,
): StyleRun[] {
  if (start >= end) return runs;
  const out: StyleRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    if (runEnd <= start || runStart >= end) {
      out.push(run);
      continue;
    }
    const before = run.text.slice(0, Math.max(0, start - runStart));
    const mid = run.text.slice(
      Math.max(0, start - runStart),
      Math.min(run.text.length, end - runStart),
    );
    const after = run.text.slice(Math.min(run.text.length, end - runStart));
    if (before) out.push({ ...run, text: before });
    if (mid) {
      const styled: StyleRun = { ...run, text: mid };
      if (patch.bold !== undefined) {
        if (patch.bold) styled.bold = true;
        else delete styled.bold;
      }
      if (patch.fontSize !== undefined) styled.fontSize = patch.fontSize;
      if (patch.color !== undefined) {
        if (patch.color === null) delete styled.color;
        else styled.color = patch.color;
      }
      out.push(styled);
    }
    if (after) out.push({ ...run, text: after });
  }
  return normalizeRuns(out);
}

/** 查询区间样式：供工具条激活态/切换方向判断（字号按块级缺省折算有效值） */
export function queryRunsStyle(
  runs: StyleRun[],
  start: number,
  end: number,
  blockFontSize: number,
): {
  allBold: boolean;
  /** 区间统一的有效字号；混合或空区间返回 null */
  fontSize: number | null;
  /** 区间统一的局部色；混合、无局部色或空区间返回 null */
  color: string | null;
} {
  let any = false;
  let allBold = true;
  let sizeSet = false;
  let sizeVal = 0;
  let sizeMixed = false;
  let colorSet = false;
  let colorVal = "";
  let colorMixed = false;
  let offset = 0;
  for (const run of runs) {
    const runStart = offset;
    const runEnd = offset + run.text.length;
    offset = runEnd;
    if (runEnd <= start || runStart >= end) continue;
    any = true;
    if (!run.bold) allBold = false;
    const size = run.fontSize ?? blockFontSize;
    if (!sizeSet) {
      sizeSet = true;
      sizeVal = size;
    } else if (sizeVal !== size) sizeMixed = true;
    const color = run.color ?? null;
    if (!colorSet) {
      colorSet = true;
      colorVal = color ?? "";
    } else if ((color ?? "") !== colorVal) colorMixed = true;
  }
  return {
    allBold: any && allBold,
    fontSize: !sizeSet || sizeMixed ? null : sizeVal,
    color: !colorSet || colorMixed ? null : colorVal || null,
  };
}

/** 整段是否已全部加粗 */
export function runsAllBold(runs: StyleRun[]): boolean {
  const text = runsToText(runs);
  if (text.length === 0) return false;
  return queryRunsStyle(runs, 0, text.length, 0).allBold;
}

/* ---- 排版测量（Konva 自定义绘制用） ---- */

export interface LaidRun {
  text: string;
  bold: boolean;
  fontSize: number;
  color?: string;
  width: number;
  /** 盒高基线以上部分（ascent + 半行距），CSS 行盒对齐用 */
  aboveBaseline: number;
  /** 盒高基线以下部分（descent + 半行距） */
  belowBaseline: number;
}
export interface LaidLine {
  runs: LaidRun[];
  width: number;
  /** 行盒顶到基线的距离 */
  baseline: number;
  /** 行盒高（含 strut，与 CSS 行盒一致） */
  height: number;
}

/** canvas 字体串（测量与绘制共用同一格式） */
export function runFont(
  bold: boolean,
  fontSize: number,
  fontFamily: string,
): string {
  return `${bold ? "bold " : ""}${fontSize}px ${fontFamily}`;
}

let measureContext: CanvasRenderingContext2D | null = null;
function getMeasureContext(): CanvasRenderingContext2D {
  if (!measureContext)
    measureContext = document.createElement("canvas").getContext("2d");
  if (!measureContext) throw new Error("无法创建文本测量用 canvas");
  return measureContext;
}

interface BoxMetrics {
  /** 盒高基线以上部分（ascent + 半行距） */
  above: number;
  /** 盒高基线以下部分（descent + 半行距） */
  below: number;
}

const boxMetricsCache = new Map<string, BoxMetrics>();
let probeEl: HTMLDivElement | null = null;

/**
 * 实测某字号文本盒在 CSS 行盒中的基线上/下高度（含半行距）。
 * CSS 行内排版用的 ascent/descent（hhea/OS2 typo 组）canvas 不暴露
 * （fontBoundingBox 是字形包围盒，数值更大），故让浏览器按真实行高
 * 排一个探针：0 高 inline-block 的底边即基线，div 高即行盒高。
 */
function measureBoxMetrics(
  bold: boolean,
  fontSize: number,
  fontFamily: string,
  lineHeight: number,
): BoxMetrics {
  const key = `${bold ? 1 : 0}|${fontSize}|${fontFamily}|${lineHeight}`;
  const hit = boxMetricsCache.get(key);
  if (hit) return hit;
  if (!probeEl) {
    probeEl = document.createElement("div");
    probeEl.setAttribute("aria-hidden", "true");
    probeEl.style.cssText =
      "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;margin:0;padding:0;border:0";
    document.body.appendChild(probeEl);
  }
  probeEl.style.font = runFont(bold, fontSize, fontFamily);
  probeEl.style.lineHeight = String(lineHeight); // font 简写会重置，须后设
  probeEl.innerHTML =
    '<span>M</span><i style="display:inline-block;width:0;height:0"></i>';
  const rect = probeEl.getBoundingClientRect();
  const above =
    probeEl.querySelector("i")!.getBoundingClientRect().bottom - rect.top;
  const metrics: BoxMetrics = { above, below: rect.height - above };
  boxMetricsCache.set(key, metrics);
  return metrics;
}

/**
 * 分行 + 逐 run 测量，按 CSS 行盒模型排版（与编辑态 contentEditable 逐项对齐）：
 * 每行都含一个块级字号的 strut（空盒，同 CSS 行盒的继承行高）；
 * 行盒高 = 各盒（strut + 各 run）"基线上高度 + 基线下高度"（均含半行距）的最大值之和；
 * 行内各 run 共用一条基线（textBaseline: "alphabetic" 直接画在基线上）。
 * 盒高度量经 measureBoxMetrics 由浏览器实测，宽度经 canvas 实测。
 */
export function layoutTextBlock(
  runs: StyleRun[],
  blockFontSize: number,
  fontFamily: string,
  lineHeight: number,
): { lines: LaidLine[]; width: number; height: number } {
  const ctx = getMeasureContext();
  // strut：CSS 中每行都含一个块级字号的空盒，行高不低于块级行高
  const strut = measureBoxMetrics(false, blockFontSize, fontFamily, lineHeight);

  const rawLines: { runs: LaidRun[]; width: number }[] = [
    { runs: [], width: 0 },
  ];
  for (const run of runs) {
    const size = run.fontSize ?? blockFontSize;
    const bold = run.bold ?? false;
    const box = measureBoxMetrics(bold, size, fontFamily, lineHeight);
    run.text.split("\n").forEach((part, index) => {
      if (index > 0) rawLines.push({ runs: [], width: 0 });
      const line = rawLines[rawLines.length - 1];
      if (part.length === 0) return;
      ctx.font = runFont(bold, size, fontFamily);
      const width = ctx.measureText(part).width;
      line.runs.push({
        text: part,
        bold,
        fontSize: size,
        color: run.color,
        width,
        aboveBaseline: box.above,
        belowBaseline: box.below,
      });
      line.width += width;
    });
  }
  const lines: LaidLine[] = rawLines.map((line) => {
    const baseline = Math.max(
      strut.above,
      ...line.runs.map((r) => r.aboveBaseline),
    );
    const bottom = Math.max(
      strut.below,
      ...line.runs.map((r) => r.belowBaseline),
    );
    return { ...line, baseline, height: baseline + bottom };
  });
  const width = Math.max(1, ...lines.map((l) => l.width));
  const height = lines.reduce((sum, l) => sum + l.height, 0);
  return { lines, width, height };
}

/* ---- 编辑器（contentEditable）互转与选区映射 ---- */

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * runs → 编辑器 HTML（每行一个 div；局部样式包 span/b）。
 * 局部字号用 em 比值（相对块级字号），与缩放解耦。
 */
export function runsToEditorHtml(
  runs: StyleRun[],
  blockFontSize: number,
): string {
  const span = (run: StyleRun): string => {
    const styles: string[] = [];
    if (run.fontSize && run.fontSize !== blockFontSize)
      styles.push(`font-size:${(run.fontSize / blockFontSize).toFixed(3)}em`);
    if (run.color) styles.push(`color:${run.color}`);
    const content = styles.length
      ? `<span style="${styles.join(";")}">${escapeHtml(run.text)}</span>`
      : escapeHtml(run.text);
    return run.bold ? `<b>${content}</b>` : content;
  };
  // run 内 \n 断行
  const lineHtml: string[] = [];
  let current = "";
  const flush = () => {
    lineHtml.push(current.length > 0 ? `<div>${current}</div>` : "<div><br></div>");
    current = "";
  };
  for (const run of runs) {
    run.text.split("\n").forEach((part, index) => {
      if (index > 0) flush();
      if (part.length > 0) current += span({ ...run, text: part });
    });
  }
  flush();
  return lineHtml.join("");
}

interface RunStyle {
  bold: boolean;
  fontSize?: number;
  color?: string;
}

type EditorEvent =
  | { type: "text"; node: Text; style: RunStyle }
  | { type: "newline" };

/**
 * 编辑器内容的统一遍历：文本节点（带样式上下文）与换行事件。
 * 序列化、选区偏移映射共用此遍历，保证三者口径一致。
 * 换行规则：块级元素（div/p/li）在已有内容后出现时补一个换行；<br> 计一个换行。
 */
function* iterateEditorContent(
  root: HTMLElement,
  blockFontSize: number,
): Generator<EditorEvent> {
  let emittedLength = 0;
  let atLineStart = true;
  const walk = function* (
    node: Node,
    style: RunStyle,
  ): Generator<EditorEvent> {
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node.textContent ?? "").length;
      if (length > 0) {
        yield { type: "text", node: node as Text, style };
        emittedLength += length;
        atLineStart = false;
      }
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    const tag = node.tagName;
    if (tag === "BR") {
      yield { type: "newline" };
      emittedLength += 1;
      atLineStart = true;
      return;
    }
    const next: RunStyle = { ...style };
    const weight = node.style.fontWeight;
    if (
      tag === "B" ||
      tag === "STRONG" ||
      weight === "bold" ||
      (weight !== "" && Number.parseInt(weight, 10) >= 600)
    )
      next.bold = true;
    const fontSize = node.style.fontSize;
    if (fontSize.endsWith("em"))
      next.fontSize = Math.round(Number.parseFloat(fontSize) * blockFontSize);
    else if (fontSize.endsWith("px"))
      next.fontSize = Math.round(Number.parseFloat(fontSize));
    const color =
      node.style.color ||
      (tag === "FONT" ? (node.getAttribute("color") ?? "") : "");
    if (color) next.color = normalizeColor(color);
    const isBlock = tag === "DIV" || tag === "P" || tag === "LI";
    if (isBlock && emittedLength > 0 && !atLineStart) {
      yield { type: "newline" };
      emittedLength += 1;
      atLineStart = true;
    }
    for (const child of node.childNodes) yield* walk(child, next);
  };
  for (const child of root.childNodes)
    yield* walk(child, { bold: false });
}

/** 编辑器 DOM → runs（只认 b/strong/font-weight/em 字号/内联色，其余拍平） */
export function serializeEditor(
  root: HTMLElement,
  blockFontSize: number,
): { runs: StyleRun[]; text: string } {
  const runs: StyleRun[] = [];
  for (const ev of iterateEditorContent(root, blockFontSize)) {
    if (ev.type === "newline") {
      runs.push({ text: "\n" });
      continue;
    }
    const run: StyleRun = { text: ev.node.textContent ?? "" };
    if (ev.style.bold) run.bold = true;
    if (ev.style.fontSize) run.fontSize = ev.style.fontSize;
    if (ev.style.color) run.color = ev.style.color;
    runs.push(run);
  }
  const normalized = normalizeRuns(runs);
  return { runs: normalized, text: runsToText(normalized) };
}

/** DOM 位置（node, offset）→ 纯文本偏移；node 不在 root 内返回 null */
export function domPointToTextOffset(
  root: HTMLElement,
  node: Node,
  offset: number,
  blockFontSize: number,
): number | null {
  if (!root.contains(node)) return null;
  const range = document.createRange();
  let length = 0;
  for (const ev of iterateEditorContent(root, blockFontSize)) {
    if (ev.type === "newline") {
      length += 1;
      continue;
    }
    range.selectNodeContents(ev.node);
    const cmp = range.comparePoint(node, offset); // -1 前 / 0 内 / 1 后
    if (cmp === 0) return length + offset;
    if (cmp === -1) return length;
    length += ev.node.length;
  }
  return length;
}

/** 纯文本偏移 → DOM 位置（换行边界落到下一文本节点起点；空编辑器落到 root 起点） */
export function textOffsetToDomPoint(
  root: HTMLElement,
  target: number,
  blockFontSize: number,
): { node: Node; offset: number } {
  let length = 0;
  let lastText: Text | null = null;
  for (const ev of iterateEditorContent(root, blockFontSize)) {
    if (ev.type === "newline") {
      length += 1;
      continue;
    }
    lastText = ev.node;
    const nodeLength = ev.node.length;
    if (target <= length + nodeLength)
      return { node: ev.node, offset: target - length };
    length += nodeLength;
  }
  if (lastText) return { node: lastText, offset: lastText.length };
  return { node: root, offset: 0 };
}
