/**
 * M3 文件夹树左侧浮层（2026-10-17 用户需求）：原先挤在「高级筛选」浮层里的文件夹树
 * 整段迁出来，改成贴左缘的自动浮层。
 *
 * 弹出：指针贴在左侧细长条（EDGE_STRIP_PX）内**静止** DWELL_MS；这段时间里不能有鼠标
 * 操作——移动超过 STILL_TOLERANCE_PX、滚轮、按下、按键都会把计时清零。
 * 收起：指针离开浮层范围（LEAVE_GRACE_MS 宽限，够从边缘斜着挪进来）、在浮层外点击 /
 * 滚动、按 Esc、焦点移出浮层。收起后工具栏上的文件夹 chip（SearchBar）仍显示当前限定，
 * 点它可再次打开本浮层。
 *
 * 树的口径与原「高级筛选 → 文件夹」逐条一致：`items[].relPath` 建树（useMemo）、
 * 每行「目录名 ×N」（N = 该目录递归文件数）、单选 `folderScope`（再点同目录取消）、
 * 首行「全部」、默认折叠、行首三角展开。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LibraryIndexItem } from "../index/indexFile";
import { splitActionState } from "../index/splitFolder";
import { useLibraryStore } from "../store";

/** 贴边触发条的宽度（px）：左侧这么窄的一条竖带才算「贴边」。
 *  12 → 24 → 20px（2026-10-17 用户两次要求），20px = `.lib-page` 的 16px 内边距 + 内容最左 4px */
const EDGE_STRIP_PX = 20;
/** 静止时长（ms）：期间任何滚动 / 移动都会把计时清零。1000 → 600 → 300ms（2026-10-17 用户
 *  三次试用后的口径）；进度动画时长由本常量内联注入，不再在 CSS 里另写一份 */
const DWELL_MS = 300;
/** 静止容差（px）：手抖 1–3px 不算移动，超过即重新计时 */
const STILL_TOLERANCE_PX = 3;
/** 指针离开浮层后的宽限（ms）：够斜着退回浮层，又不至于赖着不收 */
const LEAVE_GRACE_MS = 260;
/** 收起动画时长（ms）：与玻璃浮层惯例一致，播完再卸载 */
const LEAVE_ANIM_MS = 200;
/** 收起后的静默期（ms）：避免「点关闭 / 刚走开 → 仍贴边 → 0.3 秒后又弹」 */
const REOPEN_COOLDOWN_MS = 700;

interface FolderNode {
  name: string;
  path: string;
  count: number;
  children: FolderNode[];
}

function buildFolderTree(items: LibraryIndexItem[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const map = new Map<string, FolderNode>();
  for (const item of items) {
    const parts = item.relPath.split("/");
    parts.pop(); // 末段是文件名
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let node = map.get(path);
      if (!node) {
        node = { name: part, path, count: 0, children: [] };
        map.set(path, node);
        if (path === part) {
          roots.push(node);
        } else {
          map.get(path.slice(0, path.lastIndexOf("/")))?.children.push(node);
        }
      }
      node.count += 1;
    }
  }
  return roots;
}

