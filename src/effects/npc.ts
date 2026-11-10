/**
 * People who walk a site: a rigged glTF character with a walk and an idle (made outside the repo by the pipeline's
 * npc tools: a MakeHuman body, CMU motion capture), wandering between spots on open ground at an unhurried pace and
 * pausing to look around. When the visitor comes near, in front of her, she turns her head to look at them. Built in the effects' metric frame (metres, y up, the site at the origin; see
 * siteAnalysis.ts), whose ground heights, walls and bushes tell where she can walk.
 *
 * She's an ordinary mesh, so the splats in front of her (walls, bushes) cover her as they cover the terrain.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Daylight } from '@/effects/daylight';
import type { SiteAnalysis } from '@/effects/siteAnalysis';
import type { SceneNpc } from '@/types/cesium';
import { assetUrl } from '@/utils/assetUrl';

const NPC = {
  // The ground she can walk on (see navGrid): cells this wide (metres)
  navCell: 0.2,
  wallClearance: 0.3,
  bushClearance: 0.15,
  gapFill: 0.3,
  maxStep: 0.12,
  // Her pace (metres a second) unless the site says otherwise, and how fast she turns (degrees a second)
  pace: 0.26,
  turnRate: 40,
  // Turns sharper than this she takes in place, stepping, before walking on
  turnInPlace: 70,
  // How long she stands at a spot (seconds), and how far her next spot is (metres)
  pause: [6, 16] as const,
  hop: [1.5, 8] as const,
  // How often she heads for the walls rather than open ground
  toWalls: 0.5,
  // She waits when the visitor's camera is this close in front of her (metres)
  personalSpace: 0.9,
  // Crossfade between walking and standing (seconds)
  blend: 0.7,
  // She looks at the visitor within this distance (metres) and this far round from her front (degrees), turning her
  // head and neck at most lookYaw sideways and lookPitch up or down, and easing in and out at lookRate (per second)
  lookDistance: 5,
  lookAround: 110,
  lookYaw: 70,
  lookPitch: 25,
  lookRate: 1.5,
};

const between = ([a, b]: readonly [number, number]) => a + Math.random() * (b - a);

export type Npc = {
  /** Call every frame: `camera` is the visitor's eye in the metric frame */
  update: (deltaSeconds: number, camera: THREE.Vector3) => void;
  /** Where she stands and the top of her head (metric frame), for her shadow on the splats */
  feet: THREE.Vector3;
  head: THREE.Vector3;
  dispose: () => void;
};

type Grid = { n: number; half: number; open: Uint8Array; nearWall: Uint8Array };

/** For each cell of an n x n grid, how many cells of `mask` are within `r` cells (a square window) */
function windowCounts(mask: Uint8Array, n: number, r: number) {
  const sum = new Int32Array((n + 1) * (n + 1));
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      sum[(z + 1) * (n + 1) + x + 1] = mask[z * n + x] + sum[z * (n + 1) + x + 1] + sum[(z + 1) * (n + 1) + x] - sum[z * (n + 1) + x];
    }
  }
  const out = new Int32Array(n * n);
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(n, x + r + 1), z0 = Math.max(0, z - r), z1 = Math.min(n, z + r + 1);
      out[z * n + x] = sum[z1 * (n + 1) + x1] - sum[z0 * (n + 1) + x1] - sum[z1 * (n + 1) + x0] + sum[z0 * (n + 1) + x0];
    }
  }
  return out;
}

/**
 * Where she can walk: within `radius` of the site's centre, on ground the splat covers (its small gaps, where bigger
 * splats draw the ground, filled up to `gapFill`), clear of walls by `wallClearance` and of bushes by
 * `bushClearance`, with no step between neighbouring cells higher than `maxStep`
 */
