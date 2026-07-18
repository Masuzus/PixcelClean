# 核心算法目录

Pixel Clean 2.0 的算法层由可独立测试的纯函数组成。当前生产流水线从局部近似颜色归并开始，依次完成背景分析、二值蒙版和边缘半透明重建。

## 文件职责

- `localColorIslands.ts`：按固定顺序执行四邻域区域生长，同时约束候选像素与相邻像素、岛屿动态平均 OKLab 的距离；岛屿完成后以 OKLab 中位中心最近的岛内真实颜色统一替换。
- `directionalBackgroundDistance.ts`：将 OKLab 分解为 `ΔL / ΔC / ΔH`，按 `0.5 / 2 / 2` 加权生成方向距离，降低暗部明度差并提高色度、色相差的影响。
- `adaptiveBackgroundThresholds.ts`：根据全图非透明像素与已知背景色的方向加权 OKLCH 距离分布，以背景峰下降沿拐点和首个稳定低谷计算 `strict` 与 `loose`，可独立测试。
- `backgroundMaskGeneration.ts`：使用用户在 `strict` 与 `loose` 之间选择的单一阈值逐像素生成二值背景蒙版及方向距离数组。
- `classifyBackgroundDistances.ts`：复用已经计算的距离数组重新分类，保证保护像素始终属于前景。
- `edgeGlowReconstruction.ts`：从四邻接背景的低余量前景种子提升整个颜色岛，再使用邻近实体前景锚点在线性 RGB 中反算 Alpha 和去除背景色污染；拟合不可靠时将像素归为背景。
- `oklabDistanceDistribution.ts`：统计全图非透明像素到背景代表色的方向加权 OKLCH 距离分布，并按指定区间宽度聚合。
- `backgroundRemoval.ts`：连通背景区域生长、边界带检测、前景候选提取，以及线性 RGB 边缘 Alpha 反算与颜色去污染。
- `backgroundColorEstimation.ts`：从四角样本独立估算背景色，可直接用合成 RGBA 或真实 PNG 数据测试。
- `paletteReduction.ts`：1.0 遗留的全局调色板聚类算法，未接入 2.0 产品管线。
- `colorSpace.ts`：sRGB/线性 RGB/OKLab 转换、感知色差、色相和色系划分等共享数学基础。
- `processImage.ts`：按固定顺序组合背景移除、透明像素规范化、调色板规整和处理统计。
- `types.ts`：核心处理管线的公共输入、输出和配置类型。

## 当前流水线边界

当前 2.0 产品流水线已经输出边缘半透明最终图。边缘阶段遵守以下约束：

1. 只有未保护、完全不透明、与背景四邻接且 `0 < distance - threshold <= edgeGlowWidth` 的前景像素能够成为种子；差值默认 `0.1`，可由用户调整为 `0..0.3`；
2. 一个种子会将所属颜色岛的全部未保护前景像素提升为辉光像素；
3. 已有半透明像素和保护像素保持不变；
4. 找不到可靠锚点的辉光像素清空为透明，并进入“判为背景”统计和最终背景蒙版。

顶层编排位于 `src/pipeline/backgroundAnalysis.ts`。阈值和保护蒙版变化使用缓存归并图、颜色岛编号和距离场重新执行分类与边缘重建，不重复执行颜色归并、背景色与距离分布分析。1.0 的 `backgroundRemoval.ts` 仍保留，但未接入 2.0 产品管线。
