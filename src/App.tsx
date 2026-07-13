import {
  ChangeEvent,
  DragEvent,
  PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  colorToHex,
  estimateCornerColor,
  getFrequentColors,
  paintProtectionMask,
  removeConnectedBackground,
  type PixelPosition,
} from "./imageProcessing";

type InteractionMode = "pan" | "paint" | "erase";

type ImagePaneProps = {
  image: ImageData | null;
  emptyLabel: string;
  view: ImageView;
  onViewChange: (view: ImageView) => void;
  interactionMode: InteractionMode;
  protectedMask: Uint8Array | null;
  onPaintProtection: (from: PixelPosition, to: PixelPosition, shouldProtect: boolean) => void;
};

type ImageView = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

const minimumScale = 0.5;
const maximumScale = 16;

type PixelCleanProject = {
  kind: "pixel-clean-project";
  version: 1;
  source: {
    fileName: string;
    pngDataUrl: string;
  };
  editor: {
    tolerance: number;
    includeEnclosedAreas: boolean;
    imageView: ImageView;
    brushSize: number;
    interactionMode: InteractionMode;
    protectedMask: string;
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "pan" || value === "paint" || value === "erase";
}

function isPixelCleanProject(value: unknown): value is PixelCleanProject {
  if (!isRecord(value) || value.kind !== "pixel-clean-project" || value.version !== 1) return false;
  if (!isRecord(value.source) || typeof value.source.fileName !== "string" || typeof value.source.pngDataUrl !== "string") {
    return false;
  }
  const editor = value.editor;
  if (!isRecord(editor)) return false;
  const imageView = editor.imageView;
  if (!isRecord(imageView)) return false;
  return (
    typeof editor.tolerance === "number" &&
    typeof editor.includeEnclosedAreas === "boolean" &&
    typeof imageView.scale === "number" &&
    typeof imageView.offsetX === "number" &&
    typeof imageView.offsetY === "number" &&
    typeof editor.brushSize === "number" &&
    isInteractionMode(editor.interactionMode) &&
    typeof editor.protectedMask === "string"
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function maskToBase64(mask: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < mask.length; offset += chunkSize) {
    binary += String.fromCharCode(...mask.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToMask(value: string, expectedLength: number): Uint8Array | null {
  try {
    const binary = atob(value);
    if (binary.length !== expectedLength) return null;
    const mask = new Uint8Array(expectedLength);
    for (let index = 0; index < binary.length; index += 1) mask[index] = binary.charCodeAt(index);
    return mask;
  } catch {
    return null;
  }
}

function imageDataToDataUrl(image: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("浏览器无法创建图像画布。");
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function ImagePane({
  image,
  emptyLabel,
  view,
  onViewChange,
  interactionMode,
  protectedMask,
  onPaintProtection,
}: ImagePaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<(deltaY: number) => void>(() => undefined);
  const dragStartRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const brushPointRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  zoomRef.current = (deltaY) => {
    if (!image) return;
    const nextScale = Math.min(
      maximumScale,
      Math.max(minimumScale, view.scale * (deltaY > 0 ? 0.9 : 1.1)),
    );
    onViewChange({ ...view, scale: nextScale });
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.putImageData(image, 0, 0);
    if (protectedMask && interactionMode !== "pan") {
      context.save();
      context.fillStyle = "rgba(229, 134, 255, 0.42)";
      for (let pixelIndex = 0; pixelIndex < protectedMask.length; pixelIndex += 1) {
        if (protectedMask[pixelIndex] === 1) {
          context.fillRect(pixelIndex % image.width, Math.floor(pixelIndex / image.width), 1, 1);
        }
      }
      context.restore();
    }
  }, [image, interactionMode, protectedMask]);

  useEffect(() => {
    const pane = paneRef.current;
    if (!pane || !image) return;
    const handleCanvasWheel = (event: globalThis.WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      zoomRef.current(event.deltaY);
    };
    pane.addEventListener("wheel", handleCanvasWheel, { passive: false });
    return () => pane.removeEventListener("wheel", handleCanvasWheel);
  }, [image]);

  const getImagePosition = (event: PointerEvent<HTMLDivElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return null;
    const bounds = canvas.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) {
      return null;
    }
    return {
      x: Math.min(image.width - 1, Math.max(0, Math.floor(((event.clientX - bounds.left) / bounds.width) * image.width))),
      y: Math.min(image.height - 1, Math.max(0, Math.floor(((event.clientY - bounds.top) / bounds.height) * image.height))),
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!image) return;
    if (interactionMode !== "pan") {
      const position = getImagePosition(event);
      if (!position) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      brushPointRef.current = { pointerId: event.pointerId, ...position };
      onPaintProtection(position, position, interactionMode === "paint");
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStartRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: view.offsetX,
      offsetY: view.offsetY,
    };
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const brushPoint = brushPointRef.current;
    if (brushPoint?.pointerId === event.pointerId) {
      const position = getImagePosition(event);
      if (position) {
        onPaintProtection(brushPoint, position, interactionMode === "paint");
        brushPointRef.current = { pointerId: event.pointerId, ...position };
      }
      return;
    }
    const dragStart = dragStartRef.current;
    if (!dragStart || dragStart.pointerId !== event.pointerId) return;
    onViewChange({
      ...view,
      offsetX: dragStart.offsetX + event.clientX - dragStart.clientX,
      offsetY: dragStart.offsetY + event.clientY - dragStart.clientY,
    });
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current?.pointerId === event.pointerId) dragStartRef.current = null;
    if (brushPointRef.current?.pointerId === event.pointerId) brushPointRef.current = null;
  };

  return (
    <div
      className={`image-pane checkerboard ${image ? "is-interactive" : ""} ${
        interactionMode !== "pan" ? "is-painting" : ""
      }`}
      ref={paneRef}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
    >
      {image ? (
        <canvas
          aria-label={emptyLabel}
          ref={canvasRef}
          style={{ transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale})` }}
        />
      ) : (
        <p>{emptyLabel}</p>
      )}
    </div>
  );
}

function imageElementToImageData(image: HTMLImageElement): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法创建图像画布。");
  context.imageSmoothingEnabled = false;
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

async function loadImage(file: File): Promise<ImageData> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = objectUrl;
    await image.decode();
    return imageElementToImageData(image);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function loadImageDataUrl(dataUrl: string): Promise<ImageData> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return imageElementToImageData(image);
}

function App() {
  const [sourceImage, setSourceImage] = useState<ImageData | null>(null);
  const [tolerance, setTolerance] = useState(20);
  const [fileName, setFileName] = useState("");
  const [message, setMessage] = useState("导入一张 PNG，开始清理统一背景。");
  const [isDragging, setIsDragging] = useState(false);
  const [imageView, setImageView] = useState<ImageView>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [includeEnclosedAreas, setIncludeEnclosedAreas] = useState(true);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pan");
  const [brushSize, setBrushSize] = useState(12);
  const [protectedMask, setProtectedMask] = useState<Uint8Array | null>(null);
  const [isClosePromptVisible, setIsClosePromptVisible] = useState(false);
  const [isSavingBeforeClose, setIsSavingBeforeClose] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeApprovedRef = useRef(false);

  const processedImage = useMemo(
    () =>
      sourceImage
        ? removeConnectedBackground(sourceImage, tolerance, includeEnclosedAreas, protectedMask)
        : null,
    [sourceImage, tolerance, includeEnclosedAreas, protectedMask],
  );
  const protectedPixelCount = useMemo(
    () => protectedMask?.reduce((count, value) => count + value, 0) ?? 0,
    [protectedMask],
  );
  const backgroundColor = sourceImage ? colorToHex(estimateCornerColor(sourceImage)) : "#1C1523";
  const palette = useMemo(() => (processedImage ? getFrequentColors(processedImage) : []), [processedImage]);

  useEffect(() => {
    let isDisposed = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (closeApprovedRef.current || !sourceImage) return;
        event.preventDefault();
        setIsClosePromptVisible(true);
      })
      .then((listener) => {
        if (isDisposed) listener();
        else unlisten = listener;
      })
      .catch(() => undefined);
    return () => {
      isDisposed = true;
      unlisten?.();
    };
  }, [sourceImage]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "image/png") {
      setMessage("首版仅支持 PNG 文件。");
      return;
    }
    try {
      const image = await loadImage(file);
      setSourceImage(image);
      setFileName(file.name);
      setImageView({ scale: 1, offsetX: 0, offsetY: 0 });
      setProtectedMask(new Uint8Array(image.width * image.height));
      setInteractionMode("pan");
      setMessage(`已导入 ${file.name}（${image.width} × ${image.height}）。`);
    } catch {
      setMessage("无法读取该 PNG，请确认文件没有损坏。");
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void importFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const createProjectFile = () => {
    if (!sourceImage) return null;
    const project: PixelCleanProject = {
      kind: "pixel-clean-project",
      version: 1,
      source: {
        fileName: fileName || "pixel.png",
        pngDataUrl: imageDataToDataUrl(sourceImage),
      },
      editor: {
        tolerance,
        includeEnclosedAreas,
        imageView,
        brushSize,
        interactionMode,
        protectedMask: maskToBase64(protectedMask ?? new Uint8Array(sourceImage.width * sourceImage.height)),
      },
    };
    return {
      contents: JSON.stringify(project, null, 2),
      suggestedName: `${fileName.replace(/\.png$/i, "") || "pixel"}.pixelclean.json`,
    };
  };

  const restoreProject = async (contents: string, projectName: string) => {
    try {
      const project: unknown = JSON.parse(contents);
      if (!isPixelCleanProject(project)) throw new Error("不是有效的 Pixel Clean 工程文件。");
      const image = await loadImageDataUrl(project.source.pngDataUrl);
      const mask = base64ToMask(project.editor.protectedMask, image.width * image.height);
      if (!mask) throw new Error("工程保护蒙版无效。");
      setSourceImage(image);
      setFileName(project.source.fileName);
      setTolerance(clamp(project.editor.tolerance, 0, 120));
      setIncludeEnclosedAreas(project.editor.includeEnclosedAreas);
      setImageView({
        scale: clamp(project.editor.imageView.scale, minimumScale, maximumScale),
        offsetX: project.editor.imageView.offsetX,
        offsetY: project.editor.imageView.offsetY,
      });
      setBrushSize(clamp(project.editor.brushSize, 1, 80));
      setInteractionMode(project.editor.interactionMode);
      setProtectedMask(mask);
      setMessage(`已打开工程 ${projectName}，已恢复全部工作状态。`);
    } catch {
      setMessage("无法打开工程文件，请确认它未损坏且来自 Pixel Clean。");
    }
  };

  const saveProject = async () => {
    const projectFile = createProjectFile();
    if (!projectFile) return false;
    try {
      const path = await save({
        defaultPath: projectFile.suggestedName,
        filters: [{ name: "Pixel Clean 工程", extensions: ["json"] }],
      });
      if (path === null) {
        setMessage("已取消保存工程。");
        return false;
      }
      await invoke("write_project_file", { path, contents: projectFile.contents });
      setMessage("工程已保存：包含原图、保护蒙版和全部编辑参数。");
      return true;
    } catch {
      setMessage("无法打开桌面保存对话框，工程未保存。");
      return false;
    }
  };

  const closeDesktopWindow = async () => {
    closeApprovedRef.current = true;
    setIsClosePromptVisible(false);
    try {
      await getCurrentWindow().close();
    } catch {
      closeApprovedRef.current = false;
      setMessage("无法关闭桌面窗口。");
    }
  };

  const saveAndClose = async () => {
    setIsSavingBeforeClose(true);
    const isSaved = await saveProject();
    setIsSavingBeforeClose(false);
    if (isSaved) await closeDesktopWindow();
  };

  const openProjectDialog = async () => {
    try {
      const path = await open({
        directory: false,
        filters: [{ name: "Pixel Clean 工程", extensions: ["json"] }],
        multiple: false,
      });
      if (typeof path !== "string") return;
      const contents = await invoke<string>("read_project_file", { path });
      await restoreProject(contents, path.split(/[/\\]/).pop() ?? "工程文件");
    } catch {
      setMessage("无法打开桌面工程文件对话框。");
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void importFile(event.dataTransfer.files[0]);
  };

  const paintProtection = (from: PixelPosition, to: PixelPosition, shouldProtect: boolean) => {
    if (!sourceImage) return;
    setProtectedMask((mask) =>
      paintProtectionMask(
        mask ?? new Uint8Array(sourceImage.width * sourceImage.height),
        sourceImage.width,
        sourceImage.height,
        from,
        to,
        brushSize,
        shouldProtect,
      ),
    );
  };

  const exportImage = () => {
    if (!processedImage) return;
    const canvas = document.createElement("canvas");
    canvas.width = processedImage.width;
    canvas.height = processedImage.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.putImageData(processedImage, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `${fileName.replace(/\.png$/i, "") || "pixel"}-transparent.png`;
      link.click();
      URL.revokeObjectURL(link.href);
    }, "image/png");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PIXEL CLEAN · MVP</p>
          <h1>像素图清理台</h1>
        </div>
        <div className="toolbar-actions">
          <button className="secondary" onClick={() => fileInputRef.current?.click()} type="button">
            导入 PNG
          </button>
          <button className="secondary" onClick={() => void openProjectDialog()} type="button">
            打开工程
          </button>
          <button className="secondary" disabled={!sourceImage} onClick={() => void saveProject()} type="button">
            保存工程
          </button>
          <button className="primary" disabled={!processedImage} onClick={exportImage} type="button">
            导出透明 PNG
          </button>
          <input accept="image/png" hidden onChange={handleFileChange} ref={fileInputRef} type="file" />
        </div>
      </header>

      <section className="workspace">
        <section
          className={`canvas-area ${isDragging ? "is-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          {!sourceImage && (
            <button className="dropzone" onClick={() => fileInputRef.current?.click()} type="button">
              <span>拖入 PNG 图片</span>
              <small>或点击选择文件</small>
            </button>
          )}
          <div className="comparison-grid">
            <section className="preview-card">
              <div className="preview-heading">
                <span>原图</span>
                {sourceImage && <small>{sourceImage.width} × {sourceImage.height}</small>}
              </div>
              <ImagePane
                emptyLabel="原图将在这里显示"
                image={sourceImage}
                interactionMode={interactionMode}
                onViewChange={setImageView}
                onPaintProtection={paintProtection}
                protectedMask={protectedMask}
                view={imageView}
              />
            </section>
            <section className="preview-card">
              <div className="preview-heading">
                <span>处理结果</span>
                <small>透明背景</small>
              </div>
              <ImagePane
                emptyLabel="处理结果将在这里显示"
                image={processedImage}
                interactionMode={interactionMode}
                onViewChange={setImageView}
                onPaintProtection={paintProtection}
                protectedMask={protectedMask}
                view={imageView}
              />
            </section>
          </div>
          <div className="canvas-footer">
            <p className="status-message">{message}</p>
            <div className="view-controls" aria-label="画布视图控制">
              <button
                aria-label="缩小"
                disabled={!sourceImage || imageView.scale <= minimumScale}
                onClick={() => setImageView((view) => ({ ...view, scale: Math.max(minimumScale, view.scale - 0.25) }))}
                type="button"
              >
                −
              </button>
              <output>{Math.round(imageView.scale * 100)}%</output>
              <button
                aria-label="放大"
                disabled={!sourceImage || imageView.scale >= maximumScale}
                onClick={() => setImageView((view) => ({ ...view, scale: Math.min(maximumScale, view.scale + 0.25) }))}
                type="button"
              >
                +
              </button>
              <button
                className="reset-view"
                disabled={!sourceImage}
                onClick={() => setImageView({ scale: 1, offsetX: 0, offsetY: 0 })}
                type="button"
              >
                重置视图
              </button>
            </div>
          </div>
        </section>

        <aside className="inspector">
          <section className="panel-section">
            <div className="section-title">
              <h2>背景移除</h2>
              <span className="badge">第一步</span>
            </div>
            <p className="help-text">从四个角取样，移除近似背景；可包含圆环等封闭区域内的背景。</p>
            <div className="color-sample">
              <span aria-label={`推测背景色 ${backgroundColor}`} style={{ background: backgroundColor }} />
              <div>
                <small>推测背景色</small>
                <strong>{backgroundColor}</strong>
              </div>
            </div>
            <label className="range-label" htmlFor="tolerance">
              <span>颜色容差</span>
              <output>{tolerance}</output>
            </label>
            <input
              id="tolerance"
              max="120"
              min="0"
              onChange={(event) => setTolerance(Number(event.target.value))}
              type="range"
              value={tolerance}
            />
            <div className="range-hint">
              <span>严格</span>
              <span>宽松</span>
            </div>
            <label className="toggle-row">
              <input
                checked={includeEnclosedAreas}
                onChange={(event) => setIncludeEnclosedAreas(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>移除封闭背景</strong>
                <small>清除圆环、边框等封闭区域内匹配的背景色。</small>
              </span>
            </label>
            <p className="safety-note">若主体也使用了相近的深色，请关闭此选项或调低容差。</p>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <h2>保护区域</h2>
              <span className="badge">精细处理</span>
            </div>
            <p className="help-text">保护区域中的所有像素都会保留，不参与背景剔除。</p>
            <div className="tool-choice-row">
              <button
                className={interactionMode === "pan" ? "is-active" : ""}
                onClick={() => setInteractionMode("pan")}
                type="button"
              >
                拖动画布
              </button>
              <button
                className={interactionMode === "paint" ? "is-active" : ""}
                disabled={!sourceImage}
                onClick={() => setInteractionMode("paint")}
                type="button"
              >
                保护画笔
              </button>
              <button
                className={interactionMode === "erase" ? "is-active" : ""}
                disabled={!sourceImage || protectedPixelCount === 0}
                onClick={() => setInteractionMode("erase")}
                type="button"
              >
                清除画笔
              </button>
            </div>
            {interactionMode !== "pan" && (
              <>
                <label className="range-label" htmlFor="brush-size">
                  <span>画笔直径</span>
                  <output>{brushSize} px</output>
                </label>
                <input
                  id="brush-size"
                  max="80"
                  min="1"
                  onChange={(event) => setBrushSize(Number(event.target.value))}
                  type="range"
                  value={brushSize}
                />
              </>
            )}
            {interactionMode === "paint" && <p className="selection-tip">在原图或结果图上拖拽，涂抹需要完整保留的阴阳玉区域。</p>}
            {interactionMode === "erase" && <p className="selection-tip">涂抹紫色覆盖层，恢复该处的背景剔除。</p>}
            {protectedPixelCount > 0 ? (
              <div className="protected-status">
                <span>已保护 {protectedPixelCount} px</span>
                <button onClick={() => setProtectedMask(sourceImage ? new Uint8Array(sourceImage.width * sourceImage.height) : null)} type="button">
                  清除
                </button>
              </div>
            ) : (
              <p className="empty-protection">尚未选择保护区域。</p>
            )}
          </section>

          <section className="panel-section palette-section">
            <div className="section-title">
              <h2>当前主色</h2>
              <span className="badge muted">下一步</span>
            </div>
            <p className="help-text">背景移除后的高频颜色。色卡合并功能将在此基础上加入。</p>
            <div className="palette-list">
              {palette.length > 0 ? (
                palette.map((color) => (
                  <div className="palette-item" key={color.hex}>
                    <span style={{ backgroundColor: color.hex }} />
                    <code>{color.hex}</code>
                    <small>{color.count} px</small>
                  </div>
                ))
              ) : (
                <p className="empty-palette">导入图片后显示高频颜色。</p>
              )}
            </div>
          </section>
        </aside>
      </section>
      {isClosePromptVisible && (
        <div aria-modal="true" className="modal-backdrop" role="dialog">
          <section className="close-dialog" aria-labelledby="close-dialog-title">
            <p className="eyebrow">未保存的工作状态</p>
            <h2 id="close-dialog-title">关闭前要保存工程吗？</h2>
            <p>工程会保存原图、保护画笔、背景参数、缩放与画布位置。</p>
            <div className="close-dialog-actions">
              <button disabled={isSavingBeforeClose} onClick={() => void closeDesktopWindow()} type="button">
                不保存
              </button>
              <button disabled={isSavingBeforeClose} onClick={() => setIsClosePromptVisible(false)} type="button">
                取消
              </button>
              <button className="primary" disabled={isSavingBeforeClose} onClick={() => void saveAndClose()} type="button">
                {isSavingBeforeClose ? "正在保存…" : "保存工程"}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
