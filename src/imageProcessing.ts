export type ColorEntry = {
  hex: string;
  cssColor: string;
  alpha: number;
  lightness: number;
  hue: number;
  count: number;
};

export type PixelPosition = {
  x: number;
  y: number;
};

export type RgbColor = [number, number, number];

export type PaletteReductionSettings = {
  enabled: boolean;
  maximumColors: number;
};

export type EdgeMode = "natural" | "hard";

export type ImageProcessingOptions = {
  tolerance: number;
  includeEnclosedAreas: boolean;
  protectedMask: Uint8Array | null;
  backgroundColor: RgbColor;
  edgeMode?: EdgeMode;
  paletteReduction: PaletteReductionSettings;
};

export type ImageProcessingStats = {
  removedBackgroundPixels: number;
  originalColorCount: number;
  reducedColorCount: number;
  replacedColorPixels: number;
  decontaminatedEdgePixels: number;
  semiTransparentPixels: number;
};

export type ImageProcessingResult = {
  image: ImageData;
  stats: ImageProcessingStats;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function validateMask(mask: Uint8Array | null, expectedLength: number, name: string): void {
  if (mask && mask.length !== expectedLength) throw new Error(`${name}尺寸与图片不一致。`);
}

type OklabColor = [number, number, number];

type HistogramColor = {
  rgb: number;
  count: number;
  lab: OklabColor;
  family: number;
};

type PaletteCentroid = {
  lab: OklabColor;
  family: number;
};

function rgbToOklab(red: number, green: number, blue: number): OklabColor {
  const linearRed = srgbToLinear(red / 255);
  const linearGreen = srgbToLinear(green / 255);
  const linearBlue = srgbToLinear(blue / 255);
  const light = Math.cbrt(0.4122214708 * linearRed + 0.5363325363 * linearGreen + 0.0514459929 * linearBlue);
  const medium = Math.cbrt(0.2119034982 * linearRed + 0.6806995451 * linearGreen + 0.1073969566 * linearBlue);
  const short = Math.cbrt(0.0883024619 * linearRed + 0.2817188376 * linearGreen + 0.6299787005 * linearBlue);
  return [
    0.2104542553 * light + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * light - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * light + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

function colorDistanceSquared(left: OklabColor, right: OklabColor): number {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2 + (left[2] - right[2]) ** 2;
}

function getHueDegrees(color: OklabColor): number {
  const degrees = Math.atan2(color[2], color[1]) * 180 / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

function getHueFamily(color: OklabColor): number {
  const chroma = Math.hypot(color[1], color[2]);
  if (chroma < 0.02) return 0;
  const hue = getHueDegrees(color);
  if (hue >= 345 || hue < 45) return 1;
  if (hue < 120) return 2;
  if (hue < 180) return 3;
  if (hue < 230) return 4;
  if (hue < 290) return 5;
  return 6;
}

function createColorHistogram(image: ImageData): HistogramColor[] {
  const counts = new Map<number, number>();
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] === 0) continue;
    const rgb = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([rgb, count]) => {
      const lab = rgbToOklab((rgb >>> 16) & 0xff, (rgb >>> 8) & 0xff, rgb & 0xff);
      return { rgb, count, lab, family: getHueFamily(lab) };
    })
    .sort((left, right) => right.count - left.count || left.rgb - right.rgb);
}

function reduceImagePalette(image: ImageData, maximumColors: number): {
  originalColorCount: number;
  reducedColorCount: number;
  replacedColorPixels: number;
} {
  const colors = createColorHistogram(image);
  const targetCount = Math.min(colors.length, Math.round(clamp(maximumColors, 8, 20)));
  if (colors.length <= targetCount) {
    return { originalColorCount: colors.length, reducedColorCount: colors.length, replacedColorPixels: 0 };
  }

  const familySeeds = new Map<number, HistogramColor>();
  for (const color of colors) {
    if (!familySeeds.has(color.family)) familySeeds.set(color.family, color);
  }
  const centroids: PaletteCentroid[] = [...familySeeds.values()]
    .map((color) => ({ lab: color.lab, family: color.family }));
  while (centroids.length < targetCount) {
    let candidate = colors[0];
    let candidateScore = -1;
    for (const color of colors) {
      const familyCentroids = centroids.filter((centroid) => centroid.family === color.family);
      const nearestDistance = Math.min(...familyCentroids.map((centroid) => colorDistanceSquared(color.lab, centroid.lab)));
      const score = nearestDistance * Math.sqrt(color.count);
      if (score > candidateScore) {
        candidate = color;
        candidateScore = score;
      }
    }
    centroids.push({ lab: candidate.lab, family: candidate.family });
  }

  const assignments = new Int32Array(colors.length);
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const sums = centroids.map(() => [0, 0, 0, 0]);
    for (let colorIndex = 0; colorIndex < colors.length; colorIndex += 1) {
      const color = colors[colorIndex];
      let nearestIndex = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex += 1) {
        const centroid = centroids[centroidIndex];
        if (centroid.family !== color.family) continue;
        const distance = colorDistanceSquared(color.lab, centroid.lab);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = centroidIndex;
        }
      }
      assignments[colorIndex] = nearestIndex;
      sums[nearestIndex][0] += color.lab[0] * color.count;
      sums[nearestIndex][1] += color.lab[1] * color.count;
      sums[nearestIndex][2] += color.lab[2] * color.count;
      sums[nearestIndex][3] += color.count;
    }
    for (let centroidIndex = 0; centroidIndex < centroids.length; centroidIndex += 1) {
      const weight = sums[centroidIndex][3];
      if (weight === 0) continue;
      centroids[centroidIndex] = {
        ...centroids[centroidIndex],
        lab: [
          sums[centroidIndex][0] / weight,
          sums[centroidIndex][1] / weight,
          sums[centroidIndex][2] / weight,
        ],
      };
    }
  }

  const representatives = centroids.map((centroid, centroidIndex) => {
    let representative = colors.find((color) => color.family === centroid.family) ?? colors[0];
    let representativeDistance = Number.POSITIVE_INFINITY;
    for (let colorIndex = 0; colorIndex < colors.length; colorIndex += 1) {
      if (assignments[colorIndex] !== centroidIndex) continue;
      const color = colors[colorIndex];
      const distance = colorDistanceSquared(color.lab, centroid.lab);
      if (distance < representativeDistance || (distance === representativeDistance && color.count > representative.count)) {
        representative = color;
        representativeDistance = distance;
      }
    }
    return representative;
  });
  const uniqueRepresentatives = [...new Map(representatives.map((color) => [color.rgb, color])).values()];
  const replacements = new Map<number, number>();
  for (const color of colors) {
    let replacement = uniqueRepresentatives[0];
    let replacementDistance = Number.POSITIVE_INFINITY;
    for (const representative of uniqueRepresentatives) {
      if (representative.family !== color.family) continue;
      const distance = colorDistanceSquared(color.lab, representative.lab);
      if (distance < replacementDistance) {
        replacement = representative;
        replacementDistance = distance;
      }
    }
    replacements.set(color.rgb, replacement.rgb);
  }

  let replacedColorPixels = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    if (image.data[offset + 3] === 0) continue;
    const rgb = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
    const replacement = replacements.get(rgb) ?? rgb;
    if (replacement === rgb) continue;
    image.data[offset] = (replacement >>> 16) & 0xff;
    image.data[offset + 1] = (replacement >>> 8) & 0xff;
    image.data[offset + 2] = replacement & 0xff;
    replacedColorPixels += 1;
  }

  return {
    originalColorCount: colors.length,
    reducedColorCount: uniqueRepresentatives.length,
    replacedColorPixels,
  };
}

