import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  binOklabDistanceDistribution,
  collectOklabDistanceDistribution,
} from "../../src/algorithms/oklabDistanceDistribution.ts";
import { rgbToOklab } from "../../src/algorithms/colorSpace.ts";

function createImage(pixels) {
  return {
    width: pixels.length,
    height: 1,
    data: new Uint8ClampedArray(pixels.flat()),
  };
}

describe("OKLab distance distribution", () => {
  it("counts every non-transparent pixel across the full image", () => {
    const distribution = collectOklabDistanceDistribution(
      createImage([
        [0, 0, 0, 255],
        [0, 0, 0, 255],
        [255, 255, 255, 255],
        [128, 128, 128, 0],
      ]),
      rgbToOklab(0, 0, 0),
    );

    assert.equal(distribution.pixelCount, 3);
    assert.equal(distribution.transparentPixelCount, 1);
    assert.equal(distribution.counts.reduce((sum, count) => sum + count, 0), 3);
    assert.equal(distribution.counts[0], 2);
    assert.ok(distribution.maximumDistance > 0.99);
  });

  it("rebins the full distribution using a user-defined interval", () => {
    const distribution = collectOklabDistanceDistribution(
      createImage([
        [0, 0, 0, 255],
        [64, 64, 64, 255],
        [128, 128, 128, 255],
        [255, 255, 255, 255],
      ]),
      rgbToOklab(0, 0, 0),
    );
    const bins = binOklabDistanceDistribution(distribution, 0.1);

    assert.equal(bins.reduce((sum, bin) => sum + bin.count, 0), 4);
    assert.equal(bins[0].start, 0);
    assert.equal(bins[0].end, 0.1);
  });

  it("rejects intervals smaller than the stored distribution resolution", () => {
    const distribution = collectOklabDistanceDistribution(
      createImage([[0, 0, 0, 255]]),
      rgbToOklab(0, 0, 0),
    );

    assert.throws(() => binOklabDistanceDistribution(distribution, 0.00001));
  });
});
