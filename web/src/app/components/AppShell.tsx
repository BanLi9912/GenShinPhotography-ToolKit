import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { TopBar } from "./TopBar";
import { SideToolbar } from "./SideToolbar";
import { LabToolbar } from "../../modules/lab/api";
import { StatusBar } from "./StatusBar";
import { Toaster } from "../../ui/toast.tsx";
import { ConfirmHost } from "../../ui/confirm.tsx";
import { SettingsCenter } from "../settings/SettingsCenter";
import { devLogRoute } from "../../core/diagnostics/logger";
import "./AppShell.css";

const hasIsland = (p: string) => p.startsWith("/canvas") || p.startsWith("/lab");

/**
 * 应用壳布局（§6.3）：顶栏（通栏）/ 内容区 / 底部状态栏（通栏）。
 * 四大模块共用此骨架；工具栏为灵动岛式悬浮胶囊（SideToolbar/LabToolbar），
 * 浮于内容区之上不占布局列。M1 画布岛仅 /canvas 显示、**常驻不收起**；
 * M4 lab 岛仅 /lab 显示，鼠标靠近左缘热区滑入、离开约 400ms 自动收起、
 * 首次加载默认展开约 3 秒。双岛按路由滑入收回，直接切换时接力不穿插。
 */
export function AppShell() {
  const { pathname } = useLocation();
  const prevPathRef = useRef(pathname);
  const hotRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const [toolbarOpen, setToolbarOpen] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // M3 图库不渲染底部状态栏（含 grid 行让位给内容，2026-08-17 用户反馈）
  const onLibrary = pathname.startsWith("/library");

  const showToolbar = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setToolbarOpen(true);
  }, []);

  const scheduleHide = useCallback(() => {
    hideTimer.current = setTimeout(() => setToolbarOpen(false), 400);
  }, []);

  // 首次加载默认展开，3 秒后自动收起（鼠标提前靠近左边缘则取消计时）
  useEffect(() => {
    hideTimer.current = setTimeout(() => setToolbarOpen(false), 3000);
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  // 左侧热区是浮在内容区之上的全高条（56px），它的祖先链里没有滚动容器；
  // 滚轮落在它身上时浏览器找不到可滚区域，会把这次滚动整个吃掉——表现为
  // 「鼠标在页面左缘 56px 内滚不动页」（2026-09-16 修复）。
  // 这里把纵向/横向滚轮手动转交给内容区；deltaMode 1=行 2=页，按行高/视口换算。
  useEffect(() => {
    const hot = hotRef.current;
    const content = contentRef.current;
    if (!hot || !content) return;
    const onWheel = (e: WheelEvent) => {
      const unit =
        e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? content.clientHeight : 1;
      e.preventDefault();
      content.scrollTop += e.deltaY * unit;
      content.scrollLeft += e.deltaX * unit;
    };
    hot.addEventListener("wheel", onWheel, { passive: false });
    return () => hot.removeEventListener("wheel", onWheel);
  }, []);

  // 两个有岛工作区直接切换：进场岛延迟一个 motion-base 再滑入，
  // 让退场岛先收完，避免两岛在同一左轨穿插（接力时序）
  const relay =
    prevPathRef.current !== pathname &&
    hasIsland(prevPathRef.current) &&
    hasIsland(pathname);
  useEffect(() => {
    devLogRoute(pathname); // 开发者日志：路由切换（未开启时零开销）
    prevPathRef.current = pathname;
  }, [pathname]);

  return (
    <div
      className={`app-shell${relay ? " app-shell--island-relay" : ""}${
        onLibrary ? " app-shell--no-statusbar" : ""
      }`}
    >
      <TopBar />
      <div
        ref={hotRef}
        className="app-shell__island-hot"
        onMouseEnter={showToolbar}
        onMouseLeave={scheduleHide}
      >
        <SideToolbar />
        <LabToolbar toolbarOpen={toolbarOpen} />
      </div>
      <main ref={contentRef} className="app-shell__content">
        <Outlet />
      </main>
      {!onLibrary && <StatusBar />}
      {/* 全局轻提示（ui/toast）：壳层负责挂载，定位基准见 AppShell.css */}
      <Toaster />
      {/* 全局确认对话框（ui/confirm）：替代 window.confirm */}
      <ConfirmHost />
      {/* 全屏设置中心（portal 到 body，自顶栏齿轮打开） */}
      <SettingsCenter />
    </div>
  );
}
