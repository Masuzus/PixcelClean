import { extractSmartBackground, normalizeTransparentPixelColors } from "./backgroundRemoval";
import { createColorHistogram, reduceImagePalette } from "./paletteReduction";
import type { ImageProcessingOptions, ImageProcessingResult } from "./types";

function validateMask(mask: Uint8Array | null, expectedLength: number, name: string): void {
  if (mask && mask.length !== expectedLength) throw new Error(`${name}尺寸与图片不一致。`);
}

export function processImage(
  image: ImageData,
  options: ImageProcessingOptions,
): ImageProcessingResult {
  const pixelCount = image.width * image.height;
  validateMask(options.protectedMask, pixelCount, "保护蒙版");
  const extraction = extractSmartBackground(
    image,
    options.includeEnclosedAreas,
    options.protectedMask,
    options.backgroundColor,
    options.edgeMode ?? "natural",
  );
  const result = extraction.image;
  let removedBackgroundPixels = 0;
  for (let offset = 0; offset < result.data.length; offset += 4) {
    if (image.data[offset + 3] !== 0 && result.data[offset + 3] === 0) removedBackgroundPixels += 1;
  }
  normalizeTransparentPixelColors(result.data);
  const paletteStats = options.paletteReduction.enabled
    ? reduceImagePalette(result, options.paletteReduction.maximumColors)
    : (() => {
      const colorCount = createColorHistogram(result).length;
      return { originalColorCount: colorCount, reducedColorCount: colorCount, replacedColorPixels: 0 };
    })();
  return {
    image: result,
    stats: {
      removedBackgroundPixels,
      decontaminatedEdgePixels: extraction.decontaminatedEdgePixels,
      semiTransparentPixels: extraction.semiTransparentPixels,
      ...paletteStats,
    },
  };
}
