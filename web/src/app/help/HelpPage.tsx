import { useEffect, useRef } from "react";
import { Link, NavLink, useParams } from "react-router-dom";
import { MODULES } from "../modules";
import { GUIDES } from "./guides";
import "./HelpPage.css";

/**
 * 使用说明页（独立页面，**不套应用壳**）。
 *
 * 由设置中心「关于」页的模块行经 `<a target="_blank">` 在新标签页打开，
 * 路径 `/help/:moduleId`。故本页自带顶栏与滚动容器，不依赖 AppShell 的网格布局。
 *
 * 顶栏是**模块切换标签条**（2026-09-15 用户口径：整行换成模块名，点击即切换该模块的说明书）——
 * 站内路由切换，不重开标签页。标签用 `NavLink` + `end`：`/help/lab` 是 `/help/library`
 * 的字符串前缀，不加 `end` 会在 library 页把 lab 标签也点亮。
 *
 * 内容按模块 id 从 `GUIDES` 取；没有指南的模块显示「编写中」占位（标签仍可点，
 * 交互保持一致，不必为没写的模块特殊处理）。
 */
export function HelpPage() {
  const { moduleId } = useParams();
  const mod = MODULES.find((m) => m.id === moduleId);
  const guide = moduleId ? GUIDES[moduleId] : undefined;
  const pageRef = useRef<HTMLDivElement | null>(null);

  // 切标签换的是同一页里的内容，滚动容器不会自己回顶，故手动校正一次；
  // 带 `#锚点` 进入（如 /help/library#vision）时改为定位到该锚点。
  // instant：本页 .help-page 带 scroll-behavior: smooth，不覆盖的话换模块会"滑"下去。
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (hash) {
      document.getElementById(hash)?.scrollIntoView({ block: "start" });
      return;
    }
    pageRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [moduleId]);

  if (!mod) {
    return (
      <div className="help-page">
        <div className="help-missing">
          <p>没有名为「{moduleId}」的模块。</p>
          <Link to="/" className="help-link">
            返回工具箱
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="help-page" ref={pageRef}>
      <header className="help-top">
        <nav className="help-top__inner" aria-label="切换模块说明书">
          {MODULES.map((m) => (
            <NavLink
              key={m.id}
              to={`/help/${m.id}`}
              end
              className={({ isActive }) => "help-tab" + (isActive ? " is-active" : "")}
            >
              {m.name}
            </NavLink>
          ))}
        </nav>
      </header>

      <main className="help-body">
        <div className="help-head">
          <span className="help-head__code">{mod.code}</span>
          <h1 className="help-head__title">{mod.name}</h1>
          <p className="help-head__tag">{mod.tagline}</p>
        </div>

        {guide ? (
          <>
            <div className="help-intro">{guide.intro}</div>
            <div className="help-cols">
              <nav className="help-toc" aria-label="本页目录">
                <div className="help-toc__title">目录</div>
                <ol>
                  {guide.sections.map((s) => (
                    <li key={s.id}>
                      <a href={`#${s.id}`}>{s.title}</a>
                    </li>
                  ))}
                </ol>
              </nav>
              <article className="help-article">
                {guide.sections.map((s) => (
                  <section key={s.id} id={s.id} className="help-sec">
                    <h2>{s.title}</h2>
                    {s.body}
                  </section>
                ))}
              </article>
            </div>
          </>
        ) : (
          <p className="help-empty">
            「{mod.name}」的使用说明正在编写中。{mod.tagline}
          </p>
        )}
      </main>
    </div>
  );
}
