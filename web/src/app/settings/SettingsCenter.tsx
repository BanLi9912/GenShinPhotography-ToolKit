import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSettingsStore } from "./store";
import { APP_VERSION } from "../version";
import { MODULES } from "../modules";
import { useThemeStore } from "../theme";
import type { Theme } from "../theme";
import { useCanvasSettings } from "../../modules/canvas/api";
import { LibraryGlobalSettingsPanel, LibraryRegistryPanel } from "../../modules/library/api";
import { ComponentsPanel } from "./ComponentsPanel";
import { DevLogRow } from "./DevLogRow";
import { BackupRow } from "./BackupRow";
import "./SettingsCenter.css";

/**
 * 应用壳全屏设置中心（任务 2026-09-08）：
 * 全屏玻璃遮罩覆盖层（portal 到 body + fixed，编排对齐详情页 DetailView 先例）；
 * 左列 = 分区导航（通用 / M1–M4，列底固定「关于」），右列 = 分区内容独立滚动。
 * 顶栏原小弹层废除；M3 全局（跨图库）设置整段迁入 M3 分区。
 */

/** 设置分区（左列导航顺序；about 单独钉在列底，不入数组） */
const SECTIONS: { key: string; name: string; mini: string }[] = [
  { key: "general", name: "通用", mini: "通用" },
  { key: "canvas", name: "灵感画布", mini: "M1" },
  { key: "layout", name: "排版工房", mini: "M2" },
  { key: "library", name: "参考图库", mini: "M3" },
  { key: "lab", name: "图像分析", mini: "M4" },
];

/** M1 对齐吸附开关（自顶栏小弹层迁入，读写 store 字段不变） */
function SnapControl() {
  const snapEnabled = useCanvasSettings((s) => s.snapEnabled);
  const setSnapEnabled = useCanvasSettings((s) => s.setSnapEnabled);
  return (
    <div className="sc-row">
      <span className="sc-row__label">对齐吸附</span>
      <div className="sc-switch">
        <span className="sc-row__hint">拖动显示参考线并吸附</span>
        <button
          type="button"
          role="switch"
          aria-checked={snapEnabled}
          className={"sc-switch__track" + (snapEnabled ? " is-on" : "")}
          onClick={() => setSnapEnabled(!snapEnabled)}
        >
          <span className="sc-switch__knob" />
        </button>
      </div>
    </div>
  );
}

/** 通用分区内容：外观主题（与顶栏主题按钮同 store，双入口互通）+ 模块组件管理 */
function GeneralContent() {
  const theme = useThemeStore((s) => s.theme);
  const pick = (t: Theme) => {
    const s = useThemeStore.getState();
    if (s.theme !== t) s.toggleTheme();
  };
  return (
    <>
      <p className="sc-content__desc">应用级外观与通用偏好</p>
      <div className="sc-row">
        <span className="sc-row__label">外观主题</span>
        <div className="sc-seg" role="group" aria-label="外观主题">
          <button
            type="button"
            className={theme === "light" ? "is-active" : ""}
            aria-pressed={theme === "light"}
            onClick={() => pick("light")}
          >
            浅色
          </button>
          <button
            type="button"
            className={theme === "dark" ? "is-active" : ""}
            aria-pressed={theme === "dark"}
            onClick={() => pick("dark")}
          >
            深色
          </button>
        </div>
      </div>
      <ComponentsPanel />
      {/* 开发者模式：今日新增的两个开发者功能行归到同一标题下（标题写法对齐「模块组件」） */}
      <section className="sc-devmode">
        <div className="sc-cmp__head">
          <span className="sc-cmp__title">开发者模式</span>
        </div>
        <DevLogRow />
        <BackupRow />
      </section>
    </>
  );
}

