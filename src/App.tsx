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
  getImageColors,
  paintProtectionMask,
  type EdgeMode,
  type ImageProcessingStats,
  type PixelPosition,
  type RgbColor,
} from "./imageProcessing";

type InteractionMode = "pan" | "paint" | "erase";
type ProcessingStatus = "dirty" | "processing" | "ready";
type PreviewBackgroundMode = "checkerboard" | "black" | "white" | "custom";
type PaletteSortMode = "frequency" | "dark-to-light";

type ImagePaneProps = {
  image: ImageData | null;
  emptyLabel: string;
  view: ImageView;
  onViewChange: (view: ImageView) => void;
  interactionMode: InteractionMode;
  overlayMask: Uint8Array | null;
  overlayColor: string;
  onPaintMask: (from: PixelPosition, to: PixelPosition, shouldPaint: boolean) => void;
  paneBackgroundColor?: string | null;
};

type ImageView = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

type EditorHistorySnapshot = {
  includeEnclosedAreas: boolean;
  brushSize: number;
  protectedMask: Uint8Array | null;
  backgroundColor: string;
  edgeMode: EdgeMode;
  paletteReductionEnabled: boolean;
  maximumPaletteColors: number;
  previewBackgroundMode: PreviewBackgroundMode;
  previewCustomColor: string;
};

const minimumScale = 0.125;
const maximumScale = 16;
const wheelZoomSensitivity = 0.0025;
const automaticPreviewDelay = 500;
const historyTransactionDelay = 350;
const maximumHistoryEntries = 20;

function getIntegerButtonScale(currentScale: number, direction: -1 | 1): number {
  if (direction > 0) {
    if (currentScale < 1) return 1;
    return Math.min(maximumScale, Math.floor(currentScale) + 1);
  }
  if (currentScale <= 1) return 1;
  return Math.max(1, Math.ceil(currentScale) - 1);
}

function getLinearWheelScale(currentScale: number, deltaY: number): number {
  const nextScale = currentScale - deltaY * wheelZoomSensitivity;
  return Math.round(Math.min(maximumScale, Math.max(minimumScale, nextScale)) * 1000) / 1000;
}

function snapToDevicePixel(value: number): number {
  const pixelRatio = window.devicePixelRatio || 1;
  return Math.round(value * pixelRatio) / pixelRatio;
}

type PixelCleanProject = {
  kind: "pixel-clean-project";
  version: 3;
  source: {
    fileName: string;
    pngDataUrl: string;
  };
  editor: {
    includeEnclosedAreas: boolean;
    imageView: ImageView;
    brushSize: number;
    interactionMode: InteractionMode;
    protectedMask: string;
    autoPreviewEnabled: boolean;
    previewBackground: {
      mode: PreviewBackgroundMode;
      customColor: string;
    };
    backgroundColor: string;
    edgeMode: EdgeMode;
    paletteSortMode: PaletteSortMode;
    paletteReduction: {
      enabled: boolean;
      maximumColors: number;
    };
  };
};

type ProcessingWorkerResponse = {
  id: number;
  imageData?: ArrayBuffer;
  stats?: ImageProcessingStats;
  error?: string;
};

type StatusMessage = {
  timestamp: string;
  text: string;
};

function formatLogTimestamp(date = new Date()): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => value.toString().padStart(2, "0"))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isInteractionMode(value: unknown): value is InteractionMode {
  return value === "pan" || value === "paint" || value === "erase";
}

function isPreviewBackgroundMode(value: unknown): value is PreviewBackgroundMode {
  return value === "checkerboard" || value === "black" || value === "white" || value === "custom";
}

function isPaletteSortMode(value: unknown): value is PaletteSortMode {
  return value === "frequency" || value === "dark-to-light";
}

