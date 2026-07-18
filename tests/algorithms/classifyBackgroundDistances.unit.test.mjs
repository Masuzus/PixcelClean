import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyBackgroundDistances } from "../../src/algorithms/classifyBackgroundDistances.ts";

function createImage(pixels) {
  return {
    width: pixels.length,
    height: 1,
    data: new Uint8ClampedArray(pixels.flat()),
  };
}

describe("classifyBackgroundDistances", () => {
  it("classifies cached distances without recomputing color distance", () => {
    const image = createImage([
      [10, 20, 30, 255],
      [20, 30, 40, 255],
      [0, 0, 0, 0],
    ]);
    const mask = classifyBackgroundDistances(image, new Float32Array([0.002, 0.02, 0]), 0.01);
    assert.deepEqual([...mask], [1, 0, 0]);
  });

  it("always keeps protected pixels out of the background mask", () => {
    const image = createImage([
      [10, 20, 30, 255],
      [10, 20, 30, 255],
    ]);
    const mask = classifyBackgroundDistances(
      image,
      new Float32Array([0, 0]),
      1,
      new Uint8Array([0, 1]),
    );
    assert.deepEqual([...mask], [1, 0]);
  });

  it("supports thresholds below the adaptive slider range", () => {
    const image = createImage([[10, 20, 30, 255]]);
    const mask = classifyBackgroundDistances(image, new Float32Array([0]), -0.001);
    assert.deepEqual([...mask], [0]);
  });

  it("validates distance and protection dimensions", () => {
    const image = createImage([[10, 20, 30, 255]]);
    assert.throws(() => classifyBackgroundDistances(image, new Float32Array(2), 0.01));
    assert.throws(() => classifyBackgroundDistances(image, new Float32Array(1), 0.01, new Uint8Array(2)));
  });
});
