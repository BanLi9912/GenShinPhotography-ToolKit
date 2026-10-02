/**
 * 应用内确认对话框内核 · 公共 UI（替代 window.confirm，2026-08-23 用户口径）。
 * 模块级发布/订阅，零框架依赖：confirmDialog(opts) 返回 Promise<boolean>；
 * 同一时刻只弹一个，其余排队；确认/取消后播 180ms 退场再放行下一个。
 * 渲染器（ConfirmHost）在 confirm.tsx，本文件只含纯逻辑，不碍 fast refresh。
 */

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 确认钮文案，默认「确定」 */
  confirmText?: string;
  /** 取消钮文案，默认「取消」 */
  cancelText?: string;
  /** true 时确认钮用 --danger 色（破坏性操作，如移除绑定/清零成本） */
  danger?: boolean;
}

/** 渲染器可见状态（含退场标记） */
export interface ConfirmState extends ConfirmOptions {
  leaving: boolean;
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
  leaving: boolean;
}

let queue: PendingConfirm[] = [];
let active: PendingConfirm | null = null;
const listeners = new Set<(state: ConfirmState | null) => void>();
const EXIT_MS = 180; // 与 --motion-base 一致

function emit(): void {
  for (const l of listeners) {
    l(active ? { ...active, leaving: active.leaving } : null);
  }
}

function pump(): void {
  if (!active && queue.length > 0) {
    active = queue.shift() ?? null;
    emit();
  }
}

/** 弹一个确认框；返回用户选择（true = 确认，false = 取消/遮罩/Esc） */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    queue.push({ ...opts, resolve, leaving: false });
    pump();
  });
}

/** 用户已作出选择：立即兑现 Promise，active 保留至退场动画播完再放行下一个 */
export function settleConfirm(ok: boolean): void {
  if (!active) return;
  active.resolve(ok);
  active.leaving = true;
  emit();
  window.setTimeout(() => {
    active = null;
    emit();
    pump();
  }, EXIT_MS);
}

/** 订阅当前对话框状态（渲染器用）；返回退订函数 */
export function subscribeConfirm(
  listener: (state: ConfirmState | null) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
