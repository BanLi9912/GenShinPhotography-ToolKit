/**
 * M3.5.2 分析预设。应用口径（钉死）：选预设 → updateSettings({ presetId: id,
 * fieldConfig: { ...preset.fieldConfig } })；任何字段配置区手动修改 →
 * updateSettings({ presetId: "custom", fieldConfig: <新配置> })。
 */

import type { FieldConfig } from "./fieldSchema";

export interface VisionPreset {
  id: string;
  name: string;
  fieldConfig: FieldConfig;
}

export const VISION_PRESETS: VisionPreset[] = [
  { id: "photography", name: "摄影", fieldConfig: {} },
  {
    id: "screenshot",
    name: "截图/同人",
    fieldConfig: { enabled: ["content_type"] },
  },
];

export function getPreset(id: string): VisionPreset | undefined {
  return VISION_PRESETS.find((p) => p.id === id);
}
