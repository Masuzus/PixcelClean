import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { generateBackgroundMask } from "../../src/algorithms/backgroundMaskGeneration.ts";
import {
  defaultLocalColorSimilarityThreshold,
  mergeLocalColorIslands,
} from "../../src/algorithms/localColorIslands.ts";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const inputDirectory = path.join(projectRoot, "tests/input/images");
const outputDirectory = path.join(projectRoot, "test-results");
const reportPath = path.join(outputDirectory, "background-mask-report.html");
const distanceResolution = 0.0001;

function parseBackgroundColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value ?? "");
  if (!match) throw new Error("--background 需要 6 位 Hex 颜色，例如 #1C1523。");
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
}

function parseArguments(argumentsList) {
  let backgroundColor = null;
  let strict = null;
  let loose = null;
  let threshold = null;
  let shouldOpen = true;
  let localColorThreshold = defaultLocalColorSimilarityThreshold;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--no-open") {
      shouldOpen = false;
    } else if (argument === "--local-threshold") {
      localColorThreshold = Number(argumentsList[index + 1]);
      if (!Number.isFinite(localColorThreshold) || localColorThreshold < 0) throw new Error("--local-threshold 需要大于或等于 0 的数值。");
      index += 1;
    } else if (argument === "--background") {
      backgroundColor = parseBackgroundColor(argumentsList[index + 1]);
      index += 1;
    } else if (argument === "--strict" || argument === "--loose" || argument === "--threshold") {
      const value = Number(argumentsList[index + 1]);
      if (!Number.isFinite(value) || value < 0) throw new Error(`${argument} 需要大于或等于 0 的数值。`);
      if (argument === "--strict") strict = value;
      else if (argument === "--loose") loose = value;
      else threshold = value;
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  if (!backgroundColor) throw new Error("缺少背景颜色。请添加 --background \"#1C1523\"。");
  if (strict === null) throw new Error("缺少严格阈值。请添加 --strict 0.006。");
  if (loose === null) throw new Error("缺少宽松阈值。请添加 --loose 0.014。");
  if (loose <= strict) throw new Error("--loose 必须大于 --strict。");
  const initialThreshold = threshold ?? (strict + loose) / 2;
  if (initialThreshold < strict || initialThreshold > loose) {
    throw new Error("--threshold 必须位于 --strict 和 --loose 之间。");
  }
  return { backgroundColor, initialThreshold, inputDirectory, localColorThreshold, loose, shouldOpen, strict };
}

async function collectPngFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectPngFiles(entryPath));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".png") files.push(entryPath);
  }
  return files;
}

