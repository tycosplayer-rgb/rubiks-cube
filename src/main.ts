import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RubiksCube } from './cube/RubiksCube';
import { Pyraminx } from './cube/Pyraminx';
import { Megaminx } from './cube/Megaminx';
import { setupInteraction, type ControlMode, type InteractionHandle } from './cube/controls';
import { FACE_HEX } from './cube/colors';
import { ensureSolver } from './cube/solver';
import type { Puzzle, PuzzleType, VisualStyle } from './cube/puzzle';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div id="canvas-wrap"></div>
  <div class="hud">
    <div class="top-bar panel" id="top-bar">
      <div class="panel-chrome">
        <div class="title">
          在线魔方
          <span id="subtitle">标准配色 · 2×2–20×20</span>
          <span class="swatches" title="U白 D黄 F绿 B蓝 R红 L橙" aria-hidden="true">
            <i style="background:${FACE_HEX.U}"></i><i style="background:${FACE_HEX.D}"></i>
            <i style="background:${FACE_HEX.F}"></i><i style="background:${FACE_HEX.B}"></i>
            <i style="background:${FACE_HEX.R}"></i><i style="background:${FACE_HEX.L}"></i>
          </span>
        </div>
        <button type="button" class="panel-toggle" id="toggle-top" aria-expanded="true" aria-controls="top-bar-body" aria-label="收起顶部菜单" title="收起顶部菜单">
          <span class="toggle-label">收起</span><span class="toggle-chevron" aria-hidden="true">▴</span>
        </button>
      </div>
      <div class="panel-body" id="top-bar-body">
        <div class="controls">
          <div class="control-row setup-controls">
            <label class="ctrl type-ctrl">魔方类型
              <select id="puzzle-type">
                <option value="cube">方块魔方</option>
                <option value="pyraminx">金字塔</option>
                <option value="megaminx">十二面体</option>
              </select>
            </label>
            <label class="ctrl" id="order-ctrl">阶数
              <select id="order">
                ${Array.from({length: 19}, (_, i) => i + 2).map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n}×${n}×${n}</option>`).join('')}
              </select>
            </label>
            <label class="ctrl">速度 <input id="speed" type="range" min="0.5" max="3" step="0.25" value="1" /></label>
          </div>
          <div class="control-row mode-controls">
            <div class="mode-toggle" role="group" aria-label="操作模式">
              <button type="button" class="mode-btn active" data-mode="smart" title="点色块拧层，空白转视角">智能</button>
              <button type="button" class="mode-btn" data-mode="orbit" title="只旋转视角">视角</button>
              <button type="button" class="mode-btn" data-mode="twist" title="只拧魔方层">拧动</button>
            </div>
            <div class="mode-toggle style-toggle" role="group" aria-label="外观样式">
              <button type="button" class="style-btn active" data-style="sticker">贴纸</button>
              <button type="button" class="style-btn" data-style="full">全色</button>
            </div>
          </div>
          <div class="control-row action-controls">
            <button id="btn-scramble" class="primary" type="button">打乱</button>
            <button id="btn-solve" class="success" type="button">自动还原</button>
            <button id="btn-reset" class="ghost" type="button">复位</button>
          </div>
        </div>
      </div>
    </div>
    <div class="bottom-bar panel" id="bottom-bar">
      <div class="panel-chrome">
        <span class="panel-chrome-label">状态与面转</span>
        <button type="button" class="panel-toggle" id="toggle-bottom" aria-expanded="true" aria-controls="bottom-bar-body" aria-label="收起底部菜单" title="收起底部菜单">
          <span class="toggle-label">收起</span><span class="toggle-chevron" aria-hidden="true">▾</span>
        </button>
      </div>
      <div class="panel-body" id="bottom-bar-body">
        <div id="face-controls" class="face-controls hidden" aria-label="面转按钮"></div>
        <div class="status-row">
          <span id="status">就绪</span>
          <span class="muted">步数 <strong id="moves">0</strong></span>
          <span class="muted">打乱长度 <strong id="scramble-len">—</strong></span>
        </div>
        <div id="scramble-text" class="scramble-box">打乱公式将显示在这里</div>
        <div id="hint" class="hint">智能：单指点色块拧层、点空白转视角；双指始终转视角 · 可切换「视角/拧动」锁定</div>
      </div>
    </div>
  </div>
`;