function navGrid(analysis: SiteAnalysis, radius: number): Grid {
  const { n: fn, cell } = analysis;
  const near = (mask: Uint8Array, metres: number) => {
    const counts = windowCounts(mask, fn, Math.ceil(metres / cell));
    return Uint8Array.from(counts, c => (c > 0 ? 1 : 0));
  };
  const wallNear = near(analysis.wall, NPC.wallClearance);
  const bushNear = near(analysis.bush, NPC.bushClearance);
  const looking = near(analysis.wall, 1.5);
  // Coverage with its small gaps closed: grown, then shrunk back
  const gap = Math.ceil(NPC.gapFill / cell);
  const grown = Uint8Array.from(windowCounts(analysis.captured, fn, gap), c => (c > 0 ? 1 : 0));
  const covered = Uint8Array.from(windowCounts(Uint8Array.from(grown, v => 1 - v), fn, gap), c => (c === 0 ? 1 : 0));

  const half = Math.min(radius, analysis.half);
  const n = Math.ceil((2 * half) / NPC.navCell);
  const blocked = new Uint8Array(n * n);
  const nearWall = new Uint8Array(n * n);
  const height = new Float32Array(n * n).fill(NaN);
  const sub = Math.max(1, Math.round(NPC.navCell / cell));
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -half + (i + 0.5) * NPC.navCell;
      const z = -half + (j + 0.5) * NPC.navCell;
      const k = j * n + i;
      const centre = analysis.cellOf(x, z);
      if (Math.hypot(x, z) > radius || centre < 0) {
        blocked[k] = 1;
        continue;
      }
      const cx = centre % fn;
      const cz = Math.floor(centre / fn);
      let cov = 0;
      let cells = 0;
      for (let dz = -(sub >> 1); dz <= sub >> 1; dz++) {
        for (let dx = -(sub >> 1); dx <= sub >> 1; dx++) {
          const ax = cx + dx;
          const az = cz + dz;
          if (ax < 0 || az < 0 || ax >= fn || az >= fn) continue;
          const a = az * fn + ax;
          if (wallNear[a] || bushNear[a]) blocked[k] = 1;
          if (looking[a]) nearWall[k] = 1;
          cov += covered[a];
          cells++;
        }
      }
      if (cov < cells * 0.5) blocked[k] = 1;
      height[k] = analysis.groundAt(x, z);
    }
  }
  // Too steep: a step to any neighbour higher than maxStep
  const open = new Uint8Array(n * n);
  for (let j = 1; j < n - 1; j++) {
    for (let i = 1; i < n - 1; i++) {
      const k = j * n + i;
      if (blocked[k]) continue;
      let ok = true;
      for (const d of [-1, 1, -n, n]) {
        if (!Number.isNaN(height[k + d]) && Math.abs(height[k + d] - height[k]) > NPC.maxStep) ok = false;
      }
      open[k] = ok ? 1 : 0;
    }
  }
  return { n, half, open, nearWall };
}

const toCell = (g: Grid, x: number, z: number) => {
  const i = Math.floor((x + g.half) / NPC.navCell);
  const j = Math.floor((z + g.half) / NPC.navCell);
  return i < 0 || j < 0 || i >= g.n || j >= g.n ? -1 : j * g.n + i;
};
const cellCentre = (g: Grid, k: number) =>
  new THREE.Vector2(-g.half + ((k % g.n) + 0.5) * NPC.navCell, -g.half + (Math.floor(k / g.n) + 0.5) * NPC.navCell);

