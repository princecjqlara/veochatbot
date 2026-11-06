import { afterEach, expect, it, vi } from 'vitest';
import { getAutomationPageScope } from '@/lib/page-automation-scope';
afterEach(() => { vi.unstubAllEnvs(); });
it('requires both workspace authorization and the retained Facebook app ownership policy', async () => {
    vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true'); vi.stubEnv('VEO_ENFORCE_PAGE_RUNTIME_SCOPE', 'true');
    const rpc = vi.fn(async name => ({ data: name === 'veo_active_pages' ? ['owned', 'other-app'] : ['owned'], error: null }));
    expect(await getAutomationPageScope({ rpc })).toEqual(['owned']);
});
