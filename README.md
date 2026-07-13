# Pixel Clean

Pixel Clean 是一款本地桌面像素图清理工具，当前支持 Windows 与 macOS。项目使用 Tauri：界面由内嵌 WebView 渲染，但文件读写、保存位置选择和工程打开都使用系统原生能力。

## 开发运行

在 Windows 或 macOS 的 PowerShell 7 / 终端中执行：

```sh
npm install
npm run tauri:dev
```

## 打包

必须在对应操作系统上构建对应的安装包：

```sh
npm run tauri:build
```

Windows 会生成 Windows 安装包；macOS 会在 `src-tauri/target/release/bundle/` 中生成 `.app` 和相应的分发包。Windows 不能直接产出可发布的 macOS 应用，需要使用 Mac 或 macOS CI 运行器进行构建。

## macOS 发布

开发和本地使用可直接构建。若要将应用分发给其他 Mac 用户，应使用 Apple Developer 证书进行代码签名并完成公证，否则 Gatekeeper 可能阻止用户打开应用。