/** A* over the open cells (8 neighbours), then shortened: each waypoint the farthest one still in straight sight */
function findPath(g: Grid, from: THREE.Vector2, to: number): THREE.Vector2[] | null {
  const start = toCell(g, from.x, from.y);
  if (start < 0 || !g.open[start] || !g.open[to]) return null;
  const n = g.n;
  const cost = new Float32Array(n * n).fill(Infinity);
  const came = new Int32Array(n * n).fill(-1);
  const closed = new Uint8Array(n * n);
  const heap: [number, number][] = [];
  const push = (k: number, f: number) => {
    heap.push([f, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top[1];
  };
  const tx = to % n;
  const tz = Math.floor(to / n);
  const h = (k: number) => {
    const dx = Math.abs((k % n) - tx);
    const dz = Math.abs(Math.floor(k / n) - tz);
    return Math.max(dx, dz) + 0.414 * Math.min(dx, dz);
  };
  cost[start] = 0;
  push(start, h(start));
  while (heap.length) {
    const k = pop();
    if (k === to) break;
    if (closed[k]) continue;
    closed[k] = 1;
    const x = k % n;
    const z = Math.floor(k / n);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
        const m = nz * n + nx;
        // No cutting corners past blocked cells
        if (!g.open[m] || (dx && dz && (!g.open[z * n + nx] || !g.open[nz * n + x]))) continue;
        const c = cost[k] + (dx && dz ? 1.414 : 1);
        if (c < cost[m]) {
          cost[m] = c;
          came[m] = k;
          push(m, c + h(m));
        }
      }
    }
  }
  if (came[to] < 0 && to !== start) return null;
  const cells: number[] = [];
  for (let k = to; k !== -1; k = came[k]) cells.unshift(k);
  const points = cells.map(k => cellCentre(g, k));
  points[0] = from.clone();
  const clear = (a: THREE.Vector2, b: THREE.Vector2) => {
    const steps = Math.ceil(a.distanceTo(b) / (NPC.navCell * 0.5));
    for (let s = 1; s < steps; s++) {
      const p = a.clone().lerp(b, s / steps);
      const k = toCell(g, p.x, p.y);
      if (k < 0 || !g.open[k]) return false;
    }
    return true;
  };
  const path = [points[0]];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1 && !clear(points[i], points[j])) j--;
    path.push(points[j]);
    i = j;
  }
  return path;
}

/**
 * Loads `npc.model` and sets her walking in `parent` (the metric frame). `radius` (metres) bounds where she goes:
 * within the splat's detailed ground. `daylight` lights her and casts her shadow on the splats.
 */
