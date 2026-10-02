# M1 灵感画布（canvas）

类 OneNote 的无限自由画布：随手贴图、批注、拉连接线，做拍摄企划与知识分享看板。

- 需求详见开发文档 §2.1
- 模块约定（§3.3）：对外只暴露 `api.ts`；模块状态在 `store.ts`；组件在 `components/`
- 与其他模块协作只经各自 `api.ts`（M3.6 定案 D7 针对 `core/events` 作出）：本模块接收入口 = `api.ts` 导出的 `queueImagesForCanvas(files)` + `LIBRARY_DRAG_MIME` 拖拽回取，禁止直接 import 对方内部实现

## 进度

- **任务 1.1 无限画布底子（已完成，已验收）**：`components/CanvasPage.tsx`——Stage 铺满内容区（ResizeObserver 跟随）、滚轮以指针为锚点缩放（5%–800%，`store.ts` 的 `MIN/MAX_ZOOM`）、按住空格拖拽平移；`components/GridDots.tsx`——点阵网格，单 Shape 视口内绘制，颜色走 token `--canvas-grid-dot` 随主题切换。视口与指针坐标在 `store.ts`（对应文档 §4.3 viewport，供会话恢复复用），应用壳状态栏经 `api.ts` 暴露的 `useCanvasStore` 实时显示缩放/指针（保存状态随任务 1.5 接入）。
- **任务 1.2 文本块（已完成）**：创建方式二选一——双击空白（任意工具下）或选中文本工具（T）后单击空白（点哪写哪）；`TextEditor.tsx` contentEditable 覆盖层编辑，失焦/Ctrl+Enter 提交、Escape 放弃（还原编辑前样式）、空文本自动移除；**局部样式**：文本模型为样式段 `StyleRun[]`（文字 + 局部粗体/字号/颜色，`richText.ts` 负责段运算/排版测量/编辑器序列化/选区偏移映射），编辑中选中部分文字即可对选中部分单独调粗体/字号/颜色（作用域严格"有选区 → 仅选区，否则整段并同步块级缺省"；工具条激活态/切换方向以编辑器实时内容为准；折叠光标时粗体/颜色走浏览器输入态，新输入即生效）；`TextNode.tsx` 单 Shape + sceneFunc 按 run 自绘（排版严格按 CSS 行盒模型：每行含块级 strut、行内各 run 共用基线、盒高度量由 DOM 探针实测，与编辑态 contentEditable 逐像素对齐，进出编辑不错位），宽度随内容自适应；`TextToolbar.tsx` 悬浮工具条——字号（输入框键盘输入，钳制 8–200 + 预设弹层，获焦全选、回车应用、Escape 取消，混合显示"—"；输入框获焦会夺走编辑器选区，mousedown 先捕获、应用时按显式区间作用并恢复焦点/选区）/粗体/颜色（预设色板 + `ColorPicker.tsx` 自定义滑块取色，RGB/HSL 读数）/对齐，编辑态同样显示；编辑中点工具条不退出编辑（工具条 mousedown 拦截 + 编辑器 blur 白名单），空文本也能先调格式再输入。
- **任务 1.3 图片元素（已完成）**：`imageFiles.ts` 导入管线（dataURL → 解码取尺寸）；导入三入口——图片工具按钮打开系统文件选择器（一次性动作，完成/取消回落选择工具）、窗口拖入落点创建、Ctrl+V 粘贴（指针位置，无指针则视口中心），多张级联偏移；默认原始尺寸、超出视口 80% 等比缩小；选中出现 Transformer 手柄（等比缩放 + 旋转，accent 色描边；锚点尺寸/边框/旋转偏移均按 1/zoom 折算保持屏幕恒定，命中区经自定义 hitFunc 再外扩 6 屏幕 px，旋转手柄为两端带箭头的圆弧自定义图标）；**先选中才可拖动**（防误拖，文本块同规）；`ImageNode.tsx` 变换结束把 scale 折算回宽高写回 store。图片二进制经 `assets.ts` 存 IndexedDB（§4.3 blob-ref，任务 1.5 落地）。
- **画布工具栏（灵动岛）**：应用壳左侧 56px 栏改为灵动岛式悬浮胶囊（`app/components/SideToolbar`），仅画布模块显示，切换模块时向左滑出隐藏（位移+透明度 180ms）；工具态存于 `store.ts` 的 `tool`，快捷键 V 选择 / T 文本 / Esc 取消并回选择工具。
- **任务 1.5 自动保存 + 会话恢复（已完成）**：`persistence.ts`——store 的 elements/viewport 变更 1 秒防抖整篇写入 IndexedDB（§4.3 格式；`core/storage/idb.ts` 单例，boards/assets 两表），页面隐藏/关闭立即 flush；启动读回恢复元素与视角（恢复完成后才订阅变更，避免恢复本身触发保存）；图片迁移为 blob-ref——`assets.ts` 资产缓存（assetId → objectURL，ImageNode 渲染源），导入时 blob 写入 assets 表（先注册缓存再写库，防保存 GC 误删导入中资产），文档只存引用，每次保存清理不再引用的孤本 blob（缓存中的保留；多画板时需合并所有文档引用再清理）；复制图片共享同一 assetId。状态栏"保存"显示上次自动保存时间（`store.ts` 的 `lastSavedAt`）。
- **任务 1.6 撤销/重做（已完成）**：快照栈——`store.ts` 的 `past`/`future`（上限 100，超出丢最旧），变更类动作（增/删/改文本属性/变换/复制/旋转）经 `pushHistory` 留 elements 快照（数据不可变，快照只是数组引用，开销极小）；`undo`/`redo` 落态时选中与编辑态收敛到仍存在的元素，会话恢复 `hydrate` 清空历史；无命中或无实际变化的变更（删除空集、改非文本元素、编辑后原样提交、选中文本按 R）不产生历史。多选整体移动改为首个 dragend 批量写回全部选中节点（`setElementsTransforms`），整组移动撤销算一步；其余节点的 dragend 因坐标已一致自然跳过。快捷键 Ctrl+Z 撤销 / Ctrl+Y 重做；文本编辑态内 Ctrl+Z 归 contentEditable 原生行为，不拦截。
- **操作历史面板（已完成，清单外追加）**：侧边工具栏分隔线下新增"历史"按钮，弹出灵动岛式悬浮小窗（`HistoryPanel.tsx`）——列出撤销栈里**可回到的各状态**（最旧在上：首行「初始状态」= 栈底，点击撤销全部；其后每行为"某操作完成后的状态"，标签/时间取产生该状态的那一步，`HistoryEntry.label/at`，每个变更动作带操作名，取色拖动等逐帧微调按 `coalesce` 合并键 1 秒窗口并步），"当前状态"分界，其下灰显为可重做操作；点击条目经 `jumpHistory(delta)` 一步跳转到该状态（之前的撤销 / 之后的重做），面板保持打开可连续定位；离开画布模块自动收起。
- 画布绘制所需 token 统一经 `useCssToken.ts` 桥接（MutationObserver 跟随主题切换），组件内零硬编码色值。
- **接收入口（任务 M3.6，M3 图库送来）**：①**按钮送图**——`api.ts` 导出 `queueImagesForCanvas(files)` 只入待收队列（`incoming.ts`），画布挂载且 `startCanvasPersistence()` 的 idb 水合完成后消费并 toast「已接收 N 张图片」——跳转前直接 `addElement` 会被水合整体覆盖，故必须有此队列（`startCanvasPersistence` 因此改为返回水合完成 Promise）；②**拖拽落图**——`CanvasPage.handleDrop` 先查自定义 MIME `application/x-ystk-library-items`（payload 只有条目标识，经 `library/api.getLibraryItemFile` 回取 File）再走原 OS 文件分支（`dataTransfer.files`；应用内拖拽该字段必为空），落点世界坐标为第一张中心、其余级联 +24px；两分支共用提升到 `incoming.ts` 的 `importImageFile(file, world, ctx)`（原 CanvasPage 内部实现，视口尺寸改参数传入，OS 拖入/文件选择/粘贴行为不变）。
