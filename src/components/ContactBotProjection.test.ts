import{afterEach,describe,it,expect,vi}from'vitest';
import{act,create,type ReactTestRenderer}from'react-test-renderer';
import ContactBotProjection from'./ContactBotProjection';
import{createElement}from'react';
let view:ReactTestRenderer|undefined;
afterEach(()=>{if(view)act(()=>view!.unmount());view=undefined;vi.unstubAllGlobals();});
const bot={enabled:true,can_reply:false,reason:'awaiting_new_message',loaded_at:'2026-10-29T00:00:00Z'};
const projection={status:'estimated',forecast_method:'conversation_survival_v2',checkpoint_hours:24,needs_refresh:false,scores:{'168':{probability:.0054},'336':{probability:.0077},'720':{probability:.0107}},signal_stage:{label:'Inquiry / conversation signals'},stage_backtests:{'720':{n:1688,events:18,mean_predicted:.0107,actual_rate:.0107,auc:.726}},timing_unavailable_reason:'Too few validated later confirmations for a 30-day date in this conversation-signal group. The payment probability is still available.'};
describe('early-contact projection display',()=>{
 it('shows probability before agreement and the correct stage-specific evidence without inventing a date',()=>{
  const network=vi.fn();vi.stubGlobal('fetch',network);act(()=>{view=create(createElement(ContactBotProjection,{pageId:'p',contactId:'c',name:'Synthetic',initialBot:bot,initialProjection:projection}));});
  let text=JSON.stringify(view!.toJSON());expect(text).toContain('Available before agreeing to a commercial');expect(text).toContain('1.07%');expect(text).toContain('0.54%');expect(text).not.toContain('Median estimated date');
  act(()=>view!.root.findAllByType('button').find(b=>b.props.children==='Projection details')!.props.onClick());text=JSON.stringify(view!.toJSON());expect(text).toContain('1,688');expect(text).toContain('Agreement was not independently labeled');expect(text).toContain('0.726');expect(network).not.toHaveBeenCalled();
 });
 it('labels a supported shorter timing window with its actual horizon when Day-30 timing is unavailable',()=>{
  act(()=>{view=create(createElement(ContactBotProjection,{pageId:'p',contactId:'c',name:'Synthetic',initialBot:bot,initialProjection:{...projection,close_windows:{'168':{horizon_days:7,median_remaining_days:2,median_date_pht:'2026-10-22',middle80_remaining_days:[1,5]}}}}));});
  const text=JSON.stringify(view!.toJSON());expect(text).toContain('If confirmed by Day ');expect(text).toContain('2026-10-22');expect(text).toContain('"7"');expect(text).not.toContain('If confirmed by Day 30:');
 });
});
