import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { G, GLSL_NOISE } from './common.js';

// HDR-space atmosphere pass: distant rain curtains, low-cloud mist, lightning wash
const AtmosShader = {
  uniforms: { tDiffuse: { value: null }, uNoise: { value: null }, uTime: { value: 0 }, uRain: { value: 0 }, uWindX: { value: 0 }, uFlash: { value: 0 }, uAspect: { value: 1 }, uFog: { value: new THREE.Color() }, uLum: { value: 0.5 }, uDrops: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime, uRain, uWindX, uFlash, uAspect, uLum, uDrops; uniform vec3 uFog;
    varying vec2 vUv;
    ${GLSL_NOISE}
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // lightning wash
      c += vec3(0.55, 0.62, 0.85) * uFlash * 0.35;
      // droplets on the lens (soft refractive blobs) when raining hard
      if (uDrops > 0.01) {
        vec2 uv = vUv * vec2(uAspect, 1.0) * 7.0;
        vec2 id = floor(uv); vec2 f = fract(uv) - 0.5;
        vec2 h = hash22(id);
        float on = step(0.86, h.x);
        vec2 ctr = (h - 0.5) * 0.5;
        float d = length(f - ctr);
        float drop = smoothstep(0.09 * (0.5 + h.y), 0.02, d) * on;
        c = mix(c, c * 0.8 + uFog * 0.06, drop * uDrops);
      }
      gl_FragColor = vec4(c, 1.0);
    }`,
};

const FilmShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.035 }, uVig: { value: 0.32 }, uAspect: { value: 1 }, uCA: { value: 0.00028 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uTime, uGrain, uVig, uAspect, uCA; varying vec2 vUv;
    float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c * vec2(uAspect, 1.0), c * vec2(uAspect, 1.0));
      vec2 off = c * r2 * uCA * 6.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      col *= 1.0 - uVig * smoothstep(0.12, 0.85, r2 * 1.6);
      float g = h(vUv * 1200.0 + fract(uTime) * 91.7) - 0.5;
      float lum = dot(col, vec3(0.3, 0.59, 0.11));
      col += g * uGrain * (0.5 + (1.0 - lum) * 0.8);
      gl_FragColor = vec4(col, 1.0);
    }`,
};


