import { getHueDegrees, rgbToOklab } from "./algorithms/colorSpace";
import type { ColorEntry } from "./algorithms/types";

export { estimateCornerColor, removeConnectedBackground } from "./algorithms/backgroundRemoval";
export { colorToHex } from "./algorithms/colorSpace";
export { processImage } from "./algorithms/processImage";
export type {
  ColorEntry,
  EdgeMode,
  ImageProcessingOptions,
  ImageProcessingResult,
  ImageProcessingStats,
  PaletteReductionSettings,
  RgbColor,
} from "./algorithms/types";

export type PixelPosition = {
  x: number;
  y: number;
};

export function paintProtectionMask(
  mask: Uint8Array,
  width: number,
  height: number,
  from: PixelPosition,
  to: PixelPosition,
  brushSize: number,
  shouldProtect: boolean,
): Uint8Array {
  const nextMask = new Uint8Array(mask);
  const radius = Math.max(0.5, brushSize / 2);
  const radiusSquared = radius * radius;
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const centerX = Math.round(from.x + (to.x - from.x) * progress);
    const centerY = Math.round(from.y + (to.y - from.y) * progress);
    const startX = Math.max(0, Math.floor(centerX - radius));
    const endX = Math.min(width - 1, Math.ceil(centerX + radius));
    const startY = Math.max(0, Math.floor(centerY - radius));
    const endY = Math.min(height - 1, Math.ceil(centerY + radius));

    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const distanceX = x - centerX;
        const distanceY = y - centerY;
        if (distanceX * distanceX + distanceY * distanceY <= radiusSquared) {
          nextMask[y * width + x] = shouldProtect ? 1 : 0;
        }
      }
    }
  }

  return nextMask;
}

export function getImageColors(image: ImageData): ColorEntry[] {
  const counts = new Map<number, number>();
  const { data } = image;

  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    const rgb = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([rgb, count]) => {
      const red = (rgb >>> 16) & 0xff;
      const green = (rgb >>> 8) & 0xff;
      const blue = rgb & 0xff;
      const lab = rgbToOklab(red, green, blue);
      const rgbHex = `#${[red, green, blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`.toUpperCase();
      return {
        hex: rgbHex,
        cssColor: rgbHex,
        alpha: 255,
        lightness: lab[0],
        hue: getHueDegrees(lab),
        count,
      };
    })
    .sort((left, right) => right.count - left.count || left.hex.localeCompare(right.hex));
}
