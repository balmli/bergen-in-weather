# Bergen in weather (three.js)
Run: `npm install && npm run dev` → http://127.0.0.1:5177
- Starts with a ~3 min cinematic tour (real OSM footprints + real elevation), then free flight. Any key/drag/wheel takes over.
- Fly: WASD/arrows, Q/E down/up, Shift boost, drag to look, wheel = speed. H hides the UI.
- UI: time, rain, wind, presets (clear/grey/rain/storm/live). "live" pulls current Bergen weather from MET Norway via the dev proxy.
- Data: `node tools/prep.mjs` merges data/*.json into public/city.json; `tools/dem.mjs` builds public/dem.bin.
- Review helper: `window.__shot(name,{cam:[px,py,pz,tx,ty,tz],t,rain,wind,cover})` saves a 1600x900 JPEG to ./shots.