// ---------------------------------------------------------------------------
// Screen-space ambient occlusion straight from the depth buffer (no normal pass, so particles/instances are safe)
// ---------------------------------------------------------------------------
const AO_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const AO_GEN = /* glsl */`
precision highp float;
#include <packing>
uniform sampler2D tDepth; uniform vec2 uRes; uniform float uNear, uFar; uniform mat4 uProj; uniform mat4 uProjInv; uniform float uTime; uniform vec3 uUpV; uniform float uCamY; uniform float uMode;
varying vec2 vUv;
float viewZ(vec2 uv){ float d = texture2D(tDepth, uv).x; return perspectiveDepthToViewZ(d, uNear, uFar); }
vec3 viewPos(vec2 uv, float z){ vec4 c = vec4(uv * 2.0 - 1.0, 0.0, 1.0); vec4 v = uProjInv * c; vec3 dir = v.xyz / v.w; return dir / -dir.z * -z; }
float ign(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main(){
  float d0 = texture2D(tDepth, vUv).x;
  if (d0 >= 0.99999) { gl_FragColor = vec4(1.0); return; }
  float z0 = perspectiveDepthToViewZ(d0, uNear, uFar);
  vec3 P = viewPos(vUv, z0);
  // robust normal: pick the smaller depth gradient on each axis (handles silhouettes and facet edges)
  vec2 px = 1.0 / uRes;
  vec3 Pl = viewPos(vUv - vec2(px.x, 0.0), viewZ(vUv - vec2(px.x, 0.0)));
  vec3 Pr = viewPos(vUv + vec2(px.x, 0.0), viewZ(vUv + vec2(px.x, 0.0)));
  vec3 Pd = viewPos(vUv - vec2(0.0, px.y), viewZ(vUv - vec2(0.0, px.y)));
  vec3 Pu = viewPos(vUv + vec2(0.0, px.y), viewZ(vUv + vec2(0.0, px.y)));
  vec3 ddx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? (Pr - P) : (P - Pl);
  vec3 ddy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? (Pu - P) : (P - Pd);
  vec3 N = normalize(cross(ddx, ddy));
  if (N.z < 0.0) N = -N;
  if (uMode > 0.5 && uMode < 1.5) { gl_FragColor = vec4(N * 0.5 + 0.5, 1.0); return; }
  if (uMode > 1.5 && uMode < 2.5) { gl_FragColor = vec4(vec3(fract(-z0 * 0.25)), 1.0); return; }
  float dist = -z0;
  // open water (near sea level, facing up) never needs AO and its wave facets would band
  float wy = uCamY + dot(P, uUpV);
  float upness = dot(N, uUpV);
  if (wy < 0.9 && upness > 0.85) { gl_FragColor = vec4(1.0); return; }
  float radius = clamp(0.0075 * dist, 1.4, 14.0);
  float rot = ign(gl_FragCoord.xy) * 6.2831853;
  if (uMode > 2.5 && uMode < 3.5) rot = 0.0;
  if (uMode > 3.5) N = uUpV;
  float occ = 0.0;
  const int NS = 14;
  for (int i = 0; i < NS; i++) {
    float fi = (float(i) + 0.5) / float(NS);
    float a = rot + fi * 6.2831853 * 3.0;
    float h = fract(fi * 7.0 + ign(gl_FragCoord.xy + 17.0));
    vec3 dir = vec3(cos(a), sin(a), 0.0);
    // hemisphere around the normal (cheap): tangent frame from N
    vec3 T = normalize(abs(N.y) < 0.9 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
    vec3 B = cross(N, T);
    float elev = mix(0.32, 1.0, fract(fi * 5.0 + 0.37));
    vec3 s = normalize(T * cos(a) * sqrt(1.0 - elev * elev) + B * sin(a) * sqrt(1.0 - elev * elev) + N * elev);
    float r = radius * mix(0.2, 1.0, fi * fi);
    vec3 S = P + N * 0.06 * radius + s * r;
    vec4 pc = uProj * vec4(S, 1.0); vec2 suv = pc.xy / pc.w * 0.5 + 0.5;
    if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
    float zs = viewZ(suv);
    float diff = zs - S.z;     // >0 : surface at that pixel is nearer the camera than the sample point
    float range = smoothstep(0.0, 1.0, radius / max(abs(P.z - zs), 1e-3));
    occ += step(0.10 * r + 0.02 * dist * 0.01, diff) * range;
  }
  float ao = 1.0 - occ / float(NS);
  gl_FragColor = vec4(pow(clamp(ao, 0.0, 1.0), 1.6), 0.0, 0.0, 1.0);
}`;
const AO_COMP = /* glsl */`
precision highp float;
#include <packing>
uniform sampler2D tDiffuse; uniform sampler2D tAO; uniform sampler2D tDepth; uniform vec2 uRes; uniform float uStrength; uniform float uNear, uFar; uniform float uDbg;
varying vec2 vUv;
void main(){
  vec4 c = texture2D(tDiffuse, vUv);
  float d0 = texture2D(tDepth, vUv).x;
  float z0 = perspectiveDepthToViewZ(d0, uNear, uFar);
  float sum = 0.0, wsum = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec2 o = vec2(float(i), float(j)) * 2.0 / uRes;
    float zi = perspectiveDepthToViewZ(texture2D(tDepth, vUv + o).x, uNear, uFar);
    float w = exp(-abs(zi - z0) / (0.02 * abs(z0) + 0.1));
    sum += texture2D(tAO, vUv + o).r * w; wsum += w;
  }
  float ao = sum / max(wsum, 1e-4);
  if (d0 >= 0.99999) ao = 1.0;
  ao = mix(0.30, 1.0, ao);
  float fadeD = 1.0 - smoothstep(250.0, 1100.0, -z0);
  gl_FragColor = vec4(c.rgb * mix(1.0, ao, uStrength * fadeD), c.a);
  if (uDbg > 0.5) gl_FragColor = vec4(vec3(ao), 1.0);
}`;
class SSAOPass extends Pass {
  constructor(camera, w, h) {
    super(); this.camera = camera; this.needsSwap = true; this.strength = 0.85;
    this.aoRT = new THREE.WebGLRenderTarget(Math.max(1, w >> 1), Math.max(1, h >> 1), { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    this.gen = new THREE.ShaderMaterial({ vertexShader: AO_VERT, fragmentShader: AO_GEN, uniforms: { tDepth: { value: null }, uRes: { value: new THREE.Vector2(w, h) }, uNear: { value: camera.near }, uFar: { value: camera.far }, uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() }, uTime: { value: 0 }, uUpV: { value: new THREE.Vector3(0, 1, 0) }, uCamY: { value: 0 }, uMode: { value: 0 } }, depthTest: false, depthWrite: false });
    this.comp = new THREE.ShaderMaterial({ vertexShader: AO_VERT, fragmentShader: AO_COMP, uniforms: { tDiffuse: { value: null }, tAO: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2(w, h) }, uStrength: { value: 0.85 }, uDbg: { value: 0 }, uNear: { value: camera.near }, uFar: { value: camera.far } }, depthTest: false, depthWrite: false });
    this.quad = new FullScreenQuad(this.gen);
  }
  setSize(w, h) { this.aoRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1)); this.gen.uniforms.uRes.value.set(w, h); this.comp.uniforms.uRes.value.set(w, h); }
  render(renderer, writeBuffer, readBuffer) {
    const depth = readBuffer.depthTexture; if (!depth) { this.needsSwap = false; return; }
    this.needsSwap = true;
    const cam = this.camera; const gu = this.gen.uniforms;
    gu.tDepth.value = depth; gu.uNear.value = cam.near; gu.uFar.value = cam.far; gu.uProj.value.copy(cam.projectionMatrix); gu.uProjInv.value.copy(cam.projectionMatrixInverse); gu.uCamY.value = cam.position.y; gu.uMode.value = this.mode || 0; gu.uUpV.value.setFromMatrixColumn(cam.matrixWorldInverse, 1);
    this.quad.material = this.gen; renderer.setRenderTarget(this.aoRT); renderer.clear(); this.quad.render(renderer);
    const cu = this.comp.uniforms; cu.tDiffuse.value = readBuffer.texture; cu.tAO.value = this.aoRT.texture; cu.tDepth.value = depth; cu.uNear.value = cam.near; cu.uFar.value = cam.far; cu.uStrength.value = this.strength; cu.uDbg.value = this.dbg ? 1 : 0;
    this.quad.material = this.comp; renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer); this.quad.render(renderer);
  }
}

