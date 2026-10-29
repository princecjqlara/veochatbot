import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { userHasPageAccess } from '@/lib/page-access';
import {
    DEFAULT_CHATBOT_FALLBACK,
    DEFAULT_CHATBOT_INSTRUCTIONS,
    DEFAULT_CHATBOT_MODEL,
    generateChatbotFollowUp,
    generateChatbotResponse,
    extractChatbotContactDetails,
    analyzeChatbotContinuation,
    getChatbotKnowledgePageId,
    getOpenRouterModelContextLength,
    type ChatbotTokenUsage,
    type ChatbotConfig
} from '@/lib/chatbot';
import { createChatbotMediaPublicViewUrl, createChatbotMediaSignedUrl, getReadyChatbotMediaForDocuments } from '@/lib/chatbot-media';
import { getReadyChatbotDriveFilesForDocuments, getReadyChatbotDriveFolderForDocument } from '@/lib/chatbot-drive-folders';
import { getMissingChatbotDetails } from '@/lib/chatbot-control';
import { normalizeCommercialVideoDetails, normalizeCommercialVideoIntakeConfig } from '@/lib/chatbot-intake';
import { evaluateCommercialVideoIntake, extractClearVideoRequest, isCommercialVideoIntake } from '@/lib/chatbot-policy';
import { getCommercialVideoMessageControls, resolveChatbotAction } from '@/lib/chatbot-interactions';
import { salesSettings, validateSalesSettings } from '@/lib/chatbot-sales-assistant';
import { DEFAULT_SALES_FORM_FIELDS, normalizeSalesFormFields } from '@/lib/chatbot-guided-sales';
const CHATBOT_CONFIG_SELECT = 'page_id, knowledge_source_page_id, enabled, trial_mode_enabled, trial_contact_id, instructions, fallback_reply, model, rag_enabled, follow_up_prompt, details_to_collect, details_completion_percent, commercial_video_intake_enabled, guided_sales_enabled, sales_form_fields, sales_assistant_settings, policy_revision, continuation_review_enabled, continuation_review_hour, continuation_review_minute, continuation_enabled_at, bot_dos, bot_donts, follow_up_enabled, follow_up_first_day_mode, follow_up_quick_delays_minutes, follow_up_best_time_days, follow_up_messages, follow_up_ai_instructions, follow_up_utility_template_name, follow_up_utility_template_language, follow_up_utility_text, follow_up_media_asset_id, split_messages, max_message_parts, stop_when_details_collected, stop_on_opt_out, stop_on_refusal, stop_on_qualified, stop_on_not_qualified, stop_on_converted, stop_on_order_created';

function defaultConfig(pageId: string): ChatbotConfig {
    return {
        page_id: pageId,
        knowledge_source_page_id: pageId,
        enabled: false,
        trial_mode_enabled: false,
        trial_contact_id: null,
        instructions: DEFAULT_CHATBOT_INSTRUCTIONS,
        fallback_reply: DEFAULT_CHATBOT_FALLBACK,
        model: process.env.OPENROUTER_MODEL || DEFAULT_CHATBOT_MODEL,
        rag_enabled: true,
        follow_up_prompt: 'Ask one helpful question at a time. Once the required details are complete, thank the customer and explain that a team member will take over.',
        details_to_collect: [],
        details_completion_percent: 100,
        commercial_video_intake_enabled: false,
        sales_assistant_settings: salesSettings({}),
        guided_sales_enabled: false,
        sales_form_fields: [...DEFAULT_SALES_FORM_FIELDS],
        continuation_review_enabled: false,
        continuation_review_hour: 20,
        continuation_review_minute: 0,
        bot_dos: '',
        bot_donts: '',
        follow_up_enabled: false,
        follow_up_first_day_mode: 'fixed',
        follow_up_quick_delays_minutes: [60, 240, 720, 1380],
        follow_up_best_time_days: [2, 3, 5, 7],
        follow_up_messages: [],
        follow_up_ai_instructions: 'Read the full conversation first. Continue from the customer\'s latest request, interest, objection, or promised next step, and naturally mention one verified detail from the conversation. Never send a generic check-in, repeat an earlier Page message, restart the sales flow, or ask for information already collected. Mirror the customer\'s English, Filipino, or Taglish. When relevant, offer helpful proof such as previous work, product photos, or a promotional video from the Page knowledge base.',
        follow_up_utility_template_name: 'acct_followup_v1',
        follow_up_utility_template_language: 'en_US',
        follow_up_utility_text: 'AI-generated from conversation at send time',
        follow_up_media_asset_id: null,
        split_messages: true,
        max_message_parts: 0,
        stop_when_details_collected: true,
        stop_on_opt_out: true,
        stop_on_refusal: true,
        stop_on_qualified: true,
        stop_on_not_qualified: true,
        stop_on_converted: true,
        stop_on_order_created: true
    };
}

