import type {ForecastSnapshot} from './contact-forecast';
type Node=[number,number,number,number,number,number,number];
export type BoostModel={version:string;schema:{pages:string[];states:string[];industries:string[];feature_names:string[]};edges_hours:number[];base_log_rate:number;trees:Node[][];hazard_factor:number;support:Record<string,[number,number]>;timing_calibration:Record<string,{n:number;margin_days:number}>;backtest?:Record<string,Record<string,any>>};
const flags=['quoted','form','duration','returned','price_question'] as const;
export function hasConversationFeatures(f:ForecastSnapshot){return Number.isFinite(f.inbound)&&Number(f.inbound)>=0&&flags.every(k=>typeof f[k]==='boolean')&&(f.last_inbound_h===null||Number.isFinite(f.last_inbound_h));}
export function forecastVector(m:BoostModel,page:string,first:number,f:ForecastSnapshot,interval:number){
 const hour=(first/3_600_000+8)%24,dow=(new Date(first+8*3_600_000).getUTCDay()+6)%7;
 return [Math.log1p(Math.max(0,f.inbound||0)),...flags.map(k=>Number(f[k])),Math.log1p(Math.max(0,f.h-(f.last_inbound_h??0))),Math.sin(2*Math.PI*hour/24),Math.cos(2*Math.PI*hour/24),Math.sin(2*Math.PI*dow/7),Math.cos(2*Math.PI*dow/7),Math.log1p(f.h),Math.log1p(m.edges_hours[interval]),Math.log1p(m.edges_hours[interval+1]-m.edges_hours[interval]),...m.schema.pages.map(p=>Number(page===p)),...m.schema.states.map(b=>Number(f.b===b)),...m.schema.industries.map(i=>Number(f.i===i))].map(Math.fround);
}
export function treeRate(m:BoostModel,x:number[]){
 let raw=m.base_log_rate;
 for(const nodes of m.trees){let ix=0;while(!nodes[ix][5]){const [feature,threshold,left,right,,,missingLeft]=nodes[ix],value=x[feature];ix=Number.isNaN(value)?(missingLeft?left:right):value<=threshold?left:right;}raw+=nodes[ix][4];}
 return Math.exp(Math.max(-30,Math.min(20,raw)))*m.hazard_factor;
}
export function boostedRates(m:BoostModel,page:string,first:number,f:ForecastSnapshot){return m.edges_hours.slice(0,-1).map((_,j)=>treeRate(m,forecastVector(m,page,first,f,j)));}
export function boostedSupport(m:BoostModel,page:string,f:ForecastSnapshot){
 const levels=[[f.h,page],[f.h,page,f.b],[f.h,page,f.b,f.i]];let chosen:any=null;
 for(const group of levels){const cell=m.support[JSON.stringify(group)];if(cell&&(chosen===null||cell[0]>=100&&cell[1]>=10))chosen={comparable_records:cell[0],events:cell[1],group};}
 return chosen;
}
