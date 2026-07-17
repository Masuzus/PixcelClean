import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateBackgroundMask } from "../../src/algorithms/backgroundMaskGeneration.ts";

function createImage(pixels) {
  return {
    width: pixels.length,
    height: 1,
    data: new Uint8ClampedArray(pixels.flat()),
  };
}

describe("generateBackgroundMask", () => {
  it("classifies every non-transparent pixel using one selected threshold", () => {
    const result = generateBackgroundMask(
      createImage([
        [65, 38, 27, 255],
        [66, 38, 27, 255],
        [90, 120, 70, 255],
      ]),
      [65, 38, 27],
      0.006,
    );

    assert.deepEqual([...result.backgroundMask], [1, 1, 0]);
    assert.equal(result.distances[0], 0);
    assert.ok(result.distances[2] > 0.006);
  });

  it("keeps matching pixels out of the background when they are protected", () => {
    const result = generateBackgroundMask(
      createImage([
        [65, 38, 27, 255],
        [65, 38, 27, 255],
      ]),
      [65, 38, 27],
      0.006,
      new Uint8Array([0, 1]),
    );

    assert.deepEqual([...result.backgroundMask], [1, 0]);
  });

  it("excludes transparent pixels from the background mask", () => {
    const result = generateBackgroundMask(
      createImage([[65, 38, 27, 0]]),
      [65, 38, 27],
      0.006,
    );

    assert.deepEqual([...result.backgroundMask], [0]);
    assert.equal(result.distances[0], 0);
  });

  it("validates image and protection mask dimensions", () => {
    const image = createImage([[65, 38, 27, 255]]);
    assert.throws(() => generateBackgroundMask(image, [65, 38, 27], 0.006, new Uint8Array(2)));
  });
});
