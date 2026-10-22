import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { userHasPageAccess } from '@/lib/page-access';
import { getSupabaseAdmin } from '@/lib/supabase';
import { validatePricingExperiment } from '@/lib/chatbot-pricing';
import { currentPricingCatalog, OWNER_PRICING_CATALOGS } from '@/lib/chatbot-pricing-catalogs';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ pageId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function access(request: NextRequest, context: Context) {
    const { pageId } = await context.params;
    const session = await getSessionFromRequest(request);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (!await userHasPageAccess(session.user.id, pageId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    return pageId;
}

function failure(error: unknown) {
    console.error('[CHATBOT_PRICING]', error);
    const code = (error as { code?: string }).code;
    if (['42P01', 'PGRST202', 'PGRST205', '42883'].includes(code || '')) {
        return NextResponse.json({ error: 'Pricing setup is required. Apply migration 202610220002_chatbot_pricing_experiments.sql.' }, { status: 503 });
    }
    return NextResponse.json({ error: 'Could not load or save pricing experiments' }, { status: 500 });
}

export async function GET(request: NextRequest, context: Context) {
    try {
        const pageId = await access(request, context);
        if (typeof pageId !== 'string') return pageId;
        const db = getSupabaseAdmin();
        const query = new URL(request.url).searchParams;
        if (query.get('presets') === 'owner') {
            const configuration = await db.from('chatbot_configs').select('knowledge_source_page_id').eq('page_id', pageId).maybeSingle();
            if (configuration.error) throw configuration.error;
            const sourcePageId = configuration.data?.knowledge_source_page_id || pageId;
            const documents = await db.from('chatbot_knowledge_documents').select('id,title,content')
                .eq('page_id', sourcePageId).eq('status', 'ready')
                .or('content.ilike.%current owner-approved promo catalog%,content.ilike.%owner-approved promo price list%')
                .order('updated_at', { ascending: false }).limit(50);
            if (documents.error) throw documents.error;
            try {
                const control = currentPricingCatalog((documents.data || []).map(document => ({ ...document,
                    chunk_id: document.id, document_id: document.id, similarity: 1 })));
                return NextResponse.json({ packages: [control, ...OWNER_PRICING_CATALOGS], source_page_id: sourcePageId });
            } catch (error) {
                return NextResponse.json({ error: (error as Error).message }, { status: 409 });
            }
        }
        const requestedId = query.get('experiment');
        const duration = query.has('duration') ? Number(query.get('duration')) : null;
        if (duration !== null && (!Number.isInteger(duration) || duration < 1 || duration > 3600)) return NextResponse.json({ error: 'Invalid starting duration' }, { status: 400 });
        if (requestedId && !UUID.test(requestedId)) return NextResponse.json({ error: 'Invalid experiment ID' }, { status: 400 });
        const runs = await db.from('chatbot_pricing_experiments').select('*').eq('page_id', pageId)
            .order('created_at', { ascending: false }).limit(100);
        if (runs.error) throw runs.error;
        // Load a specifically requested archived run even when it is older than the picker limit.
        let experiment = (runs.data || []).find(run => requestedId ? run.id === requestedId : run.status !== 'archived') || (!requestedId ? runs.data?.[0] : null);
        if (requestedId && !experiment) {
            const older = await db.from('chatbot_pricing_experiments').select('*').eq('page_id', pageId).eq('id', requestedId).maybeSingle();
            if (older.error) throw older.error;
            experiment = older.data;
        }
        if (requestedId && !experiment) return NextResponse.json({ error: 'Experiment not found' }, { status: 404 });
        const config = await db.from('chatbot_configs').select('enabled,follow_up_enabled,trial_mode_enabled').eq('page_id', pageId).maybeSingle();
        if (config.error) throw config.error;
        if (!experiment) return NextResponse.json({ experiments: runs.data || [], experiment: null, packages: [], metrics: [], bot: config.data });
        const [packages, analytics, reviews] = await Promise.all([
            db.from('chatbot_pricing_packages').select('*').eq('experiment_id', experiment.id).order('position', { ascending: true }),
            db.rpc('get_chatbot_pricing_analytics', { p_page_id: pageId, p_experiment_id: experiment.id, p_duration_seconds: duration }),
            db.from('chatbot_pricing_deliveries').select('id', { count: 'exact', head: true })
                .eq('experiment_id', experiment.id).eq('status', 'sending')
        ]);
        if (packages.error) throw packages.error;
        if (analytics.error) throw analytics.error;
        if (reviews.error) throw reviews.error;
        return NextResponse.json({ experiments: runs.data || [], experiment, packages: packages.data || [], metrics: analytics.data || [], duration_seconds: duration, delivery_reviews: reviews.count || 0, bot: config.data });
    } catch (error) { return failure(error); }
}

export async function POST(request: NextRequest, context: Context) {
    try {
        const pageId = await access(request, context);
        if (typeof pageId !== 'string') return pageId;
        let config;
        try { config = validatePricingExperiment(await request.json()); }
        catch (error) { return NextResponse.json({ error: (error as Error).message }, { status: 400 }); }
        const result = await getSupabaseAdmin().rpc('create_chatbot_pricing_experiment', { p_page_id: pageId, p_config: config });
        if (result.error) throw result.error;
        return NextResponse.json({ experiment_id: result.data }, { status: 201 });
    } catch (error) { return failure(error); }
}

export async function PATCH(request: NextRequest, context: Context) {
    try {
        const pageId = await access(request, context);
        if (typeof pageId !== 'string') return pageId;
        let input;
        try { input = await request.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
        if (!input || !UUID.test(input.experiment_id || '') || !['active', 'paused'].includes(input.status)) {
            return NextResponse.json({ error: 'Provide an experiment ID and active or paused status' }, { status: 400 });
        }
        const result = await getSupabaseAdmin().from('chatbot_pricing_experiments').update({ status: input.status })
            .eq('page_id', pageId).eq('id', input.experiment_id).neq('status', 'archived').select('id,status').maybeSingle();
        if (result.error) throw result.error;
        if (!result.data) return NextResponse.json({ error: 'Current experiment not found' }, { status: 404 });
        return NextResponse.json({ experiment: result.data });
    } catch (error) { return failure(error); }
}
