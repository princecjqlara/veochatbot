import{safeAdMediaUrl}from'./ad-attribution';
const numeric=(x:unknown):string|null=>typeof x==='string'&&/^\d{1,100}$/.test(x)?x:null;
const text=(x:unknown,max=500)=>typeof x==='string'&&x.trim()?x.trim().slice(0,max):null;
export class MetaAdAccessError extends Error{constructor(public code:number|string,public reconnect=false){super(reconnect?'Connect Facebook with ad-account read access.':'Facebook ad details are temporarily unavailable.');}}
export async function readMetaAds(path:string,token:string,params:Record<string,string>={}){
 const url=new URL('https://graph.facebook.com/v24.0/'+path);for(const[k,v]of Object.entries(params))url.searchParams.set(k,v);
 let response:Response,body:any;
 try{response=await fetch(url,{headers:{Authorization:'Bearer '+token},cache:'no-store',signal:AbortSignal.timeout(8000)});body=await response.json();}catch{throw new MetaAdAccessError('META_UNAVAILABLE');}
 if(!response.ok||body.error)throw new MetaAdAccessError(body.error?.code||response.status,[10,190,200,294].includes(body.error?.code));return body;
}
export async function marketingConnection(token?:string){
 if(!token)return{status:'connect_required',accounts:[],message:'Connect Facebook ad details to read your Ads Manager inventory. Recorded Messenger ads and Page previews remain available.'};
 try{
  const result=await readMetaAds('me/permissions',token);const granted=new Set((result.data||[]).filter((p:any)=>p.status==='granted').map((p:any)=>p.permission));
  if(!granted.has('ads_read')&&!granted.has('ads_management'))return{status:'permission_required',accounts:[],message:'Your Facebook login has Page access but no ad-account read permission. Reconnect with ads_read to import all ads and their Ads Manager names.'};
  const accounts=[];let after:string|undefined;
  for(let i=0;i<4;i++){const page=await readMetaAds('me/adaccounts',token,{fields:'id,name,account_status,currency',limit:'25',...(after?{after}:{})});accounts.push(...(page.data||[]).filter((a:any)=>/^act_\d+$/.test(a.id)).map((a:any)=>({id:a.id,name:text(a.name),currency:text(a.currency,10),status:a.account_status})));if(!page.paging?.next)return{status:'ready',accounts,message:accounts.length?'Ad-account read access is connected.':'Facebook returned no accessible ad accounts.'};after=page.paging?.cursors?.after;if(!after)break;}
  return{status:'ready',accounts,partial:true,message:'Showing the first 100 accessible ad accounts.'};
 }catch(e){const error=e as MetaAdAccessError;return{status:error.reconnect?'reconnect_required':'temporarily_unavailable',accounts:[],error_code:error.code,message:error.message};}
}
/** Only authoritative creative Page identifiers may map imported ads to a Page. */
export function creativePageId(ad:any){
 const creative=ad?.creative||{},ids=[numeric(creative.object_story_spec?.page_id),numeric(String(creative.effective_object_story_id||'').split('_').length===2?creative.effective_object_story_id.split('_')[0]:null),numeric(String(creative.object_story_id||'').split('_').length===2?creative.object_story_id.split('_')[0]:null)].filter((x):x is string=>!!x);
 return new Set(ids).size===1?ids[0]:null;
}
export function catalogMetadata(ad:any,pageId:string){
 const creative=ad.creative||{};
 return{page_id:pageId,ad_id:numeric(ad.id),ad_name:text(ad.name),ad_account_id:numeric(ad.account_id),ad_status:text(ad.effective_status,60),creative_id:numeric(creative.id),creative_name:text(creative.name),photo_url:safeAdMediaUrl(creative.thumbnail_url),post_id:text(creative.effective_object_story_id||creative.object_story_id,100),campaign_id:numeric(ad.campaign?.id),campaign_name:text(ad.campaign?.name),adset_id:numeric(ad.adset?.id),adset_name:text(ad.adset?.name),metadata_source:'marketing_api',metadata_status:'available',metadata_error_code:null};
}
export async function resolveAdCreative(input:{pageId:string;facebookPageId:string;pageToken:string;userToken?:string;ad:{ad_id:string;post_id?:string|null}}){
 const {ad}=input;let patch:any={page_id:input.pageId,ad_id:ad.ad_id,metadata_status:'permissions_needed',metadata_error_code:null},adReadable=false;
 if(input.userToken){try{const body=await readMetaAds(ad.ad_id,input.userToken,{fields:'id,name,account_id,effective_status,campaign{id,name},adset{id,name},creative{id,name,thumbnail_url,effective_object_story_id,object_story_id,object_story_spec}'});if(body.id===ad.ad_id){const page=creativePageId(body);if(page&&page!==input.facebookPageId)throw new MetaAdAccessError('PAGE_MISMATCH');patch={...patch,...catalogMetadata(body,input.pageId)};adReadable=true;}}catch(e){patch.metadata_error_code=typeof(e as MetaAdAccessError).code==='number'?(e as MetaAdAccessError).code:null;}}
 let post=patch.post_id||ad.post_id;
 if(post&&/^\d+(?:_\d+)?$/.test(post)){
  if(!post.includes('_'))post=input.facebookPageId+'_'+post;
  if(post.split('_')[0]===input.facebookPageId){try{
   const body=await readMetaAds(post,input.pageToken,{fields:'id,from{id},full_picture,permalink_url,attachments{type,media_type,media,url,target{id}}'});
   if(body.id===post&&(body.from?.id===input.facebookPageId||!body.from)){
    const photo=safeAdMediaUrl(body.full_picture)||safeAdMediaUrl(body.attachments?.data?.[0]?.media?.image?.src),permalink=safeAdMediaUrl(body.permalink_url);if(photo)patch.photo_url=photo;if(permalink)patch.post_permalink_url=permalink;patch.post_id=post;
    const video=body.attachments?.data?.find((a:any)=>a.media_type==='video');const source=safeAdMediaUrl(video?.media?.source);if(source)patch.video_url=source;
    if(!adReadable){patch.metadata_status='page_post';patch.metadata_source='page_post';patch.metadata_error_code=null;}
   }
  }catch(e){if(!adReadable)patch.metadata_error_code=typeof(e as MetaAdAccessError).code==='number'?(e as MetaAdAccessError).code:null;}}
 }
 return{patch,resolved:adReadable||patch.metadata_status==='page_post',source:patch.metadata_status};
}
