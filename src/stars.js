import * as THREE from 'three';
import { G, GLSL_NOISE, smoothstep, clamp } from './common.js';

const rad = Math.PI / 180;
const eqVec = (raDeg, decDeg) => [Math.cos(decDeg * rad) * Math.cos(raDeg * rad), Math.cos(decDeg * rad) * Math.sin(raDeg * rad), Math.sin(decDeg * rad)];
function bvColor(bv) {
  const c = new THREE.Color(0.62, 0.72, 1.0).lerp(new THREE.Color(1.0, 0.97, 0.92), smoothstep(-0.2, 0.6, bv)).lerp(new THREE.Color(1.0, 0.68, 0.42), smoothstep(0.7, 1.7, bv));
  return c;
}

// Same low/high cloud layers as the sky dome, so stars and planets are veiled exactly where the sky is cloudy.
const cloudChunk = /* glsl */`
${GLSL_NOISE}
uniform vec3 uCamPos; uniform vec2 uWind;
uniform float uCover, uStorm, uTime;
float cloudField(vec2 p, float t){
  vec2 q = p + uWind * t;
  float base = fbm(q * 0.0011);
  float det = vnoise(q * 0.0085 + 3.0) * 0.5 + vnoise(q * 0.021 + 9.0) * 0.25;
  return base * 0.78 + det * 0.22 * (0.4 + uStorm * 0.8);
}
float cloudBlock(vec3 dir){
  float h = dir.y, hh = max(h, 0.012);
  vec2 p1 = uCamPos.xz + dir.xz * (1700.0 / hh);
  float thr = mix(0.62, 0.30, uCover);
  float a1 = smoothstep(thr, thr + mix(0.10, 0.34, uCover), cloudField(p1, uTime));
  vec2 p2 = (uCamPos.xz + dir.xz * (7000.0 / hh)) * vec2(1.0, 2.2);
  float a2 = smoothstep(0.52, 0.85, fbm3(p2 * 0.00035 + uWind * uTime * 0.0006)) * 0.55 * (1.0 - uCover * 0.6);
  return (1.0 - (1.0 - a1) * (1.0 - a2)) * smoothstep(0.0, 0.16, h) * mix(1.0, 0.94, 1.0 - uCover);
}
`;

const pointVert = /* glsl */`
attribute float aMag; attribute vec3 aCol;
uniform mat3 uM; uniform float uUseM, uLimit, uPx, uTime;
varying vec3 vCol, vDir; varying float vI; varying float vGlow;
void main(){
  vec3 dir = normalize(uUseM > 0.5 ? uM * position : position);
  float h = dir.y;
  float vis = clamp((uLimit - aMag) / max(uLimit + 1.8, 0.6), 0.0001, 1.0);   // 0 at the limiting magnitude, 1 at Sirius
  float dark = smoothstep(-2.6, -0.4, uLimit);                          // daylight: no halos, planets shrink to faint pinpricks
  float ext = smoothstep(-0.01, 0.16, h) * mix(0.55, 1.0, smoothstep(0.0, 0.5, h));   // horizon extinction
  float tw = 1.0 + 0.22 * (1.0 - smoothstep(0.0, 0.5, h)) * sin(uTime * 9.0 + dot(dir, vec3(311.0, 517.0, 719.0)));
  float bright = clamp(-aMag * 0.30 + 0.12, 0.0, 1.0);
  vI = (0.35 + 4.0 * vis * sqrt(vis)) * ext * tw * mix(0.25, 1.0, dark) * (aMag > uLimit ? 0.0 : 1.0);
  vGlow = bright * ext * dark;
  vCol = aCol; vDir = dir;
  gl_PointSize = (3.2 + 3.6 * vis + 22.0 * bright * dark) * uPx;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * 20000.0, 1.0);
}`;
const pointFrag = /* glsl */`
precision highp float;
varying vec3 vCol, vDir; varying float vI; varying float vGlow;
${cloudChunk}
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c) * 2.0;
  if (d > 1.0 || vI <= 0.0) discard;
  float veil = 1.0 - cloudBlock(normalize(vDir));   // clouds cover stars exactly where the sky dome is cloudy
  float core = exp(-d * d * 3.2);
  float halo = exp(-d * 3.5) * vGlow;
  gl_FragColor = vec4(vCol * (vI * core + halo * 2.5) * veil, 1.0);
}`;
const lineVert = /* glsl */`
uniform mat3 uM; uniform float uLineA;
varying float vA; varying vec3 vDir;
void main(){
  vec3 dir = normalize(uM * position);
  vA = uLineA * smoothstep(0.0, 0.12, dir.y); vDir = dir;
  gl_Position = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * 20000.0, 1.0);
}`;
const lineFrag = /* glsl */`
precision highp float; varying float vA; varying vec3 vDir;
${cloudChunk}
void main(){ gl_FragColor = vec4(vec3(0.42, 0.58, 1.0) * vA * (1.0 - cloudBlock(normalize(vDir))), 1.0); }`;

