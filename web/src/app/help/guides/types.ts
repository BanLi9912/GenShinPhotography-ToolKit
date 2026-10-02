import type { ReactNode } from "react";

/** 使用说明的一节（标题 + 正文），id 同时用于目录锚点与 <h2 id> */
export interface GuideSection {
  id: string;
  title: string;
  body: ReactNode;
}

/** 一个模块的使用说明 */
export interface Guide {
  /** 开篇一段（说清"这是什么、什么时候用"） */
  intro: ReactNode;
  /** 分节正文（顺序即页面顺序，也是配图序号的顺序） */
  sections: GuideSection[];
}
