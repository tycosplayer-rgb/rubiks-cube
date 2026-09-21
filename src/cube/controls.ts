import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { RubiksCube } from './RubiksCube';

/**
 * Mouse / touch interaction:
 * - Drag on cube face → layer turn
 * - Drag empty space / two-finger → orbit camera
 */
export function setupInteraction(
  dom: HTMLElement,
  camera: THREE.PerspectiveCamera,
  cube: RubiksCube,
  controls: OrbitControls,
): () => void {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  let mode: 'none' | 'orbit' | 'turn' | 'pending' = 'none';
  let startX = 0;
  let startY = 0;
  let startHit: ReturnType<RubiksCube['pickCubie']> = null;
  let startPoint = new THREE.Vector3();
  const THRESH = 18; // px before deciding turn vs cancel

  function setPointer(e: PointerEvent | Touch): void {
    const rect = dom.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function onPointerDown(e: PointerEvent): void {
    if (cube.isBusy()) return;

    // two-finger / secondary → orbit only
    if (e.pointerType === 'touch' && (e as PointerEvent).isPrimary === false) {
      mode = 'orbit';
      controls.enabled = true;
      return;
    }

    // track multi-touch via touches length on touch events — handled separately
    setPointer(e);
    raycaster.setFromCamera(pointer, camera);
    startHit = cube.pickCubie(raycaster);
    startX = e.clientX;
    startY = e.clientY;

    if (startHit) {
      mode = 'pending';
      startPoint.copy(startHit.point);
      controls.enabled = false;
    } else {
      mode = 'orbit';
      controls.enabled = true;
    }
  }

  function onPointerMove(e: PointerEvent): void {
    if (mode !== 'pending' || !startHit) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.hypot(dx, dy) < THRESH) return;

    mode = 'turn';
    // compute drag in world using camera basis
    setPointer(e);
    raycaster.setFromCamera(pointer, camera);
    // plane at start point with face normal
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(startHit.faceNormal, startPoint);
    const now = new THREE.Vector3();
    raycaster.ray.intersectPlane(plane, now);
    if (!now) return;
    const drag = now.clone().sub(startPoint);
    const move = cube.dragToMove(startHit.mesh, startHit.faceNormal, drag);
    if (move) {
      mode = 'none';
      controls.enabled = true;
      startHit = null;
      void cube.applyMove(move, true);
    }
  }

  function onPointerUp(): void {
    if (mode === 'pending' || mode === 'turn') {
      controls.enabled = true;
    }
    mode = 'none';
    startHit = null;
  }

  // Touch: two fingers → force orbit
  let touchCount = 0;
  function onTouchStart(e: TouchEvent): void {
    touchCount = e.touches.length;
    if (touchCount >= 2) {
      mode = 'orbit';
      controls.enabled = true;
      startHit = null;
    }
  }
  function onTouchEnd(e: TouchEvent): void {
    touchCount = e.touches.length;
  }

  dom.addEventListener('pointerdown', onPointerDown);
  dom.addEventListener('pointermove', onPointerMove);
  dom.addEventListener('pointerup', onPointerUp);
  dom.addEventListener('pointercancel', onPointerUp);
  dom.addEventListener('touchstart', onTouchStart, { passive: true });
  dom.addEventListener('touchend', onTouchEnd, { passive: true });

  return () => {
    dom.removeEventListener('pointerdown', onPointerDown);
    dom.removeEventListener('pointermove', onPointerMove);
    dom.removeEventListener('pointerup', onPointerUp);
    dom.removeEventListener('pointercancel', onPointerUp);
    dom.removeEventListener('touchstart', onTouchStart);
    dom.removeEventListener('touchend', onTouchEnd);
  };
}
