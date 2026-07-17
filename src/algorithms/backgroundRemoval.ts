import {
  clamp,
  colorDistanceSquared,
  rgbToOklab,
  srgbToLinear,
  type OklabColor,
} from "./colorSpace";
import {
  getAdaptiveBackgroundThresholds,
  type BackgroundThresholds,
} from "./adaptiveBackgroundThresholds";
import { estimateCornerColor } from "./backgroundColorEstimation";
import type { EdgeMode, RgbColor } from "./types";

export { getAdaptiveBackgroundThresholds } from "./adaptiveBackgroundThresholds";
export type { BackgroundThresholds } from "./adaptiveBackgroundThresholds";
export { estimateCornerColor } from "./backgroundColorEstimation";

export type BackgroundExtractionResult = {
  image: ImageData;
  decontaminatedEdgePixels: number;
  semiTransparentPixels: number;
};

type ForegroundAnchor = {
  rgb: RgbColor;
  linear: OklabColor;
  count: number;
  backgroundDistance: number;
};

function validateMask(mask: Uint8Array | null, expectedLength: number, name: string): void {
  if (mask && mask.length !== expectedLength) throw new Error(`${name}尺寸与图片不一致。`);
}

export function normalizeTransparentPixelColors(data: Uint8ClampedArray): void {
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] !== 0) continue;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
  }
}

function buildBackgroundMask(
  image: ImageData,
  protectedMask: Uint8Array | null,
  includeEnclosedAreas: boolean,
  backgroundLab: OklabColor,
  thresholds: BackgroundThresholds,
): { mask: Uint8Array; distances: Float32Array } {
  const { data, width, height } = image;
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);
  const distances = new Float32Array(pixelCount);
  const queued = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const colorDistanceCache = new Map<number, number>();
  let head = 0;
  let tail = 0;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (data[offset + 3] === 0) {
      distances[pixelIndex] = 0;
      continue;
    }
    const rgb = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    let distance = colorDistanceCache.get(rgb);
    if (distance === undefined) {
      distance = Math.sqrt(colorDistanceSquared(
        rgbToOklab(data[offset], data[offset + 1], data[offset + 2]),
        backgroundLab,
      ));
      colorDistanceCache.set(rgb, distance);
    }
    distances[pixelIndex] = distance;
  }

  const isProtected = (pixelIndex: number) => protectedMask?.[pixelIndex] === 1;
  const enqueue = (pixelIndex: number, isSeed: boolean) => {
    if (queued[pixelIndex] || isProtected(pixelIndex)) return;
    const offset = pixelIndex * 4;
    const isTransparent = data[offset + 3] === 0;
    const limit = isSeed ? thresholds.strict : thresholds.loose;
    if (!isTransparent && distances[pixelIndex] > limit) return;
    queued[pixelIndex] = 1;
    mask[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  };

  if (includeEnclosedAreas) {
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) enqueue(pixelIndex, true);
  } else {
    for (let x = 0; x < width; x += 1) {
      enqueue(x, true);
      enqueue((height - 1) * width + x, true);
    }
    for (let y = 1; y < height - 1; y += 1) {
      enqueue(y * width, true);
      enqueue(y * width + width - 1, true);
    }
  }

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1, false);
    if (x < width - 1) enqueue(pixelIndex + 1, false);
    if (y > 0) enqueue(pixelIndex - width, false);
    if (y < height - 1) enqueue(pixelIndex + width, false);
  }

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    if (data[pixelIndex * 4 + 3] === 0 && !isProtected(pixelIndex)) mask[pixelIndex] = 1;
  }
  return { mask, distances };
}

function buildBoundaryBand(mask: Uint8Array, width: number, height: number, radius: number): Int8Array {
  const distance = new Int8Array(mask.length);
  distance.fill(-1);
  const queue = new Int32Array(mask.length);
  let head = 0;
  let tail = 0;

  for (let pixelIndex = 0; pixelIndex < mask.length; pixelIndex += 1) {
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    const value = mask[pixelIndex];
    if (
      (x > 0 && mask[pixelIndex - 1] !== value)
      || (x < width - 1 && mask[pixelIndex + 1] !== value)
      || (y > 0 && mask[pixelIndex - width] !== value)
      || (y < height - 1 && mask[pixelIndex + width] !== value)
    ) {
      distance[pixelIndex] = 0;
      queue[tail] = pixelIndex;
      tail += 1;
    }
  }

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    const nextDistance = distance[pixelIndex] + 1;
    if (nextDistance >= radius) continue;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      const nextY = y + offsetY;
      if (nextY < 0 || nextY >= height) continue;
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const nextX = x + offsetX;
        if ((offsetX === 0 && offsetY === 0) || nextX < 0 || nextX >= width) continue;
        const nextIndex = nextY * width + nextX;
        if (distance[nextIndex] !== -1) continue;
        distance[nextIndex] = nextDistance;
        queue[tail] = nextIndex;
        tail += 1;
      }
    }
  }
  return distance;
}

