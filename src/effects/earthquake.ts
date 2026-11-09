/**
 * Sismo: the captured walls themselves, cut into stone-sized pieces, each one a Rapier rigid body. The pieces are the
 * real splats; Spark's skinning moves each piece as one "bone", so no splat is copied or re-created.
 *
 * A demonstration only: a scan has no backs to its stones (splats cover only the faces that were photographed), so
 * fallen blocks look smeared from some sides.
 *
 * The physics runs in the effects' metric frame (metres, y up; see siteAnalysis.ts). The meshes are in the .splat
 * file's own frame, like the scene's main splat mesh, and go wherever it is.
 */
import * as THREE from 'three';
import { SplatFileType, SplatMesh, SplatSkinning } from '@sparkjsdev/spark';
import RAPIER from '@dimforge/rapier3d-compat';
import { selectSplats, type ParsedSplat, type SiteAnalysis } from '@/effects/siteAnalysis';

const STONE = 0.3; // metres, the size of a piece
const G = 9.81;

// Spark's skinning stores bone indices in 8 bits, so each mesh carries at most this many pieces
const BONES_PER_MESH = 255;

/** Flags the walls' splats: in wall cells, above the ground */
export function selectWallSplats(splat: ParsedSplat, site: SiteAnalysis) {
  const flags = new Uint8Array(splat.count);
  for (let i = 0; i < splat.count; i++) {
    const k = site.cellOf(splat.x(i), splat.z(i));
    if (k < 0 || !site.wall[k]) continue;
    const y = splat.y(i);
    if (y > site.ground[k] + 0.05 && y < site.top[k] + 0.3) flags[i] = 1;
  }
  return flags;
}

type Piece = { splats: number[]; center: number[]; half: number[]; restObject?: THREE.Vector3 };

// Pieces are blocks of a staggered grid, like a running bond: odd courses shift by half a block, so joints don't line
// up. Blocks never overlap, so the wall stands still until it is shaken. Splats of blocks that stay put lose their
// flag.
function buildPieces(splat: ParsedSplat, flags: Uint8Array, site: SiteAnalysis) {
  const voxelOf = (x: number, y: number, z: number) => {
    const iy = Math.floor(y / STONE);
    const offset = (iy & 1) * STONE * 0.5;
    return [Math.floor((x - offset) / STONE), iy, Math.floor((z - offset) / STONE)];
  };
  const byKey = new Map<string, { ix: number; iy: number; iz: number; splats: number[] }>();
  for (let i = 0; i < splat.count; i++) {
    if (!flags[i]) continue;
    const [ix, iy, iz] = voxelOf(splat.x(i), splat.y(i), splat.z(i));
    const key = `${ix},${iy},${iz}`;
    let voxel = byKey.get(key);
    if (!voxel) {
      voxel = { ix, iy, iz, splats: [] };
      byKey.set(key, voxel);
    }
    voxel.splats.push(i);
  }
  // Lowest course first, so each block can reach down to what it rests on: the wall is hollow in the scan, and a
  // block with nothing under it would just drop
  const RES = 0.05;
  const support = new Map<string, number>(); // top of the stack so far, per RES cell
  const cellKey = (x: number, z: number) => `${Math.floor(x / RES)},${Math.floor(z / RES)}`;
  const pieces: Piece[] = [];
  for (const voxel of [...byKey.values()].sort((a, b) => a.iy - b.iy)) {
    const offset = (voxel.iy & 1) * STONE * 0.5;
    const x0 = voxel.ix * STONE + offset;
    const z0 = voxel.iz * STONE + offset;
    const cx = x0 + STONE / 2;
    const cz = z0 + STONE / 2;
    // The highest ground under the block, so no corner starts inside the ground collider
    let ground = -Infinity;
    for (const [gx, gz] of [[x0, z0], [x0 + STONE, z0], [x0, z0 + STONE], [x0 + STONE, z0 + STONE], [cx, cz]]) {
      ground = Math.max(ground, site.groundAt(gx, gz));
    }
    const y1 = (voxel.iy + 1) * STONE;
    // Bedrock and tall outcrops stay put; so do sparse blocks (strays)
    if (voxel.splats.length < 25 || y1 - ground > 1.6 || y1 - ground < 0.06) {
      for (const i of voxel.splats) flags[i] = 0;
      continue;
    }
    // Sample the footprint at cell centres, so a block never reads its neighbour's cells
    const footprint: string[] = [];
    for (let a = 0; a < STONE / RES; a++) {
      for (let b = 0; b < STONE / RES; b++) footprint.push(cellKey(x0 + (a + 0.5) * RES, z0 + (b + 0.5) * RES));
    }
    let base = ground + 0.005;
    for (const key of footprint) base = Math.max(base, support.get(key) ?? -Infinity);
    const y0 = Math.min(base, y1 - 0.06);
    for (const key of footprint) support.set(key, y1);
    pieces.push({ splats: voxel.splats, center: [cx, (y0 + y1) / 2, cz], half: [STONE * 0.49, (y1 - y0) * 0.49, STONE * 0.49] });
  }
  return pieces;
}

