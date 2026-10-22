import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSessionFromRequest: vi.fn(),
    getSupabaseAdmin: vi.fn(),
    userHasPageAccess: vi.fn(),
    updateContactPipelineStage: vi.fn(),
    getChatbotContactState: vi.fn(), saveChatbotContactState: vi.fn(), cancelPendingChatbotFollowUps: vi.fn()
}));

vi.mock('@/lib/get-session', () => ({ getSessionFromRequest: mocks.getSessionFromRequest }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: mocks.getSupabaseAdmin }));
vi.mock('@/lib/page-access', () => ({ userHasPageAccess: mocks.userHasPageAccess }));
vi.mock('@/lib/chatbot-control', async original => ({ ...await original<typeof import('@/lib/chatbot-control')>(), getChatbotContactState: mocks.getChatbotContactState, saveChatbotContactState: mocks.saveChatbotContactState }));
vi.mock('@/lib/chatbot-follow-ups', () => ({ cancelPendingChatbotFollowUps: mocks.cancelPendingChatbotFollowUps }));
vi.mock('@/lib/contact-pipeline', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/lib/contact-pipeline')>();
    return { ...original, updateContactPipelineStage: mocks.updateContactPipelineStage };
});

import { GET, PATCH } from './route';

describe('pipeline Page-member access', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionFromRequest.mockResolvedValue({ user: { id: 'collaborator_1' } });
        mocks.userHasPageAccess.mockResolvedValue(true);
        mocks.updateContactPipelineStage.mockResolvedValue(true);
        mocks.getChatbotContactState.mockResolvedValue(null);
        mocks.saveChatbotContactState.mockResolvedValue(undefined);
        mocks.cancelPendingChatbotFollowUps.mockResolvedValue(undefined);
    });

    it('lets any user_pages collaborator edit a contact stage', async () => {
        const builder: Record<string, any> = {};
        builder.select = vi.fn(() => builder);
        builder.eq = vi.fn(() => builder);
        builder.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'contact_1' }, error: null });
        mocks.getSupabaseAdmin.mockReturnValue({ from: vi.fn(() => builder) });

        const response = await PATCH(new Request('http://localhost/api/pages/page_1/pipeline', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contact_id: 'contact_1', stage: 'qualified' })
        }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });

        expect(response.status).toBe(200);
        expect(mocks.userHasPageAccess).toHaveBeenCalledWith('collaborator_1', 'page_1');
        expect(mocks.updateContactPipelineStage).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                pageId: 'page_1',
                contactId: 'contact_1',
                stage: 'qualified',
                source: 'manual',
                force: true
            })
        );
    });

    it('rejects a signed-in user without membership before reading pipeline data', async () => {
        mocks.userHasPageAccess.mockResolvedValue(false);

        const response = await GET(
            new Request('http://localhost/api/pages/page_1/pipeline') as NextRequest,
            { params: Promise.resolve({ pageId: 'page_1' }) }
        );

        expect(response.status).toBe(403);
        expect(mocks.getSupabaseAdmin).not.toHaveBeenCalled();
    });

    it('lists partial forms with an exact filtered total and recomputes incomplete status without stopping the bot', async () => {
        const contacts: any = { select:vi.fn(()=>contacts),eq:vi.fn(()=>contacts),order:vi.fn(()=>contacts),neq:vi.fn(()=>contacts),
            range:vi.fn(async()=>({data:[{id:'partial',pipeline_stage:'collecting_details'}],count:1,error:null})) };
        const states: any = { select:()=>states,eq:()=>states,in:async()=>({data:[{contact_id:'partial',status:'active',collected_details:{'Business Name':'Cafe'},missing_details:[]}],error:null}) };
        const config: any = {select:()=>config,eq:()=>config,maybeSingle:async()=>({data:{commercial_video_intake_enabled:true},error:null})};
        mocks.getSupabaseAdmin.mockReturnValue({from:(table:string)=>table==='contacts'?contacts:table==='chatbot_configs'?config:states,
            rpc:async()=>({data:{new:100,collecting_details:20},error:null})});
        const response=await GET(new Request('http://localhost/api/pages/page_1/pipeline?details=with_details&pageSize=1') as NextRequest,{params:Promise.resolve({pageId:'page_1'})});
        expect(response.status).toBe(200);
        const body=await response.json();
        expect(body.total).toBe(1);expect(body.stageCounts.new).toBe(100);
        expect(body.contacts[0].chatbot_state.status).toBe('active');
        expect(body.contacts[0].detail_progress).toMatchObject({complete:false,collected_count:1,required_count:8});
        expect(body.contacts[0].detail_progress.missing_details).toHaveLength(7);
        expect(contacts.select).toHaveBeenCalledWith(expect.stringContaining('chatbot_contact_states!inner'),{count:'exact'});
        expect(contacts.neq).toHaveBeenCalledWith('chatbot_contact_states.collected_details','{}');
        expect(mocks.saveChatbotContactState).not.toHaveBeenCalled();expect(mocks.cancelPendingChatbotFollowUps).not.toHaveBeenCalled();
    });

    it.each(['new', 'engaged', 'collecting_details', 'qualified'])(
        'saves a durable stop and cancels queued sends when a person selects %s', async (stage) => {
            const builder: any = { select: () => builder, eq: () => builder,
                maybeSingle: async () => ({ data: { id: 'contact_1' }, error: null }) };
            mocks.getSupabaseAdmin.mockReturnValue({ from: () => builder });
            const response = await PATCH(new Request('http://localhost/api/pages/page_1/pipeline', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contact_id: 'contact_1', stage })
            }) as NextRequest, { params: Promise.resolve({ pageId: 'page_1' }) });
            expect(response.status).toBe(200);
            expect(mocks.saveChatbotContactState).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
                contactId: 'contact_1', stopReason: stage === 'qualified' ? 'qualified' : 'manual'
            }));
            expect(mocks.cancelPendingChatbotFollowUps).toHaveBeenCalledWith(expect.objectContaining({ contactId: 'contact_1' }));
            expect(mocks.saveChatbotContactState.mock.invocationCallOrder[0]).toBeLessThan(mocks.updateContactPipelineStage.mock.invocationCallOrder[0]);
        }
    );
});
