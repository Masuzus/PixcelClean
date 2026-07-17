import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import {
  binOklabDistanceDistribution,
  collectOklabDistanceDistribution,
} from "../../src/algorithms/oklabDistanceDistribution.ts";
import { rgbToOklab } from "../../src/algorithms/colorSpace.ts";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const inputDirectory = path.join(projectRoot, "tests/input/images");
const outputDirectory = path.join(projectRoot, "test-results");
const reportPath = path.join(outputDirectory, "oklab-distance-distribution-report.html");
const csvPath = path.join(outputDirectory, "oklab-distance-distribution.csv");
const distributionResolution = 0.0001;

function parseBackgroundColor(value) {
  const match = /^#?([0-9a-f]{6})$/i.exec(value ?? "");
  if (!match) throw new Error("--background 需要 6 位 Hex 颜色，例如 #1C1523。");
  return [
    Number.parseInt(match[1].slice(0, 2), 16),
    Number.parseInt(match[1].slice(2, 4), 16),
    Number.parseInt(match[1].slice(4, 6), 16),
  ];
}

function parsePositiveNumber(value, optionName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${optionName} 需要大于 0 的数值。`);
  }
  return number;
}

function parseArguments(argumentsList) {
  let backgroundColor = null;
  let binWidth = 0.005;
  let shouldOpen = true;

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--no-open") {
      shouldOpen = false;
    } else if (argument === "--background") {
      backgroundColor = parseBackgroundColor(argumentsList[index + 1]);
      index += 1;
    } else if (argument === "--bin-width") {
      binWidth = parsePositiveNumber(argumentsList[index + 1], "--bin-width");
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  if (!backgroundColor) throw new Error("缺少背景颜色。请添加 --background \"#1C1523\"。");
  if (binWidth < distributionResolution) {
    throw new Error(`--bin-width 不能小于统计精度 ${distributionResolution}。`);
  }
  return { backgroundColor, binWidth, inputDirectory, shouldOpen };
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

function formatDistance(value, binWidth) {
  const decimals = Math.min(6, Math.max(3, Math.ceil(-Math.log10(binWidth)) + 1));
  return value.toFixed(decimals);
}

function formatCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Math.round(value));
}

function createResultMarkup(result, binWidth, index) {
  const safeName = escapeHtml(result.relativePath);
  const peakBin = result.bins.reduce((peak, bin) => bin.count > peak.count ? bin : peak, result.bins[0]);
  return `<article class="result">
    <header><h2>${safeName}</h2><span>${result.width} x ${result.height}</span></header>
    <div class="result-grid">
      <figure>
        <img alt="${safeName}" src="${result.dataUrl}">
        <figcaption>测试图片</figcaption>
      </figure>
      <section class="distribution">
        <dl>
          <div><dt>统计像素</dt><dd>${formatCount(result.distribution.pixelCount)}</dd></div>
          <div><dt>透明像素（未统计）</dt><dd>${formatCount(result.distribution.transparentPixelCount)}</dd></div>
          <div><dt>最小距离</dt><dd>${result.distribution.minimumDistance.toFixed(6)}</dd></div>
          <div><dt>最大距离</dt><dd>${result.distribution.maximumDistance.toFixed(6)}</dd></div>
          <div><dt>峰值区间</dt><dd data-role="peak-range">[${formatDistance(peakBin.start, binWidth)}, ${formatDistance(peakBin.end, binWidth)})</dd></div>
          <div><dt>峰值数量</dt><dd data-role="peak-count">${formatCount(peakBin.count)}</dd></div>
        </dl>
        <div class="chart-wrap">
          <canvas class="histogram" data-index="${index}" height="430" width="1000" role="img" aria-label="${safeName} 的全图 OKLab 距离分布；X 轴为与背景代表色的 OKLab 距离，Y 轴为像素数量"></canvas>
          <div class="chart-tooltip" hidden></div>
        </div>
      </section>
    </div>
  </article>`;
}

function createErrorMarkup(error) {
  return `<article class="result error"><h2>${escapeHtml(error.relativePath)}</h2><p>${escapeHtml(error.message)}</p></article>`;
}

function createReport(results, errors, inputDirectory, backgroundColor, binWidth) {
  const backgroundHex = colorToHex(backgroundColor);
  const swatchTextColor = getSwatchTextColor(backgroundColor);
  const generatedAt = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date());
  const clientData = JSON.stringify(results.map((result) => ({
    resolution: result.distribution.resolution,
    counts: result.distribution.counts,
    maximumDistance: result.distribution.maximumDistance,
  }))).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>全图 OKLab 距离分布</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, "Microsoft YaHei", system-ui, sans-serif; color: #202124; background: #F5F6F7; --chart-text: #263238; --chart-muted: #62676D; --chart-grid: #DCE1E4; --chart-bar: #2C8A67; --chart-active: #D59B2D; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1380px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; font-weight: 600; }
    h2 { overflow-wrap: anywhere; font-size: 15px; font-weight: 600; }
    .summary { display: flex; justify-content: space-between; align-items: end; gap: 22px; margin-bottom: 24px; }
    .summary-copy { display: grid; gap: 5px; }
    .summary p, header span, figcaption, dt { color: #62676D; font-size: 13px; }
    .inputs { display: flex; align-items: end; gap: 14px; }
    .input-value { display: grid; gap: 5px; }
    .input-value span { color: #62676D; font-size: 12px; }
    .input-value strong, .input-value input { min-width: 128px; height: 52px; padding: 0 12px; border: 1px solid #D6D9DC; border-radius: 6px; font-family: Consolas, monospace; font-size: 15px; }
    .input-value strong { display: grid; place-items: center; }
    .input-value input { width: 150px; color: #202124; background: #FFFFFF; }
    .input-value input:invalid { border-color: #B3261E; }
    .swatch { color: var(--swatch-text); background: var(--swatch-color); }
    .results { display: grid; gap: 18px; }
    .result { padding: 16px; border: 1px solid #D6D9DC; border-radius: 8px; background: #FFFFFF; }
    .result header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 14px; }
    .result-grid { display: grid; grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); gap: 24px; align-items: start; }
    figure { display: grid; gap: 6px; min-width: 0; margin: 0; }
    figure img { display: block; width: 100%; aspect-ratio: 1; object-fit: contain; background: #ECEFF1; border: 1px solid #D6D9DC; border-radius: 6px; image-rendering: pixelated; }
    .distribution { min-width: 0; }
    dl { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin: 0 0 12px; }
    dl div { min-width: 0; padding-bottom: 8px; border-bottom: 1px solid #E2E4E7; }
    dt { margin-bottom: 4px; }
    dd { margin: 0; overflow-wrap: anywhere; font-family: Consolas, monospace; font-size: 15px; }
    .chart-wrap { position: relative; }
    .histogram { display: block; width: 100%; height: auto; aspect-ratio: 1000 / 430; }
    .chart-tooltip { position: absolute; z-index: 2; max-width: 250px; padding: 7px 9px; color: #FFFFFF; background: #263238; border-radius: 4px; pointer-events: none; font-family: Consolas, monospace; font-size: 12px; white-space: nowrap; }
    .error { border-color: #D84A4A; } .error p { margin-top: 8px; color: #B3261E; }
    @media (prefers-color-scheme: dark) {
      :root { color: #E8EAED; background: #17191C; --chart-text: #DDE3E7; --chart-muted: #AEB4BA; --chart-grid: #3A4247; --chart-bar: #59B994; --chart-active: #E8C968; }
      .summary p, header span, figcaption, dt, .input-value span { color: #AEB4BA; }
      .result { border-color: #454A50; background: #22252A; }
      .input-value strong, .input-value input, figure img { border-color: #454A50; }
      .input-value input { color: #E8EAED; background: #22252A; }
      figure img { background: #111315; }
      dl div { border-color: #3A3E43; }
      .error p { color: #FF8A80; }
    }
    @media (max-width: 960px) {
      .summary { align-items: start; flex-direction: column; }
      .result-grid { grid-template-columns: 1fr; }
      figure { width: min(100%, 320px); }
      dl { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    }
  </style>
</head>
<body>
  <main>
    <section class="summary">
      <div class="summary-copy">
        <h1>全图 OKLab 距离分布</h1>
        <p>${results.length} 张图片 · ${escapeHtml(generatedAt)}</p>
        <p>输入目录：<code>${escapeHtml(inputDirectory)}</code></p>
      </div>
      <div class="inputs">
        <div class="input-value"><span>背景代表色</span><strong class="swatch" style="--swatch-color:${backgroundHex};--swatch-text:${swatchTextColor}">${backgroundHex}</strong></div>
        <label class="input-value" for="bin-width-control"><span>区间宽度</span><input id="bin-width-control" min="${distributionResolution}" step="${distributionResolution}" type="number" value="${binWidth}"></label>
      </div>
    </section>
    <section class="results" aria-label="全图 OKLab 距离分布列表">
      ${results.map((result, index) => createResultMarkup(result, binWidth, index)).join("\n")}
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
      const chartMargin = { top: 24, right: 22, bottom: 68, left: 82 };

      function formatClientDistance(value, width) {
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

      function getChartColors() {
        const style = getComputedStyle(document.documentElement);
        return {
          text: style.getPropertyValue("--chart-text").trim(),
          muted: style.getPropertyValue("--chart-muted").trim(),
          grid: style.getPropertyValue("--chart-grid").trim(),
          bar: style.getPropertyValue("--chart-bar").trim(),
          active: style.getPropertyValue("--chart-active").trim(),
        };
      }

      function drawChart(canvas, bins, width, activeIndex = -1) {
        const context = canvas.getContext("2d");
        const colors = getChartColors();
        const plotWidth = canvas.width - chartMargin.left - chartMargin.right;
        const plotHeight = canvas.height - chartMargin.top - chartMargin.bottom;
        const maximumCount = Math.max(1, ...bins.map((bin) => bin.count));
        const maximumDistance = Math.max(width, bins[bins.length - 1].end);
        const barWidth = plotWidth / bins.length;
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
          if (bin.count === 0) continue;
          const barHeight = Math.max(1, bin.count / maximumCount * plotHeight);
          const x = chartMargin.left + index * barWidth;
          context.fillStyle = index === activeIndex ? colors.active : colors.bar;
          context.fillRect(x, chartMargin.top + plotHeight - barHeight, Math.max(0.5, barWidth - Math.min(1, barWidth * 0.12)), barHeight);
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
          context.fillText(formatClientDistance(maximumDistance * ratio, width), x, chartMargin.top + plotHeight + 24);
        }

        context.fillStyle = colors.text;
        context.font = "600 13px Inter, Microsoft YaHei, system-ui, sans-serif";
        context.fillText("与背景代表色的 OKLab 距离", chartMargin.left + plotWidth / 2, canvas.height - 12);
        context.save();
        context.translate(18, chartMargin.top + plotHeight / 2);
        context.rotate(-Math.PI / 2);
        context.fillText("像素数量", 0, 0);
        context.restore();
      }

      function updateChart(canvas, width) {
        const dataset = datasets[Number(canvas.dataset.index)];
        const bins = createBins(dataset, width);
        canvas._bins = bins;
        canvas._binWidth = width;
        drawChart(canvas, bins, width);
        const peak = bins.reduce((best, bin) => bin.count > best.count ? bin : best, bins[0]);
        const result = canvas.closest(".result");
        result.querySelector('[data-role="peak-range"]').textContent = "[" + formatClientDistance(peak.start, width) + ", " + formatClientDistance(peak.end, width) + ")";
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
        canvas.addEventListener("pointermove", (event) => {
          const rect = canvas.getBoundingClientRect();
          const canvasX = (event.clientX - rect.left) * canvas.width / rect.width;
          const plotWidth = canvas.width - chartMargin.left - chartMargin.right;
          const index = Math.floor((canvasX - chartMargin.left) / plotWidth * canvas._bins.length);
          if (index < 0 || index >= canvas._bins.length) {
            tooltip.hidden = true;
            drawChart(canvas, canvas._bins, canvas._binWidth);
            return;
          }
          const bin = canvas._bins[index];
          drawChart(canvas, canvas._bins, canvas._binWidth, index);
          tooltip.textContent = "[" + formatClientDistance(bin.start, canvas._binWidth) + ", " + formatClientDistance(bin.end, canvas._binWidth) + ")：" + countFormatter.format(bin.count);
          tooltip.hidden = false;
          const localX = event.clientX - rect.left;
          const localY = event.clientY - rect.top;
          tooltip.style.left = Math.min(wrapper.clientWidth - tooltip.offsetWidth - 8, Math.max(8, localX + 12)) + "px";
          tooltip.style.top = Math.max(8, localY - tooltip.offsetHeight - 8) + "px";
        });
        canvas.addEventListener("pointerleave", () => {
          tooltip.hidden = true;
          drawChart(canvas, canvas._bins, canvas._binWidth);
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

function escapeCsv(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function createCsv(results) {
  const rows = [["file", "interval_start", "interval_end", "pixel_count"]];
  for (const result of results) {
    for (const bin of result.bins) {
      rows.push([result.relativePath, bin.start.toFixed(6), bin.end.toFixed(6), bin.count]);
    }
  }
  return `${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
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
  const { backgroundColor, binWidth, inputDirectory, shouldOpen } = parseArguments(process.argv.slice(2));
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
  console.log(`背景代表色：${backgroundHex}`);
  console.log(`OKLab 距离区间宽度：${binWidth}`);
  console.log("");

  for (const filePath of pngFiles) {
    const relativePath = path.relative(inputDirectory, filePath);
    try {
      const fileData = await readFile(filePath);
      const png = PNG.sync.read(fileData);
      const distribution = collectOklabDistanceDistribution({
        width: png.width,
        height: png.height,
        data: new Uint8ClampedArray(png.data),
      }, backgroundLab, distributionResolution);
      const bins = binOklabDistanceDistribution(distribution, binWidth);
      const peakBin = bins.reduce((peak, bin) => bin.count > peak.count ? bin : peak, bins[0]);
      results.push({
        relativePath,
        width: png.width,
        height: png.height,
        distribution,
        bins,
        dataUrl: `data:image/png;base64,${fileData.toString("base64")}`,
      });
      console.log(relativePath);
      console.log(`  统计像素：${distribution.pixelCount}`);
      console.log(`  距离范围：${distribution.minimumDistance.toFixed(6)} - ${distribution.maximumDistance.toFixed(6)}`);
      console.log(`  峰值区间：[${formatDistance(peakBin.start, binWidth)}, ${formatDistance(peakBin.end, binWidth)})，${peakBin.count} 个像素`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ relativePath, message });
      console.error(relativePath);
      console.error(`  错误: ${message}`);
    }
    console.log("");
  }

  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(reportPath, createReport(results, errors, inputDirectory, backgroundColor, binWidth), "utf8"),
    writeFile(csvPath, createCsv(results), "utf8"),
  ]);
  console.log(`分布图：${reportPath}`);
  console.log(`CSV 数据：${csvPath}`);
  if (shouldOpen) {
    await openReport(reportPath);
    console.log("已打开 OKLab 距离分布窗口。");
  }
  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
