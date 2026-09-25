import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyWebhookSignature, sendMessage, sendMessengerGenericCarousel, getConversationForPsid, getUserProfile } from '@/lib/facebook';
import { isExpectedFacebookProfileLookupError } from '@/lib/facebook-errors';
import { getPhilippinesDayOfWeek, getPhilippinesHour } from '@/lib/philippines-time';
import { replaceTemplateVariables } from '@/lib/placeholders';
import { handleFollowUpWorkflowContactReply, stopWorkflowAutomationsFromPageMessage } from '@/lib/workflow-automations';
import { recordOutboundMessageEvent } from '@/lib/outbound-message-events';
import { generateChatbotResponse, type ChatbotConfig } from '@/lib/chatbot';
import { createChatbotMediaPublicViewUrl, createChatbotMediaSignedUrl, getReadyChatbotMediaForDocuments } from '@/lib/chatbot-media';
import { getReadyChatbotDriveFilesForDocuments, getReadyChatbotDriveFolderForDocument } from '@/lib/chatbot-drive-folders';
import { cancelPendingChatbotFollowUps, scheduleChatbotFollowUps } from '@/lib/chatbot-follow-ups';
import { claimChatbotReply, finishChatbotReply } from '@/lib/chatbot-replies';
import {
    classifyChatbotStopIntent,
    getChatbotContactState,
    getChatbotStateStopReason,
    getMissingChatbotDetails,
    isChatbotContactAllowed,
    saveChatbotContactState,
    type ChatbotStopReason
} from '@/lib/chatbot-control';
import {
    isPipelineClosedForAutomation,
    pipelineStageForChatbotProgress,
    updateContactPipelineStage
} from '@/lib/contact-pipeline';
import { composeContactName, hasUsableContactName, normalizeContactName, pickPreferredContactName } from '../../../../lib/contact-names';

const PROFILE_LOOKUP_FAILURE_TTL_MS = 60 * 60 * 1000;
const CONTACT_NAME_LOOKUP_TIMEOUT_MS = 2500;
const profileLookupSuppressedUntil = new Map<string, number>();

function chatbotStopReasonForPipelineStage(stage: unknown): ChatbotStopReason | null {
    if (stage === 'qualified') return 'qualified';
    if (stage === 'order_created') return 'order_created';
    if (stage === 'converted') return 'converted';
    if (stage === 'not_qualified') return 'not_qualified';
    if (stage === 'opted_out') return 'opt_out';
    return null;
}

function isProfileLookupSuppressed(pageId: string, senderId: string) {
    const key = `${pageId}:${senderId}`;
    const suppressedUntil = profileLookupSuppressedUntil.get(key) || 0;
    if (suppressedUntil <= Date.now()) {
        profileLookupSuppressedUntil.delete(key);
        return false;
    }

    return true;
}

function suppressProfileLookup(pageId: string, senderId: string) {
    if (profileLookupSuppressedUntil.size >= 5000) {
        const now = Date.now();
        for (const [key, suppressedUntil] of profileLookupSuppressedUntil) {
            if (suppressedUntil <= now) profileLookupSuppressedUntil.delete(key);
        }
    }

    profileLookupSuppressedUntil.set(`${pageId}:${senderId}`, Date.now() + PROFILE_LOOKUP_FAILURE_TTL_MS);
}

