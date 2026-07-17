import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  colorDistanceSquared,
  rgbToOklab,
  srgbToLinear,
  type OklabColor,
} from "../algorithms/colorSpace";
import type { RgbColor } from "../algorithms/types";

type ColorStages = {
  rgb: RgbColor;
  normalized: OklabColor;
  linear: OklabColor;
  lmsRoot: OklabColor;
  lab: OklabColor;
};

const CHROMA_SCALE = 3.2;
const LIGHTNESS_SCALE = 2.2;
const PLANE_RANGE = 0.4;
const PLANE_SIZE = 420;

const presets = [
  { label: "深色背景", colorA: "#17111D", colorB: "#1C1523" },
  { label: "黑与近黑", colorA: "#000000", colorB: "#101010" },
  { label: "红与紫", colorA: "#E63946", colorB: "#9B5DE5" },
  { label: "黄与灰", colorA: "#FFD400", colorB: "#B8B8A8" },
];

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseHex(value: string): RgbColor {
  const normalized = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
  return [1, 3, 5].map((start) => Number.parseInt(normalized.slice(start, start + 2), 16)) as RgbColor;
}

function rgbToHex(color: RgbColor): string {
  return `#${color.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

function oklabToRgb([lightness, a, b]: OklabColor): RgbColor {
  const lightRoot = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mediumRoot = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const shortRoot = lightness - 0.0894841775 * a - 1.291485548 * b;
  const light = lightRoot ** 3;
  const medium = mediumRoot ** 3;
  const short = shortRoot ** 3;
  const linearRed = 4.0767416621 * light - 3.3077115913 * medium + 0.2309699292 * short;
  const linearGreen = -1.2684380046 * light + 2.6097574011 * medium - 0.3413193965 * short;
  const linearBlue = -0.0041960863 * light - 0.7034186147 * medium + 1.707614701 * short;
  return [linearRed, linearGreen, linearBlue].map((channel) => (
    Math.round(clamp(linearToSrgb(channel)) * 255)
  )) as RgbColor;
}

function getColorStages(hex: string): ColorStages {
  const rgb = parseHex(hex);
  const normalized = rgb.map((channel) => channel / 255) as OklabColor;
  const linear = normalized.map(srgbToLinear) as OklabColor;
  const lmsRoot: OklabColor = [
    Math.cbrt(0.4122214708 * linear[0] + 0.5363325363 * linear[1] + 0.0514459929 * linear[2]),
    Math.cbrt(0.2119034982 * linear[0] + 0.6806995451 * linear[1] + 0.1073969566 * linear[2]),
    Math.cbrt(0.0883024619 * linear[0] + 0.2817188376 * linear[1] + 0.6299787005 * linear[2]),
  ];
  return { rgb, normalized, linear, lmsRoot, lab: rgbToOklab(...rgb) };
}

function formatTriplet(values: readonly number[], digits = 4): string {
  return values.map((value) => value.toFixed(digits)).join("  ");
}

function ColorEditor({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commitDraft = () => {
    if (/^#[0-9a-f]{6}$/i.test(draft)) onChange(draft.toUpperCase());
    else setDraft(value);
  };

  return (
    <label className="color-editor">
      <span>{label}</span>
      <span className="color-editor-row">
        <input
          aria-label={`${label}颜色选择器`}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          type="color"
          value={value}
        />
        <input
          aria-label={`${label}十六进制颜色`}
          maxLength={7}
          onBlur={commitDraft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitDraft();
          }}
          spellCheck={false}
          value={draft}
        />
      </span>
    </label>
  );
}

function createLabelSprite(text: string, color = "#F7FAFA"): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.font = "600 24px system-ui";
  context.fillStyle = "rgba(18, 23, 26, 0.82)";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2, canvas.height / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.72, 0.18, 1);
  return sprite;
}

function labToPosition(lab: OklabColor): THREE.Vector3 {
  return new THREE.Vector3(
    lab[1] * CHROMA_SCALE,
    (lab[0] - 0.5) * LIGHTNESS_SCALE,
    lab[2] * CHROMA_SCALE,
  );
}

function OklabSpace3D({
  colorA,
  colorB,
}: {
  colorA: OklabColor;
  colorB: OklabColor;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resetViewRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14191c);
    scene.fog = new THREE.Fog(0x14191c, 5.5, 9);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 20);
    const initialCameraPosition = container.clientWidth < 600
      ? new THREE.Vector3(2.05, 1.5, 2.25)
      : new THREE.Vector3(2.8, 2.05, 3.05);
    camera.position.copy(initialCameraPosition);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.enablePan = false;
    controls.minDistance = 2.4;
    controls.maxDistance = 7;
    controls.target.set(0, 0, 0);
    controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotateSpeed = 0.42;
    controls.saveState();
    resetViewRef.current = () => {
      camera.position.copy(initialCameraPosition);
      controls.target.set(0, 0, 0);
      controls.update();
    };

    const positions: number[] = [];
    const colors: number[] = [];
    const sampleSteps = 17;
    for (let redIndex = 0; redIndex < sampleSteps; redIndex += 1) {
      for (let greenIndex = 0; greenIndex < sampleSteps; greenIndex += 1) {
        for (let blueIndex = 0; blueIndex < sampleSteps; blueIndex += 1) {
          const rgb: RgbColor = [
            Math.round(redIndex / (sampleSteps - 1) * 255),
            Math.round(greenIndex / (sampleSteps - 1) * 255),
            Math.round(blueIndex / (sampleSteps - 1) * 255),
          ];
          const position = labToPosition(rgbToOklab(...rgb));
          positions.push(position.x, position.y, position.z);
          colors.push(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        }
      }
    }
    const gamutGeometry = new THREE.BufferGeometry();
    gamutGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    gamutGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const gamutMaterial = new THREE.PointsMaterial({
      size: 0.034,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
    });
    scene.add(new THREE.Points(gamutGeometry, gamutMaterial));

    const grid = new THREE.GridHelper(2.6, 10, 0x6b7b82, 0x2d383d);
    scene.add(grid);
    const addAxis = (start: THREE.Vector3, end: THREE.Vector3, color: number) => {
      const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);
      scene.add(new THREE.Line(geometry, new THREE.LineBasicMaterial({ color })));
    };
    addAxis(new THREE.Vector3(-1.35, 0, 0), new THREE.Vector3(1.35, 0, 0), 0xe37b72);
    addAxis(new THREE.Vector3(0, -1.1, 0), new THREE.Vector3(0, 1.1, 0), 0xf1f5f5);
    addAxis(new THREE.Vector3(0, 0, -1.35), new THREE.Vector3(0, 0, 1.35), 0xe5c55f);

    const labels: Array<[string, THREE.Vector3, string]> = [
      ["L 1.0 亮", new THREE.Vector3(0, 1.28, 0), "#F7FAFA"],
      ["L 0.0 暗", new THREE.Vector3(0, -1.28, 0), "#F7FAFA"],
      ["a- 绿", new THREE.Vector3(-1.52, 0, 0), "#8BD2A8"],
      ["a+ 红", new THREE.Vector3(1.52, 0, 0), "#F08B83"],
      ["b- 蓝", new THREE.Vector3(0, 0, -1.52), "#8EB9F0"],
      ["b+ 黄", new THREE.Vector3(0, 0, 1.52), "#F2D66D"],
    ];
    for (const [text, position, color] of labels) {
      const label = createLabelSprite(text, color);
      label.position.copy(position);
      scene.add(label);
    }

    const pointA = labToPosition(colorA);
    const pointB = labToPosition(colorB);
    const connectionGeometry = new THREE.BufferGeometry().setFromPoints([pointA, pointB]);
    const connectionMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    scene.add(new THREE.Line(connectionGeometry, connectionMaterial));
    const addColorMarker = (position: THREE.Vector3, color: OklabColor, labelText: string) => {
      const rgb = oklabToRgb(color);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.065, 20, 20),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255) }),
      );
      sphere.position.copy(position);
      scene.add(sphere);
      const outline = new THREE.Mesh(
        new THREE.SphereGeometry(0.082, 14, 14),
        new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }),
      );
      outline.position.copy(position);
      scene.add(outline);
      const label = createLabelSprite(labelText);
      label.scale.set(0.25, 0.12, 1);
      label.position.copy(position).add(new THREE.Vector3(0.13, 0.13, 0));
      scene.add(label);
    };
    addColorMarker(pointA, colorA, "A");
    addColorMarker(pointB, colorB, "B");

    const resizeObserver = new ResizeObserver(() => {
      const width = Math.max(1, container.clientWidth);
      const height = Math.max(1, container.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resizeObserver.observe(container);

    let animationFrame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(animate);
    };
    animate();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Points || object instanceof THREE.Line) {
          object.geometry.dispose();
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          materials.forEach((material) => material.dispose());
        } else if (object instanceof THREE.Sprite) {
          object.material.map?.dispose();
          object.material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
      resetViewRef.current = () => undefined;
    };
  }, [colorA, colorB]);

  return (
    <section className="space3d-section">
      <div className="scene-heading">
        <div><span>感知坐标</span><h2>OKLab 三维色域</h2></div>
        <button onClick={() => resetViewRef.current()} type="button">重置视角</button>
      </div>
      <div
        aria-label="可旋转缩放的 OKLab 三维色域，包含 L、a、b 三轴及颜色 A、B"
        className="oklab-3d"
        ref={containerRef}
        role="img"
      />
    </section>
  );
}

function OklabPlane({
  lightness,
  colorA,
  colorB,
  onPick,
}: {
  lightness: number;
  colorA: OklabColor;
  colorB: OklabColor;
  onPick: (color: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const image = context.createImageData(PLANE_SIZE, PLANE_SIZE);

    for (let y = 0; y < PLANE_SIZE; y += 1) {
      const b = PLANE_RANGE - (y / (PLANE_SIZE - 1)) * PLANE_RANGE * 2;
      for (let x = 0; x < PLANE_SIZE; x += 1) {
        const a = -PLANE_RANGE + (x / (PLANE_SIZE - 1)) * PLANE_RANGE * 2;
        const rgb = oklabToRgb([lightness, a, b]);
        const renderedLab = rgbToOklab(...rgb);
        const error = Math.sqrt(colorDistanceSquared(renderedLab, [lightness, a, b]));
        const offset = (y * PLANE_SIZE + x) * 4;
        image.data[offset] = rgb[0];
        image.data[offset + 1] = rgb[1];
        image.data[offset + 2] = rgb[2];
        image.data[offset + 3] = error <= 0.025 ? 255 : 24;
      }
    }
    context.putImageData(image, 0, 0);
    context.strokeStyle = "rgba(255, 255, 255, 0.7)";
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(PLANE_SIZE / 2, 0);
    context.lineTo(PLANE_SIZE / 2, PLANE_SIZE);
    context.moveTo(0, PLANE_SIZE / 2);
    context.lineTo(PLANE_SIZE, PLANE_SIZE / 2);
    context.stroke();

    const drawPoint = (lab: OklabColor, label: string) => {
      const x = ((lab[1] + PLANE_RANGE) / (PLANE_RANGE * 2)) * PLANE_SIZE;
      const y = ((PLANE_RANGE - lab[2]) / (PLANE_RANGE * 2)) * PLANE_SIZE;
      context.beginPath();
      context.arc(x, y, 7, 0, Math.PI * 2);
      context.fillStyle = "#FFFFFF";
      context.fill();
      context.lineWidth = 3;
      context.strokeStyle = "#17191C";
      context.stroke();
      context.fillStyle = "#17191C";
      context.font = "700 12px system-ui";
      context.fillText(label, x + 11, y - 9);
    };
    drawPoint(colorA, "A");
    drawPoint(colorB, "B");
  }, [colorA, colorB, lightness]);

  return (
    <canvas
      aria-label={`可选点的 OKLab a/b 平面，当前明度 ${lightness.toFixed(3)}`}
      height={PLANE_SIZE}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const a = ((event.clientX - bounds.left) / bounds.width) * PLANE_RANGE * 2 - PLANE_RANGE;
        const b = PLANE_RANGE - ((event.clientY - bounds.top) / bounds.height) * PLANE_RANGE * 2;
        onPick(rgbToHex(oklabToRgb([lightness, a, b])));
      }}
      ref={canvasRef}
      width={PLANE_SIZE}
    />
  );
}

export default function OKLabLearningApp() {
  const [colorA, setColorA] = useState("#17111D");
  const [colorB, setColorB] = useState("#1C1523");
  const [activePoint, setActivePoint] = useState<"A" | "B">("B");
  const [planeLightness, setPlaneLightness] = useState(0.55);
  const [strict, setStrict] = useState(0.043);
  const [loose, setLoose] = useState(0.071);
  const stagesA = useMemo(() => getColorStages(colorA), [colorA]);
  const stagesB = useMemo(() => getColorStages(colorB), [colorB]);
  const delta = stagesB.lab.map((value, index) => value - stagesA.lab[index]) as OklabColor;
  const distance = Math.sqrt(colorDistanceSquared(stagesA.lab, stagesB.lab));
  const classification = distance <= strict
    ? "高可信背景种子"
    : distance <= loose
      ? "疑似背景，需要连通"
      : "前景范围";
  const distanceMaximum = Math.max(0.12, loose * 1.25, distance * 1.12);

  const stageRows = [
    { step: "01", name: "sRGB 8 位", valueA: stagesA.rgb.join("  "), valueB: stagesB.rgb.join("  ") },
    { step: "02", name: "sRGB 归一化", valueA: formatTriplet(stagesA.normalized), valueB: formatTriplet(stagesB.normalized) },
    { step: "03", name: "线性 RGB", valueA: formatTriplet(stagesA.linear), valueB: formatTriplet(stagesB.linear) },
    { step: "04", name: "LMS 立方根", valueA: formatTriplet(stagesA.lmsRoot), valueB: formatTriplet(stagesB.lmsRoot) },
    { step: "05", name: "OKLab  L a b", valueA: formatTriplet(stagesA.lab), valueB: formatTriplet(stagesB.lab) },
  ];

  return (
    <div className="lab-shell">
      <header className="lab-header">
        <div>
          <span className="lab-kicker">PIXEL CLEAN · COLOR SCIENCE</span>
          <h1>OKLab 学习实验室</h1>
        </div>
        <a href="/">返回像素图清理台</a>
      </header>

      <main>
        <section className="color-workbench">
          <div className="preset-group" aria-label="颜色对比示例">
            {presets.map((preset) => (
              <button
                key={preset.label}
                onClick={() => {
                  setColorA(preset.colorA);
                  setColorB(preset.colorB);
                }}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="color-inputs">
            <ColorEditor label="颜色 A" onChange={setColorA} value={colorA} />
            <button
              className="swap-button"
              onClick={() => {
                setColorA(colorB);
                setColorB(colorA);
              }}
              type="button"
            >
              交换 A / B
            </button>
            <ColorEditor label="颜色 B" onChange={setColorB} value={colorB} />
          </div>
          <div className="comparison-bar" aria-label="颜色 A 和颜色 B 对比">
            <div style={{ backgroundColor: colorA }}><span>A</span></div>
            <div style={{ backgroundColor: colorB }}><span>B</span></div>
          </div>
          <div className="metric-strip">
            <div><span>OKLab 距离</span><strong>{distance.toFixed(4)}</strong></div>
            <div><span>ΔL 明度</span><strong>{delta[0].toFixed(4)}</strong></div>
            <div><span>Δa 绿 ↔ 红</span><strong>{delta[1].toFixed(4)}</strong></div>
            <div><span>Δb 蓝 ↔ 黄</span><strong>{delta[2].toFixed(4)}</strong></div>
          </div>
        </section>

        <OklabSpace3D colorA={stagesA.lab} colorB={stagesB.lab} />

        <section className="plane-picker-section">
          <div className="section-heading">
            <div>
              <span>精确交互</span>
              <h2>a / b 平面选点</h2>
            </div>
            <div aria-label="平面选点编辑目标" className="point-target-control" role="group">
              <button
                aria-pressed={activePoint === "A"}
                className={activePoint === "A" ? "is-active" : ""}
                onClick={() => {
                  setActivePoint("A");
                  setPlaneLightness(stagesA.lab[0]);
                }}
                type="button"
              >
                编辑 A
              </button>
              <button
                aria-pressed={activePoint === "B"}
                className={activePoint === "B" ? "is-active" : ""}
                onClick={() => {
                  setActivePoint("B");
                  setPlaneLightness(stagesB.lab[0]);
                }}
                type="button"
              >
                编辑 B
              </button>
            </div>
          </div>
          <div className="plane-picker-grid">
            <div className="plane-picker-canvas">
              <OklabPlane
                colorA={stagesA.lab}
                colorB={stagesB.lab}
                lightness={planeLightness}
                onPick={(color) => {
                  if (activePoint === "A") setColorA(color);
                  else setColorB(color);
                }}
              />
              <div className="axis-legend">
                <span>a− 绿色</span><span>a+ 红色</span><span>b− 蓝色</span><span>b+ 黄色</span>
              </div>
            </div>
            <div className="plane-picker-controls">
              <div className="active-point-preview" style={{ backgroundColor: activePoint === "A" ? colorA : colorB }}>
                <span>正在编辑 {activePoint}</span>
              </div>
              <dl className="active-point-values">
                <div><dt>Hex</dt><dd><code>{activePoint === "A" ? colorA : colorB}</code></dd></div>
                <div><dt>L</dt><dd><code>{(activePoint === "A" ? stagesA.lab[0] : stagesB.lab[0]).toFixed(4)}</code></dd></div>
                <div><dt>a</dt><dd><code>{(activePoint === "A" ? stagesA.lab[1] : stagesB.lab[1]).toFixed(4)}</code></dd></div>
                <div><dt>b</dt><dd><code>{(activePoint === "A" ? stagesA.lab[2] : stagesB.lab[2]).toFixed(4)}</code></dd></div>
              </dl>
              <label className="range-control">
                <span>切片明度 L <output>{planeLightness.toFixed(3)}</output></span>
                <input
                  max="1"
                  min="0"
                  onChange={(event) => setPlaneLightness(Number(event.target.value))}
                  step="0.001"
                  type="range"
                  value={planeLightness}
                />
              </label>
            </div>
          </div>
        </section>

        <section className="pipeline-section">
            <div className="section-heading">
              <div>
                <span>数值管线</span>
                <h2>从 sRGB 到 OKLab</h2>
              </div>
            </div>
            <div className="pipeline-table" role="table" aria-label="颜色转换步骤">
              <div className="pipeline-header" role="row">
                <span>步骤</span><span>颜色 A</span><span>颜色 B</span>
              </div>
              {stageRows.map((row) => (
                <div className="pipeline-row" key={row.step} role="row">
                  <span><b>{row.step}</b>{row.name}</span>
                  <code>{row.valueA}</code>
                  <code>{row.valueB}</code>
                </div>
              ))}
            </div>
            <div className="distance-formula">
              <span>距离公式</span>
              <code>√(ΔL² + Δa² + Δb²) = {distance.toFixed(4)}</code>
            </div>
        </section>

        <section className="threshold-section">
          <div className="section-heading threshold-heading">
            <div>
              <span>背景算法连接</span>
              <h2>双阈值分类</h2>
            </div>
            <strong>{classification}</strong>
          </div>
          <div className="threshold-controls">
            <label>
              <span>strict <output>{strict.toFixed(3)}</output></span>
              <input
                max="0.28"
                min="0.006"
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setStrict(value);
                  if (value >= loose) setLoose(Math.min(0.38, value + 0.008));
                }}
                step="0.001"
                type="range"
                value={strict}
              />
            </label>
            <label>
              <span>loose <output>{loose.toFixed(3)}</output></span>
              <input
                max="0.38"
                min="0.012"
                onChange={(event) => setLoose(Math.max(strict + 0.001, Number(event.target.value)))}
                step="0.001"
                type="range"
                value={loose}
              />
            </label>
          </div>
          <div className="threshold-ruler" style={{ "--strict": `${strict / distanceMaximum * 100}%`, "--loose": `${loose / distanceMaximum * 100}%`, "--distance": `${Math.min(100, distance / distanceMaximum * 100)}%` } as React.CSSProperties}>
            <div className="ruler-track">
              <i className="seed-range" />
              <i className="candidate-range" />
              <i className="foreground-range" />
              <i className="distance-marker"><span>当前 {distance.toFixed(4)}</span></i>
            </div>
            <div className="ruler-labels"><span>0</span><span>{distanceMaximum.toFixed(3)}</span></div>
          </div>
          <div className="threshold-legend">
            <span><i className="seed-dot" />高可信背景</span>
            <span><i className="candidate-dot" />连通后算背景</span>
            <span><i className="foreground-dot" />前景</span>
          </div>
        </section>
      </main>
    </div>
  );
}