function normalizeTransparentPixelColors(data: Uint8ClampedArray): void {
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] !== 0) continue;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
  }
}

type BackgroundThresholds = {
  strict: number;
  loose: number;
};

type BackgroundExtractionResult = {
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

function getAdaptiveBackgroundThresholds(
  image: ImageData,
  backgroundLab: OklabColor,
  tolerance: number,
): BackgroundThresholds {
  const baseTolerance = clamp(tolerance, 0, 120) / 255 * 0.55;
  const sampleSize = Math.min(8, image.width, image.height);
  const origins: Array<[number, number]> = [
    [0, 0],
    [Math.max(0, image.width - sampleSize), 0],
    [0, Math.max(0, image.height - sampleSize)],
    [Math.max(0, image.width - sampleSize), Math.max(0, image.height - sampleSize)],
  ];
  const preliminaryLimit = Math.max(0.035, baseTolerance * 2.5);
  const distances: number[] = [];
  const colorDistanceCache = new Map<number, number>();

  for (const [startX, startY] of origins) {
    for (let offsetY = 0; offsetY < sampleSize; offsetY += 1) {
      for (let offsetX = 0; offsetX < sampleSize; offsetX += 1) {
        const offset = ((startY + offsetY) * image.width + startX + offsetX) * 4;
        if (image.data[offset + 3] === 0) continue;
        const rgb = (image.data[offset] << 16) | (image.data[offset + 1] << 8) | image.data[offset + 2];
        let distance = colorDistanceCache.get(rgb);
        if (distance === undefined) {
          const lab = rgbToOklab(image.data[offset], image.data[offset + 1], image.data[offset + 2]);
          distance = Math.sqrt(colorDistanceSquared(lab, backgroundLab));
          colorDistanceCache.set(rgb, distance);
        }
        if (distance <= preliminaryLimit) distances.push(distance);
      }
    }
  }

  distances.sort((left, right) => left - right);
  const sampledSpread = distances.length === 0
    ? 0
    : distances[Math.min(distances.length - 1, Math.floor(distances.length * 0.9))];
  const strict = clamp(Math.max(0.006, baseTolerance, sampledSpread * 1.25), 0.006, 0.28);
  return {
    strict,
    loose: clamp(Math.max(strict + 0.008, strict * 1.65), 0.012, 0.38),
  };
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

function extractSmartBackground(
  image: ImageData,
  tolerance: number,
  includeEnclosedAreas: boolean,
  protectedMask: Uint8Array | null,
  backgroundColor: RgbColor,
  edgeMode: EdgeMode,
): BackgroundExtractionResult {
  validateMask(protectedMask, image.width * image.height, "保护蒙版");
  const result = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  const backgroundLab = rgbToOklab(...backgroundColor);
  const thresholds = getAdaptiveBackgroundThresholds(image, backgroundLab, tolerance);
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

export function paintProtectionMask(
  mask: Uint8Array,
  width: number,
  height: number,
  from: PixelPosition,
  to: PixelPosition,
  brushSize: number,
  shouldProtect: boolean,
): Uint8Array {
  const nextMask = new Uint8Array(mask);
  const radius = Math.max(0.5, brushSize / 2);
  const radiusSquared = radius * radius;
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y)));

  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    const centerX = Math.round(from.x + (to.x - from.x) * progress);
    const centerY = Math.round(from.y + (to.y - from.y) * progress);
    const startX = Math.max(0, Math.floor(centerX - radius));
    const endX = Math.min(width - 1, Math.ceil(centerX + radius));
    const startY = Math.max(0, Math.floor(centerY - radius));
    const endY = Math.min(height - 1, Math.ceil(centerY + radius));

    for (let y = startY; y <= endY; y += 1) {
      for (let x = startX; x <= endX; x += 1) {
        const distanceX = x - centerX;
        const distanceY = y - centerY;
        if (distanceX * distanceX + distanceY * distanceY <= radiusSquared) {
          nextMask[y * width + x] = shouldProtect ? 1 : 0;
        }
      }
    }
  }

  return nextMask;
}

