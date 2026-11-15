"use strict";
/**
 * 自测页用的图片生成：canvas 现场画，转成 data:image/png 塞给 <img>。
 * 不联网、不留外部文件，保证扩展的「data: 图片」分支也能被真实拖一次。
 */
(() => {
  const PALETTE = [
    { bg: "#0060df", fg: "#ffffff", label: "A" },
    { bg: "#1a7f37", fg: "#ffffff", label: "B" },
    { bg: "#c04a42", fg: "#ffffff", label: "C" },
  ];

  function makeDataUrl(index) {
    const spec = PALETTE[index % PALETTE.length];
    const canvas = document.createElement("canvas");
    canvas.width = 480;
    canvas.height = 360;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = spec.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = spec.fg;
    ctx.font = "bold 160px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(spec.label, canvas.width / 2, canvas.height / 2);
    return canvas.toDataURL("image/png");
  }

  const images = Array.from(document.querySelectorAll("img[id^='demo-']"));
  images.forEach((img, index) => {
    img.src = makeDataUrl(index);
  });
})();
