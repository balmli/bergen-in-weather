import * as THREE from 'three';

// Compact triangle-soup builder. Attributes per vertex:
//  position f32x3, normal i8x4, color u8x4 (linear), aWall f32x2 (u along wall m, height above building base m),
//  aInfo u8x4 (floorH/8, winW/8, glazeX, glazeY), aInfo2 u8x4 (style, lit prob, hash, roofKind)
export const STYLE = { PLAIN: 0, WINDOWS: 1, TOWER_BLACK: 2, CURTAIN: 3, LATTICE: 4, PODIUM: 5, ROOF: 6, SHOP: 7 };

export function srgbToLinear(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
export function hexLin(hex) {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  return [srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)];
}

export class SoupBuilder {
  constructor() {
    this.pos = []; this.nor = []; this.col = []; this.wall = []; this.info = []; this.info2 = [];
  }
  get count() { return this.pos.length / 3; }
  // material record: {col:[r,g,b] linear, info:[fh,ww,gx,gy], info2:[style,lit,hash,roofKind]}
  tri(a, b, c, m, wa, wb, wc) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    const P = [a, b, c], W = [wa || [0, 0], wb || [0, 0], wc || [0, 0]];
    for (let i = 0; i < 3; i++) {
      this.pos.push(P[i][0], P[i][1], P[i][2]);
      this.nor.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127), 0);
      this.col.push(Math.round(Math.min(1, m.col[0]) * 255), Math.round(Math.min(1, m.col[1]) * 255), Math.round(Math.min(1, m.col[2]) * 255), 255);
      this.wall.push(W[i][0], W[i][1]);
      this.info.push(m.info[0], m.info[1], m.info[2], m.info[3]);
      this.info2.push(m.info2[0], m.info2[1], m.info2[2], m.info2[3]);
    }
  }
  // triangle forced to face upward (+y)
  triUp(a, b, c, m, wa, wb, wc) {
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (ny < 0) this.tri(a, c, b, m, wa, wc, wb); else this.tri(a, b, c, m, wa, wb, wc);
  }
  quad(a, b, c, d, m, wa, wb, wc, wd) { this.tri(a, b, c, m, wa, wb, wc); this.tri(a, c, d, m, wa, wc, wd); }

  // vertical prism over a polygon ring [x,z] CCW-in-(x,z) -> walls from y0 to y1, plus flat top (optional)
  prism(ring, y0, y1, m, top = true, topMat = null, wallBase = 0) {
    let ar = 0; for (let i = 0; i < ring.length; i++) { const q = ring[(i + 1) % ring.length]; ar += ring[i][0] * q[1] - q[0] * ring[i][1]; }
    if (ar > 0) ring = ring.slice().reverse(); // walls face outward when shoelace(x,z) < 0
    const n = ring.length; let u = 0;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], m,
        [u, y0 - wallBase], [u + len, y0 - wallBase], [u + len, y1 - wallBase], [u, y1 - wallBase]);
      u += len;
    }
    if (top) {
      const tm = topMat || m;
      const contour = ring.map((p) => new THREE.Vector2(p[0], p[1]));
      const tris = THREE.ShapeUtils.triangulateShape(contour, []);
      for (const t of tris) {
        const A = ring[t[0]], B = ring[t[1]], C = ring[t[2]];
        this.triUp([A[0], y1, A[1]], [B[0], y1, B[1]], [C[0], y1, C[1]], tm);
      }
    }
  }
  box(cx, cz, w, d, y0, y1, rot, m, topMat) {
    const c = Math.cos(rot), s = Math.sin(rot);
    const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c]);
    // ensure orientation matches prism() expectation (roofs face up): pts are consistently oriented by construction
    this.prism(pts, y0, y1, m, true, topMat);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(this.nor), 4, true));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(this.col), 4, true));
    g.setAttribute('aWall', new THREE.BufferAttribute(new Float32Array(this.wall), 2));
    g.setAttribute('aInfo', new THREE.BufferAttribute(new Uint8Array(this.info), 4, true));
    g.setAttribute('aInfo2', new THREE.BufferAttribute(new Uint8Array(this.info2), 4, true));
    g.computeBoundingBox(); g.computeBoundingSphere();
    return g;
  }
}
