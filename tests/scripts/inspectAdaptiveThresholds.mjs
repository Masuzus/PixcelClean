import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { getAdaptiveBackgroundThresholds } from "../../src/algorithms/adaptiveBackgroundThresholds.ts";
import { rgbToOklab } from "../../src/algorithms/colorSpace.ts";
import { collectOklabDistanceDistribution } from "../../src/algorithms/oklabDistanceDistribution.ts";
import {
  defaultLocalColorSimilarityThreshold,
  mergeLocalColorIslands,
} from "../../src/algorithms/localColorIslands.ts";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const inputDirectory = path.join(projectRoot, "tests/input/images");
const outputDirectory = path.join(projectRoot, "test-results");
const reportPath = path.join(outputDirectory, "adaptive-thresholds-report.html");
const distributionResolution = 0.0001;
const initialBinWidth = 0.001;

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
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  if (!backgroundColor) {
    throw new Error("缺少背景颜色。请添加 --background \"#1C1523\"。");
  }
  return { backgroundColor, inputDirectory, localColorThreshold, shouldOpen };
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

function createResultMarkup(result, index) {
  const safeName = escapeHtml(result.relativePath);
  const scaleMaximum = Math.max(0.12, result.loose * 1.25);
  const strictPosition = result.strict / scaleMaximum * 100;
  const loosePosition = result.loose / scaleMaximum * 100;
  return `
    <article class="result">
      <header>
        <h2>${safeName}</h2>
        <span>${result.width} x ${result.height}</span>
      </header>
      <div class="result-layout">
        <figure>
          <img alt="${safeName}" src="${result.dataUrl}">
          <figcaption>测试图片</figcaption>
        </figure>
        <section class="thresholds" aria-label="${safeName} 的自适应双阈值">
          <dl>
            <div><dt>strict 严格阈值</dt><dd><code>${result.strict.toFixed(6)}</code></dd></div>
            <div><dt>loose 宽松阈值</dt><dd><code>${result.loose.toFixed(6)}</code></dd></div>
          </dl>
          <div class="track" role="img" aria-label="strict ${result.strict.toFixed(6)}，loose ${result.loose.toFixed(6)}，刻度上限 ${scaleMaximum.toFixed(3)}">
            <div class="strict-range" style="width:${strictPosition.toFixed(3)}%"></div>
            <div class="loose-range" style="width:${(loosePosition - strictPosition).toFixed(3)}%"></div>
            <div class="foreground-range"></div>
          </div>
          <div class="track-labels"><span>0</span><span>刻度上限 ${scaleMaximum.toFixed(3)}</span></div>
          <div class="legend">
            <span><i class="strict-dot"></i>高可信背景</span>
            <span><i class="loose-dot"></i>疑似背景</span>
            <span><i class="foreground-dot"></i>前景</span>
          </div>
        </section>
      </div>
      <section class="distribution" aria-label="${safeName} 的全图方向加权 OKLCH 距离分布">
        <div class="distribution-stats">
          <span>统计像素 <strong>${result.distribution.pixelCount.toLocaleString("zh-CN")}</strong></span>
          <span>距离范围 <strong>${result.distribution.minimumDistance.toFixed(6)} - ${result.distribution.maximumDistance.toFixed(6)}</strong></span>
          <span>峰值区间 <strong data-role="peak-range">-</strong></span>
          <span>峰值数量 <strong data-role="peak-count">-</strong></span>
        </div>
        <div class="chart-toolbar">
          <span>可见范围 <strong data-role="view-range">-</strong></span>
          <div>
            <button aria-label="缩小分布图" data-action="zoom-out" type="button">−</button>
            <button aria-label="放大分布图" data-action="zoom-in" type="button">+</button>
            <button data-action="reset" type="button">重置</button>
          </div>
        </div>
        <div class="chart-wrap">
          <canvas class="histogram" data-index="${index}" height="430" width="1000" role="img" aria-label="全图像素到背景代表色的方向加权 OKLCH 距离直方图，标有 strict 和 loose"></canvas>
          <div class="chart-tooltip" hidden></div>
        </div>
      </section>
    </article>`;
}

function createErrorMarkup(error) {
  return `<article class="result error"><h2>${escapeHtml(error.relativePath)}</h2><p>${escapeHtml(error.message)}</p></article>`;
}

