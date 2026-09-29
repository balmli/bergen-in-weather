import * as THREE from 'three';
import { G, GLSL_NOISE, mulberry, applyFog, clamp } from './common.js';
import { waterUniforms, wavesGLSL, NW } from './water.js';

// Wind-blown spray torn off wave crests: stateless streaks near the camera, visible only where the sea is breaking.
const vert = /* glsl */`
attribute vec4 aR;
uniform float uTimeS; uniform vec2 uWindS; uniform float uWindK; uniform float uVol; uniform float uActive;
uniform vec2 uWDir[${NW}]; uniform float uWK[${NW}]; uniform float uWA[${NW}]; uniform float uWQ[${NW}]; uniform float uWPh[${NW}]; uniform float uWScale; uniform sampler2D uMap; uniform float uPond; uniform sampler2D uNoise;
varying float vA; varying vec2 vUv;
float vnoise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f); return texture2D(uNoise, (i + f + 0.5) / 256.0).r; }
float waveWarp(vec2 xz){ return (vnoise(xz * 0.011 + 7.0) - 0.5) * 2.2; }
float mapDist(vec2 xz){ return texture2D(uMap, xz / 14000.0 + 0.5).r * 800.0; }
float mapFetch(vec2 xz){ return texture2D(uMap, xz / 14000.0 + 0.5).g * 6000.0; }
float seaAmp(vec2 xz){ float f = mapFetch(xz); float s = mapDist(xz); return clamp(sqrt(f / 1250.0), 0.22, 1.0) * (0.5 + 0.5 * smoothstep(0.0, 120.0, s)); }
void main(){
  vUv = uv;
  vec2 base = (aR.xy - 0.5) * uVol;
  float sp = 4.0 + 8.0 * aR.w;
  vec2 drift = uWindS * (sp / max(length(uWindS), 0.1)) * uTimeS;
  vec2 p = base + drift;
  vec2 rel = mod(p - cameraPosition.xz + uVol * 0.5, uVol) - uVol * 0.5;
  vec2 xz = cameraPosition.xz + rel;
  float amp = seaAmp(xz);
  float h = 0.0, jxx = 0.0, jzz = 0.0, jxz = 0.0; float wwp = waveWarp(xz);
  for (int i = 0; i < ${NW}; i++) {
    float ph = uWK[i] * dot(uWDir[i], xz) - uWPh[i] + wwp * (1.0 - 0.08 * float(i));
    float A = uWA[i] * uWScale * amp; float c = cos(ph);
    h += A * c;
    float Q = uWQ[i] * A * uWK[i];
    jxx -= Q * uWDir[i].x * uWDir[i].x * c; jzz -= Q * uWDir[i].y * uWDir[i].y * c; jxz -= Q * uWDir[i].x * uWDir[i].y * c;
  }
  float J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;
  float thr = 0.62 + 0.14 * uWindK;
  float crest = smoothstep(thr, thr - 0.16, J);
  float land = smoothstep(4.0, 30.0, mapDist(xz));
  float d = length(rel);
  vA = crest * land * uActive * (1.0 - smoothstep(uVol * 0.30, uVol * 0.5, d)) * smoothstep(1.5, 6.0, d) * (0.35 + 0.65 * aR.z);
  vec3 c = vec3(xz.x, h + 0.25 + aR.z * 1.3 * crest, xz.y);
  vec3 wd = normalize(vec3(uWindS.x, -0.05, uWindS.y));
  vec3 vd = normalize(c - cameraPosition);
  vec3 side = normalize(cross(vd, wd));
  float len = 0.7 + 1.6 * aR.w, wid = 0.05 + 0.10 * aR.y;
  vec3 wp = c + wd * position.x * len + side * position.y * wid;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const frag = `varying float vA; varying vec2 vUv; uniform vec3 uColS; void main(){ float x = abs(vUv.x - 0.5) * 2.0, y = abs(vUv.y - 0.5) * 2.0; float a = (1.0 - x * x) * (1.0 - y); gl_FragColor = vec4(uColS, a * vA * 0.55); }`;

export class Spray {
  constructor(scene, N = 5200) {
    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry(); g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv);
    const R = mulberry(4242); const r = new Float32Array(N * 4); for (let i = 0; i < r.length; i++) r[i] = R();
    g.setAttribute('aR', new THREE.InstancedBufferAttribute(r, 4)); g.instanceCount = N;
    this.u = { uTimeS: { value: 0 }, uWindS: { value: new THREE.Vector2() }, uWindK: { value: 0 }, uVol: { value: 170 }, uActive: { value: 0 }, uColS: { value: new THREE.Color(0.8, 0.83, 0.86) } };
    const uniforms = Object.assign({}, waterUniforms, this.u);
    this.mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 9; scene.add(this.mesh);
  }
  update(light) {
    const w = 3 + G.wind * 21;
    this.u.uTimeS.value = G.time % 300; this.u.uWindS.value.set(G.windDir.x * w, G.windDir.y * w); this.u.uWindK.value = G.wind;
    this.u.uActive.value = clamp((G.wind - 0.45) / 0.4, 0, 1);
    this.mesh.visible = this.u.uActive.value > 0.01;
    const a = light ? Math.min(0.9, light.skyL * 2.2 + 0.05) : 0.5; this.u.uColS.value.setRGB(a, a * 1.02, a * 1.05);
  }
}
