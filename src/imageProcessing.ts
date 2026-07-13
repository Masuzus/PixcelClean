export type ColorEntry = {
  hex: string;
  count: number;
};

export type PixelPosition = {
  x: number;
  y: number;
};

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
  let red = 0;
  let green = 0;
  let blue = 0;
  let samples = 0;

  for (const [startX, startY] of origins) {
    for (let offsetY = 0; offsetY < sampleSize; offsetY += 1) {
      for (let offsetX = 0; offsetX < sampleSize; offsetX += 1) {
        const pixel = ((startY + offsetY) * width + startX + offsetX) * 4;
        if (data[pixel + 3] === 0) continue;
        red += data[pixel];
        green += data[pixel + 1];
        blue += data[pixel + 2];
        samples += 1;
      }
    }
  }

  return samples === 0
    ? [0, 0, 0]
    : [Math.round(red / samples), Math.round(green / samples), Math.round(blue / samples)];
}

export function removeConnectedBackground(
  image: ImageData,
  tolerance: number,
  includeEnclosedAreas: boolean,
  protectedMask: Uint8Array | null,
): ImageData {
  const result = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  const { data, width, height } = result;
  const [backgroundRed, backgroundGreen, backgroundBlue] = estimateCornerColor(image);
  const limitSquared = tolerance * tolerance;
  const queued = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0;
  let tail = 0;

  const isProtected = (pixelIndex: number) => {
    return protectedMask?.[pixelIndex] === 1;
  };

  const isBackground = (pixelIndex: number) => {
    if (isProtected(pixelIndex)) return false;
    const offset = pixelIndex * 4;
    if (data[offset + 3] === 0) return true;
    const red = data[offset] - backgroundRed;
    const green = data[offset + 1] - backgroundGreen;
    const blue = data[offset + 2] - backgroundBlue;
    return red * red + green * green + blue * blue <= limitSquared;
  };

  const enqueue = (pixelIndex: number) => {
    if (queued[pixelIndex] || !isBackground(pixelIndex)) return;
    queued[pixelIndex] = 1;
    queue[tail] = pixelIndex;
    tail += 1;
  };

  if (includeEnclosedAreas) {
    for (let pixelIndex = 0; pixelIndex < width * height; pixelIndex += 1) {
      if (isBackground(pixelIndex)) data[pixelIndex * 4 + 3] = 0;
    }
    return result;
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x);
    enqueue((height - 1) * width + x);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(y * width);
    enqueue(y * width + width - 1);
  }

  while (head < tail) {
    const pixelIndex = queue[head];
    head += 1;
    data[pixelIndex * 4 + 3] = 0;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    if (x > 0) enqueue(pixelIndex - 1);
    if (x < width - 1) enqueue(pixelIndex + 1);
    if (y > 0) enqueue(pixelIndex - width);
    if (y < height - 1) enqueue(pixelIndex + width);
  }

  return result;
}

export function getFrequentColors(image: ImageData, maximum = 8): ColorEntry[] {
  const counts = new Map<string, number>();
  const { data } = image;

  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3] === 0) continue;
    const hex = `#${data[offset].toString(16).padStart(2, "0")}${data[offset + 1]
      .toString(16)
      .padStart(2, "0")}${data[offset + 2].toString(16).padStart(2, "0")}`.toUpperCase();
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maximum)
    .map(([hex, count]) => ({ hex, count }));
}

export function colorToHex(color: [number, number, number]): string {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}
