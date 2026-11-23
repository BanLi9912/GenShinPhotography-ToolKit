# YuanShe ToolKit · 设计系统准则（design.md）

> 版本：v2.5 · 日期：2026-08-16
> 定位：UI 设计决策的唯一准则文档。写任何组件样式前先读本文 + `web/src/styles/tokens.css`。
> 依据：开发文档 v0.2 §1.3/§6 + `tokens.css` 实际取值 + ui-ux-pro-max skill 检索（见文末附录）。
> 铁律重申：**组件内零硬编码色值**，一切颜色走 `tokens.css` 的 CSS 变量（双主题，浅色默认）。
> v2.5 变更：新增 §7.10–7.13——玻璃浮层进出场动画 / 悬浮磨砂失效规避（portal）/ 温度=全局筛选精度 / 搜索行星标按钮。
> v2.4 变更：M3 悬浮工具栏收起交互定稿（§7.9）——收起阈值 100px、恢复热区 clientY ≤ 176（覆盖两行全高）、高级筛选浮层展开期间工具栏不收起。
> v2.3 变更：M4 翻页式切换动画（双面板平移 + useLayoutEffect 消闪 + reduced-motion 功能动画豁免）+ 图表区层次强化（圆角矩形阴影 + Canvas 标注色改用 --text-2 保证深色对比度）+ 视口控制钮拖拽即时跟随 + 饱和度光标竖线。
> v2.2 变更：M4 分析图表 Apple 风格（平滑填充曲线 + screen 混合叠加 + 无网格克制坐标）；面板标题改无衬线 600。
> v2.1 变更：深色基底纯黑→#1E1E1E + 三色文本纪律（黄交互/蓝标题/橙读数）+ 实心选中态 + 二级材质 + 面板空间化（胶囊控件/大留白/材质分层）；浅色仅实心选中与面板空间化两处视觉变化。
> v2.0 变更：浅色模式按 Spatial UI（visionOS 风格）重建为磨砂玻璃空间界面；深色模式换 Kinetic Typography 配色（纯黑+纯白+电光黄，仅配色变更、结构同浅色）。

## 1. 设计定位

**「概念设计工作室的工作台」**——游戏摄影师的本地暗房 + 灵感墙 + 装帧台，以**空间玻璃**承载。

- 用户是审美敏感人群，工具的质感就是信任感（"审美即功能"）。
- 界面退为**浮于内容之上的磨砂玻璃层**（半透明 + backdrop blur + 深度阴影），用户的图像/画布是唯一的视觉主角——玻璃因折射内容而存在，不为装饰。
- 浅色 = Spatial UI（visionOS 风格）：明亮空间、玻璃浮层、系统蓝点睛；深色 = Kinetic Typography 配色：纯黑场、纯白字、电光黄撞色，如动态字体海报的张力。
- skill 检索印证：Spatial UI (VisionOS) 条目（frosted glass 15–30% 透明、blur+saturate、24px 连续圆角、深度阴影分层）与产品"内容优先"定位一致。

## 2. 风格方向（Do / Don't）

| Do | Don't |
|---|---|
| 浮层一律磨砂玻璃（`--bg-elevated`/`--bg-panel` + `--glass-blur`），浮于内容之上 | 实色卡片铺满、玻璃当装饰贴在无内容处 |
| 深度靠 `--shadow-float` 一种阴影分级 + 1px 半透明细线 | 各自为政的阴影参数、无层级的阴影堆叠 |
| 选中态/关键操作用一处点睛色（浅：系统蓝 / 深：电光黄） | 多处高亮争抢注意力 |
| 分隔靠留白与 1px 细线（`--line` 半透明） | 卡片套卡片、粗边框分区 |
| SVG 图标（线性、统一描边） | emoji 当图标、混用图标风格 |
| 标题黑体/衬线混排 + 等宽数字标注参数（"设定集"感） | 全界面单一字重无层次 |
| 分析图表：平滑填充曲线 + screen 混合叠加 | 硬边柱图、横网格线 |
| 图表容器：圆角矩形 + 微阴影（`0 2px 12px rgb(0 0 0 / 14%)`）分层，双主题可辨 | 图表区与背景融为一体、边界不可辨 |

