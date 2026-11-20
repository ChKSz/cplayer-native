# CPlayer Native (Tauri 2 Android)

基于最新版 `CPlayer` 协议与核心体验重构的 **Tauri 2 原生 Android 客户端**，融合 **Hachimi (`BlurBottomBar`)** 与 **RikkaHub** 的可拖动底部交互设计，支持 **GitHub Actions 全自动云端打包 APK**（无需本地配置 Java / Android SDK / NDK）。

## 核心特性

- **真实 1:1 可拖动悬浮底栏**：横向按住 `[播放 · 歌单 · 搜索]` 液态玻璃胶囊跟手滑动切页（含物理弹簧吸附与边缘阻尼），向上拖拉底栏或右侧圆钮可直接 1:1 拉出多档位底部抽屉；右侧圆钮自动感知页面在「队列」与「迷你黑胶播停」之间切换。
- **原版视觉核心完整保留**：100% 保留原版 Aura-Music WebGL 流体着色器（切歌四色平滑过渡）、旋转黑胶唱片、左右滑/点按切换 LRC/TLRC 滚动歌词；按钮采用克制的自然按压回弹反馈（无厚阴影、亮边与发光叠加）。
- **严格遵循新版鉴权与流媒体契约**：
  - `CPlayerSync` 账号登录 → 同域换取 5 分钟短期成员播放凭证（仅发往官方音乐 API，绝不持久化、绝不泄露登录态、绝不附加到音频 CDN）。
  - 支持网易云 / QQ 音乐 / 酷狗多音源搜索、网易云 9 档音质切换、酷狗签名播放地址优先与过期流单次自恢复（`MediaRecovery`）。
  - 支持云歌单同步与网易云歌单 ID / 分享短链导入（已移除本地 JSON 导入）。
- **Tauri 2 Android 原生适配**：Rust `reqwest` 代理规避 WebView CORS/Origin 限制，`tauri-plugin-haptics` 原生震动，Edge-to-Edge 全透明状态栏/手势条，返回键优先收起面板并后台保活。

## 本地预览与测试（仅需 Node.js）

```bash
npm install
npm test
npm run dev
```

浏览器打开 `http://localhost:1420` 即可体验完整交互。

## GitHub Actions 一键云端打包 APK

1. 将本目录推送到你的 GitHub 仓库（`main` 分支）。
2. 在 GitHub 仓库打开 **Actions → Build Android APK (Tauri 2) → Run workflow**（或在每次推送到 `main` 时自动触发）。
3. 构建完成后，在 Workflow 页面的 **Artifacts** 中直接下载 `cplayer-android-arm64-apk` 解压安装即可。

### 可选：配置签名 Release APK

如需构建正式签名 Release APK（支持覆盖安装更新），在仓库 **Settings → Secrets and variables → Actions** 中添加以下 4 个 Secret，并在打 `v*` Tag 或手动选择 `release` 模式时自动签名：

- `ANDROID_KEYSTORE_BASE64`（`.keystore` 文件的 Base64 编码）
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
