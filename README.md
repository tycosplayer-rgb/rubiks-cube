# 在线魔方 · Rubik's Cube

基于 **Vite + TypeScript + Three.js** 的生产级 3D 魔方网页应用，支持 2×2～7×7，打乱 / 手动拧动 / 自动还原 / 触控与轨道相机。

## 在线体验

| 入口 | URL | 说明 |
|------|-----|------|
| **推荐（非 github.io）** | https://98amcq-ip-34-193-108-177.tunnelmole.net/ | Tunnelmole HTTPS 隧道；当前 box 在线时可用 |
| **备用隧道** | https://436a2cc49595929b-34-193-125-207.serveousercontent.com/ | Serveo HTTPS |
| **备用隧道** | https://weak-months-give.loca.lt/ | localtunnel（浏览器可能有确认页） |
| GitHub Pages | https://tycosplayer-rgb.github.io/rubiks-cube/ | 已同步修复；**在中国大陆可能被拦截 / 无法打开** |
| 仓库 | https://github.com/tycosplayer-rgb/rubiks-cube | 源码 |

> 若 github.io 打不开，请用上方隧道链接。Cloudflare Pages / Netlify / Vercel 需登录授权后可挂长期生产域名（当前环境无这些平台的 API token）。cloudflared quick tunnel 当前被限流（429）。

静态产物分支（供镜像/自建）：`cdn` 分支根目录为 `dist/` 内容。

## 功能

- **阶数**：2×2×2 ～ 7×7×7（默认 3×3），切换阶数会复位到复原状态
- **打乱**：近似公平的随机打乱，并显示打乱公式与步数
- **自动还原**：
  - **3×3**：使用 [cubejs](https://github.com/ldez/cubejs)（Kociemba 两阶段算法）
  - **其他阶数**：沿打乱/操作历史**逆序回放**还原（见下方限制）
- **手动操作**：在色块上拖拽转动对应层
- **触控**：单指拖色块拧层；双指 / 空白处拖拽旋转视角
- **轨道相机**：鼠标拖空白处旋转；滚轮缩放
- **速度**：可调节动画速度
- **标准配色**：白↔黄、红↔橙、蓝↔绿；默认 U白 D黄 F绿 B蓝 R红 L橙

## 本地运行

```bash
npm install
npm run dev
```

构建静态站点：

```bash
npm run build
# 产物在 dist/，可用 npm run preview 预览
```

`vite.config.ts` 使用相对路径 `base: './'`，可部署到任意根路径或子路径（含 GitHub Pages `/rubiks-cube/`）。

内置 Vite 插件将 `cubejs` 的 `this.Cube` 改写为 `globalThis.Cube`，避免浏览器 ESM 下白屏（仅暗色背景、无 HUD/魔方）。

## 求解器限制

| 阶数 | 求解方式 | 说明 |
|------|----------|------|
| 3×3 | Kociemba / cubejs | 根据当前状态求解，支持打乱后继续手动拧再还原 |
| 2×2、4×4～7×7 | 历史逆序 | 将自上次「复位/切换阶数」以来的所有层转逆序播放；**不是**通用最优解 |

首次加载 3×3 求解器时会在后台初始化（约 1–2 秒），之后求解通常很快。

## 技术栈

- Vite 8 + TypeScript
- Three.js（WebGL 渲染、OrbitControls）
- cubejs（仅 3×3）

## 操作提示

- 桌面：在贴纸上按住拖动 → 转层；在空白处拖动 → 转视角
- 手机：单指拖贴纸转层；双指旋转/缩放视角
