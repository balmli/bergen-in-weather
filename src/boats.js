import * as THREE from 'three';
import { G, clamp, lerp, mulberry, smoothstep, windSpeed, gustAt, applyFog } from './common.js';
import { seaHeight, seaSlope, fetchFactor } from './water.js';
import { SoupBuilder, STYLE, hexLin } from './builder.js';

// ---------------------------------------------------------------- materials
const hullMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.0 });
const rigMat = new THREE.MeshStandardMaterial({ color: 0xb9bcc0, roughness: 0.35, metalness: 0.8 });
hullMat.onBeforeCompile = applyFog; rigMat.onBeforeCompile = applyFog;
const lineMat = new THREE.LineBasicMaterial({ color: 0x1b1c1e, transparent: true, opacity: 0.85 });

const sailUniformsTemplate = () => ({
  uLuff: { value: 0 }, uCamber: { value: 0.5 }, uSide: { value: 1 }, uSailTime: { value: 0 }, uPhase: { value: 0 },
  uH: { value: 10 }, uB: { value: 3 }, uJib: { value: 0 }, uFore: { value: 4 }, uTwist: { value: 0.3 },
});
function makeSailMaterial(color) {
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    applyFog(sh); mat.userData.sh = sh;
    Object.assign(sh.uniforms, mat.userData.u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uLuff, uCamber, uSide, uSailTime, uPhase, uH, uB, uJib, uFore, uTwist;
        varying float vLeech;
        vec3 sailP(vec2 uv){
          float u = uv.x, v = uv.y;
          // triangle: u along foot (aft), v up; leech shortens toward head, with roach
          float leech = (1.0 - v) + 0.12 * sin(3.14159 * v) * (1.0 - uJib) + 0.05 * sin(3.14159 * v) * uJib;
          float x = u * leech * uB;
          float y = v * uH;
          // jib luff follows the forestay (leans forward toward the mast head)
          x += uJib * v * uFore;
          float z = 0.0;
          // camber: belly to leeward, deeper in the middle, flatter near head
          float cam = uCamber * sin(3.14159 * u) * (1.0 - 0.6 * v) * (0.10 * uB);
          z += cam * uSide;
          // twist: head sheeted farther out than foot
          z += uTwist * v * v * uB * 0.12 * uSide * u;
          // luffing: leech and upper sail flog in waves that travel aft
          float fl = uLuff * u * u * (0.25 + 0.75 * v);
          float w = sin(uSailTime * 11.0 + u * 9.0 + v * 6.0 + uPhase) + 0.6 * sin(uSailTime * 17.3 + u * 15.0 - v * 4.0 + uPhase * 2.0);
          z += fl * w * 0.28 * uB * 0.5;
          x += fl * w * 0.02;
          return vec3(x, y, z);
        }
      `)
      .replace('#include <beginnormal_vertex>', `
        vec3 objectNormal;
        {
          float e = 0.02;
          vec3 p0 = sailP(uv), pu = sailP(uv + vec2(e, 0.0)), pv = sailP(uv + vec2(0.0, e));
          objectNormal = normalize(cross(pu - p0, pv - p0));
          if (uSide < 0.0) objectNormal = -objectNormal;
        }
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif
      `)
      .replace('#include <begin_vertex>', `
        vec3 transformed = sailP(uv);
        vLeech = uv.x;
      `);
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLeech;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        diffuseColor.rgb *= 0.9 + 0.1 * sin(vLeech * 40.0);`);
  };
  return mat;
}
function sailGeometry(nu = 14, nv = 18) {
  const g = new THREE.BufferGeometry();
  const pos = [], uvs = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) { pos.push(0, 0, 0); uvs.push(i / nu, j / nv); }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 2 ? 1 : 0)), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(2, 5, 0), 12);
  return g;
}
const SAIL_GEO = sailGeometry();

