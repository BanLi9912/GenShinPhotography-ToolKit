import { Figure } from "../Figure";
import type { Guide } from "./types";

/**
 * 图像超分（SR）使用说明。
 *
 * 配图：`FIGURES` 是**唯一数据源**（序号 → 图注 + 该截什么），正文用 `fig("01")` 引用，
 * 文件放 `web/public/help/superres/01.png` 起（png/jpg/jpeg/webp 均认）。
 * 图不在时页面自动显示带文件名与拍摄说明的占位。
 */
const FIGURES = {
  "01": {
    caption: "原图区（拖入或点击选择）",
    brief:
      "刚进 /superres 的左侧「原图」卡：虚线拖放区 + 「拖入截图，或点击选择」文案 + 「支持 PNG / JPG / WebP」提示。",
  },
  "02": {
    caption: "两条线：超分 / 纹理保全",
    brief:
      "「超分设置」卡最上方那两个并排的模式按钮（超分 / 纹理保全），当前选中态可见。",
  },
  "03": {
    caption: "超分线：倍率与降噪档位",
    brief:
      "选「超分」后出现的两排按钮：上一排 2x/3x/4x（带「四档降噪 / 三档降噪」副标），下一排是当前倍率对应的降噪档（如 2x 的无降噪 / 1x 降噪 / 2x 降噪 / 3x 降噪）。",
  },
  "04": {
    caption: "超分线的两个开关",
    brief:
      "「抗锯齿预处理」与「超分后压缩回原分辨率」两个勾选项，连同它们右侧那两行说明文字。",
  },
  "05": {
    caption: "纹理保全线",
    brief:
      "切到「纹理保全」后的设置区：只剩「处理后压缩回原分辨率」一个开关，以及下面那行「SuperScale 1x 抗锯齿 → AnimeSharpV4 2x 超分…」提示。",
  },
  "06": {
    caption: "开始按钮与处理中进度",
    brief:
      "处理进行中的状态：主按钮显示「处理中…」，下面是真实进度条与百分比/阶段文字，右下角「取消」左边是这次实际用的后端标签（GPU · WebGPU · 显卡名，或 CPU · WASM）——这枚标签必须拍进去。",
  },
  "07": {
    caption: "结果对比小窗与「下载 PNG」",
    brief:
      "处理完成后的「结果」卡：左半原图 / 右半结果、中间带圆形把手的对比小窗（画框左上角是「原图」角标、右上角是「结果」角标）+ 「下载 PNG」按钮；按钮文案此时应为「重新超分 → Nx」或「重新处理」。",
  },
} as const;

type FigKey = keyof typeof FIGURES;

const fig = (n: FigKey) => (
  <Figure dir="superres" n={n} caption={FIGURES[n].caption} brief={FIGURES[n].brief} />
);

