import type { MessengerSystemSignal } from '@/lib/messaging-auto-tag';

type SupabaseLike = { from: (table: string) => any };
type PageTag = { id: string; name: string; created_at?: string | null };
type OutcomeTag = { id: string; system_key: string };

export const MESSENGER_OUTCOME_TAGS: Record<Exclude<MessengerSystemSignal, 'manual'>, { name: string; color: string }> = {
    qualified: { name: 'History: Qualified', color: '#2563eb' },
    not_qualified: { name: 'History: Not Qualified', color: '#dc2626' },
    converted: { name: 'History: Converted', color: '#7c3aed' },
    order_created: { name: 'History: Order Created', color: '#f59e0b' }
};

export function buildMessengerOutcomeTagRows(pageId: string) {
    return Object.entries(MESSENGER_OUTCOME_TAGS).map(([systemKey, tag]) => ({
        name: tag.name, color: tag.color, owner_type: 'page' as const,
        owner_id: pageId, page_id: pageId, is_default: false,
        system_key: `stage_history:${systemKey}`
    }));
}

export function choosePositiveOutcomeTag(tags: PageTag[]) {
    return tags.find(tag => /^paidavailedservices?$/.test(tag.name.toLowerCase().replace(/[^a-z]/g, ''))) || tags[0] || null;
}

export async function ensureMessengerOutcomeTags(db: SupabaseLike, pageId: string): Promise<OutcomeTag[]> {
    const systemKeys = Object.keys(MESSENGER_OUTCOME_TAGS).map(key => `stage_history:${key}`);
    const { data: existing, error } = await db.from('tags').select('id,system_key')
        .eq('owner_type', 'page').eq('owner_id', pageId).in('system_key', systemKeys);
    if (error) throw error;
    const keys = new Set((existing || []).map((tag: OutcomeTag) => tag.system_key));
    const missing = buildMessengerOutcomeTagRows(pageId).filter(tag => !keys.has(tag.system_key));
    if (!missing.length) return existing || [];
    const inserted = await db.from('tags').upsert(missing, { onConflict: 'owner_id,system_key' });
    if (inserted.error) throw inserted.error;
    const result = await db.from('tags').select('id,system_key')
        .eq('owner_type', 'page').eq('owner_id', pageId).in('system_key', systemKeys);
    if (result.error) throw result.error;
    return result.data || [];
}

/** Apply cumulative outcome tags at the point a Messenger stage is observed. */
export async function assignMessengerOutcomeTags(db: SupabaseLike, pageId: string, contactId: string, stage: string,
    options: { includePositiveTag?: boolean } = {}) {
    if (!Object.prototype.hasOwnProperty.call(MESSENGER_OUTCOME_TAGS, stage)) return;
    const tags = await ensureMessengerOutcomeTags(db, pageId);
    const outcome = tags.find(tag => tag.system_key === `stage_history:${stage}`);
    if (!outcome) throw new Error(`Messenger outcome tag is unavailable: ${stage}`);
    const result = await db.from('contact_tags').upsert([{ contact_id: contactId, tag_id: outcome.id }],
        { onConflict: 'contact_id,tag_id', ignoreDuplicates: true });
    if (result.error) throw result.error;
    // Stage history is evidence of a stage, never proof of payment. Existing
    // manual/default tags stay assigned; new stage events only add history tags.
}
