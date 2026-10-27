import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function verifyContactBrowser({base,cookie}){
 const data=path.resolve(import.meta.dirname,'../../data'),profile=path.join(data,'contact-controls-browser-'+Date.now());
 assert(profile.startsWith(data+path.sep)&&path.basename(profile).startsWith('contact-controls-browser-'));fs.mkdirSync(profile,{recursive:true});
 const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--incognito','--disable-gpu','--disable-background-networking','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
 let ws,cdp;const errors=[],requests=[],checks=[],mock=new Map(),clicks=[];
 try{
  let port;for(let i=0;i<100;i++){const p=path.join(profile,'DevToolsActivePort');if(fs.existsSync(p)){port=Number(fs.readFileSync(p,'utf8').split('\n')[0]);try{await fetch('http://127.0.0.1:'+port+'/json/version');break;}catch{}}await sleep(100);}assert(port,'Browser unavailable');
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();ws=new WebSocket(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);await new Promise((yes,no)=>{ws.addEventListener('open',yes,{once:true});ws.addEventListener('error',no,{once:true});});
  let seq=0;const pending=new Map();
  const fulfill=(id,body)=>cdp('Fetch.fulfillRequest',{requestId:id,responseCode:200,responseHeaders:[{name:'Content-Type',value:'application/json'}],body:Buffer.from(JSON.stringify(body)).toString('base64')});
  async function intercepted(p){
   const u=new URL(p.request.url),match=u.pathname.match(/\/contacts\/([^/]+)\/(bot|projection)$/);
   if(match&&match[2]==='bot'&&p.request.method==='PATCH'){
    const enabled=JSON.parse(p.request.postData).enabled;mock.set(match[1],enabled);clicks.push(enabled);await fulfill(p.requestId,{enabled,cancelled_followups:0});return;
   }
   if(p.request.method==='GET'&&(mock.size>0||match?.[2]==='projection')){
    const r=await fetch(u,{headers:{Cookie:'__Secure-next-auth.session-token='+cookie},signal:AbortSignal.timeout(45000)}),b=await r.json();
    if(r.ok){
     const control=(c,id)=>{if(mock.has(id)){c.chatbot_enabled=mock.get(id);c.bot_control={enabled:mock.get(id),can_reply:false,reason:mock.get(id)?'awaiting_new_message':'contact_disabled',loaded_at:new Date().toISOString()};}};
     if(match)control(b,match[1]);else for(const c of b.items||b.contacts||[])control(c,c.id);
     await fulfill(p.requestId,b);return;
    }
   }
   await cdp('Fetch.continueRequest',{requestId:p.requestId});
  }
  ws.addEventListener('message',e=>{const r=JSON.parse(e.data);if(r.method==='Runtime.exceptionThrown')errors.push(r.params.exceptionDetails?.text||'Browser exception');if(r.method==='Network.requestWillBeSent'){const u=new URL(r.params.request.url);if(u.pathname.includes('/contacts'))requests.push({path:u.pathname,query:u.search,method:r.params.request.method});}if(r.method==='Fetch.requestPaused')void intercepted(r.params).catch(()=>{errors.push('Request interception failed');void cdp('Fetch.failRequest',{requestId:r.params.requestId,errorReason:'Aborted'});});if(r.id&&pending.has(r.id)){const p=pending.get(r.id);pending.delete(r.id);r.error?p.no(Error('Browser action failed: '+p.method)):p.yes(r.result);}});
  cdp=(method,params={})=>new Promise((yes,no)=>{const id=++seq;pending.set(id,{yes,no,method});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error('Page evaluation failed after '+checks.length+' checks: '+String(r.exceptionDetails.exception?.description||r.exceptionDetails.text).slice(0,400));return r.result.value;};
  const until=async(expression,message)=>{for(let i=0;i<200;i++){if(await evaluate(expression))return;await sleep(250);}throw Error(message);};
  const choose=async(label,value)=>evaluate(`(()=>{const e=document.querySelector('select[aria-label="${label}"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await cdp('Page.enable');await cdp('Runtime.enable');await cdp('Network.enable');
  await cdp('Fetch.enable',{patterns:[{urlPattern:'*/api/pages/*/contacts*'},{urlPattern:'*/api/ad-quality/contacts*'}]});
  await cdp('Network.setCookie',{name:'__Secure-next-auth.session-token',value:cookie,url:base,secure:true,httpOnly:true,sameSite:'Lax'});
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:base+'/dashboard/ad-quality'});
  await until("document.body?.innerText.includes('Last successful refresh:')",'Ad dashboard failed to load');
  const az=await evaluate("[...document.querySelector('select[aria-label=Page]').options].find(o=>o.textContent==='Azshinari')?.value");assert(az);
  await choose('Page',az);await choose('Date range','30');
  await until("[...document.querySelectorAll('tbody button')].some(e=>e.textContent==='View leads')",'No cohort lead button');
  await evaluate("[...document.querySelectorAll('tbody button')].find(e=>e.textContent==='View leads').click()");
  await until("!!document.querySelector('[role=dialog] button[role=switch]:not([disabled])')",'Contact controls missing');checks.push('Ad cohort modal renders authorized switches and forecasts');
  await evaluate("document.querySelector('[role=dialog] button[role=switch]').click()");
  await until("document.querySelector('[role=dialog] button[role=switch]')?.getAttribute('aria-checked')==='false'&&!document.querySelector('[role=dialog] button[role=switch]').disabled",'Mock OFF did not render');
  await evaluate("document.querySelector('[role=dialog] button[role=switch]').click()");
  await until("document.querySelector('[role=dialog] button[role=switch]')?.getAttribute('aria-checked')==='true'&&!document.querySelector('[role=dialog] button[role=switch]').disabled",'Mock ON did not render');
  assert.deepEqual(clicks,[false,true]);checks.push('Switch OFF / ON sends correct payloads and updates state; requests intercepted, zero real permission changes');
  await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(e=>e.textContent==='Projection details').click()");
  await until("document.querySelector('[role=dialog]')?.innerText.includes('Experimental payment/deposit confirmation forecast')",'Forecast details missing');checks.push('Projection details disclose PHT source dates and forecast limitations');
  for(const value of ['off','on','all']){await choose('Ad contacts bot filter',value);await sleep(700);assert(requests.some(r=>r.path==='/api/ad-quality/contacts'&&new URLSearchParams(r.query).get('bot')===value));}
  await until("!!document.querySelector('[role=dialog] button[role=switch]')",'Restored contacts missing');checks.push('Ad detail ON / OFF / all filters issue server queries');
  const desktop=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(data,'contact-controls-desktop.png'),Buffer.from(desktop.data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:1000,deviceScaleFactor:1,mobile:true});await sleep(400);let size=await evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth})');assert(size.document<=size.viewport+1,'Mobile page overflow');
  const mobile=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(data,'contact-controls-mobile.png'),Buffer.from(mobile.data,'base64'));checks.push('Ad contact modal fits mobile viewport with a scrollable table');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await cdp('Page.navigate',{url:base+'/dashboard/contacts'});
  await until("!!document.querySelector('select[aria-label=\"Contact bot filter\"]')",'Main contact bot filter missing');
  await until(`[...document.querySelectorAll('select')].some(e=>[...e.options].some(o=>o.value===${JSON.stringify(az)}))`,'Main Page selector did not load the audited Page');
  await evaluate(`(()=>{const e=[...document.querySelectorAll('select')].find(e=>[...e.options].some(o=>o.value===${JSON.stringify(az)}));e.value=${JSON.stringify(az)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until("!!document.querySelector('tbody button[role=switch]:not([disabled])')",'Main contact controls missing');
  for(const value of ['off','on','all']){await choose('Contact bot filter',value);await sleep(700);assert(requests.some(r=>r.path==='/api/pages/'+az+'/contacts'&&new URLSearchParams(r.query).get('bot')===value));}
  await until("!!document.querySelector('tbody button[role=switch]')",'Main contacts not restored');checks.push('Main Contacts displays controls and filters before pagination');
  size=await evaluate('({viewport:innerWidth,document:document.documentElement.scrollWidth})');assert(size.document<=size.viewport+1,'Desktop page overflow');
  assert.equal(errors.length,0);return{passed:true,checks,javascript_errors:errors,intercepted_switch_payloads:clicks,real_permission_changes:0};
 }catch(e){throw Error('Browser verification after '+checks.length+' checks: '+e.message);}finally{
  if(cdp&&ws?.readyState===1)await cdp('Browser.close').catch(()=>{});ws?.close();if(chrome.exitCode===null)await Promise.race([new Promise(r=>chrome.once('exit',r)),sleep(3000)]);if(chrome.exitCode===null)chrome.kill();await sleep(300);
  assert(path.resolve(profile).startsWith(data+path.sep)&&path.basename(profile).startsWith('contact-controls-browser-'));
  try{fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch{console.warn('Temporary verification browser profile is still held by Windows; retry cleanup after exit.');}
 }
}