function colorToHex(color) {
  return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getSwatchTextColor([red, green, blue]) {
  const luminance = (0.2126 * red + 0.7152 * green + 0.0722 * blue) / 255;
  return luminance > 0.58 ? "#111111" : "#FFFFFF";
}

function encodeDistances(distances) {
  const buffer = Buffer.allocUnsafe(distances.length * 2);
  for (let index = 0; index < distances.length; index += 1) {
    const quantized = Math.min(65_535, Math.round(distances[index] / distanceResolution));
    buffer.writeUInt16LE(quantized, index * 2);
  }
  return buffer.toString("base64");
}

function createResultMarkup(result, index) {
  const safeName = escapeHtml(result.relativePath);
  const percentage = result.pixelCount === 0 ? 0 : result.initialBackgroundCount / result.pixelCount * 100;
  return `<article class="result" data-index="${index}">
    <header><h2>${safeName}</h2><span>${result.width} x ${result.height}</span></header>
    <section class="threshold-control">
      <div><span>strict</span><strong>${result.strict.toFixed(6)}</strong></div>
      <div class="threshold-editor">
        <label for="threshold-${index}">
          <span>当前阈值 <output data-role="threshold">${result.defaultThreshold.toFixed(6)}</output></span>
        </label>
        <div class="threshold-input-row">
          <input id="threshold-${index}" class="threshold-slider" max="${result.loose}" min="${result.strict}" step="${distanceResolution}" type="range" value="${result.defaultThreshold}">
          <button aria-label="阈值减少 0.001" data-threshold-step="-0.001" title="阈值减少 0.001" type="button">−</button>
          <button aria-label="阈值增加 0.001" data-threshold-step="0.001" title="阈值增加 0.001" type="button">+</button>
        </div>
      </div>
      <div><span>loose</span><strong>${result.loose.toFixed(6)}</strong></div>
    </section>
    <div class="live-stats">
      <span>背景像素 <strong data-role="background-count">${result.initialBackgroundCount.toLocaleString("zh-CN")}</strong></span>
      <span>占非透明像素 <strong data-role="background-ratio">${percentage.toFixed(2)}%</strong></span>
      <span data-role="pixel-detail">未选择像素</span>
    </div>
    <div class="report-toolbar">
      <div class="view-control" aria-label="图像视图控制" role="group">
        <button aria-label="缩小图像" data-view-action="zoom-out" title="缩小图像" type="button">−</button>
        <button data-view-action="fit" title="适应窗口" type="button">适应</button>
        <button data-view-action="actual" title="以一个图像像素对应一个屏幕像素显示" type="button">1:1</button>
        <button aria-label="放大图像" data-view-action="zoom-in" title="放大图像" type="button">+</button>
        <output data-role="zoom">100%</output>
      </div>
      <div class="mode-control" aria-label="背景分类显示模式">
        <button aria-pressed="true" data-mode="remove-background" type="button">去除背景</button>
        <button aria-pressed="false" data-mode="remove-foreground" type="button">去除前景</button>
        <button aria-pressed="false" data-mode="mask" type="button">蒙版</button>
      </div>
    </div>
    <div class="comparison">
      <figure>
        <div class="image-surface checkerboard" data-role="viewport">
          <img alt="${safeName} 原图" data-role="source" draggable="false" src="${result.dataUrl}">
          <i class="pixel-marker" data-role="pixel-marker" hidden></i>
        </div>
        <figcaption>原图</figcaption>
      </figure>
      <figure>
        <div class="image-surface checkerboard" data-role="viewport">
          <canvas aria-label="${safeName} 背景分类结果" data-role="result"></canvas>
          <i class="pixel-marker" data-role="pixel-marker" hidden></i>
        </div>
        <figcaption data-role="result-caption">背景分类 · 已去除背景</figcaption>
      </figure>
    </div>
  </article>`;
}

function createErrorMarkup(error) {
  return `<article class="result error"><h2>${escapeHtml(error.relativePath)}</h2><p>${escapeHtml(error.message)}</p></article>`;
}

function createReport(results, errors, inputDirectory, backgroundColor) {
  const backgroundHex = colorToHex(backgroundColor);
  const textColor = getSwatchTextColor(backgroundColor);
  const generatedAt = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date());
  const clientData = JSON.stringify(results.map((result) => ({
    width: result.width,
    height: result.height,
    strict: result.strict,
    loose: result.loose,
    defaultThreshold: result.defaultThreshold,
    distances: result.encodedDistances,
    resolution: distanceResolution,
  }))).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>背景蒙版分类测试</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, "Microsoft YaHei", system-ui, sans-serif; color: #202124; background: #F5F6F7; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    button, input { font: inherit; }
    main { width: min(1240px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; font-weight: 600; }
    h2 { overflow-wrap: anywhere; font-size: 15px; font-weight: 600; }
    .summary { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 24px; }
    .summary-copy { display: grid; gap: 5px; }
    .summary p, header span, figcaption, .threshold-control span, .live-stats { color: #62676D; font-size: 13px; }
    .background-input { display: grid; gap: 5px; }
    .background-input span { color: #62676D; font-size: 12px; }
    .swatch { display: grid; place-items: center; min-width: 132px; height: 54px; padding: 0 12px; color: var(--swatch-text); background: var(--swatch-color); border: 1px solid #D6D9DC; border-radius: 6px; font-family: Consolas, monospace; }
    .results { display: grid; gap: 18px; }
    .result { padding: 16px; border: 1px solid #D6D9DC; border-radius: 8px; background: #FFFFFF; }
    .result header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 16px; }
    .threshold-control { display: grid; grid-template-columns: 150px minmax(260px, 1fr) 150px; gap: 18px; align-items: end; }
    .threshold-control > div, .threshold-control label { display: grid; gap: 7px; }
    .threshold-control > div:last-child { text-align: right; }
    .threshold-control label span { display: flex; justify-content: space-between; gap: 12px; }
    .threshold-control strong, .threshold-control output { color: #17664A; font-family: Consolas, monospace; }
    .threshold-input-row { display: grid; grid-template-columns: minmax(0, 1fr) 32px 32px; gap: 6px; align-items: center; }
    .threshold-slider { width: 100%; accent-color: #247354; }
    .threshold-input-row button { display: grid; place-items: center; width: 32px; height: 28px; padding: 0; color: #30383C; background: #FFFFFF; border: 1px solid #AEB7BB; border-radius: 5px; cursor: pointer; font-size: 18px; line-height: 1; touch-action: manipulation; user-select: none; }
    .live-stats { display: flex; flex-wrap: wrap; gap: 22px; min-height: 34px; margin: 14px 0 12px; padding: 9px 0; border-top: 1px solid #E2E4E7; border-bottom: 1px solid #E2E4E7; }
    .live-stats strong { color: #202124; font-family: Consolas, monospace; }
    .live-stats [data-role="pixel-detail"] { margin-left: auto; font-family: Consolas, monospace; }
    .report-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 34px; margin-bottom: 8px; }
    .view-control, .mode-control { display: flex; align-items: center; gap: 6px; }
    .view-control button, .mode-control button { min-width: 34px; height: 31px; padding: 0 10px; color: #30383C; background: #FFFFFF; border: 1px solid #AEB7BB; border-radius: 5px; cursor: pointer; }
    .view-control output { min-width: 58px; color: #17664A; font: 600 12px Consolas, monospace; text-align: right; }
    .comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; }
    figure { display: grid; gap: 7px; min-width: 0; margin: 0; }
    .image-surface { position: relative; height: clamp(320px, 42vw, 560px); overflow: hidden; border: 1px solid #D6D9DC; border-radius: 6px; cursor: grab; touch-action: none; user-select: none; }
    .image-surface.is-dragging { cursor: grabbing; }
    .checkerboard { background-color: #F2F4F5; background-image: linear-gradient(45deg, #D9DDE0 25%, transparent 25%), linear-gradient(-45deg, #D9DDE0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #D9DDE0 75%), linear-gradient(-45deg, transparent 75%, #D9DDE0 75%); background-position: 0 0, 0 10px, 10px -10px, -10px 0; background-size: 20px 20px; }
    .image-surface img, .image-surface canvas { position: absolute; display: block; max-width: none; max-height: none; image-rendering: pixelated; pointer-events: none; }
    .pixel-marker { position: absolute; width: 14px; height: 14px; border: 2px solid #FFFFFF; border-radius: 50%; background: rgba(207, 38, 38, .32); box-shadow: 0 0 0 2px #CF2626, 0 2px 8px rgba(0, 0, 0, .45); pointer-events: none; transform: translate(-50%, -50%); }
    .pixel-marker[hidden] { display: none; }
    .mode-control button { min-width: 68px; }
    .mode-control button[aria-pressed="true"] { color: #FFFFFF; background: #202629; border-color: #202629; }
    .error { border-color: #D84A4A; } .error p { margin-top: 8px; color: #B3261E; }
    @media (prefers-color-scheme: dark) {
      :root { color: #E8EAED; background: #17191C; }
      .summary p, header span, figcaption, .threshold-control span, .live-stats, .background-input span { color: #AEB4BA; }
      .result { border-color: #454A50; background: #22252A; }
      .swatch, .image-surface { border-color: #454A50; }
      .live-stats { border-color: #3A3E43; }
      .live-stats strong { color: #E8EAED; }
      .threshold-control strong, .threshold-control output { color: #78D6AF; }
      .threshold-input-row button { color: #DDE3E7; background: #22282B; border-color: #59646A; }
      .checkerboard { background-color: #181B1D; background-image: linear-gradient(45deg, #30363A 25%, transparent 25%), linear-gradient(-45deg, #30363A 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #30363A 75%), linear-gradient(-45deg, transparent 75%, #30363A 75%); }
      .view-control button, .mode-control button { color: #DDE3E7; background: #22282B; border-color: #59646A; }
      .view-control output { color: #78D6AF; }
      .mode-control button[aria-pressed="true"] { color: #17201D; background: #78D6AF; border-color: #78D6AF; }
      .error p { color: #FF8A80; }
    }
    @media (max-width: 760px) {
      .summary { align-items: start; flex-direction: column; }
      .threshold-control { grid-template-columns: 1fr; }
      .threshold-control > div:last-child { text-align: left; }
      .report-toolbar { align-items: stretch; flex-direction: column; }
      .view-control, .mode-control { justify-content: space-between; }
      .view-control output { margin-left: auto; }
      .comparison { grid-template-columns: 1fr; }
      .live-stats [data-role="pixel-detail"] { width: 100%; margin-left: 0; }
    }
  </style>
</head>
<body>
  <main>
    <section class="summary">
      <div class="summary-copy">
        <h1>背景蒙版分类测试</h1>
        <p>${results.length} 张图片 · ${escapeHtml(generatedAt)}</p>
        <p>输入目录：<code>${escapeHtml(inputDirectory)}</code></p>
        <p>距离模型：<code>sqrt((0.5ΔL)² + (2ΔC)² + (2ΔH)²)</code></p>
      </div>
      <div class="background-input"><span>背景代表色</span><strong class="swatch" style="--swatch-color:${backgroundHex};--swatch-text:${textColor}">${backgroundHex}</strong></div>
    </section>
    <section class="results" aria-label="背景蒙版分类结果">
      ${results.map(createResultMarkup).join("\n")}
      ${errors.map(createErrorMarkup).join("\n")}
    </section>
  </main>
  <script id="background-mask-data" type="application/json">${clientData}</script>
  <script>
    (() => {
      const datasets = JSON.parse(document.getElementById("background-mask-data").textContent);
      const countFormatter = new Intl.NumberFormat("zh-CN");

      function decodeDistances(base64, count, resolution) {
        const binary = atob(base64);
        const distances = new Float32Array(count);
        for (let index = 0; index < count; index += 1) {
          const low = binary.charCodeAt(index * 2);
          const high = binary.charCodeAt(index * 2 + 1);
          distances[index] = (low | high << 8) * resolution;
        }
        return distances;
      }

      function clamp(value, minimum, maximum) {
        return Math.min(maximum, Math.max(minimum, value));
      }

      function updateFitScale(state) {
        const scales = state.viewports.map((viewport) => Math.min(
          Math.max(1, viewport.clientWidth - 2) / state.dataset.width,
          Math.max(1, viewport.clientHeight - 2) / state.dataset.height,
        ));
        state.fitScale = Math.max(0.0001, Math.min(...scales));
      }

      function updatePixelMarkers(state) {
        state.markers.forEach((marker, index) => {
          if (!state.selectedPixel) {
            marker.hidden = true;
            return;
          }
          const viewportRect = state.viewports[index].getBoundingClientRect();
          const mediaRect = state.media[index].getBoundingClientRect();
          marker.hidden = false;
          marker.style.left = (
            mediaRect.left - viewportRect.left
            + (state.selectedPixel.x + 0.5) / state.dataset.width * mediaRect.width
          ) + "px";
          marker.style.top = (
            mediaRect.top - viewportRect.top
            + (state.selectedPixel.y + 0.5) / state.dataset.height * mediaRect.height
          ) + "px";
        });
      }

      function renderView(state) {
        if (!state.initialized) return;
        const scale = state.fitScale * state.zoom;
        const displayWidth = state.dataset.width * scale;
        const displayHeight = state.dataset.height * scale;
        state.media.forEach((media, index) => {
          const viewport = state.viewports[index];
          media.style.width = displayWidth + "px";
          media.style.height = displayHeight + "px";
          media.style.left = (viewport.clientWidth / 2 + state.panX - displayWidth / 2) + "px";
          media.style.top = (viewport.clientHeight / 2 + state.panY - displayHeight / 2) + "px";
        });
        state.zoomOutput.textContent = Math.round(scale * 100) + "%";
        updatePixelMarkers(state);
      }

      function setZoom(state, nextZoom, anchor) {
        const zoom = clamp(nextZoom, 0.25, 32);
        if (zoom === state.zoom) return;
        if (anchor) {
          const viewportRect = anchor.viewport.getBoundingClientRect();
          const mediaRect = state.media[anchor.index].getBoundingClientRect();
          const imageX = (anchor.clientX - mediaRect.left) / mediaRect.width * state.dataset.width;
          const imageY = (anchor.clientY - mediaRect.top) / mediaRect.height * state.dataset.height;
          const nextScale = state.fitScale * zoom;
          state.panX = anchor.clientX - viewportRect.left - anchor.viewport.clientWidth / 2
            + (state.dataset.width / 2 - imageX) * nextScale;
          state.panY = anchor.clientY - viewportRect.top - anchor.viewport.clientHeight / 2
            + (state.dataset.height / 2 - imageY) * nextScale;
        }
        state.zoom = zoom;
        renderView(state);
      }

      function getPixelAtPoint(state, mediaIndex, clientX, clientY) {
        const rect = state.media[mediaIndex].getBoundingClientRect();
        if (clientX < rect.left || clientX >= rect.right || clientY < rect.top || clientY >= rect.bottom) return null;
        return {
          x: clamp(Math.floor((clientX - rect.left) / rect.width * state.dataset.width), 0, state.dataset.width - 1),
          y: clamp(Math.floor((clientY - rect.top) / rect.height * state.dataset.height), 0, state.dataset.height - 1),
        };
      }

      function updatePixelDetail(state) {
        if (!state.selectedPixel || !state.sourcePixels) {
          state.pixelDetail.textContent = "未选择像素";
          return;
        }
        const { x, y } = state.selectedPixel;
        const pixelIndex = y * state.dataset.width + x;
        const offset = pixelIndex * 4;
        const alpha = state.sourcePixels.data[offset + 3];
        const red = state.sourcePixels.data[offset];
        const green = state.sourcePixels.data[offset + 1];
        const blue = state.sourcePixels.data[offset + 2];
        const hex = "#" + [red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("").toUpperCase();
        if (alpha === 0) {
          state.pixelDetail.textContent = "像素 (" + x + ", " + y + ") · " + hex + " · 透明，不参与分类";
          return;
        }
        const distance = state.distances[pixelIndex];
        state.pixelDetail.textContent = "像素 (" + x + ", " + y + ") · " + hex
          + " · 方向距离 " + distance.toFixed(6)
          + " · " + (distance <= state.threshold ? "背景" : "前景");
      }

      function drawResult(state) {
        const threshold = state.threshold;
        const output = new ImageData(new Uint8ClampedArray(state.sourcePixels.data), state.dataset.width, state.dataset.height);
        let backgroundCount = 0;
        let opaqueCount = 0;
        for (let pixelIndex = 0; pixelIndex < state.distances.length; pixelIndex += 1) {
          const offset = pixelIndex * 4;
          if (state.sourcePixels.data[offset + 3] === 0) continue;
          opaqueCount += 1;
          const isBackground = state.distances[pixelIndex] <= threshold;
          if (isBackground) backgroundCount += 1;
          if (state.mode === "mask") {
            const value = isBackground ? 255 : 24;
            output.data[offset] = value;
            output.data[offset + 1] = value;
            output.data[offset + 2] = value;
            output.data[offset + 3] = 255;
          } else if (state.mode === "remove-background" && isBackground) output.data[offset + 3] = 0;
          else if (state.mode === "remove-foreground" && !isBackground) output.data[offset + 3] = 0;
        }
        state.context.putImageData(output, 0, 0);
        state.thresholdOutput.textContent = threshold.toFixed(6);
        state.backgroundCount.textContent = countFormatter.format(backgroundCount);
        state.backgroundRatio.textContent = (opaqueCount === 0 ? 0 : backgroundCount / opaqueCount * 100).toFixed(2) + "%";
        updatePixelDetail(state);
      }

      document.querySelectorAll(".result[data-index]").forEach((result) => {
        const dataset = datasets[Number(result.dataset.index)];
        const source = result.querySelector('[data-role="source"]');
        const canvas = result.querySelector('[data-role="result"]');
        const slider = result.querySelector(".threshold-slider");
        const viewports = [...result.querySelectorAll('[data-role="viewport"]')];
        const state = {
          dataset,
          source,
          canvas,
          slider,
          viewports,
          media: [source, canvas],
          markers: [...result.querySelectorAll('[data-role="pixel-marker"]')],
          context: canvas.getContext("2d"),
          distances: decodeDistances(dataset.distances, dataset.width * dataset.height, dataset.resolution),
          mode: "remove-background",
          initialized: false,
          threshold: dataset.defaultThreshold,
          selectedPixel: null,
          fitScale: 1,
          zoom: 1,
          panX: 0,
          panY: 0,
          thresholdOutput: result.querySelector('[data-role="threshold"]'),
          backgroundCount: result.querySelector('[data-role="background-count"]'),
          backgroundRatio: result.querySelector('[data-role="background-ratio"]'),
          pixelDetail: result.querySelector('[data-role="pixel-detail"]'),
          resultCaption: result.querySelector('[data-role="result-caption"]'),
          zoomOutput: result.querySelector('[data-role="zoom"]'),
        };

        const initialize = () => {
          const buffer = document.createElement("canvas");
          buffer.width = dataset.width;
          buffer.height = dataset.height;
          const bufferContext = buffer.getContext("2d");
          bufferContext.drawImage(source, 0, 0);
          state.sourcePixels = bufferContext.getImageData(0, 0, dataset.width, dataset.height);
          canvas.width = dataset.width;
          canvas.height = dataset.height;
          state.initialized = true;
          updateFitScale(state);
          drawResult(state);
          renderView(state);
        };
        if (source.complete && source.naturalWidth > 0) initialize();
        else source.addEventListener("load", initialize, { once: true });

        slider.addEventListener("input", () => {
          state.threshold = Number(slider.value);
          if (state.initialized) drawResult(state);
        });
        result.querySelectorAll("[data-threshold-step]").forEach((button) => {
          let repeatDelay = null;
          let repeatTimer = null;
          const applyStep = () => {
            if (!state.initialized) return;
            state.threshold = Math.round((state.threshold + Number(button.dataset.thresholdStep)) * 1_000_000) / 1_000_000;
            slider.value = String(clamp(state.threshold, Number(slider.min), Number(slider.max)));
            drawResult(state);
          };
          const stopRepeating = () => {
            if (repeatDelay !== null) clearTimeout(repeatDelay);
            if (repeatTimer !== null) clearInterval(repeatTimer);
            repeatDelay = null;
            repeatTimer = null;
          };
          button.addEventListener("pointerdown", (event) => {
            if (event.button !== 0 || !state.initialized) return;
            stopRepeating();
            applyStep();
            button.setPointerCapture(event.pointerId);
            repeatDelay = setTimeout(() => {
              applyStep();
              repeatTimer = setInterval(applyStep, 75);
            }, 350);
          });
          button.addEventListener("pointerup", stopRepeating);
          button.addEventListener("pointercancel", stopRepeating);
          button.addEventListener("lostpointercapture", stopRepeating);
          button.addEventListener("click", (event) => {
            if (event.detail === 0) applyStep();
          });
        });
        result.querySelectorAll(".mode-control button").forEach((button) => {
          button.addEventListener("click", () => {
            if (!state.initialized) return;
            state.mode = button.dataset.mode;
            result.querySelectorAll(".mode-control button").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
            state.resultCaption.textContent = state.mode === "mask"
              ? "背景分类 · 白色 = 背景，深色 = 前景"
              : state.mode === "remove-background"
                ? "背景分类 · 已去除背景"
                : "背景分类 · 已去除前景";
            drawResult(state);
          });
        });

        result.querySelectorAll("[data-view-action]").forEach((button) => {
          button.addEventListener("click", () => {
            if (!state.initialized) return;
            if (button.dataset.viewAction === "fit") {
              state.zoom = 1;
              state.panX = 0;
              state.panY = 0;
              renderView(state);
            } else if (button.dataset.viewAction === "actual") {
              state.zoom = clamp(1 / state.fitScale, 0.25, 32);
              state.panX = 0;
              state.panY = 0;
              renderView(state);
            } else {
              setZoom(state, state.zoom * (button.dataset.viewAction === "zoom-in" ? 1.4 : 1 / 1.4));
            }
          });
        });

        viewports.forEach((viewport, mediaIndex) => {
          let drag = null;
          viewport.addEventListener("wheel", (event) => {
            if (!state.initialized) return;
            event.preventDefault();
            setZoom(state, state.zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), {
              viewport,
              index: mediaIndex,
              clientX: event.clientX,
              clientY: event.clientY,
            });
          }, { passive: false });
          viewport.addEventListener("pointerdown", (event) => {
            if (!state.initialized || event.button !== 0) return;
            drag = {
              pointerId: event.pointerId,
              clientX: event.clientX,
              clientY: event.clientY,
              panX: state.panX,
              panY: state.panY,
              moved: false,
            };
            viewport.setPointerCapture(event.pointerId);
          });
          viewport.addEventListener("pointermove", (event) => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            const deltaX = event.clientX - drag.clientX;
            const deltaY = event.clientY - drag.clientY;
            if (!drag.moved && Math.hypot(deltaX, deltaY) < 3) return;
            drag.moved = true;
            viewport.classList.add("is-dragging");
            state.panX = drag.panX + deltaX;
            state.panY = drag.panY + deltaY;
            renderView(state);
          });
          const finishPointer = (event) => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            if (!drag.moved) {
              const pixel = getPixelAtPoint(state, mediaIndex, event.clientX, event.clientY);
              if (pixel) {
                state.selectedPixel = pixel;
                updatePixelDetail(state);
                updatePixelMarkers(state);
              }
            }
            viewport.classList.remove("is-dragging");
            drag = null;
          };
          viewport.addEventListener("pointerup", finishPointer);
          viewport.addEventListener("pointercancel", () => {
            viewport.classList.remove("is-dragging");
            drag = null;
          });
        });

        const resizeObserver = new ResizeObserver(() => {
          if (!state.initialized) return;
          updateFitScale(state);
          renderView(state);
        });
        viewports.forEach((viewport) => resizeObserver.observe(viewport));
      });
    })();
  </script>
</body>
</html>`;
}

async function openReport(reportFilePath) {
  const commands = {
    darwin: ["open", [reportFilePath]],
    linux: ["xdg-open", [reportFilePath]],
    win32: ["cmd.exe", ["/d", "/s", "/c", "start", "", reportFilePath]],
  };
  const command = commands[process.platform];
  if (!command) throw new Error(`不支持自动打开报告的平台：${process.platform}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command[0], command[1], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

async function main() {
  const { backgroundColor, initialThreshold, inputDirectory, localColorThreshold, loose, shouldOpen, strict } = parseArguments(process.argv.slice(2));
  await mkdir(inputDirectory, { recursive: true });
  const pngFiles = await collectPngFiles(inputDirectory);
  if (pngFiles.length === 0) {
    console.error("没有找到 PNG 图片。");
    console.error(`请把测试图片放入：${inputDirectory}`);
    process.exitCode = 1;
    return;
  }

  const backgroundHex = colorToHex(backgroundColor);
  const results = [];
  const errors = [];
  console.log(`输入目录：${inputDirectory}`);
  console.log(`背景颜色：${backgroundHex}`);
  console.log(`strict：${strict}`);
  console.log(`loose：${loose}`);
  console.log(`初始阈值：${initialThreshold}`);
  console.log(`近似颜色阈值：${localColorThreshold}`);
  console.log("");

  for (const filePath of pngFiles) {
    const relativePath = path.relative(inputDirectory, filePath);
    try {
      const fileData = await readFile(filePath);
      const png = PNG.sync.read(fileData);
      const image = { width: png.width, height: png.height, data: new Uint8ClampedArray(png.data) };
      const merged = mergeLocalColorIslands(image, localColorThreshold);
      const defaultThreshold = initialThreshold;
      const maskResult = generateBackgroundMask(merged.image, backgroundColor, defaultThreshold);
      const initialBackgroundCount = maskResult.backgroundMask.reduce((sum, value) => sum + value, 0);
      const transparentCount = image.data.reduce((sum, value, index) => index % 4 === 3 && value === 0 ? sum + 1 : sum, 0);
      const pixelCount = image.width * image.height - transparentCount;
      results.push({
        relativePath,
        width: image.width,
        height: image.height,
        strict,
        loose,
        defaultThreshold,
        initialBackgroundCount,
        pixelCount,
        encodedDistances: encodeDistances(maskResult.distances),
        dataUrl: `data:image/png;base64,${fileData.toString("base64")}`,
      });
      console.log(relativePath);
      console.log(`  strict: ${strict.toFixed(6)}`);
      console.log(`  loose:  ${loose.toFixed(6)}`);
      console.log(`  默认阈值: ${defaultThreshold.toFixed(6)}`);
      console.log(`  背景像素: ${initialBackgroundCount} / ${pixelCount}`);
      console.log(`  岛屿: ${merged.stats.islandCount}，替换像素: ${merged.stats.replacedPixelCount}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ relativePath, message });
      console.error(relativePath);
      console.error(`  错误: ${message}`);
    }
    console.log("");
  }

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(reportPath, createReport(results, errors, inputDirectory, backgroundColor), "utf8");
  console.log(`背景蒙版面板：${reportPath}`);
  if (shouldOpen) {
    await openReport(reportPath);
    console.log("已打开背景蒙版分类测试窗口。");
  }
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
