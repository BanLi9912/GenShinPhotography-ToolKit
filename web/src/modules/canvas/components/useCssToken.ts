import { useEffect, useState } from "react";

/** 读取 CSS 变量（design tokens）当前计算值，供 Konva 画布绘制使用 */
function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}

/**
 * 订阅一个 design token：<html data-theme> 切换时重读。
 * Canvas 2D 无法直接引用 CSS 变量，组件内零硬编码色值靠此桥接。
 */
export function useCssToken(name: string, fallback: string): string {
  const [value, setValue] = useState(() => readToken(name, fallback));

  useEffect(() => {
    const update = () => setValue(readToken(name, fallback));
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [name, fallback]);

  return value;
}
