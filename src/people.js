import * as THREE from 'three';
import { G, clamp, lerp, mulberry, smoothstep, windAt, windSpeed, gustAt, applyFog } from './common.js';
import { heightAt } from './terrain.js';

// ---------------------------------------------------------------------------
// Person geometry: low-poly body parts, animated entirely in the vertex shader
// parts: 0 torso 1 head 2 thighL 3 thighR 4 shinL 5 shinR 6 armL 7 armR (umbrella arm) 8 hood 9 shoes
// ---------------------------------------------------------------------------
function cyl(rTop, rBot, h, seg, x, y, z, part, pivot, tint, sx = 1, sz = 1) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
  g.scale(sx, 1, sz);
  g.translate(x, y + h / 2, z);
  const n = g.attributes.position.count;
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(n).fill(part), 1));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => pivot[i % 3]), 3));
  g.setAttribute('aTint', new THREE.Float32BufferAttribute(new Array(n).fill(tint), 1)); // 0 jacket 1 trousers 2 skin 3 hair/dark 4 shoe 5 hood(jacket)
  return g;
}
function sphere(r, x, y, z, part, pivot, tint, sy = 1) {
  const g = new THREE.SphereGeometry(r, 8, 6); g.scale(1, sy, 1); g.translate(x, y, z);
  const n = g.attributes.position.count;
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(n).fill(part), 1));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => pivot[i % 3]), 3));
  g.setAttribute('aTint', new THREE.Float32BufferAttribute(new Array(n).fill(tint), 1));
  return g;
}
function merge(list) {
  const pos = [], nor = [], uv = [], idx = [], part = [], piv = [], tint = []; let off = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i));
      part.push(g.attributes.aPart.getX(i)); piv.push(g.attributes.aPivot.getX(i), g.attributes.aPivot.getY(i), g.attributes.aPivot.getZ(i)); tint.push(g.attributes.aTint.getX(i));
    }
    for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off);
    off += p.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  m.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1)); m.setAttribute('aPivot', new THREE.Float32BufferAttribute(piv, 3)); m.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 1));
  m.setIndex(idx); return m;
}
function personGeometry() {
  const hip = [0, 0.92, 0], sh = [0, 1.46, 0];
  const L = [];
  // legs (x = lateral, z = forward). thigh 0.92->0.5, shin 0.5->0.06
  for (const sgn of [-1, 1]) {
    const px = sgn * 0.085; const knee = [px, 0.5, 0], hp = [px, 0.92, 0];
    L.push(cyl(0.062, 0.055, 0.42, 6, px, 0.5, 0, sgn < 0 ? 2 : 3, hp, 1));
    L.push(cyl(0.05, 0.042, 0.42, 6, px, 0.08, 0, sgn < 0 ? 4 : 5, hp, 1));
    L.push(cyl(0.05, 0.05, 0.08, 6, px, 0.0, 0.035, sgn < 0 ? 4 : 5, hp, 4, 1, 1.9));
  }
  // torso (jacket to mid-thigh)
  L.push(cyl(0.155, 0.17, 0.68, 8, 0, 0.86, 0, 0, hip, 0, 1.0, 0.68));
  // arms: swing from shoulder
  L.push(cyl(0.048, 0.04, 0.58, 6, -0.215, 0.9, 0, 6, [-0.215, 1.44, 0], 0));
  L.push(cyl(0.048, 0.04, 0.58, 6, 0.215, 0.9, 0, 7, [0.215, 1.44, 0], 0));
  L.push(sphere(0.045, -0.215, 0.88, 0, 6, [-0.215, 1.44, 0], 2));
  L.push(sphere(0.045, 0.215, 0.88, 0, 7, [0.215, 1.44, 0], 2));
  // head + hood
  L.push(sphere(0.105, 0, 1.62, 0.01, 1, hip, 2, 1.12));
  L.push(sphere(0.118, 0, 1.63, -0.02, 8, hip, 5, 1.05));
  return merge(L);
}

