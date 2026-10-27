// Generated from the timestamp-safe, backtested historical extractor.
import{industryMatches,classifyIndustry}from'./taxonomy.js';
import{administrative}from'./evidence.js';
export const CHECKPOINTS=[0,1,6,24,72,168,336];
export const UNKNOWN='Unknown / insufficient business detail';
function candidatesFrom(seq,industryMatches,DAY){
const genericClient=/^(?:hi|hello|hey|good (?:morning|afternoon|evening)|interested|yes|opo|oo|okay|ok|sige|cge|thanks?|thank you|details|info|learn more|can i (?:get|have) (?:more )?(?:information|info|details)|is (?:this|it) (?:still )?available)(?:\s+(?:po|sir|ma'?am|pls|please))*[!.,?\s]*$/i;
const priceQ=/mag\s*kano|how much|\bhm\b|presyo|\bprice\b|\brates?\b/i;
const businessQ=/\b(?:ano|anong|what|which)\s+(?:(?:po|pong|ba|bang|yung|ang|inyong|your|is|kind|type|of|name|ng)\s+){0,7}(?:business|negosyo|company|brand)\b|(?:malaman|know).{0,20}(?:business|negosyo|company)|(?:business|negosyo)\s+(?:po\s+)?(?:nila|ninyo|nyo|mo)\s*\?/i;
const creative=/\b(?:scene\s*\d|visuals?|dialogue|voice.?over|CTA|hook)\s*:/i;
const labels=/^\s*(?:[\d).•*#_\s-]*)(business\s*(?:name|type|industry|description)?|company\s*name|brand\s*name|pangalan ng negosyo|negosyo|products?(?:\s*[/&]\s*services?)?|services?(?:\s*offered)?|type of business|industry|specialty\s*[/&]\s*products)\s*(?:[:：=]\s*(.*)|$)/i;
const nextField=/^\s*[\d).•*#_\s-]*(?:business\s*(?:name|page|type|industry|description|location)|company\s*name|brand\s*name|products?|services?|specialty|type of business|industry|page\s*[/：:]|social\s*media|location|address|main\s*(?:problem|goal)|goal|purpose|preferred|contact|phone|work\s*phone|full\s*name|email|portrait|landscape|tagline|english or tagalog|what is the best time|how much is your budget|how long do you want)\b/i;
const useful=t=>t&&t.length>2&&!/^(?:not stated|unknown|none|n\/?a|wala|to follow|yes|no|opo|ok|okay|business name|company name|https?:|please|sample|example|your business|e\.g\.)\b/i.test(t)&&!/^[_\.\s-]+$/.test(t);
 const candidates=[];let incoming=0;
 for(const m of seq){if(m.sender!=='contact')continue;incoming++;const t=m.text;if(!t.trim())continue;
  const ownLabels=[],lines=t.split(/\r?\n/);let productFields=false;
  for(let li=0;li<lines.length;li++){const match=lines[li].match(labels);if(!match)continue;const values=[(match[2]||'').trim()];for(let j=li+1;j<Math.min(lines.length,li+9);j++){if(nextField.test(lines[j]))break;if(lines[j].trim())values.push(lines[j].trim());}const value=values.filter(Boolean).join(' ');if(useful(value)){ownLabels.push(value.replace(/[*_]+$/,'').trim());if(/product|service|specialty|industry|business\s*type|business\s*description/i.test(match[1]))productFields=true;}}
  if(ownLabels.length)candidates.push({text:ownLabels.join(' | '),ms:m.ms,id:m.id,index:m.i,weight:productFields?120:110,kind:'Customer business / product / service fields',specific:ownLabels.join(' | ')});
  const prev=seq.slice(Math.max(0,m.i-8),m.i).filter(x=>x.sender==='page'&&m.ms-x.ms<DAY);
  const answerBusiness=t.length<500&&prev.some(x=>businessQ.test(x.text))&&!genericClient.test(t)&&!priceQ.test(t)&&!/^\s*\d+(?:\s*(?:s|sec|seconds|mins|minutes|po))?[.!?\s]*$/i.test(t)&&!/^\s*(?:ilan|anong|paano|pano|how|what|where|can|may|meron)\b/i.test(t)&&!t.includes('?')&&!/sample|legit|scam|discount|mag.?avail|interested|send.*details/i.test(t)&&useful(t);
  const own=/\b(?:business|negosyo|company|brand|shop|store)\s+(?:ko|namin|naten|natin|is)|\b(?:my|our)\s+(?:business|company|shop|store)|\b(?:i have|we have|nagbebenta|nagtitinda|i sell|we sell)\b/i.test(t);
  if(answerBusiness&&!creative.test(t))candidates.push({text:t,ms:m.ms,id:m.id,index:m.i,weight:85,kind:'Customer answer to business question',specific:t});
  if(own&&t.length<1500&&!creative.test(t))candidates.push({text:t,ms:m.ms,id:m.id,index:m.i,weight:90,kind:'Customer states own business',specific:t});
  const serviceList=t.match(/(?:include\s+(?:our|my)\s+services?|services?\s*offered|our\s+products?\s*(?:are|include))\s*[:：]?\s*([\s\S]{5,1000})/i);if(serviceList)candidates.push({text:serviceList[1],ms:m.ms,id:m.id,index:m.i,weight:120,kind:'Customer lists own offered products or services',specific:serviceList[1]});
  if(incoming<=6&&t.length<500&&!creative.test(t)&&!genericClient.test(t)&&industryMatches(t).length&&new Set(industryMatches(t).map(h=>h.industry)).size<=3){
   const requestingOurService=!own&&!answerBusiness&&industryMatches(t).every(h=>h.industry==='Marketing / Digital Services')&&/how|magkano|price|cost|need|looking|services?\s*(?:nyo|ninyo)|can you|offer/i.test(t);
   if(!requestingOurService)candidates.push({text:t,ms:m.ms,id:m.id,index:m.i,weight:40,kind:'Industry-specific customer inquiry; ownership not independently verified',specific:t});
  }
 }

return candidates;
}
const priceQ=/mag\s*kano|how much|\bhm\b|presyo|\bprice\b|\brates?\b/i;
const money=/(?:\u20b1|PHP\s*|\bP\s*)\d[\d,]*(?:\.\d{1,2})?/i;
const fields=/^\s*[\d).\u2022*#_\s-]*(business\s*name|company\s*name|brand\s*name|page\s*[/ :]?[^:]{0,20}|location|address|goal\s*(?:ng\s*)?video|preferred\s*(?:video\s*)?length|preferred\s*style|contact\s*number)\s*[:=]\s*(.*)/i;
export function isQuote(t){
 if(/\b(?:scene\s*\d|visuals?|dialogue|voice.?over|CTA)\s*:/i.test(t)||administrative(t))return false;
 return t.split(/\r?\n/).some(l=>money.test(l)&&!/(?:down\s*payment|downpayment|revision|balance|voucher|cashback|bank\s*fee|\bdp\b)/i.test(l)&&(/package|promo|price|seconds?|\d\s*s\b|commercial|video|only|starter|best\s*seller/i.test(t)));
}
export function formFields(t){return t.split(/\r?\n/).map(l=>l.match(fields)).filter(m=>m&&m[2].replace(/[\s_.-]/g,'').length>1&& !/^(?:n\/?a|none|to follow)$/i.test(m[2].trim())).length;}
export function featureAt(messages,firstMs,ageHours){
 const stop=firstMs+ageHours*3600000,seq=messages.filter(m=>m.ms>=firstMs&&m.ms<=stop);
 seq.forEach((m,i)=>m.i=i);
 const buyer=seq.filter(m=>m.sender==='contact'&&!administrative(m.text)),page=seq.filter(m=>m.sender==='page'&&!administrative(m.text));
 const candidates=candidatesFrom(seq,industryMatches,86400000),classified=classifyIndustry(candidates),proof=classified.evidence;
 const quoted=page.find(m=>isQuote(m.text)),repliedAfterQuote=!!quoted&&buyer.some(m=>m.ms>quoted.ms),filled=buyer.some(m=>formFields(m.text)>=2);
 const duration=buyer.some(m=>m.text.length<400&&/\b\d{1,3}\s*(?:s\b|secs?\b|seconds?\b|mins?\b|minutes?\b)/i.test(m.text)&&!priceQ.test(m.text));
 const returned=buyer.some(m=>m.ms-firstMs>=86400000),state=filled?'form_details':repliedAfterQuote?'replied_after_quote':duration?'duration_chosen':returned?'returned_later':buyer.length>=3?'active_conversation':'initial_inquiry';
 const location=buyer.flatMap(m=>m.text.split(/\r?\n/)).map(l=>l.match(/^\s*[\d).\s*-]*(?:business\s*location|location|address)\s*[:=]\s*(.{3,180})$/i)).filter(Boolean).at(-1)?.[1]?.trim()||null;
 return {h:ageHours,i:classified.industry,s:classified.subtype,b:state,inbound:buyer.length,quoted:!!quoted,form:filled,duration,returned,price_question:buyer.some(m=>m.text.length<700&&priceQ.test(m.text)),last_inbound_h:buyer.length?(buyer.at(-1).ms-firstMs)/3600000:null,
  industry_evidence_id:proof?.id||null,industry_evidence_ms:proof?.ms??null,location,location_basis:location?'Explicit customer location/address field; not standardized':'Unknown',personal_age:null,personal_gender:null};
}
