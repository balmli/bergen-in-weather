import fs from 'fs'; import {PNG} from 'pngjs';
const LAT0=60.3855, LON0=5.3330;
const KX=111320*Math.cos(LAT0*Math.PI/180), KZ=111200;
const Z=12;
const n=2**Z;
const tx=(lon)=> (lon+180)/360*n;
const ty=(lat)=>{const r=lat*Math.PI/180;return (1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n;};
// cover +-7km
const lonMin=LON0-7000/KX, lonMax=LON0+7000/KX, latMin=LAT0-7000/KZ, latMax=LAT0+7000/KZ;
const x0=Math.floor(tx(lonMin)), x1=Math.floor(tx(lonMax)), y0=Math.floor(ty(latMax)), y1=Math.floor(ty(latMin));
console.log('tiles',x0,x1,y0,y1);
const W=(x1-x0+1)*256, H=(y1-y0+1)*256;
const hm=new Float32Array(W*H);
for(let ty_=y0;ty_<=y1;ty_++)for(let tx_=x0;tx_<=x1;tx_++){
  const url=`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx_}/${ty_}.png`;
  const r=await fetch(url); if(!r.ok){console.log('fail',url,r.status);process.exit(1);}
  const png=PNG.sync.read(Buffer.from(await r.arrayBuffer()));
  for(let j=0;j<256;j++)for(let i=0;i<256;i++){const k=(j*256+i)*4;const h=png.data[k]*256+png.data[k+1]+png.data[k+2]/256-32768;hm[((ty_-y0)*256+j)*W+(tx_-x0)*256+i]=h;}
}
// resample to local-meter grid: 14km at 10m => 1400 (use 1024 at ~13.7m)
const N=1024, SPAN=14000; const out=new Float32Array(N*N);
const bil=(px,py)=>{px=Math.max(0,Math.min(W-1.001,px));py=Math.max(0,Math.min(H-1.001,py));const i=Math.floor(px),j=Math.floor(py),fx=px-i,fy=py-j;const a=hm[j*W+i],b=hm[j*W+i+1],c=hm[(j+1)*W+i],d=hm[(j+1)*W+i+1];return (a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;};
let mn=1e9,mx=-1e9;
for(let j=0;j<N;j++)for(let i=0;i<N;i++){
  const x=(i/(N-1)-0.5)*SPAN, z=(j/(N-1)-0.5)*SPAN; // z south positive
  const lon=LON0+x/KX, lat=LAT0-z/KZ;
  const h=bil((tx(lon)-x0)*256,(ty(lat)-y0)*256); out[j*N+i]=h; mn=Math.min(mn,h);mx=Math.max(mx,h);
}
console.log('range',mn,mx);
// store as 16-bit: (h+20)*  -> uint16 scale 0.05 m
const u=new Uint16Array(N*N);for(let k=0;k<N*N;k++)u[k]=Math.max(0,Math.min(65535,Math.round((out[k]+20)/0.02)));
fs.writeFileSync('public/dem.bin',Buffer.from(u.buffer));
fs.writeFileSync('public/dem.json',JSON.stringify({N,SPAN,offset:20,scale:0.02}));
const at=(x,z)=>out[Math.round((z/SPAN+0.5)*(N-1))*N+Math.round((x/SPAN+0.5)*(N-1))];
console.log('MCB',at(0,0),'pond',at(-330,-500),'Floyen',at(531,-1032),'Ulriken',at(2966,889),'Lov',at(-762,2749),'sea E',at(600,300),'Vagen',at(-700,-1400));
