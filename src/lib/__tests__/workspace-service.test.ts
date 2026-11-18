import { expect, it } from 'vitest';
import { workspaceService } from '../workspace-service';
it('returns structured suspension denial instead of a server error on shared workspace routes',async()=>{
 const response=await workspaceService(async()=>{throw Object.assign(Error('Account suspended'),{status:403,code:'ACCOUNT_SUSPENDED'});});
 expect(response.status).toBe(403);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await response.json()).toEqual({error:'Account suspended',code:'ACCOUNT_SUSPENDED'});
});
