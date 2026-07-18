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
