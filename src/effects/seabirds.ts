/**
 * Seabirds over the coast (the "Aves" graphics setting): kelp gulls wheeling in loose circles, gliding with now and
 * then a few wingbeats, and Peruvian pelicans flying slower, longer loops in a file, beating and gliding together.
 *
 * Each bird is a few triangles (a body, and wings in two parts that bend at the wrist), one instanced mesh for all.
 * Their paths are smooth closed loops around the site, out of the camera's reach (never nearer than MIN_DISTANCE to
 * the site's centre, and well above its ground), banking into their turns. The wingbeat is in the vertex shader;
 * the paths are worked out each frame for a couple of dozen birds.
 *
 * Built in the effects' metric frame (metres, y up; see siteAnalysis.ts).
 */
import * as THREE from 'three';

const MIN_DISTANCE = 30;

type Species = {
  span: number;
  // Colours (linear) of the body, the wings and the wingtips; the mesh draws a gull's, tinted by the body's
  body: [number, number, number];
  wing: [number, number, number];
  tip: [number, number, number];
  // Wingbeats a second, and the share of the time spent beating
  beat: number;
  beating: number;
  speed: number;
};

const GULL: Species = {
  span: 1.35, body: [0.88, 0.88, 0.86], wing: [0.16, 0.16, 0.18], tip: [0.05, 0.05, 0.06], beat: 2.8, beating: 0.3,
  speed: 9,
};
const PELICAN: Species = {
  span: 2.3, body: [0.42, 0.4, 0.37], wing: [0.28, 0.26, 0.24], tip: [0.09, 0.09, 0.09], beat: 1.7, beating: 0.45,
  speed: 11,
};

type Bird = {
  species: Species;
  // The loop: its centre, radii, height above the site's ground, how fast it goes round (radians a second), its
  // phase, and a wobble
  cx: number;
  cz: number;
  rx: number;
  rz: number;
  turn: number;
  height: number;
  rate: number;
  phase: number;
  wobble: number;
  // The wingbeat's own timing
  beatPhase: number;
};

export type Seabirds = {
  mesh: THREE.InstancedMesh;
  update: (seconds: number) => void;
  dispose: () => void;
};