## 3. 色彩系统

双主题，经 `<html data-theme="dark|light">` 切换，浅色默认，选择本地持久化。取值以 `web/src/styles/tokens.css` 为准（下表为快照）。

### 3.1 浅色（默认，Spatial UI / visionOS 风格）

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#F4F4F6` | 应用底色（系统灰，微提亮） |
| `--bg-panel` | `rgb(250 250 251 / 55%)` | 面板（玻璃，配 `--glass-blur`） |
| `--bg-elevated` | `rgb(255 255 255 / 65%)` | 浮层（玻璃，配 `--glass-blur`） |
| `--line` | `rgb(28 28 32 / 10%)` | 1px 细线（半透明） |
| `--shadow-float` | `0 8px 32px rgb(0 0 0 / 12%)` | 浮层深度阴影（唯一阴影分级） |
| `--text-1` / `--text-2` / `--text-3` | `#1C1C20` / `#56565E` / `#8E8E96` | 主/次/弱文字 |
| `--accent` | `#0060DF` | 系统蓝（浅底压暗保对比 ≥4.5:1） |
| `--accent-weak` | `rgb(0 96 223 / 10%)` | 选中态衬底 |
| `--danger` | `#C04A42` | 破坏性操作 |
| `--canvas-grid-dot` | `#CBCBD2` | M1 画布点阵 |

### 3.2 深色（Kinetic Typography 配色：#1E1E1E + 纯白 + 三色文本）

| 变量 | 值 | 用途 |
|---|---|---|
| `--bg-app` | `#1E1E1E` | 应用底色（深灰，非纯黑） |
| `--bg-panel` | `rgb(32 32 38 / 55%)` | 面板（黑玻璃） |
| `--bg-elevated` | `rgb(44 44 50 / 60%)` | 浮层（黑玻璃） |
| `--line` | `rgb(255 255 255 / 14%)` | 1px 细线 |
| `--shadow-float` | `0 8px 32px rgb(0 0 0 / 56%)` | 浮层深度阴影 |
| `--text-1` / `--text-2` / `--text-3` | `#FFFFFF` / `#A3A3A3` / `#6E6E6E` | 主/次/弱文字 |
| `--accent` | `#FFC60F` | 暖金黄（黑底对比 ≈11.5:1，撞色点睛） |
| `--accent-weak` | `rgb(255 198 15 / 14%)` | 选中态衬底 |
| `--danger` | `#FF453A` | 破坏性操作 |
| `--canvas-grid-dot` | `rgb(255 255 255 / 18%)` | M1 画布点阵 |

**三色文本纪律（Kinetic Typography 深色专属；浅色文本保持原色零变化）：**

| 色 | token | 深色值 | 专职 |
|---|---|---|---|
| 黄 | `--accent` | `#FFC60F` | **交互点睛**：选中/激活/焦点，仅 `--accent` |
| 蓝 | `--text-title` | `#4DA3FF` | **标题展示位**：面板名称、空态标题 |
| 橙 | `--text-readout` | `#FF8A1F` | **数值读数位**：状态栏读数、直方图读数、死黑/死白 |

**实心选中态（visionOS vibrant selection）：** `--on-accent`（深色 `#000000` / 浅色 `#FFFFFF`）为 accent 实心块上的文字色。

### 3.3 用色纪律

