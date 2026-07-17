import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { PNG } from "pngjs";
import {
  getAdaptiveBackgroundThresholds,
} from "../../src/algorithms/adaptiveBackgroundThresholds.ts";
import { rgbToOklab } from "../../src/algorithms/colorSpace.ts";

function createSolidImage(width, height, [red, green, blue]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) {
    data[offset] = red;
    data[offset + 1] = green;
    data[offset + 2] = blue;
    data[offset + 3] = 255;
  }
  return { width, height, data };
}

function createImageWithCleanCornersAndVariableInterior(width, height, background) {
  const data = new Uint8ClampedArray(width * height * 4);
  const variantWeights = [300, 280, 250, 220, 190, 160, 130, 100, 80, 60, 45, 35, 25, 18, 12, 8];
  const redVariants = variantWeights.flatMap((weight, index) => Array(weight).fill(background[0] + index));
  let variantIndex = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isCleanCorner = (x < 8 || x >= width - 8) && (y < 8 || y >= height - 8);
      const offset = (y * width + x) * 4;
      data[offset] = isCleanCorner ? background[0] : redVariants[variantIndex % redVariants.length];
      data[offset + 1] = background[1];
      data[offset + 2] = background[2];
      data[offset + 3] = 255;
      if (!isCleanCorner) variantIndex += 1;
    }
  }
  return { width, height, data };
}

async function readPngFixture(relativePath) {
  const png = PNG.sync.read(await readFile(new URL(relativePath, import.meta.url)));
  return {
    data: new Uint8ClampedArray(png.data),
    height: png.height,
    width: png.width,
  };
}

describe("getAdaptiveBackgroundThresholds", () => {
  it("uses only the algorithm floor for a uniform background", () => {
    const background = [28, 21, 35];
    const thresholds = getAdaptiveBackgroundThresholds(
      createSolidImage(16, 16, background),
      rgbToOklab(...background),
    );

    assert.deepEqual(thresholds, { strict: 0.006, loose: 0.014 });
  });

  it("uses the full-image distribution even when all four 8x8 corners are uniform", () => {
    const background = [65, 38, 27];
    const uniformThresholds = getAdaptiveBackgroundThresholds(
      createSolidImage(64, 64, background),
      rgbToOklab(...background),
    );
    const variableThresholds = getAdaptiveBackgroundThresholds(
      createImageWithCleanCornersAndVariableInterior(64, 64, background),
      rgbToOklab(...background),
    );

    assert.deepEqual(uniformThresholds, { strict: 0.006, loose: 0.014 });
    assert.equal(variableThresholds.strict, 0.006);
    assert.equal(variableThresholds.loose, 0.033);
  });

  it("keeps the meaningful sparse background tail in a real PNG", async () => {
    const thresholds = getAdaptiveBackgroundThresholds(
      await readPngFixture("../input/images/rika_5782140c.png"),
      rgbToOklab(65, 38, 27),
    );

    assert.deepEqual(thresholds, { strict: 0.006, loose: 0.021 });
  });
});
