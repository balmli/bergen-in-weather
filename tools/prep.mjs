import fs from 'fs';
const d = JSON.parse(fs.readFileSync('data/osm.json','utf8'));
const seen = new Set(d.elements.map(e=>e.id));
let tilesUsed = 0;
if (fs.existsSync('data/tiles')) for (const f of fs.readdirSync('data/tiles')) {
  if (!f.endsWith('.json')) continue;
  let t; try { t = JSON.parse(fs.readFileSync('data/tiles/'+f,'utf8')); } catch(e) { continue; }
  tilesUsed++;
  for (const e of t.elements) { if (seen.has(e.id)) continue; seen.add(e.id); d.elements.push(e); }
}
console.log('tiles merged', tilesUsed, 'elements', d.elements.length);
const LAT0=60.3855, LON0=5.3330;
const KX=111320*Math.cos(LAT0*Math.PI/180), KZ=111200;
const P=(g)=>[+((g.lon-LON0)*KX).toFixed(1), +(-(g.lat-LAT0)*KZ).toFixed(1)];
const out={buildings:[],roads:[],water:[],parks:[],rails:[],coast:[]};
const area=(r)=>{let a=0;for(let i=0;i<r.length;i++){const p=r[i],q=r[(i+1)%r.length];a+=p[0]*q[1]-q[0]*p[1];}return a/2;};
for(const e of d.elements){
  if(e.type!=='way'||!e.geometry)continue;
  const t=e.tags||{}; let pts=e.geometry.map(P);
  if(t.building){
    if(pts.length>2&&pts[0][0]===pts[pts.length-1][0]&&pts[0][1]===pts[pts.length-1][1])pts.pop();
    if(pts.length<3)continue;
    if(area(pts)<0)pts.reverse();
    out.buildings.push({p:pts,l:+t['building:levels']||0,h:parseFloat(t.height)||0,t:t.building,n:t.name||'',c:t['building:colour']||'',rc:t['roof:colour']||'',rs:t['roof:shape']||'',mp:t['building:min_level']||0});
  } else if(t.highway){
    out.roads.push({p:pts,t:t.highway,n:t.name||'',ow:t.oneway==='yes'?1:0,br:t.bridge?1:0,tn:t.tunnel?1:0,ly:+t.layer||0,sf:t.surface||''});
  } else if(t.natural==='water'){ out.water.push({p:pts}); }
  else if(t.natural==='coastline'){ out.coast.push({p:pts}); }
  else if(t.leisure||t.landuse||t.natural==='wood'){ out.parks.push({p:pts,t:t.leisure||t.landuse||'forest'}); }
  else if(t.railway){ out.rails.push({p:pts}); }
}
// multipolygon relations (Lille Lungegaardsvann, Byparken, small ponds)
if (fs.existsSync('data/water.json')) {
  const rel = JSON.parse(fs.readFileSync('data/water.json','utf8'));
  const key = (g)=>g.lat.toFixed(6)+','+g.lon.toFixed(6);
  for (const e of rel.elements) {
    if (e.type !== 'relation') continue;
    const t = e.tags||{};
    const isWater = t.natural==='water', isPark = t.leisure==='park';
    if (!isWater && !isPark) continue;
    // stitch outer ways into closed rings
    let segs = e.members.filter(m=>m.role==='outer'&&m.geometry&&m.geometry.length>1).map(m=>m.geometry.slice());
    const rings = [];
    while (segs.length) {
      let ring = segs.shift();
      let grew = true;
      while (grew) {
        grew = false;
        if (key(ring[0])===key(ring[ring.length-1]) && ring.length>3) break;
        for (let i=0;i<segs.length;i++) {
          const s2 = segs[i];
          if (key(s2[0])===key(ring[ring.length-1])) { ring = ring.concat(s2.slice(1)); segs.splice(i,1); grew=true; break; }
          if (key(s2[s2.length-1])===key(ring[ring.length-1])) { ring = ring.concat(s2.slice().reverse().slice(1)); segs.splice(i,1); grew=true; break; }
          if (key(s2[s2.length-1])===key(ring[0])) { ring = s2.slice(0,-1).concat(ring); segs.splice(i,1); grew=true; break; }
          if (key(s2[0])===key(ring[0])) { ring = s2.slice().reverse().slice(0,-1).concat(ring); segs.splice(i,1); grew=true; break; }
        }
      }
      rings.push(ring);
    }
    for (const r of rings) {
      const pts = r.map(P); if (pts.length>3 && pts[0][0]===pts[pts.length-1][0] && pts[0][1]===pts[pts.length-1][1]) pts.pop();
      if (pts.length<3) continue;
      if (isWater) out.water.push({p:pts, name:t.name||''}); else out.parks.push({p:pts,t:'park'});
      console.log('relation ring', t.name||t.water, pts.length, 'area', Math.round(Math.abs(area(pts))), 'centre', Math.round(pts.reduce((s,q)=>s+q[0],0)/pts.length), Math.round(pts.reduce((s,q)=>s+q[1],0)/pts.length));
    }
  }
}
fs.writeFileSync('public/city.json',JSON.stringify(out));
const mc=out.buildings.find(b=>/Media City/.test(b.n));
console.log('buildings',out.buildings.length,'roads',out.roads.length,'water',out.water.length,'coast',out.coast.length);
console.log('MCB',JSON.stringify(mc).slice(0,400));
let minx=1e9,maxx=-1e9,minz=1e9,maxz=-1e9;for(const b of out.buildings)for(const p of b.p){minx=Math.min(minx,p[0]);maxx=Math.max(maxx,p[0]);minz=Math.min(minz,p[1]);maxz=Math.max(maxz,p[1]);}
console.log({minx,maxx,minz,maxz});
console.log('coast',out.coast.map(c=>c.p.length+':'+JSON.stringify(c.p[0])+'->'+JSON.stringify(c.p[c.p.length-1])));
console.log('water',out.water.map(c=>c.p.length+':'+JSON.stringify(c.p[0])));
console.log('named', out.buildings.filter(b=>b.n).map(b=>b.n).join(', ').slice(0,1500));
