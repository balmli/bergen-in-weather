import * as THREE from 'three';
import { G, GLSL_NOISE, clamp, mulberry, smoothstep, applyFog } from './common.js';
import { heightAt, demAt } from './terrain.js';

// occupancy raster (buildings + roads) so trees never land in them
function makeOcc(city, bounds, size) {
  const [minx, minz, maxx, maxz] = bounds;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const sx = size / (maxx - minx), sz = size / (maxz - minz);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#f00'; ctx.strokeStyle = '#f00'; ctx.lineJoin = 'round';
  for (const b of city.buildings) {
    ctx.beginPath(); b.p.forEach((q, i) => i ? ctx.lineTo((q[0] - minx) * sx, (q[1] - minz) * sz) : ctx.moveTo((q[0] - minx) * sx, (q[1] - minz) * sz)); ctx.closePath();
    ctx.lineWidth = 2.6 * sx; ctx.fill(); ctx.stroke();
  }
  ctx.fillStyle = '#f00'; for (const w of city.water) { if (w.p.length < 3) continue; ctx.beginPath(); w.p.forEach((q, i) => i ? ctx.lineTo((q[0] - minx) * sx, (q[1] - minz) * sz) : ctx.moveTo((q[0] - minx) * sx, (q[1] - minz) * sz)); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#f00'; ctx.lineWidth = 3 * sx; ctx.stroke(); }
  const W = { motorway: 20, trunk: 20, primary: 12, secondary: 11, tertiary: 9, unclassified: 8, residential: 8, service: 5, pedestrian: 6, living_street: 6, footway: 2.2, cycleway: 2.5, path: 1.5, steps: 2, motorway_link: 8, trunk_link: 8 };
  ctx.strokeStyle = '#0f0';
  for (const r of city.roads) {
    const w = W[r.t]; if (!w || r.tn) continue;
    ctx.beginPath(); r.p.forEach((q, i) => i ? ctx.lineTo((q[0] - minx) * sx, (q[1] - minz) * sz) : ctx.moveTo((q[0] - minx) * sx, (q[1] - minz) * sz));
    ctx.lineWidth = w * sx; ctx.stroke();
  }
  for (const r of city.rails) { ctx.beginPath(); r.p.forEach((q, i) => i ? ctx.lineTo((q[0] - minx) * sx, (q[1] - minz) * sz) : ctx.moveTo((q[0] - minx) * sx, (q[1] - minz) * sz)); ctx.lineWidth = 4 * sx; ctx.stroke(); }
  const d = ctx.getImageData(0, 0, size, size).data;
  return { get(x, z) { const i = Math.floor((x - minx) * sx), j = Math.floor((z - minz) * sz); if (i < 0 || j < 0 || i >= size || j >= size) return 0; const k = (j * size + i) * 4; return d[k] > 128 ? 1 : d[k + 1] > 128 ? 2 : 0; }, bounds };
}
function inPoly(x, z, p) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) if (((p[i][1] > z) !== (p[j][1] > z)) && (x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c; return c; }
function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a / 2); }

