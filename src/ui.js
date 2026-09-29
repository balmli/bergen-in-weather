const $ = (id) => document.getElementById(id);

export function initUI({ rig, weather, G, params }) {
  const time = $('time'), rain = $('rain'), wind = $('wind');
  const tv = $('timev'), rv = $('rainv'), wv = $('windv');
  let dragging = null;
  const fmt = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
  const sync = () => {
    if (dragging !== 'time') time.value = G.clock;
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
  rig.onMode = (m) => { $('tour').classList.toggle('on', m === 'tour'); $('free').classList.toggle('on', m === 'free'); };
  rig.onMode(rig.mode);
  sync();
  let n = 0;
  return { frame() { if ((n++ & 7) === 0) sync(); } };
}
