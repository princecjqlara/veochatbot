import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    return workspaceService(() => handleGET(request));
}
async function handleGET(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    const result = await getSupabaseAdmin().from('veo_worker_mappings').select('telegram_user_id').eq('user_id', session.user.id).maybeSingle();
    if (result.error) return NextResponse.json({ error: 'Telegram link status unavailable' }, { status: 503 });
    return NextResponse.json({ linked: !!result.data }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
    return workspaceService(() => handlePOST(request));
}
async function handlePOST(request: NextRequest) {
    if (request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
    const session = await getSessionFromRequest(request);
    if (!session?.user.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    let body: { code?: string } = {};
    try { body = await request.json(); } catch { /* Existing callers create the legacy link command. */ }
    if (body.code !== undefined) {
        if (typeof body.code !== 'string' || !/^[a-f0-9]{48}$/.test(body.code)) return NextResponse.json({ error: 'Enter the 48 character code Jaucian sent you' }, { status: 400 });
        const saved = await getSupabaseAdmin().rpc('veo_confirm_telegram_pairing', { p_actor: session.user.id, p_hash: createHash('sha256').update(body.code).digest('hex') });
        if (saved.error) return NextResponse.json({ error: saved.error.code === '23505' ? 'That Telegram account is already linked to another VEO user' : 'Code expired or already used. Message Jaucian /link to get a new code.' }, { status: saved.error.code === '23505' ? 409 : 400 });
        return NextResponse.json({ linked: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const code = randomBytes(24).toString('hex');
    const saved = await getSupabaseAdmin().rpc('veo_create_telegram_link', { p_actor: session.user.id, p_hash: createHash('sha256').update(code).digest('hex') });
    if (saved.error) return NextResponse.json({ error: 'Could not create a Telegram link. Please retry.' }, { status: saved.error.code === '42501' ? 403 : 503 });
    return NextResponse.json({ command: `/veolink ${code}`, expires_at: saved.data.expires_at }, { headers: { 'Cache-Control': 'no-store' } });
}
import { workspaceService } from '@/lib/workspace-service';
