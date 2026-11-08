import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { uuid } from '@/lib/veo-workspace';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    return workspaceService(() => handleGET(request));
}
async function handleGET(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    const params = request.nextUrl.searchParams, page = params.get('page_id') || null, search = (params.get('search') || '').trim();
    const offset = Number(params.get('offset') || 0);
    if ((page && !uuid(page)) || search.length > 200 || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000) return NextResponse.json({ error: 'Invalid contact filters' }, { status: 400 });
    const result = await getSupabaseAdmin().rpc('veo_contacts_page', { p_actor: session.user.id, p_page: page, p_search: search, p_offset: offset, p_limit: 25 });
    if (result.error) return NextResponse.json({ error: result.error.code === '42501' ? 'Forbidden' : 'Contact search is unavailable. Please retry.' }, { status: result.error.code === '42501' ? 403 : 503 });
    return NextResponse.json(result.data, { headers: { 'Cache-Control': 'no-store' } });
}
import { workspaceService } from '@/lib/workspace-service';
