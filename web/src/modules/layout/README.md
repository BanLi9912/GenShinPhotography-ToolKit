# M2 排版工房（layout）

高自由度模板排版系统：定尺寸画布 + 图像/文本/形状/装饰元素拼装作品，模板以 JSON（含槽位 slot）导入导出。

- 需求详见开发文档 §2.2；模板 JSON Schema 见 §4.1
- 模块约定（§3.3）：对外只暴露 `api.ts`；模块状态在 `store.ts`；组件在 `components/`
- 与其他模块协作一律走 `core/events` 事件总线，禁止直接 import 对方内部实现
