# 统一测试图片目录

所有算法可视化测试都递归读取这个目录中的 PNG 图片。测试图片只需要放置一次。

```powershell
npm run test:background-color
npm run test:adaptive-thresholds -- --background "#1C1523"
npm run test:oklab-distribution -- --background "#1C1523" --bin-width 0.005
npm run test:background-mask -- --background "#1C1523" --strict 0.006 --loose 0.014
```

背景蒙版测试可通过 `--threshold` 指定滑块初始值；未指定时使用 `strict` 与 `loose` 的中点。
