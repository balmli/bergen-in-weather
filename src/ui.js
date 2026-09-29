import { addDays, todayInOslo } from './astro.js';
const $ = (id) => document.getElementById(id);

export function initUI({ rig, weather, G, params, stars }) {
  const time = $('time'), rain = $('rain'), wind = $('wind');
  const dd = $('dd'), dm = $('dm'), dy = $('dy');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  MON.forEach((m, i) => dm.add(new Option(m, i + 1)));
  const tv = $('timev'), rv = $('rainv'), wv = $('windv');
  let dragging = null;
  const fmt = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  const sync = () => {
    if (dragging !== 'time') time.value = G.clock;
    if (document.activeElement !== dd) dd.value = G.date.d;
    if (document.activeElement !== dm) dm.value = G.date.m;
    if (document.activeElement !== dy) dy.value = G.date.y;
    if (dragging !== 'rain') rain.value = G.targets.rain;
    if (dragging !== 'wind') wind.value = G.targets.wind;
    tv.textContent = fmt(G.clock);
    rv.textContent = (G.targets.rain * 100 | 0) + '%';
    wv.textContent = (3 + G.targets.wind * 21).toFixed(0) + 'm/s';
  };
  for (const [el, name] of [[time, 'time'], [rain, 'rain'], [wind, 'wind']]) {
    el.addEventListener('pointerdown', () => { dragging = name; });
    addEventListener('pointerup', () => { dragging = null; });
  }
  time.addEventListener('input', () => { G.clock = +time.value; G.autoTime = 0; $('tl').classList.remove('on'); weather.dirty = true; });
  // typed / selected date -> G.date (day clamped to the month length)
  const setDate = (y, m, d) => {
    y = Math.min(2100, Math.max(1900, y | 0)); m = Math.min(12, Math.max(1, m | 0));
    d = Math.min(new Date(Date.UTC(y, m, 0)).getUTCDate(), Math.max(1, d | 0));
    G.date = { y, m, d }; weather.dirty = true; sync();
  };
  const fromFields = () => { if (+dd.value && +dy.value > 999) setDate(+dy.value, +dm.value, +dd.value); };
  for (const el of [dd, dm, dy]) el.addEventListener('input', fromFields);
  for (const el of [dd, dy]) el.addEventListener('change', () => { setDate(+dy.value || G.date.y, +dm.value, +dd.value || 1); });
  const step = (n) => { const t = addDays(G.date, n); G.date = t; weather.dirty = true; sync(); };
  $('dprev').addEventListener('click', () => step(-1));
  $('dnext').addEventListener('click', () => step(1));
  $('now').addEventListener('click', () => { const n = todayInOslo(); G.date = { y: n.y, m: n.m, d: n.d }; G.clock = n.clock; G.autoTime = 0; $('tl').classList.remove('on'); weather.dirty = true; });
  $('names').classList.toggle('on', stars.showNames);
  $('names').addEventListener('click', (e) => { const on = !stars.showNames; stars.setNames(on); e.target.classList.toggle('on', on); });
  rain.addEventListener('input', () => { G.targets.rain = +rain.value; weather.setManual(); markPreset(null); });
  wind.addEventListener('input', () => { G.targets.wind = +wind.value; weather.setManual(); markPreset(null); });
  const presets = document.querySelectorAll('#presets button');
  const markPreset = (n) => presets.forEach((b) => b.classList.toggle('on', b.dataset.p === n));
  presets.forEach((b) => b.addEventListener('click', () => { weather.preset(b.dataset.p); markPreset(b.dataset.p); }));
  markPreset('rain');
  $('tour').addEventListener('click', () => { rig.startTour(0); });
  $('free').addEventListener('click', () => { rig.free(); });
  $('flow').addEventListener('click', (e) => { const on = !weather.flowOn; weather.setFlow(on); e.target.classList.toggle('on', on); });
  $('tl').addEventListener('click', (e) => { const on = G.autoTime === 0; G.autoTime = on ? 0.25 : 0; e.target.classList.toggle('on', on); });
  $('hide').addEventListener('click', () => document.body.classList.add('noui'));
  addEventListener('keydown', (e) => { if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('noui'); });
  // F toggles fullscreen (Esc leaves it natively)
  const fsEl = () => document.fullscreenElement || document.webkitFullscreenElement;
  addEventListener('keydown', (e) => {
    if ((e.key !== 'f' && e.key !== 'F') || e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(e.target?.tagName || '')) return;
    e.preventDefault();
    const de = document.documentElement;
    if (fsEl()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else (de.requestFullscreen || de.webkitRequestFullscreen)?.call(de);
  });
  rig.onMode = (m) => { $('tour').classList.toggle('on', m === 'tour'); $('free').classList.toggle('on', m === 'free'); };
  rig.onMode(rig.mode);
  sync();
  let n = 0;
  return { frame() { if ((n++ & 7) === 0) sync(); } };
}
