import {scoreContactForecast,forecastPageName,type ForecastCache} from './contact-forecast';
type Db={from:(table:string)=>any;rpc:(name:string,args:Record<string,unknown>)=>any};
export async function contactControls(db:Db,pageId:string,ids:string[]){
 if(!ids.length)return new Map<string,any>();
 const loadedAt=new Date().toISOString();
 const [result,page]=await Promise.all([
  db.rpc('get_contact_controls',{p_page_id:pageId,p_contact_ids:ids.slice(0,100)}),
  db.from('pages').select('name,fb_page_id').eq('id',pageId).maybeSingle()
 ]);
 if(result.error||page.error)throw Error('Contact controls unavailable');
 return new Map<string,any>((result.data||[]).map((r:any)=>[r.contact_id,{
  bot_control:{enabled:r.enabled,can_reply:r.reason==='allowed',reason:r.reason,loaded_at:loadedAt},
  conversion_projection:r.pipeline_stage==='converted'&&!r.cache?.payment_at
    ? {...scoreContactForecast(r.cache as ForecastCache|null,forecastPageName(page.data?.fb_page_id||'')),status:'payment_verification_needed',scores:null,close_window:null}
    : scoreContactForecast(r.cache as ForecastCache|null,forecastPageName(page.data?.fb_page_id||''))
 }]));
}
