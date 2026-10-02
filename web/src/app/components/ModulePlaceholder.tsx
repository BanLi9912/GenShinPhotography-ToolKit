import type { ModuleInfo } from "../modules";
import "./ModulePlaceholder.css";

/**
 * 模块空状态占位页（§6.4：不允许大白屏）。
 * 展示模块编号、名称与定位，待各模块按路线图落地后替换。
 */
export function ModulePlaceholder({ module }: { module: ModuleInfo }) {
  return (
    <section className="module-placeholder">
      <span className="module-placeholder__code">{module.code}</span>
      <h1 className="module-placeholder__name">{module.name}</h1>
      <span className="module-placeholder__rule" aria-hidden="true" />
      <p className="module-placeholder__tagline">{module.tagline}</p>
      <p className="module-placeholder__hint">模块建设中</p>
    </section>
  );
}
