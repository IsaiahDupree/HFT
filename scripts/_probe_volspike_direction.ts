import "./_env.ts";
import { fetchBinanceKlines } from "../src/lib/data/binance.ts";
import { realizedVol } from "../src/lib/backtest/candle/indicators.ts";

function arg(name: string, def: number){ const i=process.argv.indexOf(name); return i>=0&&process.argv[i+1]?Number(process.argv[i+1]):def; }
const DAYS = arg("--days",14), VOL_N=15, TOP=0.90, WARMUP=600;
const SYMS=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT"];

async function fetchMinutes(sym:string,days:number){
  const now=Math.floor(Date.now()/1000); let start=now-days*24*3600; const all:any[]=[]; let g=0;
  while(start<now&&g++<80){
    let p:any[]=[]; let ok=false;
    for(let attempt=0;attempt<4&&!ok;attempt++){ try{ p=await fetchBinanceKlines(sym,"1m",{startUnix:start,limit:1000}); ok=true; }catch(e){ await new Promise(r=>setTimeout(r,1500)); } }
    if(!ok||!p.length)break;
    for(const c of p)all.push(c); const ls=p[p.length-1].start_unix; if(ls<=start)break; start=ls+60; if(p.length<1000)break;
  }
  const seen=new Set<number>(); const out=all.filter(c=>seen.has(c.start_unix)?false:(seen.add(c.start_unix),true));
  out.sort((a,b)=>a.start_unix-b.start_unix); return out;
}
function expQuant(vol:number[],q:number,w:number){ const thr=new Array(vol.length).fill(NaN); const h:number[]=[];
  for(let i=0;i<vol.length;i++){ if(h.length>=w){const idx=Math.min(h.length-1,Math.floor(q*(h.length-1)));thr[i]=h[idx];}
    const v=vol[i]; if(Number.isFinite(v)){let lo=0,hi=h.length;while(lo<hi){const m=(lo+hi)>>1;if(h[m]<v)lo=m+1;else hi=m;}h.splice(lo,0,v);}}
  return thr; }

// fetch once, cache
const data:Record<string,{cl:number[],vol:number[],thr:number[],n:number}>={};
for(const sym of SYMS){ const c=await fetchMinutes(sym,DAYS); const cl=c.map(x=>x.close); const n=cl.length;
  const vol=realizedVol(cl,VOL_N); const thr=expQuant(vol,TOP,WARMUP); data[sym]={cl,vol,thr,n}; console.error(`cached ${sym}: ${n} bars`); }

console.log(`\nForward return after a top-decile vol spike, by direction of the spike bar move:`);
console.log(`(avgContinuation>0 => MOMENTUM/continuation; <0 => REVERSION. This is GROSS, no fees.)`);
for(const H of [1,3,5,10,15,30]){
  let sumCont=0, nCont=0, sumAbs=0;
  for(const sym of SYMS){ const {cl,vol,thr,n}=data[sym];
    for(let i=WARMUP+VOL_N+1;i<n-H-1;i++){
      const spike=Number.isFinite(vol[i])&&Number.isFinite(thr[i])&&vol[i]>=thr[i]; if(!spike)continue;
      const ret=cl[i]/cl[i-1]-1; if(ret===0)continue;
      const fwd=cl[i+H]/cl[i]-1; const cont=Math.sign(ret)*fwd;
      sumCont+=cont; nCont++; sumAbs+=Math.abs(fwd);
    }
  }
  console.log(`H=${String(H).padStart(2)}m  n=${nCont}  avgContinuation=${(sumCont/nCont*1e4).toFixed(3)}bps  avg|fwd|=${(sumAbs/nCont*1e4).toFixed(2)}bps`);
}

// also: only LARGE moves (|ret| >= 2*vol) — does selectivity reveal reversion?
console.log(`\nSame, but ONLY large moves (|ret[i]| >= 2*vol[i]):`);
for(const H of [1,3,5,10,15,30]){
  let sumCont=0, nCont=0;
  for(const sym of SYMS){ const {cl,vol,thr,n}=data[sym];
    for(let i=WARMUP+VOL_N+1;i<n-H-1;i++){
      const spike=Number.isFinite(vol[i])&&Number.isFinite(thr[i])&&vol[i]>=thr[i]; if(!spike)continue;
      const ret=cl[i]/cl[i-1]-1; if(ret===0)continue;
      if(Math.abs(ret) < 2*vol[i])continue;
      const fwd=cl[i+H]/cl[i]-1; sumCont+=Math.sign(ret)*fwd; nCont++;
    }
  }
  console.log(`H=${String(H).padStart(2)}m  n=${nCont}  avgContinuation=${(sumCont/nCont*1e4).toFixed(3)}bps`);
}
