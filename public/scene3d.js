// Milestone 6: 3D view of a scene. It renders the same per-viewer scene data the 2D board gets (tokens, walls, fog),
// so no camera can show anything the server did not send. 1 unit = 1 grid cell (5 ft); walls are 2 cells high.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';

const EYE = 1.1;         // first-person eye height (about 5.5 ft)
const WALL_H = 2;
const RADIUS = 0.25;     // how close the first-person camera may get to a wall
const SPEED = 3;         // cells per second

export function mount(host, view, { onMove, mode = 'tactical', userId } = {}) {
  const width = host.clientWidth || 800;
  const height = Math.round(width * 0.65);
  let renderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch {
    host.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'This browser cannot show 3D (WebGL is unavailable). Use the 2D board.' }));
    return null;
  }
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.domElement.tabIndex = 0;
  renderer.domElement.setAttribute('aria-label', '3D scene. Tactical: drag to orbit, scroll to zoom. First person: click to look around, W A S D to move, Q and E to turn, Escape to release the mouse.');
  host.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#1d1a16');
  scene.add(new THREE.HemisphereLight('#ffffff', '#554433', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 1.4);
  sun.position.set(10, 20, 5);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(70, width / height, 0.05, 500);
  const world = new THREE.Group(); // rebuilt on every update
  scene.add(world);

  let state = view;
  let current = null; // 'tactical' | 'first'
  let orbit = null;
  let look = null;
  let walls = [];
  const keys = new Set();
  let lastSent = 0;
  let moved = false;
  // Your token: for players the server marks it `mine`; GMs (for whom every token is `mine`) walk freely instead.
  const me = () => state.tokens.find((t) => (t.controlledBy ? t.controlledBy.includes(userId) : t.mine)) || null;

  function label(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.font = 'bold 28px system-ui, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 6; g.strokeStyle = '#000'; g.strokeText(text, 128, 42);
    g.fillStyle = '#fff'; g.fillText(text, 128, 42);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    s.scale.set(1.6, 0.4, 1);
    return s;
  }

  function build() {
    for (const o of [...world.children]) { world.remove(o); o.traverse((x) => { x.geometry?.dispose(); x.material?.map?.dispose(); x.material?.dispose?.(); }); }
    const { scene: s, tokens, encounter, role } = state;
    // Floor, with the background image when the browser may load it (CORS); otherwise plain.
    const floorMat = new THREE.MeshStandardMaterial({ color: '#d9cdb8' });
    if (s.backgroundUrl) new THREE.TextureLoader().setCrossOrigin('anonymous').load(s.backgroundUrl, (tx) => { tx.colorSpace = THREE.SRGBColorSpace; floorMat.map = tx; floorMat.color.set('#ffffff'); floorMat.needsUpdate = true; });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(s.cols, s.rows), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(s.cols / 2, 0, s.rows / 2);
    world.add(floor);
    if (s.grid === 'square') {
      const pts = [];
      for (let x = 0; x <= s.cols; x++) pts.push(x, 0.002, 0, x, 0.002, s.rows);
      for (let z = 0; z <= s.rows; z++) pts.push(0, 0.002, z, s.cols, 0.002, z);
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      world.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: '#000000', transparent: true, opacity: 0.25 })));
    }
    // Fog: unexplored cells are black for players (dimmed for the GM).
    if (s.fog.enabled) {
      const open = new Set(s.fog.revealed);
      const hidden = [];
      for (let x = 0; x < s.cols; x++) for (let z = 0; z < s.rows; z++) if (!open.has(`${x},${z}`)) hidden.push([x, z]);
      if (hidden.length) {
        const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: '#000000', transparent: role === 'gm', opacity: role === 'gm' ? 0.45 : 1 }), hidden.length);
        const o = new THREE.Object3D();
        hidden.forEach(([x, z], i) => { o.position.set(x + 0.5, 0.004, z + 0.5); o.rotation.set(-Math.PI / 2, 0, 0); o.updateMatrix(); m.setMatrixAt(i, o.matrix); });
        world.add(m);
      }
    }
    walls = s.walls || [];
    const wallMat = new THREE.MeshStandardMaterial({ color: '#8a7d6b' });
    for (const w of walls) {
      const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
      const box = new THREE.Mesh(new THREE.BoxGeometry(w.y1 === w.y2 ? len : 0.12, WALL_H, w.y1 === w.y2 ? 0.12 : len), wallMat);
      box.position.set((w.x1 + w.x2) / 2, WALL_H / 2, (w.y1 + w.y2) / 2);
      box.userData.wall = true;
      world.add(box);
    }
    const mine = me();
    for (const t of tokens) {
      const r = t.size / 2;
      const g = new THREE.Group();
      g.position.set(t.x + r, 0, t.y + r);
      g.userData.token = t.id;
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.3 * t.size, 0.8 * t.size, 4, 12),
        new THREE.MeshStandardMaterial({ color: t.color, transparent: t.visibility === 'gm', opacity: t.visibility === 'gm' ? 0.6 : 1 }));
      body.position.y = 0.3 * t.size + 0.4 * t.size;
      g.add(body);
      const tag = label(t.name);
      tag.position.y = 1.6 * t.size + 0.2;
      g.add(tag);
      if (encounter && encounter.turnTokenId === t.id) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(0.42 * t.size, 0.5 * t.size, 32), new THREE.MeshBasicMaterial({ color: '#ffd54a', side: THREE.DoubleSide }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.01;
        g.add(ring);
      }
      if (current === 'first' && mine && t.id === mine.id) g.visible = false; // you do not see your own body in first person
      world.add(g);
    }
  }

  function setMode(next) {
    if (orbit) { orbit.dispose(); orbit = null; }
    if (look) { look.unlock(); look.dispose(); look = null; }
    current = next;
    const s = state.scene;
    if (next === 'tactical') {
      camera.position.set(s.cols / 2, Math.max(s.cols, s.rows) * 0.9, s.rows / 2 + Math.max(s.cols, s.rows) * 0.35);
      orbit = new OrbitControls(camera, renderer.domElement);
      orbit.target.set(s.cols / 2, 0, s.rows / 2);
      orbit.maxPolarAngle = Math.PI * 0.45; // never under the floor
      orbit.minDistance = 2;
      orbit.maxDistance = Math.max(s.cols, s.rows) * 2;
      orbit.update();
    } else {
      const t = me();
      const start = t ? [t.x + t.size / 2, t.y + t.size / 2] : [s.cols / 2, s.rows / 2];
      camera.position.set(start[0], EYE, start[1]);
      camera.rotation.set(0, 0, 0);
      look = new PointerLockControls(camera, renderer.domElement);
      renderer.domElement.addEventListener('click', lockOnClick);
    }
    build();
  }
  const lockOnClick = () => { if (look && !look.isLocked) look.lock(); };

  // Distance from point (px, pz) to a wall segment, in cells.
  const distToWall = (px, pz, w) => {
    const [ax, az, bx, bz] = [w.x1, w.y1, w.x2, w.y2];
    const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (pz - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
    return Math.hypot(px - (ax + t * (bx - ax)), pz - (az + t * (bz - az)));
  };
  const blocked = (x, z) => x < RADIUS || z < RADIUS || x > state.scene.cols - RADIUS || z > state.scene.rows - RADIUS || walls.some((w) => distToWall(x, z, w) < RADIUS);

  function stepFirstPerson(dt) {
    const turn = (keys.has('q') ? 1 : 0) - (keys.has('e') ? 1 : 0);
    if (turn) {
      const e = new THREE.Euler(0, 0, 0, 'YXZ').setFromQuaternion(camera.quaternion);
      e.y += turn * 1.8 * dt;
      camera.quaternion.setFromEuler(e);
    }
    const fwd = (keys.has('w') || keys.has('arrowup') ? 1 : 0) - (keys.has('s') || keys.has('arrowdown') ? 1 : 0);
    const side = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
    if (!fwd && !side) return;
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    const step = dir.multiplyScalar(fwd).add(right.multiplyScalar(side)).normalize().multiplyScalar(SPEED * dt);
    // Slide along walls: try each axis separately.
    const p = camera.position;
    if (!blocked(p.x + step.x, p.z)) p.x += step.x;
    if (!blocked(p.x, p.z + step.z)) p.z += step.z;
    moved = true;
  }

  function syncToken(now) {
    const t = me();
    if (!moved || !t || !onMove || now - lastSent < 400) return;
    lastSent = now;
    moved = false;
    const half = t.size / 2;
    const x = Math.min(state.scene.cols - t.size, Math.max(0, camera.position.x - half));
    const y = Math.min(state.scene.rows - t.size, Math.max(0, camera.position.z - half));
    onMove(t.id, state.scene.grid === 'square' ? Math.round(x) : x, state.scene.grid === 'square' ? Math.round(y) : y);
  }

  const onKey = (down) => (e) => {
    if (current !== 'first' || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      e.preventDefault();
      if (down) keys.add(k); else keys.delete(k);
    }
  };
  const keydown = onKey(true), keyup = onKey(false);
  document.addEventListener('keydown', keydown);
  document.addEventListener('keyup', keyup);

  let raf = 0;
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (current === 'first') { stepFirstPerson(dt); syncToken(now); }
    if (orbit) orbit.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(loop);
  };
  setMode(mode);
  raf = requestAnimationFrame(loop);

  return {
    update(next) { state = next; build(); },
    setMode,
    get mode() { return current; },
    camera,
    world,
    dispose() {
      cancelAnimationFrame(raf);
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('keyup', keyup);
      renderer.domElement.removeEventListener('click', lockOnClick);
      if (orbit) orbit.dispose();
      if (look) { look.unlock(); look.dispose(); }
      renderer.dispose();
    },
  };
}
