/**
 * 模块注册表（应用壳占位版）
 *
 * 四大模块的元信息：顶栏导航与路由共用这一份数据。
 * 后续按开发文档 §5.1 插件协议落地时，模块将改为经
 * core/plugins/registry 注册路由与贡献点，此文件随之迁移。
 */

export interface ModuleInfo {
  /** 模块 id（目录名 / 路由路径） */
  id: string;
  /** 路由路径 */
  path: string;
  /** 模块编号（M1–M4；SR 为导航栏工具模块） */
  code: string;
  /** 模块中文名 */
  name: string;
  /** 一句话定位（空状态占位页展示，取自开发文档 §1.4） */
  tagline: string;
  /** 是否尚未上线（占位页路由；设置中心「关于」据此标「开发中」） */
  inDevelopment?: boolean;
}

export const MODULES: ModuleInfo[] = [
  {
    id: "canvas",
    path: "/canvas",
    code: "M1",
    name: "灵感画布",
    tagline:
      "类 OneNote 的无限自由画布，随手贴图、批注、拉线，做拍摄企划与知识分享看板。",
  },
  {
    id: "layout",
    path: "/layout",
    code: "M2",
    name: "排版工房",
    tagline:
      "高自由度排版系统，拖入图像 + 装饰元素拼装作品，模板以 JSON 导入导出。",
    inDevelopment: true,
  },
  {
    id: "library",
    path: "/library",
    code: "M3",
    name: "参考图库",
    tagline:
      "绑定本地文件夹，本地算力分析主体元素与主色调，索引随文件夹走，支持关键字 / tag / 颜色搜索。",
  },
  {
    id: "lab",
    path: "/lab",
    code: "M4",
    name: "图像分析",
    tagline:
      "直方图、饱和度分布、黑白关系等色彩科学工具，特色功能为划线取色分析。",
  },
  {
    id: "superres",
    path: "/superres",
    code: "SR",
    name: "图像超分",
    tagline:
      "Real-CUGAN 本地 AI 超分：一键放大 2x / 3x / 4x 并可调降噪档，游戏与动漫截图细节优先。",
  },
];
