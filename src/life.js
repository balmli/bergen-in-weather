import * as THREE from 'three';
import { G, GLSL_NOISE, clamp, lerp, mulberry, smoothstep, windSpeed, gustAt } from './common.js';
import { heightAt } from './terrain.js';
import { ponds } from './terrain.js';

const shared = {
  uStrength: { value: 0 }, uTimeL: { value: 0 }, uWindL: { value: new THREE.Vector3() }, uWindStrength: { value: 0 }, uAmbL: { value: new THREE.Color(0.3, 0.3, 0.3) }, uCamL: { value: new THREE.Vector3() }, uSunL: { value: new THREE.Color(1, 1, 1) },
};

// ---------------------------------------------------------------------------
// Blowing debris: leaves, paper, plastic. Stateless (position = f(absolute time)), immune to frame-time spikes.
// ---------------------------------------------------------------------------
const debrisVert = `
attribute vec4 aR; attribute vec3 aC;
uniform float uTimeL; uniform vec3 uWindL; uniform vec3 uCamL; uniform float uActive; uniform float uVol;
varying vec3 vCol; varying float vA; varying vec2 vUv;
mat3 rotAxis(vec3 a, float t){ a = normalize(a); float c = cos(t), s = sin(t), o = 1.0 - c; return mat3(o*a.x*a.x+c, o*a.x*a.y+s*a.z, o*a.x*a.z-s*a.y, o*a.x*a.y-s*a.z, o*a.y*a.y+c, o*a.y*a.z+s*a.x, o*a.x*a.z+s*a.y, o*a.y*a.z-s*a.x, o*a.z*a.z+c); }
void main(){
  vUv = uv;
  vec3 vol = vec3(uVol, 26.0, uVol);
  float speed = 0.55 + 0.4 * aR.w;
  vec3 base = aR.xyz * vol;
  vec3 drift = uWindL * speed * uTimeL;
  vec3 p = base + drift;
  // gust-driven swirl and hop
  p.y += 0.5 + pow(aR.y, 2.0) * 12.0 + sin(uTimeL * (1.0 + aR.w * 2.0) + aR.x * 40.0) * (0.4 + aR.w * 1.6);
  p.xz += vec2(sin(uTimeL * 0.9 + aR.z * 30.0), cos(uTimeL * 0.8 + aR.x * 30.0)) * (1.0 + 3.0 * aR.w);
  vec3 rel = mod(p - uCamL + vol * 0.5, vol) - vol * 0.5;
  vec3 wp = uCamL + rel; wp.y = max(wp.y, 0.0) ;
  float d = length(rel);
  float size = mix(0.035, 0.12, aR.w * aR.w);
  mat3 R = rotAxis(vec3(aR.z - 0.5, 1.0, aR.x - 0.5), uTimeL * (3.0 + 6.0 * aR.w) + aR.y * 20.0);
  vec3 lp = R * vec3(position.xy * size, 0.0);
  vCol = aC;
  vA = uActive * (1.0 - smoothstep(uVol * 0.32, uVol * 0.5, d)) * smoothstep(1.0, 3.0, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp + lp, 1.0);
  // put the ground-level debris on the actual ground via a per-frame height uniform (approx)
}`;
const debrisFrag = `varying vec3 vCol; varying float vA; varying vec2 vUv; uniform vec3 uAmbL; void main(){ vec2 c = (vUv - 0.5) * 2.0; float e = length(vec2(c.x * 0.7, c.y)); if (e > 1.0 || vA < 0.01) discard; float sh = 0.75 + 0.25 * c.x; gl_FragColor = vec4(vCol * sh * (uAmbL * 1.3 + 0.02), vA * smoothstep(1.0, 0.8, e)); }`;

