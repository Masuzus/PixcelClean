import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { estimateCornerColor } from "../../src/algorithms/backgroundColorEstimation.ts";

describe("estimateCornerColor with real PNG fixtures", () => {
  it("estimates the verified dark background of pixel-clean-source.png", () => {
    const fixturePath = fileURLToPath(new URL(
      "../../docs/images/pixel-clean-source.png",
      import.meta.url,
    ));
    const png = PNG.sync.read(readFileSync(fixturePath));

    const estimated = estimateCornerColor({
      width: png.width,
      height: png.height,
      data: new Uint8ClampedArray(png.data),
    });

    assert.deepEqual(estimated, [23, 17, 29]); // #17111D
  });
});
