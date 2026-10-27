import crypto from 'node:crypto';
export const DAY=86400000;
export const ms=s=>s?Date.parse(s):null;
export const pht=t=>t==null||!Number.isFinite(t)?null:new Date(t+8*3600000).toISOString().replace('T',' ').slice(0,19);
export const redact=t=>Array.from(String(t||'').replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi,'[email]').replace(/(?:\+?63|0)?9\d(?:[\s-]?\d){8,9}\b/g,'[phone]').replace(/\b\d{9,}\b/g,'[reference]')).slice(0,1100).join('').toWellFormed();
export const administrative=t=>/^(?:you (?:confirmed|created|requested|sent an offer|marked|pinned)|lead stage|assigned|this conversation|messenger automatically|you can call|video call ended)|assigned this conversation|marked this conversation|replied to an ad\.?$/i.test(t);
const future=/\b(?:once|if|before|after|until|will|can i|when|bukas|mamaya|tomorrow|later|kapag|kung|pag|pagka|pagkatapos|paano|pano|magbabayad|magbayad|babayad|magsesend|not yet|hindi pa|di pa|wala pa)\b|\bas\s+long\s+as\b|\b(?:di|hindi)\s+(?:po\s+)?ba\b|\bpagn(?:a|aka)|\bpag\s*na|\?|send ko (?:mamaya|bukas)|mag\s*(?:dp|down|pay|full)|\b(?:not|never)\s+(?:yet\s+)?received|haven'?t\s+received|hindi.{0,12}(?:receive|tanggap)|marked?\s*(?:as\s*)?(?:fully\s*)?paid/i;
const creative=/\b(?:scene\s*\d|visuals?|dialogue|voice.?over|CTA|hook)\s*:/i;
const clientPay=/\b(?:payment|dp|down\s*payment)\s*(?:done|sent|complete|completed|already)\b|\bpaid\s*na\b|\b(?:done|sent)\s*(?:na\s*)?(?:po\s*)?(?:payment|dp|down\s*payment)\b|\b(?:fully paid|already paid|payment made)\b|\b(?:naka ?pag|nag)\s*(?:bayad|pay|down(?:payment)?|dp)\b|\b(?:nag ?send|na ?send|nasend|naipadala|na-transfer|natransfer|sent na).{0,65}(?:gcash|payment|bayad|\bdp\b|down ?payment)|\b(?:bayad|paid) na (?:ko|ako|po|ito|tayo|yan|yun)\b|binayaran ko|binayad ko/i;
const pagePay=/\bpayment\s*(?:received|confirmed)|\b(?:received|confirmed).{0,35}(?:payment|\bdp\b|down\s*payment|bayad)|\b(?:na ?receive|nareceive|na received).{0,40}(?:payment|\bdp\b|down\s*payment|bayad)|(?:payment|down\s*payment|\bdp\b).{0,30}(?:na ?receive|received|confirmed)|\bfully paid (?:na|ka)|\b(?:bayad|paid) na (?:po )?(?:kayo|ito|tayo)/i;
const numeric=x=>Number(String(x).replaceAll(',',''));
export function explicitAmount(text){
 const a=String(text).match(/(?:₱|PHP\s*|\bP\s*)(\d[\d,]*(?:\.\d{1,2})?)(?![\d,])/i);
 return a&&numeric(a[1])>0?numeric(a[1]):null;
}
export function billFields(t){
 const dep=t.match(/(?:down\s*payment|downpayment|deposit|\bdp)\s*[:=\-–]?\s*(?:₱|PHP\s*|P\s*)?([\d,]+(?:\.\d{1,2})?)/i);
 const bal=t.match(/(?:remaining\s*balance|balance\s*to\s*pay|balance|remaining)\s*[:=\-–]\s*(?:₱|PHP\s*|P\s*)?([\d,]+(?:\.\d{1,2})?)/i);
 const packageLine=t.split(/\r?\n/).map(line=>line.match(/(?:package\s*(?:availed|purchased|amount|price|total)?|availed\s*package|promo\s*package|price\s*deal|total\s*(?:package|bill|price|amount|cost))\s*[:=\-–]\s*(.+)/i)).find(Boolean);
 let total=null;
 if(packageLine){const v=packageLine[1];total=explicitAmount(v);if(total==null){const withoutDuration=v.replace(/^\s*\d{1,3}\s*[- ]*\s*(?:s\b|secs?\b|seconds?\b|mins?\b|minutes?\b)\s*/i,'');const only=withoutDuration.match(/^\s*[([]?\s*([\d,]+(?:\.\d{1,2})?)(?![\d,]|\s*[- ]*\s*(?:s\b|secs?\b|seconds?\b|mins?\b|minutes?\b))/i);if(only)total=numeric(only[1]);}}
 const revision=t.match(/revision\s*fee\s*[:=\-–]\s*(?:₱|PHP\s*|P\s*)?([\d,]+(?:\.\d{1,2})?)/i);
 return {deposit:dep&&numeric(dep[1])>0?numeric(dep[1]):null,balance:bal?numeric(bal[1]):null,total:total>0?total:null,revision_fee:revision?numeric(revision[1]):0};
}
export function paymentSignal(m,seq){
 const t=m.text.normalize('NFKC'),short=t.length<900;
 if(administrative(t)||creative.test(t))return null;
 const fields=billFields(t);
 if(m.sender==='page'&&fields.deposit&&fields.balance!=null&&!/sample|example|halimbawa|once|kapag|kung|pag nag|if you|will be|to start|muna po.{0,25}(?:dp|downpayment)/i.test(t)){
  const exactCredit=/deducted|credited|less\s*(?:your|the|paid|₱|PHP|\d)|already\s*(?:paid|received)|paid\s*(?:deposit|downpayment)|downpayment\s*(?:paid|received)|existing\s*deposit/i.test(t);
  return {kind:exactCredit?'credited_deposit':'deposit_bill_candidate',confirmed:exactCredit,amount:fields.deposit,amount_basis:'Existing deposit credited in personalized bill',bill:fields};
 }
 if(short&&!future.test(t)){
  if(m.sender==='page'&&pagePay.test(t))return{kind:/full(?:y)?\s*(?:paid|payment)|bayad na.*buo/i.test(t)?'full_payment_ack':'payment_ack',confirmed:true,amount:explicitAmount(t),amount_basis:'Amount stated in page acknowledgement'};
  if(m.sender==='contact'&&clientPay.test(t)&&!/may nag\s*bayad|saan.{0,25}nag\s*bayad|cupcat|capcut|delivery rider|nagbayad.*(?:bill|tubig|bayarin)|nagbayad.*strix|downpayment na kasi ako dun/i.test(t))return{kind:'customer_payment_report',confirmed:false,amount:explicitAmount(t),amount_basis:'Customer report; not independently confirmed'};
 }
 // Contextual acknowledgements need a customer payment claim AND a nearby customer image.
 if(m.sender==='page'&&short&&t.length<180&&!future.test(t)&&/^(?:[\s\p{P}\p{S}]*)?(?:received|receive|nareceive|na ?receive)(?:\s+(?:na|ko|po|sir|mam|ma'?am|salamat|thank|you|thanks|payment|dp|ito|namin|boss)|[\s\p{P}\p{S}])*$/iu.test(t)){
  const prev=seq.slice(Math.max(0,m.i-5),m.i).filter(x=>m.ms-x.ms<6*3600000);
  if(prev.some(x=>x.sender==='contact'&&clientPay.test(x.text)&&!future.test(x.text))&&prev.some(x=>x.sender==='contact'&&x.attachments.some(a=>a.image_data?.url&&!a.image_data?.render_as_sticker)))return{kind:'contextual_payment_ack',confirmed:true,amount:null,amount_basis:'No amount stated in acknowledgement',context_ids:prev.map(x=>x.id)};
 }
 return null;
}
export function receiptInfo(text,uploadMs){
 const t=String(text||'').normalize('NFKC');
 const success=/(?:sent via gcash|total amount sent|successfully sent|transfer successful|successfully transferred|payment successful|transaction successful|money sent|you have sent|sent to|sent PHP|sent P\d)/i.test(t)&&!/(?:request money|request sent|payment request|transaction failed|unsuccessful|payment failed)/i.test(t);
 const amountMatch=t.match(/(?:^|\n)\s*(?:amount(?:\s*sent)?|send\s*amount|transfer\s*amount|you\s*sent)\s*[:\s]*(?:PHP|₱|P)?\s*([\d,]+\.\d{2})/i)||t.match(/(?:amount\s*sent|you\s*(?:have\s*)?sent)\s*[:\s]*(?:PHP|₱|P)?\s*([\d,]+\.\d{2})/i);
 let amount=amountMatch&&numeric(amountMatch[1])>0?numeric(amountMatch[1]):null,amountBasis=amount!=null?'Amount directly beside an amount-sent label':null;
 // Windows OCR flattens two-column bank receipts: check displayed amount + fee = total.
 const decimal=[...t.matchAll(/\b(\d{1,3}(?:,\d{3})*\.\d{2}|\d{4,7}\.\d{2})\b/g)].map(m=>({value:numeric(m[1]),index:m.index}));
 if(amount==null&&/bank transfer complete|sent via gcash/i.test(t)&&/transfer\s*amount|amount\s*sent/i.test(t)){
  const choices=[];for(let i=0;i<decimal.length-2;i++){const [v,f,total]=decimal.slice(i,i+3).map(x=>x.value);if(v>0&&f>=0&&f<=100&&Math.abs(v+f-total)<.015)choices.push(v);}
  if(new Set(choices).size===1){amount=choices[0];amountBasis='Displayed transfer amount plus fee reconciles to displayed total; flattened bank-receipt layout';}
 }
 if(amount==null&&/transfer\s*successful/i.test(t)&&/transfer\s*amount/i.test(t)&&/\bFREE\b/i.test(t)){
  const cash=[...t.matchAll(/(?:PHP|₱)\s*([\d,]+\.\d{2})/gi)].map(m=>numeric(m[1]));
  if(cash.length>=2&&new Set(cash).size===1){amount=cash[0];amountBasis='Transfer amount and total agree with explicit FREE fee';}
 }
 if(amount==null&&/palawan|reference\s*no|reference\s*number/i.test(t)&&/transfer\s*successful/i.test(t)&&/discount/i.test(t)){
  const cash=[...t.matchAll(/PHP\s*([\d,]+\.\d{2})/gi)].map(m=>numeric(m[1]));
  if(cash.length>=4){const [v,f,d]=cash.slice(-3),headline=cash[0];if(v>0&&f<=100&&d<=f&&Math.abs(v+f-d-headline)<.015){amount=v;amountBasis='Transfer amount + fee - discount reconciles to successful-transfer total';}}
 }
 if(amount==null&&/sent via gcash/i.test(t)&&/total\s*amount\s*sent/i.test(t)&&!/bank\s*transfer/i.test(t)){
  const unique=[...new Set(decimal.map(x=>x.value).filter(x=>x>0))];if(unique.length===1){amount=unique[0];amountBasis='GCash send receipt shows one unambiguous readable amount; total agrees when readable';}
 }
 const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
 let dateMatch=t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+([0-3]?\d)[,;]?\s+(20\d{2})\b/i);
 let transactionDate=dateMatch?`${dateMatch[3]}-${String(months[dateMatch[1].slice(0,3).toLowerCase()]).padStart(2,'0')}-${dateMatch[2].padStart(2,'0')}`:null;
 if(!transactionDate){const m=t.match(/\b([0-3]?\d)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(20\d{2})\b/i);if(m){dateMatch=m;transactionDate=`${m[3]}-${String(months[m[2].slice(0,3).toLowerCase()]).padStart(2,'0')}-${m[1].padStart(2,'0')}`;}}
 if(!transactionDate){const m=t.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);if(m&&(Number(m[1])>12||Number(m[2])>12)){dateMatch=m;const month=Number(m[1])>12?m[2]:m[1],day=Number(m[1])>12?m[1]:m[2];transactionDate=`${m[3]}-${month.padStart(2,'0')}-${day.padStart(2,'0')}`;}}
 // Only a time beside the receipt date can supply transaction time. Preserve minute precision.
 const nearDate=dateMatch?t.slice(Math.max(0,dateMatch.index-75),dateMatch.index+dateMatch[0].length+75):'';
 const times=[...nearDate.matchAll(/\b(1[0-2]|0?[1-9]):([0-5]\d)(?::([0-5]\d))?\s*([AP])\.?M\.?\b/gi)];
 const timeMatch=times.length===1?times[0]:null;
 let transactionTime=null,transactionMs=null,transactionPrecision=transactionDate?'date':null;
 if(transactionDate&&timeMatch){const h=Number(timeMatch[1])%12+(timeMatch[4].toUpperCase()==='P'?12:0);transactionTime=`${String(h).padStart(2,'0')}:${timeMatch[2]}`+(timeMatch[3]?':'+timeMatch[3]:'');transactionPrecision=timeMatch[3]?'second':'minute';const parsed=Date.parse(transactionDate+'T'+transactionTime+'+08:00');transactionMs=transactionPrecision==='second'?parsed:null;if(!Number.isFinite(parsed)||parsed>uploadMs+5*60000){transactionMs=null;transactionTime=null;transactionPrecision='date';}}
 if(transactionDate&&Date.parse(transactionDate+'T00:00:00+08:00')>uploadMs+DAY)transactionDate=null;
 let ref=t.match(/(?:ref(?:erence)?(?:\s*(?:no|number|#))?|transaction\s*(?:id|no|number))\s*[:#.\s]*([A-Z]{0,5}\d{10,25})\b/i)?.[1]||null;
 if(!ref&&/reference\s*number/i.test(t))ref=t.match(/\b(BC\d{15,25})\b/i)?.[1]||null;
 if(!ref&&dateMatch&&/bank transfer complete/i.test(t)&&/invoice\s*no.*ref\s*no/i.test(t)){const tail=t.slice(dateMatch.index+dateMatch[0].length).split(/by going digital|powered by/i)[0];const numbers=[...tail.matchAll(/\b(\d{10,25})\b/g)];if(numbers.length>=2)ref=numbers.at(-1)[1];}
 const fingerprint=ref?crypto.createHash('sha256').update(ref.toUpperCase()).digest('hex').slice(0,20):null;
 return{success,amount,amountBasis,transactionDate,transactionTime,transactionMs,transactionPrecision,fingerprint,currency:/gcash|maya|PHP|₱|pesos?/i.test(t)?'PHP':null};
}
export function durationChoice(t){
 const m=t.match(/\b(\d{1,3})\s*(s\b|secs?\b|seconds?\b|mins?\b|minutes?\b)/i);
 if(!m)return null;const seconds=Number(m[1])*(/^m/i.test(m[2])?60:1);return seconds>=5&&seconds<=600?seconds:null;
}
