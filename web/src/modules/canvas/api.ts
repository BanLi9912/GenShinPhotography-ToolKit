/**
 * M1 灵感画布 · 对外接口
 * 模块约定（§3.3）：对外只暴露本文件；状态在 store.ts；组件在 components/。
 * useCanvasStore 暴露给应用壳（状态栏读缩放/指针，工具栏读写当前工具）。
 * 元素、连线等能力随阶段 1 后续任务逐步补充。
 * 图像来源协作（M3.6 定案 D7）：走 api 直调，不建 core/events 事件总线
 * ——M3 送去画布经本文件导出的 `queueImagesForCanvas` 入待收队列
 * （画布水合完成后落图，见 incoming.ts），拖拽经 `LIBRARY_DRAG_MIME` 回取 File。
 */
export { CanvasPage } from "./components/CanvasPage";
export { HistoryPanel } from "./components/HistoryPanel";
export { useCanvasStore, useCanvasSettings } from "./store";
export type { CanvasTool } from "./store";
export { exportBoardPng } from "./exportPng";
export { exportBoardFile, importBoardFile } from "./boardFile";
export { queueImagesForCanvas } from "./incoming";