// Static collider: the bare ground under and around the walls (where the blocks sit), the top surface everywhere else
// (outcrops, bushes)
function siteCollider(site: SiteAnalysis, step = 2) {
  const { n, cell, half } = site;
  const nearWall = new Uint8Array(n * n);
  const r = Math.ceil(0.7 / cell);
  for (let k = 0; k < n * n; k++) {
    if (!site.wall[k]) continue;
    const x = k % n;
    const z = Math.floor(k / n);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = x + dx;
        const zz = z + dz;
        if (xx >= 0 && zz >= 0 && xx < n && zz < n) nearWall[zz * n + xx] = 1;
      }
    }
  }
  const m = Math.floor(n / step);
  const vertices = new Float32Array(m * m * 3);
  for (let z = 0; z < m; z++) {
    for (let x = 0; x < m; x++) {
      const k = z * step * n + x * step;
      const y = nearWall[k] ? site.ground[k] - 0.005 : Math.max(site.ground[k], site.top[k]);
      vertices.set([-half + (x * step + 0.5) * cell, y, -half + (z * step + 0.5) * cell], (z * m + x) * 3);
    }
  }
  const indices = new Uint32Array((m - 1) * (m - 1) * 6);
  let o = 0;
  for (let z = 0; z < m - 1; z++) {
    for (let x = 0; x < m - 1; x++) {
      const a = z * m + x;
      indices.set([a, a + m, a + 1, a + 1, a + m, a + m + 1], o);
      o += 6;
    }
  }
  return RAPIER.ColliderDesc.trimesh(vertices, indices);
}

export type Earthquake = {
  // The walls' splats as skinned meshes, in the .splat file's frame
  meshes: SplatMesh[];
  // Which splats of the file went into `meshes`: the scene's main mesh should leave them out
  wallFlags: Uint8Array;
  // How far the camera shakes this frame (metres, metric frame)
  shake: THREE.Vector3;
  start: (strength: number) => void;
  reset: () => void;
  /** Advances the physics; call every frame */
  step: (deltaSeconds: number) => void;
  dispose: () => void;
};

