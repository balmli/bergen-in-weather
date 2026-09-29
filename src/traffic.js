import * as THREE from 'three';
import { G, GLSL_NOISE, clamp, lerp, mulberry, smoothstep, applyFog } from './common.js';
import { heightAt } from './terrain.js';
import { SoupBuilder, STYLE, hexLin } from './builder.js';

// ---------------------------------------------------------------------------
// Road graph (for cars) — directional ways with endpoint adjacency
// ---------------------------------------------------------------------------
function buildNet(city, classes, centre, radius) {
  const ways = [];
  for (const r of city.roads) {
    if (!classes.has(r.t) || r.tn || r.p.length < 2) continue;
    const c = r.p[Math.floor(r.p.length / 2)];
    if (Math.hypot(c[0] - centre[0], c[1] - centre[1]) > radius) continue;
    const cum = [0]; for (let i = 1; i < r.p.length; i++) cum.push(cum[i - 1] + Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]));
    if (cum[cum.length - 1] < 12) continue;
    ways.push({ p: r.p, cum, len: cum[cum.length - 1], ow: !!r.ow, t: r.t, lane: r.ow ? 1.4 : 2.0 });
  }
  const key = (q) => Math.round(q[0] * 2) + ',' + Math.round(q[1] * 2);
  const adj = new Map();
  ways.forEach((w, i) => {
    const s = key(w.p[0]), e = key(w.p[w.p.length - 1]);
    if (!adj.has(s)) adj.set(s, []); adj.get(s).push([i, 0]);
    if (!adj.has(e)) adj.set(e, []); adj.get(e).push([i, 1]);
  });
  return { ways, adj, key };
}
function pointOn(w, d, dir, lat, out) {
  let i = 1; while (i < w.cum.length - 1 && w.cum[i] < d) i++;
  const a = w.p[i - 1], b = w.p[i]; const seg = w.cum[i] - w.cum[i - 1] || 1; const t = clamp((d - w.cum[i - 1]) / seg, 0, 1);
  const sx = (b[0] - a[0]) / seg * dir, sz = (b[1] - a[1]) / seg * dir;
  out.x = a[0] + (b[0] - a[0]) * t + (-sz) * lat; out.z = a[1] + (b[1] - a[1]) * t + sx * lat; out.hdg = Math.atan2(sz, sx);
}

// ---------------------------------------------------------------------------
// Car geometry (instanced) with lit head/tail lamps
// ---------------------------------------------------------------------------
function carGeometry() {
  const parts = [];
  const add = (g, part, col) => {
    const n = g.attributes.position.count;
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(new Array(n).fill(part), 1)); // 0 body 1 glass 2 wheel 3 head 4 tail
    parts.push(g);
  };
  const body = new THREE.BoxGeometry(4.2, 0.72, 1.78); body.translate(0, 0.62, 0); add(body, 0);
  const cab = new THREE.BoxGeometry(2.25, 0.62, 1.62); cab.translate(-0.25, 1.28, 0);
  // taper the cabin roof
  const cp = cab.attributes.position; for (let i = 0; i < cp.count; i++) { if (cp.getY(i) > 1.4) { cp.setX(i, cp.getX(i) * 0.8 - 0.05); cp.setZ(i, cp.getZ(i) * 0.9); } }
  cab.computeVertexNormals(); add(cab, 1);
  for (const [x, z] of [[1.3, 0.85], [1.3, -0.85], [-1.3, 0.85], [-1.3, -0.85]]) { const w = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 10); w.rotateX(Math.PI / 2); w.translate(x, 0.34, z); add(w, 2); }
  for (const z of [-0.62, 0.62]) { const h = new THREE.BoxGeometry(0.06, 0.16, 0.36); h.translate(2.1, 0.72, z); add(h, 3); const t = new THREE.BoxGeometry(0.06, 0.15, 0.4); t.translate(-2.1, 0.78, z); add(t, 4); }
  const pos = [], nor = [], part = [], idx = []; let off = 0;
  for (const g of parts) {
    const p = g.attributes.position, n = g.attributes.normal, a = g.attributes.aPart;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); part.push(a.getX(i)); }
    for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off); off += p.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  m.setIndex(idx); return m;
}

export const trafficUniforms = { uLitT: { value: 0 } };

