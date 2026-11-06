import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
    if (request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
    const session = await getSessionFromRequest(request);
    if (!session?.user.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    try {
        const body = await request.json();
        if (typeof body.username !== 'string' || typeof body.no_username !== 'boolean' || body.username.length > 64) return NextResponse.json({ error: 'Enter your Telegram username or choose no username' }, { status: 400 });
        const saved = await getSupabaseAdmin().rpc('veo_save_telegram_profile', { p_actor: session.user.id, p_username: body.username, p_no_username: body.no_username });
        if (saved.error) return NextResponse.json({ error: saved.error.code === '42501' ? 'Forbidden' : 'Use only letters, numbers and underscores for your Telegram username.' }, { status: saved.error.code === '42501' ? 403 : 400 });
        return NextResponse.json(saved.data, { headers: { 'Cache-Control': 'no-store' } });
    } catch { return NextResponse.json({ error: 'Could not save your Telegram profile. Please retry.' }, { status: 400 }); }
}
