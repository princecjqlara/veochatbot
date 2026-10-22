import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), admin: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.session }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.access }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.admin }));
import { GET, POST, PATCH } from './route';
import { approvedCatalogContent } from '@/lib/__tests__/fixtures/pricing-catalogs';

const pageId = '00000000-0000-4000-8000-000000000001';
const runId = '00000000-0000-4000-8000-000000000002';
const context = { params: Promise.resolve({ pageId }) };
const draft = { name: 'Price test', mode: 'fair_test', duration_seconds: null, follow_up_gap_minutes: 120,
    attribution_days: 7, minimum_sample: 100, packages: [
        { name: 'A', price: 599, message: 'One video' }, { name: 'B', price: 799, message: 'Video and poster' }
    ] };
const request = (method: string, body?: unknown, query = '') => new Request('http://localhost/api/pages/' + pageId + '/chatbot/pricing' + query,
    { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }) as NextRequest;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.session.mockResolvedValue({ user: { id: 'owner' } });
    mocks.access.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({ data: runId, error: null });
    mocks.admin.mockReturnValue({ from: mocks.from, rpc: mocks.rpc });
});
describe('pricing access and persistence', () => {
    it.each([GET, POST, PATCH])('requires authentication for every operation', async handler => {
        mocks.session.mockResolvedValue(null);
        const response = await handler(request('POST', draft), context);
        expect(response.status).toBe(401);
        expect(mocks.admin).not.toHaveBeenCalled();
    });
    it.each([GET, POST, PATCH])('checks Page membership before reading or writing pricing', async handler => {
        mocks.access.mockResolvedValue(false);
        const response = await handler(request('POST', draft), context);
        expect(response.status).toBe(403);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });
    it('creates the entire immutable run atomically', async () => {
        const response = await POST(request('POST', draft), context);
        expect(response.status).toBe(201);
        expect(mocks.rpc).toHaveBeenCalledWith('create_chatbot_pricing_experiment', { p_page_id: pageId, p_config: draft });
        expect(mocks.from).not.toHaveBeenCalled();
    });
    it('rejects a one-package fair test without writing', async () => {
        const response = await POST(request('POST', { ...draft, packages: draft.packages.slice(0, 1) }), context);
        expect(response.status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('rejects invalid JSON without writing', async () => {
        const response = await POST(new Request('http://localhost/pricing', { method: 'POST', body: '{' }) as NextRequest, context);
        expect(response.status).toBe(400);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('explains required database setup', async () => {
        mocks.rpc.mockResolvedValue({ error: { code: 'PGRST202' } });
        const response = await POST(request('POST', draft), context);
        expect(response.status).toBe(503);
        expect((await response.json()).error).toContain('202610220002');
    });
    it('scopes pause/resume to this Page and excludes archived runs', async () => {
        const query: any = { update: vi.fn(() => query), eq: vi.fn(() => query), neq: vi.fn(() => query),
            select: vi.fn(() => query), maybeSingle: vi.fn().mockResolvedValue({ data: { id: runId, status: 'paused' } }) };
        mocks.from.mockReturnValue(query);
        expect((await PATCH(request('PATCH', { experiment_id: runId, status: 'paused' }), context)).status).toBe(200);
        expect(query.eq).toHaveBeenCalledWith('page_id', pageId);
        expect(query.eq).toHaveBeenCalledWith('id', runId);
        expect(query.neq).toHaveBeenCalledWith('status', 'archived');
    });
    it('cannot overwrite a package through the status endpoint', async () => {
        expect((await PATCH(request('PATCH', { experiment_id: runId, status: 'archived', packages: [] }), context)).status).toBe(400);
        expect(mocks.from).not.toHaveBeenCalled();
    });
    it('does not return a run from another Page', async () => {
        const query: any = { select: () => query, eq: vi.fn(() => query), order: () => query,
            limit: vi.fn().mockResolvedValue({ data: [] }), maybeSingle: vi.fn().mockResolvedValue({ data: null }) };
        mocks.from.mockReturnValue(query);
        const response = await GET(request('GET', undefined, '?experiment=' + runId), context);
        expect(response.status).toBe(404);
        expect(query.eq).toHaveBeenCalledWith('page_id', pageId);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('loads the existing shared knowledge as control plus the three new catalogs without writing', async () => {
        const queries: Record<string, any> = {};
        mocks.from.mockImplementation((table: string) => {
            const result = table === 'chatbot_configs' ? { data: { knowledge_source_page_id: 'shared-knowledge' } }
                : { data: [{ id: 'document', title: 'Current approved catalog', content: approvedCatalogContent }] };
            const chain: any = { select: vi.fn(() => chain), eq: vi.fn(() => chain), or: vi.fn(() => chain), order: () => chain,
                maybeSingle: async () => result, limit: async () => result };
            queries[table] = chain;
            return chain;
        });
        const response = await GET(request('GET', undefined, '?presets=owner'), context);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.packages).toHaveLength(4);
        expect(body.packages[0].options.map((option: any) => option.price)).toEqual([699,899,1099,1299,1499,2499]);
        expect(body.packages[1].hook).toBe('PREMIUM ADS, PREMIUM FREEBIES, ONE PACKAGE!');
        expect(queries.chatbot_knowledge_documents.eq).toHaveBeenCalledWith('page_id', 'shared-knowledge');
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('does not substitute the owner tables for an unverifiable current control', async () => {
        mocks.from.mockImplementation((table: string) => {
            const chain: any = { select: () => chain, eq: () => chain, or: () => chain, order: () => chain,
                maybeSingle: async () => ({ data: null }), limit: async () => ({ data: [] }) };
            return chain;
        });
        const response = await GET(request('GET', undefined, '?presets=owner'), context);
        expect(response.status).toBe(409);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('passes the selected starting duration to scoped analytics', async () => {
        mocks.from.mockImplementation((table: string) => {
            const result = table === 'chatbot_pricing_experiments' ? { data: [{ id: runId, status: 'active' }] }
                : table === 'chatbot_configs' ? { data: { enabled: true } } : { data: [], count: 0 };
            const chain: any = { select: () => chain, eq: () => chain, order: () => chain,
                maybeSingle: async () => result, limit: async () => result,
                then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject) };
            return chain;
        });
        mocks.rpc.mockResolvedValue({ data: [] });
        const response = await GET(request('GET', undefined, '?experiment=' + runId + '&duration=24'), context);
        expect(response.status).toBe(200);
        expect(mocks.rpc).toHaveBeenCalledWith('get_chatbot_pricing_analytics', { p_page_id: pageId, p_experiment_id: runId, p_duration_seconds: 24 });
    });
});
