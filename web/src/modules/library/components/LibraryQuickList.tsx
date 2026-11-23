/**
 * PR-005 · 无工具栏页面的常驻库列表：空态（unbound）/ missing /
 * need-permission 三页复用，列出注册表里除当前库外的其他图库，一键切库。
 * missing / need-permission 页的核心价值 = 逃生通道（此前必须先「移除绑定」）。
 *
 * - 数据源 = idb 注册表摘要（能直接打开的库）；不接 Node 路径表、不显示路径。
 * - 排除当前库：switchTo 对同库静默早退（store.ts），坏库行会「点了没反应」。
 * - itemCount 为 null（读不到 meta）时显示「— 张」，不显示 0：「空库」与
 *   「读不到」不可混淆（PR-005 裁定）。
 * - 可选 onRemove 槽位：仅空态页（库管理面）传入；missing / need-permission
 *   不传——破坏性操作不随「选择器」扩散到错误页。
 * - 预留「不可用行态」（灰 + 说明文案 + 次要动作位）：将来接 Node 路径表时
 *   再实现（PR-005 裁定：本轮不做 queryPermission 可达性预判，不写占位代码）。
 */
import { useLibraryStore } from "../store";
import type { LibrarySummary } from "../index/binding";

/**
 * 相对时间五档（PR-005 定稿）：刚刚 <1 分 / N 分钟前 <1 小时 / N 小时前 <1 天 /
 * N 天前 ≤30 天 / 更早 MM-DD（超过一年 YYYY-MM-DD，防丢年份）。
 */
function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  if (diff < MIN) return "刚刚";
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff <= 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
  const d = new Date(ts);
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
  return diff > 365 * DAY ? `${d.getFullYear()}-${md}` : md;
}

export function LibraryQuickList({
  onRemove,
}: {
  onRemove?: (lib: LibrarySummary) => void;
}) {
  const libraries = useLibraryStore((s) => s.libraries);
  const current = useLibraryStore((s) => s.current);
  const switchTo = useLibraryStore((s) => s.switchTo);

  const others = libraries
    .filter((lib) => lib.libraryId !== current?.libraryId)
    .sort(
      (a, b) => b.lastOpenedAt - a.lastOpenedAt || b.createdAt - a.createdAt,
    );
  if (others.length === 0) return null;

  return (
    <div className="lib-registry">
      <div className="lib-registry__title">其他图库</div>
      {others.map((lib) => (
        <div key={lib.libraryId} className="lib-registry__row">
          <div className="lib-registry__info">
            <span className="lib-registry__name">{lib.name}</span>
            <span className="lib-registry__count">
              {lib.itemCount === null ? "—" : lib.itemCount} 张 ·{" "}
              {formatRelativeTime(lib.lastOpenedAt)}
            </span>
          </div>
          <div className="lib-registry__actions">
            <button type="button" onClick={() => void switchTo(lib.libraryId)}>
              打开
            </button>
            {onRemove && (
              <button
                type="button"
                className="lib-registry__danger"
                onClick={() => onRemove(lib)}
              >
                移除
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