/** Returns null when the site has no walls to shake */
export async function createEarthquake(splat: ParsedSplat, site: SiteAnalysis): Promise<Earthquake | null> {
  await RAPIER.init();
  const wallFlags = selectWallSplats(splat, site);
  const pieces = buildPieces(splat, wallFlags, site);
  if (!pieces.length) return null;

  const world = new RAPIER.World({ x: 0, y: -G, z: 0 });
  world.createCollider(siteCollider(site).setFriction(0.9));

  const s = splat.scale;
  const bodies = pieces.map(piece => {
    const [x, y, z] = piece.center;
    // Bones rest at the origin; a piece's pose is then "rotate about the origin, then move", which syncBones turns
    // into "rotate about the piece's centre" (in the file's frame: y and z flipped)
    piece.restObject = new THREE.Vector3(x / s, -y / s, -z / s);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
      .setLinearDamping(0.05).setAngularDamping(0.3));
    world.createCollider(RAPIER.ColliderDesc.cuboid(piece.half[0], piece.half[1], piece.half[2])
      .setDensity(2.2).setFriction(0.8).setRestitution(0.02), body);
    return body;
  });

  const restAll = () => {
    bodies.forEach((body, index) => {
      const [x, y, z] = pieces[index].center;
      body.setTranslation({ x, y, z }, false);
      body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, false);
      body.setLinvel({ x: 0, y: 0, z: 0 }, false);
      body.setAngvel({ x: 0, y: 0, z: 0 }, false);
    });
  };

  // Settle for a second without shaking. A block that moves on its own rests on something the scan doesn't show (a
  // buried footing, a hidden stone): pin it, so the wall stands still until the earthquake. The shaking releases
  // them: about half the pieces are pinned, and a wall that only half moves doesn't read as falling.
  world.timestep = 1 / 60;
  for (let i = 0; i < 60; i++) world.step();
  const moved = bodies.map((body, index) => {
    const t = body.translation();
    const [x, y, z] = pieces[index].center;
    return Math.hypot(t.x - x, t.y - y, t.z - z) > 0.08 || Math.abs(body.rotation().w) < Math.cos((8 * Math.PI) / 360);
  });
  const pin = () => {
    bodies.forEach((body, index) => {
      if (moved[index]) body.setBodyType(RAPIER.RigidBodyType.Fixed, false);
      else body.sleep();
    });
  };
  restAll();
  pin();

  // One skinned mesh per BONES_PER_MESH pieces; splat j of a mesh is the j-th splat of its pieces, in file order
  const identity = new THREE.Quaternion();
  const objectPosition = new THREE.Vector3();
  const groups: { mesh: SplatMesh; skinning: SplatSkinning; first: number; count: number }[] = [];
  for (let first = 0; first < pieces.length; first += BONES_PER_MESH) {
    const members = pieces.slice(first, first + BONES_PER_MESH);
    const groupFlags = new Uint8Array(splat.count);
    for (const piece of members) for (const i of piece.splats) groupFlags[i] = 1;
    const mesh = new SplatMesh({ fileBytes: selectSplats(splat, groupFlags, 1), fileType: SplatFileType.SPLAT });
    await mesh.initialized;
    const boneOf = new Map<number, number>();
    members.forEach((piece, bone) => {
      for (const i of piece.splats) boneOf.set(i, bone);
    });
    const skinning = new SplatSkinning({ mesh, numSplats: mesh.numSplats, numBones: members.length });
    members.forEach((_, bone) => skinning.setRestQuatPos(bone, identity, objectPosition.set(0, 0, 0)));
    const boneIndices = new THREE.Vector4();
    const weights = new THREE.Vector4(1, 0, 0, 0);
    let j = 0;
    for (let i = 0; i < splat.count; i++) {
      if (!groupFlags[i]) continue;
      boneIndices.set(boneOf.get(i)!, 0, 0, 0);
      skinning.setSplatBones(j++, boneIndices, weights);
    }
    (skinning as any).skinTexture.needsUpdate = true;
    skinning.updateBones();
    mesh.skinning = skinning;
    mesh.updateGenerator();
    groups.push({ mesh, skinning, first, count: members.length });
  }

  const q = new THREE.Quaternion();
  const turned = new THREE.Vector3();
  const syncBones = () => {
    for (const { mesh, skinning, first, count } of groups) {
      for (let bone = 0; bone < count; bone++) {
        const body = bodies[first + bone];
        const t = body.translation();
        const r = body.rotation();
        // Metric frame -> file frame is a half turn about x: conjugating the rotation flips its y and z
        q.set(r.x, -r.y, -r.z, r.w);
        turned.copy(pieces[first + bone].restObject!).applyQuaternion(q);
        objectPosition.set(t.x / s, -t.y / s, -t.z / s).sub(turned);
        skinning.setBoneQuatPos(bone, q, objectPosition);
      }
      skinning.updateBones();
      mesh.updateVersion();
    }
  };

  let quake: { t: number; strength: number; phase: number } | null = null;
  let running = false;
  const shake = new THREE.Vector3();

  return {
    meshes: groups.map(group => group.mesh),
    wallFlags,
    shake,
    start(strength) {
      quake = { t: 0, strength, phase: Math.random() * 6 };
      running = true;
      bodies.forEach(body => {
        body.setBodyType(RAPIER.RigidBodyType.Dynamic, false);
        body.wakeUp();
      });
    },
    reset() {
      quake = null;
      running = false;
      shake.set(0, 0, 0);
      world.gravity = { x: 0, y: -G, z: 0 };
      restAll();
      pin();
      syncBones();
    },
    step(deltaSeconds) {
      if (!running) return;
      const h = 1 / 120;
      const steps = Math.min(4, Math.max(1, Math.round(deltaSeconds / h)));
      world.timestep = h;
      for (let i = 0; i < steps; i++) {
        if (quake) {
          // Shaking the ground is the same, in the ground's frame, as tilting gravity back and forth
          quake.t += h;
          const t = quake.t;
          const a = quake.strength * G;
          const envelope = Math.min(1, t / 0.8) * (1 - THREE.MathUtils.smoothstep(t, 5, 8));
          const ax = a * envelope * (0.65 * Math.sin(2 * Math.PI * 2.1 * t + quake.phase) + 0.35 * Math.sin(2 * Math.PI * 3.4 * t));
          const az = a * envelope * (0.55 * Math.sin(2 * Math.PI * 1.7 * t + 2) + 0.45 * Math.sin(2 * Math.PI * 2.9 * t + quake.phase));
          const ay = 0.25 * a * envelope * Math.sin(2 * Math.PI * 4.3 * t);
          world.gravity = { x: -ax, y: -G - ay, z: -az };
          shake.set(ax, ay, az).multiplyScalar(0.004);
          if (t > 8) {
            quake = null;
            world.gravity = { x: 0, y: -G, z: 0 };
            shake.set(0, 0, 0);
          }
        }
        world.step();
        // Cap speeds: a piece that starts slightly inside another must not be flung away
        for (const body of bodies) {
          if (body.isSleeping()) continue;
          const v = body.linvel();
          const speed = Math.hypot(v.x, v.y, v.z);
          if (speed > 5) body.setLinvel({ x: (v.x * 5) / speed, y: (v.y * 5) / speed, z: (v.z * 5) / speed }, false);
        }
      }
      syncBones();
      if (!quake && bodies.every(body => body.isSleeping())) running = false;
    },
    dispose() {
      for (const { mesh } of groups) {
        mesh.removeFromParent();
        mesh.dispose();
      }
      world.free();
    },
  };
}