function mergeDraftConfigForPreview(stored: ChatbotConfig, value: unknown): ChatbotConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return normalizeCommercialVideoIntakeConfig(stored);
    const draft = value as Record<string, unknown>;
    const optionalText = (key: string, maxLength: number, fallback: string) =>
        typeof draft[key] === 'string' ? draft[key].trim().slice(0, maxLength) : fallback;
    const requiredText = (key: string, maxLength: number, fallback: string) => {
        const candidate = optionalText(key, maxLength, fallback);
        return candidate || fallback;
    };
    const booleanValue = (key: string, fallback: boolean) =>
        typeof draft[key] === 'boolean' ? draft[key] as boolean : fallback;
    const stringList = (key: string, maxItems: number, maxLength: number, fallback: string[]) =>
        Array.isArray(draft[key])
            ? (draft[key] as unknown[])
                .filter((item): item is string => typeof item === 'string')
                .map((item) => item.trim().replace(/\s+/g, ' ').slice(0, maxLength))
                .filter(Boolean)
                .slice(0, maxItems)
            : fallback;
    const integerList = (key: string, min: number, max: number, maxItems: number, fallback: number[]) =>
        Array.isArray(draft[key])
            ? Array.from(new Set((draft[key] as unknown[])
                .map((item) => Math.round(Number(item)))
                .filter((item) => Number.isFinite(item) && item >= min && item <= max)))
                .sort((a, b) => a - b)
                .slice(0, maxItems)
            : fallback;
    const completionPercent = Number(draft.details_completion_percent);

    return normalizeCommercialVideoIntakeConfig({
        ...stored,
        ...(draft.sales_assistant_settings !== undefined ? { sales_assistant_settings: validateSalesSettings(draft.sales_assistant_settings) } : {}),
        page_id: stored.page_id,
        enabled: booleanValue('enabled', stored.enabled),
        trial_mode_enabled: booleanValue('trial_mode_enabled', stored.trial_mode_enabled === true),
        trial_contact_id: draft.trial_contact_id === null
            ? null
            : typeof draft.trial_contact_id === 'string'
                ? draft.trial_contact_id.trim() || null
                : stored.trial_contact_id || null,
        instructions: requiredText('instructions', 5000, stored.instructions),
        fallback_reply: requiredText('fallback_reply', 1000, stored.fallback_reply),
        model: requiredText('model', 200, stored.model),
        rag_enabled: booleanValue('rag_enabled', stored.rag_enabled),
        commercial_video_intake_enabled: booleanValue('commercial_video_intake_enabled', stored.commercial_video_intake_enabled === true),
        guided_sales_enabled: booleanValue('guided_sales_enabled', stored.guided_sales_enabled === true),
        sales_form_fields: Array.isArray(draft.sales_form_fields) ? normalizeSalesFormFields(draft.sales_form_fields) : normalizeSalesFormFields(stored.sales_form_fields),
        continuation_review_enabled: booleanValue('continuation_review_enabled',
            draft.commercial_video_intake_enabled === true && stored.commercial_video_intake_enabled !== true
                ? true : stored.continuation_review_enabled === true),
        continuation_review_hour: Number.isInteger(draft.continuation_review_hour)
            ? Math.min(23, Math.max(0, Number(draft.continuation_review_hour))) : stored.continuation_review_hour ?? 20,
        continuation_review_minute: Number.isInteger(draft.continuation_review_minute)
            ? Math.min(59, Math.max(0, Number(draft.continuation_review_minute))) : stored.continuation_review_minute ?? 0,
        follow_up_prompt: optionalText('follow_up_prompt', 3000, stored.follow_up_prompt),
        details_to_collect: stringList('details_to_collect', 20, 80, stored.details_to_collect),
        details_completion_percent: Number.isFinite(completionPercent)
            ? Math.min(100, Math.max(1, Math.round(completionPercent)))
            : stored.details_completion_percent,
        bot_dos: optionalText('bot_dos', 3000, stored.bot_dos),
        bot_donts: optionalText('bot_donts', 3000, stored.bot_donts),
        follow_up_enabled: booleanValue('follow_up_enabled', stored.follow_up_enabled),
        follow_up_first_day_mode: draft.follow_up_first_day_mode === 'adaptive' || draft.follow_up_first_day_mode === 'fixed'
            ? draft.follow_up_first_day_mode : stored.follow_up_first_day_mode || 'fixed',
        follow_up_quick_delays_minutes: integerList(
            'follow_up_quick_delays_minutes', 1, 1439, 10, stored.follow_up_quick_delays_minutes
        ),
        follow_up_best_time_days: integerList(
            'follow_up_best_time_days', 2, 7, 6, stored.follow_up_best_time_days
        ),
        follow_up_messages: stringList('follow_up_messages', 10, 500, stored.follow_up_messages),
        follow_up_ai_instructions: requiredText(
            'follow_up_ai_instructions', 3000, stored.follow_up_ai_instructions
        ),
        follow_up_utility_template_name: requiredText(
            'follow_up_utility_template_name', 200, stored.follow_up_utility_template_name
        ),
        follow_up_utility_template_language: requiredText(
            'follow_up_utility_template_language', 20, stored.follow_up_utility_template_language
        ),
        follow_up_utility_text: requiredText(
            'follow_up_utility_text', 500, stored.follow_up_utility_text
        ),
        follow_up_media_asset_id: draft.follow_up_media_asset_id === null
            ? null
            : typeof draft.follow_up_media_asset_id === 'string'
                ? draft.follow_up_media_asset_id.trim() || null
                : stored.follow_up_media_asset_id,
        split_messages: booleanValue('split_messages', stored.split_messages),
        max_message_parts: Math.min(2, Math.max(0, Math.round(Number(draft.max_message_parts ?? stored.max_message_parts)) || 0)),
        stop_when_details_collected: booleanValue(
            'stop_when_details_collected', stored.stop_when_details_collected
        ),
        stop_on_opt_out: booleanValue('stop_on_opt_out', stored.stop_on_opt_out),
        stop_on_refusal: booleanValue('stop_on_refusal', stored.stop_on_refusal),
        stop_on_qualified: booleanValue('stop_on_qualified', stored.stop_on_qualified),
        stop_on_not_qualified: booleanValue('stop_on_not_qualified', stored.stop_on_not_qualified),
        stop_on_converted: booleanValue('stop_on_converted', stored.stop_on_converted),
        stop_on_order_created: booleanValue('stop_on_order_created', stored.stop_on_order_created)
    });
}

