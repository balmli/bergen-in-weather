import * as THREE from 'three';
import { G, makeNoiseTexture, clamp, lerp, smoothstep, installFogChunks, fogX } from './common.js';
import { Sky } from './sky.js';
import { loadDEM, registerPonds, paintGround, makeTerrain, heightAt } from './terrain.js';
import { buildCity, cityUniforms } from './city.js';
import { buildHero } from './hero.js';
import { makeSea, makePonds, updateWaterUniforms, computeFetch, waterUniforms } from './water.js';
import { Boats } from './boats.js';
import { People } from './people.js';
import { Trees } from './trees.js';
import { Cars, Trams, Lamps } from './traffic.js';
import { Life } from './life.js';
import { Spray } from './spray.js';
import { CameraRig } from './camera.js';
import { makePost } from './post.js';
import { initUI } from './ui.js';
import { Weather } from './weather.js';

const $ = (id) => document.getElementById(id);
const setLoad = (t) => { const e = $('loadtxt'); if (e) e.textContent = t; };
const params = new URLSearchParams(location.search);

async function main() {
  installFogChunks();
  const canvas = $('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('shot') });
  renderer.setPixelRatio(Math.min(devicePixelRatio, params.has('pr') ? +params.get('pr') : 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.7;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  G.noise = makeNoiseTexture(256, 11);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x8899aa, 0.0002);
  const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.5, 30000);
  scene.add(camera);

  setLoad('LOADING TERRAIN');
  await loadDEM();
  setLoad('LOADING MAP DATA');
  const city = await (await fetch('/city.json')).json();
  registerPonds(city.water);

  setLoad('PAINTING STREETS');
  await new Promise((r) => setTimeout(r, 30));
  const ground = {
    fine: paintGround(city, [-1000, -1400, 800, 400], 4096, { extras: [{ c: '#8a8579', p: [[80, -175], [300, -150], [335, 60], [305, 150], [92, 112]] }, { c: '#6f7064', p: [[110, -250], [230, -240], [250, -160], [100, -170]] }] }),
    coarse: paintGround(city, [-2600, -2900, 2200, 1900], 2048, { base: '#6e706d' }),
  };
  const terrain = makeTerrain(ground);
  scene.add(terrain);

  setLoad('RAISING BUILDINGS');
  await new Promise((r) => setTimeout(r, 30));
  const cityRes = buildCity(city);
  scene.add(cityRes.group);
  scene.add(buildHero(city, cityRes.material));
  console.log('city', cityRes.group.userData.stats);

  setLoad('FILLING THE FJORD');
  await new Promise((r) => setTimeout(r, 30));
  computeFetch(Math.atan2(G.windDir.y, G.windDir.x));
  const sea = makeSea(); scene.add(sea);
  scene.add(makePonds());
  updateWaterUniforms();
  const boats = new Boats(scene, cityRes.material, waterUniforms);
  const people = new People(scene, city, 650);
  setLoad('PLANTING TREES'); await new Promise((r) => setTimeout(r, 30));
  const trees = new Trees(scene, city);
  console.log('trees', trees.count);
  const cars = new Cars(scene, city, 240);
  const trams = new Trams(scene, city, cityRes.material);
  const lamps = new Lamps(scene, city, (x, z) => trees.occF.get(x, z));
  const life = new Life(scene, city, cityRes.anchors);
  const spray = new Spray(scene);

  // sky + lights
  const sky = new Sky(); scene.add(sky.mesh);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.35;
  scene.add(sun); scene.add(sun.target);
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0);
  scene.add(moon);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT = null, envAcc = 99;

  const rig = new CameraRig(camera, canvas);
  const weather = new Weather(scene, camera, renderer);
  const post = makePost(renderer, scene, camera);
  const ui = initUI({ rig, weather, G, params });
  if (window.__extra) await window.__extra({ scene, camera, city, renderer, weather });

  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
    post.resize(innerWidth, innerHeight);
  });
  post.resize(innerWidth, innerHeight);

  // URL params for repeatable screenshots
  if (params.has('t')) G.clock = +params.get('t');
  if (params.has('rain')) { G.rain = G.targets.rain = +params.get('rain'); }
  if (params.has('wind')) { G.wind = G.targets.wind = +params.get('wind'); }
  if (params.has('cover')) { G.cover = G.targets.cover = +params.get('cover'); }
  if (params.has('cam')) { const c = params.get('cam').split(',').map(Number); rig.setPose(...c); }
  if (params.has('tour')) rig.startTour(+params.get('tour'));
  if (params.get('ui') === '0') document.body.classList.add('noui');

  const app = { cars, trams, lamps, life, trees, people, boats, scene, camera, renderer, rig, weather, sky, sun, moon, post, G, terrain, sea, city: cityRes, cityData: city, THREE };
  window.__sim = app;
  // review helper: pose the camera / weather, let things settle, then POST a JPEG to ./shots via the dev server
  window.__shot = async (name, o = {}) => {
    if (o.cam) rig.setPose(...o.cam);
    if (o.t != null) G.clock = o.t;
    for (const k of ['rain', 'wind', 'cover']) if (o[k] != null) { G[k] = G.targets[k] = o[k]; }
    if (o.rain != null || o.wind != null) weather.dirty = true;
    if (o.time != null) G.time = o.time;
    await new Promise((r) => setTimeout(r, o.wait || 1800));
    // render offscreen-sized so shots are identical regardless of the browser pane
    const W = o.w || 1600, H = o.h || 900;
    const oldPR = renderer.getPixelRatio();
    renderer.setPixelRatio(1); renderer.setSize(W, H, false); camera.aspect = W / H; camera.updateProjectionMatrix(); post.resize(W, H);
    await new Promise((r) => setTimeout(r, 900));
    post.composer.render(0.016);
    const url = renderer.domElement.toDataURL('image/jpeg', 0.93);
    await fetch('/__save?name=' + name + '.jpg', { method: 'POST', body: url });
    renderer.setPixelRatio(oldPR); renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); post.resize(innerWidth, innerHeight);
    return name;
  };

  $('load').style.opacity = 0; setTimeout(() => $('load').remove(), 1300);

  let last = performance.now(), fpsAcc = 0, fpsN = 0, fps = 0;
  const tmpV = new THREE.Vector3();
  const focus = new THREE.Vector3();
  const frameCount = { n: 0 };

  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000; last = now;
    // uneven frames must never destabilise anything: clamp render dt hard
    dt = clamp(dt, 0, 1 / 20);
    if (params.has('fixeddt')) dt = 1 / 60;
    G.time += dt;
    if (G.autoTime > 0) G.clock = (G.clock + G.autoTime * dt) % 24;
    weather.step(dt);
    rig.update(dt);
    camera.updateMatrixWorld();

    sky.update(camera);
    const L = sky.light;
    // key light: sun, moon light as a weak second directional
    sun.color.copy(L.sunColor); sun.intensity = L.sunIntensity;
    moon.intensity = L.moonIntensity; moon.position.copy(camera.position).addScaledVector(G.moonDir, 500);
    moon.target.position.copy(camera.position);
    // shadows follow where we look
    camera.getWorldDirection(tmpV);
    const camH = Math.max(camera.position.y - Math.max(heightAt(camera.position.x, camera.position.z), 0), 3);
    const half = clamp(camH * 1.3 + 90, 120, 650);
    focus.copy(camera.position).addScaledVector(tmpV, half * 0.55); focus.y = Math.max(heightAt(focus.x, focus.z), 0);
    const texel = (half * 2) / 4096;
    focus.x = Math.round(focus.x / texel) * texel; focus.z = Math.round(focus.z / texel) * texel;
    sun.target.position.copy(focus); sun.position.copy(focus).addScaledVector(G.sunDir, 900);
    const sc = sun.shadow.camera; sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half; sc.near = 50; sc.far = 2000; sc.updateProjectionMatrix();
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();

    // environment map from the live sky (refresh a few times a second)
    envAcc += dt;
    if (envAcc > (G.autoTime > 0 ? 0.6 : 1.5) || !envRT || weather.dirty) {
      envAcc = 0; weather.dirty = false;
      const prev = envRT; envRT = pmrem.fromScene(sky.envScene, 0, 0.1, 100000);
      scene.environment = envRT.texture; if (prev) prev.dispose();
    }
    // fog + exposure
    scene.fog.color.copy(G.fogColor);
    const rainFog = 1 + G.rain * 2.6 + (G.cover > 0.7 ? 0.6 : 0);
    scene.fog.density = lerp(0.00009, 0.00012, G.cover) * rainFog * (1 + smoothstep(0.2, 1, G.rain) * 1.4) * (params.has('fog') ? +params.get('fog') : 1);
    const target = clamp(0.62 * Math.pow(0.5 / (G.dayLevel + 0.02), 0.55), 0.45, 3.6);
    renderer.toneMappingExposure += (target - renderer.toneMappingExposure) * (1 - Math.exp(-dt * (target > renderer.toneMappingExposure ? 1.2 : 2.5)));
    if (params.has('exp')) renderer.toneMappingExposure = +params.get('exp');

    fogX.value.set(1 / lerp(340, 190, clamp(G.rain, 0, 1)), smoothstep(0.65, 1.0, G.cover) * (0.35 + 0.65 * G.rain) * (params.has('cloudfog') ? +params.get('cloudfog') : 1), lerp(380, 260, G.rain), 1);
    // shared uniforms
    updateWaterUniforms();
    const lit = 1 - smoothstep(0.05, 0.30, G.dayLevel);
    cityUniforms.uLit.value = lit; cityUniforms.uWet.value = clamp(0.25 + G.rain * 1.1, 0, 1); cityUniforms.uTime.value = G.time % 3600; cityUniforms.uRain.value = G.rain;
    const tu = terrain.userData.uniforms; tu.uWet.value = params.has('wet') ? +params.get('wet') : clamp(0.2 + G.rain * 1.2, 0, 1); tu.uRain.value = G.rain; tu.uTime.value = G.time % 3600;
    weather.update(dt, camera, L);
    boats.update(dt, G.time);
    people.update(dt, camera);
    trees.update(camera);
    cars.update(dt); trams.update(dt); lamps.update(); life.update(dt, camera, L); spray.update(L);
    const B = post.bloom; B.strength = lerp(0.18, 0.5, G.night * 0.8 + lit * 0.3); B.threshold = 1.5; B.radius = 0.5;
    post.atmos.uniforms.uTime.value = G.time % 100; post.atmos.uniforms.uRain.value = G.rain * smoothstep(0.1, 0.5, G.rain); post.atmos.uniforms.uWindX.value = G.windDir.x * G.wind;
    post.atmos.uniforms.uFlash.value = G.flash; post.atmos.uniforms.uFog.value.copy(G.fogColor); post.atmos.uniforms.uLum.value = clamp(G.dayLevel, 0, 1);
    post.atmos.uniforms.uDrops.value = G.rain > 0.6 ? (G.rain - 0.6) * 1.2 * smoothstep(0.55, 0.85, G.wind) : 0;
    post.film.uniforms.uTime.value = G.time;
    post.ssao.strength = params.has('ao') ? +params.get('ao') : lerp(0.55, 0.7, G.cover) * (1 - 0.4 * G.night);

    post.composer.render(dt);
    ui.frame();
    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
    frameCount.n++;
    const st = $('status');
    if (st && frameCount.n % 15 === 0) {
      const hh = Math.floor(G.clock), mm = Math.floor((G.clock % 1) * 60);
      st.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}  sun ${G.sunElev.toFixed(0)}°  ${weather.label}\n${(3 + G.wind * 21).toFixed(0)} m/s  ${fps.toFixed(0)} fps`;
    }
  }
  requestAnimationFrame(frame);
}
main().catch((e) => { console.error(e); const t = document.getElementById('loadtxt'); if (t) t.textContent = 'ERROR: ' + e.message; });
