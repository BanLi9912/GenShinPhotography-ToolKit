import { useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  exportBoardFile,
  exportBoardPng,
  HistoryPanel,
  importBoardFile,
  useCanvasStore,
} from "../../modules/canvas/api";
import type { CanvasTool } from "../../modules/canvas/api";
import { confirmDialog } from "../../ui/confirm";
import { toast } from "../../ui/toast";
import "./SideToolbar.css";

/** 导出/导入菜单的「离开宽限」（ms）：光标横移过按钮→菜单间隙、或轻微抖出时不清菜单。
 *  取值与浮层退场过渡（--motion-fast 120ms）留出余量，手感上"不会一抖就没"，
 *  又不至于拖到影响连续操作。 */
const EXPORT_CLOSE_DELAY_MS = 260;

/* ---- 工具图标：stroke 风格内联 SVG，不引图标库（§3.2 选型原则） ---- */

function CursorIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 3l7.07 16.97 2.51-7.39 7.39-2.51L4 3z" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

function ConnectorIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="5" r="2" />
      <path d="M7 19 C7 9 17 15 17 5" />
    </svg>
  );
}

function NoteIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9z" />
      <path d="M15 3v6h6" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l4 2" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}

/* ---- 工具集：ready 的已接画布；便签随后续任务接入（§6.3、§2.1.4） ---- */

const TOOLS: {
  id: string;
  name: string;
  shortcut: string | null;
  icon: ReactNode;
  ready: boolean;
}[] = [
  { id: "select", name: "选择", shortcut: "V", icon: <CursorIcon />, ready: true },
  { id: "text", name: "文本", shortcut: "T", icon: <TextIcon />, ready: true },
  { id: "image", name: "图片", shortcut: null, icon: <ImageIcon />, ready: true },
  { id: "note", name: "便签", shortcut: null, icon: <NoteIcon />, ready: false },
];

/**
 * 左侧工具栏（灵动岛式悬浮胶囊）：仅灵感画布模块显示且**常驻**（不随鼠标热区收起；
 * lab 岛为热区弹出，见 AppShell）。切换模块时向左侧滑出隐藏
 * （CSS transition，位移+透明度，§6.2 动效约束）。
 * 当前工具存于画布 store：选择/文本为持续态，图片为一次性动作（打开文件选择器）。
 * 分隔线下为动作区："历史"按钮弹出操作历史面板（新悬浮岛，离开画布自动收起）；
 * 末位"导出/导入"按钮悬停（或键盘聚焦）向右展开菜单：导出 PNG 图像 / 导出工程文件 / 导入工程文件。
 */
