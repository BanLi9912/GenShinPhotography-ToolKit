/**
 * M3.4 tag 云（FilterBar 内嵌）：当前图库 tag 图数统计前 30，
 * 点选进 activeTags（多选 AND/OR 由头部段控件切换）。
 */
import { useMemo } from "react";
import { useLibraryStore } from "../store";

const TOP_LIMIT = 30;

export function TagCloud() {
  const items = useLibraryStore((s) => s.items);
  const activeTags = useLibraryStore((s) => s.activeTags);
  const toggleActiveTag = useLibraryStore((s) => s.toggleActiveTag);
  const tagMode = useLibraryStore((s) => s.tagMode);
  const setTagMode = useLibraryStore((s) => s.setTagMode);

  const top = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const t of item.tags) {
        counts.set(t.text, (counts.get(t.text) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, TOP_LIMIT);
  }, [items]);

  return (
    <section className="lib-filter__section">
      <header className="lib-filter__section-head">
        <span className="lib-filter__section-title">标签</span>
        <div className="lib-filter__seg" role="group" aria-label="标签匹配方式">
          <button
            type="button"
            className={tagMode === "and" ? "is-active" : ""}
            aria-pressed={tagMode === "and"}
            onClick={() => setTagMode("and")}
          >
            AND
          </button>
          <button
            type="button"
            className={tagMode === "or" ? "is-active" : ""}
            aria-pressed={tagMode === "or"}
            onClick={() => setTagMode("or")}
          >
            OR
          </button>
        </div>
      </header>
      <div className="lib-tagcloud">
        {top.map(([text, count]) => (
          <button
            key={text}
            type="button"
            className={
              "lib-tagcloud__chip" + (activeTags.includes(text) ? " is-active" : "")
            }
            aria-pressed={activeTags.includes(text)}
            onClick={() => toggleActiveTag(text)}
          >
            {text} ×{count}
          </button>
        ))}
      </div>
    </section>
  );
}
