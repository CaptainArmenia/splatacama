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
 * It costs a full-screen pass and the texture; filtering the whole frame instead would also blur the splats.
 *
 * In VR (renderXR) the frame goes to the headset's image instead of the page, and the same three steps run with
 * multisampling in place of FXAA: the meshes are drawn into a 4-sample texture the size of the headset's image (both
 * eyes side by side, as three.js lays them out), copied to it with their depth, and the splats drawn over. Without it
 * the horizon and the hills' outlines were stair-steps that crawled with every move of the head; multisampling the
 * headset's whole image instead smoothed them too, but every splat was then blended into four samples and the frame
 * rate fell.
 */

export type MeshAntialias = {
  /** Draws `scene` as renderer.render would, with the meshes smoothed; `splats` is the SparkRenderer */
  render: (scene: THREE.Scene, camera: THREE.Camera, splats: THREE.Object3D) => void;
  /** The same in a VR session, into the headset's image */
  renderXR: (scene: THREE.Scene, camera: THREE.Camera, splats: THREE.Object3D) => void;
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

  // VR: the multisampled texture (made when a session first draws) and a plain copy of it, colour and depth
  let xrTarget: THREE.WebGLRenderTarget | null = null;
  const copyMaterial = new THREE.ShaderMaterial({
    uniforms: { tDiffuse: { value: null }, tDepth: { value: null } },
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform sampler2D tDepth;
      varying vec2 vUv;
      void main() {
        gl_FragColor = linearToOutputTexel(vec4(texture2D(tDiffuse, vUv).rgb, 1.0));
        gl_FragDepth = texture2D(tDepth, vUv).x;
      }`,
    depthTest: true,
    depthWrite: true,
    depthFunc: THREE.AlwaysDepth,
  });
  const copyQuad = new FullScreenQuad(copyMaterial);

  // Draws the splats over what's there, with everything else hidden for this pass (splat meshes aren't drawn
  // themselves: Spark's renderer draws them all)
  const renderSplats = (scene: THREE.Scene, camera: THREE.Camera, splats: THREE.Object3D) => {
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
  };

  return {
    render(scene, camera, splats) {
      renderer.getDrawingBufferSize(size);
      if (target.width !== size.x || target.height !== size.y) target.setSize(size.x, size.y);
      material.uniforms.resolution.value.set(1 / size.x, 1 / size.y);

      // 1. The meshes, into the texture
      splats.visible = false;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      splats.visible = true;

      // 2. To the screen, smoothed, with their depth
      renderer.setRenderTarget(null);
      quad.render(renderer);

      // 3. The splats over them
      renderSplats(scene, camera, splats);
    },
    renderXR(scene, camera, splats) {
      // The headset's image for this frame, which three.js has made the render target
      const headset = renderer.getRenderTarget();
      if (!headset) {
        renderer.render(scene, camera);
        return;
      }
      if (!xrTarget || xrTarget.width !== headset.width || xrTarget.height !== headset.height) {
        xrTarget?.depthTexture?.dispose();
        xrTarget?.dispose();
        xrTarget = new THREE.WebGLRenderTarget(headset.width, headset.height, {
          samples: 4, depthTexture: new THREE.DepthTexture(headset.width, headset.height),
        });
        xrTarget.texture.colorSpace = THREE.SRGBColorSpace;
        // The Meta Quest's browser has a cheaper way to multisample (WEBGL_multisampled_render_to_texture), which
        // three.js uses when it can. The first version of this pass drew no splats on the Quest, and the likely
        // reason is that the depth doesn't come out of that path, so the copy put every mesh at the eye. Turned off
        // for this texture: the depth is then resolved like the colour, as on a computer.
        (renderer.properties.get(xrTarget) as any).__useRenderToTexture = false;
        copyMaterial.uniforms.tDiffuse.value = xrTarget.texture;
        copyMaterial.uniforms.tDepth.value = xrTarget.depthTexture;
      }

      // 1. The meshes for both eyes, multisampled
      splats.visible = false;
      renderer.setRenderTarget(xrTarget);
      renderer.render(scene, camera);
      splats.visible = true;

      // 2. To the headset's image, with their depth. The copy is one quad over both eyes, drawn with its own camera:
      // while `xr.enabled` is on, three.js draws everything with the eyes' cameras.
      renderer.setRenderTarget(headset);
      renderer.xr.enabled = false;
      copyQuad.render(renderer);
      renderer.xr.enabled = true;

      // 3. The splats over them, not multisampled
      renderSplats(scene, camera, splats);
    },
    dispose() {
      xrTarget?.depthTexture?.dispose();
      xrTarget?.dispose();
      copyMaterial.dispose();
      copyQuad.dispose();
      target.depthTexture?.dispose();
      target.dispose();
      material.dispose();
      quad.dispose();
    },
  };
}
