import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import {
  hsvToRgb,
  parseColor,
  rgbToHsl,
  rgbToHsv,
  type Hsv,
} from "./colorUtils";

interface ColorPickerProps {
  /** 当前颜色（任意 CSS 形式；内部解析为 HSV） */
  color: string;
  /** 拖动中实时回调，值为 "rgb(r, g, b)" */
  onChange: (rgb: string) => void;
}

function toRgbString(hsv: Hsv): string {
  const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * 自定义取色区：饱和度/明度平面 + 色相滑条，自由拖动取色。
 * 读数以 RGB / HSL 编码显示（不出现 HEX）。拖动中实时回调 onChange，
 * 外部（预设色板）改动 color 时滑块位置随之同步。
 */
export function ColorPicker({ color, onChange }: ColorPickerProps) {
  const [hsv, setHsv] = useState<Hsv>(() => {
    const { r, g, b } = parseColor(color);
    return rgbToHsv(r, g, b);
  });
  const planeRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  // 外部颜色变化（如点预设色板）→ 同步滑块位置
  useEffect(() => {
    const { r, g, b } = parseColor(color);
    setHsv(rgbToHsv(r, g, b));
  }, [color]);

  const apply = (next: Hsv) => {
    setHsv(next);
    onChange(toRgbString(next));
  };

  /** 指针拖动（按下后在元素上捕获移动/抬起），把坐标折算成 0–1 比例 */
  const dragRatio = (
    e: ReactPointerEvent<HTMLDivElement>,
    el: HTMLDivElement,
    cb: (rx: number, ry: number) => void,
  ) => {
    el.setPointerCapture(e.pointerId);
    const update = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      cb(
        Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
        Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
      );
    };
    update(e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => update(ev.clientX, ev.clientY);
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const { r, g, b } = hsvToRgb(hsv.h, hsv.s, hsv.v);
  const hsl = rgbToHsl(r, g, b);
  const pureHue = `rgb(${Object.values(hsvToRgb(hsv.h, 100, 100)).join(", ")})`;

  return (
    <div className="color-picker">
      <div
        ref={planeRef}
        className="color-picker__plane"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pureHue})`,
        }}
        onPointerDown={(e) =>
          dragRatio(e, e.currentTarget, (rx, ry) =>
            apply({ ...hsv, s: rx * 100, v: (1 - ry) * 100 }),
          )
        }
        role="slider"
        aria-label="饱和度与明度"
        aria-valuetext={`饱和度 ${Math.round(hsv.s)}%，明度 ${Math.round(hsv.v)}%`}
      >
        <span
          className="color-picker__plane-dot"
          style={{
            left: `${hsv.s}%`,
            top: `${100 - hsv.v}%`,
            background: toRgbString(hsv),
          }}
        />
      </div>
      <div
        ref={hueRef}
        className="color-picker__hue"
        onPointerDown={(e) =>
          dragRatio(e, e.currentTarget, (rx) => apply({ ...hsv, h: rx * 360 }))
        }
        role="slider"
        aria-label="色相"
        aria-valuenow={Math.round(hsv.h)}
      >
        <span
          className="color-picker__hue-handle"
          style={{ left: `${(hsv.h / 360) * 100}%`, background: pureHue }}
        />
      </div>
      <div className="color-picker__readout">
        <span>{`rgb(${r}, ${g}, ${b})`}</span>
        <span>{`hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`}</span>
      </div>
    </div>
  );
}