class Debris {
  constructor(scene, N = 1300) {
    const q = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry(); g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv);
    const R = mulberry(1212); const r = new Float32Array(N * 4), c = new Float32Array(N * 3);
    const pal = [[0.30, 0.19, 0.04], [0.36, 0.24, 0.05], [0.24, 0.09, 0.03], [0.14, 0.16, 0.04], [0.38, 0.30, 0.07], [0.62, 0.62, 0.6], [0.5, 0.52, 0.55], [0.2, 0.22, 0.25]];
    for (let i = 0; i < N; i++) { r.set([R(), R(), R(), R()], i * 4); const k = pal[(R() * pal.length) | 0]; c.set([k[0] * (0.7 + 0.5 * R()), k[1] * (0.7 + 0.5 * R()), k[2] * (0.7 + 0.5 * R())], i * 3); }
    g.setAttribute('aR', new THREE.InstancedBufferAttribute(r, 4)); g.setAttribute('aC', new THREE.InstancedBufferAttribute(c, 3)); g.instanceCount = N;
    this.u = { uActive: { value: 0 }, uVol: { value: 120 } };
    this.mat = new THREE.ShaderMaterial({ vertexShader: debrisVert, fragmentShader: debrisFrag, transparent: true, depthWrite: false, side: THREE.DoubleSide, uniforms: Object.assign({}, shared, this.u) });
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 8; scene.add(this.mesh); this.N = N;
  }
  update() { const a = smoothstep(0.3, 0.75, G.wind); this.u.uActive.value = a; this.mesh.visible = a > 0.02; this.mesh.geometry.instanceCount = Math.floor(this.N * (0.3 + 0.7 * a)); }
}

