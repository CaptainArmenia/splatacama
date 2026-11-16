import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

/**
 * The "Efecto cine" setting: a last pass over the whole frame, splats included, as a camera would give it. The sun's
 * glitter on the sea, the surf and the sun's disc bloom a little; colours get a gentle S-curve and a touch more
 * saturation, light parts warmer and shade cooler; the corners darken; and a fine grain moves over it.
 *
 * The frame is drawn into `target` instead of the screen (createMeshAntialias's render takes it), then bloomed in
 * place and graded onto the screen. Not in VR: the headset's frames don't come through here.
 */
export type CinemaEffect = {
  /** Where the frame is drawn before render() puts it on the screen */
  target: THREE.WebGLRenderTarget;
  /** Sizes the target to the drawing buffer; call before drawing into it */
  prepare: () => void;
  render: (seconds: number) => void;
  dispose: () => void;
};

const BLOOM = { strength: 0.22, radius: 0.4, threshold: 0.96 };

export function createCinemaEffect(renderer: THREE.WebGLRenderer): CinemaEffect {
  // 8-bit sRGB storage, read back as linear, as the meshes' own target
  const target = new THREE.WebGLRenderTarget(1, 1);
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const size = new THREE.Vector2();
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: target.texture },
      resolution: { value: new THREE.Vector2() },
      time: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform vec2 resolution;
      uniform float time;
      varying vec2 vUv;
      float grainHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main() {
        vec3 seen = pow(max(texture2D(tDiffuse, vUv).rgb, 0.0), vec3(1.0 / 2.2));
        seen = mix(seen, seen * seen * (3.0 - 2.0 * seen), 0.3);
        float brightness = dot(seen, vec3(0.2126, 0.7152, 0.0722));
        seen = mix(vec3(brightness), seen, 1.1);
        seen += vec3(0.02, 0.008, -0.02) * smoothstep(0.45, 0.9, brightness)
          + vec3(-0.012, 0.0, 0.018) * (1.0 - smoothstep(0.1, 0.45, brightness));
        vec2 fromCentre = (vUv - 0.5) * vec2(1.0, 0.8);
        seen *= 1.0 - 0.3 * smoothstep(0.35, 1.0, length(fromCentre) * 1.4);
        seen += (grainHash(floor(vUv * resolution) + fract(time * 7.3) * 113.0) - 0.5) * 0.022;
        gl_FragColor = linearToOutputTexel(vec4(pow(max(seen, 0.0), vec3(2.2)), 1.0));
      }`,
    depthTest: false,
    depthWrite: false,
  });
  const quad = new FullScreenQuad(material);

  return {
    target,
    prepare() {
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) {
        target.setSize(size.x, size.y);
        bloom.setSize(size.x, size.y);
      }
      material.uniforms.resolution.value.copy(size);
    },
    render(seconds) {
      // The bloom, added onto the frame in its own target
      bloom.render(renderer, null as any, target, 0, false);
      material.uniforms.time.value = seconds;
      renderer.setRenderTarget(null);
      quad.render(renderer);
    },
    dispose() {
      target.dispose();
      bloom.dispose();
      material.dispose();
      quad.dispose();
    },
  };
}
