import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createWorkspaceAccount, workspaceAction, workspaceScope, uuid, philippineDate, passwordHash } from '@/lib/veo-workspace';
import { parseMoneyMinor } from '@/lib/contact-profile-evidence';
import { randomUUID } from 'node:crypto';
import { jaucianRead, verifyWorkerMapping } from '@/lib/veo-jaucian';
import { readVeoRpc } from '@/lib/veo-report-read';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const bucket = 'veo-conversation-submissions';
const errorResponse = (error: any) => NextResponse.json({ error: error.code === 'DATABASE_UNAVAILABLE' || error.code === '57014' ? 'Workspace report is busy. Retry shortly.' : error.message || 'Workspace unavailable' }, { status: error.status || (error.code === 'DATABASE_UNAVAILABLE' || error.code === '57014' ? 503 : 400) });
async function actor(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id);
    if (!scope?.launch_at) throw Object.assign(new Error('Workspace launch is pending'), { status: 403 });
    return scope;
}
export async function GET(request: NextRequest) {
    try {
        const scope = await actor(request), db = getSupabaseAdmin();
        const day = request.nextUrl.searchParams.get('date') || philippineDate();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid date');
        if (day < philippineDate(new Date(scope.launch_at!)) || day > philippineDate()) throw new Error('Choose a Philippine work date from launch through today');
        const contactId = request.nextUrl.searchParams.get('contact_id');
        if (contactId) {
            const contact = await db.from('contacts').select('id,page_id,name,psid,pipeline_stage').eq('id', contactId).maybeSingle();
            if (contact.error || !contact.data || !scope.page_ids.includes(contact.data.page_id)) throw Object.assign(new Error('Forbidden'), { status: 403 });
            const profile = await db.rpc('veo_profile_detail_access', { p_actor: scope.user_id, p_contact: contactId });
            if (profile.error || !Array.isArray(profile.data?.branch_worker_ids)) throw Object.assign(new Error('Contact financial history unavailable'), { status: profile.error?.code === '42501' ? 403 : 503 });
            const workers = profile.data.branch_worker_ids;
            const [details, orders, legacy] = await Promise.all([
                db.from('veo_contact_details').select('*').eq('contact_id', contactId).maybeSingle(),
                db.from('veo_order_facts').select('*').eq('contact_id', contactId).in('seller_id', workers),
                db.rpc('get_contact_finance_records', { p_page_id: contact.data.page_id, p_contact_id: contactId })
            ]);
            if (details.error || orders.error || legacy.error) throw new Error('Contact financial history unavailable');
            const payments = orders.data?.length ? await db.from('veo_payments').select('*').in('order_id', orders.data.map(o => o.id)).order('occurred_at') : { data: [], error: null };
            if (payments.error) throw new Error('Payment history unavailable');
            const sellerIds = [...new Set((orders.data || []).map(o => o.seller_id))];
            const sellers = sellerIds.length ? await db.from('users').select('id,name').in('id', sellerIds) : { data: [], error: null };
            if (sellers.error) throw new Error('Seller identities unavailable');
            const names = new Map((sellers.data || []).map(s => [s.id, s.name]));
            const ltv: Record<string, number> = {};
            const retainedPayments = (legacy.data?.payments || []).filter((p: any) => scope.role === 'owner' || workers.includes(p.verified_by));
            for (const p of retainedPayments) if (!p.voided_at) ltv[p.currency] = (ltv[p.currency] || 0) + Number(p.amount_minor) * (p.kind === 'refund' ? -1 : 1);
            for (const o of orders.data || []) ltv[o.currency] = (ltv[o.currency] || 0) + Number(o.paid_minor);
            // Shared-page contacts are shared; personal order attribution stays visible on the contact profile.
            return NextResponse.json({ contact: contact.data, details: details.data, orders: (orders.data || []).map(o => ({ ...o, seller_name: names.get(o.seller_id) || null })), payments: payments.data, lifetime_value: ltv,
                coverage: (retainedPayments.length ? 'Verified retained payments plus payments recorded since launch' : `Recorded since launch (${scope.launch_at}); earlier financial history is unavailable`) + (scope.role === 'owner' ? '' : '. Financial history is limited to your seller branch; other branches are excluded.') }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const params = request.nextUrl.searchParams, page = params.get('page_id');
        const offset = Number(params.get('offset') || 0), view = params.get('view') || 'dashboard', search = params.get('search') || '';
        if ((page && !uuid(page)) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000 || search.length > 200 ||
            !['dashboard', 'clients', 'closed', 'done', 'salary', 'accounts', 'sync'].includes(view)) throw new Error('Invalid order filters');
        const [dashboard, orders, capacity] = await Promise.all([
            readVeoRpc(db, 'veo_dashboard', { p_actor: scope.user_id, p_day: day }),
            readVeoRpc(db, 'veo_orders_page', { p_actor: scope.user_id, p_day: day, p_view: view, p_page: page, p_search: search, p_offset: offset, p_limit: 50 }),
            readVeoRpc(db, 'veo_team_capacity', { p_actor: scope.user_id, p_day: day })
        ]);
        if (dashboard.error || orders.error || capacity.error) throw new Error(dashboard.error?.message || orders.error?.message || capacity.error?.message);
        return NextResponse.json({ ...dashboard.data, orders: orders.data?.orders || [], order_page: orders.data, capacity: capacity.data }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
    let uploadedPath: string | null = null;
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(new Error('Same-origin request required'), { status: 403 });
        const scope = await actor(request), db = getSupabaseAdmin();
        if (request.headers.get('content-type')?.includes('multipart/form-data')) {
            const form = await request.formData(), file = form.get('photo'), orderId = form.get('order_id');
            if (!uuid(orderId) || !file || typeof file === 'string' || !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 3 * 1024 * 1024 || file.size === 0) throw new Error('Choose a JPG, PNG or WebP photo up to 3 MB');
            const bytes = new Uint8Array(await file.arrayBuffer());
            const valid = file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 : file.type === 'image/png' ? bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10' : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
            if (!valid) throw new Error('Photo contents do not match its image type');
            const path = `${scope.tenant_id}/${scope.user_id}/${randomUUID()}`;
            const reserved = await db.from('veo_photo_objects').insert({ object_path: path });
            if (reserved.error) throw new Error('Could not reserve private photo storage');
            uploadedPath = path;
            const stored = await db.storage.from(bucket).upload(path, bytes, { contentType: file.type, upsert: false });
            if (stored.error) throw new Error('Private photo storage is unavailable');
            uploadedPath = path;
            const saved = await workspaceAction(scope.user_id, 'submission', { order_id: orderId, object_path: path });
            return NextResponse.json({ saved }, { status: 202 });
        }
        const body = await request.json(), action = body.action;
        if (action === 'attendance') throw new Error('Answer Jaucian’s Telegram poll for active tomorrow. The workspace reads verified poll votes.');
        if (action === 'create_account') return NextResponse.json({ saved: await createWorkspaceAccount(scope.user_id, body) }, { status: 201 });
        if (action === 'password') return NextResponse.json({ saved: await workspaceAction(scope.user_id, 'password', { user_id: body.user_id || scope.user_id, password_hash: await passwordHash(body.password) }) });
        if (action === 'mapping' && scope.role !== 'owner') throw Object.assign(new Error('Owner access required'), { status: 403 });
        if (action === 'mapping' && body.team_id) {
            if (body.thread_id === '') body.thread_id = null;
            const destinations = (process.env.VEO_APPROVED_TELEGRAM_CHAT_IDS || '').split(',').map(v => v.trim());
            if (!destinations.includes(String(body.chat_id))) throw new Error('Choose an approved VEO Telegram destination');
            const directory = await jaucianRead(scope.tenant_id);
            if (!directory.groups?.some((g: any) => String(g.chat_id) === String(body.chat_id))) throw new Error('Choose a currently approved active Jaucian VEO group');
        }
        if (action === 'mapping' && !body.team_id) {
            const verified = await verifyWorkerMapping(scope.tenant_id, body.user_id, body.telegram_user_id, body.chat_id);
            const r = await db.rpc('veo_map_staff_telegram', { p_actor: scope.user_id, p_user: body.user_id, p_telegram: Number(verified.user_id), p_chat: Number(verified.chat_id) });
            if (r.error) throw Object.assign(new Error(r.error.message), { status: r.error.code === '42501' ? 403 : 400 });
            return NextResponse.json({ saved: r.data });
        }
        if (action === 'order') body.total_minor = parseMoneyMinor(body.amount);
        if (action === 'payment') body.amount_minor = parseMoneyMinor(body.amount);
        if (!['assign_pages', 'order', 'payment', 'attribution', 'attendance', 'contact', 'mapping', 'staff_delete', 'claim_client', 'fulfillment', 'client_assignment', 'attendance_today'].includes(action)) throw new Error('Unknown action');
        const saved = await workspaceAction(scope.user_id, action, body);
        return NextResponse.json({ saved });
    } catch (error) {
        if (uploadedPath) {
            const db = getSupabaseAdmin(), removed = await db.storage.from(bucket).remove([uploadedPath]);
            if (!removed.error) await db.from('veo_photo_objects').update({ deleted_at: new Date().toISOString() }).eq('object_path', uploadedPath);
        }
        return errorResponse(error);
    }
}