export function SideToolbar() {
  const { pathname } = useLocation();
  const onCanvas = pathname.startsWith("/canvas");
  const tool = useCanvasStore((s) => s.tool);
  const setTool = useCanvasStore((s) => s.setTool);
  const connectActive = useCanvasStore((s) => s.connectMode.active);
  /** 元素数量：清空按钮的空态禁用（画布已空就没什么可清） */
  const elementCount = useCanvasStore((s) => s.elements.length);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** 导出/导入菜单展开态（2026-09-26 用户反馈：纯 CSS :hover 太灵敏，光标一抖就收起、
   *  菜单项点不中 → 改 JS 态 + 离开宽限，口径仍对齐详情页「送出」下拉的常驻 DOM 切换） */
  const [exportOpen, setExportOpen] = useState(false);
  /** 工程文件导入用的隐藏文件选择器（菜单项「导入工程文件」触发） */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 离开宽限计时器（光标从按钮横移到菜单、或轻微抖出时不清菜单） */
  const exportCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelExportClose = () => {
    if (exportCloseTimer.current) {
      clearTimeout(exportCloseTimer.current);
      exportCloseTimer.current = null;
    }
  };

  /** 展开菜单（悬停/聚焦/点击触发器都走这里） */
  const openExportMenu = () => {
    cancelExportClose();
    setExportOpen(true);
  };

  /** 延后收起：越过宽限期仍没回来才收（EXPORT_CLOSE_DELAY_MS 见文件尾常量） */
  const scheduleExportClose = () => {
    cancelExportClose();
    exportCloseTimer.current = setTimeout(() => {
      exportCloseTimer.current = null;
      setExportOpen(false);
    }, EXPORT_CLOSE_DELAY_MS);
  };

  /** 立即收起（选中菜单项、按 Esc、离开画布模块） */
  const closeExportMenu = () => {
    cancelExportClose();
    setExportOpen(false);
  };

  // 离开画布模块时收起历史面板与导出菜单；卸载时清掉未决计时器
  useEffect(() => {
    if (!onCanvas) {
      setHistoryOpen(false);
      closeExportMenu();
    }
  }, [onCanvas]);
  useEffect(() => cancelExportClose, []);

  // Esc 收起菜单（不 stopPropagation：画布自身的 Esc 语义——退出连接模式/取消选中——照旧生效）
  useEffect(() => {
    if (!exportOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeExportMenu();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [exportOpen]);

  /** 导出 PNG：完成后 toast 反馈（失败路径由 exportPng 内部 alert，故仅在成功时提示） */
  const handleExportPng = async () => {
    closeExportMenu();
    if (await exportBoardPng()) toast("已导出 PNG 图像");
  };

  /** 导出工程文件：同上 */
  const handleExportBoardFile = async () => {
    closeExportMenu();
    if (await exportBoardFile()) toast("已导出工程文件");
  };

  /** 导入工程文件：走隐藏 input；导入成功（替换完成）才提示 */
  const handleImportBoardFile = async (file: File) => {
    if (await importBoardFile(file)) toast("已导入工程文件");
  };

  /**
   * 清空画布（破坏性）：二次确认（ui/confirm，danger 色）→ 一步历史（Ctrl+Z 可整体恢复）
   * → 轻提示。视口不动（清空不该把视角也甩走）；图片资产不在这里删——保存时的 GC
   * 按"元素引用 + 内存缓存"清理，撤销回来时缓存里的 objectURL 仍在（同会话内可恢复）。
   */
  const handleClearBoard = async () => {
    const { elements, removeElements } = useCanvasStore.getState();
    if (elements.length === 0) return;
    const ok = await confirmDialog({
      title: "清空画布",
      message: `将删除画布上的全部 ${elements.length} 个元素（视口保持不变，可用 Ctrl+Z 撤销），确定清空？`,
      confirmText: "清空画布",
      danger: true,
    });
    if (!ok) return;
    removeElements(
      elements.map((e) => e.id),
      "清空画布",
    );
    toast("已清空画布（Ctrl+Z 可撤销）");
  };

  return (
    <>
      <aside
        className={`side-toolbar${onCanvas ? " is-visible" : ""}`}
        aria-label="工具栏"
        aria-hidden={!onCanvas}
      >
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            disabled={!t.ready}
            tabIndex={onCanvas ? 0 : -1}
            className={`side-toolbar__btn${tool === t.id ? " is-active" : ""}`}
            title={
              t.ready
                ? `${t.name}${t.shortcut ? `（${t.shortcut}）` : ""}`
                : `${t.name} · 开发中`
            }
            aria-label={t.name}
            aria-pressed={tool === t.id}
            onClick={() => {
              if (t.ready) setTool(t.id as CanvasTool);
            }}
          >
            {t.icon}
          </button>
        ))}
        <span className="side-toolbar__divider" aria-hidden="true" />
        <button
          type="button"
          tabIndex={onCanvas ? 0 : -1}
          className={`side-toolbar__btn${connectActive ? " is-active" : ""}`}
          title="连接线（L）· 选中两个直接创建，或进入点选模式依次串联"
          aria-label="连接线"
          aria-pressed={connectActive}
          onClick={() => {
            const s = useCanvasStore.getState();
            const nonConn = s.selectedIds.filter(
              (id) => s.elements.find((x) => x.id === id)?.type !== "connector",
            );
            if (nonConn.length === 2) {
              s.addConnector(nonConn[0], nonConn[1], "end");
            } else {
              s.toggleConnectMode();
            }
          }}
        >
          <ConnectorIcon />
        </button>
        <button
          type="button"
          tabIndex={onCanvas ? 0 : -1}
          className={`side-toolbar__btn${historyOpen ? " is-active" : ""}`}
          title="操作历史"
          aria-label="操作历史"
          aria-pressed={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
        >
          <HistoryIcon />
        </button>
        {/* 导出/导入：一枚触发器 + 悬停（或键盘聚焦/点击）向右展开的菜单
            （先例：M3 详情页「送出」下拉）。展开态由 JS 管、菜单常驻 DOM，
            收起留 260ms 宽限（见 EXPORT_CLOSE_DELAY_MS）——纯 CSS :hover 实测
            太灵敏：光标横移过按钮→菜单间隙或被手抖带出就立刻收起，菜单项点不中。 */}
        <div
          className={"side-toolbar__export" + (exportOpen ? " is-open" : "")}
          onMouseEnter={openExportMenu}
          onMouseLeave={scheduleExportClose}
          onFocus={openExportMenu}
          onBlur={(e) => {
            // 焦点移出「触发器 + 菜单」整块才收起（菜单项之间 Tab 不收起）
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
              closeExportMenu();
            }
          }}
        >
          <button
            type="button"
            tabIndex={onCanvas ? 0 : -1}
            className="side-toolbar__btn"
            title="导出 / 导入（悬停展开）"
            aria-label="导出与导入"
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            onClick={openExportMenu}
          >
            <DownloadIcon />
          </button>
          <div className="side-toolbar__export-menu" role="menu">
            <button
              type="button"
              role="menuitem"
              tabIndex={onCanvas ? 0 : -1}
              onClick={() => void handleExportPng()}
            >
              导出 PNG 图像
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={onCanvas ? 0 : -1}
              onClick={() => void handleExportBoardFile()}
            >
              导出工程文件
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={onCanvas ? 0 : -1}
              onClick={() => {
                closeExportMenu();
                fileInputRef.current?.click();
              }}
            >
              导入工程文件
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".ystkboard,application/json"
            className="side-toolbar__file-input"
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = ""; // 允许连续导入同一文件
              if (file) void handleImportBoardFile(file);
            }}
          />
        </div>
        {/* 破坏性动作单独一段：清空画布（画布已空时禁用） */}
        <span className="side-toolbar__divider" aria-hidden="true" />
        <button
          type="button"
          disabled={!onCanvas || elementCount === 0}
          tabIndex={onCanvas ? 0 : -1}
          className="side-toolbar__btn side-toolbar__btn--danger"
          title={elementCount === 0 ? "清空画布 · 画布已是空的" : "清空画布（需二次确认）"}
          aria-label="清空画布"
          onClick={() => void handleClearBoard()}
        >
          <TrashIcon />
        </button>
      </aside>
      <HistoryPanel
        open={onCanvas && historyOpen}
        onClose={() => setHistoryOpen(false)}
      />
    </>
  );
}
