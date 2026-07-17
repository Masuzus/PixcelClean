import type { RgbColor, RgbaImageView } from "./types";

export function estimateCornerColor(image: RgbaImageView): RgbColor {
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
