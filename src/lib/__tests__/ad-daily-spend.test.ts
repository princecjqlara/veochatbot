import{describe,it,expect}from'vitest';
import{normalizeDailySpend,alignedWithPht}from'../ad-daily-spend';
const account={id:'act_99',currency:'PHP',timezone_name:'Asia/Manila'},allowed=new Map([['123','page']]),r={ad_id:'123',account_id:'99',account_currency:'PHP',date_start:'2026-10-20',date_stop:'2026-10-20',spend:'123.45',clicks:'5',impressions:'1000'};
describe('Meta daily-spend verification',()=>{
 it('accepts only actual daily spend for a verified Page/ad relationship',()=>{const v=normalizeDailySpend(r,account,allowed,'2026-10-20','2026-10-21')!;expect(v.amount).toBe(123.45);expect(v.page_id).toBe('page');expect(v.pht_aligned).toBe(true);expect(normalizeDailySpend({...r,ad_id:'unknown'},account,allowed,'2026-10-20','2026-10-21')).toBeNull();});
 it('validates currency, account, amount and one-day periods before saving anything',()=>{for(const patch of [{account_id:'different'},{account_currency:'USD'},{spend:'-1'},{spend:null},{date_stop:'2026-10-21'},{date_start:'2026-10-22',date_stop:'2026-10-22'}])expect(()=>normalizeDailySpend({...r,...patch},account,allowed,'2026-10-20','2026-10-21')).toThrow();});
 it('aligns only real Philippine-equivalent day boundaries; no timezone proration is invented',()=>{expect(alignedWithPht('2026-10-20','Asia/Manila')).toBe(true);expect(alignedWithPht('2026-10-20','Asia/Singapore')).toBe(true);expect(alignedWithPht('2026-10-20','America/Los_Angeles')).toBe(false);expect(alignedWithPht('2026-10-20','UTC')).toBe(false);expect(alignedWithPht('2026-10-20','unknown')).toBe(false);});
});
