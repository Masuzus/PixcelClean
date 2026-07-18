import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeLocalColorIslands } from "../../src/algorithms/localColorIslands.ts";

function createImage(width, pixels) {
  return {
    width,
    height: pixels.length / width,
    data: new Uint8ClampedArray(pixels.flat()),
  };
}

function rgbValues(image) {
  const values = [];
  for (let offset = 0; offset < image.data.length; offset += 4) {
    values.push([...image.data.slice(offset, offset + 4)]);
  }
  return values;
}

describe("mergeLocalColorIslands", () => {
  it("uses the running island mean to stop a local similarity chain", () => {
    const result = mergeLocalColorIslands(createImage(3, [
      [10, 10, 10, 255],
      [12, 12, 12, 255],
      [14, 14, 14, 255],
    ]), 0.01);

    assert.deepEqual([...result.islandIds], [0, 0, 1]);
    assert.deepEqual(rgbValues(result.image), [
      [12, 12, 12, 255],
      [12, 12, 12, 255],
      [14, 14, 14, 255],
    ]);
  });

  it("uses four-neighbor connectivity and does not join diagonals", () => {
    const result = mergeLocalColorIslands(createImage(2, [
      [20, 20, 20, 255], [0, 0, 0, 0],
      [0, 0, 0, 0], [20, 20, 20, 255],
    ]), 0.1);

    assert.equal(result.stats.islandCount, 2);
    assert.deepEqual([...result.islandIds], [0, -1, -1, 1]);
  });

  it("replaces an island with the real color nearest its OKLab median", () => {
    const result = mergeLocalColorIslands(createImage(3, [
      [10, 10, 10, 255],
      [11, 11, 11, 128],
      [12, 12, 12, 255],
    ]), 0.02);

    assert.deepEqual(rgbValues(result.image), [
      [11, 11, 11, 255],
      [11, 11, 11, 128],
      [11, 11, 11, 255],
    ]);
    assert.equal(result.stats.replacedPixelCount, 2);
    assert.equal(result.stats.inputColorCount, 3);
    assert.equal(result.stats.outputColorCount, 1);
  });

  it("keeps transparent pixels and validates the threshold", () => {
    const image = createImage(1, [[90, 80, 70, 0]]);
    const result = mergeLocalColorIslands(image, 0.02);
    assert.deepEqual(rgbValues(result.image), [[90, 80, 70, 0]]);
    assert.equal(result.stats.processedPixelCount, 0);
    assert.throws(() => mergeLocalColorIslands(image, -0.001));
  });
});