// ---------------------------------------------------------------------------
// Umbrella geometry: 8-rib dome; states handled in the vertex shader
// ---------------------------------------------------------------------------
function umbrellaGeometry() {
  const R = 0.52, H = 0.20, NR = 8, SEG = 6;
  const pos = [], idx = [], aPan = [], aRad = [], aAng = [], aKind = [];
  // canopy: NR panels x (SEG) rings, each panel spans 2 rib angles with slight sag between
  const RS = 4; // subdivisions across a panel
  for (let p = 0; p < NR; p++) {
    const base = pos.length / 3;
    for (let j = 0; j <= SEG; j++) for (let i = 0; i <= RS; i++) {
      const rr = (j + 0.0) / SEG; const a = (p + i / RS) / NR * Math.PI * 2;
      pos.push(0, 0, 0); aPan.push(p); aRad.push(rr); aAng.push(a); aKind.push(i / RS);
    }
    for (let j = 0; j < SEG; j++) for (let i = 0; i < RS; i++) {
      const a = base + j * (RS + 1) + i, b = a + 1, c = a + RS + 1, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPan', new THREE.Float32BufferAttribute(aPan, 1));
  g.setAttribute('aRad', new THREE.Float32BufferAttribute(aRad, 1));
  g.setAttribute('aAng', new THREE.Float32BufferAttribute(aAng, 1));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(aKind, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map(() => 0), 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 2.5);
  return g;
}
// ribs + shaft as thin quads (line-like), same vertex function
function umbrellaRibGeometry() {
  const NR = 8, SEG = 8; const pos = [], idx = [], aPan = [], aRad = [], aAng = [], aKind = [];
  for (let p = 0; p < NR; p++) {
    const base = pos.length / 3;
    for (let j = 0; j <= SEG; j++) for (let s = 0; s < 2; s++) { pos.push(0, 0, 0); aPan.push(p); aRad.push(j / SEG); aAng.push(p / NR * Math.PI * 2); aKind.push(s ? 1 : 0); }
    for (let j = 0; j < SEG; j++) { const a = base + j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  // shaft: vertical (rad<0 marks shaft)
  const base = pos.length / 3;
  for (let j = 0; j <= 4; j++) for (let s = 0; s < 2; s++) { pos.push(0, 0, 0); aPan.push(9); aRad.push(-j / 4); aAng.push(0); aKind.push(s); }
  for (let j = 0; j < 4; j++) { const a = base + j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aPan', new THREE.Float32BufferAttribute(aPan, 1)); g.setAttribute('aRad', new THREE.Float32BufferAttribute(aRad, 1));
  g.setAttribute('aAng', new THREE.Float32BufferAttribute(aAng, 1)); g.setAttribute('aKind', new THREE.Float32BufferAttribute(aKind, 1));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map(() => 0), 3));
  g.setIndex(idx); g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2.5);
  return g;
}

const umbrellaFunc = /* glsl */`
attribute float aPan; attribute float aRad; attribute float aAng; attribute float aKind;
attribute vec4 aU;   // x flip 0..1, y broken panel mask (bits as float 0..255), z bent rib mask, w rand
attribute vec4 aUt;  // x time phase, y gust flutter, z lean tilt (unused), w state
uniform float uTimeU;
const float UR = 0.52;
float hsh(float n){ return fract(sin(n * 12.9898) * 43758.5453); }
vec3 umbrellaP(out vec3 nrm, bool isRib){
  float flip = aU.x; float mask = aU.y; float bent = aU.z; float rnd = aU.w;
  float r = aRad;
  float a = aAng;
  vec3 p;
  if (r < 0.0) { // shaft
    float t = -r; p = vec3(0.0, 0.14 - 0.78 * t, 0.0); nrm = vec3(0.0,0.0,1.0);
    p.x += (aKind - 0.5) * 0.012;
    return p;
  }
  float dome = 0.24 * (1.0 - r * r) + 0.02;          // upright: apex high, rim low
  float inv = -0.30 * (1.0 - r * r) * (0.8 + 0.2 * r) + 0.10 * r; // inside-out bowl, rim curls up
  float y = mix(dome, inv, flip);
  float rad = UR * r * mix(1.0, 0.92, flip);
  // scallop: fabric sags between ribs
  float sag = isRib ? 0.0 : 0.045 * sin(fract(a / 0.785398) * 3.14159) * r * (1.0 - flip * 0.6);
  y -= sag;
  // wind flutter
  float fl = aUt.y * (0.02 + 0.06 * r) * sin(uTimeU * 14.0 + a * 3.0 + rnd * 20.0 + r * 5.0);
  y += fl * (isRib ? 0.3 : 1.0);
  // damage: missing panel collapses to the hub; bent ribs kink and stick out
  float pid = aPan;
  float missing = mod(floor(mask / pow(2.0, pid)), 2.0);
  float bentB = mod(floor(bent / pow(2.0, pid)), 2.0);
  if (missing > 0.5 && !isRib) { rad *= 0.25 + 0.1 * r; y -= 0.15 * r + 0.05 * sin(uTimeU * 9.0 + pid); }
  if (bentB > 0.5) { float k = smoothstep(0.35, 1.0, r); y += k * (0.12 + 0.1 * hsh(pid + rnd * 7.0)) * (hsh(pid * 3.1 + rnd) > 0.5 ? 1.0 : -1.0); rad *= 1.0 + 0.18 * k; a += k * 0.25 * (hsh(pid + rnd) - 0.5) * 2.0; }
  // also torn fabric flaps loosely
  p = vec3(cos(a) * rad, y, sin(a) * rad);
  nrm = normalize(vec3(cos(a) * r * 0.9, mix(1.0, -1.0, flip) * 1.0, sin(a) * r * 0.9));
  return p;
}
`;

// ---------------------------------------------------------------------------
export class People {
  constructor(scene, city, N = 650) {
    this.N = N; this.scene = scene;
    this.rand = mulberry(2026);
    this.buildNetwork(city);
    this.makeMeshes();
    this.spawn();
    this.acc = 0;
  }

  buildNetwork(city) {
    const walkable = new Set(['footway', 'pedestrian', 'living_street', 'path', 'steps', 'residential', 'service', 'tertiary', 'secondary', 'primary', 'unclassified', 'cycleway']);
    this.ways = [];
    for (const r of city.roads) {
      if (!walkable.has(r.t) || r.tn || r.p.length < 2) continue;
      // keep to the map region we care about
      const c = r.p[Math.floor(r.p.length / 2)];
      if (Math.hypot(c[0] + 250, c[1] + 600) > 1150) continue;
      const cum = [0]; for (let i = 1; i < r.p.length; i++) cum.push(cum[i - 1] + Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]));
      if (cum[cum.length - 1] < 6) continue;
      const wide = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential'].includes(r.t);
      this.ways.push({ p: r.p, cum, len: cum[cum.length - 1], off: wide ? 4.6 : (r.t === 'steps' ? 0.3 : 0.6), t: r.t });
    }
    // adjacency by endpoint
    const key = (q) => Math.round(q[0] * 2) + ',' + Math.round(q[1] * 2);
    this.adj = new Map();
    this.ways.forEach((w, i) => {
      for (const end of [0, 1]) { const q = end ? w.p[w.p.length - 1] : w.p[0]; const k = key(q); if (!this.adj.has(k)) this.adj.set(k, []); this.adj.get(k).push([i, end]); }
    });
    this.key = key;
    // weights: favour pedestrian-rich, central ways (pond / Torgallmenningen / Nygard / Storsenter)
    this.weights = this.ways.map((w) => {
      const c = w.p[Math.floor(w.p.length / 2)];
      const d = Math.hypot(c[0] + 250, c[1] + 560);
      let k = (w.t === 'footway' || w.t === 'pedestrian' || w.t === 'living_street') ? 1.6 : 0.6;
      if (w.t === 'steps') k = 0.25;
      return w.len * k * (0.35 + 0.65 * Math.exp(-d / 420));
    });
    let s = 0; this.cw = this.weights.map((w) => (s += w)); this.wsum = s;
  }
  pickWay() {
    const x = this.rand() * this.wsum; let lo = 0, hi = this.cw.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.cw[m] < x) lo = m + 1; else hi = m; }
    return lo;
  }

  makeMeshes() {
    const N = this.N;
    const geo = personGeometry();
    const mk = (n, size) => new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
    this.aAnim = mk(N, 4); this.aCol1 = mk(N, 4); this.aCol2 = mk(N, 3);
    geo.setAttribute('aAnim', this.aAnim); geo.setAttribute('aCol1', this.aCol1); geo.setAttribute('aCol2', this.aCol2);
    this.aAnim.setUsage(THREE.DynamicDrawUsage);
    const skin = [new THREE.Color(0.55, 0.36, 0.27), new THREE.Color(0.75, 0.55, 0.42), new THREE.Color(0.35, 0.22, 0.16), new THREE.Color(0.85, 0.66, 0.55)];
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0 });
    const uT = { value: 0 };
    mat.onBeforeCompile = (sh) => {
      applyFog(sh); sh.uniforms.uTimeP = uT;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aPart; attribute vec3 aPivot; attribute float aTint; attribute vec4 aAnim; attribute vec4 aCol1; attribute vec3 aCol2;
          uniform float uTimeP; varying vec3 vTint;
          vec3 rotX(vec3 p, vec3 c, float a){ vec3 q = p - c; float s = sin(a), co = cos(a); return c + vec3(q.x, q.y * co - q.z * s, q.y * s + q.z * co); }
          vec3 rotZ(vec3 p, vec3 c, float a){ vec3 q = p - c; float s = sin(a), co = cos(a); return c + vec3(q.x * co - q.y * s, q.x * s + q.y * co, q.z); }`)
        .replace('#include <begin_vertex>', `
          vec3 transformed = position;
          float ph = aAnim.x; float stride = aAnim.y; float leanF = aAnim.z; float leanS = aAnim.w;
          float A = 0.62 * stride;
          float s1 = sin(ph), s2 = sin(ph + 3.14159);
          vec3 hip = vec3(0.0, 0.92, 0.0);
          int part = int(aPart + 0.5);
          if (part == 2) transformed = rotX(transformed, aPivot, s1 * A);
          else if (part == 3) transformed = rotX(transformed, aPivot, s2 * A);
          else if (part == 4) { float bend = max(0.0, -cos(ph)) * 1.0 * stride; transformed = rotX(transformed, vec3(aPivot.x, 0.5, 0.0), -bend); transformed = rotX(transformed, aPivot, s1 * A); }
          else if (part == 5) { float bend = max(0.0, cos(ph)) * 1.0 * stride; transformed = rotX(transformed, vec3(aPivot.x, 0.5, 0.0), -bend); transformed = rotX(transformed, aPivot, s2 * A); }
          else if (part == 6) { transformed = rotX(transformed, aPivot, s2 * A * 0.9); }
          else if (part == 7) { transformed = rotX(transformed, aPivot, aCol1.w > 0.5 ? (-1.30 + 0.04 * s1) : s1 * A * 0.9); }
          if (part == 0 || part == 1 || part == 6 || part == 7 || part == 8) {
            transformed.y += abs(s1) * 0.018 * stride;
            transformed = rotX(transformed, hip, min(leanF, 0.6));
            transformed = rotZ(transformed, hip, leanS);
          }
          int tint = int(aTint + 0.5);
          vTint = tint == 0 || tint == 5 ? aCol1.rgb : (tint == 1 ? aCol2 : (tint == 2 ? vec3(0.62, 0.42, 0.33) : (tint == 3 ? vec3(0.06, 0.05, 0.04) : vec3(0.05, 0.05, 0.05))));
          if (tint == 2) vTint *= 0.7 + 0.5 * fract(aCol2.r * 7.0 + aCol1.g * 3.0);
        `)
        .replace('#include <color_vertex>', '#include <color_vertex>');
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTint;')
        .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vTint;');
    };
    this.pmesh = new THREE.InstancedMesh(geo, mat, N);
    this.pmesh.frustumCulled = false; this.pmesh.castShadow = true; this.pmesh.receiveShadow = true;
    this.pmesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.scene.add(this.pmesh);
    this.uTP = uT;

    // umbrellas
    const ug = umbrellaGeometry(), rg = umbrellaRibGeometry();
    this.aU = mk(N, 4); this.aUt = mk(N, 4);
    this.aU.setUsage(THREE.DynamicDrawUsage); this.aUt.setUsage(THREE.DynamicDrawUsage);
    this.aUcol = mk(N, 3);
    for (const g of [ug, rg]) { g.setAttribute('aU', this.aU); g.setAttribute('aUt', this.aUt); g.setAttribute('aUcol', this.aUcol); }
    const uu = { value: 0 };
    const patch = (rib) => (sh) => {
      applyFog(sh); sh.uniforms.uTimeU = uu;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>\n${umbrellaFunc}\nattribute vec3 aUcol; varying vec3 vUCol; varying float vUflip;`)
        .replace('#include <beginnormal_vertex>', `
          vec3 uN; vec3 uP = umbrellaP(uN, ${rib ? 'true' : 'false'});
          vec3 objectNormal = uN;
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3( tangent.xyz );
          #endif`)
        .replace('#include <begin_vertex>', `vec3 transformed = uP;
          ${rib ? 'transformed.xz += (aKind - 0.5) * 0.008 * vec2(1.0, 1.0);' : ''}
          vUCol = aUcol; vUflip = aU.x;`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vUCol; varying float vUflip;')
        .replace('#include <color_fragment>', `#include <color_fragment>\ndiffuseColor.rgb = ${rib ? 'vec3(0.05,0.05,0.055)' : 'vUCol'};`);
    };
    const cmat = new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0.0, side: THREE.DoubleSide });
    cmat.onBeforeCompile = patch(false);
    const rmat = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.7, side: THREE.DoubleSide });
    rmat.onBeforeCompile = patch(true);
    this.umesh = new THREE.InstancedMesh(ug, cmat, N); this.rmesh = new THREE.InstancedMesh(rg, rmat, N);
    for (const m of [this.umesh, this.rmesh]) { m.frustumCulled = false; m.castShadow = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.scene.add(m); }
    this.uU = uu;
    this.skin = skin;
  }

  spawn() {
    const N = this.N, r = this.rand;
    this.st = [];
    const jackets = [0x1c2d4a, 0x8f1f24, 0x1f4a3a, 0xd8b21c, 0x2b2b2e, 0x3d5a80, 0xc8511d, 0x6a6c70, 0x1a1a1c, 0x7b2d5f, 0xe8e2d0, 0x2c6b8a, 0x4c4f31];
    const pants = [0x1c1f26, 0x2d3140, 0x3a3a3c, 0x4b4034, 0x181818, 0x2f4058];
    const ucols = [0x0f0f12, 0x14213d, 0x7a1720, 0x1b3d2f, 0x2b2b2e, 0xcbb51c, 0x2a5aa0, 0xe8e2d0, 0x6a2a6a];
    const tmp = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const wi = this.pickWay(); const w = this.ways[wi];
      const p = {
        way: wi, d: r() * w.len, dir: r() < 0.5 ? 1 : -1, speed: 1.15 + r() * 0.5, lat: (r() < 0.5 ? -1 : 1) * (0.2 + r() * 0.7) * (w.off > 2 ? 1 : 0.5),
        h: 1.62 + r() * 0.26, phase: r() * 6.28, x: 0, z: 0, hdg: 0, seed: r(),
        // umbrella: 0 none(hood), 1 intact, 2 inverted, 3 broken
        umb: (() => { const u = r(); return u < 0.20 ? 0 : u < 0.36 ? 1 : u < 0.68 ? 2 : 3; })(),
        flipAmt: 0, flipTarget: 0, tilt: 0, mask: 0, bent: 0,
      };
      if (p.umb === 3) { p.mask = (r() * 255) | 0; p.bent = (r() * 255) | 0; p.flip = r() < 0.5 ? 1 : 0; }
      if (p.umb === 2) { p.mask = r() < 0.4 ? (1 << ((r() * 8) | 0)) : 0; p.bent = r() < 0.7 ? (1 << ((r() * 8) | 0)) | (1 << ((r() * 8) | 0)) : 0; }
      if (p.umb === 1) { p.bent = 0; }
      this.st.push(p);
      tmp.setHex(jackets[(r() * jackets.length) | 0]).convertSRGBToLinear();
      this.aCol1.setXYZW(i, tmp.r, tmp.g, tmp.b, p.umb > 0 ? 1 : 0);
      tmp.setHex(pants[(r() * pants.length) | 0]).convertSRGBToLinear();
      this.aCol2.setXYZ(i, tmp.r, tmp.g, tmp.b);
      tmp.setHex(ucols[(r() * ucols.length) | 0]).convertSRGBToLinear();
      this.aUcol.setXYZ(i, tmp.r, tmp.g, tmp.b);
    }
    this.aCol1.needsUpdate = this.aCol2.needsUpdate = this.aUcol.needsUpdate = true;
  }

  pathPoint(w, d, dir, lat, out) {
    // position + heading at distance d along way w with lateral offset (right of travel direction)
    let i = 1; while (i < w.cum.length - 1 && w.cum[i] < d) i++;
    const a = w.p[i - 1], b = w.p[i]; const seg = w.cum[i] - w.cum[i - 1] || 1; const t = clamp((d - w.cum[i - 1]) / seg, 0, 1);
    const dx = (b[0] - a[0]) / seg, dz = (b[1] - a[1]) / seg;
    const sx = dx * dir, sz = dz * dir;
    // lateral offset: perpendicular right of travel (x=east, z=south): right = (-sz, sx) rotated...
    const rx = -sz, rz = sx;
    out.x = a[0] + (b[0] - a[0]) * t + rx * lat; out.z = a[1] + (b[1] - a[1]) * t + rz * lat; out.hdg = Math.atan2(sx, sz); // facing +z local, yaw about Y
  }

  update(dt, camera) {
    // fixed sub-stepping keeps walking deterministic under uneven frame times
    this.acc = Math.min(this.acc + dt, 0.1);
    const STEP = 1 / 60; let n = 0;
    while (this.acc >= STEP && n < 4) { this.acc -= STEP; n++; this.integrate(STEP); }
    const N = this.N, t = G.time, wsp = windSpeed();
    const out = this._out || (this._out = { x: 0, z: 0, hdg: 0 });
    const tmpM = this._m || (this._m = new THREE.Matrix4()), e = this._e || (this._e = new THREE.Euler()), v = this._v || (this._v = new THREE.Vector3()), sc = this._s || (this._s = new THREE.Vector3());
    const q = this._q || (this._q = new THREE.Quaternion()), qy = this._qy || (this._qy = new THREE.Quaternion()), ql = this._ql || (this._ql = new THREE.Quaternion()), qt = this._qt || (this._qt = new THREE.Quaternion()), qq = this._qq || (this._qq = new THREE.Quaternion());
    const eL = this._eL || (this._eL = new THREE.Euler()), eT = this._eT || (this._eT = new THREE.Euler()), off = this._off || (this._off = new THREE.Vector3());
    const wdx = G.windDir.x, wdz = G.windDir.y;
    this.uTP.value = t % 300; this.uU.value = t % 300;
    for (let i = 0; i < N; i++) {
      const p = this.st[i]; const w = this.ways[p.way];
      this.pathPoint(w, p.d, p.dir, p.lat, out);
      p.x = out.x; p.z = out.z; p.hdg = out.hdg;
      const y = heightAt(p.x, p.z);
      const gust = wsp * gustAt(p.x, p.z, t);
      const fx = Math.sin(p.hdg), fz = Math.cos(p.hdg);
      const headwind = -(wdx * fx + wdz * fz) * gust;     // >0 : wind in the face
      const side = (wdx * fz - wdz * fx) * gust;           // lateral push
      const leanF = clamp(0.05 + headwind * 0.014, -0.06, 0.42);
      const leanS = clamp(side * 0.010, -0.26, 0.26);
      const stride = clamp(1.0 - headwind * 0.012, 0.55, 1.15);
      this.aAnim.setXYZW(i, p.phase, stride, leanF, leanS);
      const s = p.h / 1.75;
      e.set(0, p.hdg, 0); qy.setFromEuler(e); v.set(p.x, y, p.z); sc.set(s, s, s);
      tmpM.compose(v, qy, sc); this.pmesh.setMatrixAt(i, tmpM);
      if (p.umb > 0) {
        const g = gust / Math.max(wsp, 1);
        const target = p.umb === 2 ? 1 : p.umb === 3 ? (p.flip || 0) : smoothstep(1.28, 1.55, g * (0.75 + 0.45 * Math.sin(t * 0.3 + p.seed * 40))) * 0.92;
        p.flipAmt += (target - p.flipAmt) * (1 - Math.exp(-dt * (p.umb === 1 ? 5 : 2)));
        const tiltIn = clamp(headwind * 0.035 + Math.abs(side) * 0.01, -0.5, 0.8);
        const flut = clamp(gust / 14, 0.1, 1.6) * (0.6 + 0.6 * p.seed);
        this.aU.setXYZW(i, p.flipAmt, p.mask, p.bent, p.seed);
        this.aUt.setXYZW(i, t, flut, 0, p.umb);
        const wob = Math.sin(t * (3 + p.seed * 3) + p.seed * 20) * 0.07 * clamp(gust / 12, 0, 1.5);
        eL.set(leanF * 0.9, 0, leanS * 0.5); ql.setFromEuler(eL);
        eT.set(tiltIn * 0.8 + 0.08 + wob, 0, clamp(-0.10 + wob * 1.3 + leanS * 0.8, -0.7, 0.5)); qt.setFromEuler(eT);
        qq.copy(qy).multiply(ql); q.copy(qq).multiply(qt);
        off.set(0.17 * s, 1.95 * s, 0.40 * s).applyQuaternion(qq);
        tmpM.compose(v.clone().add(off), q, sc);
        this.umesh.setMatrixAt(i, tmpM); this.rmesh.setMatrixAt(i, tmpM);
      } else {
        this.aU.setXYZW(i, 0, 0, 0, 0);
        tmpM.makeScale(0, 0, 0); this.umesh.setMatrixAt(i, tmpM); this.rmesh.setMatrixAt(i, tmpM);
      }
    }
    this.pmesh.instanceMatrix.needsUpdate = true; this.umesh.instanceMatrix.needsUpdate = true; this.rmesh.instanceMatrix.needsUpdate = true;
    this.aAnim.needsUpdate = this.aU.needsUpdate = this.aUt.needsUpdate = true;
  }

  integrate(dt) {
    const wsp = windSpeed();
    for (const p of this.st) {
      const w = this.ways[p.way];
      const hw = 0;
      p.d += p.dir * p.speed * dt * (1 - 0.15 * G.wind);
      p.phase += dt * (p.speed * 6.2);
      if (p.d > w.len || p.d < 0) {
        // reached an end: hop to a connected way if any, otherwise turn around
        const end = p.d > w.len ? 1 : 0;
        const q = end ? w.p[w.p.length - 1] : w.p[0];
        const list = (this.adj.get(this.key(q)) || []).filter(([wi]) => wi !== p.way);
        if (list.length && this.rand() < 0.92) {
          const [wi, e2] = list[(this.rand() * list.length) | 0];
          p.way = wi; const w2 = this.ways[wi]; p.d = e2 ? w2.len - 0.01 : 0.01; p.dir = e2 ? -1 : 1;
        } else { p.dir *= -1; p.d = clamp(p.d, 0.01, w.len - 0.01); }
      }
    }
  }
}
