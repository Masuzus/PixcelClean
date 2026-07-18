import type { BackgroundMaskStats } from "./backgroundAnalysis.ts";
import type { BackgroundThresholds } from "../algorithms/adaptiveBackgroundThresholds.ts";
import type { RgbColor } from "../algorithms/types.ts";
import type { LocalColorIslandStats } from "../algorithms/localColorIslands.ts";
import type { EdgeGlowStats } from "../algorithms/edgeGlowReconstruction.ts";

export type AnalyzeBackgroundRequest = {
  type: "analyze";
  requestId: number;
  analysisId: number;
  width: number;
  height: number;
  imageData: ArrayBuffer;
  edgeGlowWidth: number;
  localColorThreshold: number;
  selectedThreshold: number | null;
  backgroundColor: RgbColor | null;
  protectedMask: ArrayBuffer | null;
};

export type ClassifyBackgroundRequest = {
  type: "classify";
  requestId: number;
  analysisId: number;
  selectedThreshold: number;
  edgeGlowWidth: number;
  protectedMask: ArrayBuffer | null;
};

export type BackgroundWorkerRequest = AnalyzeBackgroundRequest | ClassifyBackgroundRequest;

export type AnalyzeBackgroundSuccess = {
  type: "analyzed";
  requestId: number;
  analysisId: number;
  width: number;
  height: number;
  estimatedBackgroundColor: RgbColor;
  backgroundColor: RgbColor;
  thresholds: BackgroundThresholds;
  selectedThreshold: number;
  mergedImage: ArrayBuffer;
  localColorStats: LocalColorIslandStats;
  edgeImage: ArrayBuffer;
  glowMask: ArrayBuffer;
  edgeGlowStats: EdgeGlowStats;
  backgroundMask: ArrayBuffer;
  distances: ArrayBuffer;
  stats: BackgroundMaskStats;
};

export type ClassifyBackgroundSuccess = {
  type: "classified";
  requestId: number;
  analysisId: number;
  width: number;
  height: number;
  selectedThreshold: number;
  edgeImage: ArrayBuffer;
  glowMask: ArrayBuffer;
  edgeGlowStats: EdgeGlowStats;
  backgroundMask: ArrayBuffer;
  stats: BackgroundMaskStats;
};

export type BackgroundWorkerFailure = {
  type: "error";
  requestId: number;
  analysisId: number;
  message: string;
};

export type BackgroundWorkerResponse =
  | AnalyzeBackgroundSuccess
  | ClassifyBackgroundSuccess
  | BackgroundWorkerFailure;
