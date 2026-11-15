/**
 * M3.4 筛选浮层：tag 云（AND/OR）/ 明度 / 冷暖 / 取色（三个取色托盘：取色行/高光/阴影，
 * 每托盘组内 AND/OR + 组间一个 AND/OR；拖拽色片在托盘间移动，Lab 距离 ≤25）/
 * 清空全部。锚在工具栏岛下方；浮层外点击或 Esc 关闭
 * （Esc stopPropagation，不触发页面级 Esc）。
 * 文件夹树 2026-10-17 迁出到左侧浮层（见 FolderDrawer：贴左缘静止片刻弹出），
 * 本浮层不再有「文件夹」一节。
 */
import { useEffect, useRef, useState } from "react";
import type { ColorFilter } from "../search/rank";
import { useLibraryStore, type Tone, type Warmth } from "../store";
import { TagCloud } from "./TagCloud";

const TONE_OPTIONS: Array<{ value: Tone; label: string }> = [
  { value: "low", label: "低调" },
  { value: "mid", label: "中调" },
  { value: "high", label: "高调" },
];

const WARMTH_OPTIONS: Array<{ value: Warmth; label: string }> = [
  { value: "warm", label: "暖色" },
  { value: "cool", label: "冷色" },
  { value: "neutral", label: "中性" },
];

/** 取色托盘：取色行（色板主色，粗略直配）/ 高光（hiColor）/ 阴影（loColor） */
const COLOR_TRAYS = [
  { key: "row", label: "取色行" },
  { key: "hi", label: "高光" },
  { key: "lo", label: "阴影" },
] as const;

type ColorTrayKey = (typeof COLOR_TRAYS)[number]["key"];

/** 空筛选模板：组间默认 AND（拖色细化自然收窄），组内默认 OR（收集盘语义） */
const EMPTY_FILTER: ColorFilter = {
  mode: "and",
  row: { mode: "or", colors: [] },
  hi: { mode: "or", colors: [] },
  lo: { mode: "or", colors: [] },
};

/**
 * 托盘取色器：只监听原生 `change` 事件（提交最终颜色时才触发）。
 * 不绑 React onChange——其底层是 `input` 事件，在取色对话框里拖动圆点
 * 会连续触发，导致路径上所有中间色都被加入托盘。
 */