function collectForegroundAnchors(
  image: ImageData,
  backgroundMask: Uint8Array,
  backgroundDistances: Float32Array,
  protectedMask: Uint8Array | null,
  looseThreshold: number,
): ForegroundAnchor[] {
  const counts = new Map<number, { count: number; distance: number }>();
  const minimumDistance = Math.max(0.055, looseThreshold * 1.45);
  for (let pixelIndex = 0; pixelIndex < backgroundMask.length; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    if (image.data[offset + 3] === 0 || backgroundMask[pixelIndex]) continue;
    if (protectedMask?.[pixelIndex] !== 1 && backgroundDistances[pixelIndex] < minimumDistance) continue;
    const rgb = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
    const existing = counts.get(rgb);
    counts.set(rgb, {
      count: (existing?.count ?? 0) + image.data[offset + 3] / 255,
      distance: backgroundDistances[pixelIndex],
    });
  }

  return [...counts.entries()]
    .map(([rgb, entry]) => {
      const red = (rgb >>> 16) & 0xff;
      const green = (rgb >>> 8) & 0xff;
      const blue = rgb & 0xff;
      return {
        rgb: [red, green, blue] as RgbColor,
        linear: [srgbToLinear(red / 255), srgbToLinear(green / 255), srgbToLinear(blue / 255)] as OklabColor,
        count: entry.count,
        backgroundDistance: entry.distance,
      };
    })
    .sort((left, right) => (
      right.backgroundDistance * Math.sqrt(right.count) - left.backgroundDistance * Math.sqrt(left.count)
      || right.count - left.count
      || left.rgb[0] - right.rgb[0]
      || left.rgb[1] - right.rgb[1]
      || left.rgb[2] - right.rgb[2]
    ))
    .slice(0, 48);
}

function collectLocalForegroundAnchors(
  image: ImageData,
  pixelIndex: number,
  backgroundMask: Uint8Array,
  backgroundDistances: Float32Array,
  anchorCache: Map<number, ForegroundAnchor>,
): ForegroundAnchor[] {
  const { width, height } = image;
  const centerX = pixelIndex % width;
  const centerY = Math.floor(pixelIndex / width);
  const minimumDistance = backgroundDistances[pixelIndex] * 1.05 + 0.004;
  const anchors: ForegroundAnchor[] = [];
  const seen = new Set<number>();

  for (let radius = 1; radius <= 6 && anchors.length < 32; radius += 1) {
    const startX = Math.max(0, centerX - radius);
    const endX = Math.min(width - 1, centerX + radius);
    const startY = Math.max(0, centerY - radius);
    const endY = Math.min(height - 1, centerY + radius);
    for (let y = startY; y <= endY && anchors.length < 32; y += 1) {
      for (let x = startX; x <= endX && anchors.length < 32; x += 1) {
        if (x !== startX && x !== endX && y !== startY && y !== endY) continue;
        const candidateIndex = y * width + x;
        const offset = candidateIndex * 4;
        if (
          backgroundMask[candidateIndex]
          || image.data[offset + 3] === 0
          || backgroundDistances[candidateIndex] <= minimumDistance
        ) continue;
        const rgb = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
        if (seen.has(rgb)) continue;
        seen.add(rgb);
        let anchor = anchorCache.get(rgb);
        if (!anchor) {
          const red = image.data[offset];
          const green = image.data[offset + 1];
          const blue = image.data[offset + 2];
          anchor = {
            rgb: [red, green, blue],
            linear: [srgbToLinear(red / 255), srgbToLinear(green / 255), srgbToLinear(blue / 255)],
            count: 1,
            backgroundDistance: backgroundDistances[candidateIndex],
          };
          anchorCache.set(rgb, anchor);
        }
        anchors.push(anchor);
      }
    }
  }
  return anchors;
}

function fitForegroundColor(
  observed: OklabColor,
  background: OklabColor,
  anchors: ForegroundAnchor[],
): { anchor: ForegroundAnchor; alpha: number } | null {
  const observedVector: OklabColor = [
    observed[0] - background[0],
    observed[1] - background[1],
    observed[2] - background[2],
  ];
  const observedContrastSquared = colorDistanceSquared(observedVector, [0, 0, 0]);
  let best: { anchor: ForegroundAnchor; alpha: number; score: number } | null = null;

  for (const anchor of anchors) {
    const foregroundVector: OklabColor = [
      anchor.linear[0] - background[0],
      anchor.linear[1] - background[1],
      anchor.linear[2] - background[2],
    ];
    const foregroundContrastSquared = colorDistanceSquared(foregroundVector, [0, 0, 0]);
    if (foregroundContrastSquared < 0.001 || foregroundContrastSquared <= observedContrastSquared * 1.1025) continue;
    const rawAlpha = (
      observedVector[0] * foregroundVector[0]
      + observedVector[1] * foregroundVector[1]
      + observedVector[2] * foregroundVector[2]
    ) / foregroundContrastSquared;
    if (rawAlpha < 0.015 || rawAlpha > 1.04) continue;
    const alpha = clamp(rawAlpha, 0, 1);
    const reconstructed: OklabColor = [
      background[0] + foregroundVector[0] * alpha,
      background[1] + foregroundVector[1] * alpha,
      background[2] + foregroundVector[2] * alpha,
    ];
    const residual = Math.sqrt(colorDistanceSquared(observed, reconstructed));
    const relativeResidual = residual / Math.max(0.02, Math.sqrt(observedContrastSquared));
    if (residual > 0.045 || relativeResidual > 0.24) continue;
    const score = relativeResidual + alpha * 0.015 - Math.sqrt(foregroundContrastSquared) * 0.001;
    if (!best || score < best.score) best = { anchor, alpha, score };
  }
  return best ? { anchor: best.anchor, alpha: best.alpha } : null;
}