// One bird: x across the wings, y up, z forward; `part` tells the shader what moves: 0 the body, 1 the inner wing
// (pivoting at the shoulder), 2 the outer wing (bending again at the wrist). Unit span.
function birdGeometry() {
  const positions: number[] = [];
  const parts: number[] = [];
  const colours: number[] = [];
  const add = (points: number[][], part: number, colour: string) => {
    for (const p of points) {
      positions.push(...p);
      parts.push(part);
      colours.push(colour === 'body' ? 0 : colour === 'wing' ? 1 : 2);
    }
  };
  // Body: a slim diamond, nose to tail, and a little height
  const body = [[0, 0, 0.32], [0.05, 0.01, 0.0], [0, 0, -0.28], [-0.05, 0.01, 0.0]];
  add([body[0], body[1], body[2], body[0], body[2], body[3]], 0, 'body');
  add([[0, 0, 0.3], [0, 0.045, 0], [0, 0, -0.26]], 0, 'body');
  for (const side of [1, -1]) {
    const shoulderFront = [0.04 * side, 0.01, 0.07];
    const shoulderBack = [0.04 * side, 0.01, -0.08];
    const wristFront = [0.26 * side, 0.02, 0.05];
    const wristBack = [0.26 * side, 0.02, -0.1];
    const tip = [0.5 * side, 0.0, -0.06];
    const tipBack = [0.44 * side, 0.0, -0.13];
    add([shoulderFront, wristFront, wristBack, shoulderFront, wristBack, shoulderBack], 1, 'wing');
    add([wristFront, tip, tipBack, wristFront, tipBack, wristBack], 2, 'tip');
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('birdPart', new THREE.Float32BufferAttribute(parts, 1));
  geometry.setAttribute('birdColour', new THREE.Float32BufferAttribute(colours, 1));
  return geometry;
}

export function createSeabirds(groundHeight: number, random: () => number = Math.random): Seabirds {
  const birds: Bird[] = [];
  // Gulls, each wheeling on its own
  for (let i = 0; i < 14; i++) {
    const angle = random() * Math.PI * 2;
    const distance = MIN_DISTANCE + 60 + random() * 160;
    const radius = 25 + random() * 45;
    birds.push({
      species: GULL, cx: Math.cos(angle) * distance, cz: Math.sin(angle) * distance, rx: radius,
      rz: radius * (0.6 + 0.4 * random()), turn: random() * Math.PI, height: 18 + random() * 45,
      rate: (GULL.speed / radius) * (random() < 0.5 ? 1 : -1), phase: random() * Math.PI * 2, wobble: random() * 6,
      beatPhase: random() * 100,
    });
  }
  // A file of pelicans on a long loop, one behind another, beating together
  const pelicanAngle = random() * Math.PI * 2;
  const pelicanCentre = [Math.cos(pelicanAngle) * 220, Math.sin(pelicanAngle) * 220];
  const pelicanRadius = 140;
  for (let i = 0; i < 6; i++) {
    birds.push({
      species: PELICAN, cx: pelicanCentre[0], cz: pelicanCentre[1], rx: pelicanRadius, rz: pelicanRadius * 0.45,
      turn: pelicanAngle + Math.PI / 2, height: 10 + i * 0.6, rate: PELICAN.speed / pelicanRadius,
      phase: -i * (5.5 / pelicanRadius), wobble: 1, beatPhase: i * 0.12,
    });
  }

  const geometry = birdGeometry();
  const beat = new Float32Array(birds.length * 2);
  geometry.setAttribute('birdBeat', new THREE.InstancedBufferAttribute(beat, 2));
  const time = { value: 0 };
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, fog: true });
  material.onBeforeCompile = (shader: any) => {
    shader.uniforms.birdTime = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float birdPart;
        attribute vec2 birdBeat;
        uniform float birdTime;
        varying float vBirdShade;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // birdBeat: wingbeats a second (0 while gliding), and the beat's phase. Gliding, the wings hold a shallow
        // dihedral; beating, they swing about 35 degrees each way, the outer part trailing a little.
        float stroke = birdBeat.x > 0.0 ? sin(6.2832 * (birdBeat.x * birdTime + birdBeat.y)) : 0.0;
        float inner = 0.08 + 0.6 * stroke;
        float outer = inner + 0.25 * (birdBeat.x > 0.0 ? sin(6.2832 * (birdBeat.x * birdTime + birdBeat.y) - 0.8) : -0.1);
        if (birdPart > 0.5) {
          float side = sign(transformed.x);
          float x = abs(transformed.x);
          float wrist = 0.26;
          float along = min(x, wrist);
          vec2 p = vec2(along * cos(inner), along * sin(inner));
          if (birdPart > 1.5) p += vec2((x - wrist) * cos(outer), (x - wrist) * sin(outer));
          transformed.x = side * p.x;
          transformed.y += p.y;
        }
        // The wings darken a little as they sweep down and the light catches their underside less
        vBirdShade = birdPart > 0.5 ? 0.75 + 0.25 * stroke : 1.0;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vBirdShade;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= vBirdShade;`);
  };
  material.customProgramCacheKey = () => 'seabirds';

  const mesh = new THREE.InstancedMesh(geometry, material, birds.length);
  mesh.name = 'seabirds';
  mesh.frustumCulled = false;
  // The parts' colours on the vertices (a gull's), and each bird's tint on its instance (pelicans browner and darker)
  const colours = new Float32Array(geometry.attributes.position.count * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  material.vertexColors = true;
  const part = geometry.attributes.birdColour;
  for (let v = 0; v < part.count; v++) {
    const c = part.getX(v) === 0 ? GULL.body : part.getX(v) === 1 ? GULL.wing : GULL.tip;
    colours.set(c, v * 3);
  }
  const tint = new THREE.Color();
  birds.forEach((bird, i) => {
    const { body } = bird.species;
    tint.setRGB(body[0] / GULL.body[0], body[1] / GULL.body[1], body[2] / GULL.body[2]);
    mesh.setColorAt(i, tint);
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const ahead = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const bank = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const forward = new THREE.Vector3(0, 0, 1);
  const where = (bird: Bird, t: number, out: THREE.Vector3) => {
    const a = bird.phase + bird.rate * t;
    const x = Math.cos(a) * bird.rx;
    const z = Math.sin(a) * bird.rz;
    const c = Math.cos(bird.turn);
    const s = Math.sin(bird.turn);
    out.set(bird.cx + x * c - z * s, groundHeight + bird.height + Math.sin(a * 2 + bird.wobble) * 3,
      bird.cz + x * s + z * c);
    // Not into the camera's reach: pushed out from the site's centre
    const d = Math.hypot(out.x, out.z);
    if (d < MIN_DISTANCE) out.multiplyScalar(MIN_DISTANCE / Math.max(d, 1e-3)).setY(groundHeight + bird.height);
    return out;
  };

  return {
    mesh,
    update(seconds) {
      time.value = seconds;
      birds.forEach((bird, i) => {
        where(bird, seconds, position);
        where(bird, seconds + 0.4, ahead);
        const direction = ahead.sub(position).normalize();
        quaternion.setFromUnitVectors(forward, direction);
        // Banking into the turn, as much as the loop curves
        bank.setFromAxisAngle(forward, -0.5 * Math.sign(bird.rate));
        quaternion.multiply(bank);
        const span = bird.species.span;
        matrix.compose(position, quaternion, scale.set(span, span, span));
        mesh.setMatrixAt(i, matrix);
        // Beating for a while, then gliding (the file of pelicans all together)
        const cycle = (seconds * 0.12 + bird.beatPhase * 0.05) % 1;
        const beating = cycle < bird.species.beating;
        beat[2 * i] = beating ? bird.species.beat : 0;
        beat[2 * i + 1] = bird.beatPhase;
      });
      mesh.instanceMatrix.needsUpdate = true;
      (geometry.attributes.birdBeat as THREE.InstancedBufferAttribute).needsUpdate = true;
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
