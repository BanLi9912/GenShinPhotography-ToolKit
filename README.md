# YuanShe ToolKit · 原摄工具箱

本地优先的**游戏摄影工具箱**——浏览器应用，无账号、无云服务、不上传你的图。默认离线可用：数据存在你自己的浏览器（IndexedDB）与你自己磁盘上的图库文件夹里。

面向游戏/动漫截图的后期与整理工作流：贴图做企划、分析色彩与影调、本地 AI 超分、参考图库检索。

> 版本 **0.3.0**（以 `web/src/app/version.ts` 的 `APP_VERSION` 为准）

---

## 模块现状

| 代号 | 模块 | 状态 | 一句话 |
|---|---|---|---|
| **M1** | 灵感画布 | ✅ 可用 | 类 OneNote 的无限自由画布，随手贴图、批注、拉线，做拍摄企划与知识分享看板 |
| **M2** | 排版工房 | 🚧 未开工 | 高自由度排版系统，拖入图像 + 装饰元素拼装作品，模板以 JSON 导入导出 |
| **M3** | 参考图库 | ✅ 可用 | 绑定本地文件夹，本地算力分析主体元素与主色调，索引随文件夹走，支持关键字 / tag / 颜色搜索 |
| **M4** | 图像分析 | ✅ 可用 | 直方图、饱和度分布、黑白关系等色彩科学工具，特色功能为划线取色分析 |
| **SR** | 图像超分 | ✅ 可用（2x 开箱） | Real-CUGAN 本地 AI 超分：一键放大 2x / 3x / 4x 并可调降噪档，游戏与动漫截图细节优先 |

每个模块都内置**使用说明**（应用内 → 设置 → 关于 → 使用说明），带截图与逐节操作讲解。

---

## 快速开始

### 方式一：一键安装脚本（推荐，Windows）

```bat
scripts\install.bat
```

脚本会（**逐项问你确认，默认 N**，不会静默改系统）：

1. 只读探测环境（系统架构 / curl / PowerShell / tar / 系统 Node / Python / 组件状态）；
2. 下载**便携 Node.js 到仓库内 `.tools\node`**（不改系统 PATH、不污染系统安装）——镜像优先 `registry.npmmirror.com`，失败回退 `nodejs.org`；
3. 装 npm 依赖（同样镜像优先，失败回退官方源）并跑一次自检；
4. 询问是否安装**两条可选线**（见下文「可选组件」）；
5. 询问是否立即启动。

装完双击 `scripts\start-web.bat` 即可（会自动打开 `http://localhost:5173/`）。

**脚本要求**：Windows x64；有 `curl` 或 PowerShell 之一（下载用）；有 `tar` 或 PowerShell（解压用，Win10 1803+ 自带 tar）。

### 方式二：手动安装（任何平台）

需要 **Node.js `^20.19.0 || >=22.12.0`**（本仓库开发用 v24.18.0 / npm 11.16.0）。

```bash
cd web
npm install        # 必须带 devDependencies 安装，见下方说明
npm run dev        # 打开 http://localhost:5173/
```

> **不要用 `npm ci --omit=dev`**：2x 超分的权重来自 npm 包 `upscalejs`，而 `predev` / `prebuild` 要从 `node_modules/upscalejs/dist/models` 把资产复制到 `web/public/superres-assets/`。省掉 devDependencies 会构不出这部分资源。
> `web/package-lock.json` 已随仓库提供，`npm install` 装出的版本与本项目开发环境一致。

其它常用命令：

```bash
cd web
npm run build      # tsc 类型检查 + vite 构建（产物 web/dist/）
npm run lint       # oxlint
```

### 环境要求

- **浏览器**：需要 Chromium 系（Chrome / Edge）。参考图库绑定本地文件夹用的是 File System Access API（`showDirectoryPicker`），Firefox / Safari 不支持；且必须经 `localhost` 或 https 访问（安全上下文要求）。
- **运行时不依赖任何外部 CDN**：装完即完全离线可用（例外：可选的云端识图，以及可选的 Ollama 向量搜索）。

---

## 可选组件

不装也能跑；装了多出对应能力。**应用内 → 设置 → 通用 → 模块组件**可看状态与一键安装（等价于脚本的 `/texture`、`/cugan` 参数）。