// ---------------------------------------------------------------- hull geometry (sailboat)
function hullGeometry(L, B, fb, draft, hullCol, stripeCol, deckCol, cabinCol) {
  const N = 16, M = 7; // stations, section points (per half)
  const pos = [], col = [], idx = [];
  const hull = new THREE.Color(hullCol), stripe = new THREE.Color(stripeCol), bottom = new THREE.Color(0x3a1a17), deck = new THREE.Color(deckCol);
  const beamAt = (t) => { // t 0 stern .. 1 bow
    const s = t < 0.32 ? lerp(0.66, 1.0, Math.pow(t / 0.32, 0.7)) : Math.pow(Math.max(1 - Math.pow((t - 0.32) / 0.68, 1.55), 0), 0.82);
    return 0.5 * B * s;
  };
  const sheer = (t) => fb * (1 + 0.42 * Math.pow(t, 2.6) + 0.1 * Math.pow(1 - t, 3));
  const depthAt = (t) => draft * (0.25 + 0.75 * Math.sin(Math.min(t * 1.15, 1) * Math.PI * 0.5)) * (1 - 0.5 * Math.pow(t, 6));
  const ring = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, x = (t - 0.5) * L + 0.0;
    const w = beamAt(t), fbt = sheer(t), d = depthAt(t) * 0.42;
    const pts = [ // half section, starboard (+z) from deck edge down to keel
      [w * 0.98, fbt, 0], [w, fbt * 0.6, 0], [w * 0.92, 0.02, 1], [w * 0.74, -d * 0.42, 1], [w * 0.5, -d * 0.75, 1], [w * 0.22, -d * 0.95, 1], [0, -d, 1],
    ];
    ring.push({ x, pts });
  }
  const pushV = (x, y, z, c) => { pos.push(x, y, z); col.push(c.r, c.g, c.b); return pos.length / 3 - 1; };
  // build both sides
  const sec = [];
  for (const r of ring) {
    const row = [];
    for (let k = 0; k < M; k++) { const p = r.pts[k]; const c = p[2] === 0 ? hull.clone() : (p[1] > -0.02 ? stripe.clone() : bottom.clone()); if (k === 0) c.lerp(deck, 0.0); row.push(pushV(r.x, p[1], p[0], k === 1 ? hull : c)); }
    for (let k = M - 2; k >= 0; k--) { const p = r.pts[k]; const c = p[2] === 0 ? hull.clone() : (p[1] > -0.02 ? stripe.clone() : bottom.clone()); row.push(pushV(r.x, p[1], -p[0], k === 1 ? hull : c)); }
    sec.push(row);
  }
  const W = sec[0].length;
  for (let i = 0; i < N; i++) for (let k = 0; k < W - 1; k++) {
    const a = sec[i][k], b = sec[i][k + 1], c = sec[i + 1][k], d = sec[i + 1][k + 1];
    idx.push(a, c, b, b, c, d);
  }
  // deck: strip across top between the two deck-edge vertices per station
  const deckIdx0 = pos.length / 3;
  for (let i = 0; i <= N; i++) { const r = ring[i]; pushV(r.x, r.pts[0][1] + 0.02, r.pts[0][0], deck); pushV(r.x, r.pts[0][1] + 0.02 + 0.06, 0, deck); pushV(r.x, r.pts[0][1] + 0.02, -r.pts[0][0], deck); }
  for (let i = 0; i < N; i++) {
    const a = deckIdx0 + i * 3, b = a + 1, c = a + 2, a2 = a + 3, b2 = a2 + 1, c2 = a2 + 2;
    idx.push(a, a2, b, b, a2, b2, b, b2, c, c, b2, c2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function boxGeo(w, h, d, color, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z);
  const n = g.attributes.position.count; const c = new THREE.Color(color);
  g.setAttribute('color', new THREE.Float32BufferAttribute(Array.from({ length: n * 3 }, (_, i) => [c.r, c.g, c.b][i % 3]), 3));
  return g;
}
function mergeGeos(list) {
  let total = 0; for (const g of list) total += g.index ? g.index.count : g.attributes.position.count;
  const pos = [], nor = [], col = [], idx = []; let off = 0;
  for (const g of list) {
    const p = g.attributes.position, n = g.attributes.normal, c = g.attributes.color;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(c.getX(i), c.getY(i), c.getZ(i)); }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(g.index.getX(i) + off); else for (let i = 0; i < p.count; i++) idx.push(i + off);
    off += p.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); m.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); m.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  m.setIndex(idx); return m;
}

