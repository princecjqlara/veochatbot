import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { workspaceScope } from '@/lib/veo-workspace';
import { jaucianRead } from '@/lib/veo-jaucian';
import { readVeoRpc } from '@/lib/veo-report-read';
import { telegramGroupCatalog, telegramGroupInput } from '@/lib/veo-telegram-groups';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const json = (data: any, status = 200) => NextResponse.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function actor(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) throw Object.assign(Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id);
    if (!scope?.launch_at) throw Object.assign(Error('Workspace access denied'), { status: 403 });
    return scope;
}
function checked(r: any) {
    if (r.error) throw Object.assign(Error(r.error.message || 'Telegram setup unavailable'), { status: r.error.code === '42501' ? 403 : r.error.code === '23505' ? 409 : r.error.code === '57014' ? 503 : 400 });
    return r.data;
}
const fail = (e: any) => json({ error: e.code === 'DATABASE_UNAVAILABLE' ? 'Telegram setup is temporarily unavailable' : e.message || 'Telegram setup unavailable' }, e.status || (e.code === 'DATABASE_UNAVAILABLE' ? 503 : 400));
export async function GET(request: NextRequest) {
    try { const scope = await actor(request);return json(checked(await readVeoRpc(getSupabaseAdmin(), 'veo_telegram_groups_page', { p_actor: scope.user_id }))); }
    catch (e) { return fail(e); }
}
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(Error('Same-origin request required'), { status: 403 });
        const scope = await actor(request);
        if (!['owner', 'team_leader', 'manager'].includes(scope.role)) throw Object.assign(Error('Supervisor access required'), { status: 403 });
        const raw = await request.text();if (Buffer.byteLength(raw) > 30000) return json({ error: 'Group setup request too large' }, 413);
        const body = JSON.parse(raw);telegramGroupInput(body);const db = getSupabaseAdmin();
        if (body.action === 'refresh') {
            if (scope.role !== 'owner') throw Object.assign(Error('Head access required to fetch the bot directory'), { status: 403 });
            const live = await jaucianRead(scope.tenant_id), pages = await db.from('pages').select('id,name,fb_page_id').eq('veo_tenant_id', scope.tenant_id).eq('veo_enabled', true);
            if (pages.error) throw Object.assign(Error('Page directory unavailable'), { status: 503 });
            const approved = new Set((process.env.VEO_APPROVED_TELEGRAM_CHAT_IDS || '').split(',').map(v => v.trim()).filter(Boolean));
            if (!approved.size) throw Object.assign(Error('Approved VEO groups are not configured'), { status: 503 });
            const groups = telegramGroupCatalog(live.groups, pages.data || [], approved);
            if (live.groups.length && !groups.length) throw Object.assign(Error('No fetched groups match the approved VEO destinations; previous setup retained'), { status: 503 });
            return json({ saved: checked(await db.rpc('veo_sync_telegram_groups', { p_actor: scope.user_id, p_groups: groups })) });
        }
        const directory = checked(await readVeoRpc(db, 'veo_telegram_groups_page', { p_actor: scope.user_id }));
        if (body.team_id && !directory.teams.some((t: any) => t.id === body.team_id) || body.user_id && !directory.accounts.some((w: any) => w.user_id === body.user_id)) throw Object.assign(Error('Team or account is outside your branch'), { status: 403 });
        if (!body.action.startsWith('remove_')) {
            const live = await jaucianRead(scope.tenant_id);
            if (!live.groups.some((g: any) => String(g.chat_id) === String(body.chat_id))) throw Error('Choose an approved active Jaucian group');
        }
        if (body.action === 'membership') {
            if (!checked(await db.rpc('veo_staff_can_telegram_group', { p_user: body.user_id, p_chat: body.chat_id }))) throw Object.assign(Error('Choose a linked group with permitted Pages for this person'), { status: 403 });
            const identity = await jaucianRead(scope.tenant_id, { resource: 'identity', chat_id: String(body.chat_id), user_id: String(body.telegram_user_id) });
            if (!identity.verified || Number(identity.user_id) !== Number(body.telegram_user_id) || Number(identity.chat_id) !== Number(body.chat_id)) throw Error('Current Telegram membership did not match');
        }
        return json({ saved: checked(await db.rpc('veo_telegram_group_action', { p_actor: scope.user_id, p_action: body.action,
            p_data: { team_id: body.team_id, user_id: body.user_id, chat_id: body.chat_id, telegram_user_id: body.telegram_user_id, thread_id: body.thread_id || null, page_ids: body.page_ids, primary: body.primary === true, move_pages: body.move_pages === true } })) });
    } catch (e) { return fail(e); }
}