function displacedIco(r, detail, seed, squash = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const R = mulberry(seed); const p = g.attributes.position;
  // per-vertex noise displacement (same for coincident verts via position hash)
  const cache = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = p.getX(i).toFixed(3) + ',' + p.getY(i).toFixed(3) + ',' + p.getZ(i).toFixed(3);
    if (!cache.has(k)) cache.set(k, 0.78 + R() * 0.44);
    const s = cache.get(k); p.setXYZ(i, p.getX(i) * s, p.getY(i) * s * squash, p.getZ(i) * s);
  }
  g.computeVertexNormals();
  return g;
}
function coloured(g, rgb, extra = {}) {
  const n = g.attributes.position.count; const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = rgb[0]; col[i * 3 + 1] = rgb[1]; col[i * 3 + 2] = rgb[2]; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
function mergeSimple(list) {
  const pos = [], nor = [], col = [], idx = []; let off = 0;
  for (const g0 of list) {
    const g = g0.index ? g0 : g0; const p = g.attributes.position, n = g.attributes.normal, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(c.getX(i), c.getY(i), c.getZ(i)); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off); else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  m.setIndex(idx); return m;
}
function decidGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.16, 0.26, 3.2, 6); trunk.translate(0, 1.6, 0); parts.push(coloured(trunk, [0.11, 0.075, 0.05]));
  const blobs = [[0, 5.6, 0, 2.9, 1], [1.5, 4.5, 0.5, 2.0, 2], [-1.3, 4.8, -0.9, 2.2, 3], [0.2, 7.3, 0.3, 1.9, 4], [-0.3, 4.2, 1.5, 1.8, 5]];
  for (const [x, y, z, r, s] of blobs) {
    const g = displacedIco(r, 2, 100 + s, 0.85); g.translate(x, y, z);
    // vertex colour: darker toward the lower/inner part, lighter at the top (fake AO)
    const p = g.attributes.position; const col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const h = clamp((p.getY(i) - (y - r)) / (2 * r), 0, 1); const v = 0.45 + 0.75 * h; col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3)); parts.push(g);
  }
  return mergeSimple(parts);
}
function coniferGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.12, 0.22, 2.0, 5); trunk.translate(0, 1.0, 0); parts.push(coloured(trunk, [0.1, 0.07, 0.05]));
  const layers = [[1.6, 2.6, 3.4], [1.35, 2.3, 5.2], [1.0, 2.0, 6.9], [0.65, 1.7, 8.4], [0.3, 1.4, 9.7]];
  layers.forEach(([r, h, y], i) => {
    const g = new THREE.ConeGeometry(r * 1.05, h, 7, 1, true); g.translate(0, y, 0);
    const p = g.attributes.position; const col = new Float32Array(p.count * 3);
    for (let k = 0; k < p.count; k++) { const hh = clamp((p.getY(k) - (y - h / 2)) / h, 0, 1); const v = 0.42 + 0.7 * hh; col[k * 3] = v; col[k * 3 + 1] = v; col[k * 3 + 2] = v; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const q = g.attributes.position; for (let k = 0; k < q.count; k++) q.setX(k, q.getX(k) * (1 + 0.12 * Math.sin(k * 3.1 + i)));
    g.computeVertexNormals(); parts.push(g);
  });
  return mergeSimple(parts);
}

const treeUniforms = { uTimeT: { value: 0 }, uWindT: { value: new THREE.Vector3() }, uGustT: { value: 1 }, uWetT: { value: 0.5 } };

function treeMaterial(conifer) {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, side: conifer ? THREE.DoubleSide : THREE.FrontSide });
  mat.onBeforeCompile = (sh) => {
    applyFog(sh);
    Object.assign(sh.uniforms, treeUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTimeT; uniform vec3 uWindT; uniform float uGustT; varying vec3 vTP;
        `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vTP = position * 1.0 + (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        {
          vec4 wI = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float ph = wI.x * 0.11 + wI.z * 0.13;
          float g = uGustT * (0.75 + 0.25 * sin(uTimeT * 0.7 - dot(wI.xz, uWindT.xz) * 0.06 + ph));
          float hgt = max(position.y, 0.0);
          float bend = pow(hgt * 0.14, 2.0) * ${conifer ? '0.05' : '0.075'} * g;
          float flap = sin(uTimeT * (3.0 + g * 2.0) + position.x * 2.3 + position.z * 1.7 + ph * 4.0) * 0.04 * g * smoothstep(3.0, 6.0, hgt);
          vec3 wd = normalize(uWindT + vec3(1e-4));
          transformed.x += wd.x * (bend * length(uWindT) * 0.5 + flap);
          transformed.z += wd.z * (bend * length(uWindT) * 0.5 + flap);
          transformed.y -= bend * length(uWindT) * 0.02;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTP; uniform sampler2D uNoiseT;
        float tn(vec3 p){ vec2 q = p.xy + p.z * 1.7; vec2 i = floor(q), f = fract(q); f = f*f*(3.0-2.0*f); return texture2D(uNoiseT, (i + f + 0.5) / 256.0).r; }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        float lf = tn(vTP * 2.3) * 0.5 + tn(vTP * 5.1 + 3.0) * 0.3 + tn(vTP * 11.0 + 9.0) * 0.2;
        diffuseColor.rgb *= 0.55 + 0.9 * lf;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          vec3 pn = vec3(tn(vTP * 3.1), tn(vTP * 3.7 + 7.0), tn(vTP * 2.9 + 3.0)) - 0.5;
          normal = normalize(normal + (viewMatrix * vec4(pn, 0.0)).xyz * 1.1);
        }`);
    sh.uniforms.uNoiseT = { value: G.noise };
  };
  return mat;
}

