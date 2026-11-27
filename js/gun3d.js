// 3D pistol for the finger-gun pad, rendered offscreen with three.js and drawn onto the main canvas.
// The model is built from primitives (no asset file): metal slide with serrations, sights and ejection port,
// open bore, polymer frame, trigger guard, raked grip. Its origin is the top of the grip (where the hand holds it),
// and the barrel points down +Z, i.e. straight at the camera.
import * as THREE from "../vendor/three-pistol.mjs";

const SIZE = 512;                              // offscreen render size in px (square)
let renderer, scene, camera, pivot, slide, muzzlePoint, ready = false, tried = false;

export function initGun3D() {                   // once: if WebGL isn't available the 3D pistol just stays off
  if (tried) return ready;
  tried = true;
  try {
    const canvas = document.createElement("canvas");
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new THREE.RoomEnvironment(), 0.04).texture;   // reflections for the metal
    pmrem.dispose();                             // the texture stays; the generator's working buffers go
    const key = new THREE.DirectionalLight(0xffffff, 2.4); key.position.set(1.6, 2.2, 2.6); scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fb8ff, 1.4); rim.position.set(-2.2, 1.2, -1.8); scene.add(rim);
    camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
    camera.position.set(0, 0, 3.4); camera.lookAt(0, 0, 0);
    buildPistol();
    ready = true;
  } catch (err) {
    console.warn("3D pistol unavailable (WebGL failed):", err);
  }
  return ready;
}

function buildPistol() {
  const metal = new THREE.MeshStandardMaterial({ color: 0x2e3238, metalness: 0.9, roughness: 0.3 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x15171a, metalness: 0.8, roughness: 0.45 });
  const brightMetal = new THREE.MeshStandardMaterial({ color: 0x8a9099, metalness: 1, roughness: 0.22 });
  const polymer = new THREE.MeshStandardMaterial({ color: 0x18191c, metalness: 0.1, roughness: 0.78 });
  const bore = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const box = (w, h, d, r, mat) => new THREE.Mesh(r ? new THREE.RoundedBoxGeometry(w, h, d, 3, r) : new THREE.BoxGeometry(w, h, d), mat);
  const at = (m, x, y, z) => { m.position.set(x, y, z); return m; };

  pivot = new THREE.Group(); scene.add(pivot);
  const gun = new THREE.Group(); gun.position.set(0, 0.02, 0.3); pivot.add(gun);   // grip top -> pivot origin

  // slide (moves back on recoil)
  slide = new THREE.Group(); gun.add(slide);
  slide.add(at(box(0.17, 0.16, 1.0, 0.025, metal), 0, 0.08, 0.05));
  for (let i = 0; i < 7; i++) slide.add(at(box(0.176, 0.12, 0.012, 0, darkMetal), 0, 0.075, -0.42 + i * 0.022));   // rear serrations
  slide.add(at(box(0.012, 0.07, 0.22, 0, darkMetal), 0.085, 0.1, 0.12));             // ejection port (right side)
  slide.add(at(box(0.026, 0.035, 0.045, 0, darkMetal), 0, 0.175, 0.5));             // front sight
  slide.add(at(box(0.045, 0.035, 0.035, 0, darkMetal), -0.045, 0.175, -0.4));        // rear sight, two posts
  slide.add(at(box(0.045, 0.035, 0.035, 0, darkMetal), 0.045, 0.175, -0.4));

  // barrel crown + bore, facing the camera
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.05, 40), brightMetal);
  crown.rotation.x = Math.PI / 2; gun.add(at(crown, 0, 0.085, 0.57));
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.034, 32), bore);
  gun.add(at(hole, 0, 0.085, 0.5965));
  muzzlePoint = new THREE.Object3D(); gun.add(at(muzzlePoint, 0, 0.085, 0.6));

  // frame, rail, trigger guard, trigger
  gun.add(at(box(0.15, 0.09, 0.8, 0.02, polymer), 0, -0.035, 0.12));
  gun.add(at(box(0.13, 0.045, 0.26, 0.012, polymer), 0, -0.095, 0.38));
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.088, 0.016, 10, 28, Math.PI), polymer);
  guard.rotateY(Math.PI / 2); guard.rotateX(Math.PI);                               // half ring under the frame, in the YZ plane
  gun.add(at(guard, 0, -0.08, 0.06));
  const trigger = at(box(0.022, 0.085, 0.028, 0.008, darkMetal), 0, -0.11, 0.05); trigger.rotation.x = 0.3; gun.add(trigger);

  // raked grip with magazine base plate and beavertail
  const grip = at(box(0.15, 0.56, 0.27, 0.045, polymer), 0, -0.32, -0.29); grip.rotation.x = 0.28; gun.add(grip);
  grip.add(at(box(0.165, 0.045, 0.29, 0.015, darkMetal), 0, -0.29, 0));
  gun.add(at(box(0.13, 0.05, 0.12, 0.02, polymer), 0, -0.04, -0.47));
}

// Renders the pistol and returns the offscreen canvas plus the muzzle position in its pixels.
// yaw/pitch aim the barrel (0,0 = straight at the camera); kick flips the muzzle up; back slides the slide.
const tmp = new THREE.Vector3();
export function renderGun({ yaw = 0, pitch = 0, kick = 0, back = 0 }) {
  if (!ready) return null;
  pivot.rotation.set(pitch - kick, yaw, 0, "YXZ");
  slide.position.z = -back;
  renderer.render(scene, camera);
  muzzlePoint.getWorldPosition(tmp).project(camera);
  return { canvas: renderer.domElement, size: SIZE, muzzle: [(tmp.x + 1) / 2 * SIZE, (1 - tmp.y) / 2 * SIZE] };
}
