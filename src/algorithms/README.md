# 核心算法目录

Pixel Clean 有两条顶层核心处理管线：智能背景移除和近似像素颜色替换。

## 文件职责

- `adaptiveBackgroundThresholds.ts`：根据全图非透明像素与已知背景色的 OKLab 距离分布，以背景峰下降沿拐点和首个稳定低谷计算 `strict` 与 `loose`，可独立测试。
- `backgroundMaskGeneration.ts`：使用用户在 `strict` 与 `loose` 之间选择的单一阈值逐像素生成二值背景蒙版及 OKLab 距离数组。
- `oklabDistanceDistribution.ts`：统计全图非透明像素到背景代表色的 OKLab 距离分布，并按指定区间宽度聚合。
- `backgroundRemoval.ts`：连通背景区域生长、边界带检测、前景候选提取，以及线性 RGB 边缘 Alpha 反算与颜色去污染。
- `backgroundColorEstimation.ts`：从四角样本独立估算背景色，可直接用合成 RGBA 或真实 PNG 数据测试。
- `paletteReduction.ts`：颜色直方图、OKLab 色系约束、确定性远点初始化、带像素权重的聚类，以及原图代表色替换。
- `colorSpace.ts`：sRGB/线性 RGB/OKLab 转换、感知色差、色相和色系划分等共享数学基础。
- `processImage.ts`：按固定顺序组合背景移除、透明像素规范化、调色板规整和处理统计。
- `types.ts`：核心处理管线的公共输入、输出和配置类型。

## 算法边界

背景去除内部还包含两组会直接影响输出质量的核心子算法：

1. 自适应背景建模与连通区域生长，决定哪些像素属于背景；
2. 边缘 Alpha 反算与 RGB 去污染，决定半透明边缘的覆盖率和前景原色。

它们依赖同一背景模型和中间掩码，因此作为背景移除管线的内部阶段维护，而不是独立的产品功能。

`src/imageProcessing.ts` 是兼容入口，同时保留保护蒙版绘制和颜色列表统计。这两部分分别属于编辑器交互和结果展示，不属于核心图像变换算法。Worker 调度、自动预览和导出也不属于算法层。
