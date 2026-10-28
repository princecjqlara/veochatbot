import{describe,it,expect}from'vitest';
import{treeRate,forecastVector,hasConversationFeatures,boostedSupport,type BoostModel}from'../contact-forecast-boost';
const f={h:24,i:'Food / Restaurants',s:'Restaurant',b:'form_details',inbound:3,quoted:true,form:true,duration:false,returned:true,price_question:false,last_inbound_h:20};
const model={version:'fixture',schema:{pages:['Azshinari'],states:['form_details'],industries:['Food / Restaurants'],feature_names:[]},edges_hours:[0,1,6,24,72,168,336,720],base_log_rate:Math.log(.001),hazard_factor:1.25,trees:[[[0,1,1,2,0,0,1],[0,0,0,0,.2,1,0],[0,0,0,0,-.3,1,0]]],support:{'[24,"Azshinari"]':[300,20],'[24,"Azshinari","form_details"]':[50,3]},timing_calibration:{}} as BoostModel;
describe('boosted survival runtime',()=>{
 it('reproduces log-link trees including missing routing and calibration',()=>{expect(treeRate(model,[.5])).toBeCloseTo(.001*Math.exp(.2)*1.25,14);expect(treeRate(model,[2])).toBeCloseTo(.001*Math.exp(-.3)*1.25,14);expect(treeRate(model,[NaN])).toBeCloseTo(treeRate(model,[.5]),14);});
 it('does not invent richer signals in legacy cached snapshots',()=>{expect(hasConversationFeatures(f)).toBe(true);expect(hasConversationFeatures({h:0,i:'Unknown',s:'Unknown',b:'initial_inquiry'})).toBe(false);expect(hasConversationFeatures({...f,last_inbound_h:NaN})).toBe(false);});
 it('encodes PHT calendar timing and recency in library-compatible float32',()=>{const x=forecastVector(model,'Azshinari',Date.parse('2026-10-05T16:00:00Z'),f,3);expect(x[6]).toBe(Math.fround(Math.log1p(4)));expect(x[7]).toBeCloseTo(0,7);expect(x[8]).toBeCloseTo(1,7);expect(x.slice(-3)).toEqual([1,1,1]);expect(x.every(Number.isFinite)).toBe(true);});
 it('backs off sparse industry or conversation groups to the Page cohort',()=>{expect(boostedSupport(model,'Azshinari',f)?.comparable_records).toBe(300);});
});