- **表面层级只有三级**：app < panel < elevated，浮层两级均为半透明玻璃（`backdrop-filter` 不支持时由 tokens.css 文末 `@supports` 回落实色，保可读性）。
- 文字对比度 ≥ 4.5:1（WCAG AA）；弱提示 `--text-3` 不用于关键信息。
- **三色纪律**（深色专属；浅色文本保持原色）：黄（`--accent`）= 交互点睛（选中/激活/焦点）、蓝（`--text-title`）= 标题展示位、橙（`--text-readout`）= 数值读数位。三色各有专职，此外不得用彩色文本。浅色 —text-title/—text-readout 取值同默认文字（零视觉变化）。
- **实心选中态**：分段控件/按钮激活时 `background: var(--accent); color: var(--on-accent);`（visionOS vibrant selection），取代旧 accent-weak 衬底 + accent 字的弱对比方案。
- **Canvas 图表标注（轴刻度/轴题）必须用 `--text-2`**，不得用 `--text-3`。深色模式 `--text-3 = #6E6E6E` 对 `#1E1E1E` 底对比度只有 2.86:1，远低于 WCAG AA 4.5:1；`--text-2 = #A3A3A3` 对比度 5.7:1 达标。浅色模式 `--text-2 = #56565E` 同样比 `--text-3 = #8E8E96` 更清晰。
- M4 直方图通道色（`--lab-hist-*`）为功能色，不借作装饰。
- 两主题 accent 不同色（蓝/黄）是**有意的主题对撞**：浅色蓝 = 空间秩序，深色黄 = 海报张力；功能色（danger、直方图通道）两主题保持一致语义。

## 4. 字体与排版

| 角色 | 字体栈（变量） | 说明 |
|---|---|---|
| UI 正文 | `--font-ui`：Noto Sans SC / 思源黑体系 | 对应 skill 推荐的 Swiss 极简风（Inter 类），中文环境用思源黑体落地 |
| 标题/展示 | `--font-display`：Noto Serif SC 衬线系 | 设定集排版感，仅标题与展示位 |
| 数字/参数 | `--font-mono`：JetBrains Mono | 坐标、缩放、色值等参数一律等宽 |

- 字阶固定 6 级：`--text-xs/sm/md/lg/xl/2xl` = 12/13/14/16/20/28，不新增级别。
- 正文行高约 1.5；正文不小于 12px。
- **M4 分析面板为 Apple 风格区**：面板标题用 `--font-ui` 600（无衬线，SF 感，不用衬线）；其余模块（M1/壳/空态展示位）标题仍衬线。

## 5. 间距 · 圆角 · 动效

- **间距**：4px 基数，`--space-1` 到 `--space-10`（4/8/12/16/20/24/32/40），工具类密度取中档——面板内 16–20px，区块间 24px+。
- **圆角**：`--radius-sm/md/lg/xl` = 4/8/16/24；按钮、输入框用 4–8，浮层 8，**大浮层（输出面板级）24**（visionOS 窗口连续圆角），工具岛保留胶囊。胶囊控件 999px。
- **材质分层**（`--bg-glass-soft`）：窗口级玻璃（`--bg-elevated`）+ 内层二级材质（`rgb(255 255 255 / 35%)` 浅 / `rgb(255 255 255 / 6%)` 深）替代 1px 细边，靠亮度差构建层级而非描边。
- **动效**：仅透明度与位移，`--motion-fast` 120ms / `--motion-base` 180ms ease-out（hover 反馈落在 150–300ms 的 UX 推荐区间内）；不做装饰性动画。
- **翻页式切换动画**（M4 分析面板工具切换）：双 `.lab-panel` 绝对定位（`inset: 0`）同帧反向平移——方向由切换前后工具在左栏的相对位置决定（`toolDir`），切到下方工具时旧页向上滑出/新页自下方滑入，反之反向；250ms ease-out 纯 `translateY ±100%` 平移，无淡入淡出。外壳加 `is-switching` 期间 `overflow: hidden`。**必须用 `useLayoutEffect` 同步设退出页**（不可用 `useEffect`，否则首帧闪现新面板终态）。
- **reduced-motion 豁免**：翻页式切换动画是功能性空间线索（指示相对位置），**`.lab-panel` 必须从 `@media (prefers-reduced-motion: reduce)` 中豁免**，不被系统动画开关抑制。其余元素（`.lab-output`/`.lab-info__popover`/`.lab-dock__handle`）仍遵守 reduced-motion。
- **图表容器阴影**：`.lab-hist__canvas-wrap` 加 `box-shadow: 0 2px 12px rgb(0 0 0 / 14%)` 提升层次感，双主题均可辨。

## 6. 布局骨架

四大模块共用一套骨架（开发文档 §6.3）：顶栏 48px · 工具栏 56px · 内容区 · 检查器 280px · 状态栏 28px。

