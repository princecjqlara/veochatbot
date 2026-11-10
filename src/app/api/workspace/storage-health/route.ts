import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
const json = (body: any, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);if (!session?.user?.id) return json({ error: 'Sign in required' }, 401);
        if (session.user.role !== 'owner') return json({ error: 'Owner access required' }, 403);
        const result = await getSupabaseAdmin(request.signal).rpc('veo_owner_storage_health', { p_actor: session.user.id });
        if (result.error || !result.data) return json({ error: 'Database storage health is unavailable' }, result.error?.code === '42501' ? 403 : 503);
        return json(result.data);
    } catch { return json({ error: 'Database storage health is unavailable' }, 503); }
}
