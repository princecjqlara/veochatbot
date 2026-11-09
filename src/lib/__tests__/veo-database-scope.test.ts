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
it('accepts the approved replacement only when explicitly selected',()=>{
 vi.stubEnv('VEO_PAGE_SCOPE_ENFORCED','true');
 expect(()=>assertVeoDatabaseUrl('https://mjuluaqrvbnycisnarzi.supabase.co')).toThrow('configured');
 vi.stubEnv('VEO_DATABASE_PROJECT_REF','mjuluaqrvbnycisnarzi');
 expect(()=>assertVeoDatabaseUrl('https://mjuluaqrvbnycisnarzi.supabase.co')).not.toThrow();
 expect(()=>assertVeoDatabaseUrl('https://vhtbmdizugnxkgocmruq.supabase.co')).toThrow('configured');
 vi.stubEnv('VEO_DATABASE_PROJECT_REF','other');
 expect(()=>assertVeoDatabaseUrl('https://other.supabase.co')).toThrow('configured');
 vi.stubEnv('VEO_DATABASE_PROJECT_REF','pnhzpeyzpwsmwcuafgpw');
 expect(()=>assertVeoDatabaseUrl('https://pnhzpeyzpwsmwcuafgpw.supabase.co')).toThrow('disabled');
});
