import * as THREE from 'three';
import { G, GLSL_NOISE, clamp, lerp, smoothstep } from './common.js';

const LAT = 60.39 * Math.PI / 180;
const rad = Math.PI / 180;

// Sun / moon position for Bergen. Local clock is CEST (UTC+2); solar noon ~13:29 in late September.
export function solarPosition(clock, doy) {
  const decl = -23.44 * rad * Math.cos(2 * Math.PI / 365 * (doy + 10));
  const eot = 9.87 * Math.sin(2 * 2 * Math.PI * (doy - 81) / 364) - 7.53 * Math.cos(2 * Math.PI * (doy - 81) / 364) - 1.5 * Math.sin(2 * Math.PI * (doy - 81) / 364); // minutes
  const solar = clock - 2 + 5.333 / 15 * 1 * -1 + eot / 60 + 5.333 / 15 * 0; // -> UTC hour approx
  const solarTime = (clock - 2) + 5.333 / 15 + eot / 60;                  // local apparent solar time
  const H = (solarTime - 12) * 15 * rad;
  const sinE = Math.sin(LAT) * Math.sin(decl) + Math.cos(LAT) * Math.cos(decl) * Math.cos(H);
  const el = Math.asin(clamp(sinE, -1, 1));
  let az = Math.acos(clamp((Math.sin(decl) - sinE * Math.sin(LAT)) / (Math.cos(el) * Math.cos(LAT) + 1e-6), -1, 1));
  if (H > 0) az = 2 * Math.PI - az; // afternoon: west of south
  return { el, az, decl, H };
}
export function dirFromAzEl(az, el, out = new THREE.Vector3()) {
  // azimuth from north clockwise; x=east, z=south  => north = -z
  return out.set(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}
function moonPosition(H, decl, elongDeg, doy) {
  const Hm = H - elongDeg * rad;
  const dm = (16 + 10 * Math.sin(doy * 0.23)) * rad;
  const sinE = Math.sin(LAT) * Math.sin(dm) + Math.cos(LAT) * Math.cos(dm) * Math.cos(Hm);
  const el = Math.asin(clamp(sinE, -1, 1));
  let az = Math.acos(clamp((Math.sin(dm) - sinE * Math.sin(LAT)) / (Math.cos(el) * Math.cos(LAT) + 1e-6), -1, 1));
  if (Hm > 0) az = 2 * Math.PI - az;
  return { el, az };
}

// keyframes by sun elevation (deg): zenith, horizon (linear radiance), sun light colour, sun light strength
const KF = [
  [-20, [0.004, 0.007, 0.018], [0.010, 0.014, 0.030], [0.4, 0.5, 1.0], 0.0],
  [-9,  [0.010, 0.020, 0.052], [0.055, 0.060, 0.100], [0.5, 0.5, 0.9], 0.0],
  [-4,  [0.030, 0.058, 0.140], [0.330, 0.215, 0.230], [1.0, 0.45, 0.30], 0.05],
  [0,   [0.090, 0.150, 0.330], [0.800, 0.400, 0.250], [1.0, 0.50, 0.28], 0.25],
  [4,   [0.140, 0.240, 0.500], [0.900, 0.600, 0.420], [1.0, 0.62, 0.38], 0.55],
  [10,  [0.180, 0.320, 0.640], [0.780, 0.700, 0.620], [1.0, 0.76, 0.56], 0.80],
  [25,  [0.170, 0.340, 0.760], [0.640, 0.760, 0.900], [1.0, 0.88, 0.75], 1.0],
  [60,  [0.140, 0.320, 0.760], [0.600, 0.760, 0.920], [1.0, 0.94, 0.86], 1.0],
];
function keyframe(el) {
  el = clamp(el, KF[0][0], KF[KF.length - 1][0]);
  let i = 0; while (i < KF.length - 2 && el > KF[i + 1][0]) i++;
  const a = KF[i], b = KF[i + 1];
  const t = smoothstep(a[0], b[0], el);
  const mix3 = (u, v) => new THREE.Color(lerp(u[0], v[0], t), lerp(u[1], v[1], t), lerp(u[2], v[2], t));
  return { zenith: mix3(a[1], b[1]), horizon: mix3(a[2], b[2]), sun: mix3(a[3], b[3]), strength: lerp(a[4], b[4], t) };
}

const skyVert = /* glsl */`
varying vec3 vDir;
void main(){
  vec4 wp = modelMatrix * vec4(position,1.0);
  vDir = wp.xyz - cameraPosition;
  vec4 p = projectionMatrix * viewMatrix * wp;
  gl_Position = p.xyww;
}`;

const skyFrag = /* glsl */`
precision highp float;
varying vec3 vDir;
uniform vec3 uSunDir, uMoonDir, uZenith, uHorizon, uSunCol, uGround;
uniform vec3 uCloudLit, uCloudDark, uCamPos;
uniform float uCover, uStorm, uNight, uTime, uDisc, uMoonVis, uSunVis, uSunIntensity, uGlow, uFlash;
uniform vec2 uWind;
uniform vec3 uFlashDir;
${GLSL_NOISE}

float cloudField(vec2 p, float t){
  vec2 q = p + uWind * t;
  float base = fbm(q * 0.0011);
  float det = vnoise(q * 0.0085 + 3.0) * 0.5 + vnoise(q * 0.021 + 9.0) * 0.25;
  return base * 0.78 + det * 0.22 * (0.4 + uStorm * 0.8);
}

void main(){
  vec3 dir = normalize(vDir);
  float h = dir.y;
  // ---- clear-sky gradient
  float hz = pow(clamp(1.0 - max(h, 0.0), 0.0, 1.0), 4.5);
  vec3 sky = mix(uZenith, uHorizon, hz);
  // sunset warm glow toward sun azimuth (Mie-ish)
  float sd = max(dot(dir, uSunDir), 0.0);
  vec3 glowCol = uSunCol * (pow(sd, 6.0) * 0.55 + pow(sd, 40.0) * 0.9) * uGlow * (1.0 - hz * 0.3);
  sky += glowCol * (1.0 - uCover * 0.75);
  // dark storm sky tint
  vec3 grey = vec3(dot(sky, vec3(0.333)));
  sky = mix(sky, grey * mix(0.9, 0.55, uStorm), uCover * 0.55);
  if (h < 0.0) { sky = mix(sky, uGround, smoothstep(0.0, -0.25, h)); }

  vec3 col = sky;

  // ---- stars
  if (uNight > 0.02) {
    vec3 q = dir * 220.0;
    vec3 c = floor(q);
    vec3 f = fract(q) - 0.5;
    float r = hash12(c.xy * 1.31 + c.z * 17.7);
    vec2 o = hash22(c.xz + c.y * 7.1) - 0.5;
    float d = length(f.xy - o.xy * 0.7);
    float star = step(0.9935, r) * smoothstep(0.32, 0.0, d) * (0.3 + 1.6 * hash12(c.yz + 4.0));
    col += vec3(0.85, 0.9, 1.0) * star * uNight * (1.0 - uCover) * smoothstep(0.0, 0.15, h) * 0.9;
  }

  // ---- moon (procedural disc, correct phase from sun direction)
  float md = dot(dir, uMoonDir);
  float moonR = 0.0115;
  if (md > 0.9996 && uMoonVis > 0.0) {
    vec3 up = abs(uMoonDir.y) < 0.99 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
    vec3 right = normalize(cross(up, uMoonDir));
    vec3 upv = cross(uMoonDir, right);
    vec3 rel = dir - uMoonDir * md;
    vec2 uv = vec2(dot(rel, right), dot(rel, upv)) / (moonR * md);
    float rr = length(uv);
    float edge = smoothstep(1.02, 0.97, rr);
    if (edge > 0.0) {
      float z = sqrt(max(1.0 - rr*rr, 0.0));
      vec3 n = normalize(right * uv.x + upv * uv.y - uMoonDir * z);
      float lit = smoothstep(-0.04, 0.10, dot(n, uSunDir));
      vec2 mp = uv * 3.2 + vec2(4.0, 1.0);
      float maria = smoothstep(0.42, 0.62, fbm(mp));
      float crat = vnoise(uv * 22.0) * 0.5 + vnoise(uv * 47.0) * 0.3;
      float alb = 0.78 - 0.32 * maria - 0.10 * crat;
      alb *= 0.65 + 0.35 * z;                      // limb darkening
      vec3 mc = vec3(0.98, 0.96, 0.90) * alb * (lit + 0.025) * 2.1;
      col = mix(col, mc + col * 0.15, edge * uMoonVis);
    }
  }
  // moon glow
  col += vec3(0.55, 0.62, 0.8) * pow(max(md, 0.0), 260.0) * 0.10 * uMoonVis * (1.0 - uCover * 0.4);

  // ---- sun disc
  if (uDisc > 0.5) {
    float sdisc = smoothstep(0.99998, 0.999985, sd);
    col += uSunCol * sdisc * 60.0 * uSunVis;
    col += uSunCol * pow(sd, 900.0) * 1.6 * uSunVis;
  }

  // ---- clouds: two layers projected on planes, lit by sun via density gradient
  float cloudA = 0.0, silver = 0.0;
  vec3 cloudCol = vec3(0.0);
  if (h > -0.02) {
    float hh = max(h, 0.012);
    // low, thick layer
    float t1 = 1700.0 / hh;
    vec2 p1 = uCamPos.xz + dir.xz * t1;
    float n1 = cloudField(p1, uTime);
    float thr = mix(0.62, 0.30, uCover);
    float a1 = smoothstep(thr, thr + mix(0.10, 0.34, uCover), n1);
    // gradient toward the sun gives self-shadowing
    vec2 sdir = normalize(uSunDir.xz + 1e-4) * (110.0 + 200.0 * (1.0 - uSunDir.y));
    float n1s = cloudField(p1 + sdir, uTime);
    float shade = clamp(0.55 + (n1 - n1s) * 5.5, 0.0, 1.0);
    shade = mix(shade, 0.5, uCover * 0.55);
    // darker, denser base where density is high (storm)
    float dens = smoothstep(thr, thr + 0.5, n1);
    vec3 c1 = mix(uCloudDark, uCloudLit, shade);
    c1 = mix(c1, uCloudDark * 0.7, dens * uStorm * 0.7);
    // high thin cirrus
    float t2 = 7000.0 / hh;
    vec2 p2 = (uCamPos.xz + dir.xz * t2) * vec2(1.0, 2.2);
    float n2 = fbm3(p2 * 0.00035 + uWind * uTime * 0.0006);
    float a2 = smoothstep(0.52, 0.85, n2) * 0.55 * (1.0 - uCover * 0.6);
    vec3 c2 = mix(uCloudLit, uHorizon, 0.4);
    cloudA = 1.0 - (1.0 - a1) * (1.0 - a2);
    cloudCol = (c1 * a1 + c2 * a2 * (1.0 - a1)) / max(cloudA, 1e-4);
    // fade toward horizon haze
    float fadeH = smoothstep(0.0, 0.16, h);
    cloudA *= fadeH;
    cloudCol = mix(uHorizon * 0.9, cloudCol, mix(fadeH, 1.0, 0.0));
    // silver lining / light bleeding around sun and moon through thin cloud
    float thin = (1.0 - a1) * a1 * 4.0;
    silver = (pow(sd, 10.0) * uSunVis * 0.9 + pow(max(md, 0.0), 40.0) * uMoonVis * 0.25);
    cloudCol += uSunCol * silver * (0.25 + thin) * 0.9 * (1.0 - uStorm * 0.5);
    // lightning
    if (uFlash > 0.001) {
      float fd = max(dot(dir, uFlashDir), 0.0);
      cloudCol += vec3(0.75, 0.82, 1.0) * uFlash * (0.5 + 4.0 * pow(fd, 6.0)) * (0.5 + dens);
    }
  }
  // sun/moon seen through cloud: dim by cloud alpha (moon "almost" visible through veil)
  vec3 behind = col;
  col = mix(behind, cloudCol, cloudA * mix(1.0, 0.94, 1.0 - uCover));
  // horizon haze so distant sea/terrain blends seamlessly
  col = mix(col, uHorizon * (0.9 + 0.1 * (1.0 - uCover)), smoothstep(0.045, 0.0, abs(h)) * 0.6 * step(-0.02, h));

  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor() {
    this.uniforms = {
      uNoise: { value: G.noise },
      uSunDir: { value: G.sunDir }, uMoonDir: { value: G.moonDir },
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
      uSunCol: { value: new THREE.Color() }, uGround: { value: new THREE.Color(0.05, 0.05, 0.05) },
      uCloudLit: { value: new THREE.Color() }, uCloudDark: { value: new THREE.Color() },
      uCamPos: { value: new THREE.Vector3() },
      uCover: { value: 0.5 }, uStorm: { value: 0 }, uNight: { value: 0 }, uTime: { value: 0 },
      uDisc: { value: 1 }, uMoonVis: { value: 1 }, uSunVis: { value: 1 }, uSunIntensity: { value: 1 }, uGlow: { value: 1 },
      uFlash: { value: 0 }, uFlashDir: { value: G.flashDir },
      uWind: { value: new THREE.Vector2() },
    };
    const geo = new THREE.SphereGeometry(1, 48, 24);
    this.material = new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: this.uniforms, side: THREE.BackSide, depthWrite: false, depthTest: false });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -100;
    // environment scene (no sun disc; captured into PMREM)
    const envU = Object.assign({}, this.uniforms, { uDisc: { value: 0 } });
    this.envMesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: skyVert, fragmentShader: skyFrag, uniforms: envU, side: THREE.BackSide, depthWrite: false, depthTest: false }));
    this.envMesh.frustumCulled = false;
    this.envScene = new THREE.Scene(); this.envScene.add(this.envMesh);
    this.light = { sunColor: new THREE.Color(), sunIntensity: 0, moonIntensity: 0, skyL: 0.3, ambientTint: new THREE.Color() };
  }

  update(camera) {
    const u = this.uniforms;
    const sp = solarPosition(G.clock, G.dayOfYear);
    dirFromAzEl(sp.az, sp.el, G.sunDir);
    const elDeg = sp.el / rad;
    G.sunElev = elDeg;
    const mp = moonPosition(sp.H, sp.decl, 108, G.dayOfYear);
    dirFromAzEl(mp.az, mp.el, G.moonDir);
    const moonEl = mp.el / rad;

    const kf = keyframe(elDeg);
    const cover = G.cover;
    const storm = clamp((G.cover - 0.55) * 2.0, 0, 1) * clamp(0.3 + G.rain * 0.8 + G.wind * 0.3, 0, 1);
    const night = 1 - smoothstep(-14, -3, elDeg);
    G.night = night;
    // cloud colours: bright grey on overcast, dark slate in storm; tinted by low sun
    const dayAmt = smoothstep(-6, 8, elDeg);
    const sunTint = kf.sun.clone();
    const litClear = sunTint.clone().multiplyScalar(1.05 * (0.25 + 0.75 * dayAmt) + 0.03);
    const darkClear = kf.horizon.clone().lerp(kf.zenith, 0.4).multiplyScalar(0.6);
    const skyLum = 0.2126 * kf.zenith.r + 0.7152 * kf.zenith.g + 0.0722 * kf.zenith.b;
    const skyF = Math.pow(smoothstep(-8, 24, elDeg), 1.6);
    const overLum = (0.14 + 0.42 * skyF) * (1 - storm * 0.55) + 0.004 * (1 - skyF);
    const overLit = new THREE.Color(0.94, 0.97, 1.0).multiplyScalar(overLum * 1.25);
    const overDark = new THREE.Color(0.80, 0.88, 1.0).multiplyScalar(overLum * 0.55);
    // sunset underlighting at low sun on broken cloud
    const duskGlow = smoothstep(14, 0, Math.abs(elDeg - 1)) * (1 - cover * 0.6) * dayAmt;
    u.uCloudLit.value.copy(litClear).lerp(overLit, cover).lerp(new THREE.Color(1.0, 0.5, 0.3).multiplyScalar(0.9), duskGlow * 0.5);
    u.uCloudDark.value.copy(darkClear).lerp(overDark, cover);
    // night: moon-tinted clouds
    const moonUp = smoothstep(-4, 8, moonEl);
    const nightCloud = new THREE.Color(0.012, 0.016, 0.03).multiplyScalar(1 + moonUp * 2.4);
    u.uCloudLit.value.lerp(nightCloud.clone().multiplyScalar(1.6), night);
    u.uCloudDark.value.lerp(nightCloud.clone().multiplyScalar(0.7), night);
    // urban light pollution warms the underside at night
    u.uCloudLit.value.lerp(new THREE.Color(0.05, 0.03, 0.02), night * cover * 0.35);

    u.uZenith.value.copy(kf.zenith); u.uHorizon.value.copy(kf.horizon);
    u.uSunCol.value.copy(kf.sun);
    u.uGlow.value = 0.35 + 0.65 * smoothstep(12, 0, elDeg) + 0.2 * smoothstep(-10, 0, elDeg);
    u.uCover.value = cover; u.uStorm.value = storm; u.uNight.value = night; u.uTime.value = G.time;
    u.uMoonVis.value = smoothstep(-2, 3, moonEl) * (0.35 + 0.65 * night);
    u.uSunVis.value = smoothstep(-2, 2, elDeg);
    u.uWind.value.set(G.windDir.x, G.windDir.y).multiplyScalar(6 + G.wind * 26);
    u.uFlash.value = G.flash; G.flashDir && u.uFlashDir.value.copy(G.flashDir);
    u.uCamPos.value.copy(camera.position);
    this.mesh.position.copy(camera.position);
    this.mesh.scale.setScalar(camera.far * 0.9);
    u.uGround.value.copy(kf.horizon).multiplyScalar(0.28);

    // ---- lighting summary consumed by main lights, fog, exposure
    const L = this.light;
    const sunPow = kf.strength * (1 - cover * 0.93) * smoothstep(-1.5, 2.5, elDeg);
    L.sunIntensity = 6.2 * sunPow;
    L.sunColor.copy(kf.sun);
    const moonPow = smoothstep(-3, 10, moonEl) * night * (1 - cover * 0.85);
    L.moonIntensity = 0.5 * moonPow;
    // apparent sky radiance (for exposure): clear sky vs overcast
    const clearL = 0.2126 * kf.horizon.r + 0.7152 * kf.horizon.g + 0.0722 * kf.horizon.b;
    const overcastL = overLum;
    L.skyL = lerp(clearL * 0.8 + skyLum * 0.4, overcastL, cover) + 0.006;
    G.dayLevel = L.skyL + L.sunIntensity * Math.max(Math.sin(sp.el), 0) / Math.PI * 0.5;
    // fog colour follows horizon, dimmed by rain (grey haze)
    const fog = kf.horizon.clone();
    const g = fog.r * 0.3 + fog.g * 0.59 + fog.b * 0.11;
    fog.lerp(new THREE.Color(g, g, g * 1.04), cover * 0.75);
    fog.lerp(overLit.clone().multiplyScalar(0.85), cover * 0.6);
    fog.multiplyScalar(1 - 0.28 * storm);
    G.fogColor.copy(fog);
  }
}
