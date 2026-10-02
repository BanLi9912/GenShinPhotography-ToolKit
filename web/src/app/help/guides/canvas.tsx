import { Figure } from "../Figure";
import type { Guide } from "./types";

/**
 * 灵感画布（M1）使用说明。
 *
 * 配图：`FIGURES` 是**唯一数据源**（序号 → 图注 + 该截什么），正文用 `fig("01")` 引用，
 * 文件放 `web/public/help/canvas/01.png` 起（png/jpg/jpeg/webp 均认）。
 * 图不在时页面自动显示带文件名与拍摄说明的占位。
 * 序号对照表另见 `web/public/help/canvas/README.md`（补图只改那边与本表）。
 */
const FIGURES = {
  "01": {
    caption: "空画布：左侧工具岛与底部状态栏",
    brief:
      "刚进灵感画布的样子：点阵网格的空画布，左侧工具岛整条（选择 / 文本 / 图片 / 置灰的便签 — 连接线 / 历史 / 导出导入 — 清空画布），以及底部状态栏的缩放 / 指针 / 保存三组读数。",
  },
  "02": {
    caption: "文本块编辑态与文字工具条",
    brief:
      "双击空白新建一个文本块、正在输入的样子：块内带光标的编辑态，上方是文字工具条（字号输入框 + 预设下拉、粗体、字体颜色、对齐三档）。",
  },
  "03": {
    caption: "选中图片：四角缩放手柄与上方旋转手柄",
    brief:
      "单击选中一张图片后的状态：accent 色描边的选框、四角缩放手柄、上方那枚旋转手柄（圆形箭头图标）。",
  },
  "04": {
    caption: "框选与多选（虚线框）",
    brief:
      "建议拼图：左＝在选择工具下拖空白拉出的框选矩形（半透明块），框住多个元素；右＝Ctrl+点击逐个加选后的多选态——每个元素一圈虚线框，没有大边框与手柄。",
  },
  "05": {
    caption: "拖动时的对齐参考线",
    brief:
      "拖动一个元素靠近另一个元素的边或中线时：画面上出现 accent 细参考线、元素被吸附对齐的瞬间（两个元素的边缘成一条线）。",
  },
  "06": {
    caption: "连接线与它的工具条",
    brief:
      "一条连在两个元素之间的曲线，以及曲线中点上方弹出的工具条：颜色四档（自动 / 灰 / 红 / 蓝）— 分隔线 — 线头三档（单向箭头 / 双端圆点 / 无）。",
  },
  "07": {
    caption: "操作历史小窗",
    brief:
      "工具岛「历史」打开的小窗整块：最上面一行「初始状态」，其下若干「操作名 + 时间」行，金色圆点的「当前状态」分界，再下面灰显的是可重做的行。",
  },
  "08": {
    caption: "导出 / 导入菜单",
    brief:
      "工具岛最下方那枚导出按钮悬停展开的菜单三项：导出 PNG 图像 / 导出工程文件 / 导入工程文件。",
  },
  "09": {
    caption: "清空画布的二次确认",
    brief:
      "点垃圾桶后弹出的确认框：标题「清空画布」、正文写着删除全部 N 个元素且「视口保持不变，可用 Ctrl+Z 撤销」、危险色的确认按钮。",
  },
} as const;

type FigKey = keyof typeof FIGURES;

const fig = (n: FigKey) => (
  <Figure
    dir="canvas"
    n={n}
    caption={FIGURES[n].caption}
    brief={FIGURES[n].brief}
  />
);

