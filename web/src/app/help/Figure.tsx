import { useState } from "react";

/**
 * 教程配图槽位（使用说明页专用）。
 *
 * 图在 → 直接渲染；图不在 → 显示「待补截图」占位，占位里写明**期望的文件名**与
 * **该截什么**，这样补图的人打开页面就知道要拍哪一张、存成什么名字。
 *
 * 命名规范（详见 `web/public/help/<module>/README.md`）：**两位序号 + 小写扩展名**，
 * 放在 `web/public/help/<module>/` 下，序号按使用说明里的出现顺序排。
 * 扩展名按 png → jpg → jpeg → webp 依次探测，命中即用（省得为格式纠结）。
 */

/** 依次探测的扩展名（小写；顺序即优先级） */
const EXTS = ["png", "jpg", "jpeg", "webp"] as const;

export function Figure({
  dir,
  n,
  caption,
  brief,
}: {
  /** 图库目录名（= 模块 id，如 `library`） */
  dir: string;
  /** 两位序号，如 `01` */
  n: string;
  /** 图注 */
  caption: string;
  /** 该截什么（补图时看这句） */
  brief: string;
}) {
  const [extIdx, setExtIdx] = useState(0);
  const [state, setState] = useState<"probe" | "ok" | "missing">("probe");
  const file = `${n}.${EXTS[extIdx]}`;
  const rel = `help/${dir}/${file}`;
  /** 占位里展示的**推荐文件名**：固定用 .png，而不是"最后一个试过的扩展名"——
   *  否则探测失败时会把 02.webp 这种中间态名字显示给人看，误导补图 */
  const canonical = `web/public/help/${dir}/${n}.${EXTS[0]}`;

  return (
    <figure className="hp-fig">
      <div className={"hp-fig__box" + (state === "ok" ? " is-ok" : "")}>
        {/* 常驻 img 用于探测：探测期用 CSS 挪到盒子底下（opacity 0 + absolute）——
            既不影响布局也不闪破图，但**必须有真实盒子**，否则浏览器根本不去加载，
            onLoad/onError 永不触发（最初写成 display:none + lazy 就踩了这个坑）。
            同理不用 loading="lazy"：探测需要在挂载时就出结果。 */}
        <img
          className="hp-fig__img"
          src={`/${rel}`}
          alt={caption}
          onLoad={() => setState("ok")}
          onError={() => {
            if (extIdx < EXTS.length - 1) setExtIdx(extIdx + 1);
            else setState("missing");
          }}
        />
        {state !== "ok" && (
          <div className="hp-fig__slot">
            {/* 探测期只留空白盒子（不说"待补"，免得有图的槽位也闪一句误导的话） */}
            {state === "missing" && (
              <>
                <span className="hp-fig__slot-tag">待补截图</span>
                <code className="hp-fig__slot-file">{canonical}</code>
                <span className="hp-fig__slot-brief">{brief}</span>
              </>
            )}
          </div>
        )}
      </div>
      <figcaption className="hp-fig__cap">
        <span className="hp-fig__num">{n}</span>
        {caption}
      </figcaption>
    </figure>
  );
}
