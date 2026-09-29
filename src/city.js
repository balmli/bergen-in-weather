import * as THREE from 'three';
import { G, GLSL_NOISE, mulberry, applyFog } from './common.js';
import { SoupBuilder, STYLE, hexLin } from './builder.js';
import { heightAt } from './terrain.js';

// ---------------------------------------------------------------- palettes
const WALL_WHITE = [0xdcd8cc, 0xe4e0d6, 0xd0ccc0, 0xd8d3c6, 0xc9c8c2];
const WALL_YELLOW = [0xd2bd8c, 0xc4ab78, 0xd9c79f, 0xcdb88a];
const WALL_RED = [0x94503f, 0x86463a, 0x9e5f4b, 0x7a4235];
const WALL_GREY = [0xa4a5a1, 0x8c8f8f, 0xb5b4ad, 0x999892, 0xb9bcbc];
const WALL_PASTEL = [0xa1b0af, 0xb3bfa6, 0xc0b5a4, 0x9caab8];
const WALL_BROWN = [0x5c4838, 0x6b5643];
const ROOF_TILE = [0xa8492f, 0x9a4530, 0x87392a, 0xb0563a, 0x7a3a2c];
const ROOF_SLATE = [0x4a4c50, 0x3a3c40, 0x55575b];
const ROOF_FLAT = [0x54565a, 0x62615d, 0x484a4d, 0x6b6a64, 0x585b5c];
const ROOF_GREEN = [0x5f7248, 0x6a7a50];

const pick = (r, a) => a[Math.floor(r() * a.length)];
function parseColour(s) {
  if (!s) return null;
  if (s[0] === '#') return parseInt(s.slice(1), 16);
  const m = { black: 0x2a2a2c, white: 0xe8e6de, grey: 0x9a9a98, gray: 0x9a9a98, red: 0x9b4b39, brown: 0x6b5643, yellow: 0xd9b76e, beige: 0xd9cdb0, green: 0x7f9070, blue: 0x8fa3b5 };
  return m[s.toLowerCase()] || null;
}

function area(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; } return a / 2; }
function centroid(p) { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; }
function simplify(p) {
  const out = [];
  for (let i = 0; i < p.length; i++) {
    const a = out.length ? out[out.length - 1] : p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.4) continue;
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 0.02) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : p;
}
// oriented bounding box, angle taken from polygon edges
export function obb(p) {
  const edges = [];
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; edges.push([Math.atan2(q[1] - p[i][1], q[0] - p[i][0]), Math.hypot(q[0] - p[i][0], q[1] - p[i][1])]); }
  edges.sort((a, b) => b[1] - a[1]);
  let best = null;
  for (const [ang] of edges.slice(0, 10)) {
    const c = Math.cos(ang), s = Math.sin(ang);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (const q of p) { const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const A = (u1 - u0) * (v1 - v0);
    if (!best || A < best.A) best = { A, ang, u0, u1, v0, v1 };
  }
  // make ridge axis the long one
  if ((best.u1 - best.u0) < (best.v1 - best.v0)) { best.ang += Math.PI / 2; const c = Math.cos(best.ang), s = Math.sin(best.ang); let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9; for (const q of p) { const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); } Object.assign(best, { u0, u1, v0, v1, A: (u1 - u0) * (v1 - v0) }); }
  return best;
}

// split triangle by the line f(p)=0 (Sutherland-Hodgman on both sides)
function clipTri(t, f) {
  const d = t.map(f);
  if (d.every((x) => x >= -1e-6) || d.every((x) => x <= 1e-6)) return [t];
  const pos = [], neg = [];
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3, a = t[i], b = t[j], da = d[i], db = d[j];
    if (da >= 0) pos.push(a);
    if (da <= 0) neg.push(a);
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) { const s = da / (da - db); const m = [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s]; pos.push(m); neg.push(m); }
  }
  const out = [];
  for (const poly of [pos, neg]) for (let k = 1; k < poly.length - 1; k++) out.push([poly[0], poly[k], poly[k + 1]]);
  return out;
}

// ---------------------------------------------------------------- facade material
export const cityUniforms = { uNoise: { value: null }, uWet: { value: 0.5 }, uLit: { value: 0 }, uTime: { value: 0 }, uRain: { value: 0 } };

