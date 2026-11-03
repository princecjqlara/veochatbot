import {afterEach,expect,it,vi} from 'vitest';
import {filterVeoPages,isApprovedVeoPage} from '../veo-page-scope';
afterEach(()=>{vi.unstubAllEnvs();});
it('uses verified Facebook IDs and resolves only the pending Page by its verified name',()=>{
 expect(isApprovedVeoPage('656646850875530','Renamed')).toBe(true);
 expect(isApprovedVeoPage('999','Azshinari')).toBe(false);
 expect(isApprovedVeoPage('999',' AIkita   Studio ')).toBe(true);
 expect(isApprovedVeoPage('999','Tokko')).toBe(false);
});
it('limits the picker when Veo scope is enabled',()=>{
 vi.stubEnv('VEO_PAGE_SCOPE_ENFORCED','true');
 expect(filterVeoPages([{id:'656646850875530',name:'Azshinari'},{id:'999',name:'Other'}])).toHaveLength(1);
});
