import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/facebook/connect/route';
afterEach(() => { vi.unstubAllGlobals(); });
it('cannot move a Page into another tenant because Facebook connection setup is retired', async () => {
 const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher); expect((await POST()).status).toBe(410); expect(fetcher).not.toHaveBeenCalled();
});
