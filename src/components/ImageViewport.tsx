import {
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PixelPosition } from "../editor/protectionMask";

export type ImageView = {
  zoom: number;
  offsetX: number;
  offsetY: number;
};

export type InteractionMode = "pan" | "protect" | "erase";

type ImageViewportProps = {
  image: ImageData | null;
  label: string;
  previewBackgroundColor?: string | null;
  view: ImageView;
  interactionMode: InteractionMode;
  protectionMask: Uint8Array | null;
  selectedPixel: PixelPosition | null;
  onViewChange: (view: ImageView) => void;
  onPaintProtection: (from: PixelPosition, to: PixelPosition, shouldProtect: boolean) => void;
  onSelectPixel: (pixel: PixelPosition) => void;
};

function snapToDevicePixel(value: number): number {
  const pixelRatio = window.devicePixelRatio || 1;
  return Math.round(value * pixelRatio) / pixelRatio;
}

export default function ImageViewport({
  image,
  label,
  previewBackgroundColor = null,
  view,
  interactionMode,
  protectionMask,
  selectedPixel,
  onViewChange,
  onPaintProtection,
  onSelectPixel,
}: ImageViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);
  const brushRef = useRef<{ pointerId: number; point: PixelPosition } | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !image) return;
    const updateFitScale = () => {
      const availableWidth = Math.max(1, viewport.clientWidth - 32);
      const availableHeight = Math.max(1, viewport.clientHeight - 32);
      setFitScale(Math.min(availableWidth / image.width, availableHeight / image.height));
    };
    updateFitScale();
    const observer = new ResizeObserver(updateFitScale);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [image]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = false;
    context.putImageData(image, 0, 0);
    if (protectionMask && interactionMode !== "pan") {
      context.fillStyle = "rgba(216, 76, 151, 0.48)";
      for (let pixelIndex = 0; pixelIndex < protectionMask.length; pixelIndex += 1) {
        if (protectionMask[pixelIndex] === 1) {
          context.fillRect(pixelIndex % image.width, Math.floor(pixelIndex / image.width), 1, 1);
        }
      }
    }
  }, [image, interactionMode, protectionMask]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !image) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.16 : 1 / 1.16;
      const zoom = Math.min(32, Math.max(0.2, view.zoom * factor));
      onViewChange({ ...view, zoom });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [image, onViewChange, view]);

  const getImagePosition = (event: PointerEvent<HTMLDivElement>): PixelPosition | null => {
    const canvas = canvasRef.current;
    if (!canvas || !image) return null;
    const bounds = canvas.getBoundingClientRect();
    if (
      event.clientX < bounds.left
      || event.clientX >= bounds.right
      || event.clientY < bounds.top
      || event.clientY >= bounds.bottom
    ) return null;
    return {
      x: Math.min(image.width - 1, Math.max(0, Math.floor((event.clientX - bounds.left) / bounds.width * image.width))),
      y: Math.min(image.height - 1, Math.max(0, Math.floor((event.clientY - bounds.top) / bounds.height * image.height))),
    };
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!image || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (interactionMode === "pan") {
      dragRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        offsetX: view.offsetX,
        offsetY: view.offsetY,
        moved: false,
      };
      return;
    }
    const point = getImagePosition(event);
    if (!point) return;
    brushRef.current = { pointerId: event.pointerId, point };
    onPaintProtection(point, point, interactionMode === "protect");
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const brush = brushRef.current;
    if (brush?.pointerId === event.pointerId) {
      const point = getImagePosition(event);
      if (!point) return;
      onPaintProtection(brush.point, point, interactionMode === "protect");
      brushRef.current = { pointerId: event.pointerId, point };
      return;
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - drag.clientX;
    const deltaY = event.clientY - drag.clientY;
    if (Math.hypot(deltaX, deltaY) >= 3) drag.moved = true;
    if (!drag.moved) return;
    onViewChange({
      ...view,
      offsetX: drag.offsetX + deltaX,
      offsetY: drag.offsetY + deltaY,
    });
  };

  const handlePointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag?.pointerId === event.pointerId) {
      if (!drag.moved) {
        const point = getImagePosition(event);
        if (point) onSelectPixel(point);
      }
      dragRef.current = null;
    }
    if (brushRef.current?.pointerId === event.pointerId) brushRef.current = null;
  };

  const displayScale = fitScale * view.zoom;
  return (
    <div
      className={`image-viewport ${previewBackgroundColor ? "has-preview-background" : "checkerboard"} is-${interactionMode}`}
      onPointerCancel={handlePointerEnd}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerEnd}
      ref={viewportRef}
      style={previewBackgroundColor ? { backgroundColor: previewBackgroundColor } : undefined}
    >
      {image ? (
        <>
          <canvas
            aria-label={label}
            ref={canvasRef}
            style={{
              height: image.height * displayScale,
              width: image.width * displayScale,
              transform: `translate(calc(-50% + ${snapToDevicePixel(view.offsetX)}px), calc(-50% + ${snapToDevicePixel(view.offsetY)}px))`,
            }}
          />
          {selectedPixel && (
            <span
              aria-hidden="true"
              className="selected-pixel-marker"
              style={{
                height: displayScale,
                left: `calc(50% + ${snapToDevicePixel(view.offsetX - image.width * displayScale / 2 + selectedPixel.x * displayScale)}px)`,
                top: `calc(50% + ${snapToDevicePixel(view.offsetY - image.height * displayScale / 2 + selectedPixel.y * displayScale)}px)`,
                width: displayScale,
              }}
            />
          )}
        </>
      ) : (
        <div className="empty-viewport">{label}</div>
      )}
    </div>
  );
}
