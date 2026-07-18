import {
  type ChangeEvent,
  type DragEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import ImageViewport, {
  type ImageView,
  type InteractionMode,
} from "./components/ImageViewport";
import ThresholdControl from "./components/ThresholdControl";
import { colorToHex, rgbToOklab } from "./algorithms/colorSpace";
import {
  backgroundDistanceMetricVersion,
  getDirectionalBackgroundDistance,
} from "./algorithms/directionalBackgroundDistance";
import {
  defaultEdgeGlowWidth,
  type EdgeGlowStats,
} from "./algorithms/edgeGlowReconstruction";
import {
  defaultLocalColorSimilarityThreshold,
  localColorIslandsAlgorithmVersion,
  type LocalColorIslandStats,
} from "./algorithms/localColorIslands";
import type { RgbColor } from "./algorithms/types";
import {
  createImageMemoryKey,
  loadProjectMemory,
  normalizeProjectMemoryPreviewBackgroundColor,
  normalizeProjectMemoryPreviewBackgroundMode,
  saveProjectMemory,
  type ProjectMemory,
  type ProjectMemoryPreviewBackgroundMode,
} from "./editor/projectMemory";
import { paintProtectionMask, type PixelPosition } from "./editor/protectionMask";
import type { BackgroundMaskStats } from "./pipeline/backgroundAnalysis";
import type {
  BackgroundWorkerRequest,
  BackgroundWorkerResponse,
} from "./pipeline/backgroundAnalysisProtocol";
import type { BackgroundThresholds } from "./algorithms/adaptiveBackgroundThresholds";

type AnalysisStatus = "idle" | "analyzing" | "classifying" | "ready" | "error";
type PreviewMode = "remove-background" | "remove-foreground" | "mask";

type AnalysisModel = {
  analysisId: number;
  mergedImage: ImageData;
  localColorStats: LocalColorIslandStats;
  edgeImage: ImageData;
  glowMask: Uint8Array;
  edgeGlowStats: EdgeGlowStats;
  estimatedBackgroundColor: RgbColor;
  backgroundColor: RgbColor;
  thresholds: BackgroundThresholds;
  backgroundMask: Uint8Array;
  distances: Float32Array;
  stats: BackgroundMaskStats;
};

const initialView: ImageView = { zoom: 1, offsetX: 0, offsetY: 0 };
const initialBrushSize = 12;

function isCompatibleProjectMemory(
  memory: ProjectMemory | null,
  imageKey: string,
  width: number,
  height: number,
): memory is ProjectMemory {
  return Boolean(
    memory
    && memory.imageKey === imageKey
    && memory.width === width
    && memory.height === height
    && memory.protectedMask instanceof Uint8Array
    && memory.protectedMask.length === width * height
    && Number.isFinite(memory.selectedThreshold)
    && Number.isFinite(memory.brushSize)
    && Number.isFinite(memory.imageView?.zoom)
    && Number.isFinite(memory.imageView?.offsetX)
    && Number.isFinite(memory.imageView?.offsetY),
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

function createPreviewImage(
  source: ImageData,
  backgroundMask: Uint8Array,
  mode: PreviewMode,
): ImageData {
  const result = new ImageData(new Uint8ClampedArray(source.data), source.width, source.height);
  for (let pixelIndex = 0; pixelIndex < backgroundMask.length; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const isBackground = backgroundMask[pixelIndex] === 1;
    if (mode === "mask") {
      if (source.data[offset + 3] === 0) {
        result.data[offset + 3] = 0;
        continue;
      }
      const value = isBackground ? 238 : 34;
      result.data[offset] = value;
      result.data[offset + 1] = value;
      result.data[offset + 2] = value;
      result.data[offset + 3] = 255;
    } else if (mode === "remove-background" && isBackground) {
      result.data[offset + 3] = 0;
    } else if (mode === "remove-foreground" && !isBackground) {
      result.data[offset + 3] = 0;
    }
  }
  return result;
}

function countMask(mask: Uint8Array | null): number {
  if (!mask) return 0;
  let count = 0;
  for (const value of mask) count += value;
  return count;
}

function App() {
  const [sourceImage, setSourceImage] = useState<ImageData | null>(null);
  const [fileName, setFileName] = useState("");
  const [memoryKey, setMemoryKey] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisModel | null>(null);
  const [analysisStatus, setAnalysisStatus] = useState<AnalysisStatus>("idle");
  const [statusMessage, setStatusMessage] = useState("导入 PNG 开始背景分析。");
  const [backgroundColor, setBackgroundColor] = useState("#000000");
  const [localColorThreshold, setLocalColorThreshold] = useState(defaultLocalColorSimilarityThreshold);
  const [edgeGlowWidth, setEdgeGlowWidth] = useState(defaultEdgeGlowWidth);
  const [selectedThreshold, setSelectedThreshold] = useState(0);
  const [protectedMask, setProtectedMask] = useState<Uint8Array | null>(null);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pan");
  const [brushSize, setBrushSize] = useState(12);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("remove-background");
  const [previewBackgroundMode, setPreviewBackgroundMode] = useState<ProjectMemoryPreviewBackgroundMode>("checkerboard");
  const [customPreviewBackgroundColor, setCustomPreviewBackgroundColor] = useState("#6B7280");
  const [selectedPixel, setSelectedPixel] = useState<PixelPosition | null>(null);
  const [imageView, setImageView] = useState<ImageView>(initialView);
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const memoryKeyRef = useRef<string | null>(null);
  const pendingMemoryRef = useRef<ProjectMemory | null>(null);
  const analysisSequenceRef = useRef(0);
  const requestSequenceRef = useRef(0);
  const latestAnalysisRequestRef = useRef(0);
  const latestClassifyRequestRef = useRef(0);
  const activeAnalysisIdRef = useRef(0);
  const selectedThresholdRef = useRef(selectedThreshold);
  const preservedThresholdForAnalysisRef = useRef<number | null>(null);
  selectedThresholdRef.current = selectedThreshold;

  useEffect(() => {
    const worker = new Worker(new URL("./backgroundAnalysis.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<BackgroundWorkerResponse>) => {
      const response = event.data;
      if (response.type === "error") {
        const isCurrent = response.requestId === latestAnalysisRequestRef.current
          || response.requestId === latestClassifyRequestRef.current;
        if (!isCurrent) return;
        setAnalysisStatus("error");
        setStatusMessage(response.message);
        return;
      }
      if (response.type === "analyzed") {
        if (response.requestId !== latestAnalysisRequestRef.current) return;
        const restoredMemory = pendingMemoryRef.current;
        const shouldRestoreMemory = restoredMemory?.imageKey === memoryKeyRef.current;
        const shouldRestoreThreshold = shouldRestoreMemory
          && restoredMemory.distanceMetricVersion === backgroundDistanceMetricVersion
          && restoredMemory.localColorAlgorithmVersion === localColorIslandsAlgorithmVersion;
        activeAnalysisIdRef.current = response.analysisId;
        setAnalysis({
          analysisId: response.analysisId,
          mergedImage: new ImageData(
            new Uint8ClampedArray(response.mergedImage),
            response.width,
            response.height,
          ),
          localColorStats: response.localColorStats,
          edgeImage: new ImageData(
            new Uint8ClampedArray(response.edgeImage),
            response.width,
            response.height,
          ),
          glowMask: new Uint8Array(response.glowMask),
          edgeGlowStats: response.edgeGlowStats,
          estimatedBackgroundColor: response.estimatedBackgroundColor,
          backgroundColor: response.backgroundColor,
          thresholds: response.thresholds,
          backgroundMask: new Uint8Array(response.backgroundMask),
          distances: new Float32Array(response.distances),
          stats: response.stats,
        });
        setBackgroundColor(colorToHex(response.backgroundColor));
        setSelectedThreshold(shouldRestoreThreshold ? restoredMemory.selectedThreshold : response.selectedThreshold);
        if (shouldRestoreMemory) pendingMemoryRef.current = null;
        setAnalysisStatus("ready");
        setStatusMessage(shouldRestoreMemory
          ? shouldRestoreThreshold
            ? "近似颜色、背景分析和图片设置已恢复。"
            : "已恢复图片设置；上游算法已升级，阈值已重新计算。"
          : "近似颜色、背景色、双阈值、背景蒙版和边缘半透明已更新。");
        return;
      }
      if (
        response.requestId !== latestClassifyRequestRef.current
        || response.analysisId !== activeAnalysisIdRef.current
      ) return;
      setAnalysis((current) => current && current.analysisId === response.analysisId
        ? {
          ...current,
          edgeImage: new ImageData(
            new Uint8ClampedArray(response.edgeImage),
            response.width,
            response.height,
          ),
          glowMask: new Uint8Array(response.glowMask),
          edgeGlowStats: response.edgeGlowStats,
          backgroundMask: new Uint8Array(response.backgroundMask),
          stats: response.stats,
        }
        : current);
      setAnalysisStatus("ready");
      setStatusMessage("背景蒙版和边缘半透明已按当前阈值与保护区域更新。");
    };
    worker.onerror = () => {
      setAnalysisStatus("error");
      setStatusMessage("背景分析 Worker 异常退出。");
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!sourceImage || !workerRef.current) return;
    const timer = window.setTimeout(() => {
      const requestId = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestId;
      latestAnalysisRequestRef.current = requestId;
      latestClassifyRequestRef.current = 0;
      const analysisId = analysisSequenceRef.current + 1;
      analysisSequenceRef.current = analysisId;
      activeAnalysisIdRef.current = analysisId;
      setAnalysisStatus("analyzing");
      setStatusMessage("正在归并近似颜色并分析背景…");
      setAnalysis(null);
      const imageData = new Uint8ClampedArray(sourceImage.data).buffer;
      const protectionData = protectedMask ? new Uint8Array(protectedMask).buffer : null;
      const preservedThreshold = preservedThresholdForAnalysisRef.current;
      preservedThresholdForAnalysisRef.current = null;
      const request: BackgroundWorkerRequest = {
        type: "analyze",
        requestId,
        analysisId,
        width: sourceImage.width,
        height: sourceImage.height,
        imageData,
        edgeGlowWidth,
        localColorThreshold,
        selectedThreshold: preservedThreshold,
        backgroundColor: null,
        protectedMask: protectionData,
      };
      workerRef.current?.postMessage(request, {
        transfer: [imageData, ...(protectionData ? [protectionData] : [])],
      });
    }, 140);
    return () => window.clearTimeout(timer);
  }, [localColorThreshold, sourceImage]);

  useEffect(() => {
    if (!memoryKey || !sourceImage || !protectedMask) return;
    const timer = window.setTimeout(() => {
      void saveProjectMemory({
        imageKey: memoryKey,
        distanceMetricVersion: backgroundDistanceMetricVersion,
        localColorAlgorithmVersion: localColorIslandsAlgorithmVersion,
        localColorThreshold,
        edgeGlowWidth,
        width: sourceImage.width,
        height: sourceImage.height,
        protectedMask,
        selectedThreshold,
        brushSize,
        previewMode,
        previewBackgroundMode,
        customPreviewBackgroundColor,
        interactionMode,
        imageView,
        selectedPixel,
      }).catch(() => undefined);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [brushSize, customPreviewBackgroundColor, edgeGlowWidth, imageView, interactionMode, localColorThreshold, memoryKey, previewBackgroundMode, previewMode, protectedMask, selectedPixel, selectedThreshold, sourceImage]);

  useEffect(() => {
    if (!analysis || !sourceImage || !workerRef.current) return;
    const timer = window.setTimeout(() => {
      const requestId = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestId;
      latestClassifyRequestRef.current = requestId;
      const protectionData = protectedMask ? new Uint8Array(protectedMask).buffer : null;
      const request: BackgroundWorkerRequest = {
        type: "classify",
        requestId,
        analysisId: analysis.analysisId,
        selectedThreshold,
        edgeGlowWidth,
        protectedMask: protectionData,
      };
      setAnalysisStatus("classifying");
      workerRef.current?.postMessage(request, {
        transfer: protectionData ? [protectionData] : [],
      });
    }, 45);
    return () => window.clearTimeout(timer);
  }, [analysis?.analysisId, edgeGlowWidth, protectedMask, selectedThreshold, sourceImage]);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.type !== "image/png" && !file.name.toLowerCase().endsWith(".png")) {
      setAnalysisStatus("error");
      setStatusMessage("当前仅支持 PNG 图片。");
      return;
    }
    try {
      setAnalysisStatus("analyzing");
      setStatusMessage("正在读取 PNG…");
      const fileBytes = await file.arrayBuffer();
      const [image, imageKey] = await Promise.all([
        loadImage(file),
        createImageMemoryKey(fileBytes),
      ]);
      const savedMemory = await loadProjectMemory(imageKey).catch(() => null);
      const memory = isCompatibleProjectMemory(savedMemory, imageKey, image.width, image.height)
        ? savedMemory
        : null;
      memoryKeyRef.current = imageKey;
      pendingMemoryRef.current = memory;
      preservedThresholdForAnalysisRef.current = null;
      setSourceImage(image);
      setFileName(file.name);
      setMemoryKey(imageKey);
      setProtectedMask(memory ? new Uint8Array(memory.protectedMask) : new Uint8Array(image.width * image.height));
      setSelectedThreshold(
        memory?.distanceMetricVersion === backgroundDistanceMetricVersion
          && memory.localColorAlgorithmVersion === localColorIslandsAlgorithmVersion
          ? memory.selectedThreshold
          : 0,
      );
      setLocalColorThreshold(
        memory?.localColorAlgorithmVersion === localColorIslandsAlgorithmVersion
          && Number.isFinite(memory.localColorThreshold)
          ? Math.min(0.1, Math.max(0, memory.localColorThreshold))
          : defaultLocalColorSimilarityThreshold,
      );
      setEdgeGlowWidth(
        memory && Number.isFinite(memory.edgeGlowWidth)
          ? Math.min(0.3, Math.max(0, memory.edgeGlowWidth ?? defaultEdgeGlowWidth))
          : defaultEdgeGlowWidth,
      );
      setBrushSize(memory ? Math.min(80, Math.max(1, Math.round(memory.brushSize))) : initialBrushSize);
      setPreviewMode(memory ? memory.previewMode : "remove-background");
      setPreviewBackgroundMode(normalizeProjectMemoryPreviewBackgroundMode(memory?.previewBackgroundMode));
      setCustomPreviewBackgroundColor(normalizeProjectMemoryPreviewBackgroundColor(memory?.customPreviewBackgroundColor));
      setInteractionMode(memory ? memory.interactionMode : "pan");
      setSelectedPixel(memory?.selectedPixel ?? null);
      setImageView(memory ? {
        zoom: Math.min(32, Math.max(0.2, memory.imageView.zoom)),
        offsetX: memory.imageView.offsetX,
        offsetY: memory.imageView.offsetY,
      } : initialView);
      setAnalysis(null);
    } catch {
      setAnalysisStatus("error");
      setStatusMessage("无法读取 PNG，请检查文件是否损坏。");
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    void importFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDraggingFile(false);
    void importFile(event.dataTransfer.files[0]);
  };

  const paintProtection = (from: PixelPosition, to: PixelPosition, shouldProtect: boolean) => {
    if (!sourceImage) return;
    setProtectedMask((current) => paintProtectionMask(
      current ?? new Uint8Array(sourceImage.width * sourceImage.height),
      sourceImage.width,
      sourceImage.height,
      from,
      to,
      brushSize,
      shouldProtect,
    ));
  };

  const previewImage = useMemo(() => (
    analysis
      ? previewMode === "remove-background"
        ? analysis.edgeImage
        : createPreviewImage(analysis.mergedImage, analysis.backgroundMask, previewMode)
      : null
  ), [analysis, previewMode]);
  const previewBackgroundColor = previewBackgroundMode === "checkerboard"
    ? null
    : previewBackgroundMode === "black"
      ? "#000000"
      : previewBackgroundMode === "white"
        ? "#FFFFFF"
        : customPreviewBackgroundColor;

  const protectedPixelCount = useMemo(() => countMask(protectedMask), [protectedMask]);
  const selectedPixelDetail = useMemo(() => {
    if (!selectedPixel || !sourceImage || !analysis) return null;
    const pixelIndex = selectedPixel.y * sourceImage.width + selectedPixel.x;
    const offset = pixelIndex * 4;
    const sourceRgb: RgbColor = [
      sourceImage.data[offset],
      sourceImage.data[offset + 1],
      sourceImage.data[offset + 2],
    ];
    const mergedRgb: RgbColor = [
      analysis.mergedImage.data[offset],
      analysis.mergedImage.data[offset + 1],
      analysis.mergedImage.data[offset + 2],
    ];
    const alpha = analysis.mergedImage.data[offset + 3];
    const distanceComponents = getDirectionalBackgroundDistance(
      rgbToOklab(...mergedRgb),
      rgbToOklab(...analysis.backgroundColor),
    );
    return {
      ...selectedPixel,
      sourceColor: colorToHex(sourceRgb),
      mergedColor: colorToHex(mergedRgb),
      outputColor: colorToHex([
        analysis.edgeImage.data[offset],
        analysis.edgeImage.data[offset + 1],
        analysis.edgeImage.data[offset + 2],
      ]),
      outputAlpha: analysis.edgeImage.data[offset + 3],
      isGlow: analysis.glowMask[pixelIndex] === 1,
      alpha,
      deltaLightness: distanceComponents.deltaLightness,
      deltaChroma: distanceComponents.deltaChroma,
      deltaHue: distanceComponents.deltaHue,
      distance: analysis.distances[pixelIndex],
      classification: protectedMask?.[pixelIndex] === 1
        ? "受保护前景"
        : alpha === 0
          ? "透明像素"
          : analysis.backgroundMask[pixelIndex] === 1
            ? "背景"
            : "前景",
    };
  }, [analysis, protectedMask, selectedPixel, sourceImage]);

  const processingLabel = analysisStatus === "analyzing"
    ? "分析中"
    : analysisStatus === "classifying"
      ? "分类中"
      : analysisStatus === "ready"
        ? "已就绪"
        : analysisStatus === "error"
          ? "需要处理"
          : "等待图片";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="product-title">
          <span className="product-mark" aria-hidden="true">PC</span>
          <div>
            <h1>Pixel Clean</h1>
            <p>2.0 alpha · 背景分析管线</p>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`status-chip is-${analysisStatus}`}>{processingLabel}</span>
          <button className="button secondary" onClick={() => fileInputRef.current?.click()} type="button">
            导入 PNG
          </button>
          <input accept="image/png" hidden onChange={handleFileChange} ref={fileInputRef} type="file" />
        </div>
      </header>

      <section className="workspace">
        <section
          className={`canvas-area ${isDraggingFile ? "is-file-dragging" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDraggingFile(true);
          }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="canvas-toolbar">
            <div className="view-tools" aria-label="画布工具">
              <button
                className={interactionMode === "pan" ? "is-active" : ""}
                onClick={() => setInteractionMode("pan")}
                type="button"
              >
                移动
              </button>
              <button
                className={interactionMode === "protect" ? "is-active" : ""}
                disabled={!sourceImage}
                onClick={() => setInteractionMode("protect")}
                type="button"
              >
                保护
              </button>
              <button
                className={interactionMode === "erase" ? "is-active" : ""}
                disabled={!sourceImage || protectedPixelCount === 0}
                onClick={() => setInteractionMode("erase")}
                type="button"
              >
                擦除
              </button>
            </div>
            <div className="zoom-tools" aria-label="缩放控制">
              <button
                aria-label="缩小"
                disabled={!sourceImage}
                onClick={() => setImageView((view) => ({ ...view, zoom: Math.max(0.2, view.zoom / 1.25) }))}
                type="button"
              >
                −
              </button>
              <output>{Math.round(imageView.zoom * 100)}%</output>
              <button
                aria-label="放大"
                disabled={!sourceImage}
                onClick={() => setImageView((view) => ({ ...view, zoom: Math.min(32, view.zoom * 1.25) }))}
                type="button"
              >
                +
              </button>
              <button
                disabled={!sourceImage}
                onClick={() => setImageView(initialView)}
                type="button"
              >
                适应
              </button>
            </div>
          </div>

          {!sourceImage && (
            <button className="empty-import" onClick={() => fileInputRef.current?.click()} type="button">
              <strong>导入 PNG</strong>
              <span>或将图片拖入窗口</span>
            </button>
          )}

          <div className="comparison-grid">
            <section className="preview-panel">
              <header>
                <h2>原图</h2>
                <span>{sourceImage ? `${sourceImage.width} × ${sourceImage.height}` : "等待导入"}</span>
              </header>
              <ImageViewport
                image={sourceImage}
                interactionMode={interactionMode}
                label="原图"
                onPaintProtection={paintProtection}
                onSelectPixel={setSelectedPixel}
                onViewChange={setImageView}
                protectionMask={protectedMask}
                selectedPixel={selectedPixel}
                view={imageView}
              />
            </section>
            <section className="preview-panel">
              <header>
                <h2>处理结果</h2>
                <span>{previewMode === "mask" ? "二值蒙版" : previewMode === "remove-background" ? "去除背景最终图" : "去除前景"}</span>
              </header>
              <ImageViewport
                image={previewImage}
                interactionMode={interactionMode}
                label="背景分类结果"
                onPaintProtection={paintProtection}
                onSelectPixel={setSelectedPixel}
                onViewChange={setImageView}
                previewBackgroundColor={previewBackgroundColor}
                protectionMask={protectedMask}
                selectedPixel={selectedPixel}
                view={imageView}
              />
            </section>
          </div>

          <footer className="canvas-status">
            <div>
              <strong>{fileName || "未导入图片"}</strong>
              <span>{statusMessage}</span>
            </div>
            {analysis && (
              <div className="status-metrics">
                <span>背景 <strong>{analysis.stats.backgroundPixelCount.toLocaleString()}</strong></span>
                <span>前景 <strong>{analysis.stats.foregroundPixelCount.toLocaleString()}</strong></span>
                <span>保护 <strong>{analysis.stats.protectedPixelCount.toLocaleString()}</strong></span>
              </div>
            )}
          </footer>
        </section>

        <aside className="inspector">
          <section className="module-section">
            <div className="module-heading">
              <span>01</span>
              <div><h2>近似颜色归并</h2><small>四邻域动态平均色岛屿</small></div>
            </div>
            <div className="local-color-control">
              <div>
                <label htmlFor="local-color-threshold">近似阈值</label>
                <output>{localColorThreshold.toFixed(6)}</output>
              </div>
              <input
                disabled={!analysis || analysisStatus === "analyzing"}
                id="local-color-threshold"
                max="0.1"
                min="0"
                onChange={(event) => {
                  preservedThresholdForAnalysisRef.current = selectedThresholdRef.current;
                  setLocalColorThreshold(Number(event.target.value));
                }}
                step="0.001"
                type="range"
                value={localColorThreshold}
              />
            </div>
            {analysis && (
              <div className="local-color-summary">
                <div><span>像素岛屿</span><strong>{analysis.localColorStats.islandCount.toLocaleString()}</strong></div>
                <div><span>替换像素</span><strong>{analysis.localColorStats.replacedPixelCount.toLocaleString()}</strong></div>
                <div><span>输入颜色</span><strong>{analysis.localColorStats.inputColorCount.toLocaleString()}</strong></div>
                <div><span>输出颜色</span><strong>{analysis.localColorStats.outputColorCount.toLocaleString()}</strong></div>
              </div>
            )}
          </section>

          <section className="module-section">
            <div className="module-heading">
              <span>02</span>
              <div><h2>背景代表色</h2><small>四角非透明像素中位数</small></div>
            </div>
            <div className="color-control" aria-label={`自动估算背景色 ${backgroundColor}`}>
              <span className="color-swatch" style={{ backgroundColor }} aria-hidden="true" />
              <span><small>当前背景色</small><code>{backgroundColor}</code></span>
            </div>
            <div className="module-output">
              <span>自动估算</span>
              <code>{analysis ? colorToHex(analysis.estimatedBackgroundColor) : "—"}</code>
            </div>
          </section>

          <section className="module-section">
            <div className="module-heading">
              <span>03</span>
              <div><h2>自适应双阈值</h2><small>方向加权 OKLCH 距离分布</small></div>
            </div>
            <ThresholdControl
              disabled={!analysis || analysisStatus === "analyzing"}
              loose={analysis?.thresholds.loose ?? 0.014}
              onChange={setSelectedThreshold}
              strict={analysis?.thresholds.strict ?? 0.006}
              value={selectedThreshold}
            />
          </section>

          <section className="module-section">
            <div className="module-heading">
              <span>04</span>
              <div><h2>保护蒙版</h2><small>保护像素强制归类为前景</small></div>
            </div>
            <div className="brush-control">
              <label htmlFor="brush-size">画笔直径</label>
              <output>{brushSize} px</output>
              <input
                disabled={!sourceImage}
                id="brush-size"
                max="80"
                min="1"
                onChange={(event) => setBrushSize(Number(event.target.value))}
                type="range"
                value={brushSize}
              />
            </div>
            <div className="protection-summary">
              <span>已保护 <strong>{protectedPixelCount.toLocaleString()}</strong> px</span>
              <button
                disabled={!sourceImage || protectedPixelCount === 0}
                onClick={() => setProtectedMask(sourceImage ? new Uint8Array(sourceImage.width * sourceImage.height) : null)}
                type="button"
              >
                清除
              </button>
            </div>
          </section>

          <section className="module-section">
            <div className="module-heading">
              <span>05</span>
              <div><h2>背景蒙版</h2><small>单阈值逐像素分类</small></div>
            </div>
            <div className="segmented-control preview-modes" aria-label="分类结果显示模式">
              <button aria-pressed={previewMode === "remove-background"} onClick={() => setPreviewMode("remove-background")} type="button">去背景</button>
              <button aria-pressed={previewMode === "remove-foreground"} onClick={() => setPreviewMode("remove-foreground")} type="button">去前景</button>
              <button aria-pressed={previewMode === "mask"} onClick={() => setPreviewMode("mask")} type="button">蒙版</button>
            </div>
            <div className="preview-background-control">
              <span>预览底色</span>
              <div aria-label="预览底色" role="group">
                <button
                  aria-label="透明棋盘格"
                  aria-pressed={previewBackgroundMode === "checkerboard"}
                  className="preview-background-swatch is-checkerboard"
                  disabled={!sourceImage}
                  onClick={() => setPreviewBackgroundMode("checkerboard")}
                  title="透明棋盘格"
                  type="button"
                />
                <button
                  aria-label="黑色底色"
                  aria-pressed={previewBackgroundMode === "black"}
                  className="preview-background-swatch is-black"
                  disabled={!sourceImage}
                  onClick={() => setPreviewBackgroundMode("black")}
                  title="黑色底色"
                  type="button"
                />
                <button
                  aria-label="白色底色"
                  aria-pressed={previewBackgroundMode === "white"}
                  className="preview-background-swatch is-white"
                  disabled={!sourceImage}
                  onClick={() => setPreviewBackgroundMode("white")}
                  title="白色底色"
                  type="button"
                />
                <label
                  className={`custom-preview-background ${previewBackgroundMode === "custom" ? "is-active" : ""}`}
                  title="自定义底色"
                >
                  <input
                    aria-label="自定义预览底色"
                    disabled={!sourceImage}
                    onChange={(event) => {
                      setCustomPreviewBackgroundColor(event.target.value.toUpperCase());
                      setPreviewBackgroundMode("custom");
                    }}
                    onClick={() => setPreviewBackgroundMode("custom")}
                    type="color"
                    value={customPreviewBackgroundColor}
                  />
                </label>
              </div>
            </div>
            {analysis && (
              <div className="mask-summary">
                <div><span>背景像素</span><strong>{analysis.stats.backgroundPixelCount.toLocaleString()}</strong></div>
                <div>
                  <span>占非透明像素</span>
                  <strong>{(analysis.stats.opaquePixelCount === 0 ? 0 : analysis.stats.backgroundPixelCount / analysis.stats.opaquePixelCount * 100).toFixed(2)}%</strong>
                </div>
              </div>
            )}
          </section>

          <section className="module-section">
            <div className="module-heading">
              <span>06</span>
              <div><h2>边缘半透</h2><small>边缘岛线性 RGB Alpha 反算</small></div>
            </div>
            <div className="edge-glow-control">
              <div>
                <label htmlFor="edge-glow-width">方向距离差值</label>
                <output>{edgeGlowWidth.toFixed(3)}</output>
              </div>
              <input
                disabled={!analysis || analysisStatus === "analyzing"}
                id="edge-glow-width"
                max="0.3"
                min="0"
                onChange={(event) => setEdgeGlowWidth(Number(event.target.value))}
                step="0.001"
                type="range"
                value={edgeGlowWidth}
              />
            </div>
            {analysis ? (
              <div className="edge-glow-summary">
                <div><span>边缘岛</span><strong>{analysis.edgeGlowStats.edgeIslandCount.toLocaleString()}</strong></div>
                <div><span>辉光像素</span><strong>{analysis.edgeGlowStats.glowPixelCount.toLocaleString()}</strong></div>
                <div><span>完成反算</span><strong>{analysis.edgeGlowStats.reconstructedPixelCount.toLocaleString()}</strong></div>
                <div><span>未解决</span><strong>{analysis.edgeGlowStats.unresolvedGlowPixelCount.toLocaleString()}</strong></div>
                <div><span>半透明像素</span><strong>{analysis.edgeGlowStats.semiTransparentPixelCount.toLocaleString()}</strong></div>
              </div>
            ) : (
              <p className="empty-detail">等待背景蒙版结果。</p>
            )}
          </section>

          <section className="module-section selected-pixel-section">
            <div className="module-heading compact">
              <span>PX</span>
              <div><h2>选中像素</h2></div>
            </div>
            {selectedPixelDetail ? (
              <dl className="pixel-details">
                <div><dt>坐标</dt><dd><code>({selectedPixelDetail.x}, {selectedPixelDetail.y})</code></dd></div>
                <div><dt>原始颜色</dt><dd><code>{selectedPixelDetail.sourceColor}</code></dd></div>
                <div><dt>归并颜色</dt><dd><code>{selectedPixelDetail.mergedColor}</code></dd></div>
                <div><dt>输入 Alpha</dt><dd><code>{selectedPixelDetail.alpha}</code></dd></div>
                <div><dt>输出颜色</dt><dd><code>{selectedPixelDetail.outputColor}</code></dd></div>
                <div><dt>输出 Alpha</dt><dd><code>{selectedPixelDetail.outputAlpha}</code></dd></div>
                <div><dt>辉光岛</dt><dd><strong>{selectedPixelDetail.isGlow ? "是" : "否"}</strong></dd></div>
                <div><dt>ΔL</dt><dd><code>{selectedPixelDetail.deltaLightness.toFixed(6)}</code></dd></div>
                <div><dt>ΔC</dt><dd><code>{selectedPixelDetail.deltaChroma.toFixed(6)}</code></dd></div>
                <div><dt>ΔH</dt><dd><code>{selectedPixelDetail.deltaHue.toFixed(6)}</code></dd></div>
                <div><dt>方向距离</dt><dd><code>{selectedPixelDetail.distance.toFixed(6)}</code></dd></div>
                <div><dt>分类</dt><dd><strong>{selectedPixelDetail.classification}</strong></dd></div>
              </dl>
            ) : (
              <p className="empty-detail">在移动模式下点击图像像素。</p>
            )}
          </section>
        </aside>
      </section>
    </main>
  );
}

export default App;
