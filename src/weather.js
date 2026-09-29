import * as THREE from 'three';
import { G, clamp, lerp, mulberry, smoothstep, windAt } from './common.js';
import { computeFetch } from './water.js';

const PRESETS = {
  clear: { rain: 0, wind: 0.22, cover: 0.18, storm: false },
  overcast: { rain: 0.0, wind: 0.34, cover: 0.86, storm: false },
  rain: { rain: 0.6, wind: 0.62, cover: 0.95, storm: false },
  storm: { rain: 1.0, wind: 1.0, cover: 1.0, storm: true },
};

const rainVert = /* glsl */`
attribute vec4 aRand;
uniform vec3 uCam; uniform vec3 uVol; uniform vec3 uVel; uniform float uTime; uniform float uLen; uniform float uWidth; uniform float uAlpha; uniform vec2 uRes;
varying float vA; varying vec2 vUv; varying float vFade;
void main(){
  // stateless drop position: falls with velocity, wraps in a camera-centred box
  vec3 base = aRand.xyz * uVol;
  vec3 v = uVel * (0.85 + 0.3 * aRand.w);
  vec3 p = base + v * uTime;
  p = mod(p - uCam + uVol * 0.5, uVol) - uVol * 0.5;
  vec3 head = uCam + p;
  vec3 dir = normalize(v);
  vec3 tail = head - dir * uLen * (0.7 + 0.6 * aRand.w) * length(v) * 0.02;
  float endv = position.y; // 0 tail, 1 head
  vec3 wp = mix(tail, head, endv);
  vec4 mvH = viewMatrix * vec4(head, 1.0);
  vec4 mvT = viewMatrix * vec4(tail, 1.0);
  vec4 mv = mix(mvT, mvH, endv);
  // width: perpendicular to streak in view space, at least ~1.1 px
  vec2 dv = (mvH.xy - mvT.xy);
  vec2 side = normalize(vec2(-dv.y, dv.x) + 1e-6);
  float depth = max(-mv.z, 0.1);
  float pxWorld = 2.0 * depth * tan(0.5 * radians(52.0)) / uRes.y;
  float w = max(uWidth, pxWorld * 1.15);
  mv.xy += side * position.x * w;
  vA = uAlpha * clamp(uWidth / w, 0.15, 1.0) * mix(0.5, 1.0, endv);
  vFade = 1.0 - smoothstep(0.7, 1.0, length(p / (uVol * 0.5)));
  gl_Position = projectionMatrix * mv;
}`;
const rainFrag = /* glsl */`
uniform vec3 uColor; varying float vA; varying float vFade;
void main(){ gl_FragColor = vec4(uColor, vA * vFade); }`;

const flowVert = /* glsl */`
attribute vec4 aRand; attribute float aT;
uniform vec3 uCam; uniform vec3 uVol; uniform vec2 uWind; uniform float uTime; uniform float uSpeed; uniform float uOn;
varying float vA;
vec3 pathAt(vec3 base, float t){
  float s = uSpeed;
  vec3 p = base + vec3(uWind.x, 0.0, uWind.y) * s * t;
  float along = dot(p.xz, uWind);
  p.y += sin(along * 0.05 + aRand.w * 6.28 + t * 0.6) * 2.4 + sin(along * 0.13 + aRand.z * 9.0) * 0.9;
  vec2 perp = vec2(-uWind.y, uWind.x);
  p.xz += perp * (sin(along * 0.037 + aRand.w * 11.0 + t * 0.4) * 5.0);
  return p;
}
void main(){
  vec3 base = aRand.xyz * uVol;
  float tt = uTime + aT * -1.6;
  vec3 p = pathAt(base, tt);
  // wrap each line as a whole using its head position so it stays contiguous
  vec3 headP = pathAt(base, uTime);
  vec3 off = mod(headP - uCam + uVol * 0.5, uVol) - uVol * 0.5 - (headP - uCam);
  vec3 wp = p + off;
  float d = length(wp - uCam);
  vA = uOn * (1.0 - aT) * (1.0 - smoothstep(uVol.x * 0.25, uVol.x * 0.5, d)) * smoothstep(3.0, 20.0, d) * 0.55;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}`;
const flowFrag = `varying float vA; void main(){ gl_FragColor = vec4(vec3(0.92), vA); }`;

