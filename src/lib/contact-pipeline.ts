import type { ChatbotStopReason } from '@/lib/chatbot-control';
import type { MessengerSystemSignal } from '@/lib/messaging-auto-tag';

export const CONTACT_PIPELINE_STAGES = [
    'new',
    'engaged',
    'collecting_details',
    'qualified',
    'order_created',
    'converted',
    'not_qualified',
    'opted_out'
] as const;

export type ContactPipelineStage = typeof CONTACT_PIPELINE_STAGES[number];
export type ContactPipelineSource = 'system' | 'chatbot' | 'messenger' | 'manual';

const AUTOMATION_CLOSED_STAGES = new Set<ContactPipelineStage>([
    'qualified',
    'order_created',
    'converted',
    'not_qualified',
    'opted_out'
]);

export const CONTACT_PIPELINE_LABELS: Record<ContactPipelineStage, string> = {
    new: 'New',
    engaged: 'Engaged',
    collecting_details: 'Collecting Details',
    qualified: 'Qualified',
    order_created: 'Order Created',
    converted: 'Converted',
    not_qualified: 'Not Qualified',
    opted_out: 'Opted Out'
};

const PROGRESS_RANK: Partial<Record<ContactPipelineStage, number>> = {
    new: 0,
    engaged: 1,
    collecting_details: 2,
    qualified: 3,
    order_created: 4,
    converted: 5
};

export function isContactPipelineStage(value: unknown): value is ContactPipelineStage {
    return typeof value === 'string' && CONTACT_PIPELINE_STAGES.includes(value as ContactPipelineStage);
}

/** Contacts in these stages have finished the bot qualification flow. */
export function isPipelineClosedForAutomation(value: unknown, source?: unknown): boolean {
    return source === 'manual' || source === 'messenger' ||
        (isContactPipelineStage(value) && AUTOMATION_CLOSED_STAGES.has(value));
}

export function chatbotStopReasonForPipelineStage(stage: unknown, source?: unknown): ChatbotStopReason | null {
    if (stage === 'opted_out') return 'opt_out';
    if (stage === 'qualified' || stage === 'order_created' || stage === 'converted' || stage === 'not_qualified') return stage;
    return source === 'manual' || source === 'messenger' ? 'manual' : null;
}

export function pipelineStageForMessengerSignal(signal: MessengerSystemSignal): ContactPipelineStage {
    return signal === 'manual' ? 'engaged' : signal;
}

export function pipelineStageForChatbotProgress(input: {
    stopReason?: ChatbotStopReason | null;
    detailsComplete?: boolean;
    collectedDetails?: Record<string, string>;
}): ContactPipelineStage {
    if (input.stopReason === 'opt_out') return 'opted_out';
    if (input.stopReason === 'refusal' || input.stopReason === 'not_qualified') return 'not_qualified';
    if (input.stopReason === 'converted') return 'converted';
    if (input.stopReason === 'order_created') return 'order_created';
    if (input.stopReason === 'qualified' || input.stopReason === 'details_collected' || input.detailsComplete) {
        return 'qualified';
    }
    if (Object.values(input.collectedDetails || {}).some((value) => value.trim().length > 0)) {
        return 'collecting_details';
    }
    return 'engaged';
}

export function shouldAutoMovePipeline(
    current: ContactPipelineStage,
    next: ContactPipelineStage
): boolean {
    if (current === next) return false;
    if (current === 'converted' || current === 'opted_out') return false;
    if (next === 'opted_out') return true;
    if (next === 'not_qualified') return current !== 'order_created';
    if (current === 'not_qualified') {
        return next === 'qualified' || next === 'order_created' || next === 'converted';
    }
    const currentRank = PROGRESS_RANK[current];
    const nextRank = PROGRESS_RANK[next];
    return currentRank !== undefined && nextRank !== undefined && nextRank > currentRank;
}

type SupabaseLike = { from: (table: string) => any };

export async function updateContactPipelineStage(
    supabase: SupabaseLike,
    input: {
        pageId: string;
        contactId: string;
        stage: ContactPipelineStage;
        source: ContactPipelineSource;
        force?: boolean;
        now?: Date;
    }
): Promise<boolean> {
    const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('pipeline_stage,pipeline_stage_source')
        .eq('id', input.contactId)
        .eq('page_id', input.pageId)
        .maybeSingle();
    if (contactError) throw new Error(contactError.message || 'Could not load contact pipeline stage');
    if (!contact) return false;

    const current = isContactPipelineStage(contact.pipeline_stage) ? contact.pipeline_stage : 'new';
    if (input.source === 'chatbot' &&
        (contact.pipeline_stage_source === 'manual' || contact.pipeline_stage_source === 'messenger')) return false;
    // A person confirming the same stage in Messenger is still a handoff.
    // Retain that source so later photo requests cannot reopen bot intake.
    const messengerHandoff = current === input.stage && input.source === 'messenger' &&
        contact.pipeline_stage_source !== 'messenger';
    if (!input.force && !messengerHandoff && !shouldAutoMovePipeline(current, input.stage)) return false;

    let update = supabase
        .from('contacts')
        .update({
            pipeline_stage: input.stage,
            pipeline_stage_source: input.source,
            pipeline_stage_updated_at: (input.now || new Date()).toISOString()
        })
        .eq('id', input.contactId)
        .eq('page_id', input.pageId);
    // A human may change the stage between the read and this update.
    if (!input.force) {
        update = update.eq('pipeline_stage', contact.pipeline_stage);
        if (contact.pipeline_stage_source) update = update.eq('pipeline_stage_source', contact.pipeline_stage_source);
    }
    const { error: updateError } = await update;
    if (updateError) throw new Error(updateError.message || 'Could not update contact pipeline stage');
    return true;
}
