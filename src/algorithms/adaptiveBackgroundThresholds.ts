import {
  clamp,
  type OklabColor,
} from "./colorSpace.ts";
import {
  binOklabDistanceDistribution,
  collectOklabDistanceDistribution,
} from "./oklabDistanceDistribution.ts";

export type BackgroundThresholds = {
  strict: number;
  loose: number;
};

const distributionResolution = 0.0001;
const analysisBinWidth = 0.001;
const minimumStrict = 0.006;
const minimumLoose = 0.014;
const looseTailDensityRatio = 0.0075;
const looseRecoveryDensityRatio = 0.015;
const looseStableWidth = 0.004;
const looseSearchMaximum = 0.16;

function smoothCounts(counts: number[], radius = 2): number[] {
  return counts.map((_, index) => {
    let weightedCount = 0;
    let totalWeight = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const sample = counts[index + offset];
      if (sample === undefined) continue;
      const weight = radius + 1 - Math.abs(offset);
      weightedCount += sample * weight;
      totalWeight += weight;
    }
    return totalWeight === 0 ? 0 : weightedCount / totalWeight;
  });
}

function findAutomaticThresholds(image: ImageData, backgroundLab: OklabColor): BackgroundThresholds {
  const distribution = collectOklabDistanceDistribution(image, backgroundLab, distributionResolution);
  if (distribution.pixelCount === 0 || distribution.maximumDistance < minimumStrict) {
    return { strict: minimumStrict, loose: minimumLoose };
  }

  const bins = binOklabDistanceDistribution(distribution, analysisBinWidth);
  const smoothed = smoothCounts(bins.map((bin) => bin.count));
  const peakSearchEnd = Math.min(smoothed.length - 1, Math.floor(0.05 / analysisBinWidth));
  let peakIndex = 0;
  for (let index = 1; index <= peakSearchEnd; index += 1) {
    if (smoothed[index] > smoothed[peakIndex]) peakIndex = index;
  }

  const peakCount = smoothed[peakIndex];
  if (peakCount <= 0) return { strict: minimumStrict, loose: minimumLoose };

  let kneeStart = peakIndex + 1;
  while (kneeStart < smoothed.length - 1 && smoothed[kneeStart] > peakCount * 0.5) kneeStart += 1;
  const kneeSearchLimit = Math.min(smoothed.length - 2, Math.floor(0.08 / analysisBinWidth));
  let kneeEnd = kneeStart;
  while (kneeEnd < kneeSearchLimit && smoothed[kneeEnd] > peakCount * 0.025) kneeEnd += 1;
  kneeEnd = Math.max(kneeStart, kneeEnd);

  let kneeIndex = Math.min(kneeStart, smoothed.length - 1);
  let maximumCurvature = Number.NEGATIVE_INFINITY;
  for (let index = Math.max(1, kneeStart); index <= Math.min(kneeEnd, smoothed.length - 2); index += 1) {
    const curvature = smoothed[index - 1] - 2 * smoothed[index] + smoothed[index + 1];
    if (curvature > maximumCurvature) {
      maximumCurvature = curvature;
      kneeIndex = index;
    }
  }

  const automaticStrict = clamp(
    Math.max(minimumStrict, bins[kneeIndex]?.start ?? minimumStrict),
    minimumStrict,
    0.28,
  );
  const tailDensityLimit = peakCount * looseTailDensityRatio;
  const recoveryDensityLimit = peakCount * looseRecoveryDensityRatio;
  const stableWindowSize = Math.max(3, Math.round(looseStableWidth / analysisBinWidth));
  const tailSearchEnd = Math.min(smoothed.length - 1, Math.floor(looseSearchMaximum / analysisBinWidth));
  let tailEndIndex = -1;

  for (let index = Math.max(kneeIndex + 1, 1); index <= tailSearchEnd; index += 1) {
    if (smoothed[index] > tailDensityLimit) continue;
    let isStable = true;
    for (let offset = 0; offset < stableWindowSize && index + offset < smoothed.length; offset += 1) {
      if (smoothed[index + offset] > recoveryDensityLimit) {
        isStable = false;
        break;
      }
    }
    if (isStable) {
      tailEndIndex = index;
      break;
    }
  }

  const distributionEndsInBackgroundRange = distribution.maximumDistance <= looseSearchMaximum;
  const detectedLoose = tailEndIndex >= 0
    ? bins[tailEndIndex]?.start ?? automaticStrict + 0.008
    : distributionEndsInBackgroundRange
      ? bins[bins.length - 1]?.end ?? automaticStrict + 0.008
      : automaticStrict + 0.008;
  return {
    strict: automaticStrict,
    loose: clamp(Math.max(minimumLoose, automaticStrict + 0.004, detectedLoose), minimumLoose, 0.38),
  };
}

export function getAdaptiveBackgroundThresholds(
  image: ImageData,
  backgroundLab: OklabColor,
): BackgroundThresholds {
  return findAutomaticThresholds(image, backgroundLab);
}
