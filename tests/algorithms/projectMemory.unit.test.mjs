import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createImageMemoryKey,
  normalizeProjectMemoryPreviewBackgroundColor,
  normalizeProjectMemoryPreviewBackgroundMode,
  normalizeProjectMemoryPreviewMode,
} from "../../src/editor/projectMemory.ts";

describe("createImageMemoryKey", () => {
  it("creates a stable SHA-256 key from the PNG bytes", async () => {
    const bytes = new TextEncoder().encode("pixel-clean").buffer;
    const firstKey = await createImageMemoryKey(bytes);
    const secondKey = await createImageMemoryKey(bytes.slice(0));

    assert.equal(firstKey, secondKey);
    assert.equal(firstKey, "0c90f51a891ed8dfdbbf2fef18ba9344cceefe0c404f1099ca14d452c607f6bf");
  });
});

describe("normalizeProjectMemoryPreviewMode", () => {
  it("migrates the removed edge-glow preview to remove-background", () => {
    assert.equal(normalizeProjectMemoryPreviewMode("edge-glow"), "remove-background");
  });

  it("preserves current modes and falls back safely for invalid data", () => {
    assert.equal(normalizeProjectMemoryPreviewMode("remove-foreground"), "remove-foreground");
    assert.equal(normalizeProjectMemoryPreviewMode("mask"), "mask");
    assert.equal(normalizeProjectMemoryPreviewMode("merged"), "remove-background");
    assert.equal(normalizeProjectMemoryPreviewMode("unknown"), "remove-background");
  });
});

describe("preview background memory normalization", () => {
  it("preserves supported background modes and migrates missing values to checkerboard", () => {
    assert.equal(normalizeProjectMemoryPreviewBackgroundMode("black"), "black");
    assert.equal(normalizeProjectMemoryPreviewBackgroundMode("custom"), "custom");
    assert.equal(normalizeProjectMemoryPreviewBackgroundMode(undefined), "checkerboard");
  });

  it("normalizes a valid custom color and rejects invalid stored colors", () => {
    assert.equal(normalizeProjectMemoryPreviewBackgroundColor("#1c2d3e"), "#1C2D3E");
    assert.equal(normalizeProjectMemoryPreviewBackgroundColor("transparent"), "#6B7280");
  });
});
