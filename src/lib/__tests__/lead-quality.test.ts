import{describe,it,expect}from'vitest';import{leadQualityForStage,qualityForAdRow}from'../lead-quality';
describe('automatic stage-based lead quality',()=>{
 it('classifies every currently Not Qualified contact as poor without any separate setting',()=>{expect(leadQualityForStage('not_qualified')).toMatchObject({status:'poor',label:'Poor lead quality',basis:'current_pipeline_stage'});});
 it('follows a corrected stage instead of keeping a stale poor-quality flag',()=>{const contact={stage:'not_qualified'};expect(leadQualityForStage(contact.stage).status).toBe('poor');contact.stage='qualified';expect(leadQualityForStage(contact.stage).status).toBe('good');contact.stage='new';expect(leadQualityForStage(contact.stage).status).toBe('unassessed');});
 it('does not infer poor quality from silence, missing details, opt-out or an unknown stage',()=>{for(const s of ['new','engaged','collecting_details','opted_out','custom',null])expect(leadQualityForStage(s).status).toBe('unassessed');});
 it('reports each ad’s poor-lead share without classifying the whole ad from one lead',()=>{const quality=qualityForAdRow({inquiries:100,not_qualified:1,qualified:5,order_created:2,crm_converted:3});expect(quality).toMatchObject({poor:1,good:10,unassessed:89,poor_rate:.01});expect(quality).not.toHaveProperty('ad_is_bad');expect(qualityForAdRow({inquiries:0}).poor_rate).toBeNull();});
});
