import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    getSupabaseAdmin: vi.fn(), controls: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {}
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));
vi.mock('@/lib/contact-controls', () => ({ contactControls: mocks.controls }));

import { GET } from './route';

function createRequest(url: string): NextRequest {
    const request = new Request(url) as NextRequest;
    Object.defineProperty(request, 'nextUrl', {
        value: new URL(url)
    });
    return request;
}

function createSupabaseMock(options?: {
    includeContactIds?: string[];
    excludeContactIds?: string[];
    contactsData?: Array<Record<string, unknown>>;
    tagError?: string;
}) {
    const userPageSingle = vi.fn().mockResolvedValue({ data: { page_id: 'page_1' }, error: null });
    const userPageEqPage = vi.fn().mockReturnValue({ single: userPageSingle });
    const userPageEqUser = vi.fn().mockReturnValue({ eq: userPageEqPage });
    const userPageSelect = vi.fn().mockReturnValue({ eq: userPageEqUser });

    const contactsData = options?.contactsData ?? [
        {
            id: 'contact_1',
            page_id: 'page_1',
            psid: 'psid_1',
            name: 'Contact A',
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
            contact_tags: [
                {
                    tag_id: 'tag_1',
                    created_by: 'user_2',
                    tags: {
                        id: 'tag_1',
                        name: 'VIP',
                        color: '#000000',
                        owner_type: 'user',
                        owner_id: 'user_2',
                        page_id: 'page_1',
                        created_at: '2026-01-01T00:00:00.000Z'
                    }
                }
            ]
        }
    ];

    const contactsRange = vi.fn().mockResolvedValue({
        data: contactsData,
        error: null,
        count: contactsData.length
    });

    const contactsBuilder: any = {
        eq: vi.fn(() => contactsBuilder),
        in: vi.fn(() => contactsBuilder),
        is: vi.fn(() => contactsBuilder),
        not: vi.fn(() => contactsBuilder),
        neq: vi.fn(() => contactsBuilder),
        gte: vi.fn(() => contactsBuilder),
        lte: vi.fn(() => contactsBuilder),
        or: vi.fn(() => contactsBuilder),
        order: vi.fn(() => contactsBuilder),
        range: contactsRange
    };

    const contactsSelect = vi.fn(() => contactsBuilder);

    const usersIn = vi.fn().mockResolvedValue({
        data: [
            {
                id: 'user_2',
                name: 'Teammate A',
                email: 'teammate@example.com'
            }
        ],
        error: null
    });
    const usersSelect = vi.fn().mockReturnValue({ in: usersIn });

    const includeContactIds = options?.includeContactIds ?? ['contact_1'];
    const excludeContactIds = options?.excludeContactIds ?? ['contact_2'];
    const tagFilterRows = [
        includeContactIds.map(contactId => ({ contact_id: contactId })),
        excludeContactIds.map(contactId => ({ contact_id: contactId }))
    ];
    let tagFilterIndex = -1;
    const contactTagsFilterQuery = {
        range: vi.fn((from: number, to: number) => Promise.resolve({
            data: (tagFilterRows[tagFilterIndex] || []).slice(from, to + 1),
            error: null
        }))
    };
    const contactTagsEq = vi.fn(() => {
        tagFilterIndex += 1;
        return contactTagsFilterQuery;
    });
    const contactTagsIn = vi.fn().mockReturnValue({ eq: contactTagsEq });
    const contactTagRows = contactsData.flatMap((contact) =>
        Array.isArray(contact.contact_tags)
            ? contact.contact_tags.map((tagRow) => ({
                contact_id: contact.id,
                ...(tagRow as Record<string, unknown>)
            }))
            : []
    );
    const contactTagRowsQuery: any = { order: () => contactTagRowsQuery,
        range: vi.fn(async (from: number, to: number) => ({ data: contactTagRows.slice(from, to + 1), error: options?.tagError ? { message: options.tagError } : null })) };
    const contactTagRowsIn = vi.fn().mockReturnValue(contactTagRowsQuery);
    const contactTagsSelect = vi.fn((columns: string) => {
        if (columns.includes('tag_id')) {
            return { in: contactTagRowsIn };
        }

        return { in: contactTagsIn };
    });

    const from = vi.fn((table: string) => {
        if (table === 'user_pages') {
            return {
                select: userPageSelect
            };
        }

        if (table === 'contacts') {
            return {
                select: contactsSelect
            };
        }

        if (table === 'users') {
            return {
                select: usersSelect
            };
        }

        if (table === 'contact_tags') {
            return {
                select: contactTagsSelect
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        contactsSelect,
        contactsIn: contactsBuilder.in,
        contactsIs: contactsBuilder.is,
        contactsNot: contactsBuilder.not,
        contactsOr: contactsBuilder.or,
        contactsOrder: contactsBuilder.order,
        contactTagsIn,
        contactTagRowsIn,
        contactTagRowsQuery,
        contactTagsEq
    };
}

describe('GET /api/pages/[pageId]/contacts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.controls.mockReset().mockResolvedValue(new Map([['contact_1', { bot_control: { enabled: true } }]]));
    });

    it('returns all requested tags beyond a PostgREST page and never silently omits a failed source', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const tags = Array.from({ length: 1101 }, (_, i) => ({ tag_id: 'tag-' + i, tags: { id: 'tag-' + i, name: 'Tag ' + i } }));
        const db = createSupabaseMock({ contactsData: [{ id: 'contact_1', page_id: 'page_1', contact_tags: tags }] });mocks.getSupabaseAdmin.mockReturnValue(db);
        const request = () => GET(createRequest('http://localhost:3000/api/pages/page_1/contacts?includeControls=true'), { params: Promise.resolve({ pageId: 'page_1' }) });
        const response = await request();expect(response.status).toBe(200);expect((await response.json()).items[0].tags).toHaveLength(1101);
        expect(db.contactTagRowsQuery.range).toHaveBeenCalledTimes(2);
        mocks.controls.mockRejectedValueOnce(Error('controls unavailable'));
        expect((await request()).status).toBe(503);
        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({ tagError: 'tags unavailable' }));
        const failed = await request();expect(failed.status).toBe(503);expect((await failed.json()).items).toBeUndefined();
    });

    it('includes who added each tag in contact results', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock());

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.items[0].tags[0].tagged_by_user_id).toBe('user_2');
        expect(body.items[0].tags[0].tagged_by_name).toBe('Teammate A');
    });

    it('applies include and exclude tag filters together', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMock({
            includeContactIds: ['contact_1', 'contact_2'],
            excludeContactIds: ['contact_2']
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25&tagIds=tag_a,tag_b&excludeTagIds=tag_x'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        expect(supabase.contactsSelect).toHaveBeenCalledWith(
            '*,included_tag_filter:contact_tags!inner(),excluded_tag_filter:contact_tags!left()',
            { count: 'exact' }
        );
        expect(supabase.contactsIn).toHaveBeenNthCalledWith(1, 'included_tag_filter.tag_id', ['tag_a', 'tag_b']);
        expect(supabase.contactsIn).toHaveBeenNthCalledWith(2, 'excluded_tag_filter.tag_id', ['tag_x']);
        expect(supabase.contactsIs).toHaveBeenCalledWith('excluded_tag_filter', null);
    });

    it('applies exclude mode to date filters', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25&dateFrom=2026-07-20&dateTo=2026-07-26&dateFilterMode=exclude'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        expect(supabase.contactsOr).toHaveBeenCalledWith(
            'first_interaction_at.lt.2026-07-20,and(first_interaction_at.is.null,created_at.lt.2026-07-20),first_interaction_at.gte.2026-07-27,and(first_interaction_at.is.null,created_at.gte.2026-07-27)'
        );
    });

    it('sorts 7-day contacts by expiry, latest message, or name', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });

        for (const [sort, expectedColumn, expectedAscending] of [
            ['expiring', 'last_inbound_at', true],
            ['latest', 'last_inbound_at', false],
            ['name_asc', 'name', true],
            ['name_desc', 'name', false]
        ] as const) {
            const supabase = createSupabaseMock();
            mocks.getSupabaseAdmin.mockReturnValue(supabase);
            const response = await GET(
                createRequest(`http://localhost:3000/api/pages/page_1/contacts?humanAgentWindow=true&sort=${sort}`),
                { params: Promise.resolve({ pageId: 'page_1' }) }
            );
            expect(response.status).toBe(200);
            expect(supabase.contactsOrder).toHaveBeenCalledWith(expectedColumn, {
                ascending: expectedAscending,
                nullsFirst: false
            });
        }
    });

    it('can skip tag hydration for cross-page contact selection', async () => {
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?humanAgentWindow=true&includeTags=false&includeCount=false&pageSize=1000'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(200);
        expect(supabase.contactTagRowsIn).not.toHaveBeenCalled();
    });

    it('normalizes placeholder contact names out of the API response', async () => {
        mocks.getServerSession.mockResolvedValue({
            user: {
                id: 'user_1'
            }
        });

        mocks.getSupabaseAdmin.mockReturnValue(createSupabaseMock({
            contactsData: [
                {
                    id: 'contact_1',
                    page_id: 'page_1',
                    psid: 'psid_1',
                    name: 'Unknown Name',
                    created_at: '2026-01-01T00:00:00.000Z',
                    updated_at: '2026-01-01T00:00:00.000Z',
                    contact_tags: []
                }
            ]
        }));

        const response = await GET(
            createRequest('http://localhost:3000/api/pages/page_1/contacts?page=1&pageSize=25'),
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.items[0].name).toBeNull();
    });
});