const wrap = document.querySelector<HTMLDivElement>('#canvas-wrap')!;
const typeSel = document.querySelector<HTMLSelectElement>('#puzzle-type')!;
const orderCtrl = document.querySelector<HTMLElement>('#order-ctrl')!;
const orderSel = document.querySelector<HTMLSelectElement>('#order')!;
const speedInp = document.querySelector<HTMLInputElement>('#speed')!;
const btnScramble = document.querySelector<HTMLButtonElement>('#btn-scramble')!;
const btnSolve = document.querySelector<HTMLButtonElement>('#btn-solve')!;
const btnReset = document.querySelector<HTMLButtonElement>('#btn-reset')!;
const statusEl = document.querySelector<HTMLSpanElement>('#status')!;
const movesEl = document.querySelector<HTMLElement>('#moves')!;
const scrambleLenEl = document.querySelector<HTMLElement>('#scramble-len')!;
const scrambleTextEl = document.querySelector<HTMLDivElement>('#scramble-text')!;
const faceControls = document.querySelector<HTMLDivElement>('#face-controls')!;
const subtitleEl = document.querySelector<HTMLElement>('#subtitle')!;
const hintEl = document.querySelector<HTMLElement>('#hint')!;

const isCoarsePointer =
  (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) ||
  (navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 900);
