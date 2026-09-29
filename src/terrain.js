import * as THREE from 'three';
import { G, GLSL_NOISE, clamp, smoothstep, applyFog } from './common.js';

// ---------------------------------------------------------------------------
// Height field (real elevation data, 13.7 m posts, smoothed + bicubic sampled)
// ---------------------------------------------------------------------------
let DEM = null; // { N, SPAN, h: Float32Array, step }
const carves = []; // pond carve polygons

export async function loadDEM() {
  const meta = await (await fetch('/dem.json')).json();
  const buf = new Uint16Array(await (await fetch('/dem.bin')).arrayBuffer());
  const N = meta.N;
  let h = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) h[i] = buf[i] * meta.scale - meta.offset;
  // light smoothing (source has stair-steps / building noise)
  const tmp = new Float32Array(N * N);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0, w = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = clamp(i + di, 0, N - 1), jj = clamp(j + dj, 0, N - 1);
        const k = (di === 0 && dj === 0) ? 4 : (di === 0 || dj === 0) ? 2 : 1;
        s += h[jj * N + ii] * k; w += k;
      }
      tmp[j * N + i] = s / w;
    }
    h.set(tmp);
  }
  DEM = { N, SPAN: meta.SPAN, h, step: meta.SPAN / (N - 1) };
}

function cr(p0, p1, p2, p3, t) { // Catmull-Rom
  return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
}
export function demAt(x, z) {
  const { N, SPAN, h } = DEM;
  const fx = (x / SPAN + 0.5) * (N - 1), fz = (z / SPAN + 0.5) * (N - 1);
  const i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j;
  const row = [];
  for (let dj = -1; dj <= 2; dj++) {
    const jj = clamp(j + dj, 0, N - 1);
    const g = (di) => h[jj * N + clamp(i + di, 0, N - 1)];
    row.push(cr(g(-1), g(0), g(1), g(2), tx));
  }
  return cr(row[0], row[1], row[2], row[3], tz);
}

// raw DEM value (0 == open sea) -> terrain height (sea floor below 0)
export function heightAt(x, z) {
  const d = demAt(x, z);
  let h = d - 7 * (1 - smoothstep(0.15, 1.3, d));
  for (const c of carves) h = c.apply(x, z, h);
  return h;
}
export function isSea(x, z) { return demAt(x, z) < 0.55; }

// ---------------------------------------------------------------------------
// Pond carving (Lille Lungegaardsvann etc.)
// ---------------------------------------------------------------------------
function polyArea(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function pointInPoly(x, z, p) {
  let c = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    if (((p[i][1] > z) !== (p[j][1] > z)) && (x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c;
  }
  return c;
}
function distToPoly(x, z, p) {
  let best = 1e9;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const t = clamp(((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz + 1e-9), 0, 1);
    const d = Math.hypot(x - (a[0] + t * dx), z - (a[1] + t * dz));
    if (d < best) best = d;
  }
  return best;
}
export const ponds = [];
export function registerPonds(waterPolys) {
  for (const w of waterPolys) {
    const a = Math.abs(polyArea(w.p));
    if (a < 2500) continue;
    // ignore anything that is sea per DEM
    const cx = w.p.reduce((s, q) => s + q[0], 0) / w.p.length, cz = w.p.reduce((s, q) => s + q[1], 0) / w.p.length;
    if (isSea(cx, cz)) continue;
    let level = 1e9;
    for (const q of w.p) level = Math.min(level, demAt(q[0], q[1]));
    level = Math.max(level - 0.05, 0.6);
    let minx = 1e9, maxx = -1e9, minz = 1e9, maxz = -1e9;
    for (const q of w.p) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); minz = Math.min(minz, q[1]); maxz = Math.max(maxz, q[1]); }
    const pond = { poly: w.p, level, area: a, minx: minx - 8, maxx: maxx + 8, minz: minz - 8, maxz: maxz + 8 };
    pond.apply = (x, z, h) => {
      if (x < pond.minx || x > pond.maxx || z < pond.minz || z > pond.maxz) return h;
      const inside = pointInPoly(x, z, pond.poly);
      const d = distToPoly(x, z, pond.poly);
      const s = inside ? d : -d;
      // bank: land up to +0.5 above level right outside, bed 2.5 m below level inside
      const bed = level - 0.25 - 2.2 * smoothstep(0, 4, s);
      const bank = Math.max(h, level + 0.35);
      const t = smoothstep(-1.5, 2.0, s); // 0 outside .. 1 inside
      return h + (Math.min(bed, h) - h) * t + (s < 0 ? 0 : 0) * bank;
    };
    carves.push(pond); ponds.push(pond);
  }
}

