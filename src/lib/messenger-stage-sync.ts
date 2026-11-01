import type { ContactPipelineStage } from '@/lib/contact-pipeline';
import { classifyMessengerHistoryMessage, type MessengerHandoffOptions, type MessengerHistoryMessage } from '@/lib/messaging-auto-tag';

export type MessengerStageEvent = {
    messageId: string;
    label: string;
    stage: ContactPipelineStage;
    occurredAt: string;
};

/** Only Page-authored administrative notices are authoritative stage changes. */
export function parseMessengerStageEvent(message: MessengerHistoryMessage, facebookPageId: string,
    options: MessengerHandoffOptions = {}): MessengerStageEvent | null {
    if (!message.id?.trim() || !classifyMessengerHistoryMessage(message, facebookPageId, options)) return null;
    const at = Date.parse(message.created_time || '');
    if (!Number.isFinite(at)) return null;
    const match = /^Lead stage set to ([^\r\n]{1,80}?)\.?$/i.exec(message.message?.trim() || '');
    if (!match) {
        if (classifyMessengerHistoryMessage(message, facebookPageId, options) !== 'order_created') return null;
        return { messageId: message.id, label: 'Order Created', stage: 'order_created', occurredAt: new Date(at).toISOString() };
    }
    const label = match[1].trim();
    const key = label.toLowerCase().replace(/[\s-]+/g, '_');
    const stages: Record<string, ContactPipelineStage> = {
        intake: 'new', new: 'new', contacted: 'engaged', engaged: 'engaged', interested: 'engaged',
        collecting_details: 'collecting_details', qualified: 'qualified', not_qualified: 'not_qualified',
        unqualified: 'not_qualified', disqualified: 'not_qualified', converted: 'converted',
        order_created: 'order_created', opted_out: 'opted_out'
    };
    return { messageId: message.id, label, stage: stages[key] || 'engaged', occurredAt: new Date(at).toISOString() };
}

/** Save every observed stage to history; the database orders events atomically. */
export async function syncMessengerStageHistory(db: { from?: (table: string) => any; rpc?: (name: string, args: any) => any }, input: {
    pageId: string; contactId: string; facebookPageId: string; messages: MessengerHistoryMessage[];
    options?: MessengerHandoffOptions;
}) {
    const events = input.messages.map(message => parseMessengerStageEvent(message, input.facebookPageId, input.options))
        .filter((event): event is MessengerStageEvent => Boolean(event))
        .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    let applied = 0;
    for (const event of events) {
        if (!db.rpc) throw new Error('Messenger stage storage is unavailable');
        const { data, error } = await db.rpc('apply_messenger_lead_stage', {
            p_page_id: input.pageId, p_contact_id: input.contactId, p_message_id: event.messageId,
            p_label: event.label, p_stage: event.stage, p_occurred_at: event.occurredAt
        });
        if (error) throw new Error(error.message || 'Could not save Messenger lead stage');
        if (data?.applied) applied++;
    }
    return { events: events.length, applied };
}
