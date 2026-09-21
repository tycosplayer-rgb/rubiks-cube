import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RubiksCube } from './cube/RubiksCube';
import { setupInteraction } from './cube/controls';
import { FACE_HEX } from './cube/colors';
import { ensureSolver } from './cube/solver';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <div id="canvas-wrap"></div>
  <div class="hud">
    <div class="top-bar panel">
      <div class="title">
        在线魔方
        <span>标准配色 · 2×2–7×7</span>
        <span class="swatches" title="U白 D黄 F绿 B蓝 R红 L橙" aria-hidden="true">
          <i style="background:${FACE_HEX.U}"></i>
          <i style="background:${FACE_HEX.D}"></i>
          <i style="background:${FACE_HEX.F}"></i>
          <i style="background:${FACE_HEX.B}"></i>
          <i style="background:${FACE_HEX.R}"></i>
          <i style="background:${FACE_HEX.L}"></i>
        </span>
      </div>
      <div class="controls">
        <label class="ctrl">阶数
          <select id="order">
            ${[2, 3, 4, 5, 6, 7].map((n) => `<option value="${n}" ${n === 3 ? 'selected' : ''}>${n}×${n}×${n}</option>`).join('')}
          </select>
        </label>
        <label class="ctrl">速度
          <input id="speed" type="range" min="0.5" max="3" step="0.25" value="1" />
        </label>
        <button id="btn-scramble" class="primary" type="button">打乱</button>
        <button id="btn-solve" class="success" type="button">自动还原</button>
        <button id="btn-reset" class="ghost" type="button">复位</button>
      </div>
    </div>
    <div class="bottom-bar panel">
      <div class="status-row">
        <span id="status">就绪</span>
        <span class="muted">步数 <strong id="moves">0</strong></span>
        <span class="muted">打乱长度 <strong id="scramble-len">—</strong></span>
      </div>
      <div id="scramble-text" class="scramble-box">打乱公式将显示在这里</div>
      <div class="hint">拖拽色块转动层 · 空白处拖拽/双指旋转视角 · 触控支持</div>
    </div>
  </div>
`;

const wrap = document.querySelector<HTMLDivElement>('#canvas-wrap')!;
const orderSel = document.querySelector<HTMLSelectElement>('#order')!;
const speedInp = document.querySelector<HTMLInputElement>('#speed')!;
const btnScramble = document.querySelector<HTMLButtonElement>('#btn-scramble')!;
const btnSolve = document.querySelector<HTMLButtonElement>('#btn-solve')!;
const btnReset = document.querySelector<HTMLButtonElement>('#btn-reset')!;
const statusEl = document.querySelector<HTMLSpanElement>('#status')!;
const movesEl = document.querySelector<HTMLElement>('#moves')!;
const scrambleLenEl = document.querySelector<HTMLElement>('#scramble-len')!;
const scrambleTextEl = document.querySelector<HTMLDivElement>('#scramble-text')!;

// --- Three.js scene ---
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(wrap.clientWidth, wrap.clientHeight);
renderer.shadowMap.enabled = true;
wrap.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, wrap.clientWidth / wrap.clientHeight, 0.1, 200);
camera.position.set(5.2, 4.2, 6.2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.9;
controls.enablePan = false;
controls.minDistance = 4;
controls.maxDistance = 28;
controls.target.set(0, 0, 0);

const hemi = new THREE.HemisphereLight(0xb0c4ff, 0x1a1520, 1.05);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.15);
key.position.set(6, 10, 4);
key.castShadow = true;
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
fill.position.set(-5, 2, -3);
scene.add(fill);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(12, 64),
  new THREE.MeshStandardMaterial({ color: 0x0c1224, roughness: 0.9, metalness: 0.2 }),
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -3.2;
floor.receiveShadow = true;
scene.add(floor);

let cube = new RubiksCube(3);
scene.add(cube.group);
fitCameraToOrder(3);

let disposeInteraction = setupInteraction(renderer.domElement, camera, cube, controls);

function setBusy(busy: boolean): void {
  btnScramble.disabled = busy;
  btnSolve.disabled = busy;
  btnReset.disabled = busy;
  orderSel.disabled = busy;
}

function bindCubeEvents(): void {
  cube.on((e) => {
    if (e.type === 'busy') setBusy(e.busy);
    if (e.type === 'move') movesEl.textContent = String(e.historyLen);
    if (e.type === 'scramble') {
      scrambleTextEl.textContent = e.text;
      scrambleLenEl.textContent = String(e.length);
    }
    if (e.type === 'status') statusEl.textContent = e.message;
    if (e.type === 'solved') {
      statusEl.textContent = '已复原 ✨';
      movesEl.textContent = '0';
    }
    if (e.type === 'order') {
      statusEl.textContent = `阶数已切换为 ${e.order}×${e.order}×${e.order}`;
      movesEl.textContent = '0';
      scrambleLenEl.textContent = '—';
      scrambleTextEl.textContent = '打乱公式将显示在这里';
    }
  });
}
bindCubeEvents();

function fitCameraToOrder(n: number): void {
  const dist = 4.2 + n * 0.85;
  camera.position.set(dist * 0.85, dist * 0.7, dist);
  controls.minDistance = 2.5 + n * 0.35;
  controls.maxDistance = 18 + n * 2;
  controls.update();
  // raise floor
  floor.position.y = -((n * 1.06) / 2 + 0.8);
}

orderSel.addEventListener('change', () => {
  const n = Number(orderSel.value);
  scene.remove(cube.group);
  disposeInteraction();
  cube.stop();
  cube = new RubiksCube(n);
  scene.add(cube.group);
  bindCubeEvents();
  disposeInteraction = setupInteraction(renderer.domElement, camera, cube, controls);
  fitCameraToOrder(n);
  movesEl.textContent = '0';
  scrambleLenEl.textContent = '—';
  scrambleTextEl.textContent = '打乱公式将显示在这里';
  statusEl.textContent = `阶数 ${n}×${n}×${n}（已复位）`;
});

speedInp.addEventListener('input', () => {
  cube.setSpeed(Number(speedInp.value));
});

btnScramble.addEventListener('click', () => {
  void cube.scramble();
});

btnSolve.addEventListener('click', () => {
  void cube.solve();
});

btnReset.addEventListener('click', () => {
  cube.reset();
  movesEl.textContent = '0';
  scrambleLenEl.textContent = '—';
  scrambleTextEl.textContent = '打乱公式将显示在这里';
});

function onResize(): void {
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

// Prefetch 3×3 solver in background
void ensureSolver().then(() => {
  if (statusEl.textContent === '就绪') {
    statusEl.textContent = '就绪 · 3×3 求解器已加载';
  }
});