async function getAuthorizedPage(request: NextRequest, pageId: string) {
    const session = await getSessionFromRequest(request);
    const userId = session?.user?.id;
    if (!userId) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    if (!await userHasPageAccess(userId, pageId)) {
        return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
    }
    return { userId };
}

async function tokenUsageWithContext(usage: ChatbotTokenUsage | undefined, configuredModel: string) {
    if (!usage) return null;
    const contextLength = await getOpenRouterModelContextLength(usage.model || configuredModel).catch(() => null);
    return {
        ...usage,
        context_length: contextLength,
        remaining_tokens: contextLength === null ? null : Math.max(0, contextLength - usage.total_tokens)
    };
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await getAuthorizedPage(request, pageId);
        if (authorization.error) return authorization.error;

        const { data, error } = await getSupabaseAdmin()
            .from('chatbot_configs')
            .select(CHATBOT_CONFIG_SELECT)
            .eq('page_id', pageId)
            .maybeSingle();

        if (error) throw error;

        return NextResponse.json({
            config: normalizeCommercialVideoIntakeConfig((data || defaultConfig(pageId)) as ChatbotConfig),
            provider: {
                configured: Boolean(process.env.OPENROUTER_API_KEY),
                default_model: process.env.OPENROUTER_MODEL || DEFAULT_CHATBOT_MODEL
            }
        });
    } catch (error) {
        console.error('[CHATBOT_CONFIG_GET]', error);
        return NextResponse.json(
            { error: 'Failed to load chatbot settings', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await getAuthorizedPage(request, pageId);
        if (authorization.error) return authorization.error;

        const body = await request.json();
        if (body.guided_sales_enabled !== undefined && typeof body.guided_sales_enabled !== 'boolean') {
            return NextResponse.json({ error: 'Guided sales must be true or false' }, { status: 400 });
        }
        if (body.sales_form_fields !== undefined && (!Array.isArray(body.sales_form_fields) || body.sales_form_fields.length > 20 ||
            body.sales_form_fields.some((field: unknown) => typeof field !== 'string' || !field.trim() || field.length > 80) || !normalizeSalesFormFields(body.sales_form_fields).length)) {
            return NextResponse.json({ error: 'Add 1 to 20 form field labels, each at most 80 characters' }, { status: 400 });
        }
        if (body.commercial_video_intake_enabled !== undefined && typeof body.commercial_video_intake_enabled !== 'boolean') {
            return NextResponse.json({ error: 'Commercial video intake must be true or false' }, { status: 400 });
        }
        if (body.continuation_review_minute !== undefined && (!Number.isInteger(body.continuation_review_minute) || body.continuation_review_minute < 0 || body.continuation_review_minute > 59)) {
            return NextResponse.json({ error: 'Review minute must be an integer between 0 and 59' }, { status: 400 });
        }
        const instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
        const fallbackReply = typeof body.fallback_reply === 'string' ? body.fallback_reply.trim() : '';
        const model = typeof body.model === 'string' ? body.model.trim() : '';
        const followUpPrompt = typeof body.follow_up_prompt === 'string' ? body.follow_up_prompt.trim() : '';
        const botDos = typeof body.bot_dos === 'string' ? body.bot_dos.trim() : '';
        const botDonts = typeof body.bot_donts === 'string' ? body.bot_donts.trim() : '';
        const detailsCompletionPercent = Math.min(100, Math.max(
            1,
            Math.round(Number(body.details_completion_percent) || 100)
        ));
        const detailsToCollect = Array.isArray(body.details_to_collect)
            ? body.details_to_collect
                .filter((detail: unknown): detail is string => typeof detail === 'string')
                .map((detail: string) => detail.trim().replace(/\s+/g, ' ').slice(0, 80))
                .filter(Boolean)
                .slice(0, 20)
            : [];
        const normalizeIntegerList = (value: unknown, min: number, max: number, limit: number) => Array.from(new Set(
            (Array.isArray(value) ? value : [])
                .map((item) => Math.round(Number(item)))
                .filter((item) => Number.isFinite(item) && item >= min && item <= max)
        )).sort((a, b) => a - b).slice(0, limit);
        const quickDelays = normalizeIntegerList(body.follow_up_quick_delays_minutes, 1, 1439, 10);
        if (body.follow_up_first_day_mode !== undefined &&
            body.follow_up_first_day_mode !== 'fixed' && body.follow_up_first_day_mode !== 'adaptive') {
            return NextResponse.json({ error: 'First-day timing must be fixed or adaptive' }, { status: 400 });
        }
        const bestTimeDays = normalizeIntegerList(body.follow_up_best_time_days, 2, 7, 6);
        const followUpAiInstructions = typeof body.follow_up_ai_instructions === 'string'
            ? body.follow_up_ai_instructions.trim().slice(0, 3000)
            : '';
        const utilityTemplateName = typeof body.follow_up_utility_template_name === 'string'
            ? body.follow_up_utility_template_name.trim().slice(0, 200)
            : '';
        const utilityTemplateLanguage = typeof body.follow_up_utility_template_language === 'string'
            ? body.follow_up_utility_template_language.trim().slice(0, 20)
            : '';
        const trialContactId = typeof body.trial_contact_id === 'string' && body.trial_contact_id.trim()
            ? body.trial_contact_id.trim()
            : null;

        if (!instructions || instructions.length > 5000) {
            return NextResponse.json({ error: 'Instructions must be between 1 and 5000 characters' }, { status: 400 });
        }
        if (!fallbackReply || fallbackReply.length > 1000) {
            return NextResponse.json({ error: 'Fallback reply must be between 1 and 1000 characters' }, { status: 400 });
        }
        if (!model || model.length > 200) {
            return NextResponse.json({ error: 'Model must be between 1 and 200 characters' }, { status: 400 });
        }
        if (followUpPrompt.length > 3000) {
            return NextResponse.json({ error: 'Follow-up prompt cannot exceed 3000 characters' }, { status: 400 });
        }
        if (botDos.length > 3000 || botDonts.length > 3000) {
            return NextResponse.json({ error: 'Bot should and should not rules cannot exceed 3000 characters each' }, { status: 400 });
        }
        if (body.follow_up_enabled === true && !followUpAiInstructions) {
            return NextResponse.json({ error: 'Add AI follow-up instructions before enabling follow-ups' }, { status: 400 });
        }
        if (body.enabled === true && !process.env.OPENROUTER_API_KEY) {
            return NextResponse.json({ error: 'OPENROUTER_API_KEY is not configured on the server' }, { status: 400 });
        }

        const supabase = getSupabaseAdmin();

        const requestedPageIds = Array.isArray(body.apply_to_page_ids)
            ? body.apply_to_page_ids
                .filter((value: unknown): value is string => typeof value === 'string')
                .map((value: string) => value.trim())
                .filter(Boolean)
            : [];
        const targetPageIds = Array.from(new Set([pageId, ...requestedPageIds]));
        const inaccessiblePageId = (await Promise.all(
            targetPageIds.map(async (targetPageId) => ({
                targetPageId,
                accessible: await userHasPageAccess(authorization.userId, targetPageId)
            }))
        )).find((result) => !result.accessible)?.targetPageId;
        if (inaccessiblePageId) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to every selected Page' },
                { status: 403 }
            );
        }

        // Older clients may omit the policy switch. Preserve each target Page's
        // current policy so they cannot silently overwrite its required form.
        const existingPolicyByPage = new Map<string, boolean>();
        const existingFirstDayModeByPage = new Map<string, 'fixed' | 'adaptive'>();
        if (body.follow_up_first_day_mode === undefined) {
            const existingModes = await supabase.from('chatbot_configs')
                .select('page_id,follow_up_first_day_mode').in('page_id', targetPageIds);
            if (existingModes.error) throw existingModes.error;
            for (const row of existingModes.data || []) {
                existingFirstDayModeByPage.set(row.page_id, row.follow_up_first_day_mode === 'adaptive' ? 'adaptive' : 'fixed');
            }
        }
        if (typeof body.commercial_video_intake_enabled !== 'boolean') {
            const { data: existingPolicies, error: existingPolicyError } = await supabase
                .from('chatbot_configs')
                .select('page_id, commercial_video_intake_enabled')
                .in('page_id', targetPageIds);
            if (existingPolicyError) throw existingPolicyError;
            for (const row of existingPolicies || []) existingPolicyByPage.set(row.page_id, row.commercial_video_intake_enabled === true);
        }

        const requestedKnowledgePageId = typeof body.knowledge_source_page_id === 'string' && body.knowledge_source_page_id.trim()
            ? body.knowledge_source_page_id.trim()
            : pageId;
        if (!await userHasPageAccess(authorization.userId, requestedKnowledgePageId)) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to the selected knowledge library Page' },
                { status: 403 }
            );
        }
        const shouldShareKnowledge = body.share_knowledge_and_media === true && targetPageIds.length > 1;
        const sharedKnowledgePageId = requestedKnowledgePageId;

        if (body.trial_mode_enabled === true) {
            if (!trialContactId) {
                return NextResponse.json({ error: 'Choose one Messenger contact before enabling live trial mode' }, { status: 400 });
            }
            const { data: trialContact, error: trialContactError } = await supabase
                .from('contacts')
                .select('id, psid')
                .eq('id', trialContactId)
                .eq('page_id', pageId)
                .maybeSingle();
            if (trialContactError) throw trialContactError;
            if (!trialContact?.id || !trialContact?.psid) {
                return NextResponse.json({ error: 'The selected trial contact is unavailable or cannot receive Messenger messages' }, { status: 400 });
            }
        }

        let salesAssistantSettings;
        if (body.sales_assistant_settings !== undefined) {
            try { salesAssistantSettings = validateSalesSettings(body.sales_assistant_settings); }
            catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid sales settings' }, { status: 400 }); }
        }
        const sharedSettings = {
                ...(salesAssistantSettings ? { sales_assistant_settings: salesAssistantSettings } : {}),
                ...(typeof body.guided_sales_enabled === 'boolean' ? { guided_sales_enabled: body.guided_sales_enabled } : {}),
                ...(Array.isArray(body.sales_form_fields) ? { sales_form_fields: normalizeSalesFormFields(body.sales_form_fields) } : {}),
                enabled: body.enabled === true,
                instructions,
                fallback_reply: fallbackReply,
                model,
                rag_enabled: body.rag_enabled !== false,
                follow_up_prompt: followUpPrompt,
                details_to_collect: detailsToCollect,
                details_completion_percent: detailsCompletionPercent,
                ...(typeof body.continuation_review_enabled === 'boolean' ? {
                    continuation_review_enabled: body.continuation_review_enabled,
                    continuation_review_hour: Number.isInteger(body.continuation_review_hour)
                        ? Math.min(23, Math.max(0, body.continuation_review_hour)) : 20,
                    continuation_review_minute: Number.isInteger(body.continuation_review_minute)
                        ? body.continuation_review_minute : 0
                } : {}),
                bot_dos: botDos,
                bot_donts: botDonts,
                follow_up_enabled: body.follow_up_enabled === true,
                follow_up_quick_delays_minutes: quickDelays,
                follow_up_best_time_days: bestTimeDays,
                follow_up_messages: [],
                follow_up_ai_instructions: followUpAiInstructions || defaultConfig(pageId).follow_up_ai_instructions,
                follow_up_utility_template_name: utilityTemplateName || 'acct_followup_v1',
                follow_up_utility_template_language: utilityTemplateLanguage || 'en_US',
                follow_up_utility_text: 'AI-generated from conversation at send time',
                follow_up_media_asset_id: null,
                split_messages: body.split_messages !== false,
                max_message_parts: 0,
                stop_when_details_collected: body.stop_when_details_collected !== false,
                stop_on_opt_out: body.stop_on_opt_out !== false,
                stop_on_refusal: body.stop_on_refusal !== false,
                // Terminal Meta outcomes always stop the bot. Keep accepting
                // the legacy fields in the request, but never persist false.
                stop_on_qualified: true,
                stop_on_not_qualified: true,
                stop_on_converted: true,
                stop_on_order_created: true,
                updated_at: new Date().toISOString()
        };
        const payloads = targetPageIds.map((targetPageId) => normalizeCommercialVideoIntakeConfig({
            ...sharedSettings,
            follow_up_first_day_mode: body.follow_up_first_day_mode ?? existingFirstDayModeByPage.get(targetPageId) ?? 'fixed',
            ...(typeof body.commercial_video_intake_enabled === 'boolean'
                ? { commercial_video_intake_enabled: body.commercial_video_intake_enabled }
                : {}),
            ...((body.commercial_video_intake_enabled ?? existingPolicyByPage.get(targetPageId)) === true ? {
                commercial_video_intake_enabled: true,
                // Preserve an explicit review disable, but enable the nightly
                // rule when the policy is first selected without that setting.
                ...(typeof body.continuation_review_enabled !== 'boolean' && body.commercial_video_intake_enabled === true
                    ? { continuation_review_enabled: true } : {})
            } : {}),
            page_id: targetPageId,
            knowledge_source_page_id: shouldShareKnowledge
                ? sharedKnowledgePageId
                : targetPageId === pageId ? requestedKnowledgePageId : targetPageId,
            // Trial contacts are Page-specific and must never be copied to a
            // different Page. The regular bot settings are shared.
            trial_mode_enabled: targetPageId === pageId && body.trial_mode_enabled === true,
            trial_contact_id: targetPageId === pageId ? trialContactId : null
        }));
        const { error } = await supabase
            .from('chatbot_configs')
            .upsert(payloads.length === 1 ? payloads[0] : payloads, { onConflict: 'page_id' });

        if (error) throw error;
        return NextResponse.json({
            config: payloads[0],
            applied_page_ids: targetPageIds
        });
    } catch (error) {
        console.error('[CHATBOT_CONFIG_PUT]', error);
        return NextResponse.json(
            { error: 'Failed to save chatbot settings', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const { pageId } = await params;
        const authorization = await getAuthorizedPage(request, pageId);
        if (authorization.error) return authorization.error;

        const body = await request.json();
        const testMode = body.mode === 'continuation_review' ? 'continuation_review' : body.mode === 'follow_up' ? 'follow_up' : 'reply';
        const testContactName = typeof body.contact_name === 'string' && body.contact_name.trim()
            ? body.contact_name.trim().replace(/\s+/g, ' ').slice(0, 120)
            : 'Test Customer';
        let message = typeof body.message === 'string' ? body.message.trim() : '';
        const action = resolveChatbotAction(body.action_payload);
        if (action) message = action.message;
        if (testMode === 'reply' && (!message || message.length > 2000)) {
            return NextResponse.json({ error: 'Test message must be between 1 and 2000 characters' }, { status: 400 });
        }
        const rawTestHistory: unknown[] = Array.isArray(body.history) ? body.history : [];
        const testHistory = rawTestHistory
            .filter((entry: unknown): entry is { role: 'user' | 'assistant'; content: string } => {
                if (!entry || typeof entry !== 'object') return false;
                const candidate = entry as { role?: unknown; content?: unknown };
                return (candidate.role === 'user' || candidate.role === 'assistant') &&
                    typeof candidate.content === 'string' && candidate.content.trim().length > 0;
            })
            .slice(-20)
            .map((entry, index, entries) => ({
                id: `chatbot-test-${entries.length - index}`,
                message: entry.content.trim().slice(0, 2000),
                from: {
                    id: entry.role === 'assistant' ? 'test-page' : 'test-contact',
                    name: entry.role === 'assistant' ? 'Test Page' : 'Test Customer'
                },
                created_time: new Date(Date.now() - (entries.length - index) * 1000).toISOString()
            }))
            .reverse();
        if (testMode === 'follow_up' && testHistory.length === 0) {
            return NextResponse.json({ error: 'Start a test conversation before generating a follow-up' }, { status: 400 });
        }
        if (testMode === 'continuation_review' && testHistory.length === 0) {
            return NextResponse.json({ error: 'A review requires customer conversation history' }, { status: 400 });
        }
        const collectedDetails = body.collected_details && typeof body.collected_details === 'object' && !Array.isArray(body.collected_details)
            ? Object.fromEntries(
                Object.entries(body.collected_details as Record<string, unknown>)
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
                    .map(([key, value]) => [key.trim().slice(0, 80), value.trim().slice(0, 500)])
                    .filter(([key]) => key.length > 0)
                    .slice(0, 20)
            )
            : {};

        const supabase = getSupabaseAdmin();
        const [{ data, error }, { data: page, error: pageError }] = await Promise.all([
            supabase
                .from('chatbot_configs')
                .select(CHATBOT_CONFIG_SELECT)
                .eq('page_id', pageId)
                .maybeSingle(),
            supabase.from('pages').select('name').eq('id', pageId).maybeSingle()
        ]);
        if (error) throw error;
        if (pageError) throw pageError;

        const storedConfig = (data || defaultConfig(pageId)) as ChatbotConfig;
        const knowledgePageId = getChatbotKnowledgePageId(storedConfig);
        const config = mergeDraftConfigForPreview(storedConfig, body.draft_config);
        if (testMode === 'continuation_review') {
            const refreshedDetails = isCommercialVideoIntake(config)
                ? (await extractChatbotContactDetails({ config, pageId: 'test-page', history: testHistory,
                    inboundMessage: '', collectedDetails })).collected_details
                : collectedDetails;
            const analysis = await analyzeChatbotContinuation({ config, pageId: 'test-page', history: testHistory, collectedDetails: refreshedDetails });
            const policy = isCommercialVideoIntake(config)
                ? evaluateCommercialVideoIntake(refreshedDetails, analysis.has_clear_request ?? extractClearVideoRequest(testHistory, 'test-page').has_clear_request)
                : null;
            return NextResponse.json({ mode: testMode, analysis,
                ...(policy ? { policy, collected_details: normalizeCommercialVideoDetails(refreshedDetails) } : {}),
                would_resume: policy
                    ? config.continuation_review_enabled === true && policy.needsContinuation && analysis.purchase_status !== 'declined'
                    : analysis.purchase_status === 'undecided' && analysis.confidence >= 0.8,
                no_customer_messages_sent: true });
        }
        if (testMode === 'follow_up') {
            const followUpType = body.follow_up_type === 'human_agent' ? 'human_agent' : 'quick';
            const sequenceNumber = Math.min(10, Math.max(1, Math.round(Number(body.sequence_number) || 1)));
            const followUp = await generateChatbotFollowUp({
                salesProgress: body.sales_progress && typeof body.sales_progress === 'object' && !Array.isArray(body.sales_progress) ? body.sales_progress : undefined,
                config,
                pageId: 'test-page',
                pageName: page?.name,
                contactName: testContactName,
                history: testHistory,
                collectedDetails,
                missingDetails: isCommercialVideoIntake(config)
                    ? evaluateCommercialVideoIntake(collectedDetails, false).missingRequiredFields
                    : getMissingChatbotDetails(config.details_to_collect, collectedDetails),
                sequenceNumber,
                scheduleLabel: followUpType === 'human_agent' ? 'best-time day 2-7' : 'first 24 hours'
            });
            const followUpMediaIds = followUp.media_document_ids?.length
                ? followUp.media_document_ids
                : followUp.media_document_id
                    ? [followUp.media_document_id]
                    : [];
            const followUpMediaItems = await getReadyChatbotMediaForDocuments({
                pageId: knowledgePageId,
                documentIds: followUpMediaIds
            });
            const followUpMediaPreviews = await Promise.all(followUpMediaItems.map(async (media) => ({
                id: media.id,
                title: media.title,
                usage_notes: media.usage_notes,
                media_type: media.media_type,
                preview_url: await createChatbotMediaSignedUrl(media).catch(() => null),
                target_url: createChatbotMediaPublicViewUrl(media.id)
            })));
            const followUpDriveFiles = await getReadyChatbotDriveFilesForDocuments({
                pageId: knowledgePageId,
                documentIds: followUp.drive_file_document_ids || []
            });
            const followUpDrivePreviews = followUpDriveFiles.map((file) => ({
                id: file.id,
                title: file.name,
                usage_notes: `${file.media_type === 'image' ? 'Image' : 'Video'} sample from Google Drive`,
                media_type: file.media_type,
                preview_url: file.thumbnail_url,
                target_url: file.web_view_url,
                source: 'google_drive'
            }));
            const followUpPreviews = followUpDrivePreviews.length > 0 ? followUpDrivePreviews : followUpMediaPreviews;
            const followUpFolder = followUp.link_document_id
                ? await getReadyChatbotDriveFolderForDocument({ pageId: knowledgePageId, documentId: followUp.link_document_id })
                : null;

            return NextResponse.json({
                reply: followUp.message,
                ...(followUp.sales_progress ? { sales_progress: { ...followUp.sales_progress,
                    samples_sent: followUpPreviews.length ? [...followUpMediaIds, ...(followUp.drive_file_document_ids || [])] : [] } } : {}),
                messages: followUp.messages?.length ? followUp.messages : [followUp.message],
                message_controls: isCommercialVideoIntake(config) ? getCommercialVideoMessageControls(followUp.messages?.length ? followUp.messages : [followUp.message]) : [],
                mode: 'follow_up',
                follow_up_type: followUpType,
                personalization_basis: followUp.personalization_basis,
                follow_up_label: followUpType === 'human_agent' ? 'Day 2–7 Human Agent preview' : 'Quick follow-up preview',
                media: followUpPreviews[0] || null,
                media_items: followUpPreviews,
                folder: followUpFolder ? {
                    id: followUpFolder.id,
                    name: followUpFolder.name,
                    folder_url: followUpFolder.folder_url,
                    button_text: followUpFolder.button_text
                } : null,
                sources: followUp.knowledge.map((match) => ({
                    document_id: match.document_id,
                    title: match.title,
                    similarity: match.similarity
                })),
                token_usage: await tokenUsageWithContext(followUp.token_usage, config.model),
                retrieval_warning: followUp.retrieval_warning,
                generation_warning: followUp.generation_warning
            });
        }

        const result = await generateChatbotResponse({
            salesProgress: body.sales_progress && typeof body.sales_progress === 'object' && !Array.isArray(body.sales_progress) ? body.sales_progress : undefined,
            config,
            pageId: 'test-page',
            pageName: page?.name,
            contactName: testContactName,
            inboundMessage: message,
            history: testHistory,
            collectedDetails,
            detailTargetCount: !isCommercialVideoIntake(config) && Number.isInteger(body.detail_target_count) && body.detail_target_count >= 1 && body.detail_target_count <= 20
                ? body.detail_target_count : undefined
        });

        const mediaIds = result.media_document_ids?.length
            ? result.media_document_ids
            : result.media_document_id
                ? [result.media_document_id]
                : [];
        const mediaItems = await getReadyChatbotMediaForDocuments({ pageId: knowledgePageId, documentIds: mediaIds });
        const mediaPreviews = await Promise.all(mediaItems.map(async (media) => ({
            id: media.id,
            title: media.title,
            usage_notes: media.usage_notes,
            media_type: media.media_type,
            preview_url: await createChatbotMediaSignedUrl(media).catch(() => null),
            target_url: createChatbotMediaPublicViewUrl(media.id)
        })));
        const driveFiles = await getReadyChatbotDriveFilesForDocuments({
            pageId: knowledgePageId,
            documentIds: result.drive_file_document_ids || []
        });
        const drivePreviews = driveFiles.map((file) => ({
            id: file.id,
            title: file.name,
            usage_notes: `${file.media_type === 'image' ? 'Image' : 'Video'} sample from Google Drive`,
            media_type: file.media_type,
            preview_url: file.thumbnail_url,
            target_url: file.web_view_url,
            source: 'google_drive'
        }));
        const selectedPreviews = drivePreviews.length > 0 ? drivePreviews : mediaPreviews;
        const folder = result.link_document_id
            ? await getReadyChatbotDriveFolderForDocument({ pageId: knowledgePageId, documentId: result.link_document_id })
            : null;

        return NextResponse.json({
            reply: result.reply,
            ...(result.sales_progress ? { sales_progress: { ...result.sales_progress,
                samples_sent: selectedPreviews.length ? [...(result.media_document_ids || []), ...(result.drive_file_document_ids || [])] : [] } } : {}),
            messages: result.messages,
            message_controls: isCommercialVideoIntake(config) ? getCommercialVideoMessageControls(result.messages) : [],
            collected_details: result.collected_details,
            missing_details: result.missing_details,
            details_complete: result.details_complete,
            detected_stop_reason: result.detected_stop_reason,
            intake_action: result.intake_action,
            has_clear_request: result.has_clear_request,
            request_type: result.request_type,
            media: selectedPreviews[0] || null,
            media_items: selectedPreviews,
            folder: folder ? {
                id: folder.id,
                name: folder.name,
                folder_url: folder.folder_url,
                button_text: folder.button_text
            } : null,
            sources: result.knowledge.map((match) => ({
                document_id: match.document_id,
                title: match.title,
                similarity: match.similarity
            })),
            token_usage: await tokenUsageWithContext(result.token_usage, config.model),
            retrieval_warning: result.retrieval_warning,
            generation_warning: result.generation_warning
        });
    } catch (error) {
        console.error('[CHATBOT_TEST_POST]', error);
        return NextResponse.json(
            { error: 'Chatbot test failed', message: (error as Error).message },
            { status: 502 }
        );
    }
}
