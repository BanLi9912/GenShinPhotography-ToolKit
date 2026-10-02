import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent, KeyboardEvent } from "react";
import { runSuperRes, runTextureRestore } from "../engine";
import { DENOISE_OPTIONS, useSuperResStore } from "../store";
import type { CuganScale } from "../store";
import { SuperResViewer } from "./SuperResViewer";
import "./SuperResPage.css";

function UploadIcon() {
  return (
    <svg
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}

function MagicIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path d="M19 17l.9 2.1L22 20l-2.1.9L19 23l-.9-2.1L16 20l2.1-.9L19 17z" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

/**
 * 图像超分页：本地 Real-CUGAN 2x 放大。
 * 选图后由用户点击开始，默认保守档；WebGPU 优先、WASM 回退，带真实进度条。
 */
export function SuperResPage() {
  const image = useSuperResStore((s) => s.image);
  const mode = useSuperResStore((s) => s.mode);
  const scale = useSuperResStore((s) => s.scale);
  const denoise = useSuperResStore((s) => s.denoise);
  const status = useSuperResStore((s) => s.status);
  const progress = useSuperResStore((s) => s.progress);
  const phase = useSuperResStore((s) => s.phase);
  const backend = useSuperResStore((s) => s.backend);
  const adapter = useSuperResStore((s) => s.adapter);
  const result = useSuperResStore((s) => s.result);
  const error = useSuperResStore((s) => s.error);
  const setImage = useSuperResStore((s) => s.setImage);
  const setMode = useSuperResStore((s) => s.setMode);
  const setScale = useSuperResStore((s) => s.setScale);
  const setDenoise = useSuperResStore((s) => s.setDenoise);
  const restoreOriginalSize = useSuperResStore((s) => s.restoreOriginalSize);
  const setRestoreOriginalSize = useSuperResStore(
    (s) => s.setRestoreOriginalSize,
  );
  const antialias = useSuperResStore((s) => s.antialias);
  const setAntialias = useSuperResStore((s) => s.setAntialias);
  const setRunning = useSuperResStore((s) => s.setRunning);
  const setIdle = useSuperResStore((s) => s.setIdle);
  const setResult = useSuperResStore((s) => s.setResult);
  const setError = useSuperResStore((s) => s.setError);

  const inputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const loadSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const [dragOver, setDragOver] = useState(false);

  // 出图即把结果视窗滚到视口正中（处理中用户多半停在按钮附近，不滚就看不到结果）；
  // 每次重跑换了新结果都滚一次。口径同 HelpPage/HistoryPanel：只用 scrollIntoView，不做平滑动画
  useEffect(() => {
    if (!result) return;
    viewerRef.current?.scrollIntoView({ block: "center" });
  }, [result]);

  const run = useCallback(async () => {
    const s = useSuperResStore.getState();
    if (!s.image || s.status === "running") return;
    const {
      image: current,
      mode,
      scale: level,
      denoise: denoiseLevel,
      restoreOriginalSize: restore,
      antialias,
    } = s;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning();
    try {
      const opts = {
        signal: controller.signal,
        restoreOriginalSize: restore,
        onProgress: (p: {
          percent: number;
          phase: string;
          backend: "webgpu" | "wasm" | null;
          adapter?: string;
        }) =>
          useSuperResStore
            .getState()
            .setProgress(p.percent, p.phase, p.backend, p.adapter),
      };
      const outcome =
        mode === "texture"
          ? await runTextureRestore(current.url, opts)
          : await runSuperRes(
              current.url,
              { scale: level, denoise: denoiseLevel },
              { ...opts, antialias },
            );
      if (controller.signal.aborted) return;
      if (useSuperResStore.getState().image?.url !== current.url) return;
      const baseName = current.name.replace(/\.[^.]+$/, "") || "upscaled";
      const name =
        mode === "texture"
          ? `${baseName}_texture${restore ? "_restored" : ""}.png`
          : `${baseName}${antialias ? "_aa" : ""}_${level}x_${denoiseLevel}${restore ? "_restored" : ""}.png`;
      useSuperResStore.getState().setResult({ name, ...outcome });
    } catch (e) {
      const st = useSuperResStore.getState();
      if (controller.signal.aborted) {
        st.setIdle();
        return;
      }
      st.setError(e instanceof Error ? e.message : "超分失败，请重试");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [setRunning]);

  const acceptFile = useCallback(
    (file: File | null | undefined) => {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("请选择图片文件（PNG / JPG / WebP）");
        return;
      }
      abortRef.current?.abort();
      const seq = ++loadSeq.current;
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        if (seq !== loadSeq.current) {
          URL.revokeObjectURL(url);
          return;
        }
        setImage({
          name: file.name,
          width: img.naturalWidth,
          height: img.naturalHeight,
          url,
        });
      };
      img.onerror = () => {
        if (seq === loadSeq.current) setError("无法读取该图片");
        URL.revokeObjectURL(url);
      };
      img.src = url;
    },
    [setError, setImage],
  );

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0]);
    e.target.value = "";
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    acceptFile(e.dataTransfer.files?.[0]);
  };

  const onDropzoneKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  const removeImage = () => {
    abortRef.current?.abort();
    loadSeq.current += 1;
    setImage(null);
  };

  const cancel = () => {
    abortRef.current?.abort();
    setIdle();
  };

  const running = status === "running";
  const backendLabel =
    backend === "webgpu"
      ? `GPU · WebGPU${adapter ? ` · ${adapter}` : ""}`
      : "CPU · WASM";

  return (
    <section className="superres-page">
      <header className="superres-page__header">
        <span className="superres-page__code">SR</span>
        <h1>图像超分</h1>
      </header>

      <div className="superres-page__layout">
        <section className="superres-card">
          <h2>原图</h2>
          {image ? (
            <>
              <div className="superres-card__image">
                <img src={image.url} alt={image.name} />
                <span className="superres-card__meta">
                  {image.name} · {image.width}×{image.height}
                </span>
              </div>
              <div className="superres-card__actions">
                <button
                  type="button"
                  className="superres-btn"
                  onClick={() => inputRef.current?.click()}
                >
                  更换图片
                </button>
                <button
                  type="button"
                  className="superres-btn"
                  onClick={removeImage}
                >
                  移除
                </button>
              </div>
            </>
          ) : (
            <div
              className={`superres-dropzone${dragOver ? " is-dragover" : ""}`}
              role="button"
              tabIndex={0}
              aria-label="选择或拖入图片"
              onClick={() => inputRef.current?.click()}
              onKeyDown={onDropzoneKeyDown}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
            >
              <UploadIcon />
              <strong>拖入截图，或点击选择</strong>
              <span>选择图片后点击「开始超分」 · 支持 PNG / JPG / WebP</span>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onInputChange}
          />
        </section>

        <section className="superres-card">
          <h2>超分设置</h2>
          <div className="superres-options superres-options--mode">
            <button
              type="button"
              className={`superres-option${mode === "cugan" ? " is-active" : ""}`}
              aria-pressed={mode === "cugan"}
              disabled={running}
              onClick={() => setMode("cugan")}
            >
              <span className="superres-option__name">超分</span>
            </button>
            <button
              type="button"
              className={`superres-option${mode === "texture" ? " is-active" : ""}`}
              aria-pressed={mode === "texture"}
              disabled={running}
              onClick={() => setMode("texture")}
            >
              <span className="superres-option__name">纹理保全</span>
            </button>
          </div>
          {mode === "cugan" ? (
            <>
              <div className="superres-options">
                {([2, 3, 4] as CuganScale[]).map((sc) => (
                  <button
                    key={sc}
                    type="button"
                    className={`superres-option${scale === sc ? " is-active" : ""}`}
                    aria-pressed={scale === sc}
                    disabled={running}
                    onClick={() => setScale(sc)}
                  >
                    <span className="superres-option__name">{sc}x</span>
                    <span className="superres-option__desc">
                      {sc === 2 ? "四档降噪" : "三档降噪"}
                    </span>
                  </button>
                ))}
              </div>
              <div className="superres-options superres-options--denoise">
                {DENOISE_OPTIONS[scale].map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`superres-option superres-option--small${denoise === opt.id ? " is-active" : ""}`}
                    aria-pressed={denoise === opt.id}
                    disabled={running}
                    onClick={() => setDenoise(opt.id)}
                  >
                    <span className="superres-option__name">{opt.name}</span>
                    <span className="superres-option__desc">{opt.desc}</span>
                  </button>
                ))}
              </div>
              <label className="superres-option-toggle">
                <input
                  type="checkbox"
                  checked={antialias}
                  disabled={running}
                  onChange={(e) => setAntialias(e.target.checked)}
                />
                <span className="superres-option-toggle__body">
                  <span className="superres-option-toggle__name">
                    抗锯齿预处理
                  </span>
                  <span className="superres-option-toggle__desc">
                    先用 1x-SuperScale 抗锯齿修复一遍，再进 Real-CUGAN 超分；适合锯齿/压缩痕迹明显的游戏截图
                  </span>
                </span>
              </label>
              <label className="superres-option-toggle">
                <input
                  type="checkbox"
                  checked={restoreOriginalSize}
                  disabled={running}
                  onChange={(e) => setRestoreOriginalSize(e.target.checked)}
                />
                <span className="superres-option-toggle__body">
                  <span className="superres-option-toggle__name">
                    超分后压缩回原分辨率
                  </span>
                  <span className="superres-option-toggle__desc">
                    超分处理后缩回原尺寸，得到分辨率不变的锐化增强
                  </span>
                </span>
              </label>
            </>
          ) : (
            <>
              <label className="superres-option-toggle">
                <input
                  type="checkbox"
                  checked={restoreOriginalSize}
                  disabled={running}
                  onChange={(e) => setRestoreOriginalSize(e.target.checked)}
                />
                <span className="superres-option-toggle__body">
                  <span className="superres-option-toggle__name">
                    处理后压缩回原分辨率
                  </span>
                  <span className="superres-option-toggle__desc">
                    2x 处理后缩回原尺寸，得到分辨率不变的降噪锐化结果
                  </span>
                </span>
              </label>
              <p className="superres-card__hint">
                SuperScale 1x 抗锯齿 → AnimeSharpV4 2x 超分；保纹理、降噪锐化，耗时明显高于超分线
              </p>
            </>
          )}
          <button
            type="button"
            className="superres-run"
            disabled={!image || running}
            onClick={run}
          >
            <MagicIcon />
            {running
              ? "处理中…"
              : mode === "texture"
                ? result
                  ? "重新处理"
                  : "开始处理 → 降噪锐化"
                : result
                  ? `重新超分 → ${scale}x`
                  : `开始超分 → ${scale}x`}
          </button>
          {running && (
            <div className="superres-progress">
              <div
                className="superres-progress__bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              >
                <span style={{ width: `${progress}%` }} />
              </div>
              <div className="superres-progress__meta">
                <span>{phase}</span>
                <span>{Math.round(progress)}%</span>
              </div>
              <div className="superres-progress__row">
                {backend && (
                  <span className="superres-progress__backend">
                    {backendLabel}
                  </span>
                )}
                <button
                  type="button"
                  className="superres-btn"
                  onClick={cancel}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {error && <p className="superres-card__error">{error}</p>}
        </section>
      </div>

      {/* 结果区独立于上面的表单列：全幅大图模式，吃满内容区宽度（见 SuperResPage.css） */}
      {result && (
        <section className="superres-card superres-card--result">
          <h2>结果</h2>
          <div className="superres-card__image">
            {/* 包裹层只作滚动定位锚点（出图后居中结果视窗），不参与视觉 */}
            <div ref={viewerRef} className="superres-card__viewer">
              <SuperResViewer image={result} original={image} />
            </div>
            <span className="superres-card__meta">
              {result.name} · {result.width}×{result.height}
              {backend && (
                <>
                  {" · "}
                  {backendLabel}
                </>
              )}
            </span>
          </div>
          <div className="superres-card__actions">
            <a
              className="superres-download"
              href={result.url}
              download={result.name}
            >
              <DownloadIcon />
              下载 PNG
            </a>
            <button
              type="button"
              className="superres-btn"
              onClick={() => setResult(null)}
            >
              <ClearIcon />
              清除结果
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
