import * as Astronomy from 'astronomy-engine';
import { LAT0, LON0 } from './common.js';

// Real ephemerides (astronomy-engine) for the sim's observer. World frame: x = east, y = up, z = south.
const rad = Math.PI / 180;
export const OBS = new Astronomy.Observer(LAT0, LON0, 20);
const PLANETS = [
  ['Mercury', Astronomy.Body.Mercury, [0.80, 0.78, 0.74]],
  ['Venus', Astronomy.Body.Venus, [1.0, 0.97, 0.90]],
  ['Mars', Astronomy.Body.Mars, [1.0, 0.55, 0.36]],
  ['Jupiter', Astronomy.Body.Jupiter, [1.0, 0.93, 0.80]],
  ['Saturn', Astronomy.Body.Saturn, [1.0, 0.88, 0.62]],
];

// Local Norwegian clock (CET/CEST, EU rules via Intl) -> UTC instant. date = {y, m (1-12), d}.
const osloFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Oslo', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function osloOffsetHours(utcMs) {
  const p = Object.fromEntries(osloFmt.formatToParts(new Date(utcMs)).map((x) => [x.type, +x.value]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(utcMs / 60000) * 60000) / 3600000;
}
export function localToUTC(date, clock) {
  const wall = Date.UTC(date.y, date.m - 1, date.d) + clock * 3600000;
  let ms = wall - 3600000;
  ms = wall - osloOffsetHours(ms) * 3600000;
  ms = wall - osloOffsetHours(ms) * 3600000;
  return new Date(ms);
}
export function todayInOslo() {
  const p = Object.fromEntries(osloFmt.formatToParts(new Date()).map((x) => [x.type, +x.value]));
  return { y: p.year, m: p.month, d: p.day, clock: p.hour + p.minute / 60 };
}
export function addDays(date, n) {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}
export const dateToStr = (d) => `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
export function strToDate(s) { const [y, m, d] = s.split('-').map(Number); return y ? { y, m, d } : null; }

// azimuth (deg from north, clockwise) + altitude (deg) -> world direction
function horizToDir(az, alt, out) {
  const a = az * rad, e = alt * rad;
  out[0] = Math.sin(a) * Math.cos(e); out[1] = Math.sin(e); out[2] = -Math.cos(a) * Math.cos(e);
  return out;
}
function horizOf(body, time) {
  const eq = Astronomy.Equator(body, time, OBS, true, true);
  const h = Astronomy.Horizon(time, OBS, eq.ra, eq.dec, 'normal');
  return { az: h.azimuth, el: h.altitude, ra: eq.ra, dec: eq.dec };
}

// Everything the sky needs for one instant. `M` maps J2000 equatorial unit vectors -> world (row-major 3x3).
export function skyState(date, clock) {
  const utc = localToUTC(date, clock);
  const t = Astronomy.MakeTime(utc);
  const sun = horizOf(Astronomy.Body.Sun, t);
  const moon = horizOf(Astronomy.Body.Moon, t);
  const mi = Astronomy.Illumination(Astronomy.Body.Moon, t);
  const phase = Astronomy.MoonPhase(t);            // 0 new, 90 first quarter, 180 full, 270 last quarter
  const theta = (Astronomy.SiderealTime(t) * 15 + LON0) * rad;
  const ph = LAT0 * rad, ct = Math.cos(theta), st = Math.sin(theta), cp = Math.cos(ph), sp = Math.sin(ph);
  // of-date equatorial -> world, then precess J2000 -> of-date first
  const E = [[-st, ct, 0], [cp * ct, cp * st, sp], [sp * ct, sp * st, -cp]];
  const rot = Astronomy.Rotation_EQJ_EQD(t);
  const cols = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((v) => { const r = Astronomy.RotateVector(rot, new Astronomy.Vector(v[0], v[1], v[2], t)); return [r.x, r.y, r.z]; });
  const M = [0, 1, 2].map((i) => [0, 1, 2].map((j) => E[i][0] * cols[j][0] + E[i][1] * cols[j][1] + E[i][2] * cols[j][2]));
  const planets = PLANETS.map(([name, body, col]) => {
    const h = horizOf(body, t);
    return { name, el: h.el, az: h.az, mag: Astronomy.Illumination(body, t).mag, col, dir: horizToDir(h.az, h.el, [0, 0, 0]) };
  });
  return {
    utc, sun, moon, planets, M,
    moonDir: horizToDir(moon.az, moon.el, [0, 0, 0]), sunDir: horizToDir(sun.az, sun.el, [0, 0, 0]),
    moonFrac: mi.phase_fraction, moonAngle: phase, moonMag: mi.mag,
  };
}
export function moonPhaseName(a) {
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return names[Math.round(a / 45) % 8];
}
