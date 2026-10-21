// Uses a saved configuration and explicit owner policy facts; no database or Messenger writes.
import assert from 'node:assert/strict';
import { readdir,readFile,writeFile } from 'node:fs/promises';
import { generateChatbotResponse,generateChatbotFollowUp } from '../src/lib/chatbot.ts';
import { COMMERCIAL_VIDEO_FORM_REASON } from '../src/lib/chatbot-message-renderer.ts';
import { containsCommercialVideoForm } from '../src/lib/chatbot-intake.ts';
import { ChatbotFollowUpRepeatedError,hasRepeatedChatbotCopy,splitConversationalCopy } from '../src/lib/chatbot-message-copy.ts';
const directory=new URL('../../data/',import.meta.url);
const backups=(await readdir(directory)).filter(name=>/^form-summary-policy-backup-\d+\.json$/.test(name)).sort();
const saved=JSON.parse(await readFile(new URL(backups.at(-1),directory),'utf8')).configs[0];
const config={...saved,rag_enabled:false};
const pageId='preview-only-page', pageName='Commercial sa Negosyo Media';
const knowledge=[{chunk_id:'owner-policy',document_id:'owner-policy',title:'Owner-approved scope and free options',similarity:1,
    content:'Free concept and free script have no fee and require no purchase. Final paid video pricing depends on requirements and confirmed scope. Collect Business Name, Business Location, Goal ng video, Contact Number. Do not invent rates, turnaround, or free personalized videos.'}];
const first=await generateChatbotResponse({config,pageId,pageName,knowledge,inboundMessage:'Magkano po ang commercial video? May free concept po ba?',collectedDetails:{}});
const formIndex=first.messages.findIndex(containsCommercialVideoForm);
assert.equal(first.messages[formIndex-1],COMMERCIAL_VIDEO_FORM_REASON);
assert.match(first.messages[formIndex+1],/\?$/);
assert.equal(first.messages.filter(containsCommercialVideoForm).length,1);
assert.match(first.messages.slice(0,formIndex).join(' '),/scope|requirements|price|presyo/i);
assert.ok(first.messages.filter(text=>!containsCommercialVideoForm(text)).every(text=>splitConversationalCopy(text).length===1));
const history=[{id:'customer-1',from:{id:'preview-customer'},message:'May free concept po ba?',created_time:new Date().toISOString()},
    ...first.messages.map((message,index)=>({id:`page-${index}`,from:{id:pageId},message,created_time:new Date(Date.now()+index+1).toISOString()}))];
const partial=await generateChatbotResponse({config,pageId,pageName,knowledge,inboundMessage:'Preview Bakery po ang business name namin.',history,collectedDetails:{}});
assert.equal(partial.collected_details['Business Name'],'Preview Bakery');
assert.ok(!partial.messages.some(containsCommercialVideoForm));
assert.equal((partial.messages.join(' ').match(/\?/g)||[]).length,1);
let duplicateReminderSuppressed=false;
const follow=await generateChatbotFollowUp({config,pageId,pageName,knowledge,collectedDetails:partial.collected_details,
    history:[...history,{id:'customer-2',from:{id:'preview-customer'},message:'Preview Bakery po ang business name namin.',created_time:new Date(Date.now()+100).toISOString()},
        ...partial.messages.map((message,index)=>({id:`partial-${index}`,from:{id:pageId},message,created_time:new Date(Date.now()+101+index).toISOString()}))],
    previousFollowUpMessages:[],sequenceNumber:1,scheduleLabel:'preview only'})
    .catch(error=>{if(!(error instanceof ChatbotFollowUpRepeatedError))throw error;duplicateReminderSuppressed=true;return {messages:[]};});
assert.ok(!hasRepeatedChatbotCopy(follow.messages,[...first.messages,...partial.messages]));
const details={'Business Name':'Preview Bakery','Business Location':'Manila','Goal ng video':'Promote fresh bread','Contact Number':'09171234567'};
const completed=await generateChatbotResponse({config,pageId,pageName,knowledge,inboundMessage:'Free script please.',collectedDetails:details});
assert.equal(completed.intake_action,'handoff');
assert.equal(completed.messages.length,4);
assert.ok(completed.messages[0].startsWith('Ito po ang summary'));
assert.match(completed.messages.slice(2).join(' '),/free script.*Walang bayad/i);
const report={at:new Date().toISOString(),mode:'saved-configuration-with-explicit-owner-facts',page:pageName,liveDatabaseVerified:false,
    first:first.messages,partial:partial.messages,followUp:follow.messages,duplicateReminderSuppressed,completed:completed.messages,passed:true,messengerMessagesSent:0};
await writeFile(new URL('form-benefit-generation-preview.json',directory),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
