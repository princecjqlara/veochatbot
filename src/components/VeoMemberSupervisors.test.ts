import {createElement} from 'react';import {act,create,type ReactTestRenderer} from 'react-test-renderer';import {afterEach,expect,it,vi} from 'vitest';
import Editor from './VeoMemberSupervisors';let view:ReactTestRenderer;afterEach(async()=>{if(view)await act(async()=>view.unmount());vi.unstubAllGlobals();});
const accounts=[{id:'member',name:'Existing member',role:'member',parent_id:'manager',active:true},{id:'leader',name:'Leader',role:'team_leader',active:true},{id:'manager',name:'Manager',role:'manager',active:true}];
it('offers direct Team Leader supervision for the existing identity and never submits email/password changes',async()=>{
 const submit=vi.fn();vi.stubGlobal('FormData',class{get(){return 'leader';}});await act(async()=>{view=create(createElement(Editor,{accounts,scope:{role:'team_leader'},busy:false,submit}));});
 expect(view.root.findByType('select').findAllByType('option').map(o=>o.props.value)).toEqual(['leader','manager']);
 await act(async()=>view.root.findByType('form').props.onSubmit({preventDefault(){},currentTarget:{}}));expect(submit).toHaveBeenCalledWith({action:'member_supervisor',user_id:'member',parent_id:'leader',expected_parent_id:'manager'});
});
it.each(['member','manager'])('keeps reassignment controls away from %s accounts',async role=>{
 await act(async()=>{view=create(createElement(Editor,{accounts,scope:{role},busy:false,submit:vi.fn()}));});expect(view.toJSON()).toBeNull();
});
