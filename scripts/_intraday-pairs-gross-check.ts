import "./_env.ts";
// Honesty add-on: is the GROSS (zero-fee) minute-pairs spread edge even positive? If gross is also
// negative, crypto minute pairs are MOMENTUM (diverge-and-keep-going), not mean-reverting — same
// conclusion as the daily horizon. If gross is positive but net negative, it's a fee illusion.
import { fetchBinanceKlines } from "../src/lib/data/binance.ts";
import type { VenueCandle } from "../src/lib/data/venue-candles.ts";
import { sharpe } from "../src/lib/backtest/candle/stats.ts";

const DAYS = 21, BAR_SEC = 60, ANN = Math.sqrt(365 * 1440);
const BETA_WINDOW = 240, Z_WINDOW = 120, EXIT_Z = 0.5, MAX_HOLD = 240;
const PAIRS: Array<[string, string]> = [["SOLUSDT","BNBUSDT"],["ETHUSDT","SOLUSDT"]];
const ENTRY = [1.5, 2.0, 2.5, 3.0];

async function fetchMinutes(symbol: string, days: number): Promise<VenueCandle[]> {
  const now = Math.floor(Date.now()/1000); let cursor = now - days*24*3600;
  const all: VenueCandle[] = []; const seen = new Set<number>();
  for (let p=0; p<Math.ceil(days*1440/1000)+4; p++) {
    const b = await fetchBinanceKlines(symbol,"1m",{startUnix:cursor,limit:1000}); if(!b.length) break;
    for(const c of b) if(!seen.has(c.start_unix)){seen.add(c.start_unix);all.push(c);}
    const last=b[b.length-1].start_unix; if(last<=cursor) break; cursor=last+BAR_SEC; if(cursor>=now) break;
  }
  all.sort((a,b)=>a.start_unix-b.start_unix); return all;
}
function align(a:VenueCandle[],b:VenueCandle[]){const mb=new Map<number,number>();for(const c of b)mb.set(c.start_unix,c.close);
  const la:number[]=[],lb:number[]=[];for(const c of a){const cb=mb.get(c.start_unix);if(cb==null||cb<=0||c.close<=0)continue;la.push(Math.log(c.close));lb.push(Math.log(cb));}return{la,lb};}
function rbeta(la:number[],lb:number[],i:number,w:number){const lo=i-w;if(lo<0)return null;let sx=0,sy=0,sxx=0,sxy=0,n=0;
  for(let k=lo;k<i;k++){const x=lb[k],y=la[k];sx+=x;sy+=y;sxx+=x*x;sxy+=x*y;n++;}const d=n*sxx-sx*sx;if(Math.abs(d)<1e-12)return null;return (n*sxy-sx*sy)/d;}
function runGross(la:number[],lb:number[],entryZ:number){const n=la.length,warm=Math.max(BETA_WINDOW,Z_WINDOW)+2;
  const rets:number[]=[];let pos=0,bh=0,hold=0,trades=0;
  for(let i=warm;i<n-1;i++){const beta=rbeta(la,lb,i,BETA_WINDOW);let des=pos;
    if(beta!=null){const lo=i-Z_WINDOW;let s=0,ss=0,m=0;for(let k=lo;k<i;k++){const sp=la[k]-beta*lb[k];s+=sp;ss+=sp*sp;m++;}
      const mu=s/m,v=ss/m-mu*mu,sg=v>0?Math.sqrt(v):0,spI=la[i]-beta*lb[i],z=sg>0?(spI-mu)/sg:0;
      if(pos===0){if(z>=entryZ){des=-1;bh=beta;}else if(z<=-entryZ){des=1;bh=beta;}}
      else{if(Math.abs(z)<=EXIT_Z)des=0;else if(hold>=MAX_HOLD)des=0;else des=pos;}}
    if(des!==0&&pos===0)trades++; hold=des!==0?(des===pos?hold+1:0):0;
    const dLa=la[i+1]-la[i],dLb=lb[i+1]-lb[i];rets.push(des*(dLa-bh*dLb));pos=des;}
  return{rets,trades};}

for(const [A,B] of PAIRS){const ca=await fetchMinutes(A,DAYS),cb=await fetchMinutes(B,DAYS);const{la,lb}=align(ca,cb);
  console.log(`\n${A}/${B} GROSS (zero-fee):`);
  for(const z of ENTRY){const r=runGross(la,lb,z);const sh=sharpe(r.rets)*ANN;const cum=(r.rets.reduce((e,x)=>e*(1+x),1)-1)*100;
    const ptb=r.trades>0?(r.rets.reduce((s,x)=>s+x,0)/r.trades)*1e4:0;
    console.log(`  z=${z}: trades=${r.trades}, grossSharpe(ann)=${sh.toFixed(2)}, grossPerTrade=${ptb.toFixed(1)}bps, grossCum=${cum.toFixed(2)}%`);}}
