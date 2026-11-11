import { createElement } from 'react';import { act, create, type ReactTestRenderer } from 'react-test-renderer';import { afterEach, expect, it, vi } from 'vitest';
vi.mock('next/link', () => ({ default: ({ children, ...props }: any) => createElement('a', props, children) }));
import Summary from './VeoSupervisorGroups';let view: ReactTestRenderer;afterEach(async () => { if(view)await act(async()=>view.unmount()); });
const text=(v:any):string=>typeof v==='string'||typeof v==='number'?String(v):(v?.children||[]).map(text).join('');
it.each(['team_leader','manager'])('shows every assigned Page and multiple groups for a %s, and adds without replacing links', async role => {
 const onAdd=vi.fn(), data={can_manage:true,accounts:[{user_id:'person',name:'Supervisor',role,page_ids:['one','two','two']}],teams:[{id:'team',manager_id:'person'}],pages:[{id:'one',name:'First Page'},{id:'two',name:'Second Page'}],groups:[{chat_id:-1,name:'First Group'},{chat_id:-2,name:'Second Group'}],links:[{team_id:'team',chat_id:-1},{team_id:'team',chat_id:-2}],routes:[{team_id:'team',chat_id:-1,page_id:'one'},{team_id:'team',chat_id:-2,page_id:'two'}]};
 await act(async()=>{view=create(createElement(Summary,{data,onAdd}));});const output=text(view.toJSON());for(const expected of ['2 Pages','2 groups','First Page','Second Page','First Group','Second Group'])expect(output).toContain(expected);
 await act(async()=>view.root.findByType('button').props.onClick());expect(onAdd).toHaveBeenCalledWith('team');expect(data.links).toHaveLength(2);
});
