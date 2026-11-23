import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Theme = "dark" | "light";

interface ThemeState {
  theme: Theme;
  toggleTheme: () => void;
}

/**
 * 主题状态（§3.3：主题归 app/ 应用壳）。
 * 浅色为默认（2026-07-23 起，见留痕文档）；选择经 localStorage 持久化，
 * 键名 `ystk-theme`——index.html 的防闪烁内联脚本依赖此键名。
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: "light",
      toggleTheme: () =>
        set((s) => ({ theme: s.theme === "dark" ? "light" : "dark" })),
    }),
    { name: "ystk-theme" },
  ),
);