export const SUPERRES_GUIDE: Guide = {
  intro: (
    <>
      <p>
        图像超分把游戏与动漫截图<strong>放大到 2/3/4 倍</strong>，或做一次
        <strong>分辨率不变的降噪锐化</strong>。全部推理都在<strong>你自己的机器上</strong>跑
        （浏览器内 WebGPU / WASM），图片不上传任何服务。
      </p>
      <p>
        它以「导航栏里的一个独立工具」形式存在，左下角工具岛里没有它——从顶栏进「图像超分」。
        用法是三步：<strong>放进一张图 → 选一条线和一个档位 → 点开始</strong>，完成后下载 PNG。
      </p>
    </>
  ),
  sections: [
    {
      id: "start",
      title: "一、放图与开始",
      body: (
        <>
          {fig("01")}
          <ul>
            <li>
              <strong>把图拖进左侧虚线框</strong>，或<strong>点击该区域</strong>从系统里挑一张。
              支持 PNG / JPG / WebP。
            </li>
            <li>
              设置卡底部的主按钮一直是
              <strong>「开始超分 → Nx」</strong>（超分线）或
              <strong>「开始处理 → 降噪锐化」</strong>（纹理保全线）——
              还没放图时它是灰的，放好图才能点。<strong>不会自动跑</strong>，你得自己点。
            </li>
            <li>
              跑完一次后文案变成<strong>「重新超分 → Nx」/「重新处理」</strong>；
              但<strong>换倍率、换降噪档或动那两个开关会立刻作废已有结果</strong>（结果卡与对比小窗一起消失，
              按钮回到「开始超分」），想对照不同档位的产物，先把上一档的结果下载留档。
            </li>
            <li>
              <strong>3x / 4x 与纹理保全线的模型不在默认安装里</strong>：先去
              <strong>设置 → 通用 → 「模块组件」→ 可选模型组件</strong>点「安装」
              （纹理保全线约 34MB；CUGAN 3x/4x 线约 1GB+、含 Python 工具链，10–30 分钟）。
              没装就点开始会直接失败——安装按钮本身需要开发服务器在运行。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "branches",
      title: "二、两条线怎么选",
      body: (
        <>
          <p>设置卡最上方是模式切换，两条线的目标完全不同：</p>
          {fig("02")}
          <ul>
            <li>
              <strong>超分</strong>（Real-CUGAN）：<strong>真的把图放大</strong>到 2/3/4 倍，
              并可选带一档降噪。想要更高分辨率、想印、想当壁纸，走这条。
            </li>
            <li>
              <strong>纹理保全</strong>（SuperScale → AnimeSharpV4）：<strong>默认输出原尺寸</strong>，
              做的是降噪 + 锐化，重点在保住线条与纹理不被抹平。
              <strong>耗时明显高于超分线</strong>，但它对动漫/游戏截图那种"干净线条"更友好。
            </li>
          </ul>
          <p>
            简单判据：<strong>要更大 → 超分；要更干净但尺寸不变 → 纹理保全。</strong>
          </p>
        </>
      ),
    },
    {
      id: "cugan",
      title: "三、超分线：倍率与降噪档",
      body: (
        <>
          {fig("03")}
          <h3>倍率</h3>
          <ul>
            <li>
              <strong>2x</strong>：四档降噪可选（无降噪 / 1x / 2x / 3x）——档位最全，最常用。
            </li>
            <li>
              <strong>3x / 4x</strong>：三档降噪（无降噪 / 保守 / 3x）。
            </li>
            <li>
              输出尺寸 = 原图 × 倍率。任一边算出来<strong>超过 16384 像素</strong>会提示你改用更低的倍率——
              注意这个判定看的是<strong>放大后</strong>的尺寸，所以勾了「压缩回原分辨率」的大图一样会被拦下。
            </li>
          </ul>
          <h3>降噪档怎么挑</h3>
          <ul>
            <li><strong>无降噪</strong>：只放大。原图本身干净时用它，保留最多信息。</li>
            <li><strong>1x / 2x</strong>：轻度到平衡，图有轻微噪点或压缩痕迹时的常用区间。</li>
            <li><strong>保守</strong>（3x/4x）：介于无降噪与强降噪之间，改动克制。</li>
            <li><strong>3x</strong>：强降噪。噪得厉害的截图用它，代价是细节一起被抹一些。</li>
          </ul>
          <p>
            档位之上还会叠一道<strong>边缘去锯齿</strong>（只处理中高对比的边缘）——
            这是内置的，不用你开。
          </p>
        </>
      ),
    },
    {
      id: "cugan-switches",
      title: "四、超分线的两个开关",
      body: (
        <>
          {fig("04")}
          <ul>
            <li>
              <strong>抗锯齿预处理</strong>：先用 SuperScale 1x 把原图抗锯齿修复一遍，再进 Real-CUGAN 超分。
              适合<strong>锯齿明显或压缩痕迹重</strong>的游戏截图。开了之后进度会分两段走
              （先「抗锯齿 1/2」再「超分 2/2」），耗时相应变长。
            </li>
            <li>
              <strong>超分后压缩回原分辨率</strong>：放大处理完再高质量缩回原尺寸，
              得到<strong>分辨率不变的锐化增强</strong>。输出文件名会带 <code>_restored</code>。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "texture",
      title: "五、纹理保全线",
      body: (
        <>
          {fig("05")}
          <ul>
            <li>
              内部固定两步：SuperScale 1x 抗锯齿 → AnimeSharpV4 2x 超分。
              <strong>不跑边缘去锯齿</strong>（这条线的模型本身改动就克制，叠加反而糊）。
            </li>
            <li>
              <strong>「处理后压缩回原分辨率」默认开</strong>：输出原尺寸，得到"分辨率不变的降噪锐化"。
              把它关掉就是实打实的 2 倍输出。
            </li>
            <li>
              结果文件名：开＝<code>_texture_restored.png</code>，关＝<code>_texture.png</code>。
            </li>
            <li>
              耗时主要由 AnimeSharpV4 决定，<strong>比超分线慢不少</strong>——
              换档位多试两次前先有心理准备。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "run",
      title: "六、跑起来：进度与取消",
      body: (
        <>
          {fig("06")}
          <ul>
            <li>
              按 <strong>tile 分块</strong>推理并回报<strong>真实进度</strong>，不是"假装在动"的动画。
            </li>
            <li>
              进度行右侧会写明这次<strong>实际跑在什么上</strong>：
              <code>GPU · WebGPU · 显卡名</code> 或 <code>CPU · WASM</code>。
              GPU 初始化失败时会自动换一个干净的 Worker 退回 CPU，进度里会写
              「GPU 不可用，改用 CPU（WASM）」——嫌慢先看这一行是不是掉到 CPU 了。
            </li>
            <li>
              <strong>处理中可以随时「取消」</strong>，不会卡住页面。
            </li>
            <li>
              处理期间所有设置项会被<strong>锁住</strong>（灰掉）——这是刻意的：
              跑到一半换档位没有意义，还会让结果对不上参数。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "result",
      title: "七、结果与下载",
      body: (
        <>
          {fig("07")}
          <ul>
            <li>处理完在右侧「结果」区出图，点<strong>「下载 PNG」</strong>存到本地。</li>
            <li>
              结果小窗是<strong>前后对比</strong>：左半是<strong>原图</strong>、右半是<strong>结果</strong>，
              中间那条带圆形把手的竖线<strong>可以用鼠标左右拖动</strong>——同一处细节在线的两侧直接对看，
              不用来回切图。把手也能用键盘：<kbd>←</kbd> <kbd>→</kbd> 微调、<kbd>Home</kbd>/<kbd>End</kbd> 推到两端、双击居中。
            </li>
            <li>
              框内<strong>滚轮缩放</strong>（以光标为中心）、<strong>拖住画面平移</strong>，
              底部照旧是 适配窗口 / 缩小 / 放大 / 1:1；底部读数写明两边尺寸与显示比例，
              如 <code>1920×1080 → 3840×2160 · 2x · 显示 30%</code>。
              注意<strong>「适配窗口」是把画面填满画框</strong>（超出部分居中裁掉、可拖动查看），
              不是把整张图缩到框内。
            </li>
            <li>
              结果是<strong>放大过的</strong>（2x/3x/4x）还是<strong>原尺寸</strong>（勾了「压缩回原分辨率」）
              都不影响对比：小窗会把原图按同倍率对齐到结果的尺度上，两侧永远指着同一处像素。
            </li>
            <li>
              输出固定是 PNG（无损），所以你下载到的就是推理结果的原始像素，没有二次压缩损失。
            </li>
            <li>
              想对比不同档位的效果：<strong>先把当前结果「下载 PNG」留档，再换档重跑</strong>——
              换档位会立刻作废旧结果（结果卡与对比小窗一起消失）。只有<strong>切换模式</strong>
              （超分 ↔ 纹理保全）会保留结果卡供对照。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "faq",
      title: "八、常见问题",
      body: (
        <>
          <h3>第一次用很慢 / 一直在准备</h3>
          <p>
            首次运行要加载模型权重（按当前线 / 档位从本应用自身取，加载完浏览器会缓存），之后快很多。
            大图、高倍率与纹理保全线都会明显更慢，先用一张小图试一次最稳妥。
          </p>
          <h3>提示尺寸太大</h3>
          <p>
            <strong>放大后</strong>任一边超过 16384 像素就不可用（浏览器 canvas 的硬限制）——
            勾了「压缩回原分辨率」也一样按放大后的尺寸判。先用更低的倍率，或先把图裁小。
          </p>
          <h3>有没有更快的档</h3>
          <p>
            目前<strong>没有「质量 / 快速」选项</strong>——纹理保全线的高速变体（约 95% 质量、快 4–6 倍）
            还在待建，落地后才会出现在界面上。
          </p>
          <h3>图片会被上传吗</h3>
          <p>
            不会。模型与推理全在本机浏览器里，图片不出这台机器。
            权重是应用自带的静态资源，按需从本应用的地址取（开发环境下就是本机文件），
            加载完由浏览器缓存——代价换来的是隐私与缓存命中的离线可用。
          </p>
          <h3>和「图像分析」有什么不一样</h3>
          <p>
            那个是<strong>看和判断</strong>（直方图、取色、划线分析），不改像素；
            这个是<strong>改像素</strong>（放大、降噪），产出新文件。想先判断该不该超分、
            该用哪个档，可以先去「图像分析」看一眼噪点和边缘。
          </p>
        </>
      ),
    },
  ],
};
