import {afterEach,expect,it,vi} from 'vitest';
import {readContactIdentityBatch} from '../veo-contact-identity-sync';
afterEach(()=>{vi.unstubAllGlobals();});
it('requests one identity-only batch and never follows provider URLs or exposes its token',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{participants:{data:[{id:'100',name:'Page'},{id:'200',name:'Alice'}]}},{participants:{data:[{id:'200',name:'Alice'}]}}],paging:{next:'https://untrusted.test/token',cursors:{after:'next-batch'}}})));vi.stubGlobal('fetch',fetch);
 const r=await readContactIdentityBatch({fb_page_id:'100',access_token:'private-token'});
 expect(r).toEqual({contacts:[{psid:'200',name:'Alice'}],next_cursor:'next-batch'});
 const [url,options]=fetch.mock.calls[0];expect(url.hostname).toBe('graph.facebook.com');expect(url.searchParams.get('fields')).toBe('participants{id,name}');expect(url.searchParams.get('limit')).toBe('50');
 expect(url.toString()).not.toContain('private-token');expect(options.headers.Authorization).toBe('Bearer private-token');expect(fetch).toHaveBeenCalledOnce();
});
it('rejects stuck cursors and hides provider error details',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[],paging:{next:'url',cursors:{after:'same'}}}))));
 await expect(readContactIdentityBatch({fb_page_id:'100',access_token:'secret'},'same')).rejects.toThrow('did not advance');
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{message:'secret provider payload'}}),{status:400})));
 await expect(readContactIdentityBatch({fb_page_id:'100',access_token:'secret'})).rejects.toThrow('Facebook could not read');
});
