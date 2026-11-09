import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope, uuid } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
import { requestDeadline } from '@/lib/request-deadline';
import { readContactIdentityBatch } from '@/lib/veo-contact-identity-sync';
import { workspaceService } from '@/lib/workspace-service';
export const maxDuration = 30;
export async function POST(request: NextRequest) {
    return workspaceService(async () => {
        if (request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        const scope = await workspaceScope(session.user.id, request);
        const body = await request.json();
        if (scope?.role !== 'owner') return NextResponse.json({ error: 'Owner access required' }, { status: 403 });
        if (!uuid(body.page_id) || !scope.page_ids.includes(body.page_id) || (body.cursor != null && (typeof body.cursor !== 'string' || body.cursor.length > 2048))) return NextResponse.json({ error: 'Invalid Page or cursor' }, { status: 400 });
        return requestDeadline(async signal => {
            const db = getSupabaseAdmin(signal), owner = randomUUID();
            const page = await db.from('pages').select('fb_page_id,access_token').eq('id', body.page_id).single();
            if (page.error) throw Object.assign(new Error('Page connection is unavailable'), { status: 503 });
            const lease = await db.rpc('acquire_page_sync_lease', { p_page_id: body.page_id, p_owner: owner, p_lease_seconds: 60 });
            if (lease.error) throw Object.assign(new Error('Contact sync is unavailable'), { status: 503 });
            if (!lease.data) return NextResponse.json({ error: 'A sync batch for this Page is already running' }, { status: 409 });
            try {
                const batch = await readContactIdentityBatch(page.data, body.cursor, signal);
                const saved = await db.rpc('veo_seed_contact_identities', { p_actor: scope.user_id, p_page: body.page_id, p_contacts: batch.contacts });
                if (saved.error) throw Object.assign(new Error('Could not save contact identities; this batch can be retried'), { status: 503 });
                return NextResponse.json({ ...saved.data, next_cursor: batch.next_cursor, complete: !batch.next_cursor }, { headers: { 'Cache-Control': 'no-store' } });
            } finally { await db.rpc('release_page_sync_lease', { p_page_id: body.page_id, p_owner: owner }); }
        }, 15_000);
    });
}
