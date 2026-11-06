import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';

// Service-role-backed legacy endpoints pass this boundary as well as their own checks.
export async function middleware(request: NextRequest) {
    const path = request.nextUrl.pathname;
    if (['/api/facebook/connect', '/api/facebook/pages'].includes(path)) return NextResponse.json({ error: 'Facebook connection setup has been removed. Sign in with email and password.' }, { status: 410 });
    if (process.env.VEO_WORKSPACE_ENABLED !== 'true') return NextResponse.next();
    if (path === '/api/sales-form') return NextResponse.next(); // The route requires an expiring, contact-scoped capability.
    if (/^\/api\/chatbot-media\/[a-f0-9-]{36}$/i.test(path) && request.nextUrl.searchParams.has('token')) return NextResponse.next(); // Route verifies a short-lived, asset-bound signature.
    if (path.startsWith('/api/auth/') || ['/api/facebook/webhook', '/api/facebook/partner-webhook', '/api/telegram/webhook', '/api/workspace/handoff'].includes(path)) return NextResponse.next();
    if (path.startsWith('/api/cron/')) {
        if (!process.env.CRON_SECRET || request.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        return NextResponse.next();
    }
    if (/^\/api\/(test-|check-oauth)/.test(path)) return NextResponse.json({ error: 'Unavailable' }, { status: 404 });
    if (/\/sync$|\/refresh-evidence$|\/profile\/finance$/.test(path)) return NextResponse.json({ error: 'Historical imports are disabled. Record verified sales in the VEO workspace.' }, { status: 410 });
    const token = await getToken({ req: request });
    if (!token?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (token.facebookId || token.accessToken) return NextResponse.json({ error: 'Facebook sign-in has been removed. Sign in with email and password.' }, { status: 401 });
    try {
        const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
        const headers = { apikey: key!, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
        const read = async (fn: string, args: any) => {
            const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store' });
            if (!r.ok) throw new Error('Authorization unavailable');
            return r.json();
        };
        const scope = await read('veo_scope', { p_actor: token.id });
        if (!scope?.launch_at) return NextResponse.json({ error: 'Workspace access is inactive' }, { status: 403 });
        const forbidden = () => NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        if (path.startsWith('/api/workspace')) return NextResponse.next();
        if (scope.role !== 'owner' && !(/^\/api\/(pages(?:\/[^/]+(?:\/(?:contacts|team|pipeline|history|exports|human-agent-send|human-agent-media)(?:\/.*)?)?)?|campaigns(?:\/.*)?|exports(?:\/.*)?|tags(?:\/.*)?|facebook\/messages\/send|facebook\/templates(?:\/.*)?|media\/photo-header|chatbot-media\/[^/]+)$/.test(path))) return forbidden();
        if (scope.role !== 'owner' && path === '/api/pages' && request.method !== 'GET') return forbidden();
        if (scope.role !== 'owner' && /\/team$/.test(path) && request.method !== 'GET') return forbidden();
        if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.get('origin') !== request.nextUrl.origin) return forbidden();
        let body: any = {};
        if (request.headers.get('content-type')?.includes('application/json')) {
            try { body = await request.clone().json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
        }
        const refs: Array<{ kind: string; id: string }> = [];
        const add = (kind: string, v: any) => { for (const id of Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [v]) if (typeof id === 'string' && id) refs.push({ kind, id }); };
        const segments = path.split('/').filter(Boolean);
        const kinds: Record<string, string> = { pages: 'page', contacts: 'contact', campaigns: 'campaign', exports: 'export', 'chatbot-media': 'asset', automations: 'automation' };
        for (let i = 1; i < segments.length - 1; i++) if (kinds[segments[i]] && /^[a-f0-9-]{36}$/i.test(segments[i + 1])) add(kinds[segments[i]], segments[i + 1]);
        const walk = (value: any) => {
            if (!value || typeof value !== 'object') return;
            for (const [k, v] of Object.entries(value)) {
                const kind = /^(page_?ids?|pageIds?)$/i.test(k) ? 'page' : /^(contact_?ids?|contactIds?)$/i.test(k) ? 'contact' : /^(tag_?ids?|tagIds?|include_tag_ids|exclude_tag_ids|audience_include_tag_ids|audience_exclude_tag_ids)$/i.test(k) ? 'tag' : /^(campaign_?id|campaignId)$/i.test(k) ? 'campaign' : /^(export_?id|exportId)$/i.test(k) ? 'export' : null;
                if (kind) add(kind, v); else if (typeof v === 'object') walk(v);
            }
        };
        walk(body); walk(Object.fromEntries(request.nextUrl.searchParams));
        if (refs.length && !await read('veo_authorize_resources', { p_actor: token.id, p_refs: refs })) return forbidden();
        return NextResponse.next();
    } catch { return NextResponse.json({ error: 'Workspace authorization is unavailable' }, { status: 503 }); }
}
export const config = { matcher: ['/api/:path*'] };