function ColorAddInput({
  label,
  tray,
  onAdd,
}: {
  label: string;
  tray: ColorTrayKey;
  onAdd: (tray: ColorTrayKey, hex: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  /** 最新 handler 引用：监听器只在挂载时绑定一次，始终调用最新闭包 */
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const commit = () => onAddRef.current(tray, el.value);
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [tray]);

  return (
    <input
      ref={inputRef}
      type="color"
      defaultValue="#000000"
      aria-label={`取色·${label}`}
      title={`向「${label}」添加颜色`}
    />
  );
}

export function FilterBar() {
  const filterOpen = useLibraryStore((s) => s.filterOpen);
  const setFilterOpen = useLibraryStore((s) => s.setFilterOpen);
  const toneFilter = useLibraryStore((s) => s.toneFilter);
  const setToneFilter = useLibraryStore((s) => s.setToneFilter);
  const warmthFilter = useLibraryStore((s) => s.warmthFilter);
  const setWarmthFilter = useLibraryStore((s) => s.setWarmthFilter);
  const colorFilter = useLibraryStore((s) => s.colorFilter);
  const setColorFilter = useLibraryStore((s) => s.setColorFilter);
  const clearSearchAndFilters = useLibraryStore((s) => s.clearSearchAndFilters);
  /** 拖拽态：源托盘 + 拖动的色值（HTML5 DnD 用组件状态传递，不依赖 dataTransfer 读取） */
  const [drag, setDrag] = useState<{ from: ColorTrayKey; hex: string } | null>(
    null,
  );
  const [dragOver, setDragOver] = useState<ColorTrayKey | null>(null);
  /** 下拉弹出/收回动画：进入立即挂载（下拉），退出先播收回动画再卸载 */
  const [mounted, setMounted] = useState(filterOpen);
  const [leaving, setLeaving] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  // 下拉动画编排（口径同 LibraryPage 的 BatchPanel/DetailView 挂载模式）
  useEffect(() => {
    if (filterOpen) {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setMounted(false);
      setLeaving(false);
    }, 200);
    return () => {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
    };
  }, [filterOpen, mounted]);

  // Esc 关闭（stopPropagation 不冒泡到页面级）
  useEffect(() => {
    if (!filterOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setFilterOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterOpen, setFilterOpen]);

  if (!mounted) return null;


  /** 向托盘追加颜色（去重；小写统一） */  const addColor = (tray: ColorTrayKey, hex: string) => {
    const cur = colorFilter ?? EMPTY_FILTER;
    const h = hex.toLowerCase();
    if (cur[tray].colors.includes(h)) return;
    setColorFilter({
      ...cur,
      [tray]: { ...cur[tray], colors: [...cur[tray].colors, h] },
    });
  };

  /** 从托盘移除颜色（保留各组模式；全空也保持筛选对象，模式可预设） */
  const removeColor = (tray: ColorTrayKey, hex: string) => {
    const cur = colorFilter ?? EMPTY_FILTER;
    setColorFilter({
      ...cur,
      [tray]: {
        ...cur[tray],
        colors: cur[tray].colors.filter((c) => c !== hex),
      },
    });
  };

  /** 清空单个托盘（保留各组模式；全空也保持筛选对象，模式可预设） */
  const clearTray = (tray: ColorTrayKey) => {
    const cur = colorFilter ?? EMPTY_FILTER;
    setColorFilter({
      ...cur,
      [tray]: { ...cur[tray], colors: [] },
    });
  };

  /** 拖拽移动：源托盘移除、目标托盘追加（目标已含同色则只移除）；同托盘忽略 */
  const moveColor = (from: ColorTrayKey, to: ColorTrayKey, hex: string) => {
    if (!colorFilter || from === to) return;
    setColorFilter({
      ...colorFilter,
      [from]: {
        ...colorFilter[from],
        colors: colorFilter[from].colors.filter((c) => c !== hex),
      },
      [to]: {
        ...colorFilter[to],
        colors: colorFilter[to].colors.includes(hex)
          ? colorFilter[to].colors
          : [...colorFilter[to].colors, hex],
      },
    });
  };

  /** 托盘组内逻辑：无取色时也记录模式（先定逻辑后取色） */
  const setTrayMode = (tray: ColorTrayKey, mode: "and" | "or") => {
    const cur = colorFilter ?? EMPTY_FILTER;
    setColorFilter({
      ...cur,
      [tray]: { ...cur[tray], mode },
    });
  };

  /** 三托盘组间逻辑：无取色时也记录模式 */
  const setGlobalMode = (mode: "and" | "or") =>
    setColorFilter({ ...(colorFilter ?? EMPTY_FILTER), mode });

  return (
    <div
      className={"lib-filter__layer" + (leaving ? " is-leaving" : "")}
      onClick={() => setFilterOpen(false)}
    >
      <div className="lib-filter" onClick={(e) => e.stopPropagation()}>
        <TagCloud />

        <section className="lib-filter__section">
          <header className="lib-filter__section-head">
            <span className="lib-filter__section-title">明度</span>
          </header>
          <div className="lib-filter__chips">
            {TONE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={
                  "lib-tagcloud__chip" +
                  (toneFilter.includes(opt.value) ? " is-active" : "")
                }
                aria-pressed={toneFilter.includes(opt.value)}
                onClick={() => setToneFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        <section className="lib-filter__section">
          <header className="lib-filter__section-head">
            <span className="lib-filter__section-title">冷暖</span>
          </header>
          <div className="lib-filter__chips">
            {WARMTH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={
                  "lib-tagcloud__chip" +
                  (warmthFilter.includes(opt.value) ? " is-active" : "")
                }
                aria-pressed={warmthFilter.includes(opt.value)}
                onClick={() => setWarmthFilter(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </section>

        <section className="lib-filter__section">
          <header className="lib-filter__section-head">
            <span className="lib-filter__section-title">取色搜索</span>
            <div className="lib-filter__seg" role="group" aria-label="取色托盘间匹配方式">
              <button
                type="button"
                className={(colorFilter?.mode ?? "and") === "and" ? "is-active" : ""}
                aria-pressed={(colorFilter?.mode ?? "and") === "and"}
                onClick={() => setGlobalMode("and")}
              >
                AND
              </button>
              <button
                type="button"
                className={(colorFilter?.mode ?? "and") === "or" ? "is-active" : ""}
                aria-pressed={(colorFilter?.mode ?? "and") === "or"}
                onClick={() => setGlobalMode("or")}
              >
                OR
              </button>
            </div>
          </header>
          <div className="lib-filter__color-trays">
            {COLOR_TRAYS.map((tray) => {
              const group = colorFilter?.[tray.key] ?? EMPTY_FILTER[tray.key];
              return (
                <div key={tray.key} className="lib-filter__color-tray-row">
                  <span className="lib-filter__color-tray-label">{tray.label}</span>
                  <div
                    className="lib-filter__seg lib-filter__seg--mini"
                    role="group"
                    aria-label={`${tray.label}托盘内匹配方式`}
                  >
                    <button
                      type="button"
                      className={group.mode === "and" ? "is-active" : ""}
                      aria-pressed={group.mode === "and"}
                      onClick={() => setTrayMode(tray.key, "and")}
                    >
                      AND
                    </button>
                    <button
                      type="button"
                      className={group.mode === "or" ? "is-active" : ""}
                      aria-pressed={group.mode === "or"}
                      onClick={() => setTrayMode(tray.key, "or")}
                    >
                      OR
                    </button>
                  </div>
                  <div
                    className={
                      "lib-filter__color-tray" +
                      (dragOver === tray.key ? " is-over" : "") +
                      (group.colors.length === 0 ? " is-empty" : "")
                    }
                    onDragOver={(e) => {
                      if (!drag) return;
                      e.preventDefault();
                      setDragOver(tray.key);
                    }}
                    onDragLeave={() =>
                      setDragOver((cur) => (cur === tray.key ? null : cur))
                    }
                    onDrop={(e) => {
                      e.preventDefault();
                      if (drag) moveColor(drag.from, tray.key, drag.hex);
                      setDrag(null);
                      setDragOver(null);
                    }}
                  >
                    {group.colors.map((hex) => (
                      <span
                        key={hex}
                        className="lib-filter__color-chip"
                        draggable
                        title={`${hex} · 拖到取色行/高光/阴影托盘`}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", hex);
                          e.dataTransfer.effectAllowed = "move";
                          setDrag({ from: tray.key, hex });
                        }}
                        onDragEnd={() => {
                          setDrag(null);
                          setDragOver(null);
                        }}
                      >
                        <span
                          className="lib-filter__color-chip-swatch"
                          style={{ background: hex }}
                          aria-hidden="true"
                        />
                        <span className="lib-filter__color-chip-hex">{hex}</span>
                        <button
                          type="button"
                          className="lib-filter__color-chip-remove"
                          aria-label={`移除 ${hex}`}
                          onClick={() => removeColor(tray.key, hex)}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {group.colors.length === 0 && (
                      <span className="lib-filter__color-tray-empty">未取色</span>
                    )}
                    <ColorAddInput
                      label={tray.label}
                      tray={tray.key}
                      onAdd={addColor}
                    />
                    {group.colors.length > 0 && (
                      <button
                        type="button"
                        className="lib-filter__color-tray-clear"
                        aria-label={`清空${tray.label}`}
                        onClick={() => clearTray(tray.key)}
                      >
                        清空
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <button
          type="button"
          className="lib-filter__clear-all"
          onClick={clearSearchAndFilters}
        >
          清空全部
        </button>
      </div>
    </div>
  );
}
