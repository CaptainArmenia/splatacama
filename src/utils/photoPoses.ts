import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { assetUrl } from '@/utils/assetUrl';

/**
 * Where each photo of a site was taken from, drawn in the scene as COLMAP's viewer draws cameras: a wireframe
 * pyramid per photo, its tip at the camera and its base the picture's frame, a little way along the view.
 *
 * The poses come from the structure-from-motion model the site's splat was trained from (the pipeline's
 * site_cameras.py writes them in the viewer's frame):
 *   { cameras: [{ aspect, fovY }], poses: [[x, y, z, qx, qy, qz, qw, camera index], ...], names: [...] }
 * with the quaternion turning a three.js camera (looking along -z, y up) to the photo's.
 *
 * The lines are meshes (three's fat lines, a constant width on screen), so they are drawn and smoothed with the
 * terrain, before the splats: a camera behind a wall is covered by the wall's splats.
 */

export type PhotoPoses = {
  /** Shows or hides the pyramids; the poses are downloaded the first time they are shown */
  setVisible: (on: boolean) => void;
  dispose: () => void;
};

type PoseFile = { cameras: { aspect: number; fovY: number }[]; poses: number[][] };

// The pyramids' depth: a part of how far the photos typically are from the site, within limits (metres)
const DEPTH_SHARE = 0.045;
const MIN_DEPTH = 0.25;
const MAX_DEPTH = 1.2;
const COLOR = 0xff6a1a;
const PANO_COLOR = 0x38bdf8;
const LINE_WIDTH = 1.6;

export function createPhotoPoses(options: {
  url: string;
  world: THREE.Group;
  metersPerUnit: number;
  // The 360 photo's viewpoint (viewer units), marked with a ring of its own
  pano?: number[];
}): PhotoPoses {
  const { url, world, metersPerUnit, pano } = options;
  const group = new THREE.Group();
  group.name = 'photo-poses';
  group.visible = false;
  world.add(group);
  const disposables: { dispose: () => void }[] = [];
  let loading: Promise<void> | null = null;
  let disposed = false;

  const addLines = (points: number[], color: number) => {
    const geometry = new LineSegmentsGeometry();
    geometry.setPositions(points);
    const material = new LineMaterial({ color, linewidth: LINE_WIDTH });
    const lines = new LineSegments2(geometry, material);
    lines.frustumCulled = false;
    group.add(lines);
    disposables.push(geometry, material);
  };

  const load = () => {
    loading ??= (async () => {
      const response = await fetch(assetUrl(url));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const file = (await response.json()) as PoseFile;
      if (disposed) return;

      const distances = file.poses.map(pose => Math.hypot(pose[0], pose[1], pose[2])).sort((a, b) => a - b);
      const typical = distances[distances.length >> 1] ?? 10;
      const depth = THREE.MathUtils.clamp(typical * metersPerUnit * DEPTH_SHARE, MIN_DEPTH, MAX_DEPTH) / metersPerUnit;

      const points: number[] = [];
      const tip = new THREE.Vector3();
      const rotation = new THREE.Quaternion();
      const corners = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
      for (const pose of file.poses) {
        const camera = file.cameras[pose[7]] ?? file.cameras[0];
        const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fovY) / 2) * depth;
        const halfWidth = halfHeight * camera.aspect;
        tip.set(pose[0], pose[1], pose[2]);
        rotation.set(pose[3], pose[4], pose[5], pose[6]);
        // The picture's frame: top left, top right, bottom right, bottom left
        corners[0].set(-halfWidth, halfHeight, -depth);
        corners[1].set(halfWidth, halfHeight, -depth);
        corners[2].set(halfWidth, -halfHeight, -depth);
        corners[3].set(-halfWidth, -halfHeight, -depth);
        for (const corner of corners) corner.applyQuaternion(rotation).add(tip);
        for (let i = 0; i < 4; i++) {
          const next = corners[(i + 1) % 4];
          points.push(tip.x, tip.y, tip.z, corners[i].x, corners[i].y, corners[i].z);
          points.push(corners[i].x, corners[i].y, corners[i].z, next.x, next.y, next.z);
        }
      }
      addLines(points, COLOR);

      if (pano) {
        // The 360 photo looks every way: three rings around its viewpoint
        const ring: number[] = [];
        const radius = depth * 0.6;
        const steps = 32;
        for (let axis = 0; axis < 3; axis++) {
          for (let i = 0; i < steps; i++) {
            for (const k of [i, i + 1]) {
              const angle = (k / steps) * 2 * Math.PI;
              const circle = [Math.cos(angle) * radius, Math.sin(angle) * radius, 0];
              ring.push(pano[0] + circle[axis % 3], pano[1] + circle[(axis + 1) % 3], pano[2] + circle[(axis + 2) % 3]);
            }
          }
        }
        addLines(ring, PANO_COLOR);
      }
    })();
    loading.catch((e: unknown) => {
      console.error('Error loading the photo poses:', e);
      loading = null;
    });
  };

  return {
    setVisible(on) {
      group.visible = on;
      if (on) load();
    },
    dispose() {
      disposed = true;
      world.remove(group);
      for (const item of disposables) item.dispose();
    },
  };
}
