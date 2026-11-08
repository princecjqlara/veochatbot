import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { workspaceScope } from '@/lib/veo-workspace';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    return workspaceService(() => handleGET(request));
}
async function handleGET(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const scope = await workspaceScope(session.user.id, request);
    if (scope?.role !== 'owner') return NextResponse.json({ error: 'Owner required' }, { status: 403 });
    const source = request.nextUrl.searchParams.get('table') || 'contacts';
    if (!['contacts', 'campaigns', 'contact_purchases', 'contact_verified_payments', 'chatbot_contact_states', 'contact_profile_snapshots', 'page_activity_history'].includes(source)) return NextResponse.json({ error: 'Invalid archive' }, { status: 400 });
    const page = Math.max(1, Number(request.nextUrl.searchParams.get('page')) || 1);
    const result = await getSupabaseAdmin().from('veo_archive_records').select('record_key,record,archived_at', { count: 'exact' }).eq('tenant_id', scope.tenant_id)
        .eq('source_table', source).order('record_key').range((page - 1) * 100, page * 100 - 1);
    if (result.error) return NextResponse.json({ error: 'Archive unavailable' }, { status: 503 });
    return NextResponse.json({ records: result.data, total: result.count, page, read_only: true, launch_at: scope.launch_at }, { headers: { 'Cache-Control': 'no-store' } });
}
import { workspaceService } from '@/lib/workspace-service';