/** 关于分区内容 */
function AboutContent() {
  return (
    <>
      <h2 className="sc-about__name">YuanShe ToolKit · 游戏摄影工具箱</h2>
      <div className="sc-about__version">v{APP_VERSION}</div>
      <p className="sc-about__pos">
        本地优先的游戏摄影工具箱：默认无账号、无云服务。
      </p>

      <div className="sc-about__section-title">模块</div>
      {/* 模块行 = 使用说明入口：整行可点、悬停浮起，用 target="_blank" 在新标签页打开
          （普通 <a> 而非 <Link>：新标签页要走完整导航，且这样中键/Ctrl+点击也天然可用） */}
      {MODULES.map((m) => (
        <a
          key={m.id}
          className="sc-about__module"
          href={`/help/${m.id}`}
          target="_blank"
          rel="noopener noreferrer"
          title={`打开「${m.name}」使用说明（新标签页）`}
        >
          <span className="sc-about__module-code">{m.code}</span>
          <span className="sc-about__module-name">{m.name}</span>
          <span className="sc-about__module-tag">{m.tagline}</span>
          {m.inDevelopment && (
            <span className="sc-about__module-badge">开发中</span>
          )}
          <span className="sc-about__module-go" aria-hidden="true">
            ↗
          </span>
        </a>
      ))}

      <div className="sc-about__section-title">技术栈</div>
      <p className="sc-content__desc">
        React 18 · TypeScript · Vite · Konva · zustand · idb ·
        onnxruntime-web
      </p>
    </>
  );
}

export function SettingsCenter() {
  const open = useSettingsStore((s) => s.open);
  const section = useSettingsStore((s) => s.section);
  const close = useSettingsStore((s) => s.closeSettings);

  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [entered, setEntered] = useState(false);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 开合 + 进出场动画：进入立即挂载并双 rAF 加 .is-entered（遮罩 blur 渐变）；
  // 退出先播 .is-leaving 淡出（200ms）再卸载
  useEffect(() => {
    if (open) {
      if (leaveTimer.current) {
        clearTimeout(leaveTimer.current);
        leaveTimer.current = null;
      }
      setMounted(true);
      setLeaving(false);
      let raf1 = 0;
      let raf2 = 0;
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setEntered(true));
      });
      return () => {
        cancelAnimationFrame(raf1);
        cancelAnimationFrame(raf2);
      };
    }
    if (!mounted) return;
    setLeaving(true);
    leaveTimer.current = setTimeout(() => {
      leaveTimer.current = null;
      setMounted(false);
      setLeaving(false);
      setEntered(false);
    }, 200);
    return undefined;
  }, [open, mounted]);

  // Esc 关闭
  useEffect(() => {
    if (!open || leaving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, leaving, close]);

  if (!mounted) return null;

  const title =
    section === "about"
      ? "关于"
      : (SECTIONS.find((s) => s.key === section)?.name ?? "通用");

  const renderContent = () => {
    switch (section) {
      case "general":
        return <GeneralContent />;
      case "canvas":
        return (
          <>
            <p className="sc-content__desc">灵感画布偏好</p>
            <SnapControl />
          </>
        );
      case "layout":
        return <p className="sc-content__empty">模块开发中，暂无可配置项</p>;
      case "library":
        // 图库注册表（磁盘路径登记）与识图全局设置之间用横线隔开
        // （.lib-settings__section 自带 border-top）
        return (
          <>
            <LibraryRegistryPanel />
            <div className="lib-settings__section">
              <LibraryGlobalSettingsPanel />
            </div>
          </>
        );
      case "lab":
        return <p className="sc-content__empty">暂无可配置项</p>;
      case "about":
        return <AboutContent />;
      default:
        return <p className="sc-content__empty">暂无可配置项</p>;
    }
  };

  return createPortal(
    <div
      className={
        "sc-overlay" +
        (leaving ? " is-leaving" : "") +
        (entered ? " is-entered" : "")
      }
      onClick={close}
    >
      <div className="sc-shell" onClick={(e) => e.stopPropagation()}>
        <nav className="sc-nav" aria-label="设置分区">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={
                "sc-nav__item" + (section === s.key ? " is-active" : "")
              }
              aria-current={section === s.key}
              onClick={() => useSettingsStore.getState().openSettings(s.key)}
            >
              <span className="sc-nav__full">{s.name}</span>
              <span className="sc-nav__mini">{s.mini}</span>
            </button>
          ))}
          <button
            type="button"
            className={
              "sc-nav__item sc-nav__about" +
              (section === "about" ? " is-active" : "")
            }
            aria-current={section === "about"}
            onClick={() => useSettingsStore.getState().openSettings("about")}
          >
            <span className="sc-nav__full">关于 YuanShe ToolKit</span>
            <span className="sc-nav__mini">关于</span>
          </button>
        </nav>
        <div className="sc-content">
          <h2 className="sc-content__title">{title}</h2>
          {renderContent()}
        </div>
      </div>
    </div>,
    document.body,
  );
}
