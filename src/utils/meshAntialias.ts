import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';

/**
 * Antialiasing for the scene's meshes (terrain, sky, wind turbines), leaving the splats as they are.
 *
 * The renderer runs without multisampling, as Spark advises: it would multiply the cost of every splat and doesn't
 * help them. So mesh edges stair-step, along the terrain's ridgelines and the turbines' outlines. Here the meshes are
 * drawn first into a screen-sized texture, copied to the screen through FXAA (a one-pass filter that smooths edges)
 * together with their depth, and then the splats are drawn over them as before, depth-tested against the meshes.
 * It costs a full-screen pass and the texture; filtering the whole frame instead would also blur the splats. VR draws
 * directly: its frames go to the headset, not to the page.
 */

export type MeshAntialias = {
  /** Draws `scene` as renderer.render would, with the meshes smoothed; `splats` is the SparkRenderer. `output` takes
   * the frame instead of the screen (it needs a depth buffer). */
  render: (scene: THREE.Scene, camera: THREE.Camera, splats: THREE.Object3D, output?: THREE.WebGLRenderTarget | null) => void;
  dispose: () => void;
};

export function createMeshAntialias(renderer: THREE.WebGLRenderer): MeshAntialias {
  // 8-bit sRGB storage, read back as linear: no banding in the dark night scenes
  const target = new THREE.WebGLRenderTarget(1, 1, { depthTexture: new THREE.DepthTexture(1, 1) });
  target.texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.ShaderMaterial({
    uniforms: {
      tDiffuse: { value: target.texture },
      tDepth: { value: target.depthTexture },
      resolution: { value: new THREE.Vector2() },
    },
    vertexShader: FXAAShader.vertexShader,
    fragmentShader: FXAAShader.fragmentShader
      .replace('uniform vec2 resolution;', 'uniform vec2 resolution;\nuniform sampler2D tDepth;')
      // FXAA's thresholds are for brightness as seen; the texture reads back linear
      .replace('return dot( Sample( tex2D, uv ).rgb, vec3( 0.3, 0.59, 0.11 ) );',
        'return dot( sqrt( Sample( tex2D, uv ).rgb ), vec3( 0.3, 0.59, 0.11 ) );')
      .replace('gl_FragColor = ApplyFXAA( tDiffuse, resolution.xy, vUv );', `
      gl_FragColor = linearToOutputTexel( vec4( ApplyFXAA( tDiffuse, resolution.xy, vUv ).rgb, 1.0 ) );
      gl_FragDepth = texture( tDepth, vUv ).x;`),
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
  });
  const quad = new FullScreenQuad(material);
  const size = new THREE.Vector2();
  const hidden: THREE.Object3D[] = [];

  return {
    render(scene, camera, splats, output = null) {
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);

      // 1. The meshes, into the texture
      splats.visible = false;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      splats.visible = true;

      // 2. To the screen (or `output`), smoothed, with their depth
      renderer.setRenderTarget(output);
      quad.render(renderer);

      // 3. The splats over them, with everything else hidden for this pass (splat meshes aren't drawn themselves:
      // Spark's renderer draws them all)
      scene.traverseVisible(object => {
        const drawn = object as THREE.Object3D & { isMesh?: boolean; isPoints?: boolean; isLine?: boolean; isSprite?: boolean };
        if (object !== splats && (drawn.isMesh || drawn.isPoints || drawn.isLine || drawn.isSprite)) hidden.push(object);
      });
      for (const object of hidden) object.visible = false;
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = autoClear;
      for (const object of hidden) object.visible = true;
      hidden.length = 0;
    },
    dispose() {
      target.depthTexture?.dispose();
      target.dispose();
      material.dispose();
      quad.dispose();
    },
  };
}
