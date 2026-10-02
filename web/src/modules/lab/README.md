# M4 图像分析实验室（lab）

色彩科学工具箱：直方图、主色板、检查视图 LUT，特色功能为划线取色分析。

- 需求以 `开发文档-M4.md`（独立版）为准；任务拆分与验收口径见 `落地工作清单-M4.md`
- 分析器按 v0.2 §5.3 扩展点实现（`compute` + `render`），新分析器不改内核
- 像素数据统一经 `imageSource.ts` 的离屏 canvas 进入（后续分析器共用）；**色彩换算/主色算法已上移 `core/imaging`（规划 D4，M3.2 落地），本模块仅引用**
- 色彩换算唯一实现在 `core/imaging/color.ts`（§5.1：RGB↔HSL↔HEX + Rec.601 luma，禁止各处自算）
- 直方图统计在 `histogram.ts`（纯函数，单趟 R/G/B/L 256 bin + 死黑/死白）
- 划线事件 / 明度峰谷 / 事件描述句在 `strokeAnalysis.ts`（纯函数）；median-cut 主色在 `palette.ts`（委托 `core/imaging/palette`，与 M3 共用）；和谐结构判定在 `harmony.ts`（纯函数）；说明图导出在 `strokeExport.ts`（`ystk/stroke-analysis` 数据 + PNG 合成）；面板 `components/HarmonyPanel.tsx`
- 主色板在 `components/PalettePanel.tsx`（median-cut 算法复用 `palette.ts`，点击复制 HEX / 导出色板横条 PNG）
- 说明收缩在 `components/PanelInfo.tsx`（ⓘ 按钮 + 浮层，点击/点外/Esc 关闭）
- 模块约定（§3.3）：对外只暴露 `api.ts`；模块状态在 `store.ts`；组件在 `components/`

## 进度
- **任务 M4.1 模块骨架与图像视口（已完成）**：路由 `/lab` 经模块注册接入应用壳（`App.tsx`）。版面按 §2.1——壳级悬浮岛（M1 同款，随工作区切换收回/滑入，接力时序由 AppShell 控制；**lab 岛为热区弹出**——鼠标靠近左缘滑入、离开约 400ms 收起、首载约 3s 收起；**M1 画布岛常驻**不收热区影响）· 图像视口全宽（`LabViewport.tsx`）· 输出区为视口上的悬浮面板（`LabPanel.tsx` + `LabPage.tsx` 的 dock 层，可调宽/收起——按">"拖拽调宽 280–720、点按收起，收起后右侧边"<"常亮供展开）。说明收缩进 ⓘ 按钮（`PanelInfo.tsx`）。图像打开入口…（同上）。视口：滚轮缩放 **0.10–4x** 光标锚定（系数与 M1 一致）、指针拖拽平移（指针捕获）、适配/1:1 浮动控制钮随面板宽度避让、zoom ≥ 1 `image-rendering: pixelated`。直方图面板两 tab（RGB·明度/色阶）；饱和度分布移入「饱和度」工具面板（S 直方图+均值）。黑/白场拾取重映射预览（视口 crosshair → 点击取 luma → LUT 全尺寸重映射→ JPEG 0.95 预览）。面板宽度/收起状态经 localStorage 持久化（design.md §6 布局状态记忆）。分析面板按 Spatial UI 空间化（二级材质/胶囊控件/实心选中）。图表 Apple 风格：平滑填充曲线 + screen 通道叠加 + 无网格克制坐标。
- **任务 M4.3.2 / M4.3.3 翻页式切换动画（已完成）**：方向性入场动画（`toolDir` 按左栏顺序判定）→ 翻页式整页平移（双 `.lab-panel` exit/enter 同帧反向滑动，250ms ease-out 纯 `translateY ±100%`，`useLayoutEffect` 消闪烁）；`.lab-panel` 从 `prefers-reduced-motion` 豁免（功能动画）；视口控制钮拖拽期间禁用 `right` 过渡。
- **任务 M4.4 覆盖机制 + Dot Gain 20%（已完成）**：§2.4 覆盖机制落地（store 单字段互斥 / 面板开关 / 左栏 accent 角标 / 视口角标可关 / 120ms 淡化）；DotGain20% = luma 灰度化 + 特性曲线 LUT（Murray-Davies 50%→70%），覆盖层经 imageSource.getOverlayImageUrl 全尺寸生成单槽缓存；面板对照直方图（原图灰底 vs 校样 accent 线）。
- **任务 M4.5 饱和度 flyout + 双覆盖（已完成）**：左栏唯一 flyout（检查/热力，canvas-toolbar 岛肤）；检查 = PS 50% 灰明度基准（luma 归一 128 + hue-preserving 裁剪），热力 = S 映射灰→橙→红 65% 叠层；OverlayTool 细化 sat-check/sat-heat + OVERLAY_SOURCE_TOOL 角标归属；面板 S 直方图新增低/高饱和占比。
- **任务 M4.8 划线取色（进行中）**：stroke 工具下在图像上画线（自由折线/Shift直线/多线管理/整体平移）；沿路径弧长均匀采样（1/2/4/8px步长+1–15px宽度均值抗噪）；底部横贯画布的玻璃抽屉展示色彩旅程色带+HSL/RGB通道曲线；曲线→图像双向hover联动；画线/移线/参数切换即重采样；离开stroke时抽屉150ms下移→面板250ms翻页。
- **任务 M4.9 划线增强与色彩和谐（已完成）**：底部小窗事件行（L 最大跃迁 / H 色环最短距跳变 / S 峰值各配一句话，`describeStrokeEvents` 单一文案来源）+ 明度剖面高亮（起终点标注 + 峰谷三角）+ 说明图 PNG 导出（图像+路径+色带+三通道曲线+事件句，数据格式 `ystk/stroke-analysis`）；色彩和谐面板（median-cut 主色 → 色轮落点 H 定角度/S 定半径 → 近似/互补/三角/分裂互补判定 + 经典模板偏差）。
- **任务 M4.7 主色板（已完成）**：5–8 色选择（默认 6）/ 色块拼图条（占比比例、点击复制，M4.7.1 优化）+ 读数明细全部展示（12px 两行：HEX-占比 / RGB-HSL，与色板图同卡紧凑排布，点击行复制 hex，M4.7.2/4.7.3 优化）/ 横条 PNG 导出（count×100 纯色块）。
- **接收入口（任务 M3.6，M3 图库送来）**：`api.ts` 导出 `openImageFile(file)`（`imageSource.ts` 唯一装图入口）——M3 详情页/网格右键「送去分析」先调它装图、成功再 `navigate("/lab")`（口径 D7：api 直调，无 core/events）；lab store 为模块级单例（路由切换不清），故先装图后跳转、图一定在，装入即各分析面板现场取数（装图即分析）。失败返回 false，M3 侧 toast 且不跳转。
