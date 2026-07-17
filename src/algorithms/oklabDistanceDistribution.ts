import {
  colorDistanceSquared,
  rgbToOklab,
  type OklabColor,
} from "./colorSpace.ts";
import type { RgbaImageView } from "./types";

export type OklabDistanceDistribution = {
  resolution: number;
  counts: number[];
  pixelCount: number;
  transparentPixelCount: number;
  minimumDistance: number;
  maximumDistance: number;
};

export type OklabDistanceBin = {
  start: number;
  end: number;
  count: number;
};

export function collectOklabDistanceDistribution(
  image: RgbaImageView,
  backgroundLab: OklabColor,
  resolution = 0.0001,
): OklabDistanceDistribution {
  if (!Number.isFinite(resolution) || resolution <= 0) {
    throw new Error("OKLab distance resolution must be greater than zero.");
  }

  const counts: number[] = [];
  const colorDistanceCache = new Map<number, number>();
  const maximumCacheEntries = 65_536;
  let pixelCount = 0;
  let transparentPixelCount = 0;
  let minimumDistance = Number.POSITIVE_INFINITY;
  let maximumDistance = 0;

  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] === 0) {
      transparentPixelCount += 1;
      continue;
    }

    const packedRgb = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
    let distance = colorDistanceCache.get(packedRgb);
    if (distance === undefined) {
      const pixelLab = rgbToOklab(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
      distance = Math.sqrt(colorDistanceSquared(pixelLab, backgroundLab));
      if (colorDistanceCache.size < maximumCacheEntries) colorDistanceCache.set(packedRgb, distance);
    }

    const bucketIndex = Math.floor(distance / resolution);
    counts[bucketIndex] = (counts[bucketIndex] ?? 0) + 1;
    pixelCount += 1;
    minimumDistance = Math.min(minimumDistance, distance);
    maximumDistance = Math.max(maximumDistance, distance);
  }

  const normalizedCounts = Array.from({ length: counts.length }, (_, index) => counts[index] ?? 0);
  return {
    resolution,
    counts: normalizedCounts,
    pixelCount,
    transparentPixelCount,
    minimumDistance: pixelCount === 0 ? 0 : minimumDistance,
    maximumDistance,
  };
}

export function binOklabDistanceDistribution(
  distribution: OklabDistanceDistribution,
  binWidth: number,
): OklabDistanceBin[] {
  if (!Number.isFinite(binWidth) || binWidth < distribution.resolution) {
    throw new Error(`OKLab distance bin width must be at least ${distribution.resolution}.`);
  }

  const binCounts: number[] = [];
  for (let baseIndex = 0; baseIndex < distribution.counts.length; baseIndex += 1) {
    const count = distribution.counts[baseIndex];
    if (count === 0) continue;
    const distance = baseIndex * distribution.resolution;
    const binIndex = Math.floor(distance / binWidth);
    binCounts[binIndex] = (binCounts[binIndex] ?? 0) + count;
  }

  const maximumBinIndex = Math.max(
    0,
    binCounts.length - 1,
    Math.floor(distribution.maximumDistance / binWidth),
  );
  return Array.from({ length: maximumBinIndex + 1 }, (_, index) => ({
    start: index * binWidth,
    end: (index + 1) * binWidth,
    count: binCounts[index] ?? 0,
  }));
}
