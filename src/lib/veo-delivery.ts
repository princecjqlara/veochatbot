import { getSupabaseAdmin } from './supabase';

export async function assertVeoSendAllowed(facebookPageId: string, actor?: string, campaign?: string) {
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return;
    const { data, error } = await getSupabaseAdmin().rpc('veo_send_allowed', {
        p_fb_page: facebookPageId, p_actor: actor || null, p_campaign: campaign || null
    });
    if (error || data !== true) throw new Error('Page or campaign authorization was revoked');
}
export async function assertVeoJobAllowed(pageId: string, actor: string, createdAt?: string) {
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return;
    const { data, error } = await getSupabaseAdmin().rpc('veo_scope', { p_actor: actor });
    if (error || !data?.page_ids?.includes(pageId) || (createdAt && Date.parse(createdAt) < Date.parse(data.launch_at))) throw new Error('Job access was revoked or the job was archived');
}