// ---------------------------------------------------------------------------
// Ground painting from OSM: roads, pavements, tram tracks, parks -> textures
// ---------------------------------------------------------------------------
const ROAD_W = { motorway: 8, motorway_link: 5, trunk: 8, trunk_link: 5, primary: 8, primary_link: 5, secondary: 7.5, secondary_link: 5, tertiary: 6.5, unclassified: 5.8, residential: 5.6, living_street: 5, service: 3.6, pedestrian: 5, footway: 2.2, path: 1.6, steps: 2, cycleway: 2.4, platform: 3, corridor: 0 };
const ROAD_Z = { footway: 1, path: 1, steps: 1, cycleway: 1, platform: 1, service: 2, pedestrian: 2, living_street: 3, residential: 3, unclassified: 4, tertiary: 4, secondary: 5, primary: 6, trunk: 7, trunk_link: 6, motorway: 7, motorway_link: 6, primary_link: 5, secondary_link: 5 };

export function paintGround(city, bounds, size, opts = {}) {
  const [minx, minz, maxx, maxz] = bounds;
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const sx = size / (maxx - minx), sz = size / (maxz - minz);
  const mpp = (maxx - minx) / size;
  const X = (x) => (x - minx) * sx, Z = (z) => (z - minz) * sz;
  ctx.clearRect(0, 0, size, size);
  ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
  // urban / garden zones: dilate every footprint so the ground around buildings is paved or garden, nature elsewhere
  const ringPath = (pts) => { ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Z(q[1])) : ctx.moveTo(X(q[0]), Z(q[1]))); ctx.closePath(); };
  const polyA = (p) => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return Math.abs(a / 2); };
  for (const b of city.buildings) {
    const small = polyA(b.p) < 320;
    ctx.fillStyle = ctx.strokeStyle = small ? '#67744f' : '#7b7c77';
    ctx.lineWidth = (small ? 8 : 9) * sx; ringPath(b.p); ctx.fill(); ctx.stroke();
  }

  // parks / green / pitches
  for (const p of city.parks) {
    if (p.p.length < 3) continue;
    ctx.beginPath(); p.p.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Z(q[1])) : ctx.moveTo(X(q[0]), Z(q[1]))); ctx.closePath();
    ctx.fillStyle = p.t === 'pitch' ? '#3f6f3c' : (p.t === 'forest' ? '#2c4a2a' : p.t === 'cemetery' ? '#4b5f45' : '#4d7a3d');
    ctx.fill();
  }
  // hand-authored ground the OSM data lacks (e.g. the Nygaardstangen freight yard east of Media City)
  for (const ex of (opts.extras || [])) { ringPath(ex.p); ctx.fillStyle = ex.c; ctx.fill(); }
  // building footprints: soft contact-shadow halo + dark base
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = Math.max(2, 3.2 / mpp);
  ctx.fillStyle = '#4a4a48';
  for (const b of city.buildings) {
    ctx.beginPath(); b.p.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Z(q[1])) : ctx.moveTo(X(q[0]), Z(q[1]))); ctx.closePath(); ctx.fill();
  }
  ctx.restore();

  const roads = city.roads.filter((r) => !r.tn && (ROAD_W[r.t] || 0) > 0);
  const order = (r) => (r.br ? 20 : 0) + (ROAD_Z[r.t] || 1) + (r.ly || 0) * 3;
  roads.sort((a, b) => order(a) - order(b));
  const stroke = (r, w, style) => {
    ctx.beginPath(); r.p.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Z(q[1])) : ctx.moveTo(X(q[0]), Z(q[1])));
    ctx.lineWidth = Math.max(w * sx, 0.9); ctx.strokeStyle = style; ctx.stroke();
  };
  const minW = mpp * 1.1;
  // pavements first
  for (const r of roads) {
    const w = ROAD_W[r.t];
    if (['motorway', 'motorway_link', 'trunk', 'trunk_link'].includes(r.t)) continue;
    if (w >= 3.5) stroke(r, w + 4.2, /sett|paving/.test(r.sf) ? '#aaa49a' : '#9a978f');
  }
  // carriageways
  for (const r of roads) {
    const w = ROAD_W[r.t];
    let style = '#4e5053';
    if (w < 3.5) style = /sett|paving|concrete/.test(r.sf) ? '#8f887d' : (/gravel/.test(r.sf) ? '#847d70' : '#88857e');
    else if (/sett|paving/.test(r.sf)) style = '#7d776f';
    stroke(r, Math.max(w, minW), style);
  }
  // rails
  ctx.setLineDash([]);
  for (const r of city.rails) { stroke(r, 3.3, '#77716a'); }
  for (const r of city.rails) { stroke(r, 0.2, '#9a9a9a'); }
  // lane centre lines and zebra crossings (only when resolution allows)
  if (mpp < 0.6) {
    ctx.setLineDash([3.0 * sx, 5.0 * sx]);
    for (const r of roads) {
      if (['primary', 'secondary', 'tertiary', 'trunk', 'unclassified'].includes(r.t) && !r.ow) stroke(r, 0.14, 'rgba(230,230,220,0.75)');
      if (['residential'].includes(r.t)) stroke(r, 0.10, 'rgba(230,230,220,0.35)');
    }
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(235,235,230,0.85)';
    for (const r of city.roads) {
      if (r.t !== 'footway' || r.p.length !== 2) continue;
      // crossing segments: stripes perpendicular to the crossing direction
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8; tex.premultiplyAlpha = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
  return { tex, bounds: [minx, minz, maxx - minx, maxz - minz] };
}

// ---------------------------------------------------------------------------
// Terrain mesh (three concentric rings of decreasing resolution)
// ---------------------------------------------------------------------------
function ringGeometry(half, step, hole) {
  const n = Math.round((2 * half) / step);
  const nv = n + 1;
  const pos = new Float32Array(nv * nv * 3), nor = new Float32Array(nv * nv * 3);
  const e = step * 0.75;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nv; i++) {
    const x = -half + i * step, z = -half + j * step;
    const k = (j * nv + i) * 3;
    const y = heightAt(x, z);
    pos[k] = x; pos[k + 1] = y; pos[k + 2] = z;
    const hx = heightAt(x + e, z) - heightAt(x - e, z), hz = heightAt(x, z + e) - heightAt(x, z - e);
    const nx = -hx / (2 * e), nz = -hz / (2 * e), l = Math.hypot(nx, 1, nz);
    nor[k] = nx / l; nor[k + 1] = 1 / l; nor[k + 2] = nz / l;
  }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const cx = -half + (i + 0.5) * step, cz = -half + (j + 0.5) * step;
    if (hole && Math.abs(cx) < hole && Math.abs(cz) < hole) continue;
    const a = j * nv + i, b = a + 1, c = a + nv, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const terrainFrag = /* glsl */`
uniform sampler2D uGroundFine, uGroundCoarse;
uniform vec4 uBoundsFine, uBoundsCoarse;
uniform float uWet, uRain, uTime, uNightL;
varying vec3 vWPos; varying vec3 vWNrm;
${GLSL_NOISE}
vec3 srgb2lin(vec3 c){ return pow(c, vec3(2.2)); }
`;

export function makeTerrain(ground) {
  const geos = [ringGeometry(1500, 6, 0), ringGeometry(4500, 24, 1500), ringGeometry(7000, 64, 4500)];
  const uniforms = {
    uNoise: { value: G.noise },
    uGroundFine: { value: ground.fine.tex }, uBoundsFine: { value: new THREE.Vector4(...ground.fine.bounds) },
    uGroundCoarse: { value: ground.coarse.tex }, uBoundsCoarse: { value: new THREE.Vector4(...ground.coarse.bounds) },
    uWet: { value: 0.5 }, uRain: { value: 0 }, uTime: { value: 0 },
  };
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    applyFog(sh);
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWPos = (modelMatrix * vec4(position,1.0)).xyz; vWNrm = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + terrainFrag)
      .replace('#include <color_fragment>', /* glsl */`
        vec2 xz = vWPos.xz;
        float elev = vWPos.y;
        float slope = 1.0 - clamp(vWNrm.y, 0.0, 1.0);
        float n1 = fbm(xz * 0.004), n2 = fbm(xz * 0.03 + 5.0), n3 = vnoise(xz * 0.35) ;
        // natural cover
        vec3 grass = vec3(0.075, 0.115, 0.045) * (0.7 + 0.6 * n2);
        vec3 forest = mix(vec3(0.030, 0.052, 0.028), vec3(0.045, 0.075, 0.035), n2) * (0.75 + 0.5 * n3);
        vec3 rock = vec3(0.17, 0.16, 0.15) * (0.7 + 0.5 * n2);
        vec3 heather = vec3(0.11, 0.095, 0.06) * (0.8 + 0.4 * n2);
        float forestMask = smoothstep(8.0, 40.0, elev) * (1.0 - smoothstep(330.0 + 80.0 * n1, 460.0 + 80.0 * n1, elev));
        vec3 nat = mix(grass, forest, forestMask * smoothstep(0.35, 0.6, n1 + 0.15));
        nat = mix(nat, mix(heather, grass, 0.3), smoothstep(320.0, 480.0, elev + 60.0 * n1));
        nat = mix(nat, rock, smoothstep(0.30, 0.55, slope + (n2 - 0.5) * 0.25));
        // sea floor / quay edge: dark
        nat = mix(nat, vec3(0.03, 0.035, 0.035), smoothstep(0.5, -1.5, elev));
        // urban base (outside painted maps we still fade to city grey near the centre)
        vec3 urban = vec3(0.12, 0.12, 0.115) * (0.75 + 0.5 * n3);
        float urbanMask = (1.0 - smoothstep(650.0, 1500.0, length(xz - vec2(-250.0, -300.0)))) * (1.0 - smoothstep(60.0, 140.0, elev)) * 0.92;
        vec3 gcol = mix(nat, urban, urbanMask);
        float painted = 0.0; float hard = 0.0; float grassy = 0.0;
        // coarse map (alpha = painted coverage)
        vec2 uvC = (xz - uBoundsCoarse.xy) / uBoundsCoarse.zw;
        if (uvC.x > 0.0 && uvC.x < 1.0 && uvC.y > 0.0 && uvC.y < 1.0) {
          vec4 t = texture2D(uGroundCoarse, uvC);
          vec3 c = t.rgb / max(t.a, 0.001);
          float g = smoothstep(0.015, 0.05, c.g - max(c.r, c.b) * 0.9);
          vec3 cc = mix(c, grass * 1.4, g * 0.5);
          float edge = smoothstep(0.0, 0.03, min(min(uvC.x, 1.0 - uvC.x), min(uvC.y, 1.0 - uvC.y)));
          float a = t.a * edge;
          gcol = mix(gcol, cc * (0.85 + 0.3 * n3), a);
          hard = mix(hard, 1.0 - g, a); grassy = mix(grassy, g, a);
        }
        vec2 uvF = (xz - uBoundsFine.xy) / uBoundsFine.zw;
        if (uvF.x > 0.0 && uvF.x < 1.0 && uvF.y > 0.0 && uvF.y < 1.0) {
          vec4 t = texture2D(uGroundFine, uvF);
          vec3 c = t.rgb / max(t.a, 0.001);
          float g = smoothstep(0.012, 0.045, c.g - max(c.r, c.b) * 0.9);
          float edge = smoothstep(0.0, 0.02, min(min(uvF.x, 1.0 - uvF.x), min(uvF.y, 1.0 - uvF.y)));
          float a = t.a * edge;
          // micro variation so asphalt/paving does not look printed
          float mv = 0.75 + 0.5 * vnoise(xz * 1.7) * (0.6 + 0.4 * vnoise(xz * 6.0));
          vec3 cc = c * mv;
          cc = mix(cc, cc * vec3(0.7, 0.95, 0.6) * (0.7 + 0.6 * fbm3(xz * 0.9)), g);
          gcol = mix(gcol, cc, a);
          hard = mix(hard, 1.0 - g, a); grassy = mix(grassy, g, a);
        }
        // puddles only on hard surfaces
        float pn = fbm(xz * 0.11 + 3.0) * 0.7 + vnoise(xz * 0.7) * 0.3;
        float pe = 0.635 - 0.075 * uWet;
        float puddle = smoothstep(pe, pe + 0.045, pn) * hard * uWet;
        gcol *= mix(1.0, 0.68, uWet * hard) * mix(1.0, 0.7, puddle);
        gcol *= mix(1.0, 0.75, uWet * grassy);
        vGround = vec3(hard, puddle, grassy);
        diffuseColor.rgb = gcol;
      `)
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        float roughnessFactor = roughness;
        roughnessFactor = mix(0.95, mix(0.62, 0.24, uWet), vGround.x);
        roughnessFactor = mix(roughnessFactor, 0.035, vGround.y);
        roughnessFactor = mix(roughnessFactor, 0.55, vGround.z * 0.5);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        // rain rings on puddles + micro bumps (stateless, no dt dependence)
        if (vGround.y > 0.05 && uRain > 0.02) {
          vec2 gp = vWPos.xz * 3.2;
          vec3 acc = vec3(0.0);
          for (int i = 0; i < 2; i++) {
            vec2 cell = floor(gp + float(i) * 17.3);
            vec2 f = fract(gp + float(i) * 17.3) - 0.5;
            vec2 hh = hash22(cell);
            float ph = fract(uTime * (0.9 + hh.x * 0.5) + hh.y);
            float rr = ph * 0.5; float d = length(f - (hh - 0.5) * 0.4);
            float ring = sin((d - rr) * 60.0) * exp(-abs(d - rr) * 22.0) * (1.0 - ph) * step(hash12(cell + 5.0), uRain);
            vec2 dir = normalize(f - (hh - 0.5) * 0.4 + 1e-4);
            acc.xy += dir * ring;
          }
          normal = normalize(normal + (viewMatrix * vec4(acc.x, 0.0, acc.y, 0.0)).xyz * 0.16 * vGround.y);
        }
      `)
      ;
    sh.fragmentShader = sh.fragmentShader.replace('varying vec3 vWNrm;', 'varying vec3 vWNrm; vec3 vGround;');
  };
  const group = new THREE.Group();
  for (const g of geos) {
    const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.frustumCulled = false; group.add(m);
  }
  group.userData.uniforms = uniforms;
  return group;
}