export class Stars {
  constructor(scene, data, sky) {
    const shared = {};
    for (const k of ['uNoise', 'uCamPos', 'uWind', 'uCover', 'uStorm', 'uTime']) shared[k] = sky.uniforms[k];
    this.uniforms = Object.assign(shared, { uM: { value: new THREE.Matrix3() }, uLimit: { value: 5 }, uPx: { value: 1 }, uUseM: { value: 1 }, uLineA: { value: 0 } });
    const mk = (over) => new THREE.ShaderMaterial({
      vertexShader: pointVert, fragmentShader: pointFrag, uniforms: Object.assign({}, this.uniforms, over),
      blending: THREE.AdditiveBlending, transparent: false, depthTest: false, depthWrite: false,
    });
    // catalogue stars (static J2000 unit vectors; the matrix rotates them into the local sky)
    const n = data.stars.length / 4;
    const pos = new Float32Array(n * 3), mag = new Float32Array(n), col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [ra, dec, m, bv] = data.stars.slice(i * 4, i * 4 + 4);
      pos.set(eqVec(ra, dec), i * 3); mag[i] = m;
      bvColor(bv).toArray(col, i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1)); g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    this.stars = new THREE.Points(g, mk({}));
    // planets (world-space directions, refreshed with the ephemeris)
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(15), 3));
    pg.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(5), 1));
    pg.setAttribute('aCol', new THREE.BufferAttribute(new Float32Array(15), 3));
    this.planets = new THREE.Points(pg, mk({ uUseM: { value: 0 } }));
    // constellation lines
    const seg = [];
    for (const s of data.lines) for (let i = 0; i + 3 < s.length; i += 2) seg.push(...eqVec(s[i], s[i + 1]), ...eqVec(s[i + 2], s[i + 3]));
    const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(seg), 3));
    this.lines = new THREE.LineSegments(lg, new THREE.ShaderMaterial({ vertexShader: lineVert, fragmentShader: lineFrag, uniforms: this.uniforms, blending: THREE.AdditiveBlending, transparent: false, depthTest: false, depthWrite: false }));
    this.lines.visible = false;
    for (const o of [this.stars, this.planets, this.lines]) { o.frustumCulled = false; o.renderOrder = -99; scene.add(o); }
    this.names = data.labels.filter((l) => l[2] < 2.1).map(([ra, dec, m, name]) => ({ v: eqVec(ra, dec), mag: m, name }));
    // labels
    this.showNames = false;
    this.root = document.getElementById('skylabels');
    this.items = [];
    const add = (name, cls) => { const e = document.createElement('span'); e.textContent = name; e.className = cls; e.style.display = 'none'; this.root.appendChild(e); return e; };
    this.moonEl = add('Moon', 'pl');
    this.planetEls = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'].map((p) => add(p, 'pl'));
    this.starEls = this.names.map((s) => add(s.name, 'st'));
    this._v = new THREE.Vector3();
  }
  setNames(on) { this.showNames = on; this.lines.visible = on; if (!on) this.root.querySelectorAll('span').forEach((e) => { e.style.display = 'none'; }); }

  update(camera, renderer, st) {
    const u = this.uniforms;
    u.uLimit.value = G.starLimit; u.uPx.value = renderer.getPixelRatio();
    const M = st.M; u.uM.value.set(M[0][0], M[0][1], M[0][2], M[1][0], M[1][1], M[1][2], M[2][0], M[2][1], M[2][2]);
    u.uLineA.value = 0.03 * clamp((G.starLimit + 1) / 6, 0, 1);
    if (st !== this._st) {
      this._st = st;
      const p = this.planets.geometry;
      st.planets.forEach((pl, i) => { p.attributes.position.setXYZ(i, ...pl.dir); p.attributes.aMag.setX(i, pl.mag); p.attributes.aCol.setXYZ(i, ...pl.col); });
      for (const a of ['position', 'aMag', 'aCol']) p.attributes[a].needsUpdate = true;
    }
    if (!this.showNames) return;
    const W = innerWidth, H = innerHeight, veil = 1 - clamp(G.cover * 1.1, 0, 0.92);
    const place = (el, dir, alpha) => {
      if (dir[1] < 0.02 || alpha < 0.04) { el.style.display = 'none'; return; }
      this._v.set(dir[0], dir[1], dir[2]).multiplyScalar(5000).add(camera.position).project(camera);
      if (this._v.z > 1 || Math.abs(this._v.x) > 1.02 || Math.abs(this._v.y) > 1.02) { el.style.display = 'none'; return; }
      el.style.display = ''; el.style.opacity = alpha.toFixed(2);
      el.style.transform = `translate(${((this._v.x + 1) * W / 2 + 9).toFixed(0)}px, ${((1 - this._v.y) * H / 2 - 6).toFixed(0)}px)`;
    };
    const night = clamp((G.starLimit + 1.5) / 5, 0, 1), dark = smoothstep(-2.6, -0.4, G.starLimit);
    place(this.moonEl, st.moonDir, veil * smoothstep(-0.02, 0.04, st.moonDir[1]) * 0.9);
    st.planets.forEach((pl, i) => place(this.planetEls[i], pl.dir, veil * dark * clamp((G.starLimit - pl.mag + 0.5) / 3, 0, 1) * 0.9));
    this.names.forEach((s, i) => {
      const d = [M[0][0] * s.v[0] + M[0][1] * s.v[1] + M[0][2] * s.v[2], M[1][0] * s.v[0] + M[1][1] * s.v[1] + M[1][2] * s.v[2], M[2][0] * s.v[0] + M[2][1] * s.v[1] + M[2][2] * s.v[2]];
      place(this.starEls[i], d, veil * clamp((G.starLimit - s.mag) / 3, 0, 1) * 0.75 * night);
    });
  }
}