export class Trees {
  constructor(scene, city) {
    this.scene = scene;
    const R = mulberry(404);
    const fine = [-1000, -1400, 800, 400];
    const coarse = [-2600, -2900, 2200, 1900];
    this.occF = makeOcc(city, fine, 2048);
    this.occC = makeOcc(city, coarse, 2048);
    const occ = (x, z) => { const a = this.occF.get(x, z); if (x > fine[0] && x < fine[2] && z > fine[1] && z < fine[3]) return a; return this.occC.get(x, z); };
    const dec = [], con = [];
    const isSeaAt = (x, z) => demAt(x, z) < 0.9;
    const tryAdd = (arr, x, z, s, kind) => { if (occ(x, z)) return; if (isSeaAt(x, z)) return; arr.push([x, z, s, kind]); };
    // 1. parks
    for (const p of city.parks) {
      if (p.p.length < 3 || p.t === 'pitch') continue;
      const a = polyArea(p.p); if (a < 150 || a > 200000) continue;
      let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9; for (const q of p.p) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); minz = Math.min(minz, q[1]); maxz = Math.max(maxz, q[1]); }
      const dens = p.t === 'forest' ? 1 / 55 : p.t === 'garden' ? 1 / 220 : p.t === 'cemetery' ? 1 / 160 : 1 / 260;
      const n = Math.min(Math.round(a * dens), 1200);
      for (let i = 0, tries = 0; i < n && tries < n * 6; tries++) { const x = minx + R() * (maxx - minx), z = minz + R() * (maxz - minz); if (!inPoly(x, z, p.p)) continue; i++; tryAdd(p.t === 'forest' && R() < 0.6 ? con : dec, x, z, 0.75 + R() * 0.7, R()); }
    }
    // 2. street trees + garden trees
    const treeRoads = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian']);
    for (const r of city.roads) {
      if (!treeRoads.has(r.t) || r.tn) continue;
      for (let i = 1; i < r.p.length; i++) {
        const a = r.p[i - 1], b = r.p[i]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 6) continue;
        const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len; const off = (r.t === 'primary' || r.t === 'secondary' ? 6.8 : r.t === 'pedestrian' ? 4.2 : 5.4);
        for (let s = 5 + R() * 8; s < len - 3; s += 13 + R() * 9) {
          if (R() < 0.42) continue;
          const side = R() < 0.5 ? -1 : 1;
          const x = a[0] + dx * s - dz * off * side + (R() - 0.5) * 1.5, z = a[1] + dz * s + dx * off * side + (R() - 0.5) * 1.5;
          if (Math.hypot(x + 250, z + 550) > 1100) continue;
          tryAdd(dec, x, z, 0.65 + R() * 0.5, R());
        }
      }
    }
    for (const b of city.buildings) {
      const A = polyArea(b.p); if (A > 320 || A < 40) continue;
      const cx = b.p.reduce((s, q) => s + q[0], 0) / b.p.length, cz = b.p.reduce((s, q) => s + q[1], 0) / b.p.length;
      const n = R() < 0.65 ? 1 + (R() < 0.4 ? 1 : 0) : 0;
      for (let i = 0; i < n; i++) { const a = R() * 6.28, d = 7 + R() * 7; tryAdd(R() < 0.25 ? con : dec, cx + Math.cos(a) * d, cz + Math.sin(a) * d, 0.6 + R() * 0.7, R()); }
    }
    // 3. hillside forest (uses real terrain; sparse near city, dense above)
    const fnoise = (x, z) => { const s = Math.sin(x * 0.011 + 1.3) * Math.sin(z * 0.013 + 0.4) + Math.sin(x * 0.0037 - z * 0.0051 + 2.0) + 0.5 * Math.sin(x * 0.043 + z * 0.037); return s * 0.3 + 0.5; };
    const step = 10;
    let nf = 0;
    for (let x = -3200; x <= 3000 && nf < 28000; x += step) for (let z = -3400; z <= 2600 && nf < 28000; z += step) {
      const jx = x + (R() - 0.5) * step * 0.9, jz = z + (R() - 0.5) * step * 0.9;
      const dc = Math.hypot(jx + 100, jz + 500);
      if (dc > 3300) continue;
      const h = heightAt(jx, jz); if (h < 12 || h > 390) continue;
      const sl = Math.abs(heightAt(jx + 6, jz) - h) + Math.abs(heightAt(jx, jz + 6) - h);
      if (sl > 14) continue;
      if (occ(jx, jz)) continue;
      const dens = smoothstep(12, 90, h) * (1 - smoothstep(320, 390, h)) * clamp(fnoise(jx, jz) * 1.15, 0, 1);
      // keep the built-up core clear of wild forest
      const urban = 1 - smoothstep(350, 800, Math.hypot(jx + 250, jz + 500)) * 0;
      if (R() > dens * 0.85) continue;
      const cnt = (city.parks.some(() => false)) ? 0 : 1;
      const conif = R() < smoothstep(120, 260, h) * 0.7 + 0.28;
      (conif ? con : dec).push([jx, jz, 0.9 + R() * 0.9, R()]); nf++;
    }
    this.count = { dec: dec.length, con: con.length };
    this.build(dec, con);
  }
  build(dec, con) {
    const make = (list, geo, conifer) => {
      const n = list.length; const m = new THREE.InstancedMesh(geo, treeMaterial(conifer), Math.max(n, 1));
      const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();
      const R = mulberry(9);
      // autumn palette (late September in Bergen): mostly green, birches and rowans turning
      const greens = [[0.06, 0.13, 0.04], [0.07, 0.15, 0.045], [0.09, 0.17, 0.05], [0.055, 0.11, 0.04]];
      const conif_c = [[0.02, 0.06, 0.03], [0.025, 0.07, 0.035], [0.03, 0.075, 0.04]];
      for (let i = 0; i < n; i++) {
        const [x, z, sc, k] = list[i];
        const y = heightAt(x, z);
        e.set(0, R() * 6.28, 0); q.setFromEuler(e); v.set(x, y - 0.1, z); s.set(sc * (0.85 + R() * 0.3), sc * (0.9 + R() * 0.3), sc * (0.85 + R() * 0.3));
        M.compose(v, q, s); m.setMatrixAt(i, M);
        let col;
        if (conifer) col = conif_c[(R() * conif_c.length) | 0];
        else { const u = R(); col = u < 0.55 ? greens[(R() * 4) | 0] : u < 0.72 ? [0.16, 0.2, 0.05] : u < 0.86 ? [0.34, 0.27, 0.05] : u < 0.95 ? [0.42, 0.16, 0.035] : [0.28, 0.06, 0.035]; }
        const j = 0.85 + R() * 0.3; c.setRGB(col[0] * j, col[1] * j, col[2] * j); m.setColorAt(i, c);
      }
      m.count = n; m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false;
      this.scene.add(m); return m;
    };
    this.dec = make(dec, decidGeometry(), false);
    this.con = make(con, coniferGeometry(), true);
  }
  update(cam) {
    const u = treeUniforms; u.uTimeT.value = G.time % 300;
    const w = 3 + G.wind * 21;
    u.uWindT.value.set(G.windDir.x * w * 0.35, 0, G.windDir.y * w * 0.35);
    u.uGustT.value = 0.5 + G.wind * 0.8;
  }
}
