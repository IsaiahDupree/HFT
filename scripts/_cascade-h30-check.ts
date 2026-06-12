import "./_env.ts";
import { readFileSync } from "node:fs";
import { sharpe } from "../src/lib/backtest/candle/stats.ts";
import { lcgRng, permutationTest } from "../src/lib/backtest/shuffle-control.ts";
type Bar={t:number;o:number;h:number;l:number;c:number;v:number};
const COINS=[["BTCUSDT",10],["ETHUSDT",10],["SOLUSDT",10],["DOGEUSDT",10],["AVAXUSDT",16],["LINKUSDT",16]] as [string,number][];
const load=(s:string)=>JSON.parse(readFileSync(`data/cascade-klines/${s}.json`,"utf8")) as Bar[];
const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const std=(a:number[])=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
const W=10,H=30,kAtr=4,pctFloor=0.008,volPctile=0.9,volLookback=240,atrN=60;
function trades(bars:Bar[],fee:number){const n=bars.length;const tr=new Float64Array(n);
  for(let i=1;i<n;i++)tr[i]=Math.max(bars[i].h-bars[i].l,Math.abs(bars[i].h-bars[i-1].c),Math.abs(bars[i].l-bars[i-1].c));
  const trPre=new Float64Array(n+1),volPre=new Float64Array(n+1);for(let i=0;i<n;i++){trPre[i+1]=trPre[i]+tr[i];volPre[i+1]=volPre[i]+bars[i].v;}
  const out:{t:number;ret:number}[]=[];let nf=0;
  for(let i=volLookback+1;i+H<n;i++){if(i<nf)continue;const atr=(trPre[i]-trPre[i-atrN])/atrN;if(!(atr>0))continue;
    const cNow=bars[i].c,cPast=bars[i-W].c,winRet=(cNow-cPast)/cPast,mpa=(cNow-cPast)/atr;
    const bd=mpa<=-kAtr&&winRet<=-pctFloor,bu=mpa>=kAtr&&winRet>=pctFloor;if(!bd&&!bu)continue;
    const dist:number[]=[];for(let s=i-volLookback;s<=i-W;s++)dist.push(volPre[s+1]-volPre[s+1-W]);dist.sort((a,b)=>a-b);
    if((volPre[i+1]-volPre[i+1-W])<dist[Math.floor(volPctile*dist.length)])continue;
    const dir=bd?1:-1,fwd=(bars[i+H].c-cNow)/cNow,mag=Math.abs(winRet)*1e4,slip=Math.min(12,3+0.04*mag);
    out.push({t:bars[i].t,ret:dir*fwd-(fee+2*slip)/1e4});nf=i+H;}
  return out;}
const data=COINS.map(([s,f])=>({bars:load(s),fee:f}));
const pooled=data.flatMap(d=>trades(d.bars,d.fee)).sort((a,b)=>a.t-b.t);
const rets=pooled.map(x=>x.ret),N=rets.length,span=21;
const mbps=mean(rets)*1e4,tpd=N/span,sh=sharpe(rets),ann=sh*Math.sqrt(tpd*365);
console.log(`H=30m WITH FULL COST: trades ${N} | net ${mbps.toFixed(2)}bps | win ${(rets.filter(x=>x>0).length/N*100).toFixed(1)}% | ann Sharpe ${ann.toFixed(2)} | trades/day ${tpd.toFixed(2)}`);
// random-entry control
const r=lcgRng(7);const nullB:number[]=[];
for(let p=0;p<400;p++){const all:number[]=[];for(const d of data){const m=trades(d.bars,d.fee).length;const n=d.bars.length;
  for(let k=0;k<m;k++){const i=W+1+Math.floor(r()*(n-W-H-2));const cN=d.bars[i].c,cP=d.bars[i-W].c,wr=(cN-cP)/cP;const dir=wr<=0?1:-1;const mag=Math.abs(wr)*1e4,slip=Math.min(12,3+0.04*mag);all.push(dir*(d.bars[i+H].c-cN)/cN-(d.fee+2*slip)/1e4);}}nullB.push(mean(all)*1e4);}
console.log(`random-entry null: ${mean(nullB).toFixed(2)}±${std(nullB).toFixed(2)}bps | p=${permutationTest(mbps,nullB,"greater").pValue.toFixed(4)}`);