// ---------------------------------------------------------------------------
// Gulls
// ---------------------------------------------------------------------------
function gullGeometry() {
  // local +x forward, +z right wing. body + two 3-segment wings + tail
  const pos = [], idx = [], wing = [];
  const P = (x, y, z, w) => { pos.push(x, y, z); wing.push(w); return pos.length / 3 - 1; };
  const tri = (a, b, c) => idx.push(a, b, c);
  // body (flat diamond spindle)
  const b0 = P(0.28, 0, 0, 0), b1 = P(0.05, 0.05, 0.05, 0), b2 = P(0.05, 0.05, -0.05, 0), b3 = P(0.05, -0.04, 0, 0), b4 = P(-0.28, 0, 0, 0);
  tri(b0, b1, b2); tri(b0, b3, b1); tri(b0, b2, b3); tri(b4, b2, b1); tri(b4, b1, b3); tri(b4, b3, b2);
  for (const s of [1, -1]) {
    const w0 = P(0.10, 0.02, 0.04 * s, 0), w1 = P(-0.06, 0.02, 0.04 * s, 0);
    const m0 = P(0.10, 0.03, 0.32 * s, 0.5), m1 = P(-0.08, 0.02, 0.30 * s, 0.5);
    const t0 = P(0.02, 0.06, 0.62 * s, 1.0), t1 = P(-0.14, 0.05, 0.6 * s, 1.0);
    if (s > 0) { tri(w0, w1, m0); tri(w1, m1, m0); tri(m0, m1, t0); tri(m1, t1, t0); } else { tri(w0, m0, w1); tri(w1, m0, m1); tri(m0, t0, m1); tri(m1, t0, t1); }
  }
  const t0 = P(-0.28, 0, 0, 0), t1 = P(-0.46, 0, 0.07, 0), t2 = P(-0.46, 0, -0.07, 0); tri(t0, t1, t2); tri(t0, t2, t1);
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('aWing', new THREE.Float32BufferAttribute(wing, 1)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}
class Gulls {
  constructor(scene, N = 46) {
    this.N = N; this.R = mulberry(31); this._qb = new THREE.Quaternion(); this._ax = new THREE.Vector3(1, 0, 0);
    const g = gullGeometry();
    g.setAttribute('aFlap', new THREE.InstancedBufferAttribute(new Float32Array(N * 2), 2));
    this.aFlap = g.attributes.aFlap;
    const mat = new THREE.MeshStandardMaterial({ color: 0xe9ecee, roughness: 0.9, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aWing; attribute vec2 aFlap;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.y += sin(aFlap.x) * aFlap.y * aWing * abs(position.z) * 1.4;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.16, 0.17, 0.19), smoothstep(0.85, 1.0, 0.0));`);
    };
    this.mesh = new THREE.InstancedMesh(g, mat, N); this.mesh.frustumCulled = false; this.mesh.castShadow = false;
    scene.add(this.mesh);
    const centres = [[-700, -1200, 60], [-600, -1050, 40], [-450, -1000, 55], [-330, -540, 45], [-260, -300, 60], [-880, -1500, 70], [-100, -150, 60], [-1000, -1650, 55]];
    this.b = Array.from({ length: N }, (_, i) => { const c = centres[i % centres.length]; return { cx: c[0] + (this.R() - 0.5) * 120, cz: c[1] + (this.R() - 0.5) * 120, h: c[2] * (0.6 + this.R() * 0.8), r: 40 + this.R() * 90, w: (0.10 + this.R() * 0.12) * (this.R() < 0.5 ? 1 : -1), ph: this.R() * 6.28, flap: 0.7 + this.R() * 0.5 }; });
  }
  update(dt, t) {
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(1, 1, 1);
    const ws = windSpeed();
    for (let i = 0; i < this.N; i++) {
      const b = this.b[i];
      const th = b.w * t + b.ph;
      // soaring circles drift downwind and wrap slowly
      const dx = G.windDir.x * ws * 0.12 * Math.sin(t * 0.05 + b.ph) * 6, dz = G.windDir.y * ws * 0.12 * Math.sin(t * 0.05 + b.ph) * 6;
      const x = b.cx + Math.cos(th) * b.r + dx, z = b.cz + Math.sin(th) * b.r + dz;
      const y = b.h + Math.sin(t * 0.13 + b.ph * 3) * 8 + Math.sin(th * 2.0) * 3 + Math.max(heightAt(x, z), 0) * 0.0;
      const tx = -Math.sin(th) * Math.sign(b.w), tz = Math.cos(th) * Math.sign(b.w);
      const yaw = Math.atan2(tz, tx);
      const bank = clamp(-b.w * Math.sign(b.w) * 5.0, -0.7, 0.7) * Math.sign(b.w) * -1;
      q.setFromEuler(e.set(0, -yaw, 0)); q.multiply(this._qb.setFromAxisAngle(this._ax, bank));
      v.set(x, y, z); const sc = 2.3; s.set(sc, sc, sc); M.compose(v, q, s); this.mesh.setMatrixAt(i, M);
      const phase = t * (9 + b.flap * 3) + b.ph * 5; const amp = 0.28 * smoothstep(0.35, 0.9, Math.sin(t * 0.21 + b.ph * 2) * 0.5 + 0.5) + 0.05;
      this.aFlap.setXY(i, phase, amp);
    }
    this.mesh.instanceMatrix.needsUpdate = true; this.aFlap.needsUpdate = true;
  }
}

// ---------------------------------------------------------------------------
// Pond fountain + rooftop steam (soft billboard particles, stateless)
// ---------------------------------------------------------------------------
const puffVert = `
attribute vec4 aR; attribute vec3 aO;
uniform float uTimeL; uniform vec3 uWindL; uniform float uKind; uniform float uRate; uniform float uLife;
varying float vA; varying vec2 vUv; varying float vK;
void main(){
  vUv = uv * 2.0 - 1.0;
  float t = fract(uTimeL * uRate + aR.x);
  float age = t * uLife;
  vec3 p = aO;
  float size;
  if (uKind < 0.5) { // fountain: ballistic droplets thrown up from the nozzle, blown downwind
    float ang = aR.y * 6.2831; float sp = 6.0 + aR.z * 5.0;
    vec3 v0 = vec3(cos(ang) * (0.8 + aR.w * 2.0), sp + 5.0, sin(ang) * (0.8 + aR.w * 2.0));
    p += v0 * age + vec3(0.0, -4.9 * age * age, 0.0) + uWindL * age * age * 0.35;
    size = 0.09 + aR.w * 0.14 + age * 0.05;
    vA = (1.0 - t) * smoothstep(0.0, 0.05, t) * 0.7;
  } else { // steam: rises, bends downwind, expands
    p += vec3(0.0, age * 1.6, 0.0) + uWindL * age * 0.9 + vec3(sin(age * 1.7 + aR.y * 6.0), 0.0, cos(age * 1.3 + aR.z * 6.0)) * age * 0.25;
    size = 0.8 + age * 0.9 * (0.6 + aR.w);
    vA = (1.0 - t) * smoothstep(0.0, 0.12, t) * 0.32;
  }
  vK = uKind;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = p + (right * position.x + up * position.y) * size;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const puffFrag = `varying float vA; varying vec2 vUv; varying float vK; uniform vec3 uAmbL;
void main(){ float r = length(vUv); float a = smoothstep(1.0, 0.0, r); if (vK < 0.5) a = pow(a, 1.2); else a = a * a; gl_FragColor = vec4(mix(vec3(0.85, 0.88, 0.9), uAmbL * 1.9 + 0.05, vK) , a * vA); }`;
class Puffs {
  constructor(scene, origins, kind, perOrigin, rate, life) {
    const N = origins.length * perOrigin; const R = mulberry(kind * 100 + 3);
    const q = new THREE.PlaneGeometry(1, 1); const g = new THREE.InstancedBufferGeometry(); g.index = q.index; g.setAttribute('position', q.attributes.position); g.setAttribute('uv', q.attributes.uv);
    const r = new Float32Array(N * 4), o = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { const oi = origins[Math.floor(i / perOrigin)]; r.set([(i % perOrigin) / perOrigin + R() * 0.01, R(), R(), R()], i * 4); o.set(oi, i * 3); }
    g.setAttribute('aR', new THREE.InstancedBufferAttribute(r, 4)); g.setAttribute('aO', new THREE.InstancedBufferAttribute(o, 3)); g.instanceCount = N;
    const mat = new THREE.ShaderMaterial({ vertexShader: puffVert, fragmentShader: puffFrag, transparent: true, depthWrite: false, uniforms: Object.assign({}, shared, { uKind: { value: kind }, uRate: { value: rate }, uLife: { value: life } }) });
    this.mesh = new THREE.Mesh(g, mat); this.mesh.frustumCulled = false; this.mesh.renderOrder = 7; scene.add(this.mesh);
  }
}

// ---------------------------------------------------------------------------
// Flags (Norwegian) — cloth in the vertex shader, streaming with the wind
// ---------------------------------------------------------------------------
const flagVert = `
uniform float uTimeL; uniform vec3 uWindL; uniform float uStrength; varying vec2 vUv; varying float vShade;
void main(){
  vUv = uv;
  float u = uv.x, v = uv.y;
  float len = 3.2, hgt = 2.35;
  vec3 wd = normalize(vec3(uWindL.x, 0.0, uWindL.z) + 1e-4);
  float k = 1.0 + 0.6 * uStrength;
  float amp = (0.06 + 0.28 * min(uStrength, 1.4)) * u;
  float fph = instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.53;
  float w1 = sin(uTimeL * (5.0 + 5.0 * uStrength) - u * 7.0 * k + fph);
  float w2 = sin(uTimeL * (9.0 + 8.0 * uStrength) - u * 12.0 + v * 4.0 + fph * 2.0) * 0.4;
  float off = (w1 + w2) * amp;
  // cloth extends along wind, hangs from a pole at u=0; droop when calm
  float droop = (1.0 - min(uStrength * 1.3, 1.0)) * u * u * 0.9;
  vec3 local = vec3(u * len, (v - 1.0) * hgt - droop * hgt * 0.5, off * 0.6);
  vec3 side = vec3(-wd.z, 0.0, wd.x);
  vec3 wp = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz + wd * local.x + vec3(0.0, local.y, 0.0) + side * local.z;
  vShade = 0.85 + 0.35 * w1 * u;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const flagFrag = `varying vec2 vUv; varying float vShade; uniform vec3 uAmbL; uniform vec3 uSunL;
void main(){
  // Norwegian flag: red field, white-bordered blue Scandinavian cross (22:16)
  float x = vUv.x * 22.0, y = (1.0 - vUv.y) * 16.0;
  vec3 red = vec3(0.55, 0.02, 0.05), white = vec3(0.78, 0.78, 0.76), blue = vec3(0.0, 0.05, 0.25);
  vec3 c = red;
  bool inWhiteV = x > 6.0 && x < 10.0, inWhiteH = y > 6.0 && y < 10.0;
  bool inBlueV = x > 7.0 && x < 9.0, inBlueH = y > 7.0 && y < 9.0;
  if (inWhiteV || inWhiteH) c = white;
  if (inBlueV || inBlueH) c = blue;
  gl_FragColor = vec4(c * vShade * (uAmbL * 1.5 + 0.06 + uSunL * 0.25), 1.0);
}`;
class Flags {
  constructor(scene, spots) {
    const N = spots.length; if (!N) return;
    const g = new THREE.PlaneGeometry(1, 1, 16, 8);
    const im = new THREE.InstancedMesh(g, new THREE.ShaderMaterial({ vertexShader: flagVert, fragmentShader: flagFrag, side: THREE.DoubleSide, uniforms: shared }), N);
    const m = new THREE.Matrix4();
    spots.forEach((s, i) => { m.makeTranslation(s[0], s[1] + s[3] - 0.25, s[2]); im.setMatrixAt(i, m); });
    im.frustumCulled = false; scene.add(im);
    const pole = new THREE.CylinderGeometry(0.05, 0.08, 1, 6); pole.translate(0, 0.5, 0);
    const pm = new THREE.InstancedMesh(pole, new THREE.MeshStandardMaterial({ color: 0xcfd2d4, roughness: 0.4, metalness: 0.5 }), N);
    spots.forEach((s, i) => { m.compose(new THREE.Vector3(s[0], s[1], s[2]), new THREE.Quaternion(), new THREE.Vector3(1, s[3], 1)); pm.setMatrixAt(i, m); });
    pm.frustumCulled = false; pm.castShadow = true; scene.add(pm);
  }
}

export class Life {
  constructor(scene, city, anchors) {
    this.debris = new Debris(scene);
    this.gulls = new Gulls(scene);
    // fountain in the largest pond
    const pond = ponds.slice().sort((a, b) => b.area - a.area)[0];
    if (pond) {
      const cx = pond.poly.reduce((s, q) => s + q[0], 0) / pond.poly.length, cz = pond.poly.reduce((s, q) => s + q[1], 0) / pond.poly.length;
      this.fountain = new Puffs(scene, [[cx + 6, pond.level + 0.15, cz + 26]], 0, 260, 0.9, 2.6);
    }
    // steam from roof vents on larger flat-roofed buildings
    const R = mulberry(3131);
    const roofs = anchors.filter((a) => a[3] > 900).sort(() => R() - 0.5).slice(0, 26);
    this.steam = new Puffs(scene, roofs.map((a) => [a[0] + (R() - 0.5) * 8, a[2] + 1.8, a[1] + (R() - 0.5) * 8]), 1, 14, 0.09, 9);
    // flags on selected roofs + a few along the harbour
    const flagSpots = anchors.filter((a) => a[3] > 400 && ['civic', 'hotel', 'university', 'office', 'public', 'yes', 'commercial'].includes(a[4])).sort(() => R() - 0.5).slice(0, 28).map((a) => [a[0], a[2], a[1], 5.5 + R() * 3]);
    this.flags = new Flags(scene, flagSpots);
  }
  update(dt, camera, light) {
    const w = windSpeed() * 0.8;
    shared.uTimeL.value = G.time % 900; shared.uCamL.value.copy(camera.position);
    shared.uWindL.value.set(G.windDir.x * w, 0, G.windDir.y * w);
    shared.uWindStrength.value = G.wind;
    const a = light ? light.skyL : 0.3;
    shared.uAmbL.value.setRGB(a, a * 1.02, a * 1.05).multiplyScalar(0.8); shared.uSunL.value.set(1, 0.95, 0.9).multiplyScalar(light ? Math.min(light.sunIntensity / 6, 1) : 0);
    // flag uStrength (per flag uniform is global for simplicity)
    shared.uStrength.value = clamp(windSpeed() / 14, 0, 1.6);
    this.debris.update(); this.gulls.update(dt, G.time);
  }
}