export class Weather {
  constructor(scene, camera, renderer) {
    this.scene = scene; this.camera = camera; this.renderer = renderer;
    this.label = 'rain'; this.dirty = false; this.lightning = false; this.live = null;
    this.nextFlash = 12; this.flashT = -10; this.flowOn = false; this._flowFade = 0;
    this.rng = mulberry(99);
    const res = new THREE.Vector2(innerWidth, innerHeight);
    this.res = res;
    addEventListener('resize', () => res.set(innerWidth, innerHeight));
    // rain volumes: near (dense, fine) and mid (sparser, longer)
    this.rain = [];
    const mk = (n, vol, len, width, alpha) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0]), 3));
      g.setIndex([0, 1, 2, 1, 3, 2]);
      const r = new Float32Array(n * 4); const R = mulberry(5 + n);
      for (let i = 0; i < r.length; i++) r[i] = R();
      g.setAttribute('aRand', new THREE.InstancedBufferAttribute(r, 4));
      g.instanceCount = n;
      const mat = new THREE.ShaderMaterial({
        vertexShader: rainVert, fragmentShader: rainFrag, transparent: true, depthWrite: false,
        uniforms: {
          uCam: { value: new THREE.Vector3() }, uVol: { value: new THREE.Vector3(vol, vol * 0.7, vol) }, uVel: { value: new THREE.Vector3() },
          uTime: { value: 0 }, uLen: { value: len }, uWidth: { value: width }, uAlpha: { value: alpha }, uColor: { value: new THREE.Color() }, uRes: { value: res },
        },
      });
      const m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 10;
      scene.add(m);
      const o = { mesh: m, mat, n, base: n, alpha };
      this.rain.push(o); return o;
    };
    mk(26000, 34, 1.0, 0.0055, 0.55);
    mk(34000, 120, 1.5, 0.014, 0.30);
    mk(30000, 260, 2.4, 0.03, 0.12);
    // wind flow lines
    const lines = 700, segs = 14;
    const pos = new Float32Array(lines * segs * 2 * 3), rnd = new Float32Array(lines * segs * 2 * 4), tt = new Float32Array(lines * segs * 2);
    const R2 = mulberry(31); let k = 0;
    for (let i = 0; i < lines; i++) {
      const a = R2(), b = R2(), c = R2(), d = R2();
      for (let s = 0; s < segs; s++) for (let e = 0; e < 2; e++) {
        rnd[k * 4] = a; rnd[k * 4 + 1] = b; rnd[k * 4 + 2] = c; rnd[k * 4 + 3] = d;
        tt[k] = (s + e) / segs; k++;
      }
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    fg.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
    fg.setAttribute('aT', new THREE.BufferAttribute(tt, 1));
    this.flowMat = new THREE.ShaderMaterial({
      vertexShader: flowVert, fragmentShader: flowFrag, transparent: true, depthWrite: false,
      uniforms: { uCam: { value: new THREE.Vector3() }, uVol: { value: new THREE.Vector3(260, 60, 260) }, uWind: { value: new THREE.Vector2(1, 0) }, uTime: { value: 0 }, uSpeed: { value: 10 }, uOn: { value: 0 } },
    });
    this.flow = new THREE.LineSegments(fg, this.flowMat); this.flow.frustumCulled = false; this.flow.renderOrder = 11;
    scene.add(this.flow);
    this.preset('rain', true);
  }

  preset(name, instant = false) {
    if (name === 'live') { this.fetchLive(); return; }
    const p = PRESETS[name]; if (!p) return;
    this.label = name; this.live = null;
    G.targets.rain = p.rain; G.targets.wind = p.wind; G.targets.cover = p.cover; this.lightning = p.storm;
    if (instant) { G.rain = p.rain; G.wind = p.wind; G.cover = p.cover; }
    this.dirty = true;
  }
  setManual() { this.label = 'manual'; }

  async fetchLive() {
    this.label = 'live…';
    try {
      const r = await fetch('/met/weatherapi/locationforecast/2.0/compact?lat=60.3855&lon=5.333');
      const j = await r.json();
      const ts = j.properties.timeseries[0];
      const inst = ts.data.instant.details;
      const ws = inst.wind_speed, wdir = inst.wind_from_direction, cloud = inst.cloud_area_fraction;
      const pr = (ts.data.next_1_hours && ts.data.next_1_hours.details.precipitation_amount) || 0;
      const toward = (wdir + 180) * Math.PI / 180;
      G.windDir.set(Math.sin(toward), -Math.cos(toward)).normalize();
      computeFetch(Math.atan2(G.windDir.y, G.windDir.x));
      G.targets.wind = clamp((ws - 3) / 21, 0.05, 1);
      G.targets.cover = clamp(0.25 + cloud / 100 * 0.75, 0.2, 1);
      G.targets.rain = pr <= 0 ? 0 : clamp(0.18 + Math.log10(1 + pr * 3) * 0.75, 0.1, 1);
      this.lightning = pr > 4 && ws > 14;
      this.live = { ws, wdir, cloud, pr };
      this.label = `live bergen  ${ws.toFixed(0)} m/s from ${wdir.toFixed(0)}°  ${cloud.toFixed(0)}% cloud  ${pr.toFixed(1)} mm/h`;
      this.dirty = true;
    } catch (e) {
      console.warn('live weather unavailable', e);
      this.label = 'live unavailable – storm';
      this.preset('storm');
    }
  }
  setFlow(on) { this.flowOn = on; }

  step(dt) {
    const k = 1 - Math.exp(-dt / 5);
    const before = [G.rain, G.wind, G.cover];
    G.rain += (G.targets.rain - G.rain) * k; G.wind += (G.targets.wind - G.wind) * k; G.cover += (G.targets.cover - G.cover) * k;
    if (Math.abs(G.rain - before[0]) + Math.abs(G.wind - before[1]) + Math.abs(G.cover - before[2]) > 0.0008) this._acc = (this._acc || 0) + Math.abs(G.rain - before[0]) + Math.abs(G.wind - before[1]) + Math.abs(G.cover - before[2]);
    if ((this._acc || 0) > 0.03) { this.dirty = true; this._acc = 0; }
    // lightning: deterministic envelope from absolute time since the flash began
    if (this.lightning && G.rain > 0.5 && G.time > this.nextFlash) {
      this.flashT = G.time; this.nextFlash = G.time + 7 + this.rng() * 18;
      const a = this.rng() * Math.PI * 2, el = 0.25 + this.rng() * 0.5;
      G.flashDir.set(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el)).normalize();
    }
    const s = G.time - this.flashT;
    G.flash = s >= 0 && s < 0.9 ? (Math.exp(-s * 9) * 0.9 + (s > 0.16 ? Math.exp(-(s - 0.16) * 14) * 0.9 : 0)) * (0.7 + 0.3 * Math.sin(s * 80)) : 0;
    if (G.flash < 0.002) G.flash = 0;
  }

  update(dt, camera, L) {
    const wsp = 3 + G.wind * 21;
    const gust = windAt(camera.position.x, camera.position.z) / wsp;
    const wind = new THREE.Vector3(G.windDir.x, 0, G.windDir.y).multiplyScalar(wsp * gust * 0.8);
    const fall = 8.6 + 0.5 * G.rain;
    const vel = new THREE.Vector3(wind.x, -fall, wind.z);
    // drops streak against the sky: colour follows fog/sky luminance with a floor so night rain shows in lamp glow
    const col = G.fogColor.clone().multiplyScalar(1.5).addScalar(0.012 + 0.02 * G.night);
    const t = G.time % 200;
    for (const o of this.rain) {
      const u = o.mat.uniforms;
      u.uCam.value.copy(camera.position); u.uVel.value.copy(vel); u.uTime.value = t; u.uColor.value.copy(col);
      o.mesh.visible = G.rain > 0.02;
      const dens = clamp(G.rain * 1.15, 0, 1);
      o.mesh.geometry.instanceCount = Math.floor(o.n * dens * dens * 0.9 + o.n * dens * 0.1);
      u.uAlpha.value = o.alpha * (0.35 + 0.65 * dens);
    }
    // flow lines
    const target = this.flowOn ? 1 : 0;
    this._flowFade += (target - this._flowFade) * (1 - Math.exp(-dt * 3));
    const fu = this.flowMat.uniforms;
    this.flow.visible = this._flowFade > 0.01;
    fu.uOn.value = this._flowFade; fu.uCam.value.copy(camera.position); fu.uWind.value.copy(G.windDir); fu.uSpeed.value = wsp * gust * 0.9; fu.uTime.value = G.time % 500;
    fu.uVol.value.set(260, 70, 260);
  }
}
