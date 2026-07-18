/// <reference lib="webworker" />

import { classifyBackgroundDistances } from "./algorithms/classifyBackgroundDistances";
import { analyzeBackground, collectBackgroundMaskStats } from "./pipeline/backgroundAnalysis";
import type {
  AnalyzeBackgroundSuccess,
  BackgroundWorkerFailure,
  BackgroundWorkerRequest,
  ClassifyBackgroundSuccess,
} from "./pipeline/backgroundAnalysisProtocol";
import type { RgbaImageView } from "./algorithms/types";
import { reconstructEdgeGlow } from "./algorithms/edgeGlowReconstruction";
import type { RgbColor } from "./algorithms/types";

type ActiveAnalysis = {
  analysisId: number;
  image: RgbaImageView;
  islandIds: Int32Array;
  backgroundColor: RgbColor;
  distances: Float32Array;
};

let activeAnalysis: ActiveAnalysis | null = null;

function postFailure(request: BackgroundWorkerRequest, error: unknown): void {
  const response: BackgroundWorkerFailure = {
    type: "error",
    requestId: request.requestId,
    analysisId: request.analysisId,
    message: error instanceof Error ? error.message : "背景分析失败。",
  };
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<BackgroundWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === "analyze") {
      const image = new ImageData(
        new Uint8ClampedArray(request.imageData),
        request.width,
        request.height,
      );
      const protectedMask = request.protectedMask ? new Uint8Array(request.protectedMask) : null;
      const result = analyzeBackground(image, {
        backgroundColor: request.backgroundColor ?? undefined,
        edgeGlowWidth: request.edgeGlowWidth,
        localColorThreshold: request.localColorThreshold,
        selectedThreshold: request.selectedThreshold ?? undefined,
        protectedMask,
      });
      activeAnalysis = {
        analysisId: request.analysisId,
        image: result.mergedImage,
        islandIds: result.islandIds,
        backgroundColor: result.backgroundColor,
        distances: result.distances,
      };
      const backgroundMask = result.backgroundMask.buffer as ArrayBuffer;
      const distances = result.distances.slice().buffer as ArrayBuffer;
      const mergedImage = new Uint8ClampedArray(result.mergedImage.data).buffer as ArrayBuffer;
      const edgeImage = new Uint8ClampedArray(result.edgeImage.data).buffer as ArrayBuffer;
      const glowMask = result.glowMask.buffer as ArrayBuffer;
      const response: AnalyzeBackgroundSuccess = {
        type: "analyzed",
        requestId: request.requestId,
        analysisId: request.analysisId,
        width: request.width,
        height: request.height,
        estimatedBackgroundColor: result.estimatedBackgroundColor,
        backgroundColor: result.backgroundColor,
        thresholds: result.thresholds,
        selectedThreshold: result.selectedThreshold,
        mergedImage,
        localColorStats: result.localColorStats,
        edgeImage,
        glowMask,
        edgeGlowStats: result.edgeGlowStats,
        backgroundMask,
        distances,
        stats: result.stats,
      };
      self.postMessage(response, { transfer: [backgroundMask, distances, mergedImage, edgeImage, glowMask] });
      return;
    }

    if (!activeAnalysis || activeAnalysis.analysisId !== request.analysisId) {
      throw new Error("背景分析缓存已失效，请重新分析图片。");
    }
    const protectedMask = request.protectedMask ? new Uint8Array(request.protectedMask) : null;
    const backgroundMask = classifyBackgroundDistances(
      activeAnalysis.image,
      activeAnalysis.distances,
      request.selectedThreshold,
      protectedMask,
    );
    const stats = collectBackgroundMaskStats(activeAnalysis.image, backgroundMask, protectedMask);
    const edgeGlow = reconstructEdgeGlow(
      activeAnalysis.image,
      activeAnalysis.islandIds,
      activeAnalysis.backgroundColor,
      backgroundMask,
      activeAnalysis.distances,
      request.selectedThreshold,
      protectedMask,
      request.edgeGlowWidth,
    );
    const backgroundMaskBuffer = backgroundMask.buffer as ArrayBuffer;
    const edgeImage = new Uint8ClampedArray(edgeGlow.image.data).buffer as ArrayBuffer;
    const glowMask = edgeGlow.glowMask.buffer as ArrayBuffer;
    const response: ClassifyBackgroundSuccess = {
      type: "classified",
      requestId: request.requestId,
      analysisId: request.analysisId,
      width: activeAnalysis.image.width,
      height: activeAnalysis.image.height,
      selectedThreshold: request.selectedThreshold,
      edgeImage,
      glowMask,
      edgeGlowStats: edgeGlow.stats,
      backgroundMask: backgroundMaskBuffer,
      stats,
    };
    self.postMessage(response, { transfer: [backgroundMaskBuffer, edgeImage, glowMask] });
  } catch (error) {
    postFailure(request, error);
  }
};

export {};
