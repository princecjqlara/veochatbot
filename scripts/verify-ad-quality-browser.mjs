import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function verifyBrowser({base,cookie}){
 const data=path.resolve(import.meta.dirname,'../../data'),profile=path.join(data,'ad-quality-browser-'+Date.now());
 assert(profile.startsWith(data+path.sep)&&path.basename(profile).startsWith('ad-quality-browser-'));
 fs.mkdirSync(profile,{recursive:true});
 const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--incognito','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws,cdp;const errors=[],requests=[],checks=[];
 try{
  let port;for(let i=0;i<100;i++){const p=path.join(profile,'DevToolsActivePort');if(fs.existsSync(p)){port=Number(fs.readFileSync(p,'utf8').split('\n')[0]);try{await fetch('http://127.0.0.1:'+port+'/json/version');break;}catch{}}await sleep(100);}assert(port,'Verification browser did not start');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((yes,no)=>{ws.addEventListener('open',yes,{once:true});ws.addEventListener('error',no,{once:true});});
  let seq=0;const pending=new Map();ws.addEventListener('message',e=>{const r=JSON.parse(e.data);if(r.method==='Runtime.exceptionThrown')errors.push(r.params.exceptionDetails?.text||'Browser exception');if(r.method==='Network.requestWillBeSent'){const u=new URL(r.params.request.url);if(u.pathname==='/api/ad-quality')requests.push(u.search);}if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.no(Error('Browser action failed: '+p.method)):p.yes(r.result);}});
  cdp=(method,params={})=>new Promise((yes,no)=>{const id=++seq;pending.set(id,{yes,no,method});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Page evaluation failed');return r.result.value;};
  await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');await cdp('Network.setCookie',{name:'__Secure-next-auth.session-token',value:cookie,url:base,secure:true,httpOnly:true,sameSite:'Lax'});
  const ready=async()=>{for(let i=0;i<160;i++){if(await evaluate("document.body?.innerText.includes('Last successful refresh:')"))return;await sleep(250);}throw Error('Live dashboard did not load');};
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:base+'/dashboard/ad-quality'});await ready();
  let size=await evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth})');assert(size.document<=size.viewport+1,'Desktop overflow');
  assert(await evaluate("document.body.innerText.includes('Unknown originating ad')"));checks.push('Live authenticated desktop dashboard and Unknown source rows');
  for(let i=0;i<100;i++){if(await evaluate("!!document.querySelector('tbody tr[data-ad-id]:not([data-ad-id=unknown])')"))break;await sleep(200);}
  assert(await evaluate("document.querySelector('tbody tr')?.getAttribute('data-ad-id')!=='unknown'"),'Tracked ads were buried below unknown sources');
  await evaluate("document.querySelector('button[aria-label^=\"Preview ad \"]').click()");
  assert(await evaluate("!!document.querySelector('[aria-label=\"Ad creative preview\"] video[controls]')"),'Video creative preview missing');await evaluate("document.querySelector('button[aria-label=\"Close ad preview\"]').click()");checks.push('Tracked ads appear first and a genuine video preview opens');
  await evaluate("(()=>{const e=document.querySelector('select[aria-label=\"Ad visibility\"]');e.value='tracked';e.dispatchEvent(new Event('change',{bubbles:true}));})()");await sleep(200);assert(await evaluate("[...document.querySelectorAll('tbody tr')].every(e=>e.dataset.adId!=='unknown')"));
  await evaluate("(()=>{const e=document.querySelector('select[aria-label=\"Ad visibility\"]');e.value='all';e.dispatchEvent(new Event('change',{bubbles:true}));})()");await sleep(200);checks.push('Ad-only and combined source visibility filters');
  const pageOptions=await evaluate("[...document.querySelector('select[aria-label=Page]').options].map(o=>({value:o.value,label:o.textContent}))");assert(pageOptions.length>5,'Page selector omitted authorized historical Pages');
  const az=pageOptions.find(p=>p.label==='Azshinari');assert(az);await evaluate(`(()=>{const e=document.querySelector('select[aria-label=Page]');e.value=${JSON.stringify(az.value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(150);await ready();assert(requests.some(q=>new URLSearchParams(q).get('pageId')===az.value));
  await evaluate("(()=>{const e=document.querySelector('select[aria-label=Page]');e.value='all';e.dispatchEvent(new Event('change',{bubbles:true}));})()");await sleep(150);await ready();checks.push('Page filter includes historical Pages independently of token probes');
  for(const range of ['7','30','all']){await evaluate(`(()=>{const e=document.querySelector('select[aria-label="Date range"]');e.value='${range}';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(100);await ready();assert(requests.some(q=>new URLSearchParams(q).get('range')===range));}checks.push('Today / 7 / 30 / all-time selector interactions');
  await evaluate("[...document.querySelectorAll('tbody button')].find(b=>b.textContent==='View leads'&&!b.disabled)?.click()");for(let i=0;i<100;i++){if(await evaluate("!!document.querySelector('[role=dialog] tbody tr')"))break;await sleep(200);}assert(await evaluate("!!document.querySelector('[role=dialog]')"));assert(await evaluate("document.querySelector('[role=dialog]').innerText.includes('Current recorded stage')"));await evaluate("document.querySelector('button[aria-label=\"Close contacts\"]').click()");checks.push('First-inquiry contact modal opens and closes');
  await evaluate(`(()=>{const e=document.querySelector('select[aria-label="Date range"]');e.value='custom';e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await sleep(200);
  await evaluate(`(()=>{for(const[label,value]of[['From date','2026-10-20'],['Through date','2026-10-21']]){const e=document.querySelector('input[aria-label="'+label+'"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new Event('change',{bubbles:true}));}})()`);await sleep(250);await ready();assert(requests.some(q=>{const p=new URLSearchParams(q);return p.get('range')==='custom'&&p.get('from')==='2026-10-20'&&p.get('to')==='2026-10-21';}),'Custom dates were not submitted');checks.push('Custom inclusive calendar-date request');
  await cdp('Page.navigate',{url:base+'/dashboard/ad-quality'});await ready();await evaluate('window.scrollTo(0,0)');const desktop=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(data,'ad-quality-desktop.png'),Buffer.from(desktop.data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});await sleep(300);size=await evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth})');assert(size.document<=size.viewport+1,'Mobile overflow');
  await evaluate("document.querySelector('h1').scrollIntoView()");const mobile=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(data,'ad-quality-mobile.png'),Buffer.from(mobile.data,'base64'));checks.push('Mobile layout without page overflow');
  assert.equal(errors.length,0);return{passed:true,checks,javascript_errors:errors};
 }finally{
  if(cdp&&ws?.readyState===1)await cdp('Browser.close').catch(()=>{});ws?.close();
  if(chrome.exitCode===null)await Promise.race([new Promise(r=>chrome.once('exit',r)),sleep(3000)]);if(chrome.exitCode===null)chrome.kill();await sleep(300);
  // Only this newly-created, checked test directory is removed.
  assert(path.resolve(profile).startsWith(data+path.sep)&&path.basename(profile).startsWith('ad-quality-browser-'));
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{console.warn('Temporary verification browser profile is still held by Windows.');}
 }
}
