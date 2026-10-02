/**
 * 划线取色面板（任务 M4.8）：采样参数 + 线列表。
 * 去壳返回，外壳与翻页由 LabPanel 统一负责。
 */
import { useLabStore } from "../store";
import { sampleStroke } from "../strokeAnalysis";
import { exportStrokePng } from "../strokeExport";
import { PanelInfoButton } from "./PanelInfo";

const STROKE_INFO = [
  "在图像上按住左键拖出路径，系统沿路径均匀采样取色。",
  "Shift+拖画直线；按住已有的线可整体平移；空格+拖平移视图。",
  "底部小窗展示色彩旅程色带与通道曲线，悬停曲线或图像路径可双向联动定位。",
  "行内开关把线切换为代表性取样点：自动标出起终点与色彩/亮度变化最剧烈的位置。",
  "小窗自动标注明度跃迁、色相跳变与饱和度峰值；下方按钮可把整条分析导出为说明图 PNG。",
];

/* 内联 SVG（13×13，stroke currentColor，1.5px） */
function EyeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function EyeOffIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function StrokePanel() {
  const image = useLabStore((s) => s.image);
  const strokes = useLabStore((s) => s.strokes);
  const activeId = useLabStore((s) => s.activeStrokeId);
  const active = strokes.find((l) => l.id === activeId);
  const step = useLabStore((s) => s.strokeStep);
  const width = useLabStore((s) => s.strokeWidth);
  const setStep = useLabStore((s) => s.setStrokeStep);
  const setWidth = useLabStore((s) => s.setStrokeWidth);
  const setActive = useLabStore((s) => s.setActiveStroke);
  const toggleVis = useLabStore((s) => s.toggleStrokeVisible);
  const remove = useLabStore((s) => s.removeStroke);
  const update = useLabStore((s) => s.updateStroke);

  const resampleAll = (s: typeof step, w: typeof width) => {
    for (const line of strokes) {
      if (line.points.length < 2) continue;
      const r = sampleStroke(line.points, s, w);
      if (r) update(line.id, { samples: r.samples, totalLen: r.totalLen });
    }
  };

  const steps: (1 | 2 | 4 | 8)[] = [1, 2, 4, 8];
  const widths = [1, 3, 5, 9, 15];

  if (!image) {
    return (
      <>
        <header className="lab-panel__header">
          <h1 className="lab-panel__name">划线取色</h1>
          <PanelInfoButton lines={STROKE_INFO} />
        </header>
        <div className="lab-panel__card" style={{ color: "var(--text-3)", fontSize: "var(--text-sm)" }}>
          打开图像后，在图上拖拽画线取样
        </div>
      </>
    );
  }

  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">划线取色</h1>
        <PanelInfoButton lines={STROKE_INFO} />
      </header>

      <div className="lab-panel__card">
        {/* 采样参数 */}
        <div className="lab-stroke__params">
          <div className="lab-stroke__param-row">
            <span className="lab-stroke__label">步长</span>
            <div className="lab-hist__segs">
              {steps.map((v) => (
                <button key={v} type="button" className={`lab-hist__seg${step === v ? " is-active" : ""}`}
                  onClick={() => { setStep(v); resampleAll(v, width); }}>{v}px</button>
              ))}
            </div>
          </div>
          <div className="lab-stroke__param-row">
            <span className="lab-stroke__label">宽度</span>
            <div className="lab-hist__segs">
              {widths.map((v) => (
                <button key={v} type="button" className={`lab-hist__seg${width === v ? " is-active" : ""}`}
                  onClick={() => { setWidth(v); resampleAll(step, v); }}>{v}px</button>
              ))}
            </div>
          </div>
        </div>

        {/* 线列表 */}
        <div className="lab-stroke__list">
          {strokes.length === 0 ? (
            <p style={{ color: "var(--text-3)", fontSize: "var(--text-xs)" }}>
              在图像上按住左键拖拽，画出采样路径
            </p>
          ) : (
            strokes.map((line) => (
              <div
                key={line.id}
                className={`lab-stroke__row${activeId === line.id ? " is-active" : ""}`}
                onClick={() => setActive(line.id)}
              >
                <span className="lab-stroke__dot" style={{ background: line.color }} />
                <span className="lab-stroke__name">
                  线 {line.id}{line.totalLen > 0 ? ` · ${Math.round(line.totalLen)}px` : ""}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={line.asPoints}
                  className={`lab-switch lab-switch--sm${line.asPoints ? " is-on" : ""}`}
                  title="取样点模式"
                  aria-label="取样点模式"
                  onClick={(e) => { e.stopPropagation(); update(line.id, { asPoints: !line.asPoints }); }}
                />
                <button type="button" className="lab-stroke__btn"
                  title={line.visible ? "隐藏" : "显示"} aria-label={line.visible ? "隐藏" : "显示"}
                  onClick={(e) => { e.stopPropagation(); toggleVis(line.id); }}>
                  {line.visible ? <EyeIcon /> : <EyeOffIcon />}
                </button>
                <button type="button" className="lab-stroke__btn"
                  title="删除" aria-label="删除"
                  onClick={(e) => { e.stopPropagation(); remove(line.id); }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 导出说明图（导出的是 active 线） */}
      <div className="lab-panel__card">
        <button
          type="button"
          className="lab-stroke__export"
          disabled={!active || active.samples.length < 2}
          onClick={() => { if (active) exportStrokePng(active, image.name); }}
        >
          导出说明图 PNG
        </button>
      </div>
    </>
  );
}
