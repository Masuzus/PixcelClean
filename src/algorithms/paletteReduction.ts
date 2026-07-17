import {
  clamp,
  colorDistanceSquared,
  getHueFamily,
  rgbToOklab,
  type OklabColor,
} from "./colorSpace";

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

export type PaletteReductionStats = {
  originalColorCount: number;
  reducedColorCount: number;
  replacedColorPixels: number;
};

export function createColorHistogram(image: ImageData): HistogramColor[] {
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

export function reduceImagePalette(image: ImageData, maximumColors: number): PaletteReductionStats {
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