export function extractSmartBackground(
  image: ImageData,
  includeEnclosedAreas: boolean,
  protectedMask: Uint8Array | null,
  backgroundColor: RgbColor,
  edgeMode: EdgeMode,
): BackgroundExtractionResult {
  validateMask(protectedMask, image.width * image.height, "保护蒙版");
  const result = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  const backgroundLab = rgbToOklab(...backgroundColor);
  const thresholds = getAdaptiveBackgroundThresholds(image, backgroundLab);
  const { mask, distances } = buildBackgroundMask(
    image,
    protectedMask,
    includeEnclosedAreas,
    backgroundLab,
    thresholds,
  );
  const boundaryBand = buildBoundaryBand(mask, image.width, image.height, 3);
  const anchors = collectForegroundAnchors(image, mask, distances, protectedMask, thresholds.loose);
  const anchorCache = new Map<number, ForegroundAnchor>(anchors.map((anchor) => [
    (anchor.rgb[0] << 16) | (anchor.rgb[1] << 8) | anchor.rgb[2],
    anchor,
  ]));
  const linearBackground: OklabColor = [
    srgbToLinear(backgroundColor[0] / 255),
    srgbToLinear(backgroundColor[1] / 255),
    srgbToLinear(backgroundColor[2] / 255),
  ];
  let decontaminatedEdgePixels = 0;
  let semiTransparentPixels = 0;

  for (let pixelIndex = 0; pixelIndex < mask.length; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const sourceAlpha = image.data[offset + 3];
    if (sourceAlpha === 0) {
      result.data[offset + 3] = 0;
      continue;
    }
    if (protectedMask?.[pixelIndex] === 1) {
      if (edgeMode === "hard") result.data[offset + 3] = 255;
      else if (sourceAlpha < 255) semiTransparentPixels += 1;
      continue;
    }
    if (sourceAlpha < 255) {
      if (edgeMode === "natural") {
        semiTransparentPixels += 1;
      } else {
        result.data[offset + 3] = sourceAlpha >= 128 ? 255 : 0;
      }
      continue;
    }

    const isBoundaryPixel = boundaryBand[pixelIndex] >= 0;
    const observed: OklabColor = [
      srgbToLinear(image.data[offset] / 255),
      srgbToLinear(image.data[offset + 1] / 255),
      srgbToLinear(image.data[offset + 2] / 255),
    ];
    const localAnchors = isBoundaryPixel
      ? collectLocalForegroundAnchors(image, pixelIndex, mask, distances, anchorCache)
      : [];
    const fit = isBoundaryPixel
      ? fitForegroundColor(observed, linearBackground, [...localAnchors, ...anchors])
      : null;
    if (fit) {
      const outputAlpha = edgeMode === "hard"
        ? (fit.alpha >= 0.5 ? 255 : 0)
        : Math.round(fit.alpha * sourceAlpha);
      if (outputAlpha < 4) {
        result.data[offset + 3] = 0;
      } else {
        result.data[offset] = fit.anchor.rgb[0];
        result.data[offset + 1] = fit.anchor.rgb[1];
        result.data[offset + 2] = fit.anchor.rgb[2];
        result.data[offset + 3] = outputAlpha;
        if (outputAlpha < 255) semiTransparentPixels += 1;
      }
      decontaminatedEdgePixels += 1;
      continue;
    }

    if (mask[pixelIndex]) {
      result.data[offset + 3] = 0;
    } else if (edgeMode === "hard") {
      result.data[offset + 3] = 255;
    } else if (sourceAlpha < 255) {
      semiTransparentPixels += 1;
    }
  }

  normalizeTransparentPixelColors(result.data);
  return { image: result, decontaminatedEdgePixels, semiTransparentPixels };
}

export function removeConnectedBackground(
  image: ImageData,
  includeEnclosedAreas: boolean,
  protectedMask: Uint8Array | null,
  backgroundColor: RgbColor = estimateCornerColor(image),
): ImageData {
  return extractSmartBackground(
    image,
    includeEnclosedAreas,
    protectedMask,
    backgroundColor,
    "hard",
  ).image;
}
