import * as THREE from 'three';
import { G, clamp, lerp } from './common.js';
import { heightAt } from './terrain.js';

// Cinematic tour waypoints: [px,py,pz, tx,ty,tz, seconds to reach]
// Route: Google-style aerial of TV 2 Media City -> around the black towers -> Nygard & the pond
//        -> up Strandgaten to Vagen harbour, low over the sailboats -> back out over the city.
export const TOUR = [
  [-235, 132, 305, 5, 26, 10, 0],
  [-150, 118, 255, 5, 30, 12, 14],
  [-40, 100, 190, 0, 36, 10, 12],
  [95, 92, 120, -5, 38, 5, 11],
  [140, 84, 20, -8, 34, -5, 10],
  [95, 78, -95, -12, 30, -10, 11],
  [-10, 66, -215, -140, 12, -260, 12],
  [-150, 48, -330, -300, 4, -520, 12],
  [-270, 24, -430, -350, 2, -640, 11],
  [-355, 20, -560, -430, 6, -800, 10],
  [-455, 30, -790, -560, 4, -1050, 12],
  [-560, 16, -1000, -650, 2, -1300, 12],
  [-625, 10, -1150, -640, 2, -1420, 10],
  [-590, 45, -1230, -450, 24, -900, 11],
  [-400, 120, -1040, -200, 30, -400, 13],
  [-230, 170, -420, 5, 30, 10, 14],
];

export class CameraRig {
  constructor(camera, dom) {
    this.camera = camera; this.dom = dom;
    this.mode = 'tour';
    this.t = 0;
    this.pos = new THREE.Vector3(); this.yaw = 0; this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.speed = 40;
    this.keys = new Set();
    this.dragging = false; this.lastX = 0; this.lastY = 0;
    this.target = new THREE.Vector3();
    this.blend = 1; // blend between tour and free after switching
    this.loop = true;
    this.onMode = () => {};
    const posCurve = TOUR.map((w) => new THREE.Vector3(w[0], w[1], w[2]));
    const tgtCurve = TOUR.map((w) => new THREE.Vector3(w[3], w[4], w[5]));
    this.posSpline = new THREE.CatmullRomCurve3(posCurve, false, 'centripetal');
    this.tgtSpline = new THREE.CatmullRomCurve3(tgtCurve, false, 'centripetal');
    // cumulative time to param mapping (piecewise-uniform per segment, smoothstepped)
    this.times = []; let acc = 0; for (const w of TOUR) { acc += w[6]; this.times.push(acc); }
    this.total = acc;
    this.bind();
    this.applyTour(0);
  }
  tourParam(t) {
    // t in seconds -> spline u in [0,1] with smooth easing across each keyframe segment
    const n = TOUR.length - 1;
    let seg = 0; while (seg < n - 1 && t > this.times[seg + 1]) seg++;
    const t0 = this.times[seg], t1 = this.times[seg + 1];
    let f = clamp((t - t0) / Math.max(t1 - t0, 1e-3), 0, 1);
    // gentle ease only at very start/end, linear through the middle so the motion stays continuous
    const e = f;
    return (seg + e) / n;
  }
  applyTour(t) {
    const u = clamp(this.tourParam(t), 0, 1);
    this.posSpline.getPoint(u, this.camera.position);
    this.tgtSpline.getPoint(u, this.target);
    const hg = this.groundClear(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < hg) this.camera.position.y = hg;
    this.camera.updateMatrixWorld(true);
    this.camera.lookAt(this.target);
  }
  groundClear(x, z) { return Math.max(heightAt(x, z), 0) + 3.5; }
  bind() {
    const d = this.dom;
    addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'shift', ' ', 'control'].includes(k)) {
        this.keys.add(k); if (this.mode === 'tour') this.free();
        if (k.startsWith('arrow') || k === ' ') e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
    d.addEventListener('pointerdown', (e) => { this.dragging = true; this.lastX = e.clientX; this.lastY = e.clientY; d.setPointerCapture(e.pointerId); });
    d.addEventListener('pointerup', (e) => { this.dragging = false; });
    d.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const dx = e.clientX - this.lastX, dy = e.clientY - this.lastY; this.lastX = e.clientX; this.lastY = e.clientY;
      if (this.mode === 'tour' && Math.hypot(dx, dy) > 0) this.free();
      this.yaw -= dx * 0.0035; this.pitch = clamp(this.pitch - dy * 0.0035, -1.5, 1.5);
    });
    d.addEventListener('wheel', (e) => { e.preventDefault(); if (this.mode === 'tour') this.free(); this.speed = clamp(this.speed * Math.exp(-e.deltaY * 0.0015), 4, 600); }, { passive: false });
  }
  free() {
    if (this.mode === 'free') return;
    this.mode = 'free';
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y; this.pitch = e.x; this.pos.copy(this.camera.position); this.vel.set(0, 0, 0);
    this.onMode('free');
  }
  startTour(t = 0) {
    this.mode = 'tour'; this.t = t; this.onMode('tour');
  }
  setPose(px, py, pz, tx, ty, tz) {
    this.mode = 'free';
    const dx = tx - px, dy = ty - py, dz = tz - pz;
    this.yaw = Math.atan2(-dx, -dz); this.pitch = Math.atan2(dy, Math.hypot(dx, dz));
    this.pos.set(px, py, pz); this.vel.set(0, 0, 0);
    this.camera.position.copy(this.pos); this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld(true);
    this.onMode('free');
  }
  update(dt) {
    if (this.mode === 'tour') {
      this.t += dt;
      if (this.t > this.total) { if (this.loop) this.t = 0; else { this.free(); return; } }
      this.applyTour(this.t);
      return;
    }
    const k = this.keys;
    const fwd = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = new THREE.Vector3();
    if (k.has('w') || k.has('arrowup')) wish.add(fwd);
    if (k.has('s') || k.has('arrowdown')) wish.sub(fwd);
    if (k.has('d') || k.has('arrowright')) wish.add(right);
    if (k.has('a') || k.has('arrowleft')) wish.sub(right);
    if (k.has('e') || k.has(' ')) wish.y += 1;
    if (k.has('q') || k.has('control')) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize();
    const sp = this.speed * (k.has('shift') ? 4 : 1);
    // critically-damped velocity follow (frame-rate independent)
    const a = 1 - Math.exp(-dt * 6);
    this.vel.lerp(wish.multiplyScalar(sp), a);
    this.pos.addScaledVector(this.vel, dt);
    const gmin = this.groundClear(this.pos.x, this.pos.z);
    if (this.pos.y < gmin) { this.pos.y = gmin; if (this.vel.y < 0) this.vel.y = 0; }
    this.pos.y = Math.min(this.pos.y, 3000);
    this.camera.position.copy(this.pos);
    // storm shake at low altitude
    const shake = G.wind * G.wind * 0.02 * (1 - clamp((this.pos.y - 10) / 80, 0, 1));
    const sx = Math.sin(G.time * 13.1) * shake, sy = Math.sin(G.time * 17.3 + 1) * shake;
    this.camera.rotation.set(this.pitch + sy, this.yaw + sx, 0, 'YXZ');
  }
}