| 线 | 内容 | 体积 / 依赖 | 缺了会怎样 |
|---|---|---|---|
| **纹理保全** | SuperScale 1x + AnimeSharpV4 2x 专业档 | 约 66 MB；需 Python + venv + torch(CPU) —— 由脚本自动准备 | 2x 只剩 `upscalejs` 自带的 5 档基础模型 |
| **CUGAN 3x / 4x** | Real-CUGAN 六档 | 约 32 MB；同一套 Python 工具链 | 3x / 4x 点了会报"模型加载失败"（按钮仍显示） |
| **向量搜索** | 语义检索（默认词典引擎之外） | 需自装 [Ollama](https://ollama.com/) + `ollama pull bge-m3` | 自动回落到词典引擎，不报错 |
| **云端识图** | 参考图库的 AI 打标/描述 | 需你自己的 API key（应用内填，存浏览器本地） | 识图不可用，其余功能不受影响 |

**权重与许可边界（重要）**：本仓库**不包含任何模型权重文件**，也不随包分发权重。转换工具链与官方渠道下载地址在 `web/scripts/convert-sr-models/README.md`（含逐步命令与数值校验标准）。

- Real-CUGAN（bilibili）上游仓库无 LICENSE 文件，请自行确认授权；
- Kim2091 的 `2x-AnimeSharpV4` / `1x-SuperScale` 为 **CC BY-NC-SA 4.0（非商用）** —— 请仅在符合其条款的前提下本地使用；
- `upscalejs`（npm 包）未声明 `license` 字段。

即：**每个使用者从权利人处自行下载、本地转换、本地使用**。

---

## 已知限制

- **Windows 优先**：一键脚本只写了 Windows x64；macOS / Linux 走"方式二"手动安装（未实测）。
- **GPU 加速是尽力而为**：超分优先 WebGPU，失败自动回落 WASM/CPU（进度里会写明当前后端）。NVIDIA 独显上曾有浏览器进程级崩溃记录，回落核显即可正常（可预期后续修）。
- **超分 3x / 4x 必须先装模型组件**（见上），否则点击报错。
- **识图需要你自己的 key**，且 key 存在浏览器 IndexedDB 里（明文，不落磁盘文件）；清除浏览器数据会丢。
- **说明书配图不全**：M1 / M4 / SR 的说明页部分章节还是「待补截图」占位（M3 配图完整）。
- 部分**内部开发文档、任务卡与历史留痕不在本仓库内**（本项目另行保管），本仓库只含可运行的应用源码与面向使用者的文档。

---

## 目录结构

```
scripts/                 # 安装与启停脚本（Windows .bat，GBK 编码）
  install.bat            #   一键安装（环境探测 + 必需组件 + 两条可选线）
  start-web.bat          #   启动 dev server（默认 5173）
  stop-web.bat           #   停止 dev server
  make-share-package.bat #   导出"只含源码"的分享包（zip）
web/                     # 前端工程（React 18 + TypeScript + Vite）
  src/app/               #   应用壳、设置中心、使用说明
  src/core/              #   内核：存储(FSA/IndexedDB)、图像算法、诊断日志
  src/modules/           #   四个业务模块（canvas / layout / library / lab / superres）
  src/ui/  src/styles/   #   公共组件与设计 token（浅色/深色双主题）
  public/help/           #   使用说明配图
  scripts/               #   dev server 中间件用到的构建脚本、权重转换工具链
```

架构纪律（改代码前请读）：模块之间**禁止直接 import 对方内部实现**，只能经 `core/events` 或各自的 `api.ts` 通信；公共 UI 走 `src/ui/` 与 `src/styles/tokens.css`，**组件内零硬编码色值**（CSS 变量双主题）。

---

## 许可

本项目代码以 **MIT** 许可发布，见 [`LICENSE`](LICENSE)。

第三方内容（模型权重、依赖包、说明页截图中的游戏与动漫画面）**不适用** MIT，其权利归各自权利人；详见上文「可选组件」与各目录下的 README。

---

## 分享给朋友（不含开发历史）

```bat
scripts\make-share-package.bat
```

生成只含应用源码的 zip（不含 `.git` 开发历史、不含模型权重与本地数据），可直接发给别人。
