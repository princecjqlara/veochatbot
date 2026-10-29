import { createHmac, timingSafeEqual } from 'crypto';
import { getSupabaseAdmin } from '@/lib/supabase';
import type { ChatbotContactState } from '@/lib/chatbot-control';
import type { ChatbotConfig } from '@/lib/chatbot';
import { salesSettings, salesAssumptions, type SalesProgress } from '@/lib/chatbot-sales-assistant';
import type { ChatbotKnowledgeMatch } from '@/lib/chatbot-knowledge';
import { isChatbotContactAllowed } from '@/lib/chatbot-control';
import { isPipelineClosedForAutomation } from '@/lib/contact-pipeline';

const formSecret = () => process.env.CHATBOT_FORM_SECRET || process.env.NEXTAUTH_SECRET;
export function createSalesFormToken(pageId: string, contactId: string, now = Date.now()): string | null {
    const secret = formSecret();
    if (!secret) return null;
    const payload = Buffer.from(JSON.stringify({ pageId, contactId, expires: now + 7 * 86400000 })).toString('base64url');
    return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function verifySalesFormToken(token: string, now = Date.now()): { pageId: string; contactId: string } | null {
    const secret = formSecret();
    if (!secret || token.length > 1000) return null;
    try {
        const [payload, signature, extra] = token.split('.');
        if (!signature || extra) return null;
        const expected = createHmac('sha256', secret).update(payload).digest();
        const provided = Buffer.from(signature, 'base64url');
        if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) return null;
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!/^[\da-f-]{36}$/i.test(parsed.pageId) || !/^[\da-f-]{36}$/i.test(parsed.contactId) || !Number.isFinite(parsed.expires) || parsed.expires <= now) return null;
        return { pageId: parsed.pageId, contactId: parsed.contactId };
    } catch { return null; }
}
export function salesFormUrl(pageId: string, contactId: string): string | undefined {
    const token = createSalesFormToken(pageId, contactId);
    const origin = process.env.NEXTAUTH_URL || process.env.APP_URL;
    if (!token || !origin) return undefined;
    const url = new URL('/sales-form', origin); url.searchParams.set('token', token); return url.toString();
}
export async function mergeSalesRecord(db: { rpc?: (name: string, args: Record<string, unknown>) => any }, input: {
    pageId: string; contactId: string; details?: Record<string, string>; base?: Record<string, string>;
    source: 'chat' | 'form' | 'delivery'; eventKey: string; observedAt: string; progress?: SalesProgress;
}): Promise<{ state: ChatbotContactState; conflicts: string[]; duplicate: boolean }> {
    if (!db.rpc) throw new Error('Sales assistant migration is required');
    const patch = Object.fromEntries(Object.entries(input.details || {}).filter(([key, value]) => input.base?.[key] !== value));
    const { data, error } = await db.rpc('merge_chatbot_sales_details', {
        p_page_id: input.pageId, p_contact_id: input.contactId, p_patch: patch, p_base: input.base || {},
        p_source: input.source, p_event_key: input.eventKey, p_observed_at: input.observedAt, p_progress: input.progress || {}
    });
    if (error || !data?.state) throw new Error(error?.message || 'Could not synchronize customer information');
    return data;
}

/** Resolve configured IDs through existing ready assets. No user-supplied URL
 * can masquerade as a portfolio sample, and inactive assets never get selected. */
export async function loadAssignedSalesSamples(config: ChatbotConfig): Promise<ChatbotKnowledgeMatch[]> {
    const ids = salesSettings(config.sales_assistant_settings).samples.filter(sample => sample.active).map(sample => sample.document_id);
    if (!ids.length) return [];
    const db = getSupabaseAdmin(); const pageId = config.knowledge_source_page_id || config.page_id;
    const results = await Promise.all([
        db.from('chatbot_media_assets').select('knowledge_document_id,title,usage_notes').eq('page_id', pageId).eq('status', 'ready').eq('media_type', 'video').eq('auto_send', true).in('knowledge_document_id', ids),
        db.from('chatbot_drive_files').select('knowledge_document_id,name').eq('page_id', pageId).eq('media_type', 'video').eq('auto_send', true).in('knowledge_document_id', ids)
    ]);
    const out: ChatbotKnowledgeMatch[] = [];
    results.forEach((result, index) => {
        if (result.error) throw new Error(result.error.message);
        for (const row of (result.data || []) as Array<{ knowledge_document_id: string; title?: string; name?: string; usage_notes?: string }>) out.push({ document_id: row.knowledge_document_id,
            title: (index ? '[Drive video] ' : '[video] ') + (row.title || row.name),
            content: (index ? 'GOOGLE DRIVE MEDIA FILE (video)' : 'MEDIA ASSET (video)') + '\n' + (row.usage_notes || row.name || ''), similarity: 1 } as ChatbotKnowledgeMatch);
    });
    return out;
}
export { salesAssumptions };

/** A form response is a customer action in the existing queue. It does not
 * extend Messenger's response window or create any ownership transition. */
export async function queueSalesFormResponse(db: { from: (table: string) => any }, input: {
    pageId: string; contactId: string; config: ChatbotConfig; state: ChatbotContactState;
    contact: { last_inbound_at?: string | null; chatbot_enabled?: boolean | null; pipeline_stage?: any; pipeline_stage_source?: any }; now?: Date;
}): Promise<boolean> {
    const now = input.now || new Date();
    const anchor = input.contact.last_inbound_at;
    const elapsed = anchor ? now.getTime() - Date.parse(anchor) : NaN;
    if (!input.config.enabled || !isChatbotContactAllowed(input.config, input.contactId) || input.contact.chatbot_enabled === false || input.state.status === 'stopped' ||
        isPipelineClosedForAutomation(input.contact.pipeline_stage, input.contact.pipeline_stage_source, input.config) || !Number.isFinite(elapsed) || elapsed < 0 || elapsed >= 24 * 3600000 - 60000) return false;
    const { error } = await db.from('chatbot_follow_up_jobs').upsert({
        page_id: input.pageId, contact_id: input.contactId, anchor_inbound_at: anchor, schedule_type: 'response', sequence_index: 2000,
        purpose: 'form_submission', due_at: now.toISOString(), message_text: 'AI-generated from conversation at send time',
        automation_epoch: input.state.automation_epoch || 0, policy_revision: input.config.policy_revision || 1, status: 'pending'
    }, { onConflict: 'contact_id,anchor_inbound_at,schedule_type,sequence_index,automation_epoch,purpose', ignoreDuplicates: true });
    if (error) throw new Error(error.message || 'Could not queue the form response');
    return true;
}
