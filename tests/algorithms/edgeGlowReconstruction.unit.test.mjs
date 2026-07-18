import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconstructEdgeGlow } from "../../src/algorithms/edgeGlowReconstruction.ts";

function createImage(pixels) {
  return {
    width: pixels.length,
    height: 1,
    data: new Uint8ClampedArray(pixels.flat()),
  };
}

function pixelsOf(image) {
  const pixels = [];
  for (let offset = 0; offset < image.data.length; offset += 4) {
    pixels.push([...image.data.slice(offset, offset + 4)]);
  }
  return pixels;
}

describe("reconstructEdgeGlow", () => {
  it("promotes a whole edge island and reconstructs Alpha from a nearby solid anchor", () => {
    const result = reconstructEdgeGlow(
      createImage([
        [0, 0, 0, 255],
        [188, 188, 188, 255],
        [188, 188, 188, 255],
        [255, 255, 255, 255],
      ]),
      new Int32Array([0, 1, 1, 2]),
      [0, 0, 0],
      new Uint8Array([1, 0, 0, 0]),
      new Float32Array([0, 0.06, 0.06, 0.3]),
      0.02,
    );

    assert.deepEqual([...result.glowMask], [0, 1, 1, 0]);
    assert.deepEqual([...result.backgroundMask], [1, 0, 0, 0]);
    const pixels = pixelsOf(result.image);
    assert.deepEqual(pixels[0], [0, 0, 0, 0]);
    assert.deepEqual(pixels[1].slice(0, 3), [255, 255, 255]);
    assert.deepEqual(pixels[2].slice(0, 3), [255, 255, 255]);
    assert.ok(pixels[1][3] >= 127 && pixels[1][3] <= 129);
    assert.ok(pixels[2][3] >= 127 && pixels[2][3] <= 129);
    assert.equal(result.stats.edgeIslandCount, 1);
    assert.equal(result.stats.reconstructedPixelCount, 2);
  });

  it("does not modify protected pixels inside an edge island", () => {
    const image = createImage([
      [0, 0, 0, 255],
      [188, 188, 188, 255],
      [188, 188, 188, 255],
      [255, 255, 255, 255],
    ]);
    const result = reconstructEdgeGlow(
      image,
      new Int32Array([0, 1, 1, 2]),
      [0, 0, 0],
      new Uint8Array([1, 0, 0, 0]),
      new Float32Array([0, 0.06, 0.06, 0.3]),
      0.02,
      new Uint8Array([0, 0, 1, 0]),
    );

    assert.deepEqual(pixelsOf(result.image)[2], [188, 188, 188, 255]);
  });

  it("classifies glow pixels as background when no reliable foreground anchor exists", () => {
    const result = reconstructEdgeGlow(
      createImage([[0, 0, 0, 255], [80, 80, 80, 255]]),
      new Int32Array([0, 1]),
      [0, 0, 0],
      new Uint8Array([1, 0]),
      new Float32Array([0, 0.05]),
      0.02,
    );

    assert.deepEqual(pixelsOf(result.image)[1], [0, 0, 0, 0]);
    assert.deepEqual([...result.backgroundMask], [1, 1]);
    assert.equal(result.stats.fallbackBackgroundPixelCount, 1);
  });

  it("does not treat non-boundary foreground or existing semi-transparency as baked glow", () => {
    const result = reconstructEdgeGlow(
      createImage([
        [0, 0, 0, 255],
        [80, 80, 80, 128],
        [80, 80, 80, 255],
      ]),
      new Int32Array([0, 1, 2]),
      [0, 0, 0],
      new Uint8Array([1, 0, 0]),
      new Float32Array([0, 0.05, 0.05]),
      0.02,
    );

    assert.deepEqual([...result.glowMask], [0, 0, 0]);
    assert.equal(result.stats.semiTransparentPixelCount, 1);
  });

  it("preserves existing semi-transparent pixels even when the background mask contains them", () => {
    const result = reconstructEdgeGlow(
      createImage([[12, 18, 24, 96]]),
      new Int32Array([0]),
      [12, 18, 24],
      new Uint8Array([1]),
      new Float32Array([0]),
      0.02,
    );

    assert.deepEqual(pixelsOf(result.image)[0], [12, 18, 24, 96]);
    assert.equal(result.stats.semiTransparentPixelCount, 1);
  });

  it("allows a zero glow width to disable edge-island reconstruction", () => {
    const result = reconstructEdgeGlow(
      createImage([[0, 0, 0, 255], [188, 188, 188, 255], [255, 255, 255, 255]]),
      new Int32Array([0, 1, 2]),
      [0, 0, 0],
      new Uint8Array([1, 0, 0]),
      new Float32Array([0, 0.06, 0.3]),
      0.02,
      null,
      0,
    );

    assert.deepEqual([...result.glowMask], [0, 0, 0]);
    assert.equal(result.stats.edgeIslandCount, 0);
    assert.equal(result.stats.reconstructedPixelCount, 0);
  });
});
