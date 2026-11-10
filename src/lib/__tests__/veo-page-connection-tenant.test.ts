import { afterEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const owner = vi.hoisted(() => vi.fn());
vi.mock('@/lib/veo-page-connections', async () => ({ ...await vi.importActual<any>('@/lib/veo-page-connections'), requirePageOwner: owner }));
import { POST } from '@/app/api/facebook/connect/route';
afterEach(() => { vi.unstubAllGlobals(); });
it('stops connection before external work if current Owner scope is unavailable', async () => {
 owner.mockRejectedValue(Object.assign(new Error('No Owner access'), { status: 403 }));
 const fetcher=vi.fn(); vi.stubGlobal('fetch',fetcher);
 expect((await POST(new NextRequest('https://veo.test/api/facebook/connect',{method:'POST'}))).status).toBe(403); expect(fetcher).not.toHaveBeenCalled();
});
