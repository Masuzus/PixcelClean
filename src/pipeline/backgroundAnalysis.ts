import { getAdaptiveBackgroundThresholds, type BackgroundThresholds } from "../algorithms/adaptiveBackgroundThresholds.ts";
import { estimateCornerColor } from "../algorithms/backgroundColorEstimation.ts";
import { generateBackgroundMask } from "../algorithms/backgroundMaskGeneration.ts";
import { rgbToOklab } from "../algorithms/colorSpace.ts";
import {
  reconstructEdgeGlow,
  type EdgeGlowStats,
} from "../algorithms/edgeGlowReconstruction.ts";
import {
  defaultLocalColorSimilarityThreshold,
  mergeLocalColorIslands,
  type LocalColorIslandStats,
} from "../algorithms/localColorIslands.ts";
import type { RgbColor, RgbaImageView } from "../algorithms/types.ts";

export type BackgroundMaskStats = {
  opaquePixelCount: number;
  transparentPixelCount: number;
  backgroundPixelCount: number;
  foregroundPixelCount: number;
  protectedPixelCount: number;
};

export type BackgroundAnalysisResult = {
  mergedImage: RgbaImageView;
  islandIds: Int32Array;
  localColorStats: LocalColorIslandStats;
  edgeImage: RgbaImageView;
  glowMask: Uint8Array;
  edgeGlowStats: EdgeGlowStats;
  estimatedBackgroundColor: RgbColor;
  backgroundColor: RgbColor;
  thresholds: BackgroundThresholds;
  selectedThreshold: number;
  backgroundMask: Uint8Array;
  distances: Float32Array;
  stats: BackgroundMaskStats;
};

export type BackgroundAnalysisOptions = {
  backgroundColor?: RgbColor;
  edgeGlowWidth?: number;
  localColorThreshold?: number;
  selectedThreshold?: number;
  protectedMask?: Uint8Array | null;
};

export function collectBackgroundMaskStats(
  image: RgbaImageView,
  backgroundMask: Uint8Array,
  protectedMask: Uint8Array | null,
): BackgroundMaskStats {
  let opaquePixelCount = 0;
  let transparentPixelCount = 0;
  let backgroundPixelCount = 0;
  let protectedPixelCount = 0;
  for (let pixelIndex = 0; pixelIndex < backgroundMask.length; pixelIndex += 1) {
    if (image.data[pixelIndex * 4 + 3] === 0) transparentPixelCount += 1;
    else opaquePixelCount += 1;
    if (backgroundMask[pixelIndex] === 1) backgroundPixelCount += 1;
    if (protectedMask?.[pixelIndex] === 1) protectedPixelCount += 1;
  }
  return {
    opaquePixelCount,
    transparentPixelCount,
    backgroundPixelCount,
    foregroundPixelCount: opaquePixelCount - backgroundPixelCount,
    protectedPixelCount,
  };
}

export function analyzeBackground(
  image: ImageData,
  options: BackgroundAnalysisOptions = {},
): BackgroundAnalysisResult {
  const localColorResult = mergeLocalColorIslands(
    image,
    options.localColorThreshold ?? defaultLocalColorSimilarityThreshold,
  );
  const mergedImage = localColorResult.image;
  const estimatedBackgroundColor = estimateCornerColor(mergedImage);
  const backgroundColor = options.backgroundColor ?? estimatedBackgroundColor;
  const thresholds = getAdaptiveBackgroundThresholds(mergedImage as ImageData, rgbToOklab(...backgroundColor));
  const selectedThreshold = options.selectedThreshold ?? (thresholds.strict + thresholds.loose) / 2;
  if (!Number.isFinite(selectedThreshold)) throw new Error("Selected background threshold must be finite.");
  const protectedMask = options.protectedMask ?? null;
  const { backgroundMask, distances } = generateBackgroundMask(
    mergedImage,
    backgroundColor,
    selectedThreshold,
    protectedMask,
  );
  const edgeGlow = reconstructEdgeGlow(
    mergedImage,
    localColorResult.islandIds,
    backgroundColor,
    backgroundMask,
    distances,
    selectedThreshold,
    protectedMask,
    options.edgeGlowWidth,
  );
  return {
    mergedImage,
    islandIds: localColorResult.islandIds,
    localColorStats: localColorResult.stats,
    edgeImage: edgeGlow.image,
    glowMask: edgeGlow.glowMask,
    edgeGlowStats: edgeGlow.stats,
    estimatedBackgroundColor,
    backgroundColor,
    thresholds,
    selectedThreshold,
    backgroundMask,
    distances,
    stats: collectBackgroundMaskStats(mergedImage, backgroundMask, protectedMask),
  };
}
