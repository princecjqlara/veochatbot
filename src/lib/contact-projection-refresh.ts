import {featureAt,CHECKPOINTS} from './conversion-runtime/features.js';
import {administrative,paymentSignal} from './conversion-runtime/evidence.js';
import {scoreContactForecast,forecastPageName,type ForecastCache} from './contact-forecast';
type Db={from:(table:string)=>any;rpc:(name:string,args:Record<string,unknown>)=>any};
const HOUR=3_600_000;
async function graph(url:URL,token:string){
 if(url.protocol!=='https:'||url.hostname!=='graph.facebook.com')throw Error('Invalid history cursor');
 url.searchParams.delete('access_token');
 const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`},cache:'no-store',signal:AbortSignal.timeout(6000)}),body=await response.json();
 if(!response.ok||body.error)throw Error('Verified Messenger history is unavailable');
 return body;
}
export function projectionCacheFromMessages(raw:any[],input:{contactId:string;pageId:string;facebookPageId:string;psid:string;cutoff:number;previous?:ForecastCache|null}):ForecastCache{
 const unique=[...new Map(raw.map(m=>[m.id,m])).values()];
 const seq=unique.map(m=>({id:m.id,ms:Date.parse(m.created_time),text:String(m.message||'').normalize('NFKC'),sender:m.from?.id===input.psid?'contact':m.from?.id===input.facebookPageId?'page':'other',attachments:m.attachments?.data||[]}))
  .filter(m=>typeof m.id==='string'&&Number.isFinite(m.ms)&&m.ms<=input.cutoff).sort((a,b)=>a.ms-b.ms||a.id.localeCompare(b.id)).map((m,i)=>({...m,i}));
 const buyer=seq.find(m=>m.sender==='contact'&&!administrative(m.text));
 if(!buyer)throw Error('No identifiable customer inquiry in accessible history');
 const previous=input.previous,first=Math.min(buyer.ms,previous?Date.parse(previous.first_inquiry_at):Infinity);
 const missingOlder=buyer.ms>first;
 const snapshots=missingOlder&&previous?previous.snapshots:CHECKPOINTS.filter((h:number)=>first+h*HOUR<=input.cutoff).map((h:number)=>{const f=featureAt(seq.map(m=>({...m})),first,h);return {h:f.h,i:f.i,s:f.s,b:f.b,industry_evidence_id:f.industry_evidence_id,industry_evidence_ms:f.industry_evidence_ms,inbound:f.inbound,quoted:f.quoted,form:f.form,duration:f.duration,returned:f.returned,price_question:f.price_question,last_inbound_h:f.last_inbound_h};});
 let paymentAt=previous?.payment_at||null,evidenceId=previous?.payment_evidence_id||null;
 for(const m of seq){if(m.ms<first)continue;const signal=paymentSignal(m,seq);if(signal?.confirmed&&['payment_ack','full_payment_ack'].includes(signal.kind)&&(!paymentAt||m.ms<Date.parse(paymentAt))){paymentAt=new Date(m.ms).toISOString();evidenceId=m.id;}}
 return {contact_id:input.contactId,page_id:input.pageId,first_inquiry_at:new Date(first).toISOString(),first_message_id:missingOlder?previous?.first_message_id||null:buyer.id,source_cutoff_at:new Date(input.cutoff).toISOString(),snapshots,payment_at:paymentAt,payment_evidence_id:evidenceId,source_kind:'live_graph',complete_history:true,dirty_at:null};
}
export async function refreshContactProjection(db:Db,pageId:string,contactId:string,force=false){
 const [contactResult,pageResult,cacheResult]=await Promise.all([
  db.from('contacts').select('id,psid,pipeline_stage').eq('page_id',pageId).eq('id',contactId).maybeSingle(),
  db.from('pages').select('id,name,fb_page_id,access_token').eq('id',pageId).maybeSingle(),
  db.from('contact_conversion_cache').select('*').eq('page_id',pageId).eq('contact_id',contactId).maybeSingle()
 ]);
 if(contactResult.error||pageResult.error||cacheResult.error)throw Error('Could not load projection sources');
 const contact=contactResult.data,page=pageResult.data,previous=cacheResult.data as ForecastCache|null;
 if(!contact||!page)throw Error('Contact not found');
 const pageName=forecastPageName(page.fb_page_id),cached=scoreContactForecast(previous,pageName);
 if(cached.status==='unsupported_page')return cached;
 if(previous&&!cached.needs_refresh&&!force)return{...cached,...(contact.pipeline_stage==='converted'&&!previous.payment_at?{status:'payment_verification_needed',scores:null,close_window:null,close_windows:{}}:{}),from_cache:true};
 const cutoff=Date.now(),fields='id,messages.limit(100){id,message,from,created_time,attachments{mime_type,image_data}}';
 const url=new URL(`https://graph.facebook.com/v24.0/${page.fb_page_id}/conversations`);
 url.searchParams.set('user_id',contact.psid);url.searchParams.set('fields',fields);url.searchParams.set('limit','1');
 const thread=(await graph(url,page.access_token)).data?.[0];
 if(!thread?.messages)throw Error('No accessible conversation for this contact');
 let next=thread.messages.paging?.next,raw=[...(thread.messages.data||[])];const seen=new Set<string>(),deadline=Date.now()+80_000;
 while(next){
  if(raw.length>=5000||seen.has(next)||Date.now()>deadline)throw Error('Complete history could not be verified within this refresh; no partial projection saved');
  seen.add(next);const body=await graph(new URL(next),page.access_token);raw.push(...(body.data||[]));next=body.paging?.next;
 }
 const verified=projectionCacheFromMessages(raw,{contactId,pageId,facebookPageId:page.fb_page_id,psid:contact.psid,cutoff,previous});
 const saved=await db.rpc('save_contact_conversion_cache',{p_page_id:pageId,p_contact_id:contactId,p_payload:verified});
 if(saved.error||!saved.data)throw Error('Could not save verified projection');
 const cache=saved.data as ForecastCache;
 let prediction:any=scoreContactForecast(cache,pageName);
 if(contact.pipeline_stage==='converted'&&!cache.payment_at)prediction={...prediction,status:'payment_verification_needed',scores:null,close_window:null,close_windows:{},message:'CRM converted is recorded, but payment evidence has not been verified in this source.'};
 const hour=new Date(Math.floor(Date.now()/HOUR)*HOUR).toISOString();
 await db.from('contact_conversion_prediction_issues').upsert({page_id:pageId,contact_id:contactId,model_version:prediction.model_version,score_hour:hour,source_cutoff_at:cache.source_cutoff_at,prediction},{onConflict:'contact_id,model_version,score_hour',ignoreDuplicates:true});
 return prediction;
}
