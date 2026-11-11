import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => mock }));
import { scanVeoAutoTags, processVeoAutoTags } from '../veo-autotag';
const page = { page_id: 'page', fb_page_id: '111', access_token: 'secret-token', launch_at: '2026-11-09T00:00:00Z', owner_id: 'owner', lease_token: 'lease', checked_at: '2026-11-09T00:00:00Z', cursor: null };
const conversation = (id = 'thread', psid = 'customer') => ({ id, updated_time: '2026-11-11T00:00:00Z', participants: { data: [{ id: '111' }, { id: psid }] } });
const stage = (text = 'Qualified', from = '111', at = '2026-11-10T00:00:00Z') => ({ id: text + at, message: 'Lead stage set to ' + text, from: { id: from }, created_time: at });
beforeEach(() => {
    vi.stubEnv('VEO_WORKSPACE_ENABLED', 'true');mock.rpc.mockReset().mockImplementation(async name => ({ data: name === 'veo_repair_autotag_history' ? 1 : name === 'apply_messenger_lead_stage' ? { applied: true } : true }));
    mock.from.mockReset().mockImplementation(() => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { id: 'contact' } }) };return q; });
});
afterEach(() => { vi.unstubAllGlobals();vi.unstubAllEnvs(); });
const finish = () => mock.rpc.mock.calls.filter(([name]) => name === 'veo_finish_autotag_page').at(-1)?.[1];
it('saves only Page-authored launch-period stages without importing transcripts, creating contacts or inferring payment', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: [conversation()] })).mockResolvedValueOnce(Response.json({ data: [stage(), stage('Converted', 'customer'), stage('Converted', '111', '2026-11-01T00:00:00Z'), { ...stage(), id: 'invoice', message: 'You created an order for PHP100. View: fb-pma://payments/orderdetails/?invoice_id=123' }] }));
    vi.stubGlobal('fetch', fetch);
    expect(await scanVeoAutoTags(page)).toMatchObject({ complete: true, stage_events: 1, repaired_tags: 1 });
    expect(mock.rpc.mock.calls.filter(([name]) => name === 'apply_messenger_lead_stage')).toHaveLength(1);
    expect(mock.rpc).toHaveBeenCalledWith('apply_messenger_lead_stage', expect.objectContaining({ p_page_id: 'page', p_contact_id: 'contact', p_stage: 'qualified' }));
    expect(mock.from.mock.calls.every(([table]) => table === 'contacts')).toBe(true);
    expect(fetch.mock.calls.every(([url, options]) => url.hostname === 'graph.facebook.com' && !url.searchParams.has('access_token') && options.headers.Authorization === 'Bearer secret-token' && !options.method)).toBe(true);
    expect(finish().p_result).toMatchObject({ next_cursor: null, stage_events: 1 });
});
it('keeps checkpoints retryable on Meta or stage-storage failures without recording sensitive upstream errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 190, message: 'private secret-token' } }, { status: 400 })));
    expect((await scanVeoAutoTags(page)).complete).toBe(false);expect(finish().p_result.error).toBe('PAGE_RECONNECT_REQUIRED');expect(JSON.stringify(finish())).not.toContain('secret-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ data: [conversation()] })).mockResolvedValueOnce(Response.json({ data: [stage()] })));
    mock.rpc.mockImplementation(async name => name === 'apply_messenger_lead_stage' ? { error: { message: 'offline' } } : { data: true });
    expect((await scanVeoAutoTags(page)).complete).toBe(false);expect(finish().p_result.error).toBe('TAG_STORAGE_UNAVAILABLE');
});
it('looks at new edits during paginated recovery, deduplicates threads and queues deeper known-contact evidence safely', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ data: [conversation()], paging: { next: 'https://untrusted.invalid/', cursors: { after: 'after-next' } } }))
        .mockResolvedValueOnce(Response.json({ data: [conversation()] })).mockResolvedValueOnce(Response.json({ data: [stage()], paging: { next: 'https://graph.facebook.com/remaining' } }));
    vi.stubGlobal('fetch', fetch);
    expect(await scanVeoAutoTags({ ...page, cursor: 'after-old' })).toMatchObject({ complete: true, conversations: 1 });
    expect(fetch).toHaveBeenCalledTimes(3);expect(mock.rpc).toHaveBeenCalledWith('veo_request_source_refresh', { p_actor: 'owner', p_contact: 'contact' });expect(finish().p_result.next_cursor).toBe('after-next');
});
it('processes known contacts despite an unmatched participant and leaves a visible retry without inventing a contact', async () => {
    mock.from.mockImplementation(() => { let psid: string; const q: any = { select: () => q, eq: (key: string, value: string) => { if (key === 'psid') psid = value;return q; }, maybeSingle: async () => ({ data: psid === 'unknown' ? null : { id: 'contact' } }) };return q; });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ data: [conversation('unknown', 'unknown'), conversation()] })).mockResolvedValueOnce(Response.json({ data: [stage()] })));
    expect(await scanVeoAutoTags(page)).toMatchObject({ complete: false, stage_events: 1 });expect(finish().p_result.error).toBe('CONTACT_SYNC_REQUIRED');
});
it('rejects incomplete evidence and non-advancing cursors instead of silently certifying a scan', async () => {
    for (const data of [{ data: [conversation()], paging: { next: 'next', cursors: { after: 'old' } } }, { data: [{ ...conversation(), updated_time: null }] }]) {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(data)));expect((await scanVeoAutoTags({ ...page, cursor: 'old' })).complete).toBe(false);
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ data: [conversation()] })).mockResolvedValueOnce(Response.json({ data: [{ ...stage(), created_time: null }] })));
    expect((await scanVeoAutoTags(page)).complete).toBe(false);expect(finish().p_result.error).toBe('META_STAGE_EVIDENCE_INCOMPLETE');
});
it('isolates a failed Page while other claimed Pages still complete', async () => {
    mock.rpc.mockImplementation(async name => ({ data: name === 'veo_claim_autotag_pages' ? [page, { ...page, page_id: 'other', access_token: '' }] : true }));
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [] })));
    expect(await processVeoAutoTags()).toEqual({ pages: 2, completed: 1, failed: 1 });
});
