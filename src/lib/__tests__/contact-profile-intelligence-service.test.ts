import { afterEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ scope: vi.fn() }));
vi.mock('../veo-workspace', () => ({ workspaceEnabled: () => true, workspaceScope: m.scope }));
vi.mock('../contact-controls', () => ({ contactControls: async () => new Map() }));
import { getContactProfile } from '../contact-profile-service';
afterEach(() => { vi.clearAllMocks(); });
it('combines existing facts, saved answers and verified order metrics while retaining former-worker history in the permitted branch', async () => {
    m.scope.mockResolvedValue({ role: 'manager', page_ids: ['page'], worker_ids: ['active'], user_id: 'active' });
    const at = '2026-11-07T00:00:00Z', proof = [{ message_id: 'm', quote: 'I need advertising.', at }];
    const tables: Record<string, any> = {
        contacts: { id: 'client', page_id: 'page', name: 'Client', pipeline_stage: 'converted', contact_tags: [], best_contact_hour: 9, best_contact_confidence: 'high' }, pages: { id: 'page', name: 'VEO' },
        chatbot_configs: { details_to_collect: ['Phone number', 'Purpose'] }, chatbot_contact_states: { collected_details: { phone: '123', purpose: 'Advertising' } },
        contact_profile_snapshots: { source_cutoff_at: at, payload: { extracted_answers: [], facts: [{ category: 'purpose', key: 'Goal', value: 'Advertising', evidence: proof }] } },
        veo_orders: [{ id: 'new', page_id: 'page', contact_id: 'client', seller_id: 'former', description: 'Video offer', total_minor: 20000, currency: 'PHP', created_at: at, created_by: 'former' }],
        veo_payments: [{ id: 'new-paid', order_id: 'new', kind: 'full', amount_minor: 20000, occurred_at: at, reference: 'verified-new', created_at: at }]
    };
    const db = { from: vi.fn((table: string) => {
        const result = { data: tables[table] ?? (['messenger_lead_stage_events', 'ad_lead_stage_events', 'ad_referral_events'].includes(table) ? [] : null), error: null };
        const q: any = {}; for (const method of ['select', 'eq', 'order', 'limit', 'lt']) q[method] = vi.fn(() => q);
        q.in = vi.fn((_key: string, values: string[]) => { if (table === 'veo_orders') expect(values).toEqual(['active', 'former']); return q; });
        q.maybeSingle = async () => result; q.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject); return q;
    }), rpc: vi.fn(async (name: string) => ({ error: null, data: name === 'veo_profile_detail_access' ? { branch_worker_ids: ['active', 'former'], chatbot_fields: ['Phone number', 'Purpose'], manual_fields: {}, saved_fields: { phone: '123', purpose: 'Advertising' }, analysis: { fields: [{ field: 'buying_purpose', value: 'Advertising', evidence: proof }, { field: 'problems_encountered', value: 'No enquiries', evidence: proof }] } } : {
        purchases: [{ id: 'legacy', recorded_by: 'former', description: 'Retained offer', total_minor: 10000, currency: 'PHP', purchased_at: at }, { id: 'foreign', recorded_by: 'outside', description: 'Other branch', total_minor: 90000, currency: 'PHP', purchased_at: at }],
        payments: [{ id: 'old-payment', purchase_id: 'legacy', verified_by: 'former', amount_minor: 10000, currency: 'PHP', kind: 'full', occurred_at: at }, { id: 'foreign-payment', purchase_id: 'foreign', verified_by: 'outside', amount_minor: 90000, currency: 'PHP', kind: 'full', occurred_at: at }]
    } })) };
    const result = await getContactProfile(db, 'page', 'client', 'active');
    expect(result!.finance.metrics.orders.map((o: any) => o.id).sort()).toEqual(['legacy', 'new']);
    expect(result!.finance.metrics.currencies[0]).toMatchObject({ paid_order_count: 2, average_order_minor: 15000, net_minor: 30000 });
    expect(result!.facts.filter((f: any) => f.category === 'purpose')).toHaveLength(1); expect(result!.facts.some((f: any) => f.category === 'problem')).toBe(true);
    expect(result!.detail_progress.collected_details['Phone number']).toBe('123'); expect(result!.best_contact_time.source).toBe('activity');
    expect(result!.detail_progress).toMatchObject({ required_count: 2, collected_count: 2, complete: true });
    expect(db.rpc.mock.calls.every(([name]) => ['get_contact_finance_records', 'veo_profile_detail_access'].includes(name))).toBe(true);
    const baseRpc = db.rpc.getMockImplementation()!;
    db.rpc.mockImplementation(async (name: string) => { const result = await baseRpc(name); if (name === 'veo_profile_detail_access') result.data.saved_fields = { phone: '123' }; return result; });
    const extractedPurpose = await getContactProfile(db, 'page', 'client', 'active');
    expect(extractedPurpose!.detail_progress.collected_details.Purpose).toBe('Advertising');
    expect(extractedPurpose!.detail_progress.complete).toBe(true); expect(extractedPurpose!.answer_sources.Purpose).toBe('extracted');
});
