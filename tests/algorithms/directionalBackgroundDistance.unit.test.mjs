import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rgbToOklab } from "../../src/algorithms/colorSpace.ts";
import {
  directionalBackgroundDistance,
  getDirectionalBackgroundDistance,
} from "../../src/algorithms/directionalBackgroundDistance.ts";

function distanceBetween(background, pixel) {
  return directionalBackgroundDistance(rgbToOklab(...pixel), rgbToOklab(...background));
}

describe("directionalBackgroundDistance", () => {
  it("tolerates near-black lightness variation", () => {
    assert.ok(distanceBetween([0, 0, 0], [10, 10, 10]) < 0.1);
  });

  it("separates a saturated purple from a dark purple background", () => {
    const background = [23, 17, 29];
    assert.ok(distanceBetween(background, [68, 11, 56]) > 0.15);
    assert.ok(distanceBetween(background, [29, 15, 40]) < 0.08);
  });

  it("reports independently weighted lightness, chroma, and hue components", () => {
    const result = getDirectionalBackgroundDistance(
      rgbToOklab(68, 11, 56),
      rgbToOklab(23, 17, 29),
    );
    assert.ok(result.deltaLightness > 0);
    assert.ok(result.deltaChroma > 0);
    assert.ok(result.deltaHue > 0);
    assert.ok(Math.abs(result.distance - 0.16694856) < 0.000001);
  });

  it("rejects invalid weight profiles", () => {
    assert.throws(() => directionalBackgroundDistance(
      rgbToOklab(0, 0, 0),
      rgbToOklab(0, 0, 0),
      { lightnessWeight: 0, chromaWeight: 2, hueWeight: 2 },
    ));
  });
});