function carMaterial() {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.28, metalness: 0.15 });
  mat.onBeforeCompile = (sh) => {
    applyFog(sh); Object.assign(sh.uniforms, trafficUniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aPart; varying float vPart;').replace('#include <begin_vertex>', '#include <begin_vertex>\nvPart = aPart;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vPart; uniform float uLitT;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float pt = vPart;
        if (pt > 0.5 && pt < 1.5) diffuseColor.rgb = vec3(0.02, 0.03, 0.035);
        else if (pt > 1.5 && pt < 2.5) diffuseColor.rgb = vec3(0.01);
        else if (pt > 2.5 && pt < 3.5) diffuseColor.rgb = vec3(0.9);
        else if (pt > 3.5) diffuseColor.rgb = vec3(0.5, 0.02, 0.02);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        if (vPart > 2.5 && vPart < 3.5) totalEmissiveRadiance += vec3(4.0, 3.8, 3.2) * (0.25 + 0.75 * uLitT);
        if (vPart > 3.5) totalEmissiveRadiance += vec3(3.0, 0.1, 0.05) * (0.3 + 0.7 * uLitT);`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = (vPart > 0.5 && vPart < 1.5) ? 0.06 : (vPart > 1.5 && vPart < 2.5) ? 0.9 : roughness;`);
  };
  return mat;
}