export async function createNpc(npc: SceneNpc, parent: THREE.Object3D, analysis: SiteAnalysis, radius: number,
  daylight: Daylight): Promise<Npc> {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(assetUrl(npc.model));
  const body = gltf.scene;
  body.traverse(object => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false; // skinned: her bounds move with the animation
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      // Cut-out, not blended: blended meshes are drawn with the splats, which don't write depth, so they'd show
      // through walls
      if (material.transparent) {
        material.transparent = false;
        material.alphaTest = 0.5;
        material.depthWrite = true;
      }
      // Cloth and skin, not plastic: the exported shoes shine like patent leather
      const standard = material as THREE.MeshStandardMaterial;
      if (standard.roughness !== undefined) standard.roughness = Math.max(standard.roughness, 0.75);
      daylight.light(material);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  });
  const group = new THREE.Group();
  group.name = `npc-${npc.name}`;
  group.add(body);
  parent.add(group);

  const mixer = new THREE.AnimationMixer(body);
  const clip = (name: string) => gltf.animations.find(a => a.name === name) ?? gltf.animations[0];
  const walk = mixer.clipAction(clip('walk'));
  const idle = mixer.clipAction(clip('idle'));
  walk.play();
  idle.play();
  walk.setEffectiveWeight(0);

  const grid = navGrid(analysis, radius);
  // She keeps to the largest stretch of ground she can walk across (a patch boxed in by bushes would strand her)
  const region = new Int32Array(grid.n * grid.n).fill(-1);
  const sizes: number[] = [];
  grid.open.forEach((v, k) => {
    if (!v || region[k] >= 0) return;
    const id = sizes.length;
    let size = 0;
    const queue = [k];
    region[k] = id;
    while (queue.length) {
      const c = queue.pop()!;
      size++;
      for (const d of [-1, 1, -grid.n, grid.n]) {
        const m = c + d;
        if (m >= 0 && m < grid.open.length && grid.open[m] && region[m] < 0) {
          region[m] = id;
          queue.push(m);
        }
      }
    }
    sizes.push(size);
  });
  const main = sizes.indexOf(Math.max(...sizes, 0));
  const openCells: number[] = [];
  const wallCells: number[] = [];
  region.forEach((id, k) => {
    if (id !== main || main < 0) return;
    openCells.push(k);
    if (grid.nearWall[k]) wallCells.push(k);
  });

  // Where she starts: an open spot a few metres from the centre
  const position = new THREE.Vector2();
  if (openCells.length) {
    const pick = openCells.filter(k => cellCentre(grid, k).length() > 2.5);
    position.copy(cellCentre(grid, (pick.length ? pick : openCells)[Math.floor(Math.random() * (pick.length || openCells.length))]));
  }
  let heading = Math.random() * Math.PI * 2;
  let y = analysis.groundAt(position.x, position.y);
  let state: 'idle' | 'walk' = 'idle';
  let timer = between(NPC.pause) * 0.5;
  let path: THREE.Vector2[] = [];
  let facing: number | null = null;
  let walkWeight = 0;
  let speed = 0;
  const pace = npc.pace ?? NPC.pace;

  const nextSpot = () => {
    const pool = Math.random() < NPC.toWalls && wallCells.length ? wallCells : openCells;
    for (let attempt = 0; attempt < 25; attempt++) {
      const k = pool[Math.floor(Math.random() * pool.length)];
      const d = cellCentre(grid, k).distanceTo(position);
      if (d < NPC.hop[0] || d > NPC.hop[1]) continue;
      const found = findPath(grid, position, k);
      if (found && found.length > 1) return found;
    }
    return null;
  };

  // The shortest turn from a to b, in radians
  const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
  const forward = new THREE.Vector2();

  // Where her face points in the head bone's own axes, from the rest pose (the body faces +z)
  const neck = body.getObjectByName('Neck1');
  const head = body.getObjectByName('Head');
  const face = new THREE.Vector3(0, 0, 1);
  if (head) {
    body.updateMatrixWorld(true);
    const inBody = body.getWorldQuaternion(new THREE.Quaternion()).invert()
      .multiply(head.getWorldQuaternion(new THREE.Quaternion()));
    face.applyQuaternion(inBody.invert());
  }
  let look = 0;
  const feet = new THREE.Vector3(0, -1000, 0);
  const top = new THREE.Vector3(0, -999, 0);
  const headAt = new THREE.Vector3();
  const want = new THREE.Vector3();
  const now = new THREE.Vector3();
  const final = new THREE.Vector3();
  const qa = new THREE.Quaternion();
  const qb = new THREE.Quaternion();
  const qc = new THREE.Quaternion();
  const turn = new THREE.Quaternion();
  /** Turns `bone` by `delta`, a rotation in world axes, on top of the pose the animation gave it */
  const rotateInWorld = (bone: THREE.Object3D, delta: THREE.Quaternion) => {
    bone.getWorldQuaternion(qa);
    bone.parent!.getWorldQuaternion(qb);
    bone.quaternion.copy(qb.invert().multiply(delta).multiply(qa));
    bone.updateWorldMatrix(false, true);
  };
  /** After the animation: her head turned toward the visitor's eye (`camera`, metric frame) when they're near */
  const lookAtVisitor = (dt: number, camera: THREE.Vector3) => {
    if (!head || !neck) return;
    parent.worldToLocal(head.getWorldPosition(headAt));
    want.copy(camera).sub(headAt);
    // In her body's axes (turned by her heading): how far round and how far up the visitor is
    const c = Math.cos(heading);
    const s = Math.sin(heading);
    const x = want.x * c - want.z * s;
    const z = want.x * s + want.z * c;
    const yaw = Math.atan2(x, z);
    const pitch = Math.atan2(want.y, Math.hypot(x, z));
    const near = want.length() < NPC.lookDistance && Math.abs(yaw) < THREE.MathUtils.degToRad(NPC.lookAround);
    look += ((near ? 1 : 0) - look) * Math.min(1, dt * NPC.lookRate);
    if (look < 0.01) return;
    const y = THREE.MathUtils.clamp(yaw, -THREE.MathUtils.degToRad(NPC.lookYaw), THREE.MathUtils.degToRad(NPC.lookYaw));
    const p = THREE.MathUtils.clamp(pitch, -THREE.MathUtils.degToRad(NPC.lookPitch), THREE.MathUtils.degToRad(NPC.lookPitch));
    const sx = Math.sin(y) * Math.cos(p);
    const sz = Math.cos(y) * Math.cos(p);
    want.set(sx * c + sz * s, Math.sin(p), -sx * s + sz * c).transformDirection(parent.matrixWorld);
    now.copy(face).applyQuaternion(head.getWorldQuaternion(qa));
    turn.setFromUnitVectors(now, want);
    final.copy(now).applyQuaternion(qc.identity().slerp(turn, look));
    // The neck takes part of the turn, the head the rest
    rotateInWorld(neck, qc.identity().slerp(turn, look * 0.4));
    now.copy(face).applyQuaternion(head.getWorldQuaternion(qa));
    rotateInWorld(head, qc.setFromUnitVectors(now, final));
  };

  return {
    update(dt, camera) {
      if (!openCells.length) return;
      const cam = new THREE.Vector2(camera.x, camera.z);
      let wantSpeed = 0;
      let stepping = false;
      if (state === 'idle') {
        timer -= dt;
        // Facing somewhere while she stands: the site, or the visitor when near
        if (facing !== null) {
          const turn = angleTo(heading, facing);
          const stepTurn = Math.sign(turn) * Math.min(Math.abs(turn), THREE.MathUtils.degToRad(NPC.turnRate) * dt);
          heading += stepTurn;
          stepping = Math.abs(turn) > THREE.MathUtils.degToRad(12);
          if (!stepping) facing = null;
        }
        if (timer <= 0) {
          const found = nextSpot();
          if (found) {
            path = found.slice(1);
            state = 'walk';
          } else {
            timer = between(NPC.pause);
          }
        }
      } else {
        const target = path[0];
        const toTarget = target.clone().sub(position);
        const want = Math.atan2(toTarget.x, toTarget.y);
        const turn = angleTo(heading, want);
        heading += Math.sign(turn) * Math.min(Math.abs(turn), THREE.MathUtils.degToRad(NPC.turnRate) * dt);
        // Sharp turns in place; otherwise slower the more she still has to turn
        const sharp = Math.abs(turn) > THREE.MathUtils.degToRad(NPC.turnInPlace);
        wantSpeed = sharp ? 0 : pace * Math.max(0.3, Math.cos(turn));
        stepping = sharp;
        // The visitor right in front of her: she waits
        forward.set(Math.sin(heading), Math.cos(heading));
        const toCam = cam.clone().sub(position);
        if (toCam.length() < NPC.personalSpace && toCam.dot(forward) > 0.3 * toCam.length()) wantSpeed = 0;
        if (toTarget.length() < 0.15) {
          path.shift();
          if (!path.length) {
            state = 'idle';
            timer = between(NPC.pause);
            // Then she turns to look at the site's centre, or at the visitor if near
            const lookAt = cam.distanceTo(position) < 6 && Math.random() < 0.5 ? cam : new THREE.Vector2(0, 0);
            facing = Math.atan2(lookAt.x - position.x, lookAt.y - position.y);
          }
        }
      }
      // Ease in and out of her pace
      speed += (wantSpeed - speed) * Math.min(1, dt * 2);
      forward.set(Math.sin(heading), Math.cos(heading));
      position.addScaledVector(forward, speed * dt);
      y += (analysis.groundAt(position.x, position.y) - y) * Math.min(1, dt * 6);
      group.position.set(position.x, y, position.y);
      group.rotation.y = heading;

      // The walk's feet match her speed; turning in place, it steps slowly
      const walking = speed > 0.02 || stepping;
      walkWeight += ((walking ? 1 : 0) - walkWeight) * Math.min(1, dt / NPC.blend * 2);
      walk.setEffectiveWeight(walkWeight);
      idle.setEffectiveWeight(1 - walkWeight);
      walk.timeScale = stepping && speed < 0.05 ? 0.55 : Math.max(speed / npc.walkSpeed, 0.3);
      mixer.update(dt);
      lookAtVisitor(dt, camera);
      feet.copy(group.position);
      if (head) parent.worldToLocal(head.getWorldPosition(top));
      else top.copy(feet).setY(feet.y + 1.5);
      top.y += 0.08;
      daylight.follow(feet, top.y - feet.y);
    },
    feet,
    head: top,
    dispose() {
      mixer.stopAllAction();
      group.removeFromParent();
      body.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
          material.dispose();
        }
      });
    },
  };
}