export const CANVAS_GUIDE: Guide = {
  intro: (
    <>
      <p>
        灵感画布是一张<strong>无限大的白板</strong>：随手贴图、写批注、拉连接线，
        用来做拍摄企划、参考拼贴、知识分享看板。没有画板尺寸、没有图层、也没有「保存」按钮——
        想到哪写到哪，往外摆多远都行。
      </p>
      <p>
        内容全部存在<strong>本机浏览器</strong>里（IndexedDB），改完自动保存，
        下次打开原样回来。它<strong>不联网、不上传</strong>（会花钱的云端识图只属于参考图库，画布本身不碰网络）。
      </p>
    </>
  ),
  sections: [
    {
      id: "enter",
      title: "一、界面：左上右下各管什么",
      body: (
        <>
          {fig("01")}
          <ul>
            <li>
              <strong>顶栏</strong>：点模块名「灵感画布」进本模块。左侧那枚工具岛
              <strong>只在画布模块显示</strong>，切到别的模块它会滑走、再回来又滑回来。
            </li>
            <li>
              <strong>左侧工具岛</strong>（自上而下三组）：工具（选择 / 文本 / 图片 /
              <strong>便签（灰的，还没做）</strong>）— 动作（连接线 / 历史 / 导出导入）—
              <strong>清空画布</strong>（垃圾桶，破坏性动作单独隔开）。
            </li>
            <li>
              <strong>底部状态栏</strong>：缩放百分比、指针的世界坐标、上次自动保存的时间。
              摆位、对对齐时用得上。
            </li>
            <li>
              <strong>背景点阵网格</strong>只是参照物，随主题明暗变化，
              <strong>不会出现在导出的图里</strong>。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "viewport",
      title: "二、看：缩放与平移",
      body: (
        <>
          <ul>
            <li>
              <strong>滚轮缩放</strong>：范围 <strong>5% – 800%</strong>，
              而且<strong>以光标位置为锚点</strong>——想看清某处就把光标放那儿再滚，不会跑偏。
            </li>
            <li>
              <strong>按住 <kbd>空格</kbd> 再拖动 = 平移</strong>：光标变成抓手，怎么拖怎么走，
              松开空格即退出（画布不像图像分析那样能直接拖画面，这是防误触的取舍）。
            </li>
            <li>
              左下角状态栏会实时跟着显示<strong>缩放</strong>与<strong>指针坐标</strong>，
              想确认两块图是不是齐平，看数字比看眼睛准。
            </li>
            <li>每次打开都会恢复你上次的视角（缩放与位置一起回来）。</li>
          </ul>
        </>
      ),
    },
    {
      id: "text",
      title: "三、写：文本块与文字工具条",
      body: (
        <>
          <p>
            两种建法：<strong>双击空白</strong>（任何工具下都行），
            或者按 <kbd>T</kbd> / 点工具岛「文本」后<strong>单击空白</strong>——点哪写哪。
          </p>
          {fig("02")}
          <ul>
            <li>
              <strong>改文字</strong>：双击文本块进入编辑（<kbd>Esc</kbd> 放弃并还原编辑前的样式，
              点别处或 <kbd>Ctrl</kbd> + <kbd>Enter</kbd> 提交）。<strong>一个字都没写的空块会自动消失</strong>。
            </li>
            <li>
              <strong>文字工具条</strong>（选中文本块后出现在块上方）：
              <strong>字号</strong>（键盘输入 8–200 回车生效，也可以从预设里挑，默认 16）/
              <strong>粗体</strong>（编辑中选中文字时 <kbd>Ctrl</kbd> + <kbd>B</kbd> 同效）/
              <strong>字体颜色</strong>（预设色板 + 自定义取色，能调 RGB 与 HSL）/
              <strong>对齐</strong>（左 / 中 / 右）。
            </li>
            <li>
              <strong>局部样式</strong>：编辑时<strong>选中一部分文字</strong>再调字号 / 粗体 / 颜色，
              只作用选中那一段；没有选区就作用于整段。所以一个块里可以混排大小字与配色。
            </li>
            <li>
              文本块的宽度随内容自适应，<strong>没有缩放 / 旋转手柄</strong>；挪位置直接拖它。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "image",
      title: "四、贴图：四个入口",
      body: (
        <>
          <ul>
            <li>
              <strong>工具岛「图片」按钮</strong>：打开系统文件选择器，可一次多选；
              选完（或取消）自动回到选择工具。
            </li>
            <li>
              <strong>把图片文件从桌面拖进窗口</strong>：落在指针所在的位置。
            </li>
            <li>
              <strong><kbd>Ctrl</kbd> + <kbd>V</kbd> 粘贴</strong>：直接贴剪贴板里的图，
              截图后马上贴最顺手；指针不在画布内就落在视口中心。
            </li>
            <li>
              <strong>从参考图库（M3）送过来</strong>：详情页「送出 → 送去画布」、网格右键
              「送去画布」、或批量小窗整批送（一次最多 50 张，超出会提示截断）。
              送完自动跳到画布并落成图片元素，右下角有「已接收 N 张图片」的提示。
              <strong>注意</strong>：跨模块要按按钮，把图库的图直接拖到画布上这条路走不通
              （两个模块不会同时在场），别在那边找拖拽。
            </li>
          </ul>
          <p>
            多张一起进来会<strong>依次错开</strong>摆放，不会叠成一摞。落图尺寸 = 原始像素；
            比视口 80% 还大时等比缩小（<strong>不会放大</strong>）。
          </p>
          {fig("03")}
          <ul>
            <li>
              <strong>改大小 / 角度</strong>：先<strong>单击选中</strong>图片，出现四角手柄
              （等比缩放）与上方旋转手柄；按 <kbd>R</kbd> 直接顺时针转 90°（只对图片有效）。
            </li>
            <li>
              <kbd>Ctrl</kbd> + <kbd>C</kbd> 复制选中（副本错开一点放）。
              连线不参与复制——它跟着元素走，不需要单独复制。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "select",
      title: "五、选与拖：单击 / 框选 / 多选",
      body: (
        <>
          {fig("04")}
          <ul>
            <li>
              <strong>单击选中</strong>。元素<strong>先选中才能拖</strong>——
              直接拖没选中的块它是不会动的（防误拖，文本块与图片同规）。
            </li>
            <li>
              <strong>拖空白 = 框选</strong>：拉出的矩形<strong>碰到</strong>哪个元素就选上哪个，
              一次圈一批。
            </li>
            <li>
              <strong><kbd>Ctrl</kbd> + 单击</strong>：逐个<strong>加选 / 退选</strong>。
              这样选出来的元素显示<strong>虚线框</strong>（大边框与手柄会隐藏，免得挡住画面）。
            </li>
            <li>
              <strong>多选后拖动其中一个 = 整组一起走</strong>，撤销时也算一步。
            </li>
            <li>
              <kbd>Delete</kbd> 删除选中；单击空白或按 <kbd>Esc</kbd> 取消选中
              （<kbd>Esc</kbd> 还会把工具切回选择）。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "snap",
      title: "六、对齐吸附与参考线",
      body: (
        <>
          <p>
            拖动元素时，附近元素的<strong>边与中线</strong>会浮出参考线并轻轻吸附
            （阈值 5 屏幕像素，与缩放无关），排整齐不用靠数值微调。
          </p>
          {fig("05")}
          <ul>
            <li>
              参考线只在<strong>拖动过程中</strong>出现，松手即收，不会留在画面上。
            </li>
            <li>
              不想要它：<strong>设置 → 灵感画布 → 「对齐吸附」</strong>关掉
              （关掉后既不吸附也不显示参考线）。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "connector",
      title: "七、拉线：连接线",
      body: (
        <>
          <p>把两个元素「连起来」（企划里的先后顺序、看板里的因果关系），两种拉法：</p>
          <ul>
            <li>
              <strong>选中两个元素 → 按 <kbd>L</kbd></strong>（或点工具岛「连接线」按钮），
              立刻连上。
            </li>
            <li>
              <strong><kbd>L</kbd> 进入点选模式，逐个点</strong>：点第一个元素出现虚线框
              （它成了起点）→ 点第二个就连上，而且<strong>终点自动变成新起点</strong>，
              可以一路串下去；再点一次起点 = 撤掉起点；<kbd>Esc</kbd> 退出模式。
            </li>
          </ul>
          {fig("06")}
          <ul>
            <li>
              连线是<strong>挂在元素上</strong>的：挪动两边任何一个，线实时跟着走，
              不用重拉。
            </li>
            <li>
              <strong>选中连线</strong>后弹出工具条：颜色四档（<strong>自动</strong> = 跟随主题 /
              灰 / 红 / 蓝）、线头三档（<strong>单向箭头</strong>（默认）/ 双端圆点 / 无）。
            </li>
            <li>
              同一对元素只会有一条线（重复拉不会叠成两条）；<kbd>Delete</kbd> 删除选中的线
              （删连线不会删元素）。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "history",
      title: "八、撤销 / 重做与操作历史",
      body: (
        <>
          <ul>
            <li>
              <kbd>Ctrl</kbd> + <kbd>Z</kbd> 撤销、<kbd>Ctrl</kbd> + <kbd>Y</kbd> 重做，
              最多记 <strong>100 步</strong>（更早的会被丢掉）。
            </li>
            <li>
              连续微调（比如拖字体颜色的滑块）会在 1 秒窗口内<strong>合并成一步</strong>，
              不会一次拖动产生几十步撤销。
            </li>
            <li>
              没有实际变化的动作不留记录（删空的、把非文本元素按 <kbd>R</kbd>、
              编辑后原样提交）——所以不会出现「撤销了一下却什么都没变」。
            </li>
          </ul>
          <p>
            工具岛「<strong>历史</strong>」按钮打开操作历史小窗，可以<strong>一步跳到任意状态</strong>：
          </p>
          {fig("07")}
          <ul>
            <li>
              最旧的在最上面，<strong>第一行是「初始状态」</strong>——点它就一步回到最初
              （等于把这批操作全部撤销）。
            </li>
            <li>
              其下每行是「某个操作完成后的状态」（操作名 + 时间），<strong>点哪行就跳到哪个状态</strong>。
            </li>
            <li>
              金色圆点那行是<strong>「当前状态」分界</strong>；它下面灰显的还可以重做，
              点一下往前跳（点最下面那条 = 全部重做回来）。
            </li>
            <li>
              面板保持打开，可以连着跳几次；切到别的模块会自动收起。
            </li>
            <li>
              <strong>文本编辑框里</strong>按 <kbd>Ctrl</kbd> + <kbd>Z</kbd> 是输入框自己的撤销
              （撤你刚打的字），不是画布的撤销；点走后再按才撤画布操作。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "save",
      title: "九、自动保存与会话恢复",
      body: (
        <>
          <ul>
            <li>
              改动停下约 <strong>1 秒</strong>后自动写入本机；切到别的标签页、关窗口时会立刻保存一次。
            </li>
            <li>
              底部状态栏的「<strong>保存</strong>」显示上次保存成功的时间；
              显示 <code>—</code> 表示本次会话还没有存过。
            </li>
            <li>
              下次打开应用，<strong>元素与视角原样回来</strong>。
              注意历史栈不跨会话——重开之后「初始状态」是重开时的样子。
            </li>
            <li>
              图片是按二进制存在本机的。<strong>清掉浏览器站点数据、换浏览器或换设备，画布内容就没了</strong>；
              要带走请用下面第十节的「导出工程文件」。
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "export",
      title: "十、导出、工程文件与清空画布",
      body: (
        <>
          <p>
            工具岛最下方那枚导出按钮<strong>悬停展开</strong>三项菜单：
          </p>
          {fig("08")}
          <ul>
            <li>
              <strong>导出 PNG 图像</strong>：把画布上的全部内容导成一张 PNG。按内容包围框四周留白，
              <strong>恒按 2 倍世界尺寸出图</strong>（4000px 宽的画布就出 8000px，与你当前缩放无关），
              背景取当前主题底色，<strong>不含点阵网格、选择框与参考线</strong>；
              文件名形如 <code>未命名画布-20261002-1147.png</code>。画布为空时会提示没有可导出的内容。
            </li>
            <li>
              <strong>导出工程文件</strong>：一个 <code>.ystkboard</code> 文件（元素 + 视角 +
              图片资产以 base64 内嵌在一份 JSON 里）。换机器、做备份、发给别人都用它——
              这是唯一能把<strong>图片本体</strong>一起带走的方式。
            </li>
            <li>
              <strong>导入工程文件</strong>：会<strong>整体替换</strong>当前画布（不是合并）。
              画布非空时会先弹确认；导入后<strong>历史栈清空</strong>，撤不回导入前的内容；
              文件里图片资产缺失的元素会被跳过。想保留旧内容，先导出备份。
            </li>
          </ul>
          <h3>清空画布</h3>
          {fig("09")}
          <ul>
            <li>
              工具岛最底下那枚<strong>垃圾桶</strong>：二次确认后一次清掉全部元素，
              并且<strong>算一步历史</strong>——<kbd>Ctrl</kbd> + <kbd>Z</kbd> 可以整体恢复。
            </li>
            <li>清空<strong>不动视角</strong>（不会顺手把你的镜头甩走）；画布本来就是空的时候按钮是灰的。</li>
          </ul>
        </>
      ),
    },
    {
      id: "keys",
      title: "十一、快捷键与鼠标一览",
      body: (
        <>
          <h3>工具与编辑</h3>
          <ul>
            <li>
              <kbd>V</kbd> 选择工具 / <kbd>T</kbd> 文本工具 / <kbd>L</kbd> 连接线
              （两个选中元素 = 直连，否则进出点选模式）
            </li>
            <li>
              <kbd>Esc</kbd> 取消选中并回选择工具（也会退出连接模式、退出文本编辑）
            </li>
            <li>
              <kbd>Delete</kbd> 删除选中 / <kbd>Ctrl</kbd> + <kbd>C</kbd> 复制选中
            </li>
            <li>
              <kbd>Ctrl</kbd> + <kbd>Z</kbd> 撤销 / <kbd>Ctrl</kbd> + <kbd>Y</kbd> 重做
            </li>
            <li>
              <kbd>Ctrl</kbd> + <kbd>B</kbd> 加粗（单选一个文本块时；编辑中选中文字亦可）
            </li>
            <li>
              <kbd>R</kbd> 选中的图片顺时针转 90°
            </li>
          </ul>
          <h3>画布与鼠标</h3>
          <ul>
            <li>滚轮：缩放（以光标为锚点）</li>
            <li>
              <kbd>空格</kbd> + 拖动：平移画布
            </li>
            <li>拖空白：框选；<kbd>Ctrl</kbd> + 单击：加选 / 退选</li>
            <li>双击空白：新建文本块；双击文本块：进入编辑</li>
            <li>拖元素：先单击选中再拖；多选时拖一个带走整组</li>
          </ul>
        </>
      ),
    },
    {
      id: "faq",
      title: "十二、常见问题",
      body: (
        <>
          <ul>
            <li>
              <strong>元素拖不动</strong>：先单击把它选中再拖（防误拖）。另外看看是不是还停在
              <strong>文本工具</strong>上——那个工具下单击空白是「新建文本」，
              按 <kbd>V</kbd> 或 <kbd>Esc</kbd> 回选择工具。
            </li>
            <li>
              <strong>滚轮缩不动了</strong>：到边了，缩放范围是 5% – 800%。
            </li>
            <li>
              <strong>历史面板第一行点了，画布变回空白</strong>：那行就是「初始状态」（撤销栈底），
              点它等于把记录里的操作全部撤销；栈只保留最近 100 步，再早的已经丢了。
            </li>
            <li>
              <strong>「清空画布」点不动</strong>：画布已经是空的，按钮会置灰。
            </li>
            <li>
              <strong>导出的 PNG 比我屏幕上看到的大</strong>：导出恒按 2 倍世界尺寸出图，
              与当前缩放无关；想让导出小一点，先把图片元素本身缩小。
            </li>
            <li>
              <strong>图片显示成空白框 / 打不开</strong>：图片资产存在本机浏览器里，
              清了站点数据或换了浏览器就取不到了；已经导出的 <code>.ystkboard</code> 里有图本体，
              导入即可恢复。
            </li>
            <li>
              <strong>参考线不见了</strong>：设置 → 灵感画布 → 「对齐吸附」被关了。
            </li>
            <li>
              <strong>便签工具是灰的</strong>：还没做。
            </li>
            <li>
              <strong>从图库拖图到画布没反应</strong>：这条路走不通（两个模块不会同时在场），
              请用图库侧的「送去画布」按钮。
            </li>
          </ul>
        </>
      ),
    },
  ],
};
