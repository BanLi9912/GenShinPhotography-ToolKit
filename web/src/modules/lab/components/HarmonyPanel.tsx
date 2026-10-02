/**
 * 色彩和谐面板（任务 M4.9）：median-cut 主色提取 + 色轮落点 + 结构判定。
 * 去壳返回，外壳与翻页由 LabPanel 统一负责；数据经组件内 useMemo 现算，零 store 改动。
 */
import { useMemo } from "react";
import { useLabStore } from "../store";
import { extractPalette } from "../palette";
import { analyzeHarmony } from "../harmony";
import { PanelInfoButton } from "./PanelInfo";

const HARMONY_INFO = [
  "提取画面主色并落到色轮：色相定角度、饱和度定半径。",
  "自动判定近似 / 互补 / 三角 / 分裂互补结构，并给出与经典模板的角度偏差。",
  "饱和度低于 15% 的主色不参与判定（灰的色相不稳定）。",
];

export function HarmonyPanel() {
  const image = useLabStore((s) => s.image);
  const palette = useMemo(() => extractPalette(6), [image]); // eslint-disable-line react-hooks/exhaustive-deps
  const result = useMemo(() => (palette ? analyzeHarmony(palette) : null), [palette]);

  if (!image) {
    return (
      <>
        <header className="lab-panel__header">
          <h1 className="lab-panel__name">色彩和谐</h1>
          <PanelInfoButton lines={HARMONY_INFO} />
        </header>
        <div className="lab-panel__card" style={{ color: "var(--text-3)", fontSize: "var(--text-sm)" }}>
          打开图像后，这里显示色轮与和谐结构判定
        </div>
      </>
    );
  }

  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">色彩和谐</h1>
        <PanelInfoButton lines={HARMONY_INFO} />
      </header>

      {/* 色轮卡：12 楔 + 外圈 + 主色落点（H 定角度、S 定半径） */}
      <div className="lab-panel__card">
        <svg
          viewBox="0 0 200 200"
          style={{ maxWidth: 210, margin: "0 auto", display: "block", width: "100%" }}
          role="img"
          aria-label="主色色轮"
        >
          {Array.from({ length: 12 }, (_, i) => {
            const a0 = ((i * 30 - 105) * Math.PI) / 180;
            const a1 = ((i * 30 - 75) * Math.PI) / 180;
            const x0 = 100 + Math.cos(a0) * 78;
            const y0 = 100 + Math.sin(a0) * 78;
            const x1 = 100 + Math.cos(a1) * 78;
            const y1 = 100 + Math.sin(a1) * 78;
            return (
              <path
                key={i}
                d={`M100,100 L${x0.toFixed(1)},${y0.toFixed(1)} A78,78 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`}
                fill={`hsl(${i * 30},60%,55%)`} // 内容色
                opacity="0.85"
              />
            );
          })}
          <circle cx="100" cy="100" r="78" fill="none" stroke="var(--line)" />
          {palette?.map((c) => {
            const a = ((c.h - 90) * Math.PI) / 180;
            const r = (c.s / 100) * 78;
            return (
              <circle
                key={c.hex}
                cx={(100 + Math.cos(a) * r).toFixed(1)}
                cy={(100 + Math.sin(a) * r).toFixed(1)}
                r="5"
                fill={`rgb(${c.r},${c.g},${c.b})`}
                stroke="#ffffff" // 内容色
                strokeWidth="1.5"
              >
                <title>{c.hex}</title>
              </circle>
            );
          })}
        </svg>
        {result && <p className="lab-harmony__verdict">{result.verdict}</p>}
        {result?.structures.map((st) => (
          <p key={st.kind} className="lab-harmony__row">{st.detail}</p>
        ))}
      </div>

      {/* 主色卡：6 色块 + hex + 占比 */}
      <div className="lab-panel__card">
        <div className="lab-harmony__swatches">
          {palette?.map((c) => (
            <div key={c.hex} className="lab-harmony__swatch">
              <span
                className="lab-harmony__swatch-dot"
                style={{ background: `rgb(${c.r},${c.g},${c.b})` }}
              />
              <span className="lab-harmony__swatch-hex">{c.hex}</span>
              <span className="lab-harmony__swatch-pct">{Math.round(c.p * 100)}%</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
