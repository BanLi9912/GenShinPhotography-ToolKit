import { useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { CanvasPage } from "../modules/canvas/api";
import { LabPage } from "../modules/lab/api";
import { LibraryPage, startCollectorBridge } from "../modules/library/api";
import { SuperResPage } from "../modules/superres/api";
import { AppShell } from "./components/AppShell";
import { HelpPage } from "./help/HelpPage";
import { ModulePlaceholder } from "./components/ModulePlaceholder";
import { MODULES } from "./modules";
import { useThemeStore } from "./theme";

/**
 * 应用入口：主题同步 + 路由 + 应用壳。
 * `/` 重定向到灵感画布；M1 与 M4 骨架已落地（任务 1.1 / M4.1），
 * 其余模块路由先挂空状态占位页。
 */
export function App() {
  const theme = useThemeStore((s) => s.theme);

  // 主题落到 <html data-theme>，tokens 按属性整体切换（见 styles/tokens.css）
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  /**
   * 浏览器拖拽采集桥（M3，2026-11-12 任务卡）：全局挂一次，不依赖当前路由——
   * 用户在哪个页面都要能接住浏览器扩展转发过来的落盘请求。
   * effect 返回的清理函数与挂载对称（StrictMode 下会挂→卸→再挂）。
   */
  useEffect(() => startCollectorBridge(), []);

  return (
    <BrowserRouter>
      <Routes>
        {/* 使用说明：独立页面（**不套应用壳**），由设置中心「关于」页的模块行
            在新标签页打开；故放在 AppShell 布局路由之外，自成整页文档 */}
        <Route path="/help/:moduleId" element={<HelpPage />} />
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/canvas" replace />} />
          {MODULES.map((m) => (
            <Route
              key={m.id}
              path={m.path}
              element={
                m.id === "canvas" ? (
                  <CanvasPage />
                ) : m.id === "lab" ? (
                  <LabPage />
                ) : m.id === "library" ? (
                  <LibraryPage />
                ) : m.id === "superres" ? (
                  <SuperResPage />
                ) : (
                  <ModulePlaceholder module={m} />
                )
              }
            />
          ))}
          <Route path="*" element={<Navigate to="/canvas" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
