import * as THREE from 'three';
import { G, GLSL_NOISE, WAVES, clamp, smoothstep, waveScale, applyFog, waveWarp } from './common.js';
import { demAt, ponds } from './terrain.js';

// ---------------------------------------------------------------------------
// Shore distance + wind fetch maps (physical: wave height grows with sqrt(fetch))
// ---------------------------------------------------------------------------
const MAP_N = 512, MAP_SPAN = 14000;
let shoreDist = null, fetchMap = null, mapTex = null, fetchAngle = null;
const mapStep = MAP_SPAN / (MAP_N - 1);

function buildShoreDist() {
  const N = MAP_N;
  const d = new Float32Array(N * N);
  const land = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const x = (i / (N - 1) - 0.5) * MAP_SPAN, z = (j / (N - 1) - 0.5) * MAP_SPAN;
    land[j * N + i] = demAt(x, z) >= 0.55 ? 1 : 0;
    d[j * N + i] = land[j * N + i] ? 0 : 1e5;
  }
  const a = mapStep, b = mapStep * Math.SQRT2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a); if (j > 0) v = Math.min(v, d[k - N] + a);
    if (i > 0 && j > 0) v = Math.min(v, d[k - N - 1] + b); if (i < N - 1 && j > 0) v = Math.min(v, d[k - N + 1] + b);
    d[k] = v;
  }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
    const k = j * N + i; let v = d[k];
    if (i < N - 1) v = Math.min(v, d[k + 1] + a); if (j < N - 1) v = Math.min(v, d[k + N] + a);
    if (i < N - 1 && j < N - 1) v = Math.min(v, d[k + N + 1] + b); if (i > 0 && j < N - 1) v = Math.min(v, d[k + N - 1] + b);
    d[k] = v;
  }
  shoreDist = d; return land;
}

