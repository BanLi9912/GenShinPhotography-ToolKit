/**
 * M4 图像分析实验室 · 对外接口
 * 模块约定（§3.3）：对外只暴露本文件；状态在 store.ts；组件在 components/。
 * useLabStore 暴露给应用壳（状态栏读缩放/光标 RGB/HSL，见 app/components/StatusBar）。
 * LabToolbar 暴露给应用壳挂载（悬浮岛，随路由滑入/收回）。
 * 图像来源协作（M3.6 定案 D7）：走 api 直调，不建 core/events 事件总线
 * ——M3 送去分析经本文件导出的 `openImageFile` 装入后跳转本模块路由。
 */
export { LabPage } from "./components/LabPage";
export { LabToolbar } from "./components/LabToolbar";
export { useLabStore } from "./store";
export type { LabTool } from "./store";
export { openImageFile } from "./imageSource";
