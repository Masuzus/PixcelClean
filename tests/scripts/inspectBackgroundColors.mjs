import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { estimateCornerColor } from "../../src/algorithms/backgroundColorEstimation.ts";
import {
  defaultLocalColorSimilarityThreshold,
  mergeLocalColorIslands,
} from "../../src/algorithms/localColorIslands.ts";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const inputDirectory = path.join(projectRoot, "tests/input/images");
const outputDirectory = path.join(projectRoot, "test-results");
const reportPath = path.join(outputDirectory, "background-color-report.html");

function parseArguments(argumentsList) {
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
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }

  return { inputDirectory, localColorThreshold, shouldOpen };
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

function createResultMarkup(result) {
  const safeName = escapeHtml(result.relativePath);
  const color = colorToHex(result.estimatedColor);
  const [red, green, blue] = result.estimatedColor;
  const textColor = getSwatchTextColor(result.estimatedColor);

  return `
    <article class="result">
      <header>
        <h2>${safeName}</h2>
        <span>${result.width} × ${result.height}</span>
      </header>
      <div class="comparison">
        <figure>
          <img alt="${safeName}" src="${result.dataUrl}">
          <figcaption>测试图片</figcaption>
        </figure>
        <figure>
          <div class="swatch" style="--swatch-color: ${color}; --swatch-text: ${textColor}" role="img" aria-label="估算背景色 ${color}">
            <strong>${color}</strong>
          </div>
          <figcaption>估算背景色</figcaption>
        </figure>
      </div>
      <dl>
        <div><dt>Hex</dt><dd><code>${color}</code></dd></div>
        <div><dt>RGB</dt><dd><code>rgb(${red}, ${green}, ${blue})</code></dd></div>
      </dl>
    </article>`;
}

function createErrorMarkup(error) {
  return `
    <article class="result error">
      <header><h2>${escapeHtml(error.relativePath)}</h2></header>
      <p>${escapeHtml(error.message)}</p>
    </article>`;
}

function createReport(results, errors, inputDirectory) {
  const generatedAt = new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date());
  const resultMarkup = results.map(createResultMarkup).join("\n");
  const errorMarkup = errors.map(createErrorMarkup).join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>背景色估算结果</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: Inter, "Microsoft YaHei", system-ui, sans-serif;
      color: #202124;
      background: #F5F6F7;
    }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 48px; }
    .summary { display: flex; justify-content: space-between; align-items: end; gap: 16px; margin-bottom: 24px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; font-weight: 600; }
    h2 { overflow-wrap: anywhere; font-size: 15px; font-weight: 600; }
    .summary p, header span, figcaption, dt { color: #62676D; font-size: 13px; }
    .summary code { overflow-wrap: anywhere; }
    .results { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr)); gap: 16px; }
    .result { padding: 16px; border: 1px solid #D6D9DC; border-radius: 8px; background: #FFFFFF; }
    .result header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 14px; }
    .comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    figure { display: grid; gap: 6px; min-width: 0; margin: 0; }
    figure img, .swatch { display: block; width: 100%; aspect-ratio: 1; border: 1px solid #D6D9DC; border-radius: 6px; }
    figure img { object-fit: contain; background: #ECEFF1; image-rendering: pixelated; }
    .swatch { display: grid; place-items: center; padding: 12px; color: var(--swatch-text); background: var(--swatch-color); }
    .swatch strong { max-width: 100%; font-family: Consolas, monospace; font-size: 20px; overflow-wrap: anywhere; }
    dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 14px 0 0; }
    dl div { min-width: 0; padding-top: 10px; border-top: 1px solid #E2E4E7; }
    dt { margin-bottom: 3px; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .error { border-color: #D84A4A; }
    .error p { color: #B3261E; }
    @media (prefers-color-scheme: dark) {
      :root { color: #E8EAED; background: #17191C; }
      .summary p, header span, figcaption, dt { color: #AEB4BA; }
      .result { border-color: #454A50; background: #22252A; }
      figure img, .swatch { border-color: #454A50; }
      figure img { background: #111315; }
      dl div { border-color: #3A3E43; }
      .error p { color: #FF8A80; }
    }
    @media (max-width: 560px) {
      main { width: min(100% - 20px, 1120px); padding-top: 18px; }
      .summary { align-items: start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <section class="summary">
      <div>
        <h1>背景色估算结果</h1>
        <p>${results.length} 张图片 · ${escapeHtml(generatedAt)}</p>
      </div>
      <p>输入目录：<code>${escapeHtml(inputDirectory)}</code></p>
    </section>
    <section class="results" aria-label="背景色估算列表">
      ${resultMarkup}
      ${errorMarkup}
    </section>
  </main>
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
    const child = spawn(command[0], command[1], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

async function main() {
  const { inputDirectory, localColorThreshold, shouldOpen } = parseArguments(process.argv.slice(2));
  await mkdir(inputDirectory, { recursive: true });
  const pngFiles = await collectPngFiles(inputDirectory);

  if (pngFiles.length === 0) {
    console.error("没有找到 PNG 图片。");
    console.error(`请把测试图片放入：${inputDirectory}`);
    process.exitCode = 1;
    return;
  }

  const results = [];
  const errors = [];
  console.log(`输入目录：${inputDirectory}`);
  console.log(`近似颜色阈值：${localColorThreshold}`);
  console.log("");

  for (const filePath of pngFiles) {
    const relativePath = path.relative(inputDirectory, filePath);
    try {
      const fileData = await readFile(filePath);
      const png = PNG.sync.read(fileData);
      const merged = mergeLocalColorIslands({
        width: png.width,
        height: png.height,
        data: new Uint8ClampedArray(png.data),
      }, localColorThreshold);
      const estimatedColor = estimateCornerColor(merged.image);
      const hex = colorToHex(estimatedColor);
      results.push({
        relativePath,
        width: png.width,
        height: png.height,
        estimatedColor,
        dataUrl: `data:image/png;base64,${fileData.toString("base64")}`,
      });
      console.log(`${relativePath}`);
      console.log(`  Hex: ${hex}`);
      console.log(`  RGB: rgb(${estimatedColor.join(", ")})`);
      console.log(`  岛屿: ${merged.stats.islandCount}，替换像素: ${merged.stats.replacedPixelCount}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ relativePath, message });
      console.error(`${relativePath}`);
      console.error(`  错误: ${message}`);
    }
    console.log("");
  }

  await mkdir(outputDirectory, { recursive: true });
  await writeFile(reportPath, createReport(results, errors, inputDirectory), "utf8");
  console.log(`可视化报告：${reportPath}`);

  if (shouldOpen) {
    await openReport(reportPath);
    console.log("已打开背景色结果窗口。");
  }

  if (errors.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