export function estimateCornerColor(image: ImageData): [number, number, number] {
  const { data, width, height } = image;
  const sampleSize = Math.min(4, width, height);
  const origins: Array<[number, number]> = [
    [0, 0],
    [Math.max(0, width - sampleSize), 0],
    [0, Math.max(0, height - sampleSize)],
    [Math.max(0, width - sampleSize), Math.max(0, height - sampleSize)],
  ];
  const redSamples: number[] = [];
  const greenSamples: number[] = [];
  const blueSamples: number[] = [];

  for (const [startX, startY] of origins) {
    for (let offsetY = 0; offsetY < sampleSize; offsetY += 1) {
      for (let offsetX = 0; offsetX < sampleSize; offsetX += 1) {
        const pixel = ((startY + offsetY) * width + startX + offsetX) * 4;
        if (data[pixel + 3] === 0) continue;
        redSamples.push(data[pixel]);
        greenSamples.push(data[pixel + 1]);
        blueSamples.push(data[pixel + 2]);
      }
    }
  }

  if (redSamples.length === 0) return [0, 0, 0];
  const median = (samples: number[]) => {
    samples.sort((left, right) => left - right);
    const middle = Math.floor(samples.length / 2);
    return samples.length % 2 === 0
      ? Math.round((samples[middle - 1] + samples[middle]) / 2)
      : samples[middle];
  };
  return [median(redSamples), median(greenSamples), median(blueSamples)];
}

export function removeConnectedBackground(
  image: ImageData,
  tolerance: number,
  includeEnclosedAreas: boolean,
  protectedMask: Uint8Array | null,
  backgroundColor: RgbColor = estimateCornerColor(image),
): ImageData {
  return extractSmartBackground(
    image,
    tolerance,
    includeEnclosedAreas,
    protectedMask,
    backgroundColor,
    "hard",
  ).image;
}

export function processImage(
  image: ImageData,
  options: ImageProcessingOptions,
): ImageProcessingResult {
  const pixelCount = image.width * image.height;
  validateMask(options.protectedMask, pixelCount, "保护蒙版");
  const extraction = extractSmartBackground(
    image,
    options.tolerance,
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

export function getImageColors(image: ImageData): ColorEntry[] {
  const counts = new Map<number, number>();
  const { data } = image;

  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    const rgb = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    counts.set(rgb, (counts.get(rgb) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([rgb, count]) => {
      const red = (rgb >>> 16) & 0xff;
      const green = (rgb >>> 8) & 0xff;
      const blue = rgb & 0xff;
      const lab = rgbToOklab(red, green, blue);
      const rgbHex = `#${[red, green, blue]
        .map((channel) => channel.toString(16).padStart(2, "0"))
        .join("")}`.toUpperCase();
      return {
        hex: rgbHex,
        cssColor: rgbHex,
        alpha: 255,
        lightness: lab[0],
        hue: getHueDegrees(lab),
        count,
      };
    })
    .sort((left, right) => right.count - left.count || left.hex.localeCompare(right.hex));
}

export function colorToHex(color: [number, number, number]): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