const beamVert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position,1.0); }`;
const beamFrag = `varying vec2 vUv; uniform float uLitT; uniform float uAlpha; void main(){
  float x = vUv.x, y = (vUv.y - 0.5) * 2.0;
  float cone = smoothstep(1.0, 0.0, abs(y) / (0.25 + 0.75 * x)) * smoothstep(1.0, 0.0, x) * smoothstep(0.0, 0.04, x);
  gl_FragColor = vec4(vec3(1.0, 0.92, 0.72) * cone * uLitT * uAlpha, 1.0);
}`;

export class Cars {
  constructor(scene, city, N = 240) {
    this.N = N; this.scene = scene; this.rand = mulberry(5150);
    this.net = buildNet(city, new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'trunk_link', 'motorway_link', 'primary_link', 'living_street', 'service']), [-300, -450], 1500);
    const geo = carGeometry();
    this.mesh = new THREE.InstancedMesh(geo, carMaterial(), N);
    this.mesh.frustumCulled = false; this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    const bg = new THREE.PlaneGeometry(1, 1); bg.rotateX(-Math.PI / 2); bg.translate(0.5, 0, 0); bg.scale(24, 1, 5);
    this.beamMat = new THREE.ShaderMaterial({ vertexShader: beamVert, fragmentShader: beamFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, uniforms: { uLitT: trafficUniforms.uLitT, uAlpha: { value: 0.16 } } });
    this.beams = new THREE.InstancedMesh(bg, this.beamMat, N); this.beams.frustumCulled = false; this.beams.renderOrder = 4; this.beams.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.beams);
    // weights favour big streets
    const wts = this.net.ways.map((w) => w.len * ({ motorway: 1.4, trunk: 1.4, primary: 1.3, secondary: 1.2, tertiary: 1.0, unclassified: 0.8, residential: 0.7, service: 0.25, living_street: 0.3 }[w.t] || 0.4));
    let s = 0; const cw = wts.map((w) => (s += w));
    const pick = () => { const x = this.rand() * s; let lo = 0, hi = cw.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cw[m] < x) lo = m + 1; else hi = m; } return lo; };
    const cols = [0xe8e8e8, 0x1a1a1c, 0x9aa0a6, 0x2b3a55, 0x7b1c1c, 0xd8d8d0, 0x37474f, 0x0e0e0e, 0xb8b8b8, 0x2f5d3a, 0xc9b56a];
    this.st = []; const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      const wi = pick(), w = this.net.ways[wi];
      this.st.push({ way: wi, d: this.rand() * w.len, dir: w.ow ? 1 : (this.rand() < 0.5 ? 1 : -1), v: 6 + this.rand() * 7, vt: 6 + this.rand() * 7, x: 0, z: 0, hdg: 0, y: 0, pitch: 0 });
      c.setHex(cols[(this.rand() * cols.length) | 0]).convertSRGBToLinear(); this.mesh.setColorAt(i, c);
    }
    this.mesh.instanceColor.needsUpdate = true;
    this.acc = 0;
  }
  update(dt) {
    this.acc = Math.min(this.acc + dt, 0.1);
    while (this.acc >= 1 / 60) { this.acc -= 1 / 60; this.integrate(1 / 60); }
    const M = this._M || (this._M = new THREE.Matrix4()), q = this._q || (this._q = new THREE.Quaternion()), e = this._e || (this._e = new THREE.Euler()), v = this._v || (this._v = new THREE.Vector3()), s = this._s || (this._s = new THREE.Vector3(1, 1, 1));
    const out = this._o || (this._o = { x: 0, z: 0, hdg: 0 });
    trafficUniforms.uLitT.value = clamp((1 - smoothstep(0.03, 0.4, G.dayLevel)) + G.rain * 0.4, 0, 1);
    for (let i = 0; i < this.N; i++) {
      const p = this.st[i], w = this.net.ways[p.way];
      pointOn(w, p.d, p.dir, w.lane, out);
      const y = heightAt(out.x, out.z);
      const fx = Math.cos(out.hdg), fz = Math.sin(out.hdg);
      const y2 = heightAt(out.x + fx * 2, out.z + fz * 2), y1 = heightAt(out.x - fx * 2, out.z - fz * 2);
      e.set(0, -out.hdg, Math.atan2(y2 - y1, 4)); q.setFromEuler(e); e.order = 'YXZ';
      v.set(out.x, y + 0.02, out.z);
      M.compose(v, q, s); this.mesh.setMatrixAt(i, M); this.beams.setMatrixAt(i, M.clone().setPosition(v.x + fx * 2.1, y + 0.07, v.z + fz * 2.1));
    }
    this.mesh.instanceMatrix.needsUpdate = true; this.beams.instanceMatrix.needsUpdate = true;
    this.beams.visible = trafficUniforms.uLitT.value > 0.03;
  }
  integrate(dt) {
    const wsp = G.rain;
    for (const p of this.st) {
      const w = this.net.ways[p.way];
      p.v += (p.vt * (1 - 0.18 * wsp) - p.v) * Math.min(1, dt * 0.8);
      p.d += p.dir * p.v * dt;
      if (p.d > w.len || p.d < 0) {
        const endIdx = p.d > w.len ? 1 : 0; const q = endIdx ? w.p[w.p.length - 1] : w.p[0];
        const list = (this.net.adj.get(this.net.key(q)) || []).filter(([wi, e]) => wi !== p.way && (!this.net.ways[wi].ow || this.net.ways[wi].ow && (e === 0 ? true : false) || true));
        // legal continuation: enter a way at its start if one-way
        const ok = list.filter(([wi, e]) => !this.net.ways[wi].ow || e === 0);
        if (ok.length) { const [wi, e] = ok[(this.rand() * ok.length) | 0]; p.way = wi; const w2 = this.net.ways[wi]; p.d = e ? w2.len - 0.01 : 0.01; p.dir = e ? -1 : 1; if (w2.ow) p.dir = 1; }
        else { p.dir = w.ow ? 1 : -p.dir; p.d = p.dir > 0 ? 0.01 : w.len - 0.01; if (w.ow) { p.d = 0.01; } }
        p.vt = 6 + this.rand() * 7;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Light rail (Bybanen) — trams shuttling along the real OSM tracks
// ---------------------------------------------------------------------------
export class Trams {
  constructor(scene, city, cityMat) {
    this.scene = scene; this.trams = [];
    // chain rail ways by endpoints into long routes
    const key = (q) => Math.round(q[0]) + ',' + Math.round(q[1]);
    const rails = city.rails.map((r) => r.p.slice()).filter((p) => p.length > 1);
    const used = new Set(); const routes = [];
    const ends = new Map(); rails.forEach((p, i) => { for (const e of [0, 1]) { const k = key(e ? p[p.length - 1] : p[0]); if (!ends.has(k)) ends.set(k, []); ends.get(k).push([i, e]); } });
    for (let i = 0; i < rails.length; i++) {
      if (used.has(i)) continue; used.add(i);
      let route = rails[i].slice();
      for (let grow = 0; grow < 60; grow++) {
        const k = key(route[route.length - 1]); const cand = (ends.get(k) || []).find(([j]) => !used.has(j));
        if (!cand) break; used.add(cand[0]); const p = rails[cand[0]]; route = route.concat((cand[1] ? p.slice().reverse() : p).slice(1));
      }
      for (let grow = 0; grow < 60; grow++) {
        const k = key(route[0]); const cand = (ends.get(k) || []).find(([j]) => !used.has(j));
        if (!cand) break; used.add(cand[0]); const p = rails[cand[0]]; route = (cand[1] ? p : p.slice().reverse()).slice(0, -1).concat(route);
      }
      routes.push(route);
    }
    const len = (r) => { let l = 0; for (let i = 1; i < r.length; i++) l += Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1]); return l; };
    routes.sort((a, b) => len(b) - len(a));
    this.routes = routes.slice(0, 3).filter((r) => len(r) > 200).map((r) => { const cum = [0]; for (let i = 1; i < r.length; i++) cum.push(cum[i - 1] + Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1])); return { p: r, cum, len: cum[cum.length - 1] }; });
    const mk = () => {
      const sb = new SoupBuilder();
      const body = { col: hexLin(0xdfe3e6), info: [Math.round(3.2 / 8 * 255), Math.round(1.8 / 8 * 255), 250, 130], info2: [STYLE.WINDOWS, 230, 3, 0] };
      const stripe = { col: hexLin(0x1b3f6b), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
      const roof = { col: hexLin(0x8c9296), info: [128, 128, 0, 0], info2: [STYLE.ROOF, 0, 0, 0] };
      const L = 42, W = 2.65;
      const ring = [[-L / 2, -W / 2 + 0.3], [-L / 2 + 1.2, -W / 2], [L / 2 - 1.2, -W / 2], [L / 2, -W / 2 + 0.3], [L / 2, W / 2 - 0.3], [L / 2 - 1.2, W / 2], [-L / 2 + 1.2, W / 2], [-L / 2, W / 2 - 0.3]];
      sb.prism(ring, 0.5, 3.3, body, true, roof, 0.5);
      sb.prism(ring.map(([x, z]) => [x, z * 1.005]), 0.5, 1.0, stripe, false);
      const g = sb.build(); const m = new THREE.Mesh(g, cityMat); m.castShadow = true; m.receiveShadow = true; return m;
    };
    this.routes.forEach((r, i) => { for (let k = 0; k < (i === 0 ? 2 : 1); k++) { const m = mk(); scene.add(m); this.trams.push({ m, route: r, d: r.len * (0.15 + 0.5 * k + 0.1 * i), dir: k ? -1 : 1, v: 0, stop: 0 }); } });
  }
  update(dt) {
    for (const t of this.trams) {
      const r = t.route;
      const target = t.stop > 0 ? 0 : 9;
      t.v += (target - t.v) * Math.min(1, dt * 0.6);
      if (t.stop > 0) t.stop -= dt;
      t.d += t.dir * t.v * dt;
      if (t.d > r.len - 10 || t.d < 10) { t.dir *= -1; t.d = clamp(t.d, 10, r.len - 10); t.stop = 12; }
      const o = { x: 0, z: 0, hdg: 0 }; pointOn({ p: r.p, cum: r.cum }, t.d, 1, 0, o);
      const o2 = { x: 0, z: 0, hdg: 0 }; pointOn({ p: r.p, cum: r.cum }, clamp(t.d + 10, 0, r.len), 1, 0, o2);
      const o1 = { x: 0, z: 0, hdg: 0 }; pointOn({ p: r.p, cum: r.cum }, clamp(t.d - 10, 0, r.len), 1, 0, o1);
      const hdg = Math.atan2(o2.z - o1.z, o2.x - o1.x) + (t.dir < 0 ? 0 : 0);
      const y = heightAt(o.x, o.z);
      t.m.position.set(o.x, y + 0.1, o.z); t.m.rotation.set(0, -hdg, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Street lamps: poles + glow halos + light pools (night, dusk, dark storm)
// ---------------------------------------------------------------------------
const glowVert = `
attribute vec3 aPos; uniform float uLitL; uniform vec3 uCamL; varying vec2 vUv; varying float vA;
void main(){
  vUv = uv * 2.0 - 1.0;
  vec3 c = aPos; float d = distance(c, cameraPosition);
  float size = 1.5 + d * 0.0045;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 wp = c + (right * position.x + up * position.y) * size;
  vA = uLitL * (1.0 - smoothstep(350.0, 900.0, d)) * smoothstep(3.0, 12.0, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const glowFrag = `varying vec2 vUv; varying float vA; void main(){ float r = length(vUv); float w = smoothstep(1.0, 0.55, r); float g = (exp(-r * r * 7.0) * 0.9 + exp(-r * 3.0) * 0.10) * w; gl_FragColor = vec4(vec3(1.0, 0.8, 0.5) * g * vA * 1.3, 1.0); }`;
const poolVert = `attribute vec3 aPos; uniform float uLitL; varying vec2 vUv; varying float vA;
void main(){ vUv = uv * 2.0 - 1.0; float d = distance(aPos, cameraPosition); vA = uLitL * (1.0 - smoothstep(250.0, 600.0, d)); vec3 wp = aPos + vec3(position.x * 9.0, 0.06, position.z * 9.0); gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0); }`;
const poolFrag = `varying vec2 vUv; varying float vA; void main(){ float r = length(vUv); float g = pow(max(1.0 - r, 0.0), 2.2); gl_FragColor = vec4(vec3(1.0, 0.78, 0.5) * g * vA * 0.42, 1.0); }`;

export class Lamps {
  constructor(scene, city, occ) {
    const R = mulberry(88);
    const pts = [];
    const cls = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'pedestrian', 'trunk']);
    for (const r of city.roads) {
      if (!cls.has(r.t) || r.tn) continue;
      const off = r.t === 'pedestrian' ? 0 : (r.t === 'primary' || r.t === 'secondary' || r.t === 'trunk') ? 6.4 : 4.8;
      let carry = R() * 12;
      for (let i = 1; i < r.p.length; i++) {
        const a = r.p[i - 1], b = r.p[i]; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); if (len < 1) continue;
        const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
        for (let s = carry; s < len; s += 32) {
          const side = (pts.length & 1) ? 1 : -1;
          const x = a[0] + dx * s - dz * off * side, z = a[1] + dz * s + dx * off * side;
          if (Math.hypot(x + 250, z + 500) > 1250) continue;
          if (occ && occ(x, z) === 1) continue;
          pts.push([x, z]);
        }
        carry = ((carry + Math.ceil((len - carry) / 32) * 32) - len);
        if (carry < 0) carry = 0;
      }
    }
    this.count = pts.length;
    const n = pts.length;
    // poles
    const pole = new THREE.CylinderGeometry(0.07, 0.11, 7.4, 6); pole.translate(0, 3.7, 0);
    const arm = new THREE.BoxGeometry(1.4, 0.08, 0.08); arm.translate(0.7, 7.3, 0);
    const head = new THREE.BoxGeometry(0.7, 0.12, 0.3); head.translate(1.35, 7.25, 0);
    const merged = (() => { const list = [pole, arm, head]; const pos = [], nor = [], idx = []; let off = 0; for (const g of list) { const p = g.attributes.position, nn = g.attributes.normal; for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(nn.getX(i), nn.getY(i), nn.getZ(i)); } for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off); off += p.count; } const m = new THREE.BufferGeometry(); m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setIndex(idx); return m; })();
    const pm = new THREE.InstancedMesh(merged, new THREE.MeshStandardMaterial({ color: 0x3b3f42, roughness: 0.5, metalness: 0.6 }), n);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s1 = new THREE.Vector3(1, 1, 1);
    const glowPos = new Float32Array(n * 3), poolPos = new Float32Array(n * 3);
    pts.forEach(([x, z], i) => {
      const y = heightAt(x, z);
      // arm points toward the road (roughly toward the nearest road centre = back toward origin of offset): random yaw for variety
      const yaw = Math.atan2(-(x + 250), -(z + 500)) * 0 + R() * Math.PI * 2;
      e.set(0, yaw, 0); q.setFromEuler(e); v.set(x, y, z); M.compose(v, q, s1); pm.setMatrixAt(i, M);
      const hx = x + Math.cos(yaw) * 1.35, hz = z - Math.sin(yaw) * 1.35;
      glowPos.set([hx, y + 7.15, hz], i * 3); poolPos.set([hx, heightAt(hx, hz), hz], i * 3);
    });
    pm.frustumCulled = false; pm.castShadow = false; scene.add(pm);
    const quad = new THREE.PlaneGeometry(2, 2);
    const gg = new THREE.InstancedBufferGeometry(); gg.index = quad.index; gg.setAttribute('position', quad.attributes.position); gg.setAttribute('uv', quad.attributes.uv); gg.instanceCount = n;
    gg.setAttribute('aPos', new THREE.InstancedBufferAttribute(glowPos, 3));
    this.uLit = { value: 0 };
    const gm = new THREE.ShaderMaterial({ vertexShader: glowVert, fragmentShader: glowFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, uniforms: { uLitL: this.uLit, uCamL: { value: new THREE.Vector3() } } });
    this.glow = new THREE.Mesh(gg, gm); this.glow.frustumCulled = false; this.glow.renderOrder = 6; scene.add(this.glow);
    const pq = new THREE.PlaneGeometry(2, 2); pq.rotateX(-Math.PI / 2);
    const pg = new THREE.InstancedBufferGeometry(); pg.index = pq.index; pg.setAttribute('position', pq.attributes.position); pg.setAttribute('uv', pq.attributes.uv); pg.instanceCount = n;
    pg.setAttribute('aPos', new THREE.InstancedBufferAttribute(poolPos, 3));
    const pmm = new THREE.ShaderMaterial({ vertexShader: poolVert, fragmentShader: poolFrag, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, uniforms: { uLitL: this.uLit } });
    this.pool = new THREE.Mesh(pg, pmm); this.pool.frustumCulled = false; this.pool.renderOrder = 5; scene.add(this.pool);
  }
  update() {
    const lit = clamp(1 - smoothstep(0.05, 0.42, G.dayLevel), 0, 1);
    this.uLit.value = lit; this.glow.visible = this.pool.visible = lit > 0.02;
  }
}