export function makePost(renderer, scene, camera) {
  const size = renderer.getSize(new THREE.Vector2());
  const pr = renderer.getPixelRatio();
  const rt = new THREE.WebGLRenderTarget(size.x * pr, size.y * pr, { type: THREE.HalfFloatType, samples: 0 });
  rt.depthTexture = new THREE.DepthTexture(size.x * pr, size.y * pr); rt.depthTexture.type = THREE.UnsignedIntType;
  const composer = new EffectComposer(renderer, rt);
  composer.setPixelRatio(pr);
  const rp = new RenderPass(scene, camera);
  composer.addPass(rp);
  const ssao = new SSAOPass(camera, size.x * pr, size.y * pr);
  composer.addPass(ssao);
  const atmos = new ShaderPass(AtmosShader); atmos.uniforms.uNoise.value = G.noise;
  composer.addPass(atmos);
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.35, 0.7, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const smaa = new SMAAPass(size.x * pr, size.y * pr); composer.addPass(smaa);
  const film = new ShaderPass(FilmShader);
  composer.addPass(film);
  return {
    composer, bloom, atmos, film, ssao, smaa,
    resize(w, h) { composer.setSize(w, h); smaa.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio()); ssao.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio()); atmos.uniforms.uAspect.value = w / h; film.uniforms.uAspect.value = w / h; },
  };
}
