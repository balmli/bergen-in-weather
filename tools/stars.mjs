// Builds public/stars.json (naked-eye stars, names, constellation lines) from the d3-celestial data set.
//   npm i --no-save d3-celestial && node tools/stars.mjs node_modules/d3-celestial/data
import fs from 'fs';
import path from 'path';

const dir = process.argv[2] || 'node_modules/d3-celestial/data';
const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const ra = (lon) => +(((lon % 360) + 360) % 360).toFixed(3);
const r3 = (x) => +x.toFixed(3);

const names = read('starnames.json');
const stars = [], labels = [];
for (const f of read('stars.6.json').features) {
  const [lon, dec] = f.geometry.coordinates, mag = f.properties.mag, bv = parseFloat(f.properties.bv);
  stars.push(ra(lon), r3(dec), +mag.toFixed(2), Number.isFinite(bv) ? +bv.toFixed(2) : 0.6);
  const nm = names[String(f.id)]?.name;
  if (nm && mag < 2.6) labels.push([ra(lon), r3(dec), +mag.toFixed(2), nm]);
}
const lines = [];
for (const f of read('constellations.lines.json').features)
  for (const seg of f.geometry.coordinates) lines.push(seg.flatMap(([lon, dec]) => [ra(lon), r3(dec)]));

fs.writeFileSync('public/stars.json', JSON.stringify({ stars, labels, lines }));
console.log(stars.length / 4, 'stars,', labels.length, 'named,', lines.length, 'line strips');
