import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceEnabled, workspaceScope } from './veo-workspace';

export async function getUserPageIds(userId: string, signal?: AbortSignal, request?: object): Promise<string[]> {
    if (workspaceEnabled()) return (await workspaceScope(userId, request))?.page_ids || [];
    const query = getSupabaseAdmin()
        .from('user_pages')
        .select('page_id')
        .eq('user_id', userId);
    const { data, error } = await (signal ? query.abortSignal(signal) : query);
    if (error) throw error;
    return [...new Set((data || []).map((membership) => membership.page_id))];
}

export async function userHasPageAccess(userId: string, pageId: string, request?: object): Promise<boolean> {
    if (workspaceEnabled()) return Boolean((await workspaceScope(userId, request))?.page_ids.includes(pageId));
    const { data, error } = await getSupabaseAdmin()
        .from('user_pages')
        .select('page_id')
        .eq('user_id', userId)
        .eq('page_id', pageId)
        .maybeSingle();
    if (error) throw error;
    return Boolean(data);
}
