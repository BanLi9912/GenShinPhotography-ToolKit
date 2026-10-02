import type { Guide } from "./types";
import { CANVAS_GUIDE } from "./canvas";
import { LIBRARY_GUIDE } from "./library";
import { LAB_GUIDE } from "./lab";
import { SUPERRES_GUIDE } from "./superres";

/**
 * 使用说明注册表：模块 id → 指南。
 *
 * 已有指南：灵感画布（M1）、参考图库（M3）、图像分析（M4）、图像超分（SR）。
 * 尚未编写：排版工房（M2，模块未开工）——它的行在「关于」页同样可点，
 * 点开会看到「使用说明正在编写中」的占位页。写完在这里注册即可上线，不必改其它地方。
 */
export const GUIDES: Record<string, Guide> = {
  canvas: CANVAS_GUIDE,
  library: LIBRARY_GUIDE,
  lab: LAB_GUIDE,
  superres: SUPERRES_GUIDE,
};

export type { Guide, GuideSection } from "./types";
