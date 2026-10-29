import{describe,it,expect}from'vitest';import{act,create}from'react-test-renderer';import{createElement}from'react';import LeadQualityBadge from'./LeadQualityBadge';
describe('lead quality label tracks stage changes',()=>{
 it('updates from poor to good when the recorded stage is corrected',()=>{let view:any;act(()=>{view=create(createElement(LeadQualityBadge,{stage:'not_qualified'}));});expect(view.root.findByType('span').props['data-lead-quality']).toBe('poor');expect(JSON.stringify(view.toJSON())).toContain('Poor lead quality');act(()=>view.update(createElement(LeadQualityBadge,{stage:'qualified'})));expect(view.root.findByType('span').props['data-lead-quality']).toBe('good');expect(JSON.stringify(view.toJSON())).not.toContain('Poor lead quality');act(()=>view.unmount());});
});
