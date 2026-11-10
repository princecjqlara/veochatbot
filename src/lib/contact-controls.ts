import {scoreContactForecast,forecastPageName,type ForecastCache} from './contact-forecast';
type Db={from:(table:string)=>any;rpc:(name:string,args:Record<string,unknown>)=>any};
export async function contactControls(db:Db,pageId:string,ids:string[]){
 if(!ids.length)return new Map<string,any>();
 const loadedAt=new Date().toISOString();
 const unique=[...new Set(ids)];
 async function readControls(){
  let cursor=0;const rows:any[]=[];
  await Promise.all(Array.from({length:Math.min(2,Math.ceil(unique.length/100))},async()=>{
   while(cursor<unique.length){const batch=unique.slice(cursor,cursor+100);cursor+=100;
    const result=await db.rpc('get_contact_controls',{p_page_id:pageId,p_contact_ids:batch});
    if(result.error||!Array.isArray(result.data))throw Error('Contact controls unavailable');rows.push(...result.data);
   }
  }));
  const found=new Set(rows.map(r=>r.contact_id));
  if(found.size!==unique.length||unique.some(id=>!found.has(id)))throw Error('Complete contact controls unavailable');
  return rows;
 }
 const [rows,page]=await Promise.all([
  readControls(),
  Promise.resolve().then(()=>db.from('pages').select('name,fb_page_id').eq('id',pageId).maybeSingle())
 ]);
 if(page.error)throw Error('Contact controls unavailable');
 return new Map<string,any>(rows.map((r:any)=>[r.contact_id,{
  bot_control:{enabled:r.enabled,can_reply:r.reason==='allowed',reason:r.reason,loaded_at:loadedAt},
  conversion_projection:r.pipeline_stage==='order_created'
    ? { ...scoreContactForecast(r.cache as ForecastCache|null,forecastPageName(page.data?.fb_page_id||'')),status:'order_created_paid',scores:null,close_window:null,close_windows:{},message:'Order Created is a paid conversion in this workflow. Receipt amounts are tracked separately.' }
    : r.pipeline_stage==='converted'&&!r.cache?.payment_at
    ? {...scoreContactForecast(r.cache as ForecastCache|null,forecastPageName(page.data?.fb_page_id||'')),status:'payment_verification_needed',scores:null,close_window:null,close_windows:{}}
    : scoreContactForecast(r.cache as ForecastCache|null,forecastPageName(page.data?.fb_page_id||''))
 }]));
}
