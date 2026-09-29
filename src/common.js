import * as THREE from 'three';

// World convention: x = east, y = up, z = south (north is -z). Origin = Media City Bergen.
export const LAT0 = 60.3855, LON0 = 5.3330;
export const KX = 111320 * Math.cos(LAT0 * Math.PI / 180), KZ = 111200;

// ---- deterministic rng ------------------------------------------------------
export function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---- shared tileable noise texture (RGBA random, bilinear) ------------------
export function makeNoiseTexture(size = 256, seed = 7) {
  const r = mulberry(seed);
  const d = new Uint8Array(size * size * 4);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(r() * 256);
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// ---- global simulation state shared by everything ---------------------------
export const G = {
  time: 0,            // monotonic sim seconds (dt is clamped, so this never jumps)
  clock: 16.6,        // local clock hour (CEST)
  dayOfYear: 272,
  autoTime: 0,        // hours advanced per real second when > 0
  rain: 0.65,         // 0..1 rain intensity (smoothed toward target)
  wind: 0.65,         // 0..1 (mapped to m/s below)
  cover: 0.9,         // cloud cover 0..1
  targets: { rain: 0.65, wind: 0.65, cover: 0.9 },
  windDir: new THREE.Vector2(0.94, 0.34).normalize(), // direction wind blows TOWARD (WNW gale -> ESE)
  gust: 1,
  flash: 0, flashDir: new THREE.Vector3(0, 1, 0),
  night: 0, dayLevel: 1,
  sunDir: new THREE.Vector3(0, 1, 0), moonDir: new THREE.Vector3(0, 1, 0),
  sunElev: 30,
  fogColor: new THREE.Color(0.5, 0.55, 0.6),
  noise: null,
};

// gusting wind speed in m/s at world position (gusts sweep across the map)
export function windSpeed() { return 3 + G.wind * 21; }
export function gustAt(x, z, t = G.time) {
  const ph = (x * G.windDir.x + z * G.windDir.y) / 14; // gust front travels ~14 m/s
  const s = 0.5 * Math.sin((t - ph) * 0.41) + 0.3 * Math.sin((t - ph) * 0.97 + 2.0) + 0.2 * Math.sin((t - ph) * 2.3 + 1.0);
  return 1 + 0.5 * G.wind * s;
}
export function windAt(x, z, t = G.time) { return windSpeed() * gustAt(x, z, t); }

// ---- GLSL chunks ------------------------------------------------------------
export const GLSL_NOISE = /* glsl */`
uniform sampler2D uNoise;
float vnoise(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p);
  f = f*f*(3.0-2.0*f);
  vec2 uv = (i + f + 0.5) / 256.0;
  return texture2D(uNoise, uv).r;
}
float fbm(vec2 p){
  float a = 0.5, s = 0.0;
  for(int i=0;i<5;i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
float fbm3(vec2 p){
  float a = 0.5, s = 0.0;
  for(int i=0;i<3;i++){ s += a*vnoise(p); p = p*2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return s;
}
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx+33.33); return fract((p3.xx+p3.yz)*p3.zy); }
`;

// Same wave set on CPU and GPU so hulls sit on the surface.
// Each wave: dir angle (rad, relative to wind), wavelength, amplitude fraction, steepness
export const WAVES = [
  { a: 0.00, L: 52, A: 0.30, Q: 0.50 },
  { a: 0.30, L: 31, A: 0.22, Q: 0.55 },
  { a: -0.38, L: 19.3, A: 0.15, Q: 0.60 },
  { a: 0.62, L: 11.7, A: 0.10, Q: 0.65 },
  { a: -0.75, L: 7.3, A: 0.06, Q: 0.70 },
  { a: 0.12, L: 4.6, A: 0.035, Q: 0.70 },
  { a: -0.20, L: 2.9, A: 0.02, Q: 0.70 },
  { a: 0.95, L: 1.9, A: 0.01, Q: 0.70 },
];
// wave height scale (metres) depends on wind
export function waveScale() { return 0.10 + G.wind * G.wind * 2.6; }
// CPU twin of the shader's low-frequency phase warp (breaks up the regular sinusoid lattice)
export function vnoiseJS(x, z) {
  const d = G.noise.image.data;
  const ix = Math.floor(x), iz = Math.floor(z); let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const at = (i, j) => d[(((j & 255) * 256) + (i & 255)) * 4] / 255;
  return (at(ix, iz) * (1 - fx) + at(ix + 1, iz) * fx) * (1 - fz) + (at(ix, iz + 1) * (1 - fx) + at(ix + 1, iz + 1) * fx) * fz;
}
export function waveWarp(x, z) { return (vnoiseJS(x * 0.011 + 7.0, z * 0.011 + 7.0) - 0.5) * 2.2; }

// ---- height-aware fog + low cloud layer (shared by every lit material) --------
export const fogX = { value: new THREE.Vector4(1 / 260, 0, 320, 1) }; // x: 1/scale-height, y: cloud strength, z: cloud base (m), w: enabled
export function applyFog(sh) { sh.uniforms.uFogX = fogX; }
export function installFogChunks() {
  THREE.ShaderChunk.fog_pars_vertex = `#ifdef USE_FOG
  varying float vFogDepth; varying float vFogWY;
#endif`;
  THREE.ShaderChunk.fog_vertex = `#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWY = (transpose(mat3(viewMatrix)) * (mvPosition.xyz - viewMatrix[3].xyz)).y;
#endif`;
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
  uniform vec3 fogColor; varying float vFogDepth; varying float vFogWY; uniform vec4 uFogX;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear; uniform float fogFar;
  #endif
#endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor;
    if (uFogX.w > 0.5) {
      float fL = vFogDepth; float fk = uFogX.x;
      float yc = max(cameraPosition.y, 0.0), yf = max(vFogWY, 0.0);
      float avg = abs(yf - yc) < 0.5 ? exp(-fk * yc) : (exp(-fk * yc) - exp(-fk * yf)) / (fk * (yf - yc));
      float tau = fogDensity * 1.7 * fL * avg;
      float yavg = 0.5 * (yc + yf);
      float layer = smoothstep(uFogX.z - 90.0, uFogX.z + 30.0, yavg) * (1.0 - smoothstep(uFogX.z + 330.0, uFogX.z + 620.0, yavg));
      tau += uFogX.y * layer * fL * 0.0026;
      fogFactor = 1.0 - exp(-tau * tau * 0.8 - tau * 0.45);
    } else {
      fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
    }
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;
}