// ---------------------------------------------------------------- wake / foam decal that follows the waves
const wakeVert = /* glsl */`
uniform vec2 uWDir[6]; uniform float uWK[6]; uniform float uWA[6]; uniform float uWPh[6]; uniform float uWScale; uniform float uAmp;
varying vec2 vUv; varying float vY;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float y = 0.0;
  for (int i = 0; i < 6; i++) { y += uWA[i] * uWScale * uAmp * cos(uWK[i] * dot(uWDir[i], wp.xz) - uWPh[i]); }
  wp.y = y + 0.14;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const wakeFrag = /* glsl */`
uniform float uTime; uniform float uSpeed; uniform float uLen; uniform vec3 uCol; uniform float uWind;
varying vec2 vUv;
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float n2(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f); return mix(mix(h21(i), h21(i+vec2(1,0)), f.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y); }
void main(){
  // uv.x: 0 at the stern -> 1 far astern ; uv.y: -1..1 across
  float x = vUv.x, y = vUv.y;
  float ay = abs(y);
  float arm = exp(-pow((ay - 0.10 - 0.62 * x) / (0.035 + 0.05 * x), 2.0));
  float trail = exp(-pow(y / (0.07 + 0.11 * x), 2.0));
  float fade = pow(max(1.0 - x, 0.0), 1.4);
  float breakup = n2(vec2(x * 30.0 - uTime * 1.2, y * 14.0)) * 0.55 + n2(vec2(x * 90.0, y * 42.0 + uTime)) * 0.45;
  float a = (arm * 0.35 + trail * 0.55) * fade * smoothstep(0.42, 0.7, breakup + 0.15 * (1.0 - x));
  a *= smoothstep(0.0, 0.02, x) * clamp(uSpeed * 0.3, 0.0, 1.0);
  gl_FragColor = vec4(uCol * (0.6 + 0.4 * breakup), a * 0.55);
}`;

// ---------------------------------------------------------------- boat
class Sailboat {
  constructor(o, wakeUniformsBase) {
    this.o = o; this.rand = mulberry(o.seed);
    this.root = new THREE.Group(); this.body = new THREE.Group(); this.root.add(this.body);
    const L = o.L, B = o.B;
    const g = hullGeometry(L, B, 0.95, 1.3, o.hull, o.stripe, 0xb9a98a, 0xf0f0f0);
    // cabin trunk + cockpit coaming + windows
    const parts = [g];
    const cab = new THREE.Color(0xe9e9e6);
    parts.push(boxGeo(L * 0.34, 0.5, B * 0.62, o.cabin, L * 0.02, 1.15, 0));
    parts.push(boxGeo(L * 0.30, 0.16, B * 0.64, 0x1a2126, L * 0.02, 1.22, 0));
    parts.push(boxGeo(L * 0.16, 0.5, 0.12, 0xd8d8d4, -L * 0.30, 1.1, B * 0.3));
    parts.push(boxGeo(L * 0.16, 0.5, 0.12, 0xd8d8d4, -L * 0.30, 1.1, -B * 0.3));
    // keel + rudder
    parts.push(boxGeo(L * 0.26, 1.3, 0.09, 0x2b2c2f, L * 0.02, -0.75, 0));
    parts.push(boxGeo(0.4, 0.9, 0.06, 0x2b2c2f, -L * 0.5 + 0.35, -0.4, 0));
    parts.push(boxGeo(0.5, 0.28, 0.4, 0x2b2c2f, -L * 0.5 + 0.2, 0.55, 0));
    const merged = mergeGeos(parts.map((p) => { if (!p.attributes.normal) p.computeVertexNormals(); return p; }));
    this.hull = new THREE.Mesh(merged, hullMat); this.hull.castShadow = true; this.hull.receiveShadow = true;
    this.body.add(this.hull);
    // rig
    this.mastX = L * 0.12; const H = o.rigH;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.075, H, 8), rigMat);
    mast.position.set(this.mastX, H / 2 + 1.05, 0); mast.castShadow = true; this.body.add(mast);
    this.boomLen = o.boom;
    this.boom = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, o.boom, 6), rigMat);
    this.boom.geometry.rotateZ(Math.PI / 2); this.boom.geometry.translate(-o.boom / 2, 0, 0); this.boom.castShadow = true;
    this.boomPivot = new THREE.Group(); this.boomPivot.position.set(this.mastX, 1.85, 0); this.boomPivot.add(this.boom); this.body.add(this.boomPivot);
    // stays
    const pts = [
      this.mastX, H + 1.05, 0, L * 0.5 - 0.1, 1.15, 0,
      this.mastX, H + 1.05, 0, -L * 0.5 + 0.1, 1.05, 0,
      this.mastX, H * 0.62 + 1.05, 0, this.mastX - 0.3, 1.0, B * 0.48,
      this.mastX, H * 0.62 + 1.05, 0, this.mastX - 0.3, 1.0, -B * 0.48,
    ];
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.body.add(new THREE.LineSegments(lg, lineMat));
    // sails
    const sc = o.sail;
    this.mainMat = makeSailMaterial(sc); this.mainMat.userData.u = sailUniformsTemplate();
    this.jibMat = makeSailMaterial(o.jibColor || sc); this.jibMat.userData.u = sailUniformsTemplate();
    this.main = new THREE.Mesh(SAIL_GEO, this.mainMat); this.main.castShadow = true; this.main.frustumCulled = false;
    this.jib = new THREE.Mesh(SAIL_GEO, this.jibMat); this.jib.castShadow = true; this.jib.frustumCulled = false;
    // main hangs from the boom pivot; local +x = aft -> rotate PI about Y
    this.mainPivot = new THREE.Group(); this.mainPivot.position.set(this.mastX, 1.9, 0); this.mainPivot.rotation.y = Math.PI; this.mainPivot.add(this.main);
    this.body.add(this.mainPivot);
    this.jibPivot = new THREE.Group(); this.jibPivot.position.set(L * 0.5 - 0.2, 1.15, 0); this.jibPivot.rotation.y = Math.PI; this.jibPivot.add(this.jib);
    this.body.add(this.jibPivot);
    this.setReef(o.reef || 0);
    // wake decal
    const wg = new THREE.PlaneGeometry(1, 1, 24, 24); wg.rotateX(-Math.PI / 2); wg.translate(0.5, 0, 0);
    this.wakeMat = new THREE.ShaderMaterial({
      vertexShader: wakeVert, fragmentShader: wakeFrag, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      uniforms: Object.assign({}, wakeUniformsBase, { uAmp: { value: 1 }, uSpeed: { value: 0 }, uLen: { value: L }, uCol: { value: new THREE.Color(0.75, 0.78, 0.8) }, uTime: { value: 0 }, uWind: { value: 0 } }),
    });
    this.wake = new THREE.Mesh(wg, this.wakeMat); this.wake.renderOrder = 3; this.wake.frustumCulled = false;
    this.wake.scale.set(L * 3.5, 1, B * 2.8); this.wake.position.set(-L * 0.5 + 0.4, 0, 0);
    // v runs 0..1 in plane z -> want -1..1 : handled by remap in uv
    this.wake.geometry.attributes.uv.array.forEach((_, i, a) => { if (i % 2 === 1) a[i] = (a[i] - 0.5) * 2; });
    // wake trails astern (-x)
    this.wake.rotation.y = Math.PI;
    this.wakeHolder = new THREE.Group(); this.wakeHolder.add(this.wake);
    // state
    this.plen = o.path.getLength(); this.s = o.s0 * this.plen; this.speed = 2; this.heel = 0; this.pitch = 0; this.roll = 0; this.heading = 0; this.yPos = 0;
    this.pos = new THREE.Vector3(); this.trim = 0.4; this.luff = 0;
    this.phase = this.rand() * 6.28;
  }
  setReef(r) {
    const H = this.o.rigH, u = this.mainMat.userData.u, uj = this.jibMat.userData.u;
    u.uH.value = (H - 1.0) * (1 - 0.34 * r); u.uB.value = this.boomLen * (1 - 0.1 * r); u.uJib.value = 0; u.uFore.value = 0;
    uj.uH.value = H * 0.86 * (1 - 0.42 * r); uj.uB.value = this.o.L * 0.36 * (1 - 0.3 * r); uj.uJib.value = 1; uj.uFore.value = this.o.L * 0.5 - this.mastX - 0.6;
    if (this.o.noMain) this.main.visible = false;
    if (this.o.noJib) this.jib.visible = false;
  }
  step(dt, t) {
    const o = this.o, path = o.path;
    const PL = this.plen;
    const wrap = (v) => (((v % PL) + PL) % PL) / PL;
    const p0 = path.getPointAt(wrap(this.s));
    const ds = 1.5;
    const p1 = path.getPointAt(wrap(this.s + ds));
    let hx = p1.x - p0.x, hz = p1.z - p0.z; const hl = Math.hypot(hx, hz) + 1e-6; hx /= hl; hz /= hl;
    const targetHead = Math.atan2(hz, hx);
    // smooth heading
    let dh = targetHead - this.heading; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    this.heading += dh * (1 - Math.exp(-dt * 2.5));
    // wind relations (wind vector blows toward windDir)
    const wsp = windSpeed() * gustAt(p0.x, p0.z, t);
    const wx = -G.windDir.x, wz = -G.windDir.y; // direction wind comes FROM
    const hxx = Math.cos(this.heading), hzz = Math.sin(this.heading);
    const cosTwa = clamp(hxx * wx + hzz * wz, -1, 1);
    const twa = Math.acos(cosTwa); // 0 head to wind .. PI running
    const side = Math.sign(hxx * wz - hzz * wx) || 1; // +: wind on port -> heel to starboard... sign for leeward
    // polar-ish speed (m/s): reefed & fighting the wind
    const drive = smoothstep(0.35, 1.2, twa) * (0.55 + 0.45 * Math.sin(Math.min(twa, 2.6)));
    const vt = clamp(0.18 * wsp * drive + 0.5, 0.6, 4.4) * (o.speedMul || 1);
    this.speed += (vt - this.speed) * (1 - Math.exp(-dt * 0.7));
    this.s += this.speed * dt;
    // heel: proportional to wind pressure on the sails across the beam
    const force = wsp * wsp * Math.pow(Math.sin(clamp(twa, 0, 2.2)), 1.3) * (1 - 0.55 * (o.reef || 0));
    const heelT = clamp(force * 0.115, 0, 38) * side;
    this.heel += (heelT - this.heel) * (1 - Math.exp(-dt * 2.2));
    // sail trim & luffing (head to wind or eased in gusts -> flog)
    const trim = clamp(twa * 0.5, 0.12, 1.4);
    this.trim += (trim - this.trim) * (1 - Math.exp(-dt * 1.5));
    const luffT = clamp(smoothstep(0.85, 0.35, twa) + (o.flog || 0) * (0.5 + 0.5 * Math.sin(t * 0.7 + this.phase)) + smoothstep(1.35, 1.5, gustAt(p0.x, p0.z, t)) * 0.0, 0, 1);
    this.luff += (luffT - this.luff) * (1 - Math.exp(-dt * 3));
    // sea state under the hull (5 sample points)
    const L = o.L, B = o.B;
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    const sample = (lx, lz) => seaHeight(p0.x + c * lx - s * lz, p0.z + s * lx + c * lz, t);
    const hb = sample(L * 0.42, 0), hs = sample(-L * 0.42, 0), hp = sample(0, -B * 0.5), hst = sample(0, B * 0.5), hc = sample(0, 0);
    const y = (hb + hs + hc + hp + hst) / 5;
    this.yPos += (y - this.yPos) * (1 - Math.exp(-dt * 12));
    this.pitch += (Math.atan2(hb - hs, L * 0.84) - this.pitch) * (1 - Math.exp(-dt * 8));
    this.roll += (-Math.atan2(hst - hp, B) - this.roll) * (1 - Math.exp(-dt * 8));
    this.pos.set(p0.x, this.yPos, p0.z);
    this.root.position.copy(this.pos);
    // local frame: +x bow, +y up, +z starboard.  rotation.y = -heading maps +x onto the heading direction.
    this.root.rotation.set(0, -this.heading, 0);
    // leeward side: +1 when wind arrives from port (boat leans to starboard, +z)
    const lee = -side;
    this.body.rotation.set(lee * Math.abs(this.heel) * Math.PI / 180 + this.roll * 0.8, 0, this.pitch, 'XYZ');
    // boom swings aft-end to leeward; sail meshes are built with +x = aft, so they carry a PI yaw
    const swing = lee * this.trim;
    this.boomPivot.rotation.y = swing;
    this.mainPivot.rotation.y = Math.PI + swing;
    this.jibPivot.rotation.y = Math.PI + swing * 0.85;
    // cloth uniforms
    const uu = [this.mainMat.userData.u, this.jibMat.userData.u];
    for (const u of uu) {
      u.uLuff.value = this.luff; u.uSide.value = -lee * (this.luff > 0.6 ? (Math.sin(t * 3.1 + this.phase) > 0 ? 1 : -1) : 1);
      u.uSailTime.value = t % 300; u.uPhase.value = this.phase; u.uCamber.value = lerp(0.7, 0.25, clamp(wsp / 18, 0, 1)) * (1 - this.luff * 0.6);
    }
    // wake
    this.wakeHolder.position.set(this.pos.x, 0, this.pos.z); this.wakeHolder.rotation.y = -this.heading;
    this.wakeMat.uniforms.uSpeed.value = this.speed; this.wakeMat.uniforms.uTime.value = t % 100;
    this.wakeMat.uniforms.uAmp.value = fetchFactor(p0.x, p0.z);
  }
}

// ---------------------------------------------------------------- ships (city material for lit windows)
function loftHull(sb, len, beam, depthAbove, draft, mTop, mBottom, mDeck) {
  const N = 34; const st = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N; const x = (t - 0.5) * len;
    let w = t < 0.22 ? lerp(0.78, 1, Math.pow(t / 0.22, 0.6)) : t < 0.62 ? 1 : Math.pow(Math.max(1 - Math.pow((t - 0.62) / 0.38, 1.7), 0), 0.72);
    w *= beam / 2;
    const rake = t > 0.9 ? (t - 0.9) * 10 : 0;                      // raked stem
    const dk = depthAbove * (1 + 0.16 * Math.pow(t, 3) + 0.05 * Math.pow(1 - t, 3));
    const fl = 1.0 + 0.055 * smoothstep(0.35, 1.0, t);              // bow flare
    const dr = draft * (t < 0.08 ? 0.75 : 1) * (1 - 0.55 * smoothstep(0.85, 1.0, t));
    st.push({ x, pts: [[w * fl, dk + rake * 1.5], [w * 1.0, 0.0], [w * 0.86, -dr * 0.55], [w * 0.5, -dr * 0.9], [0, -dr]] });
  }
  const V = (x, p, s) => [x, p[1], p[0] * s];
  for (let i = 0; i < N; i++) for (const sgn of [1, -1]) for (let k = 0; k < 4; k++) {
    const a = V(st[i].x, st[i].pts[k], sgn), b = V(st[i].x, st[i].pts[k + 1], sgn), c = V(st[i + 1].x, st[i + 1].pts[k + 1], sgn), d = V(st[i + 1].x, st[i + 1].pts[k], sgn);
    const m = k === 0 ? mTop : mBottom;
    // outward orientation check (normal must point away from centreline)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    const nz = ux * vy - uy * vx;                                     // z of (b-a)x(d-a)
    const outward = sgn * nz > 0;
    if (outward) sb.quad(a, b, c, d, m); else sb.quad(a, d, c, b, m);
  }
  // deck cap
  for (let i = 0; i < N; i++) {
    const a = [st[i].x, st[i].pts[0][1], st[i].pts[0][0]], b = [st[i + 1].x, st[i + 1].pts[0][1], st[i + 1].pts[0][0]], c = [st[i + 1].x, st[i + 1].pts[0][1], -st[i + 1].pts[0][0]], d = [st[i].x, st[i].pts[0][1], -st[i].pts[0][0]];
    sb.triUp(a, b, c, mDeck); sb.triUp(a, c, d, mDeck);
  }
}
function buildShip(cityMat, len, beam, decks, hullHex, supHex, opts = {}) {
  const sb = new SoupBuilder();
  const hullM = { col: hexLin(hullHex), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
  const bottomM = { col: hexLin(0x5b1f1c), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
  const deckM = { col: hexLin(0x8c8f8e), info: [128, 128, 0, 0], info2: [STYLE.ROOF, 0, 0, 0] };
  const supM = { col: hexLin(supHex), info: [Math.round(3.0 / 8 * 255), Math.round(2.6 / 8 * 255), 230, 150], info2: [STYLE.WINDOWS, 210, 22, 0] };
  const balM = { col: hexLin(0xb8bcbe), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
  const hw = beam / 2, hl = len / 2, fb = opts.freeboard || 9.0;
  loftHull(sb, len, beam, fb, opts.draft || 7, hullM, bottomM, deckM);
  // stepped superstructure: forward-raked front, full-width lower decks tapering upward
  const tiers = Math.max(decks, 2);
  for (let i = 0; i < tiers; i++) {
    const y0 = fb + i * 3.05, y1 = y0 + 3.05;
    const inset = 1 + i * (opts.taper || 0.5);
    const aft = -hl * (0.9 - 0.035 * i), fore = hl * (0.66 - 0.06 * Math.max(i - 4, 0) - (i > 5 ? 0.06 : 0));
    const w = hw - inset;
    const ring = [[aft, -w * 0.94], [fore * 0.55, -w], [fore, -w * 0.62], [fore + 3, 0], [fore, w * 0.62], [fore * 0.55, w], [aft, w * 0.94]];
    sb.prism(ring, y0, y1, supM, false);
    // promenade rail band and deck cap
    const cap = ring.map(([x, z]) => [x, z * 1.0]);
    sb.prism(cap, y1, y1 + 0.45, balM, true, deckM);
  }
  const ty = fb + tiers * 3.05 + 0.45;
  // bridge block + funnel + mast
  const br = [[hl * 0.28, -hw * 0.5], [hl * 0.5, -hw * 0.5], [hl * 0.56, 0], [hl * 0.5, hw * 0.5], [hl * 0.28, hw * 0.5]];
  sb.prism(br, ty, ty + 3.2, supM, true, deckM);
  const funnelM = { col: hexLin(opts.funnel || 0xc9d3dc), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
  const fun = []; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; fun.push([-hl * 0.28 + Math.cos(a) * 5.2, Math.sin(a) * 4.0]); }
  sb.prism(fun, ty, ty + 9, funnelM, true, funnelM);
  const dark = { col: hexLin(0x222528), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
  const fun2 = []; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; fun2.push([-hl * 0.28 + Math.cos(a) * 5.25, Math.sin(a) * 4.05]); }
  sb.prism(fun2, ty + 8, ty + 9.6, dark, true, dark);
  const mast = []; for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; mast.push([hl * 0.4 + Math.cos(a) * 0.35, Math.sin(a) * 0.35]); }
  sb.prism(mast, ty + 3.2, ty + 16, balM, true, balM);
  // lifeboats along the boat deck (orange)
  const orange = { col: hexLin(0xd7541f), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
  for (let i = 0; i < 8; i++) for (const sgn of [1, -1]) sb.box(-hl * 0.55 + i * 7.5 + (i > 3 ? 12 : 0), sgn * (hw - 1.2), 6.5, 2.2, fb + 3.05 * 2.4, fb + 3.05 * 2.4 + 2.4, 0, orange);
  const g = sb.build();
  const m = new THREE.Mesh(g, cityMat); m.castShadow = true; m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- manager
export class Boats {
  constructor(scene, cityMat, uniforms) {
    this.scene = scene; this.boats = []; this.ships = [];
    const rr = mulberry(77);
    const wakeBase = { uWDir: uniforms.uWDir, uWK: uniforms.uWK, uWA: uniforms.uWA, uWPh: uniforms.uWPh, uWScale: uniforms.uWScale };
    // routes: closed CatmullRom loops in the sheltered Vagen channel and the open water beyond (world metres)
    const loop = (pts) => new THREE.CatmullRomCurve3(pts.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
    const routes = [
      loop([[-690, -1190], [-800, -1330], [-930, -1470], [-1050, -1560], [-1000, -1640], [-880, -1560], [-770, -1440], [-660, -1290], [-640, -1200]]),
      loop([[-760, -1300], [-900, -1440], [-1080, -1600], [-1180, -1700], [-1120, -1760], [-990, -1660], [-850, -1520], [-720, -1360]]),
      loop([[-1150, -1750], [-1350, -1850], [-1500, -1800], [-1450, -1650], [-1300, -1600], [-1200, -1660]]),
      loop([[-1000, -1900], [-1200, -2050], [-1400, -2000], [-1350, -1880], [-1150, -1830]]),
      loop([[-1250, -1250], [-1500, -1300], [-1700, -1200], [-1650, -1050], [-1450, -1100], [-1300, -1180]]),
      loop([[-1550, -900], [-1750, -800], [-1800, -650], [-1650, -620], [-1520, -760]]),
    ];
    this.routes = routes;
    const palette = [
      { hull: 0xf4f4f0, stripe: 0x1c3a63, sail: 0xf1efe6, cabin: 0xe8e8e2, jib: 0xf1efe6 },
      { hull: 0x1d2d4a, stripe: 0xe8e8e2, sail: 0xe9e4d3, cabin: 0xd8d8d0, jib: 0xd9d4c2 },
      { hull: 0xefefe9, stripe: 0x8b1e1e, sail: 0xe4e6ea, cabin: 0xf0f0ea, jib: 0xd7dae0 },
      { hull: 0x2f3a3a, stripe: 0xe6e2d6, sail: 0xcfc8b2, cabin: 0xc9c9c2, jib: 0xc4bda6 },
      { hull: 0xf0efe8, stripe: 0x2b5b3a, sail: 0xf3f1e8, cabin: 0xe8e8e0, jib: 0xf3f1e8 },
      { hull: 0x9b2b25, stripe: 0xeeeeea, sail: 0xf1efe6, cabin: 0xe8e8e2, jib: 0xf1efe6 },
    ];
    const cfg = [
      { r: 0, s0: 0.05, L: 10.8, reef: 0.85, flog: 0.15 },
      { r: 0, s0: 0.55, L: 8.6, reef: 1.0, noMain: false, flog: 0.5, speedMul: 0.9 },
      { r: 1, s0: 0.2, L: 12.4, reef: 0.7, flog: 0.1 },
      { r: 1, s0: 0.7, L: 9.4, reef: 1.0, noMain: true, flog: 0.2 },
      { r: 2, s0: 0.3, L: 11.6, reef: 0.8, flog: 0.25 },
      { r: 3, s0: 0.6, L: 10.2, reef: 1.0, flog: 0.6 },
      { r: 4, s0: 0.1, L: 13.2, reef: 0.6, flog: 0.1 },
      { r: 5, s0: 0.5, L: 9.0, reef: 1.0, flog: 0.4, noMain: true },
    ];
    cfg.forEach((c, i) => {
      const pal = palette[i % palette.length];
      const o = { seed: 100 + i * 17, path: routes[c.r], s0: c.s0, L: c.L, B: c.L * 0.32, rigH: c.L * 1.1, boom: c.L * 0.36, hull: pal.hull, stripe: pal.stripe, sail: pal.sail, cabin: pal.cabin, jibColor: pal.jib, reef: c.reef, flog: c.flog, noMain: c.noMain, noJib: c.noJib, speedMul: c.speedMul };
      const b = new Sailboat(o, wakeBase);
      this.scene.add(b.root); this.scene.add(b.wakeHolder);
      this.boats.push(b);
    });
    // cruise ship berthed on the Bergenhus side of Vagen, coastal ferry & workboat moving
    const ship = buildShip(cityMat, 205, 28, 8, 0x1b2a44, 0xeceeee, { taper: 0.55 });
    ship.position.set(-865, 0, -1395); ship.rotation.y = -Math.atan2(-0.78, -0.62); this.shipBase = ship;
    scene.add(ship); this.ships.push(ship);
    const ferry = buildShip(cityMat, 62, 13, 2, 0x8a1c1c, 0xe9ecec, { freeboard: 3.4, draft: 2.6, taper: 0.9, funnel: 0xd9dcde });
    ferry.position.set(-1100, 0, -1560);
    this.ferryPath = loop([[-790, -1380], [-960, -1550], [-1180, -1690], [-1350, -1760], [-1200, -1810], [-1010, -1700], [-830, -1470]]);
    scene.add(ferry); this.ferry = ferry; this.ferryS = 0.1;
    this.ferryWake = null;
  }
  update(dt, t) {
    for (const b of this.boats) b.step(dt, t);
    // ship rides swell gently
    const p = this.shipBase.position; p.y = seaHeight(p.x, p.z, t) * 0.5;
    // ferry along its loop
    const path = this.ferryPath; this.ferryS = (this.ferryS + dt * 5.2 / path.getLength()) % 1;
    const q = path.getPointAt(this.ferryS), q2 = path.getPointAt((this.ferryS + 0.004) % 1);
    this.ferry.position.set(q.x, seaHeight(q.x, q.z, t) * 0.7, q.z);
    const ang = Math.atan2(q2.z - q.z, q2.x - q.x);
    this.ferry.rotation.set(0, -ang, 0, 'YXZ');

  }
}