// GET /api/facebook/webhook - Verify webhook
export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');
    const showToken = searchParams.get('show_token') === 'true';

    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const appId = process.env.FACEBOOK_CLIENT_ID;

    if (!appSecret || !appId) {
        return NextResponse.json({ error: 'Facebook app credentials not configured' }, { status: 500 });
    }

    const verifyToken = 'TEST_TOKEN';

    // Show token in development mode for Facebook webhook setup
    const isDevelopment = process.env.NODE_ENV !== 'production';
    if (showToken && isDevelopment) {
        console.log('🔵 Webhook verify token requested (development mode)');
        return NextResponse.json({
            verify_token: verifyToken,
            message: 'Use this token when setting up your Facebook webhook',
            webhook_url: `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/facebook/webhook`,
            app_id: appId,
            environment: 'development'
        });
    }

    if (mode === 'subscribe' && token === verifyToken) {
        console.log('✅ Webhook verified successfully');
        if (isDevelopment) {
            console.log('🔵 Webhook verification details:', {
                mode,
                challenge_length: challenge?.length,
                app_id: appId
            });
        }
        return new NextResponse(challenge, { status: 200 });
    }

    if (isDevelopment) {
        console.warn('⚠️ Webhook verification failed:', {
            mode,
            token_provided: !!token,
            token_match: token === verifyToken
        });
    }
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// POST /api/facebook/webhook - Receive webhook events
export async function POST(request: NextRequest) {
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const logPrefix = `[FB_WEBHOOK][${requestId}]`;
    const logInfo = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.log(`${logPrefix} ${message}`, data);
            return;
        }
        console.log(`${logPrefix} ${message}`);
    };
    const logWarn = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.warn(`${logPrefix} ${message}`, data);
            return;
        }
        console.warn(`${logPrefix} ${message}`);
    };
    const logError = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.error(`${logPrefix} ${message}`, data);
            return;
        }
        console.error(`${logPrefix} ${message}`);
    };

    try {
        const body = await request.text();
        const signature = request.headers.get('x-hub-signature-256') || '';
        const appSecret = process.env.FACEBOOK_APP_SECRET!;

        // Verify signature in production only (skip in development for easier testing)
        const isDevelopment = process.env.NODE_ENV !== 'production';
        if (!isDevelopment && appSecret) {
            if (!verifyWebhookSignature(body, signature, appSecret)) {
                logError('Webhook signature verification failed');
                return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
            }
        } else if (isDevelopment) {
            logInfo('Webhook signature verification skipped (development mode)');
        }

        const data = JSON.parse(body);
        const supabase = getSupabaseAdmin();
        let hadCriticalFailure = false;

        let processedEntries = 0;
        let processedEvents = 0;
        let processedContacts = 0;
        let skippedEvents = 0;

        const entryCount = Array.isArray(data.entry) ? data.entry.length : 0;
        logInfo('Webhook payload parsed', {
            object: data.object,
            entryCount,
            bodyLength: body.length,
            signatureProvided: Boolean(signature)
        });

        // Process messaging events
        if (data.object === 'page') {
            for (const entry of data.entry) {
                processedEntries += 1;
                const pageId = entry.id;
                const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
                const standbyEvents = Array.isArray((entry as { standby?: unknown[] }).standby)
                    ? (entry as { standby?: unknown[] }).standby || []
                    : [];

                const inboundEvents = [...messagingEvents, ...standbyEvents];

                if (standbyEvents.length > 0) {
                    logInfo('Received standby events for contact ingestion', {
                        pageId,
                        standbyCount: standbyEvents.length
                    });
                }

                if (inboundEvents.length === 0) {
                    logInfo('Skipping entry with no inbound events', { pageId });
                    continue;
                }

                // Get our page record
                const { data: page, error: pageError } = await supabase
                    .from('pages')
                    .select('id, name, access_token')
                    .eq('fb_page_id', pageId)
                    .single();

                if (pageError) {
                    logError('Failed to fetch page by fb_page_id', {
                        pageId,
                        error: pageError.message
                    });
                    hadCriticalFailure = true;
                    continue;
                }

                if (!page) {
                    logWarn('No internal page record found for webhook entry', { pageId });
                    continue;
                }

                // Fetch welcome message config for this page (cached per webhook batch)
                let welcomeConfig: { enabled: boolean; message_text: string; buttons: Array<{ type: string; text: string; url?: string; payload?: string }> } | null = null;
                let welcomeConfigFetched = false;
                let chatbotConfig: ChatbotConfig | null = null;
                let chatbotConfigFetched = false;

                // Process inbound events from both messaging and standby arrays
                if (inboundEvents.length > 0) {
                    for (const event of inboundEvents) {
                        processedEvents += 1;
                        try {
                            const isStandbyEvent = standbyEvents.includes(event);
                            const eventType = event.message
                                ? 'message'
                                : event.postback
                                    ? 'postback'
                                    : event.referral
                                        ? 'referral'
                                        : event.delivery
                                            ? 'delivery'
                                            : event.read
                                                ? 'read'
                                                : event.optin
                                                    ? 'optin'
                                                    : 'unknown';
                            const senderId = event.sender?.id;
                            const recipientId = event.recipient?.id;

                            if (!senderId) {
                                skippedEvents += 1;
                                logWarn('Skipping messaging event without sender id', {
                                    pageId,
                                    recipientId: recipientId ?? null,
                                    eventType,
                                    eventKeys: Object.keys(event || {})
                                });
                                continue;
                            }

                            const isFromContact = senderId !== pageId;

                            // Page echoes can carry the manual workflow stop code.
                            if (!isFromContact) {
                                skippedEvents += 1;
                                const outboundMessageText = typeof event.message?.text === 'string'
                                    ? event.message.text.trim()
                                    : '';

                                if (eventType === 'message' && outboundMessageText && recipientId) {
                                    try {
                                        const stopResult = await stopWorkflowAutomationsFromPageMessage({
                                            supabase,
                                            pageId: page.id,
                                            contactPsid: recipientId,
                                            messageText: outboundMessageText
                                        });

                                        if (stopResult.stopped > 0) {
                                            logInfo('Stopped workflow automation from outbound page code', {
                                                pageId,
                                                recipientId,
                                                stopped: stopResult.stopped
                                            });
                                        }
                                    } catch (stopError) {
                                        logWarn('Failed to process outbound workflow stop code', {
                                            pageId,
                                            recipientId,
                                            error: (stopError as Error).message
                                        });
                                    }
                                }

                                if (eventType === 'message' || eventType === 'postback' || eventType === 'referral') {
                                    logInfo('Skipping outbound page event from webhook payload', {
                                        pageId,
                                        senderId,
                                        recipientId: recipientId ?? null,
                                        eventType
                                    });
                                }
                                continue;
                            }

                        let interactionTime = new Date();
                        const rawTimestamp = event.timestamp;
                        if (rawTimestamp !== undefined && rawTimestamp !== null) {
                            let parsedTime: Date | null = null;
                            if (typeof rawTimestamp === 'number' || typeof rawTimestamp === 'string') {
                                const numericTimestamp = Number(rawTimestamp);
                                if (Number.isFinite(numericTimestamp)) {
                                    const candidate = new Date(numericTimestamp);
                                    if (!Number.isNaN(candidate.getTime())) {
                                        parsedTime = candidate;
                                    }
                                }

                                if (!parsedTime) {
                                    const candidate = new Date(rawTimestamp);
                                    if (!Number.isNaN(candidate.getTime())) {
                                        parsedTime = candidate;
                                    }
                                }
                            }

                            if (parsedTime) {
                                interactionTime = parsedTime;
                            } else {
                                logWarn('Invalid webhook event timestamp; using server time fallback', {
                                    pageId,
                                    senderId,
                                    eventType,
                                    rawTimestamp
                                });
                            }
                        } else {
                            logWarn('Webhook event missing timestamp; using server time fallback', {
                                pageId,
                                senderId,
                                eventType
                            });
                        }

                        const interactionAt = interactionTime.toISOString();

                        // Check if contact exists BEFORE upsert (to detect new contacts)
                        const { data: existingContact, error: existingContactError } = await supabase
                            .from('contacts')
                            .select('id, name, last_inbound_at, best_contact_hour, pipeline_stage')
                            .eq('page_id', page.id)
                            .eq('psid', senderId)
                            .maybeSingle();

                        if (existingContactError) {
                            logError('Failed to check existing contact before upsert', {
                                pageId,
                                senderId,
                                error: existingContactError.message
                            });
                            hadCriticalFailure = true;
                            continue;
                        }

                        const isNewContact = !existingContact;
                        const missingName = !hasUsableContactName(existingContact?.name);
                        const eventSenderName = normalizeContactName(event.sender?.name);
                        const shouldRefreshProfile =
                            (isNewContact || missingName) &&
                            !isProfileLookupSuppressed(page.id, senderId);

                        let profileName: string | null = null;
                        let conversationName: string | null = null;
                        let profilePic: string | null = null;
                        let resolvedConversation: Awaited<ReturnType<typeof getConversationForPsid>> = null;

                        if (shouldRefreshProfile) {
                            try {
                                const profile = await getUserProfile(senderId, page.access_token, {
                                    timeoutMs: CONTACT_NAME_LOOKUP_TIMEOUT_MS
                                });
                                profileName = normalizeContactName(profile.name);

                                profileName = pickPreferredContactName(
                                    profileName,
                                    composeContactName(profile.first_name, profile.last_name)
                                );

                                profilePic = typeof profile.profile_pic === 'string' ? profile.profile_pic.trim() || null : null;
                            } catch (profileError) {
                                const profileErrorMessage = (profileError as Error).message || String(profileError);
                                if (isExpectedFacebookProfileLookupError(profileErrorMessage)) {
                                    suppressProfileLookup(page.id, senderId);
                                } else {
                                    logWarn('Failed to fetch profile for contact enrichment', {
                                        pageId,
                                        senderId,
                                        isNewContact,
                                        missingName,
                                        error: profileErrorMessage
                                    });
                                }
                            }
                        }

                        if ((isNewContact || missingName) && !profileName && !eventSenderName) {
                            try {
                                resolvedConversation = await getConversationForPsid(
                                    pageId,
                                    senderId,
                                    page.access_token,
                                    { throwOnError: true, timeoutMs: CONTACT_NAME_LOOKUP_TIMEOUT_MS }
                                );
                                conversationName = pickPreferredContactName(
                                    ...(resolvedConversation?.participants?.data || [])
                                        .filter((participant) => participant.id === senderId)
                                        .map((participant) => participant.name),
                                    ...(resolvedConversation?.messages?.data || [])
                                        .filter((message) => message.from?.id === senderId)
                                        .map((message) => message.from?.name)
                                );
                            } catch (conversationError) {
                                logWarn('Failed to fetch conversation name for contact enrichment', {
                                    pageId,
                                    senderId,
                                    error: (conversationError as Error).message || String(conversationError)
                                });
                            }
                        }

                        const resolvedName = pickPreferredContactName(
                            profileName,
                            eventSenderName,
                            conversationName,
                            existingContact?.name
                        );
                        const existingNameShouldBeCleared =
                            typeof existingContact?.name === 'string' &&
                            !hasUsableContactName(existingContact.name);

                        const contactPayload: Record<string, unknown> = {
                            page_id: page.id,
                            psid: senderId,
                            ...(resolvedName ? { name: resolvedName } : existingNameShouldBeCleared ? { name: null } : {}),
                            ...(profilePic ? { profile_pic: profilePic } : {}),
                            last_interaction_at: interactionAt,
                            ...(eventType === 'message' && (
                                !existingContact?.last_inbound_at ||
                                new Date(existingContact.last_inbound_at).getTime() < interactionTime.getTime()
                            ) ? { last_inbound_at: interactionAt } : {}),
                            updated_at: new Date().toISOString(),
                            ...(isNewContact ? { first_interaction_at: interactionAt } : {})
                        };

                        let { data: contact, error: contactUpsertError } = await supabase
                            .from('contacts')
                            .upsert(contactPayload, {
                                onConflict: 'page_id,psid'
                            })
                            .select('id, name, best_contact_hour, pipeline_stage')
                            .single();

                        if (
                            contactUpsertError &&
                            isNewContact &&
                            Object.prototype.hasOwnProperty.call(contactPayload, 'first_interaction_at') &&
                            /first_interaction_at/i.test(contactUpsertError.message || '')
                        ) {
                            const { first_interaction_at: _ignored, ...legacyContactPayload } = contactPayload;

                            logWarn('Retrying contact upsert without first_interaction_at due to schema mismatch', {
                                pageId,
                                senderId,
                                error: contactUpsertError.message
                            });
                            const retryResult = await supabase
                                .from('contacts')
                                .upsert(legacyContactPayload, {
                                    onConflict: 'page_id,psid'
                                })
                                .select('id, name, best_contact_hour, pipeline_stage')
                                .single();

                            contact = retryResult.data;
                            contactUpsertError = retryResult.error;
                        }

                        if (contactUpsertError && isNewContact) {
                            const { first_interaction_at: _ignored, ...insertContactPayload } = contactPayload;

                            logWarn('Upsert failed for new contact, retrying with direct insert', {
                                pageId,
                                senderId,
                                error: contactUpsertError.message
                            });
                            const insertResult = await supabase
                                .from('contacts')
                                .insert(insertContactPayload)
                                .select('id, name, best_contact_hour, pipeline_stage')
                                .single();

                            contact = insertResult.data;
                            contactUpsertError = insertResult.error;
                        }

                        if (contactUpsertError) {
                            logError('Failed to create or update contact from webhook', {
                                pageId,
                                senderId,
                                error: contactUpsertError.message
                            });
                            hadCriticalFailure = true;
                            continue;
                        }

                        processedContacts += 1;
                        let welcomeMessageSent = false;
                        let conversationHistoryUnavailable = false;

                        // A contact can be new to our database while already having an
                        // existing Messenger thread. Read that thread before treating
                        // the person as a brand-new conversation.
                        if (isNewContact && !resolvedConversation) {
                            try {
                                resolvedConversation = await getConversationForPsid(
                                    pageId,
                                    senderId,
                                    page.access_token,
                                    { throwOnError: true, timeoutMs: 5000 }
                                );
                            } catch (conversationError) {
                                conversationHistoryUnavailable = true;
                                logWarn('Could not verify conversation history for new contact; skipping welcome safely', {
                                    pageId,
                                    senderId,
                                    error: (conversationError as Error).message || String(conversationError)
                                });
                            }
                        }

                        const currentInboundMessageId = typeof event.message?.mid === 'string'
                            ? event.message.mid.trim()
                            : '';
                        const hasPriorConversation = (resolvedConversation?.messages?.data || []).some((message) =>
                            !currentInboundMessageId || message.id !== currentInboundMessageId
                        );

                        // Send welcome message to new contacts
                        if (isNewContact && contact && !hasPriorConversation && !conversationHistoryUnavailable) {
                            // Lazy-load welcome config once per page per webhook batch
                            if (!welcomeConfigFetched) {
                                const { data: wc, error: welcomeConfigError } = await supabase
                                    .from('welcome_messages')
                                    .select('enabled, message_text, buttons')
                                    .eq('page_id', page.id)
                                    .maybeSingle();

                                if (welcomeConfigError) {
                                    logWarn('Failed to fetch welcome message config', {
                                        pageId,
                                        pageDbId: page.id,
                                        error: welcomeConfigError.message
                                    });
                                } else {
                                    welcomeConfig = wc;
                                }
                                welcomeConfigFetched = true;
                            }

                            if (welcomeConfig?.enabled && welcomeConfig.message_text?.trim()) {
                                // Personalize the message
                                const contactName = (contact as { id: string; name?: string }).name || '';

                                let welcomeText = replaceTemplateVariables(welcomeConfig.message_text, {
                                    id: (contact as { id: string }).id || '',
                                    psid: senderId,
                                    page_id: page.id,
                                    name: contactName,
                                    last_interaction_at: null
                                });

                                const mappedWelcomeButtons = Array.isArray(welcomeConfig.buttons)
                                    ? welcomeConfig.buttons
                                        .map((button) => {
                                            const text = typeof button?.text === 'string' ? button.text.trim() : '';
                                            if (!text) return null;

                                            const buttonType = typeof button?.type === 'string' ? button.type.toUpperCase() : 'URL';
                                            if (buttonType === 'QUICK_REPLY') {
                                                const payload = typeof button?.payload === 'string' && button.payload.trim().length > 0
                                                    ? button.payload.trim()
                                                    : text;
                                                return {
                                                    type: 'POSTBACK' as const,
                                                    text,
                                                    payload
                                                };
                                            }

                                            const url = typeof button?.url === 'string' ? button.url.trim() : '';
                                            if (!url) return null;

                                            return {
                                                type: 'URL' as const,
                                                text,
                                                url
                                            };
                                        })
                                        .filter((button): button is { type: 'URL'; text: string; url: string } | { type: 'POSTBACK'; text: string; payload: string } => button !== null)
                                        .slice(0, 3)
                                    : [];

                                const welcomeMessagingType = 'RESPONSE';

                                // Send welcome message (must await in serverless environment)
                                try {
                                    const sendResult = await sendMessage(
                                        pageId,
                                        page.access_token,
                                        senderId,
                                        welcomeText,
                                        welcomeMessagingType,
                                        undefined,
                                        undefined,
                                        undefined,
                                        mappedWelcomeButtons.length > 0 ? mappedWelcomeButtons : undefined
                                    );
                                    await recordOutboundMessageEvent(supabase, {
                                        pageId: page.id,
                                        contactId: (contact as { id: string }).id,
                                        messageId: sendResult.message_id,
                                        sourceType: 'welcome',
                                        sourceName: 'Welcome message',
                                        messageKind: welcomeMessagingType
                                    });
                                    welcomeMessageSent = true;
                                    logInfo('Welcome message sent to new contact', {
                                        pageId,
                                        senderId,
                                        messagingType: welcomeMessagingType,
                                        buttonCount: mappedWelcomeButtons.length
                                    });
                                } catch (err) {
                                    logError('Failed to send welcome message', {
                                        pageId,
                                        senderId,
                                        error: (err as Error).message
                                    });
                                }
                            }
                        }

                        // Record interaction for best time to contact analysis
                        if (contact) {
                            const inboundMessageText = typeof event.message?.text === 'string'
                                ? event.message.text.trim()
                                : '';

                            // Attachments are replies too. The workflow handler
                            // does not require text, so schedule/reset on every
                            // inbound message rather than text-only messages.
                            if (eventType === 'message') {
                                try {
                                    await cancelPendingChatbotFollowUps({
                                        supabase,
                                        pageId: page.id,
                                        contactId: contact.id,
                                        reason: 'Customer replied',
                                        now: interactionTime
                                    });
                                } catch (followUpCancelError) {
                                    logWarn('Could not cancel pending chatbot follow-ups', {
                                        pageId,
                                        senderId,
                                        contactId: contact.id,
                                        error: (followUpCancelError as Error).message
                                    });
                                }

                                try {
                                    const pipelineClosed = isPipelineClosedForAutomation(
                                        (contact as { pipeline_stage?: unknown }).pipeline_stage
                                    );
                                    const workflowResult = pipelineClosed
                                        ? { scheduled: 0, continued: 0, reset: 0, stopped: 0, errors: 0 }
                                        : await handleFollowUpWorkflowContactReply({
                                        supabase,
                                        page: {
                                            id: page.id,
                                            fb_page_id: pageId,
                                            access_token: page.access_token
                                        },
                                        contact: {
                                            id: contact.id,
                                            psid: senderId,
                                            page_id: page.id,
                                            name: (contact as { name?: string | null }).name || null,
                                            last_interaction_at: interactionAt
                                        },
                                        messageText: inboundMessageText,
                                        interactionAt
                                        });

                                    if (
                                        workflowResult.scheduled > 0 ||
                                        workflowResult.continued > 0 ||
                                        workflowResult.reset > 0 ||
                                        workflowResult.stopped > 0 ||
                                        workflowResult.errors > 0
                                    ) {
                                        logInfo('Processed follow-up workflow automations', {
                                            pageId,
                                            senderId,
                                            contactId: contact.id,
                                            ...workflowResult
                                        });
                                    }
                                } catch (workflowError) {
                                    logWarn('Failed to process follow-up workflow automations', {
                                        pageId,
                                        senderId,
                                        contactId: contact.id,
                                        error: (workflowError as Error).message
                                    });
                                }
                            }

                            const inboundMessageId = typeof event.message?.mid === 'string'
                                ? event.message.mid.trim()
                                : '';

                            if (
                                eventType === 'message' &&
                                inboundMessageText &&
                                inboundMessageId &&
                                !isStandbyEvent &&
                                !welcomeMessageSent
                            ) {
                                if (!chatbotConfigFetched) {
                                    try {
                                        const { data: storedChatbotConfig, error: chatbotConfigError } = await supabase
                                            .from('chatbot_configs')
                                            .select('page_id, enabled, trial_mode_enabled, trial_contact_id, instructions, fallback_reply, model, rag_enabled, follow_up_prompt, details_to_collect, details_completion_percent, bot_dos, bot_donts, follow_up_enabled, follow_up_quick_delays_minutes, follow_up_best_time_days, follow_up_messages, follow_up_ai_instructions, follow_up_utility_template_name, follow_up_utility_template_language, follow_up_utility_text, follow_up_media_asset_id, split_messages, max_message_parts, stop_when_details_collected, stop_on_opt_out, stop_on_refusal, stop_on_qualified, stop_on_not_qualified, stop_on_converted, stop_on_order_created')
                                            .eq('page_id', page.id)
                                            .maybeSingle();

                                        if (chatbotConfigError) {
                                            logWarn('Failed to fetch chatbot config', {
                                                pageId,
                                                pageDbId: page.id,
                                                error: chatbotConfigError.message
                                            });
                                        } else {
                                            chatbotConfig = storedChatbotConfig as ChatbotConfig | null;
                                        }
                                    } catch (chatbotConfigError) {
                                        logWarn('Chatbot config is unavailable; skipping automatic reply', {
                                            pageId,
                                            pageDbId: page.id,
                                            error: (chatbotConfigError as Error).message
                                        });
                                    }
                                    chatbotConfigFetched = true;
                                }

                                if (chatbotConfig?.enabled && isChatbotContactAllowed(chatbotConfig, contact.id)) {
                                    let chatbotState = null;
                                    let stateStopReason: ChatbotStopReason | null = chatbotStopReasonForPipelineStage(
                                        (contact as { pipeline_stage?: unknown }).pipeline_stage
                                    );
                                    try {
                                        chatbotState = await getChatbotContactState(supabase, page.id, contact.id);
                                        const storedStopReason = getChatbotStateStopReason(chatbotState, interactionTime);
                                        if (storedStopReason === 'window_expired') {
                                            // A fresh customer message opens a new seven-day activity window.
                                            // Other stop reasons remain durable until manually reset.
                                            chatbotState = null;
                                        } else if (!stateStopReason) {
                                            stateStopReason = storedStopReason;
                                        }
                                        stateStopReason = stateStopReason || classifyChatbotStopIntent(inboundMessageText, {
                                                stopOnOptOut: chatbotConfig.stop_on_opt_out,
                                                stopOnRefusal: chatbotConfig.stop_on_refusal
                                            });

                                        if (stateStopReason && chatbotState?.status !== 'stopped') {
                                            await saveChatbotContactState(supabase, {
                                                pageId: page.id,
                                                contactId: contact.id,
                                                existingState: chatbotState,
                                                collectedDetails: chatbotState?.collected_details || {},
                                                missingDetails: getMissingChatbotDetails(
                                                    chatbotConfig.details_to_collect,
                                                    chatbotState?.collected_details || {}
                                                ),
                                                inboundAt: interactionAt,
                                                stopReason: stateStopReason,
                                                now: interactionTime
                                            });
                                        }
                                    } catch (stateError) {
                                        stateStopReason = 'manual';
                                        logWarn('Chatbot state is unavailable; skipping automatic reply safely', {
                                            pageId,
                                            senderId,
                                            error: (stateError as Error).message
                                        });
                                    }

                                    if (stateStopReason !== 'manual' && stateStopReason !== 'window_expired') {
                                        try {
                                            await updateContactPipelineStage(supabase, {
                                                pageId: page.id,
                                                contactId: contact.id,
                                                stage: pipelineStageForChatbotProgress({
                                                    stopReason: stateStopReason,
                                                    collectedDetails: chatbotState?.collected_details || {}
                                                }),
                                                source: 'chatbot',
                                                now: interactionTime
                                            });
                                        } catch (pipelineError) {
                                            logWarn('Could not update chatbot contact pipeline stage', {
                                                pageId,
                                                senderId,
                                                contactId: contact.id,
                                                error: (pipelineError as Error).message
                                            });
                                        }
                                    }

                                    if (stateStopReason) {
                                        logInfo('Chatbot reply skipped by stop rule', {
                                            pageId,
                                            senderId,
                                            contactId: contact.id,
                                            reason: stateStopReason
                                        });
                                    }

                                    let claimed = false;
                                    if (!stateStopReason) {
                                        try {
                                            claimed = await claimChatbotReply(supabase, {
                                                inboundMessageId,
                                                pageId: page.id,
                                                contactId: contact.id
                                            });
                                        } catch (claimError) {
                                            logWarn('Could not claim chatbot reply', {
                                                pageId,
                                                senderId,
                                                inboundMessageId,
                                                error: (claimError as Error).message
                                            });
                                        }
                                    }

                                    if (claimed) {
                                        try {
                                            if (!resolvedConversation) {
                                                resolvedConversation = await getConversationForPsid(
                                                    pageId,
                                                    senderId,
                                                    page.access_token,
                                                    { throwOnError: true, timeoutMs: 5000 }
                                                );
                                            }

                                            let replyMessages = chatbotConfig.fallback_reply.trim()
                                                ? [chatbotConfig.fallback_reply.trim()]
                                                : [];
                                            let collectedDetails = chatbotState?.collected_details || {};
                                            let missingDetails = getMissingChatbotDetails(
                                                chatbotConfig.details_to_collect,
                                                collectedDetails
                                            );
                                            let generatedStopReason: ChatbotStopReason | null = null;
                                            let detailsComplete = false;
                                            let generatedMediaDocumentIds: string[] = [];
                                            let generatedDriveFileDocumentIds: string[] = [];
                                            let generatedLinkDocumentId: string | undefined;
                                            try {
                                                const generated = await generateChatbotResponse({
                                                    config: chatbotConfig,
                                                    contactName: (contact as { name?: string | null }).name,
                                                    pageName: page.name,
                                                    pageId,
                                                    inboundMessage: inboundMessageText,
                                                    history: resolvedConversation?.messages?.data || [],
                                                    collectedDetails
                                                });
                                                replyMessages = generated.messages;
                                                collectedDetails = generated.collected_details;
                                                missingDetails = generated.missing_details;
                                                detailsComplete = generated.details_complete;
                                                generatedMediaDocumentIds = generated.media_document_ids?.length
                                                    ? generated.media_document_ids
                                                    : generated.media_document_id
                                                        ? [generated.media_document_id]
                                                        : [];
                                                generatedDriveFileDocumentIds = generated.drive_file_document_ids || [];
                                                generatedLinkDocumentId = generated.link_document_id;
                                                if (
                                                    generated.detected_stop_reason === 'opt_out' &&
                                                    chatbotConfig.stop_on_opt_out
                                                ) {
                                                    generatedStopReason = 'opt_out';
                                                } else if (
                                                    generated.detected_stop_reason === 'refusal' &&
                                                    chatbotConfig.stop_on_refusal
                                                ) {
                                                    generatedStopReason = 'refusal';
                                                } else if (
                                                    generated.details_complete &&
                                                    chatbotConfig.stop_when_details_collected
                                                ) {
                                                    generatedStopReason = 'details_collected';
                                                }
                                            } catch (generationError) {
                                                logWarn('AI reply generation failed; using chatbot fallback', {
                                                    pageId,
                                                    senderId,
                                                    error: (generationError as Error).message
                                                });
                                            }

                                            if (generatedStopReason === 'opt_out' || generatedStopReason === 'refusal') {
                                                replyMessages = [];
                                            }

                                            if (replyMessages.length === 0 && !generatedStopReason) {
                                                throw new Error('Chatbot generated no reply and no fallback is configured');
                                            }

                                            let lastOutboundMessageId: string | undefined;
                                            let sentMedia = false;
                                            let selectedDriveFolder = null;
                                            let selectedDriveFiles = [] as Awaited<ReturnType<typeof getReadyChatbotDriveFilesForDocuments>>;
                                            if (generatedDriveFileDocumentIds.length > 0 && !generatedStopReason) {
                                                try {
                                                    selectedDriveFiles = await getReadyChatbotDriveFilesForDocuments({
                                                        pageId: page.id,
                                                        documentIds: generatedDriveFileDocumentIds
                                                    });
                                                } catch (driveFileError) {
                                                    logWarn('Chatbot reply generated but indexed Drive file lookup failed', {
                                                        pageId,
                                                        senderId,
                                                        documentIds: generatedDriveFileDocumentIds,
                                                        error: (driveFileError as Error).message
                                                    });
                                                }
                                            }
                                            if (generatedLinkDocumentId && selectedDriveFiles.length === 0 && !generatedStopReason) {
                                                try {
                                                    selectedDriveFolder = await getReadyChatbotDriveFolderForDocument({
                                                        pageId: page.id,
                                                        documentId: generatedLinkDocumentId
                                                    });
                                                } catch (folderError) {
                                                    logWarn('Chatbot reply generated but Drive folder lookup failed', {
                                                        pageId,
                                                        senderId,
                                                        documentId: generatedLinkDocumentId,
                                                        error: (folderError as Error).message
                                                    });
                                                }
                                            }
                                            for (const [messageIndex, replyText] of replyMessages.entries()) {
                                                const isFinalMessage = messageIndex === replyMessages.length - 1;
                                                const sendResult = await sendMessage(
                                                    pageId,
                                                    page.access_token,
                                                    senderId,
                                                    replyText.trim(),
                                                    'RESPONSE',
                                                    undefined,
                                                    undefined,
                                                    undefined,
                                                    isFinalMessage && selectedDriveFolder
                                                        ? [{
                                                            type: 'URL',
                                                            text: selectedDriveFolder.button_text,
                                                            url: selectedDriveFolder.folder_url
                                                        }]
                                                        : undefined
                                                );
                                                lastOutboundMessageId = sendResult.message_id;

                                                await recordOutboundMessageEvent(supabase, {
                                                    pageId: page.id,
                                                    contactId: contact.id,
                                                    messageId: sendResult.message_id,
                                                    sourceType: 'chatbot',
                                                    sourceName: replyMessages.length > 1
                                                        ? `AI Chatbot (${messageIndex + 1}/${replyMessages.length})`
                                                        : 'AI Chatbot',
                                                    messageKind: 'RESPONSE'
                                                });
                                            }

                                            if (selectedDriveFiles.length > 0 && !generatedStopReason) {
                                                try {
                                                    const mediaResult = await sendMessengerGenericCarousel(
                                                        pageId,
                                                        page.access_token,
                                                        senderId,
                                                        selectedDriveFiles.map((file) => ({
                                                            title: file.name,
                                                            subtitle: file.media_type === 'image' ? 'Image sample' : 'Video sample',
                                                            url: file.web_view_url,
                                                            imageUrl: file.thumbnail_url || undefined,
                                                            buttonTitle: file.media_type === 'image' ? 'View image' : 'Watch video'
                                                        })),
                                                        'RESPONSE'
                                                    );
                                                    lastOutboundMessageId = mediaResult.message_id;
                                                    sentMedia = true;
                                                    await recordOutboundMessageEvent(supabase, {
                                                        pageId: page.id,
                                                        contactId: contact.id,
                                                        messageId: mediaResult.message_id,
                                                        sourceType: 'chatbot',
                                                        sourceName: selectedDriveFiles.length > 1
                                                            ? `AI Chatbot Drive carousel (${selectedDriveFiles.length} cards)`
                                                            : `AI Chatbot Drive card: ${selectedDriveFiles[0].name}`,
                                                        messageKind: selectedDriveFiles.length > 1
                                                            ? `Drive media carousel (${selectedDriveFiles.length} cards)`
                                                            : 'Drive media card'
                                                    });
                                                } catch (driveCarouselError) {
                                                    logWarn('Chatbot text sent but Drive file carousel failed', {
                                                        pageId,
                                                        senderId,
                                                        fileIds: selectedDriveFiles.map((file) => file.drive_file_id),
                                                        error: (driveCarouselError as Error).message
                                                    });
                                                }
                                            }

                                            if (generatedMediaDocumentIds.length > 0 && !generatedStopReason) {
                                                try {
                                                    const mediaItems = await getReadyChatbotMediaForDocuments({
                                                        pageId: page.id,
                                                        documentIds: generatedMediaDocumentIds
                                                    });
                                                    if (mediaItems.length > 0) {
                                                        const cards = await Promise.all(mediaItems.map(async (media) => {
                                                            const mediaUrl = await createChatbotMediaSignedUrl(media);
                                                            return {
                                                                title: media.title,
                                                                subtitle: media.usage_notes || `${media.media_type === 'image' ? 'Image' : 'Video'} sample`,
                                                                url: createChatbotMediaPublicViewUrl(media.id),
                                                                imageUrl: media.media_type === 'image' ? mediaUrl : undefined,
                                                                buttonTitle: media.media_type === 'image' ? 'View image' : 'Watch video'
                                                            };
                                                        }));
                                                        const mediaResult = await sendMessengerGenericCarousel(
                                                            pageId,
                                                            page.access_token,
                                                            senderId,
                                                            cards,
                                                            'RESPONSE'
                                                        );
                                                        lastOutboundMessageId = mediaResult.message_id;
                                                        sentMedia = true;
                                                        await recordOutboundMessageEvent(supabase, {
                                                            pageId: page.id,
                                                            contactId: contact.id,
                                                            messageId: mediaResult.message_id,
                                                            sourceType: 'chatbot',
                                                            sourceName: mediaItems.length > 1
                                                                ? `AI Chatbot media carousel (${mediaItems.length} cards)`
                                                                : `AI Chatbot media card: ${mediaItems[0].title}`,
                                                            messageKind: mediaItems.length > 1
                                                                ? `media carousel (${mediaItems.length} cards)`
                                                                : 'media card'
                                                        });
                                                    }
                                                } catch (mediaError) {
                                                    logWarn('Chatbot text sent but media attachment failed', {
                                                        pageId,
                                                        senderId,
                                                        documentIds: generatedMediaDocumentIds,
                                                        error: (mediaError as Error).message
                                                    });
                                                }
                                            }

                                            await saveChatbotContactState(supabase, {
                                                pageId: page.id,
                                                contactId: contact.id,
                                                existingState: chatbotState,
                                                collectedDetails,
                                                missingDetails,
                                                inboundAt: interactionAt,
                                                botRepliedAt: replyMessages.length > 0 || sentMedia ? new Date().toISOString() : undefined,
                                                stopReason: generatedStopReason
                                            });

                                            const chatbotPipelineStage = pipelineStageForChatbotProgress({
                                                stopReason: generatedStopReason,
                                                detailsComplete,
                                                collectedDetails
                                            });
                                            try {
                                                await updateContactPipelineStage(supabase, {
                                                    pageId: page.id,
                                                    contactId: contact.id,
                                                    stage: chatbotPipelineStage,
                                                    source: 'chatbot'
                                                });
                                            } catch (pipelineError) {
                                                logWarn('Chatbot state saved but pipeline stage update failed', {
                                                    pageId,
                                                    senderId,
                                                    contactId: contact.id,
                                                    error: (pipelineError as Error).message
                                                });
                                            }

                                            if (
                                                !generatedStopReason &&
                                                !isPipelineClosedForAutomation(chatbotPipelineStage) &&
                                                (replyMessages.length > 0 || sentMedia)
                                            ) {
                                                try {
                                                    const scheduledFollowUps = await scheduleChatbotFollowUps({
                                                        supabase,
                                                        pageId: page.id,
                                                        contact: {
                                                            id: contact.id,
                                                            page_id: page.id,
                                                            psid: senderId,
                                                            name: (contact as { name?: string | null }).name || null,
                                                            best_contact_hour: (contact as { best_contact_hour?: number | null }).best_contact_hour,
                                                            last_interaction_at: interactionAt,
                                                            pipeline_stage: chatbotPipelineStage
                                                        },
                                                        config: chatbotConfig,
                                                        anchorInboundAt: interactionAt,
                                                        now: interactionTime
                                                    });
                                                    if (scheduledFollowUps > 0) {
                                                        logInfo('Scheduled chatbot follow-ups', {
                                                            pageId,
                                                            senderId,
                                                            contactId: contact.id,
                                                            count: scheduledFollowUps
                                                        });
                                                    }
                                                } catch (followUpScheduleError) {
                                                    logWarn('Chatbot reply sent but follow-up scheduling failed', {
                                                        pageId,
                                                        senderId,
                                                        contactId: contact.id,
                                                        error: (followUpScheduleError as Error).message
                                                    });
                                                }
                                            }

                                            await finishChatbotReply(supabase, inboundMessageId, {
                                                status: 'sent',
                                                outboundMessageId: lastOutboundMessageId
                                            }).catch((finishError) => {
                                                logWarn('Chatbot reply sent but status update failed', {
                                                    pageId,
                                                    inboundMessageId,
                                                    error: (finishError as Error).message
                                                });
                                            });

                                            logInfo('Chatbot reply sent', {
                                                pageId,
                                                senderId,
                                                inboundMessageId,
                                                model: chatbotConfig.model,
                                                messageParts: replyMessages.length,
                                                stopReason: generatedStopReason,
                                                missingDetails
                                            });
                                        } catch (chatbotError) {
                                            await finishChatbotReply(supabase, inboundMessageId, {
                                                status: 'failed',
                                                error: (chatbotError as Error).message
                                            }).catch(() => undefined);

                                            logWarn('Failed to send chatbot reply', {
                                                pageId,
                                                senderId,
                                                inboundMessageId,
                                                error: (chatbotError as Error).message
                                            });
                                        }
                                    }
                                }
                            }

                            const hourOfDay = getPhilippinesHour(interactionTime);
                            const dayOfWeek = getPhilippinesDayOfWeek(interactionTime);

                            const { error: insertInteractionError } = await supabase
                                .from('contact_interactions')
                                .insert({
                                    contact_id: contact.id,
                                    page_id: page.id,
                                    interaction_at: interactionAt,
                                    hour_of_day: hourOfDay,
                                    day_of_week: dayOfWeek,
                                    is_from_contact: true
                                });

                            if (insertInteractionError) {
                                logWarn('Failed to save contact interaction', {
                                    pageId,
                                    senderId,
                                    contactId: contact.id,
                                    error: insertInteractionError.message
                                });
                            }

                            // Automatically recalculate best time to contact
                            const { data: interactions, error: interactionsError } = await supabase
                                .from('contact_interactions')
                                .select('hour_of_day')
                                .eq('contact_id', contact.id)
                                .eq('is_from_contact', true);

                            if (interactionsError) {
                                logWarn('Failed to fetch interaction history for best-time calculation', {
                                    pageId,
                                    senderId,
                                    contactId: contact.id,
                                    error: interactionsError.message
                                });
                                continue;
                            }

                            const interactionCount = interactions?.length || 0;
                            const hourDistribution: Record<number, number> = {};

                            for (const interaction of interactions || []) {
                                const hour = interaction.hour_of_day;
                                hourDistribution[hour] = (hourDistribution[hour] || 0) + 1;
                            }

                            // Find most common hour
                            let bestHour: number | null = null;
                            let maxCount = 0;
                            for (const [hour, count] of Object.entries(hourDistribution)) {
                                if (count > maxCount) {
                                    maxCount = count;
                                    bestHour = parseInt(hour);
                                }
                            }

                            // Determine confidence level
                            let confidence: string;
                            if (interactionCount >= 5) {
                                confidence = 'high';
                            } else if (interactionCount >= 2) {
                                confidence = 'medium';
                            } else if (interactionCount === 1) {
                                confidence = 'inferred';
                                // For single interaction, use neighbor inference (simplified - use this hour)
                                bestHour = hourOfDay;
                            } else {
                                confidence = 'none';
                            }

                            // Update contact with best time data
                            const { error: bestTimeUpdateError } = await supabase
                                .from('contacts')
                                .update({
                                    best_contact_hour: bestHour,
                                    best_contact_confidence: confidence
                                })
                                .eq('id', contact.id);

                            if (bestTimeUpdateError) {
                                logWarn('Failed to update best-time fields for contact', {
                                    pageId,
                                    senderId,
                                    contactId: contact.id,
                                    error: bestTimeUpdateError.message
                                });
                            }
                        }
                        } catch (eventError) {
                            skippedEvents += 1;
                            hadCriticalFailure = true;
                            logError('Unhandled exception while processing inbound webhook event', {
                                pageId,
                                senderId: event?.sender?.id ?? null,
                                recipientId: event?.recipient?.id ?? null,
                                eventKeys: Object.keys(event || {}),
                                error: (eventError as Error).message
                            });
                        }
                    }
                }
            }
        } else {
            logWarn('Ignoring webhook payload with unsupported object type', { object: data.object });
        }

        logInfo('Webhook processing summary', {
            processedEntries,
            processedEvents,
            processedContacts,
            skippedEvents,
            hadCriticalFailure
        });

        if (hadCriticalFailure) {
            return NextResponse.json(
                {
                    error: 'Webhook processing partially failed',
                    message: 'One or more contact upserts failed. Returning 500 so Facebook can retry delivery.'
                },
                { status: 500 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        logError('Unhandled webhook error', {
            error: (error as Error).message
        });
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
    }
}