function createReport(results, errors, inputDirectory, backgroundColor) {
  const backgroundHex = colorToHex(backgroundColor);
  const textColor = getSwatchTextColor(backgroundColor);
  const generatedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date());
  const clientData = JSON.stringify(results.map((result) => ({
    counts: result.distribution.counts,
    maximumDistance: result.distribution.maximumDistance,
    resolution: result.distribution.resolution,
    strict: result.strict,
    loose: result.loose,
  }))).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>自适应双阈值测试结果</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, "Microsoft YaHei", system-ui, sans-serif; color: #202124; background: #F5F6F7; --chart-text: #263238; --chart-muted: #62676D; --chart-grid: #DCE1E4; --chart-bar: #638F80; --chart-active: #C98719; --chart-strict: #2563EB; --chart-loose: #B06E00; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; font-weight: 600; }
    h2 { overflow-wrap: anywhere; font-size: 15px; font-weight: 600; }
    .summary { display: flex; justify-content: space-between; align-items: end; gap: 20px; margin-bottom: 24px; }
    .summary-copy { display: grid; gap: 5px; }
    .summary p, header span, figcaption, dt, .track-labels { color: #62676D; font-size: 13px; }
    .inputs { display: flex; align-items: end; gap: 14px; }
    .input-value { display: grid; gap: 5px; }
    .input-value > span { color: #62676D; font-size: 12px; }
    .input-value input { width: 148px; height: 56px; padding: 0 11px; color: #202124; background: #FFFFFF; border: 1px solid #D6D9DC; border-radius: 6px; font-family: Consolas, monospace; font-size: 15px; }
    .input-value input:invalid { border-color: #B3261E; }
    .swatch { display: grid; place-items: center; width: 128px; height: 56px; color: var(--swatch-text); background: var(--swatch-color); border: 1px solid #D6D9DC; border-radius: 6px; font-family: Consolas, monospace; font-weight: 600; }
    .results { display: grid; gap: 16px; }
    .result { padding: 16px; border: 1px solid #D6D9DC; border-radius: 8px; background: #FFFFFF; }
    .result header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 14px; }
    .result-layout { display: grid; grid-template-columns: minmax(180px, 280px) minmax(0, 1fr); gap: 22px; align-items: center; }
    figure { display: grid; gap: 6px; min-width: 0; margin: 0; }
    figure img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background: #ECEFF1; border: 1px solid #D6D9DC; border-radius: 6px; image-rendering: pixelated; }
    .thresholds { min-width: 0; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 0 0 24px; }
    dl div { min-width: 0; padding-bottom: 10px; border-bottom: 1px solid #E2E4E7; }
    dt { margin-bottom: 4px; }
    dd { margin: 0; overflow-wrap: anywhere; font-size: 22px; }
    .track { display: flex; height: 30px; overflow: hidden; border: 1px solid #9FA8AC; border-radius: 5px; }
    .strict-range { background: #70B99B; }
    .loose-range { background: #E8C968; }
    .foreground-range { flex: 1; background: #DF8179; }
    .track-labels { display: flex; justify-content: space-between; margin-top: 5px; }
    .legend { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 14px; color: #4D585D; font-size: 12px; }
    .legend span { display: inline-flex; align-items: center; gap: 6px; }
    .legend i { width: 10px; height: 10px; border-radius: 2px; }
    .strict-dot { background: #70B99B; } .loose-dot { background: #E8C968; } .foreground-dot { background: #DF8179; }
    .distribution { margin-top: 20px; padding-top: 16px; border-top: 1px solid #E2E4E7; }
    .distribution-stats { display: flex; flex-wrap: wrap; gap: 20px; color: #62676D; font-size: 12px; }
    .distribution-stats strong { color: #202124; font-family: Consolas, monospace; }
    .chart-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 36px; margin-top: 8px; color: #62676D; font-size: 12px; }
    .chart-toolbar strong { color: #202124; font-family: Consolas, monospace; }
    .chart-toolbar > div { display: flex; gap: 6px; }
    .chart-toolbar button { min-width: 34px; height: 30px; padding: 0 9px; color: #30383C; background: #FFFFFF; border: 1px solid #AEB7BB; border-radius: 5px; cursor: pointer; }
    .chart-toolbar button:hover { border-color: #247354; background: #EEF7F3; }
    .chart-wrap { position: relative; margin-top: 6px; }
    .histogram { display: block; width: 100%; height: auto; aspect-ratio: 1000 / 430; cursor: grab; touch-action: none; }
    .histogram.is-dragging { cursor: grabbing; }
    .chart-tooltip { position: absolute; z-index: 2; max-width: 250px; padding: 7px 9px; color: #FFFFFF; background: #263238; border-radius: 4px; pointer-events: none; font-family: Consolas, monospace; font-size: 12px; white-space: nowrap; }
    .error { border-color: #D84A4A; } .error p { margin-top: 8px; color: #B3261E; }
    @media (prefers-color-scheme: dark) {
      :root { color: #E8EAED; background: #17191C; --chart-text: #DDE3E7; --chart-muted: #AEB4BA; --chart-grid: #3A4247; --chart-bar: #6EA894; --chart-active: #E8C968; --chart-strict: #75A7FF; --chart-loose: #F2CD63; }
      .summary p, header span, figcaption, dt, .track-labels, .legend, .input-value > span, .distribution-stats, .chart-toolbar { color: #AEB4BA; }
      .result { border-color: #454A50; background: #22252A; }
      .swatch, .input-value input, figure img { border-color: #454A50; }
      .input-value input { color: #E8EAED; background: #22252A; }
      figure img { background: #111315; }
      dl div, .distribution { border-color: #3A3E43; }
      .distribution-stats strong, .chart-toolbar strong { color: #E8EAED; }
      .chart-toolbar button { color: #DDE3E7; background: #22282B; border-color: #59646A; }
      .chart-toolbar button:hover { background: #2B3539; border-color: #78D6AF; }
      .error p { color: #FF8A80; }
    }
    @media (max-width: 700px) {
      .summary { align-items: start; flex-direction: column; }
      .result-layout { grid-template-columns: 1fr; }
      figure { width: min(100%, 320px); }
    }
  </style>
</head>
<body>
  <main>
    <section class="summary">
      <div class="summary-copy">
        <h1>自适应双阈值测试结果</h1>
        <p>${results.length} 张图片 · ${escapeHtml(generatedAt)}</p>
        <p>输入目录：<code>${escapeHtml(inputDirectory)}</code></p>
        <p>距离模型：<code>sqrt((0.5ΔL)² + (2ΔC)² + (2ΔH)²)</code></p>
      </div>
      <div class="inputs">
        <div class="input-value"><span>输入背景色</span><div class="swatch" style="--swatch-color:${backgroundHex};--swatch-text:${textColor}" role="img" aria-label="输入背景色 ${backgroundHex}">${backgroundHex}</div></div>
        <label class="input-value" for="bin-width-control"><span>分布区间宽度</span><input id="bin-width-control" min="${distributionResolution}" step="${distributionResolution}" type="number" value="${initialBinWidth}"></label>
      </div>
    </section>
    <section class="results" aria-label="自适应双阈值结果列表">
      ${results.map(createResultMarkup).join("\n")}
      ${errors.map(createErrorMarkup).join("\n")}
    </section>
  </main>
  <script id="distribution-data" type="application/json">${clientData}</script>
  <script>
    (() => {
      const datasets = JSON.parse(document.getElementById("distribution-data").textContent);
      const input = document.getElementById("bin-width-control");
      const canvases = Array.from(document.querySelectorAll("canvas.histogram"));
      const countFormatter = new Intl.NumberFormat("zh-CN");
      const chartMargin = { top: 48, right: 22, bottom: 68, left: 82 };

      function formatDistance(value, width) {
        const decimals = Math.min(6, Math.max(3, Math.ceil(-Math.log10(width)) + 1));
        return value.toFixed(decimals);
      }

      function createBins(dataset, width) {
        const counts = [];
        for (let baseIndex = 0; baseIndex < dataset.counts.length; baseIndex += 1) {
          const count = dataset.counts[baseIndex];
          if (count === 0) continue;
          const binIndex = Math.floor(baseIndex * dataset.resolution / width);
          counts[binIndex] = (counts[binIndex] || 0) + count;
        }
        const maximumIndex = Math.max(0, counts.length - 1, Math.floor(dataset.maximumDistance / width));
        return Array.from({ length: maximumIndex + 1 }, (_, index) => ({
          start: index * width,
          end: (index + 1) * width,
          count: counts[index] || 0,
        }));
      }

      function getColors() {
        const style = getComputedStyle(document.documentElement);
        return {
          text: style.getPropertyValue("--chart-text").trim(),
          muted: style.getPropertyValue("--chart-muted").trim(),
          grid: style.getPropertyValue("--chart-grid").trim(),
          bar: style.getPropertyValue("--chart-bar").trim(),
          active: style.getPropertyValue("--chart-active").trim(),
          strict: style.getPropertyValue("--chart-strict").trim(),
          loose: style.getPropertyValue("--chart-loose").trim(),
        };
      }

      function drawChart(canvas, activeIndex = -1) {
        const bins = canvas._bins;
        const width = canvas._binWidth;
        const dataset = canvas._dataset;
        const context = canvas.getContext("2d");
        const colors = getColors();
        const plotWidth = canvas.width - chartMargin.left - chartMargin.right;
        const plotHeight = canvas.height - chartMargin.top - chartMargin.bottom;
        const viewStart = canvas._viewStart;
        const viewSpan = canvas._viewSpan;
        const viewEnd = viewStart + viewSpan;
        const maximumCount = canvas._maximumCount;
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.font = "12px Inter, Microsoft YaHei, system-ui, sans-serif";
        context.textBaseline = "middle";

        context.strokeStyle = colors.grid;
        context.fillStyle = colors.muted;
        context.textAlign = "right";
        for (let index = 0; index < 5; index += 1) {
          const ratio = index / 4;
          const y = chartMargin.top + plotHeight * (1 - ratio);
          context.beginPath();
          context.moveTo(chartMargin.left, y);
          context.lineTo(canvas.width - chartMargin.right, y);
          context.stroke();
          context.fillText(countFormatter.format(Math.round(maximumCount * ratio)), chartMargin.left - 10, y);
        }

        for (let index = 0; index < bins.length; index += 1) {
          const bin = bins[index];
          if (bin.count === 0 || bin.end <= viewStart || bin.start >= viewEnd) continue;
          const barHeight = Math.max(1, bin.count / maximumCount * plotHeight);
          const x = chartMargin.left + (bin.start - viewStart) / viewSpan * plotWidth;
          const nextX = chartMargin.left + (bin.end - viewStart) / viewSpan * plotWidth;
          context.fillStyle = index === activeIndex ? colors.active : colors.bar;
          context.fillRect(x, chartMargin.top + plotHeight - barHeight, Math.max(0.5, nextX - x - Math.min(1, (nextX - x) * 0.12)), barHeight);
        }

        context.strokeStyle = colors.text;
        context.lineWidth = 1.2;
        context.beginPath();
        context.moveTo(chartMargin.left, chartMargin.top);
        context.lineTo(chartMargin.left, chartMargin.top + plotHeight);
        context.lineTo(canvas.width - chartMargin.right, chartMargin.top + plotHeight);
        context.stroke();

        context.fillStyle = colors.muted;
        context.textAlign = "center";
        for (let index = 0; index < 6; index += 1) {
          const ratio = index / 5;
          const x = chartMargin.left + plotWidth * ratio;
          context.beginPath();
          context.moveTo(x, chartMargin.top + plotHeight);
          context.lineTo(x, chartMargin.top + plotHeight + 6);
          context.stroke();
          context.fillText(formatDistance(viewStart + viewSpan * ratio, width), x, chartMargin.top + plotHeight + 24);
        }

        const drawThreshold = (value, color, label, labelY) => {
          if (value < viewStart || value > viewEnd) return;
          const x = chartMargin.left + (value - viewStart) / viewSpan * plotWidth;
          context.save();
          context.strokeStyle = color;
          context.lineWidth = 1;
          context.setLineDash([4, 4]);
          context.beginPath();
          context.moveTo(x, chartMargin.top);
          context.lineTo(x, chartMargin.top + plotHeight);
          context.stroke();
          context.restore();
          context.fillStyle = color;
          context.textAlign = "left";
          context.font = "600 12px Consolas, monospace";
          context.fillText(label + " " + value.toFixed(6), Math.min(x + 4, canvas.width - chartMargin.right - 110), labelY);
        };
        drawThreshold(dataset.strict, colors.strict, "strict", 14);
        drawThreshold(dataset.loose, colors.loose, "loose", 32);

        context.fillStyle = colors.text;
        context.font = "600 13px Inter, Microsoft YaHei, system-ui, sans-serif";
        context.textAlign = "center";
        context.fillText("与背景代表色的方向加权 OKLCH 距离", chartMargin.left + plotWidth / 2, canvas.height - 12);
        context.save();
        context.translate(18, chartMargin.top + plotHeight / 2);
        context.rotate(-Math.PI / 2);
        context.fillText("像素数量", 0, 0);
        context.restore();
      }

      function updateViewControls(canvas) {
        const result = canvas.closest(".result");
        const end = canvas._viewStart + canvas._viewSpan;
        result.querySelector('[data-role="view-range"]').textContent = formatDistance(canvas._viewStart, canvas._binWidth) + " - " + formatDistance(end, canvas._binWidth);
        const minimumSpan = Math.max(canvas._binWidth * 8, canvas._dataset.resolution * 10);
        result.querySelector('[data-action="zoom-in"]').disabled = canvas._viewSpan <= minimumSpan * 1.001;
        result.querySelector('[data-action="zoom-out"]').disabled = canvas._viewSpan >= canvas._maximumDistance * 0.999;
      }

      function redraw(canvas, activeIndex = -1) {
        drawChart(canvas, activeIndex);
        updateViewControls(canvas);
      }

      function setView(canvas, start, span) {
        const minimumSpan = Math.max(canvas._binWidth * 8, canvas._dataset.resolution * 10);
        const nextSpan = Math.min(canvas._maximumDistance, Math.max(minimumSpan, span));
        canvas._viewSpan = nextSpan;
        canvas._viewStart = Math.min(canvas._maximumDistance - nextSpan, Math.max(0, start));
        redraw(canvas);
      }

      function zoomCanvas(canvas, factor) {
        const anchorRatio = factor < 1 && canvas._viewStart === 0 ? 0 : 0.5;
        const anchor = canvas._viewStart + canvas._viewSpan * anchorRatio;
        const nextSpan = canvas._viewSpan * factor;
        setView(canvas, anchor - nextSpan * anchorRatio, nextSpan);
      }

      function updateChart(canvas, width) {
        const dataset = datasets[Number(canvas.dataset.index)];
        const bins = createBins(dataset, width);
        canvas._bins = bins;
        canvas._binWidth = width;
        canvas._dataset = dataset;
        canvas._maximumCount = Math.max(1, ...bins.map((bin) => bin.count));
        canvas._maximumDistance = Math.max(width, bins[bins.length - 1].end);
        if (canvas._viewStart === undefined) {
          canvas._viewStart = 0;
          canvas._viewSpan = canvas._maximumDistance;
        } else {
          canvas._viewSpan = Math.min(canvas._viewSpan, canvas._maximumDistance);
          canvas._viewStart = Math.min(canvas._viewStart, canvas._maximumDistance - canvas._viewSpan);
        }
        redraw(canvas);
        const peak = bins.reduce((best, bin) => bin.count > best.count ? bin : best, bins[0]);
        const result = canvas.closest(".result");
        result.querySelector('[data-role="peak-range"]').textContent = "[" + formatDistance(peak.start, width) + ", " + formatDistance(peak.end, width) + ")";
        result.querySelector('[data-role="peak-count"]').textContent = countFormatter.format(peak.count);
      }

      function updateAll() {
        const width = Number(input.value);
        const minimum = Number(input.min);
        const valid = Number.isFinite(width) && width >= minimum;
        input.setCustomValidity(valid ? "" : "区间宽度不能小于 " + minimum);
        if (!valid) return;
        canvases.forEach((canvas) => updateChart(canvas, width));
      }

      canvases.forEach((canvas) => {
        const wrapper = canvas.closest(".chart-wrap");
        const tooltip = wrapper.querySelector(".chart-tooltip");
        const result = canvas.closest(".result");
        result.querySelector('[data-action="zoom-in"]').addEventListener("click", () => zoomCanvas(canvas, 0.5));
        result.querySelector('[data-action="zoom-out"]').addEventListener("click", () => zoomCanvas(canvas, 2));
        result.querySelector('[data-action="reset"]').addEventListener("click", () => setView(canvas, 0, canvas._maximumDistance));
        canvas.addEventListener("pointerdown", (event) => {
          canvas._dragging = true;
          canvas._dragPointerId = event.pointerId;
          canvas._dragStartX = event.clientX;
          canvas._dragViewStart = canvas._viewStart;
          canvas.classList.add("is-dragging");
          canvas.setPointerCapture(event.pointerId);
          tooltip.hidden = true;
        });
        canvas.addEventListener("pointermove", (event) => {
          const rect = canvas.getBoundingClientRect();
          const canvasX = (event.clientX - rect.left) * canvas.width / rect.width;
          const plotWidth = canvas.width - chartMargin.left - chartMargin.right;
          if (canvas._dragging) {
            const deltaCanvasX = (event.clientX - canvas._dragStartX) * canvas.width / rect.width;
            const distanceDelta = -deltaCanvasX / plotWidth * canvas._viewSpan;
            const nextStart = Math.min(canvas._maximumDistance - canvas._viewSpan, Math.max(0, canvas._dragViewStart + distanceDelta));
            canvas._viewStart = nextStart;
            redraw(canvas);
            return;
          }
          const ratio = (canvasX - chartMargin.left) / plotWidth;
          const distance = canvas._viewStart + ratio * canvas._viewSpan;
          const index = Math.floor(distance / canvas._binWidth);
          if (index < 0 || index >= canvas._bins.length) {
            tooltip.hidden = true;
            redraw(canvas);
            return;
          }
          const bin = canvas._bins[index];
          redraw(canvas, index);
          tooltip.textContent = "[" + formatDistance(bin.start, canvas._binWidth) + ", " + formatDistance(bin.end, canvas._binWidth) + ")：" + countFormatter.format(bin.count);
          tooltip.hidden = false;
          const localX = event.clientX - rect.left;
          const localY = event.clientY - rect.top;
          tooltip.style.left = Math.min(wrapper.clientWidth - tooltip.offsetWidth - 8, Math.max(8, localX + 12)) + "px";
          tooltip.style.top = Math.max(8, localY - tooltip.offsetHeight - 8) + "px";
        });
        const stopDragging = (event) => {
          if (!canvas._dragging || event.pointerId !== canvas._dragPointerId) return;
          canvas._dragging = false;
          canvas.classList.remove("is-dragging");
          if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
        };
        canvas.addEventListener("pointerup", stopDragging);
        canvas.addEventListener("pointercancel", stopDragging);
        canvas.addEventListener("pointerleave", () => {
          tooltip.hidden = true;
          if (!canvas._dragging) redraw(canvas);
        });
      });

      input.addEventListener("input", updateAll);
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateAll);
      updateAll();
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
  const { backgroundColor, inputDirectory, localColorThreshold, shouldOpen } = parseArguments(process.argv.slice(2));
  await mkdir(inputDirectory, { recursive: true });
  const pngFiles = await collectPngFiles(inputDirectory);
  if (pngFiles.length === 0) {
    console.error("没有找到 PNG 图片。");
    console.error(`请把测试图片放入：${inputDirectory}`);
    process.exitCode = 1;
    return;
  }

  const backgroundHex = colorToHex(backgroundColor);
  const backgroundLab = rgbToOklab(...backgroundColor);
  const results = [];
  const errors = [];
  console.log(`输入目录：${inputDirectory}`);
  console.log(`背景颜色：${backgroundHex}`);
  console.log(`近似颜色阈值：${localColorThreshold}`);
  console.log("");

  for (const filePath of pngFiles) {
    const relativePath = path.relative(inputDirectory, filePath);
    try {
      const fileData = await readFile(filePath);
      const png = PNG.sync.read(fileData);
      const image = {
        width: png.width,
        height: png.height,
        data: new Uint8ClampedArray(png.data),
      };
      const merged = mergeLocalColorIslands(image, localColorThreshold);
      const thresholds = getAdaptiveBackgroundThresholds(merged.image, backgroundLab);
      const distribution = collectOklabDistanceDistribution(merged.image, backgroundLab, distributionResolution);
      results.push({
        relativePath,
        width: png.width,
        height: png.height,
        strict: thresholds.strict,
        loose: thresholds.loose,
        distribution,
        dataUrl: `data:image/png;base64,${fileData.toString("base64")}`,
      });
      console.log(relativePath);
      console.log(`  strict: ${thresholds.strict.toFixed(6)}`);
      console.log(`  loose:  ${thresholds.loose.toFixed(6)}`);
      console.log(`  统计像素: ${distribution.pixelCount}`);
      console.log(`  距离范围: ${distribution.minimumDistance.toFixed(6)} - ${distribution.maximumDistance.toFixed(6)}`);
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
  console.log(`可视化报告：${reportPath}`);
  if (shouldOpen) {
    await openReport(reportPath);
    console.log("已打开自适应双阈值结果窗口。");
  }
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
