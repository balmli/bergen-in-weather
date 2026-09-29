import fs from 'fs'; import {PNG} from 'pngjs';
const meta=JSON.parse(fs.readFileSync('public/dem.json'));const b=fs.readFileSync('public/dem.bin');const u=new Uint16Array(b.buffer,b.byteOffset,b.length/2);
const N=meta.N;const png=new PNG({width:N,height:N});
for(let k=0;k<N*N;k++){const h=u[k]*meta.scale-meta.offset;let r,g,bl;
 if(h<0.8){r=20;g=60;bl=120;} else {const t=Math.min(1,h/300);r=60+180*t;g=110+60*(1-t);bl=60+120*t;}
 // MCB marker
 png.data[k*4]=r;png.data[k*4+1]=g;png.data[k*4+2]=bl;png.data[k*4+3]=255;}
const mark=(x,z,c)=>{const i=Math.round((x/meta.SPAN+0.5)*(N-1)),j=Math.round((z/meta.SPAN+0.5)*(N-1));for(let dj=-3;dj<=3;dj++)for(let di=-3;di<=3;di++){const k=((j+dj)*N+i+di)*4;png.data[k]=255;png.data[k+1]=0;png.data[k+2]=0;}};
mark(0,0);mark(-330,-500);mark(-555,-1357);
// crop center 5km
const cw=512,c0=(N-cw)/2;const o=new PNG({width:cw,height:cw});PNG.bitblt(png,o,c0,c0,cw,cw,0,0);
fs.writeFileSync('/private/tmp/claude-501/-Volumes-WD-BLACK-Prosjekter-tv2-3d-sim/4194efde-3cb5-4b6e-98fc-334a9bfa80d6/scratchpad/dem.png',PNG.sync.write(o));
