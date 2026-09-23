import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LayerDragSession, Puzzle } from './puzzle';

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
 * - Pyraminx: continuous axis-locked layer follow + magnetic snap on release
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
  let gesture: 'none' | 'orbit' | 'turn' | 'pending' | 'turnDrag' = 'none';
  let startX = 0;
  let startY = 0;
  let startHit: ReturnType<Puzzle['pickCubie']> = null;
  let startPoint = new THREE.Vector3();
  let dragSession: LayerDragSession | null = null;

  const supportsContinuous =
    cube.puzzleType === 'pyraminx' && typeof cube.beginLayerDrag === 'function';
  /** Continuous Pyraminx: 5px commit; discrete cube/megaminx: 28px. */
  const THRESH = supportsContinuous ? 5 : 28;
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

  function cancelContinuousDrag(): void {
    if (dragSession && cube.cancelLayerDrag) {
      cube.cancelLayerDrag(dragSession);
    }
    dragSession = null;
  }

  function forceOrbit(): void {
    if (gesture === 'turnDrag') {
      cancelContinuousDrag();
    }
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

    // Two or more pointers → always orbit; cancel pending / mid-drag twist
    if (activePointers.size >= 2) {
      forceOrbit();
      return;
    }

    if (cube.isBusy()) {
      // While animating / snapping, allow orbit so the user can still look around
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

    if (
      activePointers.size >= 2 &&
      (gesture === 'pending' || gesture === 'turn' || gesture === 'turnDrag')
    ) {
      forceOrbit();
      return;
    }

    // Continuous follow while twisting
    if (gesture === 'turnDrag' && dragSession && cube.updateLayerDrag) {
      setPointerFromClient(e.clientX, e.clientY);
      cube.updateLayerDrag(dragSession, pointer.x, pointer.y, camera);
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

    if (supportsContinuous && cube.beginLayerDrag && cube.updateLayerDrag) {
      const session = cube.beginLayerDrag(startHit, camera);
      if (session) {
        gesture = 'turnDrag';
        dragSession = session;
        setPointerFromClient(e.clientX, e.clientY);
        cube.updateLayerDrag(session, pointer.x, pointer.y, camera);
        return;
      }
      // Fall through to discrete if begin failed
    }

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
      if (gesture === 'turnDrag') {
        cancelContinuousDrag();
      }
      gesture = 'orbit';
      startHit = null;
      setOrbitAllowed(uiMode !== 'twist');
      return;
    }

    // Continuous drag release → magnetic snap + commit
    if (gesture === 'turnDrag' && dragSession && cube.endLayerDrag) {
      const session = dragSession;
      dragSession = null;
      gesture = 'none';
      startHit = null;
      setOrbitAllowed(false);
      void cube.endLayerDrag(session).finally(() => {
        if (gesture === 'none' && activePointers.size === 0) {
          setOrbitAllowed(uiMode !== 'twist');
        }
      });
      return;
    }

    // pending under dead-zone → no move
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
      if (dragSession) cancelContinuousDrag();
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
      if (dragSession) cancelContinuousDrag();
      uiMode = mode;
      gesture = 'none';
      startHit = null;
      setOrbitAllowed(mode !== 'twist');
    },
    getMode: () => uiMode,
  };
}
