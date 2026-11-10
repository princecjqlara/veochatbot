import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createWorkspaceAccount, workspaceAction, workspaceScope, uuid, philippineDate, passwordHash } from '@/lib/veo-workspace';
import { parseMoneyMinor } from '@/lib/contact-profile-evidence';
import { jaucianRead, verifyWorkerMapping } from '@/lib/veo-jaucian';
import { readVeoRpc } from '@/lib/veo-report-read';
import { loadVeoAccountDirectory } from '@/lib/veo-account-directory';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;
const errorResponse = (error: any) => NextResponse.json({ error: error.code === 'DATABASE_UNAVAILABLE' || error.code === '57014' ? 'Workspace report is busy. Retry shortly.' : error.message || 'Workspace unavailable' }, { status: error.status || (error.code === 'DATABASE_UNAVAILABLE' || error.code === '57014' ? 503 : 400) });
async function actor(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) throw Object.assign(new Error('Sign in required'), { status: 401 });
    const scope = await workspaceScope(session.user.id, request);
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
            const [details, orders, legacy, closedDeals] = await Promise.all([
                db.from('veo_contact_details').select('*').eq('contact_id', contactId).maybeSingle(),
                db.from('veo_order_facts').select('*').eq('contact_id', contactId).in('seller_id', workers),
                db.rpc('get_contact_finance_records', { p_page_id: contact.data.page_id, p_contact_id: contactId }),
                db.from('veo_closed_deals').select('id,order_id,amount_minor,currency,occurred_at,verified_payment_id,seller_id').eq('contact_id', contactId).is('voided_at', null).in('seller_id', workers)
            ]);
            if (details.error || orders.error || legacy.error || closedDeals.error) throw new Error('Contact financial history unavailable');
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
            return NextResponse.json({ contact: contact.data, details: details.data, orders: (orders.data || []).map(o => ({ ...o, seller_name: names.get(o.seller_id) || null })), payments: payments.data, closed_deals: closedDeals.data || [], lifetime_value: ltv,
                coverage: (retainedPayments.length ? 'Verified retained payments plus payments recorded since launch' : `Recorded since launch (${scope.launch_at}); earlier financial history is unavailable`) + (scope.role === 'owner' ? '' : '. Financial history is limited to your seller branch; other branches are excluded.') }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const params = request.nextUrl.searchParams, page = params.get('page_id');
        const offset = Number(params.get('offset') || 0), view = params.get('view') || 'dashboard', search = params.get('search') || '';
        if ((page && !uuid(page)) || !Number.isSafeInteger(offset) || offset < 0 || offset > 10000000 || search.length > 200 ||
            !['dashboard', 'clients', 'closed', 'done', 'salary', 'accounts', 'sync'].includes(view)) throw new Error('Invalid order filters');
        const includeOrders = ['closed', 'done'].includes(view);
        if (view === 'accounts') return NextResponse.json({ scope, accounts: await loadVeoAccountDirectory(db, scope), tomorrow: [], orders: [], salary: [], submissions: [], sync: [], teams: [], capacity: null }, { headers: { 'Cache-Control': 'no-store' } });
        const includeCapacity = view === 'capacity' || view === 'dashboard';
        const [dashboard, orders, capacity] = await Promise.all([
            readVeoRpc(db, 'veo_dashboard', { p_actor: scope.user_id, p_day: day }),
            includeOrders ? readVeoRpc(db, 'veo_orders_page', { p_actor: scope.user_id, p_day: day, p_view: view, p_page: page, p_search: search, p_offset: offset, p_limit: 50 }) : Promise.resolve({ data: null, error: null }),
            includeCapacity ? readVeoRpc(db, 'veo_team_capacity', { p_actor: scope.user_id, p_day: day }) : Promise.resolve({ data: null, error: null })
        ]);
        if (dashboard.error || orders.error || capacity.error) throw new Error(dashboard.error?.message || orders.error?.message || capacity.error?.message);
        return NextResponse.json({ ...dashboard.data, orders: orders.data?.orders || [], ...(orders.data ? { order_page: orders.data } : {}), capacity: capacity.data }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return errorResponse(error); }
}
export async function POST(request: NextRequest) {
    try {
        if (request.headers.get('origin') !== request.nextUrl.origin) throw Object.assign(new Error('Same-origin request required'), { status: 403 });
        const scope = await actor(request), db = getSupabaseAdmin();
        if (request.headers.get('content-type')?.includes('multipart/form-data')) throw new Error('Submit through Receipts after checking the Facebook requirements');
        const body = await request.json(), action = body.action;
        if (action === 'recover_account_login') {
            if (scope.role !== 'owner') return NextResponse.json({ error: 'Owner access required' }, { status: 403 });
            if (!uuid(body.user_id) || typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim()) || typeof body.password !== 'string' || !body.password) throw new Error('Account, email and new password are required');
            const result = await db.rpc('veo_recover_account_login', { p_actor: scope.user_id, p_user: body.user_id, p_email: body.email.trim().toLowerCase(), p_password_hash: await passwordHash(body.password) });
            if (result.error) throw Object.assign(new Error(result.error.code === '23505' ? 'This email belongs to another account' : 'Could not configure account sign-in'), { status: result.error.code === '42501' ? 403 : 400 });
            return NextResponse.json({ saved: result.data });
        }
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
        if (action === 'order') throw new Error('Create the order in Facebook Business Suite, then use Fetch Facebook orders in Receipts.');
        if (action === 'import_business_order' && (!uuid(body.business_order_id) || !uuid(body.seller_id) || !['new', 'existing'].includes(body.deal_mode) || body.deal_mode === 'existing' && !uuid(body.closed_deal_id) || body.deal_mode === 'new' && body.closed_deal_id)) throw new Error('Choose a Facebook order, seller and New deal or existing Closed Deal');
        if (action === 'payment') body.amount_minor = body.settle_done === true && /^0(?:\.0{1,2})?$/.test(String(body.amount).trim()) ? 0 : parseMoneyMinor(body.amount);
        if (!['assign_pages', 'import_business_order', 'payment', 'attribution', 'attendance', 'contact', 'mapping', 'staff_delete', 'claim_client', 'fulfillment', 'client_assignment', 'attendance_today'].includes(action)) throw new Error('Unknown action');
        const saved = await workspaceAction(scope.user_id, action, body);
        return NextResponse.json({ saved });
    } catch (error) {
        return errorResponse(error);
    }
}