- 工具栏/检查器内容由模块插件注入——**布局一致性即扩展性**，新模块不得自创骨架。
- 面板可折叠、宽度可拖，布局状态记忆。
- 顶栏/状态栏/工具岛/浮层面板同为玻璃材质，是"漂浮在同一空间"的统一语汇。

## 7. 交互与可用性细则

来自开发文档 §6.4 + skill UX 准则库（高严重级条目）：

1. **键盘可达**：全功能键盘可操作；Tab 顺序与视觉顺序一致；可见焦点环（用 `--accent`），禁止无替代的 `outline: none`；命令面板 `Ctrl+K`（P1）。
2. **当前位置可辨**：激活的模块/工具/页签必须有高亮指示（`--accent-weak` 衬底或点睛色下划）。
3. **反馈**：可点元素 `cursor: pointer`；hover 有过渡态；耗时操作有进度且可取消；破坏性操作二次确认（`--danger`）。
4. **空状态必引导**：示例模板、示例图库、快捷键卡片，不允许大白屏。
5. **图像永不失焦**：画布缩放走 GPU 变换，1:1 查看有明确入口。
6. **触控/点击目标**：可交互元素不小于 24px（桌面指针场景；移动端适配时升至 44px）。
7. **图表光标竖线**：所有分析工具（直方图色阶 tab / 饱和度）的图表区均需指示光标对应像素在曲线上的位置。CSS 实现（`.lab-hist__cursor-line`）：1px 宽 `--text-1` 45% 不透明竖线，`position: absolute`，`top: 16px; bottom: 36px` 限定绘图区不越轴，`transition: left 60ms ease-out` 跟随。饱和度用 `pointer.s`（0–100%），色阶用 `luma(r,g,b)/255*100%`。
8. **拖拽期间禁用过渡**：拖拽调面板宽度时，被 `right` 过渡跟随的元素（如 `.lab-viewport__controls`）必须加 `.is-resizing` class 临时收窄 `transition-property`（去掉 `right`），实现即时跟随无拖尾；点按收起/展开时保留平滑过渡。
9. **M3 悬浮工具栏收起**（2026-08-16 用户两轮反馈定稿）：向下滚动收起阈值 = **100px**（滚到即收起，轻微滚动不触发，太敏感会导致搜索行按钮点不到）；恢复条件 = 滚回顶部，或鼠标进入页面顶部热区（clientY ≤ **176**，须覆盖工具栏两行全高，否则收起后移回按钮位置也无法恢复）；**高级筛选浮层展开期间工具栏不收起**（保证「高级筛选」按钮始终可点）。
10. **玻璃浮层进出场动画惯例**：一切玻璃浮层（高级筛选浮层、补全下拉、批量小窗等）必须带**对称进出场动画**——进场沿出现方向位移 6–16px + 淡入，退场反向 + 淡出，时长 `--motion-base`（180ms ease-out）；退场播完再卸载（200ms 编排），退场期间 `pointer-events: none` 防误点。属用户点名的功能动画，不随 reduced-motion 禁用（口径同 BatchPanel）。
11. **悬浮元素磨砂失效规避**：需 backdrop 磨砂的浮层若处于带 `backdrop-filter`（或 transform / filter / opacity）的祖先内，会被 Backdrop Root 限制而磨砂失效——此类浮层一律 **portal 挂 `document.body` + `fixed` 定位**，位置用 `getBoundingClientRect()` 内联写入，并在打开期间持续校正（rAF + 250ms 定时 + `document.fonts.ready`，位置无变化时跳过重渲染）；点选与点击外部关闭等事件需同时排除 portal 内的节点。
12. **温度 = 全局筛选精度**：温度滑杆同步控制所有具备连续阈值的筛选——取色 Lab 距离阈值 `10 + 5t`（t=3 默认 = 25）、冷暖 W 阈值表 `20/16/12/8/5/3`（t=3 默认 = 8）、标签同义/模糊随温度放开（t=0 精确、t≥1 同义、t≥2 编辑距离/bigram）；分类型筛选（明度、文件夹）不跟随；默认 t=3 必须保持旧口径。阈值函数集中在检索引擎定义并导出，**UI 命中高亮与筛选引擎共用同一阈值**。
13. **搜索行星标按钮**：★ 按钮为标星筛选开关，实心选中态（`--accent` 底 + `--on-accent` 字形），与其他筛选 AND 叠加；「清空全部」与切换图库时复位。

