/**
 * 主色板面板（任务 M4.7）：median-cut 主色提取（复用 palette.ts）+ 色卡读数 + 点击复制 + 横条 PNG 导出。
 * 去壳返回，外壳与翻页由 LabPanel 统一负责；数据经组件内 useMemo 现算，零 store 改动。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "../store";
import { extractPalette } from "../palette";
import type { PaletteColor } from "../palette";
import { PanelInfoButton } from "./PanelInfo";

const PALETTE_INFO = [
  "缩样 ≤64×64 经 median-cut 聚类出 5–8 个主色，按占比降序排列（算法与 M3 图库共用）。",
  "占比 = 该色簇像素数 / 缩样总像素数；点击色卡复制该色 HEX。",
  "「导出色板图」把当前主色生成为横条 PNG 下载。",
];

export function PalettePanel() {
  const image = useLabStore((s) => s.image);
  const [count, setCount] = useState(6);
  const [copiedHex, setCopiedHex] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const palette = useMemo(() => extractPalette(count), [image, count]); // eslint-disable-line react-hooks/exhaustive-deps

  // 卸载清理复制反馈计时器
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  /** 复制失败兜底：textarea + execCommand（对齐演示 :1007-1012） */
  const fallbackCopy = (text: string, done: () => void) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      /* 复制失败静默（不引 toast） */
    }
    ta.remove();
  };

  const copyColor = (c: PaletteColor) => {
    const done = () => {
      setCopiedHex(c.hex);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopiedHex((h) => (h === c.hex ? null : h)), 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(c.hex).then(done, () => fallbackCopy(c.hex, done));
    } else {
      fallbackCopy(c.hex, done);
    }
  };

  /** 色板横条 PNG：count×100 纯色块（内容色，对齐演示 :1013-1020） */
  const exportPalettePng = () => {
    if (!palette || palette.length === 0 || !image) return;
    const W = palette.length * 100;
    const H = 100;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    palette.forEach((c, i) => {
      ctx.fillStyle = `rgb(${c.r},${c.g},${c.b})`; // 内容色
      ctx.fillRect(i * 100, 0, 100, 100);
    });
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${image.name.replace(/\.[^.]+$/, "")}-主色板.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    }, "image/png");
  };

  if (!image) {
    return (
      <>
        <header className="lab-panel__header">
          <h1 className="lab-panel__name">主色板</h1>
          <PanelInfoButton lines={PALETTE_INFO} />
        </header>
        <div className="lab-panel__card" style={{ color: "var(--text-3)", fontSize: "var(--text-sm)" }}>
          打开图像后，这里显示主色板与占比
        </div>
      </>
    );
  }

  return (
    <>
      <header className="lab-panel__header">
        <h1 className="lab-panel__name">主色板</h1>
        <PanelInfoButton lines={PALETTE_INFO} />
      </header>

      {/* 参数 + 色块拼图（占比比例条，点击复制） */}
      <div className="lab-panel__card">
        <div className="lab-stroke__param-row">
          <span className="lab-stroke__label">主色数量</span>
          <div className="lab-hist__segs">
            {[5, 6, 7, 8].map((v) => (
              <button key={v} type="button"
                className={`lab-hist__seg${count === v ? " is-active" : ""}`}
                onClick={() => setCount(v)}>{v}</button>
            ))}
          </div>
        </div>
        <div className="lab-palette__strip">
          {palette?.map((c) => (
            <button key={c.hex} type="button"
              className={`lab-palette__strip-block${copiedHex === c.hex ? " is-copied" : ""}`}
              title={`${c.hex} · ${(c.p * 100).toFixed(1)}% · 点击复制`}
              aria-label={`复制 ${c.hex}`}
              style={{ flexGrow: Math.max(1, c.p * 1000), flexBasis: 0, background: `rgb(${c.r},${c.g},${c.b})` }}
              onClick={() => copyColor(c)} />
          ))}
        </div>
        {copiedHex && <p className="lab-palette__hint" aria-live="polite">已复制 {copiedHex}</p>}
        {/* 读数明细（HEX / 占比 / RGB / HSL，全部展示；点击行复制 hex） */}
        <div className="lab-palette__rows">
          {palette?.map((c) => (
            <button key={c.hex} type="button"
              className={`lab-palette__row${copiedHex === c.hex ? " is-copied" : ""}`}
              title="点击复制 HEX"
              aria-label={`复制 ${c.hex}`}
              onClick={() => copyColor(c)}>
              <span className="lab-palette__row-chip" style={{ background: `rgb(${c.r},${c.g},${c.b})` }} />
              <span className="lab-palette__row-text">
                <span className="lab-palette__row-main">{c.hex} · {(c.p * 100).toFixed(1)}%</span>
                <span className="lab-palette__row-sub">RGB {c.r} {c.g} {c.b} · HSL {Math.round(c.h)}° {Math.round(c.s)}% {Math.round(c.l)}%</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* 导出横条 PNG */}
      <div className="lab-panel__card">
        <button
          type="button"
          className="lab-palette__export"
          disabled={!palette || palette.length === 0}
          onClick={exportPalettePng}
        >
          导出色板图 PNG
        </button>
      </div>
    </>
  );
}
