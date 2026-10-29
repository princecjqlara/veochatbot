import{qualityForAdRow}from'./lead-quality';
export function visibleAdRows(pages:any[]){
 return pages.flatMap(p=>{
  const merged=new Map<string,any>();
  for(const row of p.rows||[])merged.set(row.ad_id||'unknown',{...row});
  for(const ad of p.tracked_ads||[]){const measured=merged.get(ad.ad_id);merged.set(ad.ad_id,{...ad,inquiries:0,not_qualified:0,qualified:0,pending:0,opted_out:0,crm_converted:0,order_created:0,not_qualified_rate:null,not_qualified_assessed_rate:null,legacy_dates:0,...measured,referral_events:ad.referral_events,referral_contacts:ad.referral_contacts});}
  return[...merged.values()].map(ad=>({page:p.page,ad:{...ad,lead_quality:qualityForAdRow(ad)}}));
 });
}
export function sortAdRows(rows:any[],sort:string){return[...rows].sort((a,b)=>(sort==='tracked'?Number(!!b.ad.ad_id)-Number(!!a.ad.ad_id):0)||(sort==='rate'?Number(b.ad.not_qualified_rate)-Number(a.ad.not_qualified_rate):Number(b.ad.not_qualified)-Number(a.ad.not_qualified))||Number(b.ad.inquiries)-Number(a.ad.inquiries));}