## 8. 反模式清单（Avoid）

- 组件内写死 hex 色值 / rgba（必须走 CSS 变量）
- 浮层用实色不透明底（丧失玻璃材质；`backdrop-filter` 回落场景除外）
- 移除焦点环、仅用 placeholder 当表单标签
- emoji 充当图标；混用扁平与拟物风格
- 瞬间无过渡的状态跳变（0ms）或纯装饰动画
- 横向滚动、固定像素容器宽、禁用缩放
- 灰字叠灰底（对比度不足 4.5:1）

## 9. 交付前 Checklist

- [ ] 颜色全部来自 `tokens.css` 变量，双主题下都核对过
- [ ] 浮层走玻璃材质（半透 + `--glass-blur` + `--shadow-float`），无实色浮层漏网
- [ ] 文字对比度 ≥ 4.5:1（重点查 `--text-3` 与点睛色的组合）
- [ ] 焦点态可见、键盘可达、Tab 顺序合理
- [ ] 可点元素有 hover 过渡（120–180ms）与 `cursor: pointer`
- [ ] 图标为 SVG，无 emoji
- [ ] 空状态有引导
- [ ] 动效仅透明度/位移，尊重 reduced-motion
- [ ] `npm run build` + `npm run lint` 通过，dev server 实际核对过页面

## 附录：skill 检索依据（ui-ux-pro-max v2.11.0）

| 检索 | 关键结论 | 本文落点 |
|---|---|---|
| `--design-system "photography tool creative studio professional minimal"`（variance 3 / density 6，2026-07-28） | 极简方向、WCAG AA、交付检查项 | §2、§9（v1.0） |
| `--domain product "creative tool productivity desktop professional"`（2026-07-28） | 生产力工具 = Flat Design + 微交互 + Minimalism；功能色层级清晰 | §1、§3.3（v1.0） |
| `--domain typography "editorial professional minimal tool"`（2026-07-28） | Swiss 极简单字族字重分层 / 衬线+无衬线编辑风 | §4（v1.0） |
| `--domain ux "keyboard navigation focus feedback loading empty state"`（2026-07-28） | 焦点环、键盘可达、空态引导、激活态指示（均 High 级） | §7（v1.0） |
| `--domain style "spatial UI visionOS floating depth light"`（2026-07-28，v2.0） | Spatial UI (VisionOS)：frosted glass 15–30% 透明、blur+saturate、24px 连续圆角、深度阴影、悬浮窗 | §1、§2、§3.1、§5 |
| `--domain style "glassmorphism"`（2026-07-28，v2.0） | backdrop blur 10–20px、半透白 15–30%、1px 高光细边、文字对比 ≥4.5:1 | §3、§8、§9 |
| 深色"Kinetic Typography 配色"（2026-07-28，v2.0，无库内直接命中，按风格语言定稿） | 纯黑场 + 纯白字 + 单一高饱和电光色（黄）撞色 | §3.2 |
| v2.1 用户反馈修正（2026-07-28）：深色基底 #1E1E1E + 三色纪律（蓝标题/橙读数）+ 实心选中态 + 二级材质 | 深色非纯黑、Kinetic Typography 三色体系完整落地、visionOS vibrant selection、材质分层替代描边 | §3.2、§3.3、§5 |
| v2.2 Apple 风格重做（2026-07-28，用户指定参照 macOS Photos 直方图，非 skill 检索） | 平滑填充曲线 + screen 混合 + 无横网格线 + 面板标题无衬线 600 | §2、§4 |

> skill 检索给的营销页模式（Exaggerated Minimalism、纯黑白撞色）与"桌面工具"定位不符，已弃用；色彩以项目既有 tokens 演进为准，未采用 skill 色板。