function isEdgeMode(value: unknown): value is EdgeMode {
  return value === "natural" || value === "hard";
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9A-F]{6}$/i.test(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPixelCleanProject(value: unknown): value is PixelCleanProject {
  if (!isRecord(value) || value.kind !== "pixel-clean-project" || value.version !== 3) return false;
  if (!isRecord(value.source) || typeof value.source.fileName !== "string" || typeof value.source.pngDataUrl !== "string") {
    return false;
  }
  const editor = value.editor;
  if (!isRecord(editor)) return false;
  const imageView = editor.imageView;
  const previewBackground = editor.previewBackground;
  const paletteReduction = editor.paletteReduction;
  return (
    isRecord(imageView)
    && isRecord(previewBackground)
    && isRecord(paletteReduction)
    && typeof editor.includeEnclosedAreas === "boolean"
    && isFiniteNumber(imageView.scale)
    && isFiniteNumber(imageView.offsetX)
    && isFiniteNumber(imageView.offsetY)
    && isFiniteNumber(editor.brushSize)
    && isInteractionMode(editor.interactionMode)
    && typeof editor.protectedMask === "string"
    && typeof editor.autoPreviewEnabled === "boolean"
    && isPreviewBackgroundMode(previewBackground.mode)
    && isHexColor(previewBackground.customColor)
    && isHexColor(editor.backgroundColor)
    && isEdgeMode(editor.edgeMode)
    && isPaletteSortMode(editor.paletteSortMode)
    && typeof paletteReduction.enabled === "boolean"
    && isFiniteNumber(paletteReduction.maximumColors)
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function hexToColor(hex: string): RgbColor {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
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
  overlayMask,
  overlayColor,
  onPaintMask,
  paneBackgroundColor = null,
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
    const nextScale = getLinearWheelScale(view.scale, deltaY);
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
    if (overlayMask && interactionMode !== "pan") {
      context.save();
      context.fillStyle = overlayColor;
      for (let pixelIndex = 0; pixelIndex < overlayMask.length; pixelIndex += 1) {
        if (overlayMask[pixelIndex] === 1) {
          context.fillRect(pixelIndex % image.width, Math.floor(pixelIndex / image.width), 1, 1);
        }
      }
      context.restore();
    }
  }, [image, interactionMode, overlayColor, overlayMask]);

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
      onPaintMask(position, position, interactionMode === "paint");
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
        onPaintMask(brushPoint, position, interactionMode === "paint");
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
      className={`image-pane ${paneBackgroundColor === null ? "checkerboard" : ""} ${image ? "is-interactive" : ""} ${
        interactionMode !== "pan" ? "is-painting" : ""
      }`}
      ref={paneRef}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      style={paneBackgroundColor === null ? undefined : { backgroundColor: paneBackgroundColor }}
    >
      {image ? (
        <canvas
          aria-label={emptyLabel}
          ref={canvasRef}
          style={{
            height: image.height * view.scale,
            transform: `translate(calc(-50% + ${snapToDevicePixel(view.offsetX)}px), calc(-50% + ${snapToDevicePixel(view.offsetY)}px))`,
            width: image.width * view.scale,
          }}
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
  const [fileName, setFileName] = useState("");
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<StatusMessage>(() => ({
    timestamp: formatLogTimestamp(),
    text: "导入一张 PNG，开始清理统一背景。",
  }));
  const message = statusMessage.text;
  const setMessage = (text: string) => setStatusMessage({ timestamp: formatLogTimestamp(), text });
  const [isDragging, setIsDragging] = useState(false);
  const [imageView, setImageView] = useState<ImageView>({ scale: 1, offsetX: 0, offsetY: 0 });
  const [includeEnclosedAreas, setIncludeEnclosedAreas] = useState(true);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>("pan");
  const [brushSize, setBrushSize] = useState(12);
  const [protectedMask, setProtectedMask] = useState<Uint8Array | null>(null);
  const [backgroundColor, setBackgroundColor] = useState("#1C1523");
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("natural");
  const [paletteReductionEnabled, setPaletteReductionEnabled] = useState(true);
  const [maximumPaletteColors, setMaximumPaletteColors] = useState(16);
  const [paletteSortMode, setPaletteSortMode] = useState<PaletteSortMode>("frequency");
  const [previewBackgroundMode, setPreviewBackgroundMode] = useState<PreviewBackgroundMode>("checkerboard");
  const [previewCustomColor, setPreviewCustomColor] = useState("#6B7280");
  const [autoPreviewEnabled, setAutoPreviewEnabled] = useState(true);
  const [processedImage, setProcessedImage] = useState<ImageData | null>(null);
  const [processingStatus, setProcessingStatus] = useState<ProcessingStatus>("dirty");
  const [processingStats, setProcessingStats] = useState<ImageProcessingStats | null>(null);
  const [isClosePromptVisible, setIsClosePromptVisible] = useState(false);
  const [isSavingBeforeClose, setIsSavingBeforeClose] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeApprovedRef = useRef(false);
  const processingWorkerRef = useRef<Worker | null>(null);
  const processingRequestIdRef = useRef(0);
  const autoPreviewTimerRef = useRef<number | null>(null);
  const updateHighQualityPreviewRef = useRef<() => void>(() => undefined);
  const suppressNextAutoPreviewRef = useRef(false);
  const saveProjectRef = useRef<() => Promise<boolean>>(async () => false);
  const undoEditorRef = useRef<() => void>(() => undefined);
  const redoEditorRef = useRef<() => void>(() => undefined);
  const historySourceRef = useRef<ImageData | null>(null);
  const historyTimerRef = useRef<number | null>(null);
  const historyTransactionActiveRef = useRef(false);
  const isApplyingHistoryRef = useRef(false);
  const lastCommittedSnapshotRef = useRef<EditorHistorySnapshot | null>(null);
  const undoStackRef = useRef<EditorHistorySnapshot[]>([]);
  const redoStackRef = useRef<EditorHistorySnapshot[]>([]);

  const protectedPixelCount = useMemo(
    () => protectedMask?.reduce((count, value) => count + value, 0) ?? 0,
    [protectedMask],
  );
  const palette = useMemo(() => (processedImage ? getImageColors(processedImage) : []), [processedImage]);
  const sortedPalette = useMemo(() => {
    if (paletteSortMode === "frequency") return palette;
    return [...palette].sort((left, right) => (
      left.lightness - right.lightness
      || left.hue - right.hue
      || left.hex.localeCompare(right.hex)
    ));
  }, [palette, paletteSortMode]);
  const entityRgbColorCount = palette.length;
  const resultPaneBackgroundColor = previewBackgroundMode === "checkerboard"
    ? null
    : previewBackgroundMode === "black"
      ? "#000000"
      : previewBackgroundMode === "white"
        ? "#FFFFFF"
        : previewCustomColor;
  const previewBackgroundLabel = previewBackgroundMode === "checkerboard"
    ? "透明棋盘格"
    : previewBackgroundMode === "black"
      ? "黑色预览"
      : previewBackgroundMode === "white"
        ? "白色预览"
        : `${previewCustomColor} 预览`;

  const captureEditorSnapshot = (): EditorHistorySnapshot => ({
    includeEnclosedAreas,
    brushSize,
    protectedMask,
    backgroundColor,
    edgeMode,
    paletteReductionEnabled,
    maximumPaletteColors,
    previewBackgroundMode,
    previewCustomColor,
  });

  const applyEditorSnapshot = (snapshot: EditorHistorySnapshot) => {
    setIncludeEnclosedAreas(snapshot.includeEnclosedAreas);
    setBrushSize(snapshot.brushSize);
    setProtectedMask(snapshot.protectedMask);
    setBackgroundColor(snapshot.backgroundColor);
    setEdgeMode(snapshot.edgeMode);
    setPaletteReductionEnabled(snapshot.paletteReductionEnabled);
    setMaximumPaletteColors(snapshot.maximumPaletteColors);
    setPreviewBackgroundMode(snapshot.previewBackgroundMode);
    setPreviewCustomColor(snapshot.previewCustomColor);
  };

  const clearHistoryTimer = () => {
    if (historyTimerRef.current === null) return;
    window.clearTimeout(historyTimerRef.current);
    historyTimerRef.current = null;
  };

  const undoEditor = () => {
    if (!sourceImage) return;
    clearHistoryTimer();
    const target = undoStackRef.current.pop();
    if (!target) {
      setMessage("没有可撤销的编辑。");
      return;
    }
    redoStackRef.current.push(captureEditorSnapshot());
    isApplyingHistoryRef.current = true;
    historyTransactionActiveRef.current = false;
    lastCommittedSnapshotRef.current = target;
    applyEditorSnapshot(target);
    setMessage("已撤销上一步编辑。");
  };

  const redoEditor = () => {
    if (!sourceImage) return;
    clearHistoryTimer();
    const target = redoStackRef.current.pop();
    if (!target) {
      setMessage("没有可重做的编辑。");
      return;
    }
    undoStackRef.current.push(captureEditorSnapshot());
    isApplyingHistoryRef.current = true;
    historyTransactionActiveRef.current = false;
    lastCommittedSnapshotRef.current = target;
    applyEditorSnapshot(target);
    setMessage("已重做上一步编辑。");
  };

  undoEditorRef.current = undoEditor;
  redoEditorRef.current = redoEditor;

  useEffect(() => {
    const snapshot = captureEditorSnapshot();
    if (historySourceRef.current !== sourceImage) {
      clearHistoryTimer();
      historySourceRef.current = sourceImage;
      historyTransactionActiveRef.current = false;
      isApplyingHistoryRef.current = false;
      undoStackRef.current = [];
      redoStackRef.current = [];
      lastCommittedSnapshotRef.current = sourceImage ? snapshot : null;
      return;
    }
    if (!sourceImage) return;
    if (isApplyingHistoryRef.current) {
      isApplyingHistoryRef.current = false;
      historyTransactionActiveRef.current = false;
      lastCommittedSnapshotRef.current = snapshot;
      return;
    }
    const lastCommitted = lastCommittedSnapshotRef.current;
    if (!lastCommitted) {
      lastCommittedSnapshotRef.current = snapshot;
      return;
    }
    if (!historyTransactionActiveRef.current) {
      undoStackRef.current.push(lastCommitted);
      if (undoStackRef.current.length > maximumHistoryEntries) undoStackRef.current.shift();
      redoStackRef.current = [];
      historyTransactionActiveRef.current = true;
    }
    clearHistoryTimer();
    historyTimerRef.current = window.setTimeout(() => {
      historyTimerRef.current = null;
      lastCommittedSnapshotRef.current = snapshot;
      historyTransactionActiveRef.current = false;
    }, historyTransactionDelay);
  }, [
    sourceImage,
    includeEnclosedAreas,
    brushSize,
    protectedMask,
    backgroundColor,
    edgeMode,
    paletteReductionEnabled,
    maximumPaletteColors,
    previewBackgroundMode,
    previewCustomColor,
  ]);

  useEffect(() => {
    if (!sourceImage) return;
    processingWorkerRef.current?.terminate();
    processingWorkerRef.current = null;
    processingRequestIdRef.current += 1;
    setProcessingStatus("dirty");
    setProcessingStats(null);
  }, [
    sourceImage,
    includeEnclosedAreas,
    protectedMask,
    backgroundColor,
    edgeMode,
    paletteReductionEnabled,
    maximumPaletteColors,
  ]);

  useEffect(() => {
    if (autoPreviewTimerRef.current !== null) {
      window.clearTimeout(autoPreviewTimerRef.current);
      autoPreviewTimerRef.current = null;
    }
    if (!sourceImage || !autoPreviewEnabled || processingStatus !== "dirty") return;
    if (suppressNextAutoPreviewRef.current) {
      suppressNextAutoPreviewRef.current = false;
      return;
    }
    autoPreviewTimerRef.current = window.setTimeout(() => {
      autoPreviewTimerRef.current = null;
      updateHighQualityPreviewRef.current();
    }, automaticPreviewDelay);
    return () => {
      if (autoPreviewTimerRef.current !== null) {
        window.clearTimeout(autoPreviewTimerRef.current);
        autoPreviewTimerRef.current = null;
      }
    };
  }, [
    sourceImage,
    autoPreviewEnabled,
    processingStatus,
    includeEnclosedAreas,
    protectedMask,
    backgroundColor,
    edgeMode,
    paletteReductionEnabled,
    maximumPaletteColors,
  ]);

  useEffect(() => () => {
    processingWorkerRef.current?.terminate();
    if (autoPreviewTimerRef.current !== null) window.clearTimeout(autoPreviewTimerRef.current);
    if (historyTimerRef.current !== null) window.clearTimeout(historyTimerRef.current);
  }, []);

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
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
      setProjectPath(null);
      setImageView({ scale: 1, offsetX: 0, offsetY: 0 });
      setProtectedMask(new Uint8Array(image.width * image.height));
      setBackgroundColor(colorToHex(estimateCornerColor(image)));
      setProcessedImage(null);
      setProcessingStats(null);
      setInteractionMode("pan");
      setMessage(
        `已导入 ${file.name}（${image.width} × ${image.height}）${autoPreviewEnabled ? "，即将自动更新预览。" : "，请更新高质量预览。"}`,
      );
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
      version: 3,
      source: {
        fileName: fileName || "pixel.png",
        pngDataUrl: imageDataToDataUrl(sourceImage),
      },
      editor: {
        includeEnclosedAreas,
        imageView,
        brushSize,
        interactionMode,
        autoPreviewEnabled,
        previewBackground: {
          mode: previewBackgroundMode,
          customColor: previewCustomColor,
        },
        backgroundColor,
        edgeMode,
        paletteSortMode,
        paletteReduction: {
          enabled: paletteReductionEnabled,
          maximumColors: maximumPaletteColors,
        },
        protectedMask: maskToBase64(protectedMask ?? new Uint8Array(sourceImage.width * sourceImage.height)),
      },
    };
    return {
      contents: JSON.stringify(project, null, 2),
      suggestedName: `${fileName.replace(/\.png$/i, "") || "pixel"}.pixelclean.json`,
    };
  };

  const restoreProject = async (contents: string, path: string) => {
    try {
      const projectName = path.split(/[/\\]/).pop() ?? "工程文件";
      const project: unknown = JSON.parse(contents);
      if (!isPixelCleanProject(project)) throw new Error("不是有效的 Pixel Clean 工程文件。");
      const image = await loadImageDataUrl(project.source.pngDataUrl);
      const mask = base64ToMask(project.editor.protectedMask, image.width * image.height);
      if (!mask) throw new Error("工程保护蒙版无效。");
      setSourceImage(image);
      setFileName(project.source.fileName);
      setProjectPath(path);
      setIncludeEnclosedAreas(project.editor.includeEnclosedAreas);
      setImageView({
        scale: clamp(project.editor.imageView.scale, minimumScale, maximumScale),
        offsetX: project.editor.imageView.offsetX,
        offsetY: project.editor.imageView.offsetY,
      });
      setBrushSize(clamp(project.editor.brushSize, 1, 80));
      setInteractionMode(project.editor.interactionMode);
      setProtectedMask(mask);
      setProcessedImage(null);
      setProcessingStats(null);
      setBackgroundColor(project.editor.backgroundColor.toUpperCase());
      setEdgeMode(project.editor.edgeMode);
      setPreviewBackgroundMode(project.editor.previewBackground.mode);
      setPreviewCustomColor(project.editor.previewBackground.customColor.toUpperCase());
      setAutoPreviewEnabled(project.editor.autoPreviewEnabled);
      setPaletteReductionEnabled(project.editor.paletteReduction.enabled);
      setMaximumPaletteColors(clamp(project.editor.paletteReduction.maximumColors, 8, 20));
      setPaletteSortMode(project.editor.paletteSortMode);
      setMessage(
        `已打开工程 ${projectName}${project.editor.autoPreviewEnabled ? "，即将自动更新预览。" : "，请强制渲染预览。"}`,
      );
    } catch {
      setMessage("无法打开工程文件，请确认它未损坏且来自 Pixel Clean。");
    }
  };

  const saveProject = async () => {
    const projectFile = createProjectFile();
    if (!projectFile) return false;
    try {
      let targetPath = projectPath;
      if (targetPath === null) {
        targetPath = await save({
          defaultPath: projectFile.suggestedName,
          filters: [{ name: "Pixel Clean 工程", extensions: ["json"] }],
        });
        if (targetPath === null) {
          setMessage("已取消保存工程。");
          return false;
        }
      }
      await invoke("write_project_file", { path: targetPath, contents: projectFile.contents });
      setProjectPath(targetPath);
      setMessage(`工程已保存：${targetPath.split(/[/\\]/).pop() ?? targetPath}`);
      return true;
    } catch {
      setMessage(projectPath ? "无法写入当前工程文件，工程未保存。" : "无法保存工程文件，工程未保存。");
      return false;
    }
  };

  saveProjectRef.current = saveProject;

  useEffect(() => {
    const handleKeyboardShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "s" && !event.shiftKey) {
        event.preventDefault();
        void saveProjectRef.current();
        return;
      }
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redoEditorRef.current();
        else undoEditorRef.current();
        return;
      }
      if (key === "y" && !event.shiftKey) {
        event.preventDefault();
        redoEditorRef.current();
      }
    };
    window.addEventListener("keydown", handleKeyboardShortcut);
    return () => window.removeEventListener("keydown", handleKeyboardShortcut);
  }, []);

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
      await restoreProject(contents, path);
    } catch {
      setMessage("无法打开桌面工程文件对话框。");
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    void importFile(event.dataTransfer.files[0]);
  };

  const paintProtection = (from: PixelPosition, to: PixelPosition, shouldPaint: boolean) => {
    if (!sourceImage) return;
    setProtectedMask((mask) => paintProtectionMask(
      mask ?? new Uint8Array(sourceImage.width * sourceImage.height),
      sourceImage.width,
      sourceImage.height,
      from,
      to,
      brushSize,
      shouldPaint,
    ));
  };

  const updateHighQualityPreview = () => {
    if (!sourceImage) return;
    if (autoPreviewTimerRef.current !== null) {
      window.clearTimeout(autoPreviewTimerRef.current);
      autoPreviewTimerRef.current = null;
    }
    processingWorkerRef.current?.terminate();
    const worker = new Worker(new URL("./imageProcessing.worker.ts", import.meta.url), { type: "module" });
    processingWorkerRef.current = worker;
    const requestId = processingRequestIdRef.current + 1;
    processingRequestIdRef.current = requestId;
    const width = sourceImage.width;
    const height = sourceImage.height;
    const imageData = new Uint8ClampedArray(sourceImage.data);
    const protectedData = protectedMask ? new Uint8Array(protectedMask) : null;

    setProcessingStatus("processing");
    setMessage("正在执行全分辨率高质量处理…");
    worker.onmessage = (event: MessageEvent<ProcessingWorkerResponse>) => {
      if (event.data.id !== processingRequestIdRef.current) return;
      worker.terminate();
      processingWorkerRef.current = null;
      if (event.data.error || !event.data.imageData || !event.data.stats) {
        suppressNextAutoPreviewRef.current = true;
        setProcessingStatus("dirty");
        setMessage(event.data.error ?? "图像处理失败。");
        return;
      }
      setProcessedImage(new ImageData(new Uint8ClampedArray(event.data.imageData), width, height));
      setProcessingStats(event.data.stats);
      setProcessingStatus("ready");
      setMessage(
        `高质量预览已更新：${event.data.stats.originalColorCount.toLocaleString()} 色规整为 ${event.data.stats.reducedColorCount.toLocaleString()} 色，恢复 ${event.data.stats.decontaminatedEdgePixels.toLocaleString()} 个边缘像素。`,
      );
    };
    worker.onerror = () => {
      if (requestId !== processingRequestIdRef.current) return;
      worker.terminate();
      processingWorkerRef.current = null;
      suppressNextAutoPreviewRef.current = true;
      setProcessingStatus("dirty");
      setMessage("高质量处理进程异常退出，请重试。");
    };

    const imageBuffer = imageData.buffer as ArrayBuffer;
    const protectedBuffer = protectedData?.buffer as ArrayBuffer | undefined;
    worker.postMessage(
      {
        id: requestId,
        width,
        height,
        imageData: imageBuffer,
        protectedMask: protectedBuffer ?? null,
        includeEnclosedAreas,
        backgroundColor: hexToColor(backgroundColor),
        edgeMode,
        paletteReduction: {
          enabled: paletteReductionEnabled,
          maximumColors: maximumPaletteColors,
        },
      },
      [imageBuffer, ...(protectedBuffer ? [protectedBuffer] : [])],
    );
  };

  updateHighQualityPreviewRef.current = updateHighQualityPreview;

  const cancelProcessing = () => {
    processingWorkerRef.current?.terminate();
    processingWorkerRef.current = null;
    processingRequestIdRef.current += 1;
    suppressNextAutoPreviewRef.current = true;
    setProcessingStatus("dirty");
    setMessage("已取消处理，当前预览仍是旧结果。");
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
          <button
            className="secondary"
            disabled={!sourceImage}
            onClick={() => void saveProject()}
            title="保存工程（Command/Ctrl + S）"
            type="button"
          >
            保存工程
          </button>
          <button
            className="primary"
            disabled={!processedImage || processingStatus !== "ready"}
            onClick={exportImage}
            type="button"
          >
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
                onPaintMask={paintProtection}
                overlayColor="rgba(229, 134, 255, 0.42)"
                overlayMask={protectedMask}
                view={imageView}
              />
            </section>
            <section className="preview-card">
              <div className="preview-heading">
                <span>处理结果</span>
                <small>{previewBackgroundLabel}</small>
              </div>
              <ImagePane
                emptyLabel="处理结果将在这里显示"
                image={processedImage}
                interactionMode={interactionMode}
                onViewChange={setImageView}
                onPaintMask={paintProtection}
                overlayColor="rgba(229, 134, 255, 0.42)"
                overlayMask={protectedMask}
                paneBackgroundColor={resultPaneBackgroundColor}
                view={imageView}
              />
            </section>
          </div>
          <div className="canvas-footer">
            <p className="status-message">
              <time>{statusMessage.timestamp}</time>
              <span>{message}</span>
            </p>
            <div className="view-controls" aria-label="画布视图控制">
              <button
                aria-label="缩小"
                disabled={!sourceImage || imageView.scale <= 1}
                onClick={() => setImageView((view) => ({ ...view, scale: getIntegerButtonScale(view.scale, -1) }))}
                type="button"
              >
                −
              </button>
              <output
                className={Number.isInteger(imageView.scale) ? "" : "is-fractional"}
                title={Number.isInteger(imageView.scale) ? "整数像素倍率" : "连续浏览倍率；点击 − 或 + 回到整数像素倍率"}
              >
                {Math.round(imageView.scale * 1000) / 10}%
              </output>
              <button
                aria-label="放大"
                disabled={!sourceImage || imageView.scale >= maximumScale}
                onClick={() => setImageView((view) => ({ ...view, scale: getIntegerButtonScale(view.scale, 1) }))}
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
                1:1 重置
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
            <p className="help-text">自动分析背景波动，并从边缘混色中恢复干净的前景颜色与透明度。</p>
            <div className="color-sample">
              <input
                aria-label="背景色"
                disabled={!sourceImage}
                onChange={(event) => setBackgroundColor(event.target.value.toUpperCase())}
                type="color"
                value={backgroundColor}
              />
              <div>
                <small>处理背景色</small>
                <strong>{backgroundColor}</strong>
              </div>
            </div>
            <p className="control-label">边缘输出</p>
            <div className="edge-mode-control" aria-label="边缘输出模式">
              <button
                className={edgeMode === "natural" ? "is-active" : ""}
                disabled={!sourceImage}
                onClick={() => setEdgeMode("natural")}
                type="button"
              >
                <strong>自然边缘</strong>
                <small>恢复半透明覆盖率</small>
              </button>
              <button
                className={edgeMode === "hard" ? "is-active" : ""}
                disabled={!sourceImage}
                onClick={() => setEdgeMode("hard")}
                type="button"
              >
                <strong>硬像素边缘</strong>
                <small>仅输出透明或不透明</small>
              </button>
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
            <p className="safety-note">若主体与背景颜色接近，请使用保护画笔后重新渲染。</p>
          </section>

          <section className="panel-section preview-background-section">
            <div className="section-title">
              <h2>结果预览背景</h2>
              <span className="badge muted">仅预览</span>
            </div>
            <p className="help-text">切换右侧处理结果的底色，用于检查亮边、暗边和半透明像素。</p>
            <div className="preview-background-options">
              <button
                className={previewBackgroundMode === "checkerboard" ? "is-active" : ""}
                onClick={() => setPreviewBackgroundMode("checkerboard")}
                type="button"
              >
                棋盘格
              </button>
              <button
                className={previewBackgroundMode === "black" ? "is-active" : ""}
                onClick={() => setPreviewBackgroundMode("black")}
                type="button"
              >
                黑色
              </button>
              <button
                className={previewBackgroundMode === "white" ? "is-active" : ""}
                onClick={() => setPreviewBackgroundMode("white")}
                type="button"
              >
                白色
              </button>
              <button
                className={previewBackgroundMode === "custom" ? "is-active" : ""}
                onClick={() => setPreviewBackgroundMode("custom")}
                type="button"
              >
                自定义
              </button>
            </div>
            <label className="preview-custom-color">
              <span>自定义底色</span>
              <input
                onChange={(event) => {
                  setPreviewCustomColor(event.target.value.toUpperCase());
                  setPreviewBackgroundMode("custom");
                }}
                type="color"
                value={previewCustomColor}
              />
              <code>{previewCustomColor}</code>
            </label>
            <p className="preview-export-note">此设置不写入 PNG 像素；导出文件仍保持透明背景。</p>
          </section>

          <section className="panel-section">
            <div className="section-title">
              <h2>保护区域</h2>
              <span className="badge">精细处理</span>
            </div>
            <p className="help-text">保护区域不会被背景剔除，但仍会参与最终的相似颜色规整。</p>
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
            {interactionMode === "paint" && <p className="selection-tip">在原图或结果图上拖拽，涂抹需要保留为前景的区域。</p>}
            {interactionMode === "erase" && <p className="selection-tip">涂抹紫色覆盖层，恢复该处的图像处理。</p>}
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

          <section className="panel-section palette-reduction-section">
            <div className="section-title">
              <h2>相似颜色替换</h2>
              <span className="badge">像素规整</span>
            </div>
            <p className="help-text">在 OKLab 感知空间聚合相似颜色，并实际替换输出像素；透明色不计入颜色上限。</p>
            <label className="toggle-row">
              <input
                checked={paletteReductionEnabled}
                disabled={!sourceImage}
                onChange={(event) => setPaletteReductionEnabled(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong>启用相似颜色替换</strong>
                <small>默认启用，不使用抖动，不产生额外噪点颜色。</small>
              </span>
            </label>
            <label className="range-label" htmlFor="maximum-palette-colors">
              <span>最大实体颜色数</span>
              <output>{maximumPaletteColors}</output>
            </label>
            <input
              disabled={!sourceImage || !paletteReductionEnabled}
              id="maximum-palette-colors"
              max="20"
              min="8"
              onChange={(event) => setMaximumPaletteColors(Number(event.target.value))}
              step="1"
              type="range"
              value={maximumPaletteColors}
            />
            <p className="palette-reduction-note">输出使用原图中实际存在的代表色；不插值、不抖动，最终实体颜色数不会超过设定值。</p>
            <div className={`processing-card is-${processingStatus}`}>
              <label className="auto-preview-toggle">
                <input
                  checked={autoPreviewEnabled}
                  disabled={!sourceImage}
                  onChange={(event) => setAutoPreviewEnabled(event.target.checked)}
                  type="checkbox"
                />
                <span>参数停止变化后自动渲染</span>
              </label>
              <strong>
                {!sourceImage && "导入图片后将自动生成预览"}
                {sourceImage && processingStatus === "ready" && "高质量预览已是最新"}
                {sourceImage && processingStatus === "dirty" && (
                  autoPreviewEnabled
                    ? "检测到修改，停止操作后将自动更新"
                    : "参数或蒙版已修改，预览尚未更新"
                )}
                {sourceImage && processingStatus === "processing" && "正在执行全分辨率处理…"}
              </strong>
              {processingStats && processingStatus === "ready" && (
                <small>
                  {processingStats.originalColorCount.toLocaleString()} 色 → {processingStats.reducedColorCount.toLocaleString()} 色，
                  替换 {processingStats.replacedColorPixels.toLocaleString()} px；恢复边缘 {processingStats.decontaminatedEdgePixels.toLocaleString()} px，
                  半透明 {processingStats.semiTransparentPixels.toLocaleString()} px
                </small>
              )}
              {processingStatus === "processing" ? (
                <button onClick={cancelProcessing} type="button">取消</button>
              ) : (
                <button
                  className="primary"
                  disabled={!sourceImage}
                  onClick={updateHighQualityPreview}
                  type="button"
                >
                  强制高质量渲染
                </button>
              )}
            </div>
          </section>

          <section className="panel-section palette-section">
            <div className="section-title">
              <h2>全部像素颜色</h2>
              <span className="badge muted">{entityRgbColorCount.toLocaleString()} RGB 色</span>
            </div>
            <p className="help-text">按实体 RGB 合并统计；半透明像素计入对应颜色，完全透明背景不显示。</p>
            <div className="palette-sort-control" aria-label="颜色排序">
              <button
                className={paletteSortMode === "frequency" ? "is-active" : ""}
                onClick={() => setPaletteSortMode("frequency")}
                type="button"
              >
                使用次数
              </button>
              <button
                className={paletteSortMode === "dark-to-light" ? "is-active" : ""}
                onClick={() => setPaletteSortMode("dark-to-light")}
                type="button"
              >
                深 → 浅
              </button>
            </div>
            <div className="palette-list">
              {palette.length > 0 ? (
                sortedPalette.map((color) => (
                  <div className="palette-item" key={color.hex}>
                    <span className="palette-swatch">
                      <i style={{ backgroundColor: color.cssColor }} />
                    </span>
                    <code>{color.hex}</code>
                    <small>{color.count.toLocaleString()} px</small>
                  </div>
                ))
              ) : (
                <p className="empty-palette">生成处理结果后显示全部像素颜色。</p>
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
