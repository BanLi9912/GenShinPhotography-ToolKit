/**
 * M3.4 搜索行（悬浮工具栏岛第二行）：搜索框 + 150ms 防抖、补全下拉
 * （历史 + tag 语料）、标星筛选按钮、温度滑杆（0–5，档名点击循环
 * 精准→平衡→联想）、高级筛选按钮。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "../../../ui/toast";
import { extractImageQueryFeatures } from "../search/imageQuery";
import { getSuggestions, pushHistory } from "../search/suggest";
import { useLibraryStore } from "../store";

const TEMP_LABEL = ["精准", "精准", "平衡", "平衡", "联想", "联想"];
const TEMP_CYCLE = [0, 3, 5];

export function SearchBar() {
  const items = useLibraryStore((s) => s.items);
  const searchQuery = useLibraryStore((s) => s.searchQuery);
  const setSearchQuery = useLibraryStore((s) => s.setSearchQuery);
  const imageQuery = useLibraryStore((s) => s.imageQuery);
  const clearImageQuery = useLibraryStore((s) => s.clearImageQuery);
  const temperature = useLibraryStore((s) => s.temperature);
  const setTemperature = useLibraryStore((s) => s.setTemperature);
  const filterOpen = useLibraryStore((s) => s.filterOpen);
  const setFilterOpen = useLibraryStore((s) => s.setFilterOpen);
  const setSearchFocused = useLibraryStore((s) => s.setSearchFocused);
  const starredOnly = useLibraryStore((s) => s.starredOnly);
  const setStarredOnly = useLibraryStore((s) => s.setStarredOnly);
  const [text, setText] = useState(searchQuery);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** 补全下拉定位基准（portal 挂 body，脱离工具栏 Backdrop Root，磨砂才对页面生效） */
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const suggestRef = useRef<HTMLUListElement | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const lastSentRef = useRef(searchQuery);
  /** 下拉进场/收回动画：进入立即挂载（下拉），退出先播收回动画再卸载 */
  const [suggestMounted, setSuggestMounted] = useState(false);
  const [suggestLeaving, setSuggestLeaving] = useState(false);
  const suggestLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 150ms 防抖写 store（Enter/点选走 commit 立即提交）
  // 〔2026-09-24 以图搜图〕粘贴图片时 store 会清空 searchQuery，但本 effect 的定时器
  // 可能还挂着「粘贴前刚敲的文本」——150ms 内粘贴会把它写回 store（输入框里残留旧文本，
  // 与图片态并存）。图片态下不许再写文本；搜索框跟随清空走下方 store→输入框同步 effect。
  useEffect(() => {
    const timer = setTimeout(() => {
      if (useLibraryStore.getState().imageQuery) return;
      lastSentRef.current = text;
      setSearchQuery(text);
    }, 150);
    return () => clearTimeout(timer);
  }, [text, setSearchQuery]);

  // store 被外部清空/复位时同步输入框（区别于防抖发送）
  useEffect(() => {
    if (lastSentRef.current === searchQuery) return;
    lastSentRef.current = searchQuery;
    setText(searchQuery);
  }, [searchQuery]);

  const suggestions = useMemo(() => getSuggestions(text, items), [text, items]);
  const showSuggest = open && suggestions.length > 0;

  // 下拉进出场编排（口径同 FilterBar：进入立即挂载，退出播完收回动画再卸载）
  useEffect(() => {
    if (showSuggest) {
      if (suggestLeaveTimer.current) {
        clearTimeout(suggestLeaveTimer.current);
        suggestLeaveTimer.current = null;
      }
      setSuggestMounted(true);
      setSuggestLeaving(false);
      return;
    }
    if (!suggestMounted) return;
    setSuggestLeaving(true);
    suggestLeaveTimer.current = setTimeout(() => {
      suggestLeaveTimer.current = null;
      setSuggestMounted(false);
      setSuggestLeaving(false);
    }, 200);
    return () => {
      if (suggestLeaveTimer.current) {
        clearTimeout(suggestLeaveTimer.current);
        suggestLeaveTimer.current = null;
      }
    };
  }, [showSuggest, suggestMounted]);

  // 下拉打开/输入变化时测量输入框视口位置（portal 固定定位用）。
  // 工具栏 fit-content 会随字体加载/内容变化晚到重排，故 rAF + 250ms 定时 + 字体就绪三重重测
  // （位置无变化时保持同一 rect 引用，避免无谓重渲染）
  useLayoutEffect(() => {
    if (!open || suggestions.length === 0) return;
    const measure = () => {
      const el = fieldRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect((prev) =>
        prev &&
        Math.abs(prev.left - r.left) < 1 &&
        Math.abs(prev.top - r.top) < 1 &&
        Math.abs(prev.width - r.width) < 1
          ? prev
          : r,
      );
    };
    measure();
    const raf = requestAnimationFrame(measure);
    const interval = window.setInterval(measure, 250);
    document.fonts?.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(interval);
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [open, suggestions.length, text]);

  // 点击外部关闭补全（下拉经 portal 挂 body，须同时排除下拉自身）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (suggestRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  /** 提交搜索：立即写 store + 历史（空串不入） */
  const commit = (value: string) => {
    const trimmed = value.trim();
    lastSentRef.current = trimmed;
    setText(trimmed);
    setSearchQuery(trimmed);
    pushHistory(trimmed);
    setOpen(false);
  };

  const cycleTemp = () => {
    const idx = TEMP_CYCLE.indexOf(temperature);
    setTemperature(idx < 0 ? TEMP_CYCLE[0] : TEMP_CYCLE[(idx + 1) % TEMP_CYCLE.length]);
  };

  return (
    <div className="lib-search" ref={wrapRef}>
      <div className="lib-search__field" ref={fieldRef}>
        {imageQuery && (
          <span className="lib-search__img-chip" title="以图搜图中：点击 × 退出">
            <img src={imageQuery.url} alt="搜索用图片" draggable={false} />
          </span>
        )}
        <input
          className="lib-search__input"
          type="text"
          value={text}
          placeholder={
            imageQuery ? "以图搜图：正在找最相似的图片" : "搜索：输入一段描述，或文件名"
          }
          aria-label="搜索"
          aria-expanded={open && suggestions.length > 0}
          aria-activedescendant={
            open && suggestions.length > 0 ? `lib-suggest-${active}` : undefined
          }
          onFocus={() => {
            setOpen(true);
            setSearchFocused(true);
          }}
          onBlur={() => setSearchFocused(false)}
          onPaste={(e) => {
            const imgItem = Array.from(e.clipboardData.items).find((it) =>
              it.type.startsWith("image/"),
            );
            if (!imgItem) return; // 普通文本粘贴走默认行为
            e.preventDefault();
            const file = imgItem.getAsFile();
            if (!file) return;
            void extractImageQueryFeatures(file)
              .then(({ patch, url }) => {
                useLibraryStore.getState().setImageQuery(patch, url);
                // 输入框立即清空：store 的 searchQuery 被清后，防抖 effect 已不会回写文本，
                // 本地 text 必须同步清掉，否则「输入框还显示着字、其实已在图片态」的假态
                setText("");
                setOpen(false);
              })
              .catch((err) => {
                console.warn("[library] 以图搜图特征提取失败", err);
                toast("图片读取失败，请换一张试试");
              });
          }}
          onChange={(e) => {
            setText(e.target.value);
            // 互斥：输入文本即退出图片搜索（清空输入不触发，保留图片态）
            if (e.target.value !== "" && useLibraryStore.getState().imageQuery) {
              clearImageQuery();
            }
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(suggestions.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const pick =
                open && suggestions.length > 0
                  ? suggestions[Math.min(active, suggestions.length - 1)]
                  : text;
              commit(pick);
            } else if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
        {text || imageQuery ? (
          <button
            type="button"
            className="lib-search__clear"
            aria-label={imageQuery ? "退出图片搜索" : "清空搜索"}
            onClick={() => {
              if (imageQuery) {
                clearImageQuery();
                return;
              }
              commit("");
            }}
          >
            ×
          </button>
        ) : null}
        {suggestMounted && rect != null &&
          createPortal(
            <ul
              ref={suggestRef}
              className={
                "lib-search__suggest" + (suggestLeaving ? " is-leaving" : "")
              }
              role="listbox"
              style={{
                top: rect.bottom + 4,
                left: rect.left,
                width: rect.width,
              }}
            >
              {suggestions.map((s, i) => (
                <li
                  key={s}
                  id={`lib-suggest-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={
                    "lib-search__suggest-item" + (i === active ? " is-active" : "")
                  }
                  onMouseEnter={() => setActive(i)}
                  onClick={() => commit(s)}
                >
                  {s}
                </li>
              ))}
            </ul>,
            document.body,
          )}
      </div>
      <button
        type="button"
        className={"lib-search__star" + (starredOnly ? " is-active" : "")}
        aria-pressed={starredOnly}
        aria-label="筛选标星"
        title="只看标星的图片"
        onClick={() => setStarredOnly(!starredOnly)}
      >
        ★
      </button>
      <div className="lib-search__temp">
        <input
          type="range"
          min={0}
          max={5}
          step={1}
          value={temperature}
          title={`温度 ${temperature} · ${TEMP_LABEL[temperature]}`}
          aria-label="搜索温度"
          onChange={(e) => setTemperature(Number(e.target.value))}
        />
        <button
          type="button"
          className="lib-search__temp-label"
          title="点击循环 精准→平衡→联想"
          onClick={cycleTemp}
        >
          {TEMP_LABEL[temperature]}
        </button>
      </div>
      <button
        type="button"
        className={"lib-toolbar__btn" + (filterOpen ? " lib-toolbar__btn--primary" : "")}
        onClick={() => setFilterOpen(!filterOpen)}
      >
        高级筛选
      </button>
    </div>
  );
}
