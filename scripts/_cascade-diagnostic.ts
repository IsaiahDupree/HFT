import "./_env.ts";
import { readFileSync } from "node:fs";
type Bar = { t:number;o:number;h:number;l:number;c:number;v:number };
const SYMS = ["BTCUSDT","ETHUSDT","SOLUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT"];
const load = (s:string)=>JSON.parse(readFileSync(`data/cascade-klines/${s}.json`,"utf8")) as Bar[];
const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;

// For each cascade trigger (same definition), measure the GROSS forward fade return at multiple horizons.
// If reversion is real, gross fade return > 0 and grows then fades. This is cost-free signal detection.
const W=10,kAtr=4,pctFloor=0.008,volPctile=0.9,volLookback=240,atrN=60;
const horizons=[5,15,30,60,120,240];
const acc: Record<number,number[]> = {}; horizons.forEach(h=>acc[h]=[]);
let nDown=0,nUp=0;

for(const sym of SYMS){
  const bars=load(sym); const n=bars.length;
  const tr=new Float64Array(n);
  for(let i=1;i<n;i++){tr[i]=Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-bars[i-1].c),Math.abs(bars[i].l-bars[i-1].c));}
  const trPre=new Float64Array(n+1),volPre=new Float64Array(n+1);
  for(let i=0;i<n;i++){trPre[i+1]=trPre[i]+tr[i];volPre[i+1]=volPre[i]+bars[i].v;}
  const maxH=Math.max(...horizons);
  let nextFree=0;
  for(let i=volLookback+1;i+maxH<n;i++){
    if(i<nextFree)continue;
    const atr=(trPre[i]-trPre[i-atrN])/atrN; if(!(atr>0))continue;
    const cNow=bars[i].c,cPast=bars[i-W].c;
    const winRet=(cNow-cPast)/cPast, movePerAtr=(cNow-cPast)/atr;
    const bigDown=movePerAtr<=-kAtr&&winRet<=-pctFloor, bigUp=movePerAtr>=kAtr&&winRet>=pctFloor;
    if(!bigDown&&!bigUp)continue;
    const dist:number[]=[]; for(let s=i-volLookback;s<=i-W;s++)dist.push(volPre[s+1]-volPre[s+1-W]);
    dist.sort((a,b)=>a-b); const thr=dist[Math.floor(volPctile*dist.length)];
    if((volPre[i+1]-volPre[i+1-W])<thr)continue;
    const dir=bigDown?+1:-1; if(bigDown)nDown++;else nUp++;
    for(const h of horizons){const fwd=(bars[i+h].c-cNow)/cNow; acc[h].push(dir*fwd*1e4);} // GROSS fade bps
    nextFree=i+maxH;
  }
}
console.log(`triggers: ${nDown} down-cascades, ${nUp} up-cascades, total ${nDown+nUp}`);
console.log(`GROSS fade return (bps, no cost) by horizon — positive = reversion, negative = continuation:`);
for(const h of horizons){const a=acc[h];console.log(`  H=${String(h).padStart(3)}m  mean ${mean(a).toFixed(2).padStart(8)}bps  median ${a.slice().sort((x,y)=>x-y)[Math.floor(a.length/2)].toFixed(2).padStart(8)}bps  win% ${(a.filter(x=>x>0).length/a.length*100).toFixed(1)}`);}

// Also test the OPPOSITE: MOMENTUM (ride the cascade) gross at H=60
const mom=acc[60].map(x=>-x);
console.log(`\nMOMENTUM (ride, opposite of fade) gross at H=60m: mean ${mean(mom).toFixed(2)}bps win% ${(mom.filter(x=>x>0).length/mom.length*100).toFixed(1)}`);
console.log(`Round-trip cost to beat: ~10-16bps fee + 6-24bps slip = ~16-40bps. Gross edge must exceed this.`);