function FolderNodeRow({
  node,
  depth,
  expandedSet,
  folderScope,
  onTogglePath,
  onSelect,
}: {
  node: FolderNode;
  depth: number;
  expandedSet: Set<string>;
  folderScope: string | null;
  onTogglePath: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  return (
    <>
      <div
        className="lib-folderdrawer__row"
        style={{ paddingLeft: depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="lib-folderdrawer__caret"
            aria-label={expandedSet.has(node.path) ? "折叠" : "展开"}
            onClick={() => onTogglePath(node.path)}
          >
            {expandedSet.has(node.path) ? "▾" : "▸"}
          </button>
        ) : (
          <span className="lib-folderdrawer__caret lib-folderdrawer__caret--empty" />
        )}
        <button
          type="button"
          className={
            "lib-folderdrawer__name" +
            (folderScope === node.path ? " is-active" : "")
          }
          title={node.path}
          onClick={() => onSelect(node.path)}
        >
          {node.name} ×{node.count}
        </button>
      </div>
      {expandedSet.has(node.path) &&
        node.children.map((child) => (
          <FolderNodeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            expandedSet={expandedSet}
            folderScope={folderScope}
            onTogglePath={onTogglePath}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

export function FolderDrawer() {
  const open = useLibraryStore((s) => s.folderDrawerOpen);
  const setOpen = useLibraryStore((s) => s.setFolderDrawerOpen);
  const items = useLibraryStore((s) => s.items);
  const folderScope = useLibraryStore((s) => s.folderScope);
  const setFolderScope = useLibraryStore((s) => s.setFolderScope);
  const scanRunning = useLibraryStore((s) => s.scan.running);
  const splittingTarget = useLibraryStore((s) => s.splittingTarget);
  const splitFolderToLibrary = useLibraryStore((s) => s.splitFolderToLibrary);
  /** 别的浮层开着时不自动弹出（免得两层玻璃叠一起，或盖住设置 / 详情 / 批量确认） */
  const blocked = useLibraryStore(
    (s) =>
      s.filterOpen ||
      s.settingsOpen ||
      s.detailId != null ||
      s.visionBatchRequest != null,
  );

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [arming, setArming] = useState(false);
  /** 每次（重新）开始计时递增：当成进度条的 key，逼它重挂载、动画从 0 重来 */
  const [armNonce, setArmNonce] = useState(0);
  const [mounted, setMounted] = useState(open);
  const [leaving, setLeaving] = useState(false);

  const gripRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** 触发条范围取自本模块自己的滚动容器（.lib-page），不硬编码顶栏高度 */
  const hostRef = useRef<Element | null>(null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<{ x: number; y: number } | null>(null);
  const armingRef = useRef(false);
  /** 本次展开是否由用户主动点开（键盘/点击）：是则把焦点移进浮层，纯悬停弹出不动焦点 */
  const openedByUserRef = useRef(false);
  /**
   * 最近一次交互是否来自鼠标（true）。收起时只给**键盘用户**把焦点还回抓手——
   * 鼠标用户点完就还焦点的话，抓手会亮起焦点环（2026-11-19 用户反馈「点一下左侧文件数
   * 按钮冒出个选中框」）；CSS 侧已把环改成 4px 胶囊的细描边，这里再掐掉「根本不该有」。
   */
  const pointerInputRef = useRef(false);
  /** 静默期截止时间（performance.now 口径） */
  const readyAtRef = useRef(0);
  /** 是否已经展开过一次：首次挂载不进静默期（页面刚打开就该能贴边弹出） */
  const everOpenedRef = useRef(false);

  const tree = useMemo(() => buildFolderTree(items), [items]);

  /** 底部「拆分为独立图库…」的可见/禁用口径（纯函数在 splitFolder.ts，可单测） */
  const splitAction = splitActionState({
    folderScope,
    treeEmpty: tree.length === 0,
    scanRunning,
    splitting: splittingTarget != null,
  });

  /** 计时态只在真变化时写 state：指针在页面里频繁移动，不要每帧重渲染
   *  （进度动画的 key 只在真正重新计时的那些事件上递增） */
  const markArming = useCallback((value: boolean) => {
    if (armingRef.current === value) return;
    armingRef.current = value;
    setArming(value);
  }, []);

  const cancelDwell = useCallback(() => {
    if (dwellTimer.current) {
      clearTimeout(dwellTimer.current);
      dwellTimer.current = null;
    }
    // 计时一停，静止基准点就作废：留着旧点的话，指针回到原位（≤3px 容差内）永远
    // 重新计不了时，浮层也就再也弹不出来（收起后回到原处最容易踩到）
    anchorRef.current = null;
    markArming(false);
  }, [markArming]);

  const cancelLeave = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }, []);

  /** 开始 / 续上「静止计时」（已展开、被别的浮层挡着、静默期内都不计） */
  const scheduleDwell = useCallback(() => {
    if (open || blocked) {
      cancelDwell();
      return;
    }
    if (performance.now() < readyAtRef.current) {
      // 静默期内不重新计时，顺手把计时态清干净（防「看着还在跑」的残留）
      cancelDwell();
      return;
    }
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    markArming(true);
    // 计时重来 → 进度动画也重来：只重置 JS 定时器的话，CSS 动画会自己跑满并停在
    // 100%（forwards），出现「条已顶满但浮层不弹」的假进度
    setArmNonce((n) => n + 1);
    dwellTimer.current = setTimeout(() => {
      dwellTimer.current = null;
      markArming(false);
      setOpen(true);
    }, DWELL_MS);
  }, [open, blocked, cancelDwell, markArming, setOpen]);

  /** 收起（Esc / 点别处 / 滚别处 / 指针离开）：焦点在浮层里的话先还给抓手，免得掉到 body */
  const close = useCallback(() => {
    cancelDwell();
    cancelLeave();
    const panel = panelRef.current;
    // 只在键盘交互后把焦点还给抓手（焦点不能落到 body）；鼠标收起就让它自然消失
    if (panel && panel.contains(document.activeElement) && !pointerInputRef.current) {
      gripRef.current?.focus({ preventScroll: true });
    }
    setOpen(false);
  }, [cancelDwell, cancelLeave, setOpen]);

  // 全局指针 / 滚轮 / 滚动 / 按键监听：贴边静置计时 + 各种收起判定。
  // 不能只挂在触发条 DOM 上——左缘那一条在应用壳的左侧热区（56px，z-index 19）下面，
  // 自己收不到指针事件；监听挂 window 上等于覆盖整页，也无须拦事件。
  useEffect(() => {
    const hostRect = () => {
      const host = hostRef.current ?? gripRef.current?.closest(".lib-page") ?? null;
      hostRef.current = host;
      return host ? host.getBoundingClientRect() : null;
    };
    const inStrip = (clientX: number, clientY: number) => {
      if (clientX > EDGE_STRIP_PX) return false; // 快路径：绝大多数移动事件在这里就走
      const rect = hostRect();
      if (!rect) return false;
      return clientY >= rect.top && clientY <= rect.bottom;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      if (open) {
        // 已展开：用矩形判断在不在浮层范围内。不用 pointerleave——指针可能正停在浮层
        // 左缘的抓手上（抓手不在浮层 DOM 里），从那里直接甩出去不会触发浮层的 leave。
        const panel = panelRef.current;
        if (!panel) return;
        const rect = panel.getBoundingClientRect();
        const inside =
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom;
        if (inside) {
          cancelLeave();
        } else if (!leaveTimer.current) {
          leaveTimer.current = setTimeout(() => {
            leaveTimer.current = null;
            close();
          }, LEAVE_GRACE_MS);
        }
        return;
      }
      if (!inStrip(e.clientX, e.clientY)) {
        cancelDwell(); // 连带清掉静止基准点
        return;
      }
      const anchor = anchorRef.current;
      if (!anchor) {
        anchorRef.current = { x: e.clientX, y: e.clientY };
        scheduleDwell();
        return;
      }
      // 动了就重新计时（用户口径：这段静止时间里不能有移动）
      if (
        Math.abs(e.clientX - anchor.x) > STILL_TOLERANCE_PX ||
        Math.abs(e.clientY - anchor.y) > STILL_TOLERANCE_PX
      ) {
        anchorRef.current = { x: e.clientX, y: e.clientY };
        scheduleDwell();
      }
    };

    const onWheel = (e: WheelEvent) => {
      // 浮层内部的滚动（树太长）不算「别的操作」，别把它当成收起信号
      if (panelRef.current?.contains(e.target as Node)) return;
      if (open) {
        close();
        return;
      }
      // 贴边滚动：计时清零（滚完还停在条内就从这一刻重新数 DWELL_MS）
      if (inStrip(e.clientX, e.clientY)) {
        anchorRef.current = { x: e.clientX, y: e.clientY };
        scheduleDwell();
      } else {
        cancelDwell();
      }
    };

    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (open) close();
      else cancelDwell();
    };

    const onDown = (e: PointerEvent) => {
      pointerInputRef.current = true;
      cancelDwell(); // 按下即重新计时（连带清掉静止基准点）
      if (!open) return;
      const target = e.target as Node | null;
      if (!target) return;
      if (
        panelRef.current?.contains(target) ||
        gripRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };

    const onKey = (e: KeyboardEvent) => {
      pointerInputRef.current = false;
      if (e.key === "Escape" && open) {
        e.stopPropagation();
        close();
        return;
      }
      if (!open) cancelDwell(); // 打字等按键同样算「有操作」
    };

    const onWindowBlur = () => {
      if (open) close();
      else cancelDwell();
    };

    window.addEventListener("pointermove", onMove);
    // 捕获阶段：先于页面里的点击处理（点浮层外要立刻收，不等页面自己的逻辑）
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    document.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
      document.removeEventListener("scroll", onScroll, true);
    };
  }, [open, cancelDwell, cancelLeave, scheduleDwell, close]);

  // 进出场编排（口径同 FilterBar / BatchPanel：进入立即挂载，退出播完收回动画再卸载）
  useEffect(() => {
    if (open) {
      if (unmountTimer.current) {
        clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
      setMounted(true);
      setLeaving(false);
      return;
    }
    if (!mounted) return;
    setLeaving(true);
    unmountTimer.current = setTimeout(() => {
      unmountTimer.current = null;
      setLeaving(false);
      setMounted(false);
    }, LEAVE_ANIM_MS);
    return () => {
      if (unmountTimer.current) {
        clearTimeout(unmountTimer.current);
        unmountTimer.current = null;
      }
    };
  }, [open, mounted]);

  // 每次**收起**进入静默期，避免「刚收起就原地又弹」；首次挂载不算收起
  useEffect(() => {
    if (open) {
      everOpenedRef.current = true;
      return;
    }
    if (!everOpenedRef.current) return;
    readyAtRef.current = performance.now() + REOPEN_COOLDOWN_MS;
  }, [open]);

  // 用户主动点开时把焦点移进浮层（纯悬停弹出不动焦点，否则会打断用户当前操作）
  useEffect(() => {
    if (!open || !mounted) return;
    if (!openedByUserRef.current) return;
    openedByUserRef.current = false;
    panelRef.current?.focus({ preventScroll: true });
  }, [open, mounted]);

  // 组件卸载时清掉所有在途计时器
  useEffect(
    () => () => {
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
      if (leaveTimer.current) clearTimeout(leaveTimer.current);
      if (unmountTimer.current) clearTimeout(unmountTimer.current);
    },
    [],
  );

  const toggleExpanded = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const pickScope = (path: string | null) =>
    setFolderScope(path !== null && folderScope === path ? null : path);

  /**
   * 拆分入口：先收起浮层再弹公共确认框（确认期间浮层不该开着，移开鼠标也不该把它关掉），
   * 快照/计数/复核/写入全部由 store.splitFolderToLibrary 负责——本层只传目标目录。
   */
  const onSplit = () => {
    if (folderScope == null || splitAction.disabled) return;
    const target = folderScope;
    close();
    void splitFolderToLibrary(target);
  };

  return (
    <>
      {/* 贴边抓手：左缘细条上的可见提示（悬停变亮、计时进度向上填充），
          也是键盘用户与纯点击用户的开入口；浮层展开期间让位给浮层 */}
      <button
        ref={gripRef}
        type="button"
        className={
          "lib-folderdrawer__grip" +
          (arming ? " is-arming" : "") +
          (open ? " is-open" : "") +
          (folderScope != null ? " is-active" : "")
        }
        title={
          folderScope != null
            ? `文件夹筛选：${folderScope}（点开，或鼠标贴左缘静止 ${DWELL_MS / 1000} 秒）`
            : `文件夹：鼠标贴左缘静止 ${DWELL_MS / 1000} 秒弹出（点击也可）`
        }
        aria-label="文件夹筛选"
        aria-expanded={open}
        aria-controls="lib-folderdrawer"
        onClick={() => {
          openedByUserRef.current = true;
          setOpen(!open);
        }}
      >
        <span className="lib-folderdrawer__grip-track" aria-hidden="true">
          {/* 时长由 DWELL_MS 内联注入：JS 定时器与 CSS 进度动画只会有一个真值 */}
          <span
            key={armNonce}
            className="lib-folderdrawer__grip-fill"
            style={{ animationDuration: `${DWELL_MS}ms` }}
          />
        </span>
      </button>
      {mounted && (
        <div
          id="lib-folderdrawer"
          ref={panelRef}
          tabIndex={-1}
          role="region"
          aria-label="文件夹筛选"
          className={"lib-folderdrawer" + (leaving ? " is-leaving" : "")}
          onBlur={(e) => {
            // 焦点真的挪到浮层外才收（挪到 body 的空 focus 不算，交给指针规则判定）
            const next = e.relatedTarget as Node | null;
            if (next && !e.currentTarget.contains(next)) close();
          }}
        >
          <header className="lib-folderdrawer__head">
            <span className="lib-folderdrawer__title">文件夹</span>
            <button
              type="button"
              className="lib-folderdrawer__close"
              aria-label="收起文件夹浮层"
              onClick={close}
            >
              ×
            </button>
          </header>
          <div className="lib-folderdrawer__body">
            <div className="lib-folderdrawer__row">
              <span className="lib-folderdrawer__caret lib-folderdrawer__caret--empty" />
              <button
                type="button"
                className={
                  "lib-folderdrawer__name" +
                  (folderScope === null ? " is-active" : "")
                }
                onClick={() => setFolderScope(null)}
              >
                全部 ×{items.length}
              </button>
            </div>
            {tree.map((node) => (
              <FolderNodeRow
                key={node.path}
                node={node}
                depth={0}
                expandedSet={expanded}
                folderScope={folderScope}
                onTogglePath={toggleExpanded}
                onSelect={pickScope}
              />
            ))}
            {tree.length === 0 && (
              <p className="lib-folderdrawer__empty">
                这个图库还没有子文件夹（图片都在根目录）
              </p>
            )}
          </div>
          <footer className="lib-folderdrawer__foot">
            {folderScope != null ? (
              <div className="lib-folderdrawer__actions">
                <button
                  type="button"
                  className="lib-folderdrawer__clear"
                  onClick={() => setFolderScope(null)}
                >
                  清除文件夹筛选
                </button>
                {splitAction.visible && (
                  <button
                    type="button"
                    className="lib-folderdrawer__split"
                    disabled={splitAction.disabled}
                    title={
                      splitAction.disabled
                        ? splitAction.hint
                        : `把「${folderScope}」及其子目录生成独立图库索引（不动原图）`
                    }
                    onClick={onSplit}
                  >
                    拆分为独立图库…
                  </button>
                )}
              </div>
            ) : (
              <span className="lib-folderdrawer__hint">移开鼠标即收起</span>
            )}
            {folderScope != null && splitAction.hint !== "" && (
              <p className="lib-folderdrawer__hint">{splitAction.hint}</p>
            )}
          </footer>
        </div>
      )}
    </>
  );
}
