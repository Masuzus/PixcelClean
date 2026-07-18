import {
  rgbToOklab,
} from "./colorSpace.ts";
import { classifyBackgroundDistances } from "./classifyBackgroundDistances.ts";
import { directionalBackgroundDistance } from "./directionalBackgroundDistance.ts";
import type { RgbColor, RgbaImageView } from "./types";

export type BackgroundMaskResult = {
  backgroundMask: Uint8Array;
  distances: Float32Array;
};

export function generateBackgroundMask(
  image: RgbaImageView,
  backgroundColor: RgbColor,
  threshold: number,
  protectedMask: Uint8Array | null = null,
): BackgroundMaskResult {
  const pixelCount = image.width * image.height;
  if (image.data.length !== pixelCount * 4) throw new Error("RGBA image data size does not match its dimensions.");
  if (!Number.isFinite(threshold)) throw new Error("Background threshold must be finite.");
  if (protectedMask && protectedMask.length !== pixelCount) throw new Error("Protected mask size does not match the image.");

  const distances = new Float32Array(pixelCount);
  const backgroundLab = rgbToOklab(...backgroundColor);
  const colorDistanceCache = new Map<number, number>();

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (image.data[offset + 3] === 0) continue;
    const packedRgb = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
    let distance = colorDistanceCache.get(packedRgb);
    if (distance === undefined) {
      distance = directionalBackgroundDistance(
        rgbToOklab(image.data[offset], image.data[offset + 1], image.data[offset + 2]),
        backgroundLab,
      );
      colorDistanceCache.set(packedRgb, distance);
    }
    distances[pixelIndex] = distance;
  }

  const backgroundMask = classifyBackgroundDistances(image, distances, threshold, protectedMask);
  return { backgroundMask, distances };
}
