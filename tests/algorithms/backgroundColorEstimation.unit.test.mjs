import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateCornerColor } from "../../src/algorithms/backgroundColorEstimation.ts";

function createImage(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function setPixel(image, x, y, color) {
  image.data.set(color, (y * image.width + x) * 4);
}

function paintCornerSamples(image, color) {
  const sampleSize = Math.min(4, image.width, image.height);
  const origins = [
    [0, 0],
    [image.width - sampleSize, 0],
    [0, image.height - sampleSize],
    [image.width - sampleSize, image.height - sampleSize],
  ];
  for (const [startX, startY] of origins) {
    for (let y = startY; y < startY + sampleSize; y += 1) {
      for (let x = startX; x < startX + sampleSize; x += 1) setPixel(image, x, y, color);
    }
  }
}

describe("estimateCornerColor", () => {
  it("uses corner samples and ignores an unrelated center", () => {
    const image = createImage(12, 12, [240, 30, 20, 255]);
    paintCornerSamples(image, [28, 21, 35, 255]);

    assert.deepEqual(estimateCornerColor(image), [28, 21, 35]);
  });

  it("resists a minority of noisy corner pixels", () => {
    const image = createImage(12, 12, [28, 21, 35, 255]);
    setPixel(image, 0, 0, [255, 0, 200, 255]);
    setPixel(image, 11, 0, [0, 255, 10, 255]);
    setPixel(image, 0, 11, [100, 100, 255, 255]);

    assert.deepEqual(estimateCornerColor(image), [28, 21, 35]);
  });

  it("ignores fully transparent corner pixels", () => {
    const image = createImage(12, 12, [28, 21, 35, 255]);
    setPixel(image, 0, 0, [255, 255, 255, 0]);
    setPixel(image, 11, 11, [0, 0, 0, 0]);

    assert.deepEqual(estimateCornerColor(image), [28, 21, 35]);
  });

  it("falls back to black when all sampled pixels are transparent", () => {
    const image = createImage(12, 12, [10, 20, 30, 0]);

    assert.deepEqual(estimateCornerColor(image), [0, 0, 0]);
  });

  it("handles images smaller than the normal corner sample", () => {
    const image = createImage(2, 3, [7, 13, 19, 255]);

    assert.deepEqual(estimateCornerColor(image), [7, 13, 19]);
  });

  it("does not mutate source pixels", () => {
    const image = createImage(12, 12, [28, 21, 35, 255]);
    const original = new Uint8ClampedArray(image.data);

    estimateCornerColor(image);

    assert.deepEqual(image.data, original);
  });
});
