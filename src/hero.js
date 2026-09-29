import * as THREE from 'three';
import { SoupBuilder, STYLE, hexLin } from './builder.js';
import { heightAt } from './terrain.js';

const mat = (hex, info, info2) => ({ col: hexLin(hex), info, info2 });
const b8 = (v, s = 8) => Math.round(v / s * 255);

function octagon(cx, cz, R, rot = Math.PI / 8) {
  const pts = [];
  for (let i = 0; i < 8; i++) { const a = rot + i * Math.PI / 4; pts.push([cx + Math.cos(a) * R, cz + Math.sin(a) * R]); }
  return pts;
}
// x extent of polygon at a given z (mid of the two outermost crossings)
function midXAtZ(ring, z) {
  const xs = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if ((a[1] - z) * (b[1] - z) < 0) xs.push(a[0] + (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]));
  }
  xs.sort((p, q) => p - q);
  return xs.length >= 2 ? (xs[0] + xs[xs.length - 1]) / 2 : ring[0][0];
}

export function buildHero(cityData, cityMaterial) {
  const sb = new SoupBuilder();
  const mc = cityData.buildings.find((b) => b.n === 'Media City Bergen');
  const ring = mc.p;
  let hmin = 1e9; for (const q of ring) hmin = Math.min(hmin, heightAt(q[0], q[1]));
  const base = hmin - 0.4;
  const podH = 19.5;
  const podTop = base + podH;

  // --- podium: pale ribbed concrete with continuous ribbon windows
  const pod = mat(0xb9b5ab, [b8(3.9), b8(3.2), 200, 140], [STYLE.PODIUM, 150, 7, 0]);
  const podRoof = mat(0x3d3f42, [128, 128, 0, 0], [STYLE.ROOF, 0, 3, 0]);
  sb.prism(ring, base - 1.2, podTop, pod, true, podRoof, base);
  // parapet lip
  // podium plant on roof
  const plant = mat(0x7a7d80, [128, 128, 0, 0], [STYLE.PLAIN, 0, 0, 0]);
  sb.box(-8, 62, 9, 6, podTop, podTop + 2.4, 0.1, plant);
  sb.box(-14, -40, 12, 7, podTop, podTop + 2.0, 0.05, plant);
  sb.box(4, 5, 7, 5, podTop, podTop + 1.6, 0.0, plant);

  // --- three black octagonal towers (heights read from the photos: tall centre, small left, medium right)
  const towers = [
    { z: -14, R: 11.6, floors: 5, dishes: true },
    { z: 27, R: 13.2, floors: 10 },
    { z: 66, R: 11.9, floors: 7 },
  ];
  const fh = 3.55;
  for (const t of towers) {
    const cx = midXAtZ(ring, t.z) + 1.5;
    const oct = octagon(cx, t.z, t.R);
    const facet = 2 * t.R * Math.sin(Math.PI / 8);
    const blk = mat(0x111214, [b8(fh), b8(facet / 3), 220, 200], [STYLE.TOWER_BLACK, 200, Math.round(t.z * 3) & 255, 0]);
    const top = podTop + t.floors * fh;
    const roof = mat(0x2e3033, [128, 128, 0, 0], [STYLE.ROOF, 0, 5, 0]);
    sb.prism(oct, podTop - 0.5, top, blk, true, roof, podTop);
    // parapet ring (slightly wider, lighter)
    const par = mat(0x3a3c3f, [128, 128, 0, 0], [STYLE.PLAIN, 0, 0, 0]);
    sb.prism(octagon(cx, t.z, t.R + 0.25), top, top + 0.55, par, true, roof);
    // plant room
    sb.prism(octagon(cx, t.z, t.R * 0.52), top + 0.5, top + 3.4, plant, true, roof);
    sb.box(cx + t.R * 0.55, t.z - t.R * 0.2, 3.4, 2.4, top + 0.5, top + 2.1, 0.3, plant);
    if (t.dishes) {
      const white = mat(0xe4e6e8, [128, 128, 0, 0], [STYLE.PLAIN, 0, 0, 0]);
      for (let i = 0; i < 5; i++) {
        const a = i * 1.26 + 0.4, rr = t.R * 0.55;
        const dx = cx + Math.cos(a) * rr, dz = t.z + Math.sin(a) * rr;
        sb.prism(octagon(dx, dz, 1.35 + (i % 2) * 0.4), top + 0.5, top + 2.3 + (i % 3) * 0.5, white, true);
      }
    }
    if (t.floors === 10) {
      // antenna mast on the tall tower
      const steel = mat(0x8f9295, [128, 128, 0, 0], [STYLE.PLAIN, 0, 0, 0]);
      sb.prism(octagon(cx - 1.5, t.z + 1, 0.22), top + 3.3, top + 17, steel, true);
      sb.prism(octagon(cx - 1.5, t.z + 1, 0.55), top + 3.3, top + 6, steel, true);
    }
  }

  // --- twin lattice-clad towers north-east of the site (newer buildings not yet in OSM)
  const twin = [
    { x: 58, z: -152, w: 27, d: 21, floors: 12, rot: -0.62 },
    { x: 92, z: -190, w: 22, d: 19, floors: 9, rot: -0.62 },
  ];
  for (const t of twin) {
    const g0 = heightAt(t.x, t.z);
    const h = t.floors * 3.5;
    const lat = mat(0x9da29c, [b8(3.5), b8(3.2), 200, 160], [STYLE.LATTICE, 90, 40, 0]);
    const roof = mat(0x5a5d5f, [128, 128, 0, 0], [STYLE.ROOF, 0, 9, 0]);
    sb.box(t.x, t.z, t.w, t.d, g0 - 1, g0 + h, t.rot, lat, roof);
    sb.box(t.x + 2, t.z + 1, 8, 6, g0 + h, g0 + h + 2.4, t.rot, plant);
  }

  const g = sb.build();
  const mesh = new THREE.Mesh(g, cityMaterial);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const grp = new THREE.Group(); grp.add(mesh);
  return grp;
}
