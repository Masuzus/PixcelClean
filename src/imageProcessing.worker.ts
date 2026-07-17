/// <reference lib="webworker" />

import {
  processImage,
  type EdgeMode,
  type ImageProcessingStats,
  type PaletteReductionSettings,
  type RgbColor,
} from "./imageProcessing";

type ProcessingWorkerRequest = {
  id: number;
  width: number;
  height: number;
  imageData: ArrayBuffer;
  protectedMask: ArrayBuffer | null;
  includeEnclosedAreas: boolean;
  backgroundColor: RgbColor;
  edgeMode: EdgeMode;
  paletteReduction: PaletteReductionSettings;
};

type ProcessingWorkerSuccess = {
  id: number;
  imageData: ArrayBuffer;
  stats: ImageProcessingStats;
};

type ProcessingWorkerFailure = {
  id: number;
  error: string;
};

self.onmessage = (event: MessageEvent<ProcessingWorkerRequest>) => {
  const request = event.data;
  try {
    const source = new ImageData(
      new Uint8ClampedArray(request.imageData),
      request.width,
      request.height,
    );
    const result = processImage(source, {
      includeEnclosedAreas: request.includeEnclosedAreas,
      protectedMask: request.protectedMask ? new Uint8Array(request.protectedMask) : null,
      backgroundColor: request.backgroundColor,
      edgeMode: request.edgeMode,
      paletteReduction: request.paletteReduction,
    });
    const response: ProcessingWorkerSuccess = {
      id: request.id,
      imageData: result.image.data.buffer,
      stats: result.stats,
    };
    self.postMessage(response, { transfer: [response.imageData] });
  } catch (error) {
    const response: ProcessingWorkerFailure = {
      id: request.id,
      error: error instanceof Error ? error.message : "图像处理失败。",
    };
    self.postMessage(response);
  }
};

export {};
