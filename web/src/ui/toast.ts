/**
 * 轻提示 toast 内核 · 公共 UI（design.md §7.10 玻璃浮层进出场惯例）。
 * 模块级发布/订阅，零框架依赖：任意模块调 toast(text) 即弹，
 * 显示 2.2s 后两段式退场（leaving 播 180ms 再移除）；最多同时 3 条。
 * 渲染器（Toaster）在 toast.tsx，本文件只含纯逻辑，不碍 fast refresh。
 */

export interface ToastItem {
  id: number;
  text: string;
  leaving: boolean;
}

type ToastListener = (list: ToastItem[]) => void;

let nextId = 1;
let items: ToastItem[] = [];
const listeners = new Set<ToastListener>();
const VISIBLE_MS = 2200;
const EXIT_MS = 180; // 与 --motion-base 一致

function emit(): void {
  for (const l of listeners) l(items);
}

/** 弹一条轻提示；最多同时 3 条（超出丢弃最旧） */
export function toast(text: string): void {
  const id = nextId++;
  items = [...items, { id, text, leaving: false }];
  if (items.length > 3) items = items.slice(items.length - 3);
  emit();
  window.setTimeout(() => {
    items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
    emit();
    window.setTimeout(() => {
      items = items.filter((t) => t.id !== id);
      emit();
    }, EXIT_MS);
  }, VISIBLE_MS);
}

/** 订阅当前列表（渲染器用）；返回退订函数 */
export function subscribeToast(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 当前列表快照（渲染器初始态用） */
export function getToastItems(): ToastItem[] {
  return items;
}
