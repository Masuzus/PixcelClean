import type { RgbaImageView } from "./types.ts";

function validateInputs(
  image: RgbaImageView,
  distances: Float32Array,
  threshold: number,
  protectedMask: Uint8Array | null,
): void {
  const pixelCount = image.width * image.height;
  if (image.data.length !== pixelCount * 4) throw new Error("RGBA image data size does not match its dimensions.");
  if (distances.length !== pixelCount) throw new Error("Background distance field size does not match the image.");
  if (!Number.isFinite(threshold)) throw new Error("Background threshold must be finite.");
  if (protectedMask && protectedMask.length !== pixelCount) throw new Error("Protected mask size does not match the image.");
}

export function classifyBackgroundDistances(
  image: RgbaImageView,
  distances: Float32Array,
  threshold: number,
  protectedMask: Uint8Array | null = null,
): Uint8Array {
  validateInputs(image, distances, threshold, protectedMask);
  const backgroundMask = new Uint8Array(distances.length);
  for (let pixelIndex = 0; pixelIndex < distances.length; pixelIndex += 1) {
    const alpha = image.data[pixelIndex * 4 + 3];
    if (alpha === 0 || protectedMask?.[pixelIndex] === 1) continue;
    if (distances[pixelIndex] <= threshold) backgroundMask[pixelIndex] = 1;
  }
  return backgroundMask;
}
