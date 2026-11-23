/**
 * 图像超分 · 对外接口
 * 模块约定（§3.3）：对外只暴露本文件；状态在 store.ts；组件在 components/。
 */
export { SuperResPage } from "./components/SuperResPage";
export { useSuperResStore } from "./store";
export type { DenoiseLevel, CuganScale, SuperResMode } from "./store";
