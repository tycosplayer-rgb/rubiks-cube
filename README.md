# 在线魔方 · Rubik's Cube

基于 **Vite + TypeScript + Three.js** 的交互式 3D 魔方网页应用，支持：

- **方块魔方**：2×2–7×7
- **金字塔（Pyraminx）**
- **十二面体（Megaminx）**

## 在线体验

| 入口 | URL | 说明 |
|------|-----|------|
| **推荐（非 github.io）** | https://1mpbki-ip-35-171-58-89.tunnelmole.net/ | Tunnelmole HTTPS；当前 box 在线时可用 |
| GitHub Pages | https://tycosplayer-rgb.github.io/rubiks-cube/ | 可能在中国大陆打不开 |
| 仓库 | https://github.com/tycosplayer-rgb/rubiks-cube | 源码 |

静态产物也发布在 `cdn` 分支根目录（不含 `node_modules`）。

## 功能

### 通用
- 打乱 / 自动还原 / 复位
- 轨道相机；智能 / 视角 / 拧动三种手势模式
- 贴纸 / 全色外观（localStorage 记住）
- 顶部 / 底部菜单可独立折叠（localStorage 记住；收起后仅保留窄条切换）
- 动画速度调节；状态与步数显示

### 方块魔方
- 阶数 2–7；色块拖动转层
- 3×3 使用 cubejs / Kociemba；其它阶数逆序回放历史
- 保留短路径逆时针动画、安全重挂载、统一 rAF、MSAA、底部补光等优化

### 金字塔 / 十二面体
- 固定尺寸；切换类型时隐藏阶数选择器
- **面转按钮**（顺时针 ↻ / 逆时针 ↺）为主要可靠操作方式，适配手机
- 金字塔另有尖角（tip）按钮
- 也可拖动色块尝试面转；轨道相机始终可用
- 打乱 = 随机合法面转；自动还原 = **逆序回放自复位/切换/打乱以来的历史**

## 模型说明与限制（请注意）

金字塔与十二面体是 **3D 面片层模型（facelet-based）**，不是完整隐藏块 / cubie 置换数据库：

- 转动时会选中并旋转对应轴附近的可见色块，画面会真实变化
- 逆序历史可精确转回记录起点
- **不是**任意打乱状态的通用求解器；也未模拟所有实体块拓扑细节
- 手机上请优先使用底部/面板中的面转按钮

## 本地运行

```bash
npm install
npm run dev
```

构建：

```bash
npm run build
npm run preview
```

`vite.config.ts` 使用相对路径 `base: './'`，可部署到任意子路径。内置 Vite 插件修补 cubejs 的浏览器 ESM 全局引用。

## 技术栈

- Vite + TypeScript
- Three.js / OrbitControls
- cubejs（仅方块 3×3）

### 金字塔（Pyraminx）
- 四**尖轴** 120° 转动（非面转）：`U层`/`L层`/`R层`/`B层` 为深层（尖+邻边/轴心带，12 贴纸），`U尖`… 为只转尖（3 贴纸）
- 打乱以深层尖轴为主，偶发尖拧；还原为历史逆序

### 十二面体（Megaminx）
- 每面 **五角星切割（star cut）**：1 中心五边形 + 5 角块 + 5 棱块（共 11 贴纸），沟槽呈五角星
- 面转 72°；按**当前面位置**选层（轴投影找出本面 11 贴纸），再按 piece id 扩到整块（约 26），相邻面转后仍正确
- 全色模式不放大贴纸（用 polygonOffset + 几何 inset 防 z-fighting / 露核）
- 打乱 / 还原为随机面转与历史逆序

### 校验
```bash
npx tsx scripts/verify-pyraminx.mjs
npx tsx scripts/verify-megaminx.mjs
```

