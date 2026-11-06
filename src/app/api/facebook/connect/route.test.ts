import { afterEach, expect, it, vi } from 'vitest';
import { POST } from './route';
afterEach(() => { vi.unstubAllGlobals(); });
it('returns 410 without looking up or changing Facebook connections', async () => {
 const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher); const response=await POST();
 expect(response.status).toBe(410); expect((await response.json()).error).toContain('removed'); expect(fetcher).not.toHaveBeenCalled();
});