const dprCap = isCoarsePointer ? 1.5 : 2;
const useShadows = !isCoarsePointer;
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
renderer.shadowMap.enabled = useShadows;
if (useShadows) renderer.shadowMap.type = THREE.BasicShadowMap;
wrap.appendChild(renderer.domElement);
renderer.domElement.style.width = '100%';
renderer.domElement.style.height = '100%';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, wrap.clientWidth / wrap.clientHeight, 0.1, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.9;
controls.enablePan = false;
controls.target.set(0, 0, 0);
controls.maxPolarAngle = Math.PI;
controls.minPolarAngle = 0;
scene.add(new THREE.AmbientLight(0xffffff, 0.42));
scene.add(new THREE.HemisphereLight(0xc8d6ff, 0xffe6a8, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 0.95);
key.position.set(6, 10, 4);
key.castShadow = useShadows;
if (useShadows) { key.shadow.mapSize.set(1024, 1024); key.shadow.camera.near = 1; key.shadow.camera.far = 40; }
scene.add(key);
const fill = new THREE.DirectionalLight(0xa8c0ff, 0.45); fill.position.set(-6, 3, -4); scene.add(fill);
const under = new THREE.DirectionalLight(0xfff0c8, 0.7); under.position.set(0, -8, 2); scene.add(under);
const rim = new THREE.DirectionalLight(0xb0c8ff, 0.35); rim.position.set(2, -2, -6); scene.add(rim);
const floor = new THREE.Mesh(
  new THREE.CircleGeometry(12, 64),
  new THREE.MeshStandardMaterial({ color: 0x121a30, roughness: .92, metalness: .15, transparent: true, opacity: .72, depthWrite: false }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
floor.renderOrder = -1;
scene.add(floor);

const STYLE_STORAGE_KEY = 'rubiks-visual-style';
function loadVisualStyle(): VisualStyle {
  try { const v = localStorage.getItem(STYLE_STORAGE_KEY); if (v === 'sticker' || v === 'full') return v; } catch { /* ignore */ }
  return 'sticker';
}
function saveVisualStyle(style: VisualStyle): void { try { localStorage.setItem(STYLE_STORAGE_KEY, style); } catch { /* ignore */ } }
const PUZZLE_TYPE_STORAGE_KEY = 'rubiks-puzzle-type';
const ORDER_KEYS: Record<PuzzleType, string> = {
  cube: 'rubiks-cube-order',
  pyraminx: 'rubiks-pyraminx-order',
  megaminx: 'rubiks-megaminx-order',
};
function loadPuzzleType(): PuzzleType {
  try {
    const v = localStorage.getItem(PUZZLE_TYPE_STORAGE_KEY);
    if (v === 'cube' || v === 'pyraminx' || v === 'megaminx') return v;
  } catch { /* ignore */ }
  return 'cube';
}
function savePuzzleType(type: PuzzleType): void {
  try { localStorage.setItem(PUZZLE_TYPE_STORAGE_KEY, type); } catch { /* ignore */ }
}
function loadOrder(type: PuzzleType): number {
  try {
    const v = Number(localStorage.getItem(ORDER_KEYS[type]));
    if (Number.isFinite(v) && v >= 2 && v <= 20) return Math.round(v);
  } catch { /* ignore */ }
  return 3;
}
function saveOrder(type: PuzzleType, order: number): void {
  try { localStorage.setItem(ORDER_KEYS[type], String(order)); } catch { /* ignore */ }
}
let visualStyle = loadVisualStyle();
let currentType = loadPuzzleType();
typeSel.value = currentType;
let orders: Record<PuzzleType, number> = {
  cube: loadOrder('cube'),
  pyraminx: loadOrder('pyraminx'),
  megaminx: loadOrder('megaminx'),
};
function createPuzzle(type: PuzzleType): Puzzle {
  const order = orders[type];
  if (type === 'pyraminx') return new Pyraminx(order, visualStyle);
  if (type === 'megaminx') return new Megaminx(order, visualStyle);
  return new RubiksCube(order, visualStyle);
}
function rebuildOrderOptions(type: PuzzleType): void {
  const order = orders[type];
  const aliases: Record<number, string> = { 3: 'Megaminx', 5: 'Gigaminx', 7: 'Teraminx', 9: 'Petaminx', 11: 'Examinx' };
  const opts = Array.from({ length: 19 }, (_, i) => i + 2).map((n) => {
    // Keep the control compact; the well-known Megaminx names live in its tooltip.
    const label = type === 'cube' ? `${n}×${n}×${n}` : `${n}阶`;
    return `<option value="${n}" ${n === order ? 'selected' : ''}>${label}</option>`;
  });
  orderSel.innerHTML = opts.join('');
  const alias = type === 'megaminx' ? aliases[order] : undefined;
  orderSel.title = alias ? `${order}阶（${alias}）` : `${order}阶`;
  orderSel.setAttribute('aria-label', alias ? `阶数：${order}阶（${alias}）` : `阶数：${order}阶`);
}
let puzzle: Puzzle = createPuzzle(currentType);
puzzle.setCastShadows(useShadows);
scene.add(puzzle.group);
let interaction: InteractionHandle = setupInteraction(renderer.domElement, camera, puzzle, controls, 'smart');
let unbindPuzzle = () => {};

const modeBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.mode-btn'));
const styleBtns = Array.from(document.querySelectorAll<HTMLButtonElement>('.style-btn'));
function applyStyleUI(style: VisualStyle): void { for (const b of styleBtns) b.classList.toggle('active', b.dataset.style === style); }
function applyModeUI(mode: ControlMode): void { for (const b of modeBtns) b.classList.toggle('active', b.dataset.mode === mode); }
applyStyleUI(visualStyle);

function setBusy(busy: boolean): void {
  btnScramble.disabled = busy; btnSolve.disabled = busy; btnReset.disabled = busy; typeSel.disabled = busy;
  orderSel.disabled = busy;
  faceControls.querySelectorAll('button').forEach((b) => { (b as HTMLButtonElement).disabled = busy; });
}
function resetHud(): void {
  movesEl.textContent = '0'; scrambleLenEl.textContent = '—'; scrambleTextEl.textContent = '打乱公式将显示在这里';
}
function bindPuzzleEvents(): void {
  unbindPuzzle();
  unbindPuzzle = puzzle.on((e) => {
    if (e.type === 'busy') setBusy(e.busy);
    if (e.type === 'move') movesEl.textContent = String(e.historyLen);
    if (e.type === 'scramble') { scrambleTextEl.textContent = e.text; scrambleLenEl.textContent = String(e.length); }
    if (e.type === 'status') statusEl.textContent = e.message;
    if (e.type === 'solved') { statusEl.textContent = '已复原 ✨'; movesEl.textContent = '0'; }
  });
}
function fitCamera(): void {
  const dist = puzzle.getFitDistance();
  camera.position.set(dist * .85, dist * .7, dist);
  controls.minDistance = dist * .48;
  controls.maxDistance = dist * 3.5;
  floor.position.y = puzzle.getFloorY();
  controls.update();
}
function renderFaceControls(): void {
  const buttons = puzzle.getFaceButtons();
  faceControls.classList.toggle('hidden', buttons.length === 0);
  faceControls.innerHTML = buttons.map((b) => `
    <span class="face-turn-pair" style="--face-color:${b.color}">
      <b>${b.label}</b>
      <button type="button" data-face="${b.id}" data-tip="${b.tip ? '1' : '0'}" data-bottom="${b.bottom ? '1' : '0'}" data-depth="${b.depth !== undefined ? b.depth : ''}" data-wide="${b.wide ? '1' : '0'}" data-dir="1" aria-label="${b.label} 顺时针">↻</button>
      <button type="button" data-face="${b.id}" data-tip="${b.tip ? '1' : '0'}" data-bottom="${b.bottom ? '1' : '0'}" data-depth="${b.depth !== undefined ? b.depth : ''}" data-wide="${b.wide ? '1' : '0'}" data-dir="-1" aria-label="${b.label} 逆时针">↺</button>
    </span>`).join('');
  faceControls.querySelectorAll<HTMLButtonElement>('button').forEach((button) => button.addEventListener('click', () => {
    const face = button.dataset.face!;
    const steps = Number(button.dataset.dir);
    const tip = button.dataset.tip === '1';
    const bottom = button.dataset.bottom === '1';
    const wide = button.dataset.wide === '1';
    const depthStr = button.dataset.depth ?? '';
    const depth = depthStr === '' ? undefined : Number(depthStr);
    void puzzle.applyMove({
      kind: 'face',
      face,
      steps,
      ...(depth !== undefined && Number.isFinite(depth) ? { depth } : {}),
      ...(tip ? { tip: true } : {}),
      ...(bottom ? { bottom: true } : {}),
      ...(wide ? { wide: true } : {}),
    }, true);
  }));
}
function updateTypeUI(): void {
  orderCtrl.classList.remove('hidden');
  orderSel.disabled = false;
  rebuildOrderOptions(currentType);
  const n = orders[currentType];
  subtitleEl.textContent =
    currentType === 'cube'
      ? '标准配色 · 2×2–20×20'
      : currentType === 'pyraminx'
        ? `金字塔 · ${n}阶 · 四尖轴 120°`
        : `十二面体 · ${n}阶 · 72° 面转`;
  hintEl.textContent =
    currentType === 'cube'
      ? '智能：单指点色块拧层、点空白转视角；双指始终转视角 · 可切换「视角/拧动」锁定'
      : currentType === 'pyraminx'
        ? '尖轴按钮：尖 / 层… / 底 按阶数分带；也可拖色块绕近尖转动，空白处转视角'
        : '使用上方面转按钮可靠操作（↻/↺）；也可拖动色块尝试面转，空白处拖动旋转视角 · 双指缩放';
  faceControls.setAttribute(
    'aria-label',
    currentType === 'pyraminx' ? '金字塔尖轴转动' : currentType === 'megaminx' ? '十二面体面转' : '面转按钮',
  );
  renderFaceControls();
}
function switchPuzzle(type: PuzzleType): void {
  const prevMode = interaction.getMode();
  interaction.dispose();
  unbindPuzzle();
  scene.remove(puzzle.group);
  puzzle.stop();
  puzzle.dispose();
  currentType = type;
  savePuzzleType(type);
  puzzle = createPuzzle(type);
  puzzle.setSpeed(Number(speedInp.value));
  puzzle.setCastShadows(useShadows);
  scene.add(puzzle.group);
  bindPuzzleEvents();
  interaction = setupInteraction(renderer.domElement, camera, puzzle, controls, prevMode);
  applyModeUI(prevMode);
  fitCamera();
  resetHud();
  updateTypeUI();
  const n = orders[type];
  statusEl.textContent =
    type === 'cube'
      ? `方块魔方 ${n}×${n}×${n}（已复位）`
      : type === 'pyraminx'
        ? `金字塔 ${n}阶已就绪`
        : `十二面体 ${n}阶已就绪`;
}

for (const btn of styleBtns) btn.addEventListener('click', () => {
  const style = btn.dataset.style as VisualStyle;
  if (style !== 'sticker' && style !== 'full') return;
  visualStyle = style; puzzle.setVisualStyle(style); saveVisualStyle(style); applyStyleUI(style);
  statusEl.textContent = style === 'sticker' ? '外观：贴纸' : '外观：全色';
});
for (const btn of modeBtns) btn.addEventListener('click', () => {
  const mode = btn.dataset.mode as ControlMode; interaction.setMode(mode); applyModeUI(mode);
  statusEl.textContent = mode === 'smart' ? '智能模式：色块拧动，空白转视角' : mode === 'orbit' ? '视角模式：拖拽只旋转相机' : '拧动模式：拖拽只拧层';
});
typeSel.addEventListener('change', () => switchPuzzle(typeSel.value as PuzzleType));
orderSel.addEventListener('change', () => {
  const n = Number(orderSel.value);
  if (!Number.isFinite(n) || n < 2 || n > 20) return;
  orders[currentType] = n;
  saveOrder(currentType, n);
  switchPuzzle(currentType);
});
speedInp.addEventListener('input', () => puzzle.setSpeed(Number(speedInp.value)));
btnScramble.addEventListener('click', () => { void puzzle.scramble(); });
btnSolve.addEventListener('click', () => { void puzzle.solve(); });
btnReset.addEventListener('click', () => { puzzle.reset(); resetHud(); });

bindPuzzleEvents();
fitCamera();
updateTypeUI();
function onResize(): void {
  const w = wrap.clientWidth, h = wrap.clientHeight;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap)); renderer.setSize(w, h, false);
}
const TOP_OPEN_KEY = 'rubiks-top-bar-open';
const BOTTOM_OPEN_KEY = 'rubiks-bottom-bar-open';
const topBar = document.querySelector<HTMLDivElement>('#top-bar')!;
const bottomBar = document.querySelector<HTMLDivElement>('#bottom-bar')!;
const toggleTop = document.querySelector<HTMLButtonElement>('#toggle-top')!;
const toggleBottom = document.querySelector<HTMLButtonElement>('#toggle-bottom')!;

function loadPanelOpen(key: string, fallback = true): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch { /* ignore */ }
  return fallback;
}
function savePanelOpen(key: string, open: boolean): void {
  try { localStorage.setItem(key, open ? '1' : '0'); } catch { /* ignore */ }
}
function applyPanelCollapsed(
  bar: HTMLElement,
  btn: HTMLButtonElement,
  open: boolean,
  which: 'top' | 'bottom',
): void {
  bar.classList.toggle('collapsed', !open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  const label = open ? '收起' : '展开';
  const where = which === 'top' ? '顶部菜单' : '底部菜单';
  btn.setAttribute('aria-label', `${label}${where}`);
  btn.title = `${label}${where}`;
  const labelEl = btn.querySelector('.toggle-label');
  const chevronEl = btn.querySelector('.toggle-chevron');
  if (labelEl) labelEl.textContent = label;
  if (chevronEl) {
    if (which === 'top') chevronEl.textContent = open ? '▴' : '▾';
    else chevronEl.textContent = open ? '▾' : '▴';
  }
}
function setPanelOpen(which: 'top' | 'bottom', open: boolean, persist = true): void {
  if (which === 'top') {
    applyPanelCollapsed(topBar, toggleTop, open, 'top');
    if (persist) savePanelOpen(TOP_OPEN_KEY, open);
  } else {
    applyPanelCollapsed(bottomBar, toggleBottom, open, 'bottom');
    if (persist) savePanelOpen(BOTTOM_OPEN_KEY, open);
  }
  // Keep canvas sizing in sync if layout/viewport metrics shift after toggle.
  requestAnimationFrame(() => onResize());
}

setPanelOpen('top', loadPanelOpen(TOP_OPEN_KEY, true), false);
setPanelOpen('bottom', loadPanelOpen(BOTTOM_OPEN_KEY, true), false);
toggleTop.addEventListener('click', () => setPanelOpen('top', topBar.classList.contains('collapsed')));
toggleBottom.addEventListener('click', () => setPanelOpen('bottom', bottomBar.classList.contains('collapsed')));

window.addEventListener('resize', onResize);
function animate(now: number): void { requestAnimationFrame(animate); puzzle.update(now); controls.update(); renderer.render(scene, camera); }
requestAnimationFrame(animate);
void ensureSolver().then(() => { if (currentType === 'cube' && statusEl.textContent === '就绪') statusEl.textContent = '就绪 · 3×3 求解器已加载'; });
