import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomBytes } from 'node:crypto';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { jaucianRead } from '@/lib/veo-jaucian';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    return workspaceService(() => handleGET(request));
}
async function handleGET(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    const result = await getSupabaseAdmin().from('veo_worker_mappings').select('telegram_user_id').eq('user_id', session.user.id).maybeSingle();
    if (result.error) return NextResponse.json({ error: 'Telegram link status unavailable' }, { status: 503 });
    return NextResponse.json({ linked: !!result.data, telegram_user_id: result.data ? String(result.data.telegram_user_id) : null }, { headers: { 'Cache-Control': 'no-store' } });
}
export async function POST(request: NextRequest) {
    return workspaceService(() => handlePOST(request));
}
async function handlePOST(request: NextRequest) {
    if (request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required' }, { status: 403 });
    const session = await getSessionFromRequest(request);
    if (!session?.user.id) return NextResponse.json({ error: 'Sign in required' }, { status: 401 });
    let body: { code?: string; relink?: boolean; expected_telegram_user_id?: string } = {};
    try { body = await request.json(); } catch { /* Existing callers create the legacy link command. */ }
    if (!body || typeof body !== 'object' || Array.isArray(body) || (body.relink !== undefined && typeof body.relink !== 'boolean')) return NextResponse.json({ error: 'Choose a valid Telegram link action' }, { status: 400 });
    if (body.relink === true && (typeof body.code !== 'string' || typeof body.expected_telegram_user_id !== 'string' || !/^[1-9]\d{0,15}$/.test(body.expected_telegram_user_id) || !Number.isSafeInteger(Number(body.expected_telegram_user_id)))) return NextResponse.json({ error: 'Refresh your current link and enter a new pairing code' }, { status: 400 });
    if (body.code !== undefined) {
        if (typeof body.code !== 'string' || !/^[a-f0-9]{48}$/.test(body.code)) return NextResponse.json({ error: 'Enter the 48 character code Jaucian sent you' }, { status: 400 });
        if (body.relink === true) {
            const db = getSupabaseAdmin(), hash = createHash('sha256').update(body.code).digest('hex');
            const [account, pairing] = await Promise.all([
                db.from('veo_accounts').select('tenant_id').eq('user_id', session.user.id).eq('active', true).maybeSingle(),
                db.from('veo_telegram_pairing_codes').select('tenant_id,chat_id,telegram_user_id').eq('code_hash', hash).gt('expires_at', new Date().toISOString()).is('consumed_at', null).maybeSingle()
            ]);
            if (account.error || pairing.error) return NextResponse.json({ error: 'Telegram verification is temporarily unavailable' }, { status: 503 });
            if (!account.data || !pairing.data || account.data.tenant_id !== pairing.data.tenant_id) return NextResponse.json({ error: 'Code expired or invalid. Message Jaucian /link for a fresh code.' }, { status: 400 });
            if (!(process.env.VEO_APPROVED_TELEGRAM_CHAT_IDS || '').split(',').map(v => v.trim()).includes(String(pairing.data.chat_id))) return NextResponse.json({ error: 'The pairing group is no longer approved' }, { status: 403 });
            try {
                const verified = await jaucianRead(account.data.tenant_id, { resource: 'identity', chat_id: String(pairing.data.chat_id), user_id: String(pairing.data.telegram_user_id) });
                if (verified.verified !== true || String(verified.user_id) !== String(pairing.data.telegram_user_id) || String(verified.chat_id) !== String(pairing.data.chat_id)) return NextResponse.json({ error: 'Current Telegram membership could not be verified. Your existing link is retained.' }, { status: 403 });
            } catch { return NextResponse.json({ error: 'Telegram verification is temporarily unavailable. Your existing link is retained.' }, { status: 503 }); }
            const saved = await db.rpc('veo_relink_telegram_pairing', { p_actor: session.user.id, p_hash: hash, p_expected: body.expected_telegram_user_id });
            if (saved.error && !['23505', '40001', '42501'].includes(saved.error.code)) return NextResponse.json({ error: 'Telegram relinking is temporarily unavailable. Your existing link is retained.' }, { status: 503 });
            if (saved.error) return NextResponse.json({ error: saved.error.code === '23505' ? 'That Telegram account belongs to another VEO user' : saved.error.code === '40001' ? 'Your Telegram link changed. Refresh your profile before trying again.' : 'Code expired or invalid. Message Jaucian /link for a fresh code.' }, { status: ['23505', '40001'].includes(saved.error.code) ? 409 : 400 });
            return NextResponse.json(saved.data, { headers: { 'Cache-Control': 'no-store' } });
        }
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
