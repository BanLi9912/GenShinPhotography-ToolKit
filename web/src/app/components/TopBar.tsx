import { NavLink } from "react-router-dom";
import { MODULES } from "../modules";
import { useThemeStore } from "../theme";
import { useSettingsStore } from "../settings/store";
import {
  serviceLabel,
  serviceTitle,
  useServiceHealth,
} from "../serviceHealth";
import "./TopBar.css";

/** 太阳图标（深色主题下显示，点击切换到浅色） */
function SunIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

/** 月亮图标（浅色主题下显示，点击切换到深色） */
function MoonIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </svg>
  );
}

/** 设置齿轮图标（stroke 风格，与工具栏图标一致） */
function SettingsIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** 顶栏（§6.3）：产品名 · 模块导航 · 服务状态 · 主题切换 · 设置 */
export function TopBar() {
  const theme = useThemeStore((s) => s.theme);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);
  const openSettings = useSettingsStore((s) => s.openSettings);
  const health = useServiceHealth();
  const nextThemeLabel =
    theme === "dark" ? "切换到浅色主题" : "切换到深色主题";

  return (
    <header className="topbar">
      <div className="topbar__group">
        <span className="topbar__brand">YuanShe ToolKit</span>
        <span className="topbar__divider" aria-hidden="true" />
        <nav className="topbar__nav" aria-label="模块导航">
          {MODULES.map((m) => (
            <NavLink
              key={m.id}
              to={m.path}
              className={({ isActive }) =>
                `topbar__nav-item${isActive ? " is-active" : ""}`
              }
            >
              {m.name}
            </NavLink>
          ))}
        </nav>
      </div>
      <div className="topbar__group">
        <span
          className={`topbar__service is-${health.state}`}
          title={serviceTitle(health)}
          data-service-state={health.state}
        >
          <span className="topbar__service-dot" aria-hidden="true" />
          {serviceLabel(health.state)}
        </span>
        <button
          type="button"
          className="topbar__icon-btn"
          title={nextThemeLabel}
          aria-label={nextThemeLabel}
          onClick={toggleTheme}
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className="topbar__icon-btn"
          title="设置"
          aria-label="设置"
          onClick={() => openSettings()}
        >
          <SettingsIcon />
        </button>
      </div>
    </header>
  );
}
