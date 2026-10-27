import{describe,it,expect}from'vitest';
import{projectionCacheFromMessages}from'../contact-projection-refresh';
const first=Date.parse('2026-10-20T00:00:00Z');
const m=(id:string,h:number,sender:string,text:string)=>({id,created_time:new Date(first+h*3600000).toISOString(),from:{id:sender},message:text});
const input={contactId:'c',pageId:'p',facebookPageId:'page',psid:'buyer',cutoff:first+25*3600000};
describe('timestamp-safe live conversation features',()=>{
 it('does not use later form details or industry in an earlier checkpoint',()=>{
  const c=projectionCacheFromMessages([m('one',0,'buyer','How much?'),m('quote',2,'page','Video package: PHP 699 for 16 seconds'),m('later',20,'buyer','Business name: ABC\nLocation: Manila')],input);
  expect(c.snapshots.find(s=>s.h===1)?.b).toBe('initial_inquiry');expect(c.snapshots.find(s=>s.h===24)?.b).toBe('form_details');expect(c.snapshots.every(s=>s.h<=25)).toBe(true);
 });
 it('requires a documentary confirmation rather than a customer claim or administrative paid tag',()=>{
  const base=[m('one',0,'buyer','I need an ad'),m('claim',2,'buyer','Payment sent na po'),m('tag',3,'page','You marked this conversation as paid')];
  expect(projectionCacheFromMessages(base,input).payment_at).toBeNull();
  const c=projectionCacheFromMessages([...base,m('ack',4,'page','Payment received, thank you!')],input);expect(c.payment_evidence_id).toBe('ack');expect(c.payment_at).toBe(new Date(first+4*3600000).toISOString());
 });
 it('excludes events created after the source cutoff',()=>{
  const c=projectionCacheFromMessages([m('one',0,'buyer','Hello'),m('future',30,'page','Payment received')],input);expect(c.payment_at).toBeNull();
 });
});
