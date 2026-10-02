import { create } from "zustand";

/**
 * 设置中心开合与分区（会话内状态，不持久化）。
 * section 默认 "general"，会话内记忆上次停留的分区——openSettings 不带参时
 * 打开即回到上次分区（不跨会话，刷新重置）。
 */
interface SettingsState {
  open: boolean;
  section: string;
  openSettings: (section?: string) => void;
  closeSettings: () => void;
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  open: false,
  section: "general",
  openSettings: (section) =>
    set((s) => ({ open: true, section: section ?? s.section })),
  closeSettings: () => set({ open: false }),
}));