export function makeCityMaterial() {
  cityUniforms.uNoise.value = G.noise;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  mat.onBeforeCompile = (sh) => {
    applyFog(sh);
    Object.assign(sh.uniforms, cityUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aWall; attribute vec4 aInfo; attribute vec4 aInfo2;
        varying vec2 vWall; varying vec4 vInfo; varying vec4 vInfo2; varying vec3 vWP; varying vec3 vWN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vWall = aWall; vInfo = aInfo; vInfo2 = aInfo2; vWP = (modelMatrix * vec4(position, 1.0)).xyz; vWN = normal;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vWall; varying vec4 vInfo; varying vec4 vInfo2; varying vec3 vWP; varying vec3 vWN;
        uniform float uWet, uLit, uTime, uRain;
        ${GLSL_NOISE}
        vec3 gEmit; float gRough; float gGlass; float gMetal;
        float cover(float x, float a, float b, float w){ return clamp((min(x + 0.5*w, b) - max(x - 0.5*w, a)) / max(w, 1e-4), 0.0, 1.0); }
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        gEmit = vec3(0.0); gGlass = 0.0; gMetal = 0.0;
        float isWall = step(abs(vWN.y), 0.5);
        int style = int(vInfo2.x * 255.0 + 0.5);
        int flags = int(vInfo2.w * 255.0 + 0.5);
        float fh = max(vInfo.x * 8.0, 2.4), ww = max(vInfo.y * 8.0, 1.2), gx = vInfo.z, gy = vInfo.w;
        float litP = vInfo2.y; float bh = vInfo2.z * 255.0;
        vec3 base = diffuseColor.rgb;
        gRough = 0.86;
        if (isWall > 0.5) {
          vec2 cell = vec2(vWall.x / ww, vWall.y / fh);
          vec2 id = floor(cell); vec2 f = fract(cell);
          vec2 fw = max(fwidth(cell), vec2(1e-4));
          bool ground = vWall.y < fh && (flags & 4) != 0;
          float mxm = (1.0 - gx) * 0.5, myb = (1.0 - gy) * 0.5, myt = (1.0 - gy) * 0.5 + 0.06;
          float wmask = 0.0, inner = 0.0, frame = 0.0;
          float cid = hash12(id + bh * 7.31);
          if (style == 5) { // podium: continuous ribbon windows
            float wy = cover(f.y, 0.30, 0.74, fw.y);
            wmask = wy; inner = wy;
            float mull = 1.0 - cover(f.x, 0.96, 1.0, fw.x) * 0.9;
            wmask *= mull; inner = wmask;
            base *= 1.0 - 0.10 * smoothstep(0.86, 1.0, f.y) ;
          } else if (style == 2) { // black tower: dark glass band + black spandrel, thin vertical ribs
            float wy = cover(f.y, 0.16, 0.80, fw.y);
            float rib = 1.0 - cover(f.x, 0.90, 1.0, fw.x) * 0.85;
            wmask = wy * rib; inner = wmask;
            base = mix(vec3(0.012, 0.013, 0.015), base, 0.0);
          } else if (style == 3) { // curtain wall
            float wx = cover(f.x, 0.03, 0.97, fw.x), wy = cover(f.y, 0.06, 0.70, fw.y);
            wmask = wx * wy; inner = wmask;
          } else if (style == 4) { // perforated lattice cladding
            vec2 q = vec2(vWall.x, vWall.y) / vec2(1.6, 1.6);
            vec2 r = vec2(q.x + q.y, q.x - q.y) * 0.7071;
            vec2 ff = abs(fract(r * 1.0) - 0.5) * 2.0;
            float hole = 1.0 - smoothstep(0.35, 0.55, max(ff.x, ff.y) * 0.9 + 0.1 * (1.0 - min(fw.x*4.0, 1.0)));
            wmask = hole * 0.75; inner = wmask;
            base = mix(base, vec3(0.58, 0.60, 0.57), 0.3);
          } else if (style == 1 || style == 7) {
            float wxo = cover(f.x, mxm, 1.0 - mxm, fw.x);
            float wyo = cover(f.y, myb, 1.0 - myt, fw.y);
            float wxi = cover(f.x, mxm + 0.05, 1.0 - mxm - 0.05, fw.x);
            float wyi = cover(f.y, myb + 0.05, 1.0 - myt - 0.04, fw.y);
            if (ground) { wxo = cover(f.x, 0.06, 0.94, fw.x); wyo = cover(f.y, 0.10, 0.88, fw.y); wxi = wxo; wyi = wyo; }
            wmask = wxo * wyo; inner = wxi * wyi; frame = wmask - inner;
            // recess shadow under lintel & on sill
            inner *= 1.0;
          }
          // per-window variation (blinds, curtains, depth)
          vec3 glassCol = mix(vec3(0.045, 0.055, 0.065), vec3(0.15, 0.16, 0.17), cid);
          if (cid > 0.82 && style == 1) glassCol = mix(glassCol, base * 0.5, 0.6);   // curtains / blinds
          if (style == 2) glassCol = vec3(0.02, 0.026, 0.032);
          if (style == 3) glassCol = mix(vec3(0.06, 0.09, 0.11), vec3(0.12, 0.16, 0.18), cid);
          if (style == 5) glassCol = mix(vec3(0.05, 0.062, 0.072), vec3(0.11, 0.12, 0.13), cid);
          vec3 frameCol = mix(base * 0.9, vec3(0.6, 0.6, 0.58), 0.35);
          if (style == 1 || style == 7) { base = mix(base, frameCol, frame); }
          vec3 wallC = base;
          float mpp = max(fw.x * ww, 0.0005);
          float md = 1.0 - smoothstep(0.012, 0.09, mpp);       // micro-detail fades with distance (no shimmer)
          // plaster / paint grain
          wallC *= 1.0 + (vnoise(vec2(vWall.x * 7.0, vWall.y * 7.0)) - 0.5) * 0.14 * md + (vnoise(vec2(vWall.x * 1.3, vWall.y * 1.7) + bh) - 0.5) * 0.10;
          if ((flags & 16) != 0) { // brick courses with running bond
            vec2 bu = vec2(vWall.x / 0.23 + step(0.5, fract(vWall.y / 0.15)) * 0.5, vWall.y / 0.075);
            vec2 bf = fract(bu); vec2 bi = floor(bu);
            float mortar = smoothstep(0.0, 0.10, bf.x) * smoothstep(0.0, 0.14, bf.y) * smoothstep(1.0, 0.92, bf.x);
            wallC *= mix(1.0, (0.62 + 0.38 * mortar) * (0.86 + 0.28 * hash12(bi + bh)), md);
          } else if ((flags & 8) != 0) { // horizontal timber cladding
            float bd = fract(vWall.y / 0.13);
            wallC *= mix(1.0, 0.86 + 0.14 * smoothstep(0.0, 0.16, bd) * smoothstep(1.0, 0.86, bd), md);
          }
          if (style == 1 || style == 7) {
            // window surround: sill catch-light, lintel shadow, jamb shading, drip stains below the sill
            float sill = smoothstep(myb - 0.055, myb - 0.02, f.y) * (1.0 - smoothstep(myb - 0.02, myb, f.y)) * cover(f.x, mxm - 0.03, 1.0 - mxm + 0.03, fw.x);
            wallC *= 1.0 + 0.22 * sill * md;
            float sx = smoothstep(mxm - 0.02, mxm + 0.10, f.x) * (1.0 - smoothstep(1.0 - mxm - 0.10, 1.0 - mxm + 0.02, f.x));
            float below = (1.0 - smoothstep(0.0, max(myb - 0.02, 0.05), f.y)) * step(f.y, myb);
            float stain = sx * below * (0.35 + 0.65 * vnoise(vec2(vWall.x * 5.0 + bh, vWall.y * 0.5)));
            wallC *= 1.0 - (0.10 + 0.20 * uWet) * stain;
            // window reveal
            float lint = smoothstep(1.0 - myt - 0.075, 1.0 - myt, f.y) * (1.0 - smoothstep(1.0 - myt, 1.0 - myt + 0.02, f.y));
            wallC *= 1.0 - 0.28 * lint * sx;
            frame = max(frame, 0.0);
          }
          // slab line between floors
          wallC *= 1.0 - 0.06 * (1.0 - smoothstep(0.0, 0.05, f.y)) * md;
          // vertical rain streaks & grime (soft, height-driven; not tied to the window grid)
          float sn = vnoise(vec2(vWall.x * 2.9, vWall.y * 0.05) + bh) * 0.6 + vnoise(vec2(vWall.x * 8.3, vWall.y * 0.16) + bh * 2.0) * 0.4;
          float streak = smoothstep(0.5, 0.85, sn);
          wallC *= 1.0 - (0.10 + 0.22 * uWet) * streak;
          wallC *= mix(0.6, 1.0, smoothstep(-0.5, 3.5, vWall.y));       // ground grime / AO
          wallC *= 0.90 + 0.2 * vnoise(vWP.xz * 0.5 + vWP.y * 0.2);
          // plinth
          if (vWall.y < 0.0) wallC = vec3(0.09, 0.09, 0.085);
          // deep-set glass: darker at the top of the opening, faint mullion
          float recess = 0.75 + 0.25 * smoothstep(0.0, 0.5, 1.0 - (f.y - myb) / max(1.0 - myt - myb, 0.2));
          if (style == 1 || style == 7) { float mull = 1.0 - 0.7 * cover(f.x, 0.485, 0.515, fw.x); glassCol *= recess * mix(1.0, mull, md); }
          diffuseColor.rgb = mix(wallC, glassCol, clamp(inner * (vWall.y >= 0.0 ? 1.0 : 0.0), 0.0, 1.0));
          gGlass = inner * step(0.0, vWall.y);
          gRough = mix(mix(0.86, 0.55, uWet), 0.10, gGlass);
          gMetal = gGlass * 0.32;
          if (style == 2) { gRough = mix(0.30, 0.06, gGlass); gMetal = gGlass * 0.6; }
          if (style == 3) { gRough = mix(0.5, 0.05, gGlass); }
          // night emission
          float lightOn = step(cid * 0.999, litP * uLit) * gGlass;
          float kind = hash12(id + bh * 3.7 + 1.3);
          vec3 lc = kind < 0.55 ? vec3(1.0, 0.66, 0.36) : (kind < 0.85 ? vec3(0.95, 0.85, 0.65) : (kind < 0.95 ? vec3(0.65, 0.78, 1.0) : vec3(0.5, 0.6, 1.0)));
          if (style == 2 || style == 3 || style == 5) lc = mix(vec3(0.85, 0.92, 1.0), vec3(1.0, 0.85, 0.6), kind);
          gEmit = lc * lightOn * (0.7 + 0.9 * hash12(id + 9.1)) * (0.4 + 0.6 * step(0.12, f.x));
        } else {
          // roofs
          int rk = flags & 3;
          float nz = vnoise(vWP.xz * 0.9), nz2 = fbm(vWP.xz * 0.15);
          vec3 c = base;
          if (rk == 1 || rk == 2) {
            float course = fract(vWP.y * (rk == 1 ? 3.6 : 4.5));
            float line = smoothstep(0.0, 0.16, course) * smoothstep(1.0, 0.84, course);
            c *= 0.80 + 0.20 * line;
            c *= 0.75 + 0.5 * vnoise(vWP.xz * (rk == 1 ? 5.0 : 3.0) + vWP.y * 2.0);
            c *= 0.8 + 0.4 * nz2;
            gRough = mix(0.72, 0.30, uWet);
          } else {
            float gr = vnoise(vWP.xz * 6.0) * 0.6 + vnoise(vWP.xz * 17.0) * 0.4;
            c *= 0.88 + 0.24 * gr;
            c *= 0.94 + 0.12 * nz2;
            float pd = smoothstep(0.60, 0.70, fbm(vWP.xz * 0.21 + 7.0)) * uWet;
            c *= 1.0 - 0.30 * pd;
            gRough = mix(0.85, 0.5, uWet);
            gRough = mix(gRough, 0.04, pd);
            if (rk == 3) c = mix(c, vec3(0.08, 0.14, 0.05) * (0.7 + 0.6 * nz), 0.75);
          }
          diffuseColor.rgb = c;
        }
      `)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = gRough;
      `)
      .replace('#include <metalnessmap_fragment>', `
        float metalnessFactor = gMetal;
      `)
      .replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        totalEmissiveRadiance += gEmit;
      `);
  };
  return mat;
}

// ---------------------------------------------------------------- building generation
const DEFAULT_LEVELS = { house: 2, detached: 2, residential: 3, terrace: 3, semidetached_house: 2, apartments: 4, dormitory: 4, hotel: 5, commercial: 4, retail: 3, office: 5, university: 5, school: 3, civic: 3, public: 3, hospital: 5, church: 3, industrial: 2, warehouse: 2, garage: 1, garages: 1, parking: 3, service: 1, roof: 1, shed: 1, hut: 1, construction: 4, yes: 4 };

function chooseWall(r, type, area_) {
  const t = r();
  if (/house|detached|terrace|semi|residential/.test(type)) {
    if (t < 0.36) return [pick(r, WALL_WHITE), 'wood'];
    if (t < 0.55) return [pick(r, WALL_YELLOW), 'wood'];
    if (t < 0.72) return [pick(r, WALL_RED), 'wood'];
    if (t < 0.82) return [pick(r, WALL_PASTEL), 'wood'];
    if (t < 0.9) return [pick(r, WALL_GREY), 'x'];
    return [pick(r, WALL_BROWN), 'wood'];
  }
  if (/apartments|dormitory|hotel/.test(type)) {
    if (t < 0.28) return [pick(r, WALL_WHITE), 'x'];
    if (t < 0.5) return [pick(r, WALL_RED), 'x'];
    if (t < 0.7) return [pick(r, WALL_GREY), 'x'];
    if (t < 0.85) return [pick(r, WALL_YELLOW), 'x'];
    return [pick(r, WALL_PASTEL), 'x'];
  }
  if (/office|commercial|retail|university|school|civic|public|hospital|industrial|warehouse|parking|yes/.test(type)) {
    if (t < 0.36) return [pick(r, WALL_GREY), 'x'];
    if (t < 0.6) return [pick(r, WALL_WHITE), 'x'];
    if (t < 0.78) return [pick(r, WALL_RED), 'x'];
    if (t < 0.9) return [pick(r, WALL_YELLOW), 'x'];
    return [pick(r, WALL_PASTEL), 'x'];
  }
  return [pick(r, WALL_WHITE), 'x'];
}

export function buildCity(city, opts = {}) {
  const skipNames = opts.skipNames || ['Media City Bergen'];
  const chunks = new Map();
  const CH = 250;
  const getSb = (x, z) => { const k = Math.floor(x / CH) + ',' + Math.floor(z / CH); let s = chunks.get(k); if (!s) { s = new SoupBuilder(); chunks.set(k, s); } return s; };
  let made = 0, skipped = 0;
  const anchors = [];
  const heightCache = opts.heightAt || heightAt;

  for (const b of city.buildings) {
    if (skipNames.includes(b.n)) continue;
    let ring = simplify(b.p);
    if (ring.length < 3) continue;
    const A = Math.abs(area(ring));
    if (A < 6) continue;
    const [cx, cz] = centroid(ring);
    let hmin = 1e9, hmax = -1e9, hsum = 0;
    for (const q of ring) { const h = heightCache(q[0], q[1]); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h); hsum += h; }
    const hc = heightCache(cx, cz);
    if (hc < 0.45 || hmin < -2.5) { skipped++; continue; }
    const seed = Math.floor(Math.abs(cx * 73.1 + cz * 131.7)) + ring.length * 17;
    const r = mulberry(seed);
    const type = b.t || 'yes';
    const sb = getSb(cx, cz);
    // height
    let H = b.h || 0;
    let levels = b.l || 0;
    if (!H) {
      if (!levels) {
        levels = DEFAULT_LEVELS[type] || 3;
        if (type === 'yes') levels = A > 1400 ? 5 + Math.floor(r() * 2) : A > 450 ? 4 + Math.floor(r() * 2) : 3 + Math.floor(r() * 2);
        if (/house|detached|semi/.test(type)) levels = 2;
        if (/apartments/.test(type) && A < 200) levels = 3;
      }
      H = levels * 3.1 + 0.6;
    } else levels = Math.max(1, Math.round(H / 3.2));
    if (H < 3) H = 3;
    const base = hmin - 0.35;
    const ground = hsum / ring.length;
    const eave = Math.max(ground, hmin + 0.5) + H;
    // roof
    const isHouseish = /house|detached|terrace|semi|residential|apartments|yes|hotel|dormitory|school|church|civic|office/.test(type);
    let gabled = false;
    if (b.rs === 'gabled' || b.rs === 'hipped') gabled = true;
    else if (b.rs === 'flat') gabled = false;
    else if (isHouseish && A < 420 && levels <= 4) gabled = r() < 0.9;
    else if (isHouseish && A < 1300 && levels <= 6) gabled = r() < 0.5;
    if (type === 'church') gabled = true;
    const wallInfo = wallInfoFor(type, levels, A, r);
    const [wc, wk] = wallInfo.wall === undefined ? chooseWall(r, type, A) : wallInfo.wall;
    let wallHex = parseColour(b.c) || wc;
    if (b.c === 'black' || b.c === '#000000') wallHex = 0x2a2a2c;
    const wl = hexLin(wallHex);
    const hash8 = Math.floor(r() * 255);
    let roofKind = 0, roofHex;
    if (gabled) { if (r() < 0.72) { roofKind = 1; roofHex = pick(r, ROOF_TILE); } else { roofKind = 2; roofHex = pick(r, ROOF_SLATE); } }
    else { roofKind = r() < 0.06 ? 3 : 0; roofHex = roofKind === 3 ? pick(r, ROOF_GREEN) : pick(r, ROOF_FLAT); }
    if (b.rc) { const c = parseColour(b.rc); if (c) roofHex = c; }
    const rl = hexLin(roofHex);
    const shop = (levels >= 2 && /apartments|commercial|retail|yes|hotel|office/.test(type) && A > 150 && r() < (Math.hypot(cx + 200, cz + 500) < 700 ? 0.55 : 0.2)) ? 4 : 0;
    const isRed = WALL_RED.includes(wallHex);
    const flags = shop | (wk === 'wood' ? 8 : 0) | (isRed && wk !== 'wood' ? 16 : 0);
    const wmat = { col: wl, info: [Math.round(wallInfo.fh / 8 * 255), Math.round(wallInfo.ww / 8 * 255), Math.round(wallInfo.gx * 255), Math.round(wallInfo.gy * 255)], info2: [wallInfo.style, Math.round(wallInfo.lit * 255), hash8, flags & ~3 | 0] };
    const rmat = { col: rl, info: [128, 128, 0, 0], info2: [STYLE.ROOF, 0, hash8, roofKind] };

    emitBuilding(sb, ring, base, eave, gabled, wmat, rmat, r, b);
    if (A > 300 && !gabled) anchors.push([cx, cz, eave, A, type]);
    made++;
  }
  const group = new THREE.Group();
  const mat = makeCityMaterial();
  for (const [k, sb] of chunks) {
    const g = sb.build();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true; m.receiveShadow = true; m.matrixAutoUpdate = false;
    group.add(m);
  }
  group.userData.stats = { made, skipped, chunks: chunks.size };
  return { group, material: mat, anchors };
}

function wallInfoFor(type, levels, A, r) {
  const o = { fh: 3.1, ww: 2.6, gx: 0.42, gy: 0.5, style: STYLE.WINDOWS, lit: 0.55 };
  if (/house|detached|semi|terrace|residential/.test(type)) { o.fh = 2.9; o.ww = 2.4 + r() * 0.8; o.gx = 0.38 + r() * 0.1; o.gy = 0.5; o.lit = 0.5; }
  else if (/apartments|dormitory|hotel/.test(type)) { o.fh = 3.0 + r() * 0.2; o.ww = 2.7 + r() * 0.8; o.gx = 0.42 + r() * 0.12; o.gy = 0.52; o.lit = 0.6; }
  else if (/office|commercial|university|school|civic|public|hospital/.test(type)) {
    o.fh = 3.5 + r() * 0.3; o.ww = 3.0 + r() * 1.2; o.gx = 0.62 + r() * 0.3; o.gy = 0.55; o.lit = 0.35;
    if (r() < 0.3 && A > 700) { o.style = STYLE.CURTAIN; o.fh = 3.6; o.ww = 1.6 + r(); }
  } else if (/industrial|warehouse|garage|parking|service/.test(type)) { o.fh = 4.5; o.ww = 5; o.gx = 0.3; o.gy = 0.25; o.lit = 0.1; if (type === 'parking') { o.gx = 0.9; o.gy = 0.32; o.lit = 0.05; o.fh = 2.8; } }
  else { o.fh = 3.2; o.ww = 3.0; o.gx = 0.5; o.gy = 0.5; o.lit = 0.4; }
  return o;
}

function emitBuilding(sb, ring, base, eave, gabled, wmat, rmat, r, b) {
  // ensure ring orientation so walls face outward (shoelace(x,z) < 0)
  if (area(ring) > 0) ring = ring.slice().reverse();
  const n = ring.length;
  const ob = obb(ring);
  const ca = Math.cos(ob.ang), sa = Math.sin(ob.ang);
  const vc = (ob.v0 + ob.v1) / 2, w = (ob.v1 - ob.v0) / 2;
  const vOf = (x, z) => -x * sa + z * ca - vc;
  let slope = 0;
  if (gabled) slope = Math.min(0.72, 5.2 / Math.max(w, 2));
  const lift = (x, z) => (gabled ? Math.max(0, slope * (w - Math.abs(vOf(x, z)))) : 0);
  const y0 = base;
  // walls
  let u = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const segs = [[a, c, 0, 1]];
    if (gabled) {
      const da = vOf(a[0], a[1]), dc = vOf(c[0], c[1]);
      if (da * dc < 0) { const t = da / (da - dc); const m = [a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t]; segs.length = 0; segs.push([a, m, 0, t], [m, c, t, 1]); }
    }
    for (const [p, q, t0, t1] of segs) {
      const u0 = u + len * t0, u1 = u + len * t1;
      const yp = eave + lift(p[0], p[1]), yq = eave + lift(q[0], q[1]);
      const gb = hbase(base);
      sb.quad([p[0], y0, p[1]], [q[0], y0, q[1]], [q[0], yq, q[1]], [p[0], yp, p[1]], wmat,
        [u0, y0 - gb], [u1, y0 - gb], [u1, yq - gb], [u0, yp - gb]);
    }
    u += len;
  }
  // roof
  const contour = ring.map((p) => new THREE.Vector2(p[0], p[1]));
  const tris = THREE.ShapeUtils.triangulateShape(contour, []);
  for (const t of tris) {
    let list = [[ring[t[0]], ring[t[1]], ring[t[2]]]];
    if (gabled) list = clipTri(list[0], (p) => vOf(p[0], p[1]));
    for (const T of list) {
      const P = T.map((p) => [p[0], eave + lift(p[0], p[1]), p[1]]);
      sb.triUp(P[0], P[1], P[2], rmat);
    }
  }
  // rooftop details
  const A = Math.abs(area(ring));
  if (!gabled && A > 250) {
    const nb = A > 1500 ? 3 : A > 600 ? 2 : 1;
    const cm = { col: hexLin(0x6a6d70), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
    for (let i = 0; i < nb; i++) {
      const k = Math.floor(r() * n);
      const cx0 = (ring[k][0] + ring[(k + 1) % n][0] + ring[(k + 2) % n][0]) / 3, cz0 = (ring[k][1] + ring[(k + 1) % n][1] + ring[(k + 2) % n][1]) / 3;
      const mx = (cx0 * 2 + centroidOf(ring)[0]) / 3, mz = (cz0 * 2 + centroidOf(ring)[1]) / 3;
      if (!inside(mx, mz, ring)) continue;
      const bw = 1.6 + r() * 3.5, bd = 1.4 + r() * 2.5, bh = 1.0 + r() * 2.2;
      sb.box(mx, mz, bw, bd, eave, eave + bh, ob.ang + (r() < 0.3 ? 0.5 : 0), cm);
    }
  } else if (gabled && A < 500 && r() < 0.6) {
    const cm = { col: hexLin(pick(r, [0x8a4a3a, 0x77706a, 0x9a9690])), info: [128, 128, 0, 0], info2: [STYLE.PLAIN, 0, 0, 0] };
    const [ccx, ccz] = centroidOf(ring);
    const off = (r() - 0.5) * (ob.u1 - ob.u0) * 0.4;
    const px = ccx + off * ca, pz = ccz + off * sa;
    if (inside(px, pz, ring)) sb.box(px, pz, 0.7, 0.7, eave + slope * w * 0.55, eave + slope * w + 1.3, ob.ang, cm);
  }
}
const hbase = (b) => b + 0.35; // building ground plane for window/floor phase
function centroidOf(ring) { return centroid(ring); }
function inside(x, z, p) { let c = false; for (let i = 0, j = p.length - 1; i < p.length; j = i++) { if (((p[i][1] > z) !== (p[j][1] > z)) && (x < (p[j][0] - p[i][0]) * (z - p[i][1]) / (p[j][1] - p[i][1]) + p[i][0])) c = !c; } return c; }
