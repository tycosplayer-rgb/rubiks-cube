import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Puzzle } from './puzzle';

/** 智能：点到色块拧层、空白转视角；视角：只旋转；拧动：只拧层 */
export type ControlMode = 'smart' | 'orbit' | 'twist';

export interface InteractionHandle {
  dispose: () => void;
  setMode: (mode: ControlMode) => void;
  getMode: () => ControlMode;
}

/**
 * Mouse / touch interaction:
 * - One finger on cube → layer turn (orbit rotate disabled for that gesture)
 * - One finger on empty / background → orbit
 * - Two fingers → always orbit (pinch + rotate), never layer turn
 * - Optional forced modes: orbit-only / twist-only
 *
 * Uses capture-phase pointerdown so OrbitControls sees the correct
 * enableRotate flag before it handles the same event (bubble).
 */
export function setupInteraction(
  dom: HTMLElement,
  camera: THREE.PerspectiveCamera,
  cube: Puzzle,
  controls: OrbitControls,
  initialMode: ControlMode = 'smart',
): InteractionHandle {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let uiMode: ControlMode = initialMode;
  let gesture: 'none' | 'orbit' | 'turn' | 'pending' = 'none';
  let startX = 0;
  let startY = 0;
  let startHit: ReturnType<Puzzle['pickCubie']> = null;
  let startPoint = new THREE.Vector3();
  /** Raised so tiny finger jitter does not commit a turn */
  const THRESH = 28;
  const activePointers = new Map<number, { x: number; y: number }>();

  function setOrbitAllowed(allow: boolean): void {
    if (uiMode === 'twist') {
      controls.enableRotate = false;
      controls.enableZoom = false;
      return;
    }
    if (uiMode === 'orbit') {
      controls.enableRotate = true;
      controls.enableZoom = true;
      return;
    }
    // smart
    controls.enableRotate = allow;
    controls.enableZoom = allow || activePointers.size >= 2;
  }

  function setPointerFromClient(clientX: number, clientY: number): void {
    const rect = dom.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  }

  function rayPick(clientX: number, clientY: number) {
    setPointerFromClient(clientX, clientY);
    raycaster.setFromCamera(pointer, camera);
    return cube.pickCubie(raycaster);
  }

  function forceOrbit(): void {
    gesture = 'orbit';
    startHit = null;
    setOrbitAllowed(true);
  }

  function beginTurnPending(hit: NonNullable<ReturnType<Puzzle['pickCubie']>>, x: number, y: number): void {
    gesture = 'pending';
    startHit = hit;
    startPoint.copy(hit.point);
    startX = x;
    startY = y;
    setOrbitAllowed(false);
  }

  function onPointerDownCapture(e: PointerEvent): void {
    activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two or more pointers → always orbit; cancel pending twist
    if (activePointers.size >= 2) {
      forceOrbit();
      return;
    }

    if (cube.isBusy()) {
      // While animating, allow orbit so the user can still look around
      if (uiMode === 'twist') {
        gesture = 'none';
        startHit = null;
        setOrbitAllowed(false);
      } else {
        forceOrbit();
      }
      return;
    }

    if (uiMode === 'orbit') {
      forceOrbit();
      return;
    }

    const hit = rayPick(e.clientX, e.clientY);

    if (uiMode === 'twist') {
      if (hit) {
        beginTurnPending(hit, e.clientX, e.clientY);
        try {
          dom.setPointerCapture(e.pointerId);
        } catch {
          /* ignore */
        }
      } else {
        gesture = 'none';
        startHit = null;
        setOrbitAllowed(false);
      }
      return;
    }

    // smart
    if (hit) {
      beginTurnPending(hit, e.clientX, e.clientY);
      try {
        dom.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    } else {
      forceOrbit();
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePointers.has(e.pointerId)) {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (activePointers.size >= 2 && (gesture === 'pending' || gesture === 'turn')) {
      forceOrbit();
      return;
    }

    if (gesture !== 'pending' || !startHit) return;
    if (cube.isBusy()) {
      gesture = 'none';
      startHit = null;
      setOrbitAllowed(uiMode !== 'twist');
      return;
    }

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) < THRESH) return;

    gesture = 'turn';
    const screenDelta = new THREE.Vector2(dx, dy);
    const move = cube.dragToMove(startHit.mesh, startHit.faceNormal, screenDelta, camera, startPoint);
    if (move) {
      gesture = 'none';
      startHit = null;
      setOrbitAllowed(false);
      void cube.applyMove(move, true).finally(() => {
        if (gesture === 'none' && activePointers.size === 0) {
          setOrbitAllowed(uiMode !== 'twist');
        }
      });
    }
  }

  function onPointerUp(e: PointerEvent): void {
    if (!activePointers.has(e.pointerId) && gesture === 'none') {
      // Duplicate lostpointercapture after pointerup — ignore
      return;
    }
    activePointers.delete(e.pointerId);
    try {
      if (typeof dom.hasPointerCapture === 'function' && dom.hasPointerCapture(e.pointerId)) {
        dom.releasePointerCapture(e.pointerId);
      }
    } catch {
      /* ignore */
    }

    if (activePointers.size >= 2) {
      forceOrbit();
      return;
    }
    if (activePointers.size === 1) {
      gesture = 'orbit';
      startHit = null;
      setOrbitAllowed(uiMode !== 'twist');
      return;
    }

    gesture = 'none';
    startHit = null;
    setOrbitAllowed(uiMode !== 'twist');
  }

  controls.enabled = true;
  setOrbitAllowed(uiMode !== 'twist');

  dom.addEventListener('pointerdown', onPointerDownCapture, true);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);

  return {
    dispose: () => {
      dom.removeEventListener('pointerdown', onPointerDownCapture, true);
      dom.removeEventListener('pointermove', onPointerMove);
      dom.removeEventListener('pointerup', onPointerUp);
      dom.removeEventListener('pointercancel', onPointerUp);
      activePointers.clear();
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.enabled = true;
    },
    setMode: (mode: ControlMode) => {
      uiMode = mode;
      gesture = 'none';
      startHit = null;
      setOrbitAllowed(mode !== 'twist');
    },
    getMode: () => uiMode,
  };
}
