import {
  colorDistanceSquared,
  rgbToOklab,
  type OklabColor,
} from "./colorSpace.ts";
import type { RgbaImageView } from "./types.ts";

export const localColorIslandsAlgorithmVersion = "local-color-islands-v1";
export const defaultLocalColorSimilarityThreshold = 0.02;

export type LocalColorIslandStats = {
  islandCount: number;
  processedPixelCount: number;
  replacedPixelCount: number;
  inputColorCount: number;
  outputColorCount: number;
};

export type LocalColorIslandResult = {
  image: RgbaImageView;
  islandIds: Int32Array;
  stats: LocalColorIslandStats;
};

type IslandColor = {
  packedRgb: number;
  lab: OklabColor;
  count: number;
  firstPixelIndex: number;
};

function weightedMedian(colors: IslandColor[], component: number, pixelCount: number): number {
  const ordered = [...colors].sort((left, right) => (
    left.lab[component] - right.lab[component]
    || left.firstPixelIndex - right.firstPixelIndex
  ));
  const lowerPosition = Math.floor((pixelCount - 1) / 2);
  const upperPosition = Math.floor(pixelCount / 2);
  let lowerValue = ordered[0].lab[component];
  let upperValue = lowerValue;
  let hasLowerValue = false;
  let accumulated = 0;
  for (const color of ordered) {
    accumulated += color.count;
    if (!hasLowerValue && accumulated > lowerPosition) {
      lowerValue = color.lab[component];
      hasLowerValue = true;
    }
    if (accumulated > upperPosition) {
      upperValue = color.lab[component];
      break;
    }
  }
  return (lowerValue + upperValue) / 2;
}

function getPackedRgb(image: RgbaImageView, pixelIndex: number): number {
  const offset = pixelIndex * 4;
  return (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
}

export function mergeLocalColorIslands(
  image: RgbaImageView,
  similarityThreshold: number,
): LocalColorIslandResult {
  const pixelCount = image.width * image.height;
  if (image.data.length !== pixelCount * 4) throw new Error("RGBA image data size does not match its dimensions.");
  if (!Number.isFinite(similarityThreshold) || similarityThreshold < 0) {
    throw new Error("Local color similarity threshold must be finite and greater than or equal to zero.");
  }

  const outputData = new Uint8ClampedArray(image.data);
  const islandIds = new Int32Array(pixelCount);
  islandIds.fill(-1);
  const queue = new Int32Array(pixelCount);
  const labCache = new Map<number, OklabColor>();
  const inputColors = new Set<number>();
  const outputColors = new Set<number>();
  const thresholdSquared = similarityThreshold ** 2;
  let islandCount = 0;
  let processedPixelCount = 0;
  let replacedPixelCount = 0;

  const getLab = (packedRgb: number): OklabColor => {
    let lab = labCache.get(packedRgb);
    if (!lab) {
      lab = rgbToOklab(packedRgb >> 16, packedRgb >> 8 & 0xff, packedRgb & 0xff);
      labCache.set(packedRgb, lab);
    }
    return lab;
  };

  for (let seedIndex = 0; seedIndex < pixelCount; seedIndex += 1) {
    const seedOffset = seedIndex * 4;
    if (image.data[seedOffset + 3] === 0 || islandIds[seedIndex] !== -1) continue;

    const seedPackedRgb = getPackedRgb(image, seedIndex);
    const seedLab = getLab(seedPackedRgb);
    const islandColors = new Map<number, IslandColor>();
    islandColors.set(seedPackedRgb, {
      packedRgb: seedPackedRgb,
      lab: seedLab,
      count: 1,
      firstPixelIndex: seedIndex,
    });
    let queueHead = 0;
    let queueLength = 1;
    let islandPixelCount = 1;
    let meanLightness = seedLab[0];
    let meanA = seedLab[1];
    let meanB = seedLab[2];
    queue[0] = seedIndex;
    islandIds[seedIndex] = islandCount;
    inputColors.add(seedPackedRgb);
    processedPixelCount += 1;

    while (queueHead < queueLength) {
      const currentIndex = queue[queueHead];
      queueHead += 1;
      const currentX = currentIndex % image.width;
      const currentY = Math.floor(currentIndex / image.width);
      const currentLab = getLab(getPackedRgb(image, currentIndex));
      const neighbors = [
        currentY > 0 ? currentIndex - image.width : -1,
        currentX > 0 ? currentIndex - 1 : -1,
        currentX + 1 < image.width ? currentIndex + 1 : -1,
        currentY + 1 < image.height ? currentIndex + image.width : -1,
      ];

      for (const candidateIndex of neighbors) {
        if (candidateIndex < 0 || islandIds[candidateIndex] !== -1) continue;
        const candidateOffset = candidateIndex * 4;
        if (image.data[candidateOffset + 3] === 0) continue;
        const candidatePackedRgb = getPackedRgb(image, candidateIndex);
        const candidateLab = getLab(candidatePackedRgb);
        if (colorDistanceSquared(candidateLab, currentLab) > thresholdSquared) continue;
        if (colorDistanceSquared(candidateLab, [meanLightness, meanA, meanB]) > thresholdSquared) continue;

        const nextCount = islandPixelCount + 1;
        meanLightness += (candidateLab[0] - meanLightness) / nextCount;
        meanA += (candidateLab[1] - meanA) / nextCount;
        meanB += (candidateLab[2] - meanB) / nextCount;
        islandPixelCount = nextCount;
        islandIds[candidateIndex] = islandCount;
        queue[queueLength] = candidateIndex;
        queueLength += 1;
        inputColors.add(candidatePackedRgb);
        processedPixelCount += 1;
        const islandColor = islandColors.get(candidatePackedRgb);
        if (islandColor) islandColor.count += 1;
        else {
          islandColors.set(candidatePackedRgb, {
            packedRgb: candidatePackedRgb,
            lab: candidateLab,
            count: 1,
            firstPixelIndex: candidateIndex,
          });
        }
      }
    }

    const colors = [...islandColors.values()];
    const medianLab: OklabColor = [
      weightedMedian(colors, 0, islandPixelCount),
      weightedMedian(colors, 1, islandPixelCount),
      weightedMedian(colors, 2, islandPixelCount),
    ];
    let representative = colors[0];
    let representativeDistance = colorDistanceSquared(representative.lab, medianLab);
    for (let index = 1; index < colors.length; index += 1) {
      const candidate = colors[index];
      const distance = colorDistanceSquared(candidate.lab, medianLab);
      if (
        distance < representativeDistance
        || (distance === representativeDistance && candidate.firstPixelIndex < representative.firstPixelIndex)
      ) {
        representative = candidate;
        representativeDistance = distance;
      }
    }

    outputColors.add(representative.packedRgb);
    for (let queueIndex = 0; queueIndex < queueLength; queueIndex += 1) {
      const pixelIndex = queue[queueIndex];
      const originalRgb = getPackedRgb(image, pixelIndex);
      if (originalRgb !== representative.packedRgb) replacedPixelCount += 1;
      const offset = pixelIndex * 4;
      outputData[offset] = representative.packedRgb >> 16;
      outputData[offset + 1] = representative.packedRgb >> 8 & 0xff;
      outputData[offset + 2] = representative.packedRgb & 0xff;
    }
    islandCount += 1;
  }

  return {
    image: { width: image.width, height: image.height, data: outputData },
    islandIds,
    stats: {
      islandCount,
      processedPixelCount,
      replacedPixelCount,
      inputColorCount: inputColors.size,
      outputColorCount: outputColors.size,
    },
  };
}
