import {afterEach,expect,it,vi} from 'vitest';
import {assertVeoDatabaseUrl} from '../veo-database-scope';
afterEach(()=>{vi.unstubAllEnvs();});
it('blocks the former shared database even when an older environment is loaded',()=>{
 expect(()=>assertVeoDatabaseUrl('https://pnhzpeyzpwsmwcuafgpw.supabase.co')).toThrow('disabled');
});
it('requires the intended project when VeoBot scope is enabled',()=>{
 vi.stubEnv('VEO_PAGE_SCOPE_ENFORCED','true');
 expect(()=>assertVeoDatabaseUrl('https://other.supabase.co')).toThrow('configured');
 expect(()=>assertVeoDatabaseUrl('https://vhtbmdizugnxkgocmruq.supabase.co')).not.toThrow();
});
