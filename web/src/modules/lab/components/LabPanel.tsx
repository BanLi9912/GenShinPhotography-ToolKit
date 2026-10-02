import { useLayoutEffect, useRef, useState } from "react";
import { useLabStore } from "../store";
import type { LabTool } from "../store";
import { DotGainPanel } from "./DotGainPanel";
import { HistogramPanel } from "./HistogramPanel";
import { SaturationPanel } from "./SaturationPanel";
import { StrokePanel } from "./StrokePanel";
import { HarmonyPanel } from "./HarmonyPanel";
import { PalettePanel } from "./PalettePanel";
import { PanelInfoButton } from "./PanelInfo";

/**
 * 面板占位信息（任务 M4.1 骨架期）：各工具的完整输出随对应任务接入后，
 * 本表逐步移除；排版规则见开发文档-M4 §2.3。
 */
const PANEL_INFO: Record<
  Exclude<LabTool, "histogram" | "saturation" | "dotgain" | "stroke" | "harmony" | "palette">,
  { name: string; desc: string; plan: string }
> = {
  falsecolor: {
    name: "假彩色",
    desc: "明度映射色带，曝光结构一眼可读",
    plan: "任务 M4.6",
  },
  compare: {
    name: "对比模式",
    desc: "双图左右/上下/滑轨对比（P1）",
    plan: "Backlog",
  },
};

/**
 * 按工具分发面板内容（外壳与翻页由 LabPanel 统一负责）。
 * HistogramPanel / SaturationPanel 已去壳，直接返回 header + 内容。
 */
function ToolContent({ tool }: { tool: LabTool }) {
  const hasImage = useLabStore((s) => s.image !== null);
  if (tool === "histogram") return <HistogramPanel />;
  if (tool === "dotgain") return <DotGainPanel />;
  if (tool === "saturation") return <SaturationPanel />;
  if (tool === "stroke") return <StrokePanel />;
  if (tool === "harmony") return <HarmonyPanel />;
  if (tool === "palette") return <PalettePanel />;
  const info = PANEL_INFO[tool];
  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">{info.name}</h1>
        <PanelInfoButton lines={[info.desc]} />
      </header>
      <div className="lab-panel__card">
        {hasImage
          ? `完整输出随 ${info.plan} 接入`
          : "打开图像后，这里显示该工具的分析结果"}
      </div>
    </>
  );
}

/**
 * 右半输出区（开发文档-M4 §2.3）：单一常驻外壳 + 翻页式工具切换。
 * 切换时新旧两个 .lab-panel 绝对定位共存一帧：旧页整页滑出、新页反向滑入，
 * 方向由 toolDir 决定（store），250ms ease-out 纯平移无淡入淡出。
 */
export function LabPanel() {
  const tool = useLabStore((s) => s.tool);
  const toolDir = useLabStore((s) => s.toolDir);
  const panel = useLabStore((s) => s.panel);

  // 翻页状态机：tool 变化时把旧工具挂为退出页，其滑出动画结束即卸载；
  // 动画进行中再次切换，旧退出页直接由新的退出页取代（允许中断，不排队）
  const [exiting, setExiting] = useState<LabTool | null>(null);
  const [renderedTool, setRenderedTool] = useState<LabTool>(tool);
  const prevToolRef = useRef(tool);
  const delayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    if (prevToolRef.current === tool) return;
    // stroke 离开时若抽屉可见，等 150ms 抽屉下移再翻页
    const wasStroke = prevToolRef.current === "stroke";
    if (wasStroke) {
      const st = useLabStore.getState();
      const active = st.strokes.find(l => l.id === st.activeStrokeId);
      if (active?.visible && active.samples.length > 1) {
        delayRef.current = setTimeout(() => {
          setExiting(prevToolRef.current);
          prevToolRef.current = tool;
          setRenderedTool(tool);
        }, 150);
        return () => { if (delayRef.current) clearTimeout(delayRef.current); };
      }
    }
    setExiting(prevToolRef.current);
    prevToolRef.current = tool;
    setRenderedTool(tool);
    return () => { if (delayRef.current) clearTimeout(delayRef.current); };
  }, [tool]);

  const dir = toolDir === 1 ? "up" : "down"; // 1 = 新工具在下方：旧页向上滑出，新页自下方滑入
  return (
    <section
      id="lab-output-wrapper"
      className={`lab-output${panel.collapsed ? " is-collapsed" : ""}${exiting ? " is-switching" : ""}`}
      style={{ width: panel.width }}
      aria-label="分析输出"
    >
      {exiting && (
        <div
          className={`lab-panel lab-panel--exit-${dir}`}
          aria-hidden="true"
          onAnimationEnd={() => setExiting(null)}
        >
          <ToolContent tool={exiting} />
        </div>
      )}
      <div
        className={`lab-panel${exiting ? ` lab-panel--enter-${dir}` : ""}`}
        key={renderedTool}
      >
        <ToolContent tool={renderedTool} />
      </div>
    </section>
  );
}