export function computeFetch(windAngle) {
  const N = MAP_N;
  if (!shoreDist) buildShoreDist();
  fetchMap = new Float32Array(N * N);
  const ux = -Math.cos(windAngle), uz = -Math.sin(windAngle); // upwind direction
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    if (shoreDist[k] === 0) { fetchMap[k] = 0; continue; }
    const x = (i / (N - 1) - 0.5) * MAP_SPAN, z = (j / (N - 1) - 0.5) * MAP_SPAN;
    let f = 0;
    for (let s = 1; s <= 100; s++) {
      const d = s * 60;
      const px = x + ux * d, pz = z + uz * d;
      const ii = Math.round((px / MAP_SPAN + 0.5) * (N - 1)), jj = Math.round((pz / MAP_SPAN + 0.5) * (N - 1));
      if (ii < 0 || jj < 0 || ii >= N || jj >= N) { f = 6000; break; }
      if (shoreDist[jj * N + ii] === 0) break;
      f = d;
    }
    fetchMap[k] = f;
  }
  // blur once
  const t = new Float32Array(N * N);
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) { let s = 0; for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) s += fetchMap[(j + dj) * N + i + di]; t[j * N + i] = s / 9; }
  fetchMap.set(t);
  fetchAngle = windAngle;
  // pack
  const px = new Uint16Array(N * N * 2);
  for (let k = 0; k < N * N; k++) {
    px[k * 2] = THREE.DataUtils.toHalfFloat(Math.min(shoreDist[k], 800) / 800);
    px[k * 2 + 1] = THREE.DataUtils.toHalfFloat(Math.min(fetchMap[k], 6000) / 6000);
  }
  if (!mapTex) {
    mapTex = new THREE.DataTexture(px, N, N, THREE.RGFormat, THREE.HalfFloatType);
    mapTex.magFilter = mapTex.minFilter = THREE.LinearFilter; mapTex.wrapS = mapTex.wrapT = THREE.ClampToEdgeWrapping;
  } else { mapTex.image.data.set(px); }
  mapTex.needsUpdate = true;
}
function sampleMap(arr, x, z) {
  const N = MAP_N; const fx = clamp((x / MAP_SPAN + 0.5) * (N - 1), 0, N - 1.001), fz = clamp((z / MAP_SPAN + 0.5) * (N - 1), 0, N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
  const a = arr[j * N + i], b = arr[j * N + i + 1], c = arr[(j + 1) * N + i], d = arr[(j + 1) * N + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
export function fetchFactor(x, z) {
  if (!fetchMap) return 1;
  const f = sampleMap(fetchMap, x, z), s = sampleMap(shoreDist, x, z);
  return clamp(Math.sqrt(f / 1250), 0.22, 1.0) * (0.5 + 0.5 * smoothstep(0, 120, s));
}
// physically consistent sea surface used by boats (matches GPU vertex shader)
export function seaHeight(x, z, t = G.time) {
  const sc = waveScale() * fetchFactor(x, z);
  let h = 0; const wa = Math.atan2(G.windDir.y, G.windDir.x); const wp = waveWarp(x, z);
  WAVES.forEach((w, i) => {
    const ang = wa + w.a, k = 2 * Math.PI / w.L, c = Math.sqrt(9.81 / k);
    h += w.A * sc * Math.cos(k * (x * Math.cos(ang) + z * Math.sin(ang)) - k * c * (t % (2 * Math.PI / (k * c))) + wp * (1 - 0.08 * i));
  });
  return h;
}
export function seaSlope(x, z, t = G.time) {
  const sc = waveScale() * fetchFactor(x, z);
  let sx = 0, sz = 0; const wa = Math.atan2(G.windDir.y, G.windDir.x); const wp = waveWarp(x, z);
  WAVES.forEach((w, i) => {
    const ang = wa + w.a, k = 2 * Math.PI / w.L, c = Math.sqrt(9.81 / k);
    const v = -w.A * sc * k * Math.sin(k * (x * Math.cos(ang) + z * Math.sin(ang)) - k * c * (t % (2 * Math.PI / (k * c))) + wp * (1 - 0.08 * i));
    sx += v * Math.cos(ang); sz += v * Math.sin(ang);
  });
  return [sx, sz];
}

// ---------------------------------------------------------------------------
// Water material (MeshStandard + patches: lighting/IBL/fog/shadows come for free)
// ---------------------------------------------------------------------------
export const NW = WAVES.length;
export const waterUniforms = {
  uNoise: { value: null },
  uWDir: { value: WAVES.map(() => new THREE.Vector2()) },
  uWK: { value: WAVES.map((w) => 2 * Math.PI / w.L) },
  uWA: { value: WAVES.map((w) => w.A) },
  uWQ: { value: WAVES.map((w) => w.Q) },
  uWPh: { value: WAVES.map(() => 0) },
  uWScale: { value: 1 },
  uMap: { value: null },
  uTime: { value: 0 }, uRain: { value: 0 }, uWind: { value: 0.5 }, uWindDir: { value: new THREE.Vector2(1, 0) },
  uGustT: { value: 0 }, uPond: { value: 0 }, uDay: { value: 1 },
};
export function updateWaterUniforms() {
  const U = waterUniforms; U.uNoise.value = G.noise; U.uMap.value = mapTex;
  const wa = Math.atan2(G.windDir.y, G.windDir.x);
  WAVES.forEach((w, i) => {
    const ang = wa + w.a; U.uWDir.value[i].set(Math.cos(ang), Math.sin(ang));
    const k = 2 * Math.PI / w.L, c = Math.sqrt(9.81 / k);
    U.uWPh.value[i] = (k * c * G.time) % (2 * Math.PI);
  });
  U.uWScale.value = waveScale();
  U.uTime.value = G.time % 3600; U.uRain.value = G.rain; U.uWind.value = G.wind; U.uWindDir.value.copy(G.windDir);
  U.uGustT.value = G.time; U.uDay.value = clamp(G.dayLevel, 0, 1);
}

export const wavesGLSL = /* glsl */`
uniform vec2 uWDir[${NW}]; uniform float uWK[${NW}]; uniform float uWA[${NW}]; uniform float uWQ[${NW}]; uniform float uWPh[${NW}];
uniform float uWScale; uniform sampler2D uMap; uniform float uPond;
float waveWarp(vec2 xz){ return (vnoise(xz * 0.011 + 7.0) - 0.5) * 2.2; }
float mapDist(vec2 xz){ return texture2D(uMap, xz / 14000.0 + 0.5).r * 800.0; }
float mapFetch(vec2 xz){ return texture2D(uMap, xz / 14000.0 + 0.5).g * 6000.0; }
float seaAmp(vec2 xz){
  float f = mapFetch(xz); float s = mapDist(xz);
  float a = clamp(sqrt(f / 1250.0), 0.22, 1.0) * (0.5 + 0.5 * smoothstep(0.0, 120.0, s));
  return mix(a, 0.10, uPond);
}
`;

export function makeWaterMaterial(pond = false) {
  const mat = new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 0.1, metalness: 0.0, envMapIntensity: 1.0 });
  mat.onBeforeCompile = (sh) => {
    applyFog(sh);
    Object.assign(sh.uniforms, waterUniforms);
    if (pond) sh.uniforms.uPond = { value: 1 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${GLSL_NOISE}
        ${wavesGLSL}
        varying vec3 vWorldP; varying float vDist;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 wp0 = (modelMatrix * vec4(position, 1.0)).xyz;
        float dcam = length(wp0.xz - cameraPosition.xz);
        float amp = seaAmp(wp0.xz);
        float spacing = max(dcam * 0.058, 0.35);
        vec3 dsp = vec3(0.0);
        float wwp = waveWarp(wp0.xz);
        for (int i = 0; i < ${NW}; i++) {
          float L = 6.2831853 / uWK[i];
          float res = 1.0 - smoothstep(0.35, 0.8, spacing * 2.0 / L);
          float ph = uWK[i] * dot(uWDir[i], wp0.xz) - uWPh[i] + wwp * (1.0 - 0.08 * float(i));
          float A = uWA[i] * uWScale * amp * res;
          dsp.y += A * cos(ph);
          dsp.xz -= uWQ[i] * A * uWDir[i] * sin(ph);
        }
        dsp *= (1.0 - uPond);
        transformed += dsp;
        vWorldP = wp0 + dsp; vDist = dcam;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        ${GLSL_NOISE}
        ${wavesGLSL}
        uniform float uTime, uRain, uWind, uGustT, uDay; uniform vec2 uWindDir;
        varying vec3 vWorldP; varying float vDist;
        float gGustField, gFoam, gShade;
        float gustSweep(vec2 p){
          float ph = dot(p, uWindDir) / 14.0;
          float t = uGustT - ph;
          return 1.0 + 0.5 * uWind * (0.5 * sin(t * 0.41) + 0.3 * sin(t * 0.97 + 2.0) + 0.2 * sin(t * 2.3 + 1.0));
        }
        // stateless raindrop rings: only depends on absolute time (mod 1), never on frame dt
        vec2 rainRings(vec2 p, float scale, float rate, float dens){
          vec2 gp = p * scale; vec2 acc = vec2(0.0);
          for (int i = 0; i < 2; i++) {
            vec2 gq = gp + float(i) * 13.7; vec2 cell = floor(gq); vec2 f = fract(gq) - 0.5;
            vec2 hh = hash22(cell);
            float ph = fract(uTime * rate * (0.8 + 0.4 * hh.x) + hh.y);
            float on = step(hash12(cell + 3.1), dens);
            vec2 c = (hh - 0.5) * 0.5; vec2 d = f - c; float dl = length(d);
            float rr = ph * 0.45;
            float ring = sin((dl - rr) * 38.0) * exp(-abs(dl - rr) * 26.0) * (1.0 - ph) * (1.0 - ph) * on;
            acc += d / (dl + 1e-3) * ring;
          }
          return acc;
        }
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        vec2 xz = vWorldP.xz;
        float amp = seaAmp(xz);
        float dist = vDist;
        // ---- analytic wave normal + Jacobian (crest pinching)
        vec2 grad = vec2(0.0); float jxx = 0.0, jzz = 0.0, jxz = 0.0; float lost = 0.0;
        float gust = gustSweep(xz);
        float fwp = waveWarp(xz);
        for (int i = 0; i < ${NW}; i++) {
          float L = 6.2831853 / uWK[i];
          float vis = smoothstep(dist / 120.0, dist / 45.0, L);
          float ph = uWK[i] * dot(uWDir[i], xz) - uWPh[i] + fwp * (1.0 - 0.08 * float(i));
          float A = uWA[i] * uWScale * amp * gust;
          float s = sin(ph), c = cos(ph);
          grad += -A * uWK[i] * s * uWDir[i] * vis;
          float Q = uWQ[i] * A * uWK[i] * vis;
          jxx -= Q * uWDir[i].x * uWDir[i].x * c; jzz -= Q * uWDir[i].y * uWDir[i].y * c; jxz -= Q * uWDir[i].x * uWDir[i].y * c;
          lost += (1.0 - vis) * pow(A * uWK[i], 2.0);
        }
        float J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;
        // ---- wind-aligned capillary detail (anisotropic), advected by the wind, strengthened by gust cat's-paws
        vec2 wd = uWindDir, wpn = vec2(-wd.y, wd.x);
        vec2 q = vec2(dot(xz, wd), dot(xz, wpn));
        float cat = smoothstep(0.30, 0.75, fbm3(xz * 0.0065 - wd * uGustT * 2.5 * 0.0065 * 4.0 + 3.0));
        gGustField = cat;
        float detAmp = (0.020 + 0.11 * uWind) * (0.5 + 0.9 * cat) * (1.0 - smoothstep(60.0, 700.0, dist) * 0.85) * mix(1.0, 0.35, uPond);
        vec2 d1 = vec2(0.0);
        {
          vec2 p1 = q * vec2(0.55, 1.3) - vec2(uWind * 2.2 * uTime * 0.5, 0.0);
          float e = 0.07;
          float h0 = vnoise(p1), hx = vnoise(p1 + vec2(e, 0.0)), hy = vnoise(p1 + vec2(0.0, e));
          vec2 g1 = vec2(hx - h0, hy - h0) / e;
          vec2 p2 = q * vec2(1.7, 3.6) - vec2(uWind * 3.4 * uTime * 0.5, 0.3 * uTime);
          float k0 = vnoise(p2), kx = vnoise(p2 + vec2(e, 0.0)), ky = vnoise(p2 + vec2(0.0, e));
          vec2 g2 = vec2(kx - k0, ky - k0) / e;
          d1 = (g1 * 0.5 + g2 * 0.35);
          d1 = wd * d1.x * 0.6 + wpn * d1.y;
        }
        vec2 tot = grad + d1 * detAmp;
        // rain ring ripples: real rings are 10-30 cm, so they only resolve within ~20 m (avoid sub-pixel sparkle)
        if (uRain > 0.02 && dist < 26.0) {
          float px = dist * 0.0022;                      // metres per pixel (approx)
          float fadeR = 1.0 - smoothstep(6.0, 26.0, dist);
          vec2 r1 = rainRings(xz, 1.7, 1.5, uRain * 0.9) + rainRings(xz + 40.0, 3.4, 2.1, uRain * 0.75) * 0.7;
          tot += r1 * 0.10 * fadeR * (0.3 + 0.7 * uRain);
        }
        vec3 Nw = normalize(vec3(-tot.x, 1.0, -tot.y));
        // ---- foam: thin, streaky, lace-like. Driven by crest pinching (J) not by random blobs
        float thr = 0.66 + 0.16 * uWind;
        float pot = smoothstep(thr, thr - 0.16, J);
        float brk = smoothstep(0.85, 1.35, length(grad));
        pot = max(pot * 0.55, brk * 0.7) * smoothstep(0.4, 0.75, uWind);
        pot *= (0.7 + 0.5 * cat);
        float t = uTime;
        float f1 = vnoise(q * vec2(0.9, 2.6) + vec2(-0.6 * t, 0.0));
        float f2 = vnoise(q * vec2(3.2, 8.5) + 11.0 + vec2(-0.9 * t, 0.0));
        float f3 = vnoise(q * vec2(9.0, 21.0) + 5.0);
        float pat = f1 * 0.42 + f2 * 0.33 + f3 * 0.25;
        float lvl = 0.42 + 0.34 * (1.0 - pot);
        float core = smoothstep(lvl, lvl + 0.10, pat + pot * 0.42) * smoothstep(0.06, 0.32, pot);
        float net = (1.0 - smoothstep(0.0, 0.045, abs(pat - lvl - 0.13))) * smoothstep(0.02, 0.28, pot) * 0.65;
        // long wind-aligned streaks of old foam (Langmuir lines)
        float sk = vnoise(vec2(q.x * 0.045 - 0.4 * t, q.y * 0.55) + 20.0) * 0.6 + vnoise(vec2(q.x * 0.11, q.y * 1.7) + 8.0) * 0.4;
        float streaks = smoothstep(0.62, 0.86, sk) * smoothstep(0.35, 0.85, uWind) * (0.35 + 0.65 * f2) * 0.55;
        float shore = (1.0 - smoothstep(0.0, 14.0, mapDist(xz))) * (1.0 - uPond) * smoothstep(0.0, 0.5, uWind);
        float lap = shore * (0.5 + 0.5 * sin(mapDist(xz) * 0.55 - uTime * 1.6)) * smoothstep(0.2, 0.7, f2 + f3 * 0.4);
        float foam = clamp(max(max(core * 0.92, net), max(streaks * (1.0 - smoothstep(300.0, 1400.0, dist)), lap * 0.7)), 0.0, 1.0);
        foam *= (1.0 - uPond);
        foam *= 1.0 - smoothstep(1500.0, 3600.0, dist);
        gFoam = foam;
        vec3 water = mix(vec3(0.0045, 0.0125, 0.0155), vec3(0.006, 0.014, 0.012), uPond);
        water *= mix(1.0, 0.65, cat * uWind);              // gust patches read darker
        // faint crest transmission (thin, no milky wash)
        float thinCrest = smoothstep(0.55, 1.0, sin(1.0) * (grad.x * wd.x + grad.y * wd.y) * -6.0 + 0.5) * 0.0;
        vec3 foamCol = vec3(0.60, 0.63, 0.64) * (0.62 + 0.38 * pat) ;
        diffuseColor.rgb = mix(water, foamCol, foam);
        gShade = foam;
        // roughness broadens with distance & lost sub-pixel wave variance
        float rough = 0.045 + 0.10 * uWind + 4.0 * lost + 0.20 * smoothstep(120.0, 2500.0, dist) * (0.4 + uWind);
        rough += uRain * 0.06 * (1.0 - smoothstep(30.0, 200.0, dist));
        rough = mix(rough, 0.55 + 0.25 * f2, foam);
        gRoughW = clamp(rough, 0.03, 0.85);
      `)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = gRoughW;')
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        normal = normalize((viewMatrix * vec4(Nw, 0.0)).xyz);
      `)
      .replace('uniform float uTime, uRain, uWind, uGustT, uDay;', 'uniform float uTime, uRain, uWind, uGustT, uDay; float gRoughW;');
  };
  mat.customProgramCacheKey = () => (pond ? 'pond' : 'sea');
  return mat;
}

function polarGrid(nr = 170, na = 280, r0 = 1.2, rmax = 14000) {
  const pos = new Float32Array((nr * na + 1) * 3);
  const g = Math.pow(rmax / r0, 1 / (nr - 1));
  for (let i = 0; i < nr; i++) {
    const r = r0 * Math.pow(g, i);
    for (let j = 0; j < na; j++) {
      const a = (j / na) * Math.PI * 2, k = (i * na + j) * 3;
      pos[k] = Math.cos(a) * r; pos[k + 1] = 0; pos[k + 2] = Math.sin(a) * r;
    }
  }
  const cIdx = nr * na; // centre
  const idx = [];
  for (let j = 0; j < na; j++) idx.push(cIdx, ((j + 1) % na), j);
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < na; j++) {
    const a = i * na + j, b = i * na + (j + 1) % na, c = (i + 1) * na + j, d = (i + 1) * na + (j + 1) % na;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nor = new Float32Array(pos.length); for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setIndex(idx);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), rmax * 2);
  return geo;
}

export function makeSea() {
  const mesh = new THREE.Mesh(polarGrid(), makeWaterMaterial(false));
  mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.renderOrder = 1;
  return mesh;
}

export function makePonds() {
  const group = new THREE.Group();
  for (const p of ponds) {
    const contour = p.poly.map((q) => new THREE.Vector2(q[0], q[1]));
    // subdivide edges a bit so shading interpolation is stable
    const tris = THREE.ShapeUtils.triangulateShape(contour, []);
    const pos = [];
    for (const t of tris) for (const i of t) pos.push(p.poly[i][0], 0, p.poly[i][1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const nn = []; for (let i = 0; i < pos.length / 3; i++) nn.push(0, 1, 0);
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nn, 3));
    const m = new THREE.Mesh(g, makeWaterMaterial(true));
    m.position.y = p.level; m.receiveShadow = true; m.renderOrder = 1;
    group.add(m);
  }
  return group;
}
