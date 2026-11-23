import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/global.css";
import { App } from "./app/App";
import { initDevLog } from "./app/diagnostics";
import { initBackup } from "./app/backup";

// 开发者日志：渲染前初始化，早于 React 才能捕获启动期异常（开关关闭时零开销）
initDevLog();
// 图库索引备份：开关已开则恢复定时调度（关闭时零开销）
initBackup();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
