import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import { analyzeBackground } from "../../src/pipeline/backgroundAnalysis.ts";

describe("analyzeBackground", () => {
  it("chains estimation, adaptive thresholds, and protected mask classification", () => {
    const image = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([
        28, 21, 35, 255,
        28, 21, 35, 255,
        28, 21, 35, 255,
      ]),
    };
    const result = analyzeBackground(image, {
      protectedMask: new Uint8Array([0, 1, 0]),
    });
    assert.deepEqual(result.estimatedBackgroundColor, [28, 21, 35]);
    assert.deepEqual([...result.mergedImage.data], [...image.data]);
    assert.equal(result.localColorStats.islandCount, 1);
    assert.deepEqual(result.backgroundColor, [28, 21, 35]);
    assert.deepEqual(result.thresholds, { strict: 0.006, loose: 0.014 });
    assert.equal(result.selectedThreshold, 0.01);
    assert.deepEqual([...result.backgroundMask], [1, 0, 1]);
    assert.equal(result.stats.backgroundPixelCount, 2);
    assert.equal(result.stats.foregroundPixelCount, 1);
    assert.equal(result.stats.protectedPixelCount, 1);
  });

  it("runs local color islands before background estimation on a real PNG", async () => {
    const png = PNG.sync.read(await readFile(new URL("../input/images/rika_42185cce (1).png", import.meta.url)));
    const result = analyzeBackground({
      width: png.width,
      height: png.height,
      data: new Uint8ClampedArray(png.data),
    }, {
      backgroundColor: [28, 21, 35],
      localColorThreshold: 0.02,
    });

    assert.deepEqual(result.thresholds, { strict: 0.015, loose: 0.019 });
    assert.equal(result.localColorStats.islandCount, 8122);
    assert.equal(result.localColorStats.replacedPixelCount, 17761);
    assert.equal(result.localColorStats.outputColorCount, 5976);
  });

  it("preserves an explicit background threshold while local colors are recomputed", () => {
    const image = {
      width: 2,
      height: 1,
      data: new Uint8ClampedArray([
        28, 21, 35, 255,
        29, 22, 36, 255,
      ]),
    };
    const result = analyzeBackground(image, {
      localColorThreshold: 0.03,
      selectedThreshold: 0.027,
    });

    assert.equal(result.selectedThreshold, 0.027);
  });

  it("applies an adjustable edge-glow width without changing the selected background threshold", () => {
    const image = {
      width: 3,
      height: 1,
      data: new Uint8ClampedArray([
        0, 0, 0, 255,
        30, 30, 30, 255,
        255, 255, 255, 255,
      ]),
    };
    const disabled = analyzeBackground(image, {
      backgroundColor: [0, 0, 0],
      localColorThreshold: 0,
      selectedThreshold: 0.02,
      edgeGlowWidth: 0,
    });
    const enabled = analyzeBackground(image, {
      backgroundColor: [0, 0, 0],
      localColorThreshold: 0,
      selectedThreshold: 0.02,
      edgeGlowWidth: 0.1,
    });

    assert.equal(disabled.selectedThreshold, 0.02);
    assert.equal(enabled.selectedThreshold, 0.02);
    assert.equal(disabled.edgeGlowStats.edgeIslandCount, 0);
    assert.equal(enabled.edgeGlowStats.edgeIslandCount, 1);
  });
});
