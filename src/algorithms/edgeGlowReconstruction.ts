import { clamp, srgbToLinear } from "./colorSpace.ts";
import type { RgbColor, RgbaImageView } from "./types.ts";

export const edgeGlowAlgorithmVersion = "edge-glow-v1";
export const defaultEdgeGlowWidth = 0.1;

export type EdgeGlowStats = {
  edgeSeedPixelCount: number;
  edgeIslandCount: number;
  glowPixelCount: number;
  reconstructedPixelCount: number;
  unresolvedGlowPixelCount: number;
  semiTransparentPixelCount: number;
};

export type EdgeGlowResult = {
  image: RgbaImageView;
  glowMask: Uint8Array;
  stats: EdgeGlowStats;
};

type ForegroundAnchor = {
  rgb: RgbColor;
  linear: [number, number, number];
  spatialDistance: number;
};

function packedRgb(image: RgbaImageView, pixelIndex: number): number {
  const offset = pixelIndex * 4;
  return (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
}

function linearRgb(image: RgbaImageView, pixelIndex: number): [number, number, number] {
  const offset = pixelIndex * 4;
  return [
    srgbToLinear(image.data[offset] / 255),
    srgbToLinear(image.data[offset + 1] / 255),
    srgbToLinear(image.data[offset + 2] / 255),
  ];
}

function hasBackgroundNeighbor(
  pixelIndex: number,
  width: number,
  height: number,
  backgroundMask: Uint8Array,
): boolean {
  const x = pixelIndex % width;
  const y = Math.floor(pixelIndex / width);
  return (
    (x > 0 && backgroundMask[pixelIndex - 1] === 1)
    || (x + 1 < width && backgroundMask[pixelIndex + 1] === 1)
    || (y > 0 && backgroundMask[pixelIndex - width] === 1)
    || (y + 1 < height && backgroundMask[pixelIndex + width] === 1)
  );
}

function collectLocalAnchors(
  image: RgbaImageView,
  pixelIndex: number,
  backgroundMask: Uint8Array,
  glowMask: Uint8Array,
  distances: Float32Array,
): ForegroundAnchor[] {
  const centerX = pixelIndex % image.width;
  const centerY = Math.floor(pixelIndex / image.width);
  const minimumDistance = distances[pixelIndex] + 0.004;
  const anchors: ForegroundAnchor[] = [];
  const seenColors = new Set<number>();

  for (let radius = 1; radius <= 8 && anchors.length < 32; radius += 1) {
    const startX = Math.max(0, centerX - radius);
    const endX = Math.min(image.width - 1, centerX + radius);
    const startY = Math.max(0, centerY - radius);
    const endY = Math.min(image.height - 1, centerY + radius);
    for (let y = startY; y <= endY && anchors.length < 32; y += 1) {
      for (let x = startX; x <= endX && anchors.length < 32; x += 1) {
        if (x !== startX && x !== endX && y !== startY && y !== endY) continue;
        const candidateIndex = y * image.width + x;
        const offset = candidateIndex * 4;
        if (
          backgroundMask[candidateIndex] === 1
          || glowMask[candidateIndex] === 1
          || image.data[offset + 3] !== 255
          || distances[candidateIndex] <= minimumDistance
        ) continue;
        const color = packedRgb(image, candidateIndex);
        if (seenColors.has(color)) continue;
        seenColors.add(color);
        anchors.push({
          rgb: [image.data[offset], image.data[offset + 1], image.data[offset + 2]],
          linear: linearRgb(image, candidateIndex),
          spatialDistance: Math.hypot(x - centerX, y - centerY),
        });
      }
    }
  }
  return anchors;
}

function fitForegroundAnchor(
  observed: [number, number, number],
  background: [number, number, number],
  anchors: ForegroundAnchor[],
): { anchor: ForegroundAnchor; alpha: number } | null {
  const observedVector = observed.map((value, index) => value - background[index]) as [number, number, number];
  const observedContrastSquared = observedVector.reduce((sum, value) => sum + value * value, 0);
  let best: { anchor: ForegroundAnchor; alpha: number; score: number } | null = null;

  for (const anchor of anchors) {
    const foregroundVector = anchor.linear.map((value, index) => value - background[index]) as [number, number, number];
    const foregroundContrastSquared = foregroundVector.reduce((sum, value) => sum + value * value, 0);
    if (foregroundContrastSquared < 0.0001 || foregroundContrastSquared <= observedContrastSquared * 1.02) continue;
    const rawAlpha = observedVector.reduce(
      (sum, value, index) => sum + value * foregroundVector[index],
      0,
    ) / foregroundContrastSquared;
    if (rawAlpha <= 0.015 || rawAlpha >= 0.995) continue;
    const alpha = clamp(rawAlpha, 0, 1);
    const residualSquared = observed.reduce((sum, value, index) => {
      const reconstructed = background[index] + foregroundVector[index] * alpha;
      return sum + (value - reconstructed) ** 2;
    }, 0);
    const residual = Math.sqrt(residualSquared);
    const relativeResidual = residual / Math.max(0.02, Math.sqrt(observedContrastSquared));
    if (residual > 0.045 || relativeResidual > 0.24) continue;
    const score = relativeResidual + anchor.spatialDistance * 0.0005;
    if (!best || score < best.score) best = { anchor, alpha, score };
  }
  return best ? { anchor: best.anchor, alpha: best.alpha } : null;
}

export function reconstructEdgeGlow(
  image: RgbaImageView,
  islandIds: Int32Array,
  backgroundColor: RgbColor,
  backgroundMask: Uint8Array,
  distances: Float32Array,
  selectedThreshold: number,
  protectedMask: Uint8Array | null = null,
  glowWidth = defaultEdgeGlowWidth,
): EdgeGlowResult {
  const pixelCount = image.width * image.height;
  if (image.data.length !== pixelCount * 4) throw new Error("RGBA image data size does not match its dimensions.");
  if (islandIds.length !== pixelCount) throw new Error("Local color island map size does not match the image.");
  if (backgroundMask.length !== pixelCount) throw new Error("Background mask size does not match the image.");
  if (distances.length !== pixelCount) throw new Error("Background distance field size does not match the image.");
  if (protectedMask && protectedMask.length !== pixelCount) throw new Error("Protected mask size does not match the image.");
  if (!Number.isFinite(selectedThreshold)) throw new Error("Selected background threshold must be finite.");
  if (!Number.isFinite(glowWidth) || glowWidth < 0) throw new Error("Edge glow width must be finite and greater than or equal to zero.");

  const edgeIslands = new Set<number>();
  let edgeSeedPixelCount = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const margin = distances[pixelIndex] - selectedThreshold;
    if (
      backgroundMask[pixelIndex] === 0
      && protectedMask?.[pixelIndex] !== 1
      && image.data[offset + 3] === 255
      && margin > 0
      && margin <= glowWidth
      && hasBackgroundNeighbor(pixelIndex, image.width, image.height, backgroundMask)
    ) {
      const islandId = islandIds[pixelIndex];
      if (islandId >= 0) edgeIslands.add(islandId);
      edgeSeedPixelCount += 1;
    }
  }

  const glowMask = new Uint8Array(pixelCount);
  let glowPixelCount = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (
      backgroundMask[pixelIndex] === 0
      && protectedMask?.[pixelIndex] !== 1
      && islandIds[pixelIndex] >= 0
      && edgeIslands.has(islandIds[pixelIndex])
    ) {
      glowMask[pixelIndex] = 1;
      glowPixelCount += 1;
    }
  }

  const output = new Uint8ClampedArray(image.data);
  const linearBackground: [number, number, number] = [
    srgbToLinear(backgroundColor[0] / 255),
    srgbToLinear(backgroundColor[1] / 255),
    srgbToLinear(backgroundColor[2] / 255),
  ];
  let reconstructedPixelCount = 0;
  let unresolvedGlowPixelCount = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (protectedMask?.[pixelIndex] === 1) continue;
    const inputAlpha = image.data[offset + 3];
    if (inputAlpha > 0 && inputAlpha < 255) continue;
    if (backgroundMask[pixelIndex] === 1) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
      output[offset + 3] = 0;
      continue;
    }
    if (glowMask[pixelIndex] !== 1 || inputAlpha !== 255) continue;
    const anchors = collectLocalAnchors(image, pixelIndex, backgroundMask, glowMask, distances);
    const fit = fitForegroundAnchor(linearRgb(image, pixelIndex), linearBackground, anchors);
    if (!fit) {
      unresolvedGlowPixelCount += 1;
      continue;
    }
    output[offset] = fit.anchor.rgb[0];
    output[offset + 1] = fit.anchor.rgb[1];
    output[offset + 2] = fit.anchor.rgb[2];
    output[offset + 3] = Math.max(1, Math.min(254, Math.round(fit.alpha * 255)));
    reconstructedPixelCount += 1;
  }

  let semiTransparentPixelCount = 0;
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (output[offset + 3] > 0 && output[offset + 3] < 255) semiTransparentPixelCount += 1;
    if (output[offset + 3] === 0 && protectedMask?.[pixelIndex] !== 1) {
      output[offset] = 0;
      output[offset + 1] = 0;
      output[offset + 2] = 0;
    }
  }

  return {
    image: { width: image.width, height: image.height, data: output },
    glowMask,
    stats: {
      edgeSeedPixelCount,
      edgeIslandCount: edgeIslands.size,
      glowPixelCount,
      reconstructedPixelCount,
      unresolvedGlowPixelCount,
      semiTransparentPixelCount,
    },
  };
}
