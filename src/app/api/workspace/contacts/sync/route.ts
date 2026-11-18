import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requestDeadline } from '@/lib/request-deadline';
import { readContactIdentityBatch } from '@/lib/veo-contact-identity-sync';
import { requireStorageForOptionalWork } from '@/lib/veo-storage-health';
import { isSupabaseUnavailable } from '@/lib/supabase-errors';
export const maxDuration = 30;
const reply = (body: any, status = 200, retry?: number) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...(retry ? { 'Retry-After': String(retry) } : {}) } });
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) return reply({ error: 'Same-origin request required' }, 403);
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return reply({ error: 'Unauthorized' }, 401);
        const scope = await workspaceScope(session.user.id, request);
        if (!scope?.launch_at || !['owner','team_leader','manager','member'].includes(scope.role)) return reply({ error: 'Active workspace access required' }, 403);
        let body: any;try { body = await request.json(); } catch { return reply({ error: 'Invalid sync request' }, 400); }
        if (!body || !uuid(body.page_id) || (body.cursor != null && (typeof body.cursor !== 'string' || body.cursor.length > 2048))) return reply({ error: 'Invalid Page or cursor' }, 400);
        if (!scope.page_ids.includes(body.page_id)) return reply({ error: 'Choose one of your assigned Pages' }, 403);
        return await requestDeadline(async signal => {
            const db = getSupabaseAdmin(signal), owner = randomUUID();
            await requireStorageForOptionalWork(db);
            const page = await db.from('pages').select('fb_page_id,access_token').eq('id', body.page_id).single();
            if (page.error) throw Object.assign(new Error('Page connection is unavailable'), { status: 503 });
            const lease = await db.rpc('acquire_page_sync_lease', { p_page_id: body.page_id, p_owner: owner, p_lease_seconds: 60 });
            if (lease.error) throw Object.assign(new Error('Contact sync is unavailable'), { status: 503 });
            if (!lease.data) return reply({ error: 'A sync batch for this Page is already running. Retry shortly.', retryable: true }, 409, 5);
            try {
                const batch = await readContactIdentityBatch(page.data, body.cursor, signal);
                const saved = await db.rpc('veo_seed_contact_identities', { p_actor: scope.user_id, p_page: body.page_id, p_contacts: batch.contacts });
                if (saved.error) throw Object.assign(new Error(saved.error.code === '42501' ? 'Page access changed or your account was suspended. Refresh before syncing again.' : 'Could not save contact identities; this batch can be retried'), { status: saved.error.code === '42501' ? 403 : 503 });
                return reply({ ...saved.data, next_cursor: batch.next_cursor, complete: !batch.next_cursor });
            } finally { await db.rpc('release_page_sync_lease', { p_page_id: body.page_id, p_owner: owner }); }
        }, 15_000);
    } catch (error: any) {
        const storage = error.code === 'STORAGE_ATTENTION', unavailable = !error.status && isSupabaseUnavailable(error);
        const status = storage || unavailable ? 503 : error.status || 503;
        return reply({ error: unavailable ? 'Contact sync is temporarily unavailable. Retry this batch shortly.' : error.message || 'Contact sync unavailable', ...(error.code === 'ACCOUNT_SUSPENDED' || storage ? { code: error.code } : {}), retryable: status >= 500 }, status, storage ? 300 : status >= 500 ? 5 : undefined);
    }
}
