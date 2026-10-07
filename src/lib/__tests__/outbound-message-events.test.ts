import { describe, expect, it, vi } from 'vitest';
import { recordChatbotInterruptionIfNeeded } from '@/lib/outbound-message-events';

function queryResult(data: unknown) {
    const query: any = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        maybeSingle: vi.fn().mockResolvedValue({ data, error: null })
    };
    return query;
}

describe('chatbot interruption attribution', () => {
    it('records the staff sender when a manual message interrupts active detail collection', async () => {
        const configQuery = queryResult({
            details_to_collect: ['Name', 'Budget', 'Schedule', 'Service'],
            details_completion_percent: 100
        });
        const stateQuery = queryResult({
            status: 'active',
            collected_details: { Name: 'Customer', Budget: 'P10,000' }
        });
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === 'chatbot_configs') return configQuery;
                if (table === 'chatbot_contact_states') return stateQuery;
                if (table === 'chatbot_interruption_events') return { upsert };
                throw new Error(`Unexpected table: ${table}`);
            })
        };

        await recordChatbotInterruptionIfNeeded(supabase, {
            pageId: 'page_1',
            contactId: 'contact_1',
            messageId: 'mid.1',
            source: 'veobot',
            interruptionType: 'manual_message',
            actorUserId: 'user_1',
            actorName: 'Maria Santos',
            interruptedAt: '2026-09-28T08:00:00.000Z'
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            page_id: 'page_1',
            contact_id: 'contact_1',
            message_id: 'mid.1',
            actor_user_id: 'user_1',
            actor_name: 'Maria Santos',
            source: 'veobot',
            interruption_type: 'manual_message',
            lead_stage: null,
            collected_detail_count: 2,
            required_detail_count: 4,
            interrupted_at: '2026-09-28T08:00:00.000Z'
        }), { onConflict: 'message_id' });
    });

    it('does not record an interruption after the detail target is reached', async () => {
        const configQuery = queryResult({
            details_to_collect: ['Name', 'Budget', 'Schedule', 'Service'],
            details_completion_percent: 50
        });
        const stateQuery = queryResult({
            status: 'active',
            collected_details: { Name: 'Customer', Budget: 'P10,000' }
        });
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === 'chatbot_configs') return configQuery;
                if (table === 'chatbot_contact_states') return stateQuery;
                if (table === 'chatbot_interruption_events') return { upsert };
                throw new Error(`Unexpected table: ${table}`);
            })
        };

        await recordChatbotInterruptionIfNeeded(supabase, {
            pageId: 'page_1', contactId: 'contact_1', messageId: 'mid.2',
            source: 'veobot', interruptionType: 'manual_message', actorName: 'Maria Santos'
        });

        expect(upsert).not.toHaveBeenCalled();
    });

    it('records a Business Suite lead-stage change before details are complete', async () => {
        const configQuery = queryResult({
            details_to_collect: ['Name', 'Budget', 'Schedule', 'Service'],
            details_completion_percent: 100
        });
        const stateQuery = queryResult({
            status: 'active',
            collected_details: { Name: 'Customer' }
        });
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const supabase = {
            from: vi.fn((table: string) => {
                if (table === 'chatbot_configs') return configQuery;
                if (table === 'chatbot_contact_states') return stateQuery;
                if (table === 'chatbot_interruption_events') return { upsert };
                throw new Error(`Unexpected table: ${table}`);
            })
        };

        await recordChatbotInterruptionIfNeeded(supabase, {
            pageId: 'page_1',
            contactId: 'contact_1',
            messageId: 'stage-event-1',
            source: 'business_suite',
            interruptionType: 'lead_stage_change',
            leadStage: 'qualified',
            interruptedAt: '2026-09-29T08:00:00.000Z'
        });

        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            source: 'business_suite',
            interruption_type: 'lead_stage_change',
            lead_stage: 'qualified',
            collected_detail_count: 1,
            required_detail_count: 4
        }), { onConflict: 'message_id' });
    });

    it('uses the pre-stop snapshot after the worker has already saved a durable stop', async () => {
        const upsert = vi.fn().mockResolvedValue({ error: null });
        const supabase = { from: vi.fn((table: string) => {
            if (table === 'chatbot_configs') return queryResult({ details_to_collect: ['Name', 'Budget'], details_completion_percent: 100 });
            if (table === 'chatbot_interruption_events') return { upsert };
            throw new Error(`Snapshot should avoid reloading ${table}`);
        }) };
        await recordChatbotInterruptionIfNeeded(supabase, {
            pageId: 'page', contactId: 'contact', messageId: 'stage-event',
            source: 'business_suite', interruptionType: 'lead_stage_change', leadStage: 'qualified',
            stateBeforeStop: { status: 'active', collected_details: { Name: 'Customer' } }
        });
        expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
            interruption_type: 'lead_stage_change', collected_detail_count: 1, required_detail_count: 2
        }), { onConflict: 'message_id' });
    });
});
