'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import {
    BarChart3,
    Bot,
    BookOpen,
    ChevronLeft,
    ChevronRight,
    Clock3,
    Database,
    FileText,
    ExternalLink,
    FolderOpen,
    Image as ImageIcon,
    ListChecks,
    MessageSquare,
    Power,
    PowerOff,
    RefreshCw,
    RotateCcw,
    Save,
    Send,
    ShieldCheck,
    TrendingUp,
    Trash2,
    Upload,
    Users,
    Video
} from 'lucide-react';
import { getSupabaseClient } from '@/lib/supabase';

type PageSummary = {
    id: string;
    name: string;
};

type ChatbotConfig = {
    page_id: string;
    enabled: boolean;
    trial_mode_enabled: boolean;
    trial_contact_id: string | null;
    instructions: string;
    fallback_reply: string;
    model: string;
    rag_enabled: boolean;
    follow_up_prompt: string;
    details_to_collect: string[];
    details_completion_percent: number;
    bot_dos: string;
    bot_donts: string;
    follow_up_enabled: boolean;
    follow_up_quick_delays_minutes: number[];
    follow_up_best_time_days: number[];
    follow_up_messages: string[];
    follow_up_ai_instructions: string;
    follow_up_utility_template_name: string;
    follow_up_utility_template_language: string;
    follow_up_utility_text: string;
    follow_up_media_asset_id: string | null;
    split_messages: boolean;
    max_message_parts: number;
    stop_when_details_collected: boolean;
    stop_on_opt_out: boolean;
    stop_on_refusal: boolean;
    stop_on_qualified: boolean;
    stop_on_not_qualified: boolean;
    stop_on_converted: boolean;
    stop_on_order_created: boolean;
};

type KnowledgeDocument = {
    id: string;
    title: string;
    source_type: 'manual' | 'file';
    original_filename: string | null;
    char_count: number;
    chunk_count: number;
    status: 'processing' | 'ready' | 'failed';
    error_message: string | null;
    created_at: string;
};

type TestSource = {
    document_id: string;
    title: string;
    similarity: number;
};

type MediaAsset = {
    id: string;
    knowledge_document_id: string | null;
    title: string;
    usage_notes: string;
    media_type: 'image' | 'video';
    mime_type: string;
    original_filename: string;
    source_folder: string;
    source_relative_path: string;
    file_size: number;
    status: 'processing' | 'ready' | 'failed';
    error_message: string | null;
    auto_send: boolean;
    preview_url: string | null;
    created_at: string;
};

type PendingMediaUpload = {
    id: string;
    file: File;
    mimeType: string;
    title: string;
    sourceRelativePath: string;
    sourceFolder: string;
    status: 'queued' | 'uploading' | 'analyzing' | 'failed';
    error?: string;
};

type TestMedia = Pick<MediaAsset, 'id' | 'title' | 'media_type'> & {
    usage_notes?: string;
    preview_url?: string | null;
    target_url?: string | null;
};

type DriveFolder = {
    id: string;
    knowledge_document_id: string | null;
    name: string;
    folder_url: string;
    usage_notes: string;
    button_text: string;
    auto_send: boolean;
    file_count: number;
    last_synced_at: string | null;
    sync_status: 'idle' | 'syncing' | 'ready' | 'failed';
    sync_error: string | null;
    created_at: string;
};

type DriveFile = {
    id: string;
    folder_id: string;
    name: string;
    relative_path: string;
    media_type: 'image' | 'video';
    mime_type: string;
    size_bytes: number | null;
    web_view_url: string;
    thumbnail_url: string | null;
    auto_send: boolean;
};

type DriveSyncStatus = {
    configured: boolean;
    mode?: 'public_link' | 'service_account';
    service_account_email: string | null;
    message?: string;
};

type TestFolder = Pick<DriveFolder, 'id' | 'name' | 'folder_url' | 'button_text'>;

type TestTokenUsage = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    context_length: number | null;
    remaining_tokens: number | null;
    model: string | null;
};

type TestChatMessage = {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    label?: string;
    sources?: TestSource[];
    media?: TestMedia | null;
    mediaItems?: TestMedia[];
    folder?: TestFolder | null;
};

type LiveTrialContact = {
    id: string;
    name: string | null;
    psid: string | null;
    pipeline_stage?: string | null;
    last_interaction_at?: string | null;
    last_inbound_at?: string | null;
};

type LiveTrialStatus = {
    enabled: boolean;
    chatbot_enabled: boolean;
    trial_mode_enabled: boolean;
    contact: LiveTrialContact | null;
    state: {
        status: 'active' | 'stopped';
        collected_details: Record<string, string>;
        missing_details: string[];
        stop_reason: string | null;
        window_expires_at: string;
        last_bot_reply_at: string | null;
    } | null;
    pending_follow_ups: number;
};

type ChatbotAnalytics = {
    from: string;
    to: string;
    generated_at: string;
    contacts: {
        total: number;
        today: number;
        new_in_range: number;
        active_in_range: number;
        within_7_day_window: number;
    };
    conversations: {
        conversations: number;
        contacts_with_details: number;
        details_collected: number;
        details_missing: number;
        average_details_per_contact: number;
        completed_or_qualified: number;
        response_eligible: number;
        latest_inbound_replied: number;
    };
    current_states: { active: number; stopped: number; total: number };
    stop_reasons: Record<string, number>;
    reply_events: { claimed: number; sent: number; failed: number; contacts_replied: number };
    outbound: { total: number; conversation_replies: number; media_attachments: number };
    follow_ups: {
        scheduled: number;
        pending_now: number;
        sent: number;
        quick_sent: number;
        human_agent_sent: number;
        failed: number;
        cancelled: number;
        with_media: number;
        contacted: number;
        responded: number;
    };
    pipeline: Record<string, number>;
    knowledge: { documents: number; ready_documents: number; ready_chunks: number; failed_documents: number };
    media: { assets: number; ready_assets: number; ready_images: number; ready_videos: number; failed_assets: number };
    configuration: {
        saved: boolean;
        enabled: boolean;
        follow_up_enabled: boolean;
        rag_enabled: boolean;
        details_requested: number;
        details_completion_percent: number;
        model: string | null;
    };
};

type ChatbotWorkspaceSection = 'overview' | 'behavior' | 'sales' | 'knowledge' | 'test';

const PIPELINE_LABELS: Record<string, string> = {
    new: 'New',
    engaged: 'Engaged',
    collecting_details: 'Collecting details',
    qualified: 'Qualified',
    order_created: 'Order created',
    converted: 'Converted',
    not_qualified: 'Not qualified',
    opted_out: 'Opted out'
};

const STOP_REASON_LABELS: Record<string, string> = {
    details_collected: 'Details collected',
    qualified: 'Qualified',
    order_created: 'Order created',
    converted: 'Converted',
    not_qualified: 'Not qualified',
    opt_out: 'Opted out',
    refusal: 'Refused',
    window_expired: '7-day window expired',
    manual: 'Stopped manually'
};

function percentage(numerator: number, denominator: number) {
    if (!denominator) return '0%';
    return `${Math.round((numerator / denominator) * 100)}%`;
}

function formatMetric(value: number) {
    return Number(value || 0).toLocaleString();
}

async function readJsonResponse(response: Response): Promise<Record<string, any>> {
    const raw = await response.text();
    if (!raw.trim()) {
        if (!response.ok) throw new Error(`Server request failed (${response.status})`);
        return {};
    }
    try {
        return JSON.parse(raw) as Record<string, any>;
    } catch {
        const isHtml = response.headers.get('content-type')?.includes('text/html') || /^\s*<!doctype html/i.test(raw);
        if (isHtml) {
            throw new Error(
                response.ok
                    ? 'The server returned a web page instead of API data. Refresh and try again.'
                    : `The server returned an error page (${response.status}). Refresh and try again.`
            );
        }
        throw new Error(`The server returned an invalid API response (${response.status}).`);
    }
}

function MessengerCarouselPreview({ mediaItems }: { mediaItems: TestMedia[] }) {
    const carouselRef = useRef<HTMLDivElement | null>(null);
    const slide = (direction: -1 | 1) => {
        carouselRef.current?.scrollBy({ left: direction * 196, behavior: 'smooth' });
    };

    return (
        <div className="mt-3 border-t border-gray-300 pt-3">
            <div className="mb-2 flex items-center justify-between gap-3">
                <p className="font-mono text-[9px] font-bold uppercase text-gray-500">
                    Messenger carousel · swipe or use arrows
                </p>
                <div className="hidden gap-1 sm:flex">
                    <button type="button" onClick={() => slide(-1)} className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-400 bg-white hover:border-black hover:bg-gray-100" aria-label="Previous carousel card">
                        <ChevronLeft className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => slide(1)} className="flex h-7 w-7 items-center justify-center rounded-full border border-gray-400 bg-white hover:border-black hover:bg-gray-100" aria-label="Next carousel card">
                        <ChevronRight className="h-4 w-4" />
                    </button>
                </div>
            </div>
            <div ref={carouselRef} className="flex w-[min(72vw,540px)] touch-pan-x snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain pb-2" aria-label="Messenger media carousel preview">
                {mediaItems.map((mediaItem) => (
                    <article key={mediaItem.id} className="min-w-[188px] max-w-[188px] snap-start overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm">
                        {mediaItem.media_type === 'image' && mediaItem.preview_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={mediaItem.preview_url} alt={mediaItem.title} className="h-32 w-full border-b border-gray-200 object-cover" />
                        ) : mediaItem.media_type === 'video' && mediaItem.preview_url ? (
                            <video src={mediaItem.preview_url} preload="metadata" muted playsInline className="h-32 w-full border-b border-gray-200 bg-black object-cover" />
                        ) : (
                            <div className="flex h-32 items-center justify-center border-b border-gray-200 bg-gradient-to-br from-blue-50 to-gray-200">
                                {mediaItem.media_type === 'image' ? <ImageIcon className="h-9 w-9 text-gray-500" /> : <Video className="h-9 w-9 text-gray-500" />}
                            </div>
                        )}
                        <div className="p-3">
                            <p className="line-clamp-2 min-h-8 text-xs font-bold leading-4">{mediaItem.title}</p>
                            <p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-4 text-gray-500">
                                {mediaItem.usage_notes || `${mediaItem.media_type === 'image' ? 'Image' : 'Video'} sample`}
                            </p>
                            {mediaItem.preview_url ? (
                                <a href={mediaItem.target_url || mediaItem.preview_url} target="_blank" rel="noreferrer" className="mt-2 flex h-9 items-center justify-center border-t border-gray-200 text-[11px] font-bold text-blue-700 hover:bg-blue-50">
                                    {mediaItem.media_type === 'image' ? 'View image' : 'Watch video'}
                                </a>
                            ) : (
                                <div className="mt-2 flex h-9 items-center justify-center border-t border-gray-200 text-[11px] font-bold text-blue-700">
                                    {mediaItem.media_type === 'image' ? 'View image' : 'Watch video'}
                                </div>
                            )}
                        </div>
                    </article>
                ))}
            </div>
            <p className="mt-1 font-mono text-[9px] text-gray-400">{mediaItems.length} cards · actual Messenger layout may vary slightly by device</p>
        </div>
    );
}

export default function ChatbotPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<PageSummary[]>([]);
    const [selectedPageId, setSelectedPageId] = useState('');
    const [config, setConfig] = useState<ChatbotConfig | null>(null);
    const [providerConfigured, setProviderConfigured] = useState(false);
    const [loading, setLoading] = useState(false);
    const [analytics, setAnalytics] = useState<ChatbotAnalytics | null>(null);
    const [analyticsDays, setAnalyticsDays] = useState(7);
    const [analyticsLoading, setAnalyticsLoading] = useState(false);
    const [analyticsError, setAnalyticsError] = useState('');
    const [activeSection, setActiveSection] = useState<ChatbotWorkspaceSection>('overview');
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');
    const [testMessage, setTestMessage] = useState('');
    const [testContactName, setTestContactName] = useState('Test Customer');
    const [testConversation, setTestConversation] = useState<TestChatMessage[]>([]);
    const [testCollectedDetails, setTestCollectedDetails] = useState<Record<string, string>>({});
    const [testTokenUsage, setTestTokenUsage] = useState<TestTokenUsage | null>(null);
    const [testFollowUpType, setTestFollowUpType] = useState<'quick' | 'human_agent'>('quick');
    const [testFollowUpCount, setTestFollowUpCount] = useState(0);
    const [trialContacts, setTrialContacts] = useState<LiveTrialContact[]>([]);
    const [trialContactSearch, setTrialContactSearch] = useState('');
    const [trialContactId, setTrialContactId] = useState('');
    const [liveTrialStatus, setLiveTrialStatus] = useState<LiveTrialStatus | null>(null);
    const [liveTrialLoading, setLiveTrialLoading] = useState(false);
    const testChatEndRef = useRef<HTMLDivElement | null>(null);
    const [knowledgeDocuments, setKnowledgeDocuments] = useState<KnowledgeDocument[]>([]);
    const [knowledgeTitle, setKnowledgeTitle] = useState('');
    const [knowledgeContent, setKnowledgeContent] = useState('');
    const [knowledgeFilename, setKnowledgeFilename] = useState<string | null>(null);
    const [indexingKnowledge, setIndexingKnowledge] = useState(false);
    const [deletingDocumentId, setDeletingDocumentId] = useState('');
    const [mediaAssets, setMediaAssets] = useState<MediaAsset[]>([]);
    const [mediaUsage, setMediaUsage] = useState('');
    const [pendingMediaUploads, setPendingMediaUploads] = useState<PendingMediaUpload[]>([]);
    const folderMediaInputRef = useRef<HTMLInputElement | null>(null);
    const [uploadingMedia, setUploadingMedia] = useState(false);
    const [deletingMediaId, setDeletingMediaId] = useState('');
    const [driveFolders, setDriveFolders] = useState<DriveFolder[]>([]);
    const [driveFiles, setDriveFiles] = useState<DriveFile[]>([]);
    const [driveSyncStatus, setDriveSyncStatus] = useState<DriveSyncStatus | null>(null);
    const [driveFolderName, setDriveFolderName] = useState('');
    const [driveFolderUrl, setDriveFolderUrl] = useState('');
    const [driveFolderUsage, setDriveFolderUsage] = useState('');
    const [driveFolderButtonText, setDriveFolderButtonText] = useState('View media samples');
    const [addingDriveFolder, setAddingDriveFolder] = useState(false);
    const [syncingDriveFolderId, setSyncingDriveFolderId] = useState('');
    const [deletingDriveFolderId, setDeletingDriveFolderId] = useState('');

    useEffect(() => {
        const input = folderMediaInputRef.current;
        if (!input) return;
        input.setAttribute('webkitdirectory', '');
        input.setAttribute('directory', '');
    }, []);

    useEffect(() => {
        if (!session) return;
        fetch('/api/pages')
            .then(async (response) => {
                const body = await readJsonResponse(response);
                if (!response.ok) throw new Error(body.message || body.error || 'Failed to load pages');
                return body;
            })
            .then((body) => {
                const nextPages = body.pages || [];
                setPages(nextPages);
                setSelectedPageId((current) => current || nextPages[0]?.id || '');
            })
            .catch((loadError) => setError(loadError.message));
    }, [session]);

    const loadConfig = useCallback(async () => {
        if (!selectedPageId) return;
        setLoading(true);
        setError('');
        setStatus('');
        setTestConversation([]);
        setTestCollectedDetails({});
        setTestTokenUsage(null);
        setTestFollowUpCount(0);
        setTestMessage('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot');
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to load chatbot settings');
            setConfig(body.config);
            setTrialContactId(body.config?.trial_contact_id || '');
            setProviderConfigured(Boolean(body.provider?.configured));
        } catch (loadError) {
            setError((loadError as Error).message);
        } finally {
            setLoading(false);
        }
    }, [selectedPageId]);

    useEffect(() => {
        loadConfig();
    }, [loadConfig]);

    const loadLiveTrialStatus = useCallback(async () => {
        if (!selectedPageId) return;
        try {
            const response = await fetch(`/api/pages/${selectedPageId}/chatbot/trial`);
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to load live trial status');
            const nextStatus = body.trial as LiveTrialStatus;
            setLiveTrialStatus(nextStatus);
            if (nextStatus?.contact?.id) {
                setTrialContactId(nextStatus.contact.id);
                setTrialContacts((current) => current.some((contact) => contact.id === nextStatus.contact?.id)
                    ? current
                    : [nextStatus.contact as LiveTrialContact, ...current]);
            }
        } catch (loadError) {
            setError((loadError as Error).message);
        }
    }, [selectedPageId]);

    useEffect(() => {
        setTrialContacts([]);
        setTrialContactSearch('');
        setLiveTrialStatus(null);
        void loadLiveTrialStatus();
    }, [loadLiveTrialStatus]);

    useEffect(() => {
        if (!selectedPageId || activeSection !== 'test') return;
        const timeoutId = window.setTimeout(async () => {
            try {
                const search = trialContactSearch.trim();
                const response = await fetch(
                    `/api/pages/${selectedPageId}/contacts?page=1&pageSize=25&sendable=true&includeTags=false&includeCount=false${search ? `&search=${encodeURIComponent(search)}` : ''}`
                );
                const body = await readJsonResponse(response);
                if (!response.ok) throw new Error(body.message || body.error || 'Failed to load Messenger contacts');
                const contacts = (Array.isArray(body.data) ? body.data : Array.isArray(body.items) ? body.items : []) as LiveTrialContact[];
                setTrialContacts((current) => {
                    const selected = current.find((contact) => contact.id === trialContactId);
                    return selected && !contacts.some((contact) => contact.id === selected.id)
                        ? [selected, ...contacts]
                        : contacts;
                });
            } catch (loadError) {
                setError((loadError as Error).message);
            }
        }, 250);
        return () => window.clearTimeout(timeoutId);
    }, [activeSection, selectedPageId, trialContactId, trialContactSearch]);

    const loadAnalytics = useCallback(async () => {
        if (!selectedPageId) return;
        setAnalyticsLoading(true);
        setAnalyticsError('');
        try {
            const response = await fetch(`/api/pages/${selectedPageId}/chatbot/analytics?days=${analyticsDays}`);
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to load chatbot analytics');
            setAnalytics(body.analytics);
        } catch (loadError) {
            setAnalyticsError((loadError as Error).message);
        } finally {
            setAnalyticsLoading(false);
        }
    }, [analyticsDays, selectedPageId]);

    useEffect(() => {
        setAnalytics(null);
        void loadAnalytics();
    }, [loadAnalytics]);

    useEffect(() => {
        if (testConversation.length > 0 || testing) {
            testChatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, [testConversation, testing]);

    const loadKnowledge = useCallback(async () => {
        if (!selectedPageId) return;
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/knowledge');
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to load chatbot knowledge');
            setKnowledgeDocuments(body.documents || []);
        } catch (loadError) {
            setError((loadError as Error).message);
        }
    }, [selectedPageId]);

    const loadMedia = useCallback(async () => {
        if (!selectedPageId) return;
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/media');
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to load chatbot media');
            setMediaAssets(body.assets || []);
        } catch (loadError) {
            setError((loadError as Error).message);
        }
    }, [selectedPageId]);

    const loadDriveFolders = useCallback(async () => {
        if (!selectedPageId) return;
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/folders');
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to load Drive folders');
            setDriveFolders(body.folders || []);
            setDriveFiles(body.files || []);
            setDriveSyncStatus(body.drive_sync || null);
        } catch (loadError) {
            setError((loadError as Error).message);
        }
    }, [selectedPageId]);

    useEffect(() => {
        setKnowledgeDocuments([]);
        setKnowledgeTitle('');
        setKnowledgeContent('');
        setKnowledgeFilename(null);
        setMediaAssets([]);
        setMediaUsage('');
        setPendingMediaUploads([]);
        setDriveFolders([]);
        setDriveFiles([]);
        setDriveSyncStatus(null);
        setDriveFolderName('');
        setDriveFolderUrl('');
        setDriveFolderUsage('');
        setDriveFolderButtonText('View media samples');
        loadKnowledge();
        loadMedia();
        loadDriveFolders();
    }, [loadDriveFolders, loadKnowledge, loadMedia]);

    const updateConfig = (changes: Partial<ChatbotConfig>) => {
        setConfig((current) => current ? { ...current, ...changes } : current);
        setStatus('');
    };

    const saveConfig = async () => {
        if (!config || !selectedPageId) return;
        setSaving(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to save chatbot settings');
            setConfig(body.config);
            setStatus('Chatbot settings saved.');
        } catch (saveError) {
            setError((saveError as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const configureLiveTrial = async (enabled: boolean) => {
        if (!selectedPageId || !trialContactId || liveTrialLoading) return;
        const selectedContact = trialContacts.find((contact) => contact.id === trialContactId) || liveTrialStatus?.contact;
        const contactLabel = selectedContact?.name || 'this contact';
        const confirmed = enabled
            ? window.confirm(`Enable the real Messenger chatbot only for ${contactLabel}? Their next message to this Page can receive a real AI reply.`)
            : window.confirm('Stop the live trial and disable the chatbot?');
        if (!confirmed) return;

        setLiveTrialLoading(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch(`/api/pages/${selectedPageId}/chatbot/trial`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'configure', enabled, contact_id: trialContactId })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to configure live trial');
            setConfig((current) => current ? {
                ...current,
                enabled: body.config?.enabled === true,
                trial_mode_enabled: body.config?.trial_mode_enabled === true,
                trial_contact_id: body.config?.trial_contact_id || trialContactId
            } : current);
            setStatus(body.message || (enabled ? 'Live Messenger trial enabled.' : 'Live Messenger trial stopped.'));
            await loadLiveTrialStatus();
        } catch (trialError) {
            setError((trialError as Error).message);
        } finally {
            setLiveTrialLoading(false);
        }
    };

    const resetLiveTrialContact = async () => {
        if (!selectedPageId || !trialContactId || liveTrialLoading) return;
        const selectedContact = trialContacts.find((contact) => contact.id === trialContactId) || liveTrialStatus?.contact;
        const contactLabel = selectedContact?.name || 'the selected contact';
        if (!window.confirm(`Reset ${contactLabel}'s collected details, stop state, pending chatbot follow-ups, and pipeline stage to Engaged? Messenger history will remain available to the AI.`)) return;

        setLiveTrialLoading(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch(`/api/pages/${selectedPageId}/chatbot/trial`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'reset', contact_id: trialContactId })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to reset live trial contact');
            setStatus(body.message || 'Live trial contact reset.');
            await Promise.all([loadLiveTrialStatus(), loadAnalytics()]);
        } catch (trialError) {
            setError((trialError as Error).message);
        } finally {
            setLiveTrialLoading(false);
        }
    };

    const testChatbot = async () => {
        const message = testMessage.trim();
        if (!selectedPageId || !message || testing) return;
        const history = testConversation.map(({ role, content }) => ({ role, content }));
        const userMessage: TestChatMessage = {
            id: `user-${Date.now()}`,
            role: 'user',
            content: message
        };
        setTesting(true);
        setError('');
        setStatus('');
        setTestMessage('');
        setTestConversation((current) => [...current, userMessage]);
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message,
                    contact_name: testContactName,
                    history,
                    collected_details: testCollectedDetails,
                    draft_config: config
                })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Chatbot test failed');
            const replies = (Array.isArray(body.messages) ? body.messages : [body.reply])
                .filter((reply: unknown): reply is string => typeof reply === 'string' && reply.trim().length > 0);
            const sources = Array.isArray(body.sources) ? body.sources : [];
            const assistantMessages: TestChatMessage[] = replies.map((reply: string, index: number) => ({
                id: `assistant-${Date.now()}-${index}`,
                role: 'assistant',
                content: reply,
                ...(index === replies.length - 1 ? {
                    sources,
                    media: body.media || null,
                    mediaItems: Array.isArray(body.media_items) ? body.media_items : body.media ? [body.media] : [],
                    folder: body.folder || null
                } : {})
            }));
            setTestConversation((current) => [...current, ...assistantMessages]);
            setTestCollectedDetails(body.collected_details || {});
            setTestTokenUsage(body.token_usage || null);
            if (body.retrieval_warning) setStatus('Reply generated, but knowledge retrieval was unavailable: ' + body.retrieval_warning);
        } catch (testError) {
            setError((testError as Error).message);
            setTestConversation((current) => current.filter((entry) => entry.id !== userMessage.id));
            setTestMessage(message);
        } finally {
            setTesting(false);
        }
    };

    const resetTestConversation = () => {
        setTestConversation([]);
        setTestCollectedDetails({});
        setTestTokenUsage(null);
        setTestFollowUpType('quick');
        setTestFollowUpCount(0);
        setTestMessage('');
        setError('');
        setStatus('');
    };

    const previewTestCarousel = () => {
        const uploadedMedia: TestMedia[] = mediaAssets
            .filter((asset) => asset.status === 'ready')
            .map((asset) => ({
                id: asset.id,
                title: asset.title,
                usage_notes: asset.usage_notes,
                media_type: asset.media_type,
                preview_url: asset.preview_url,
                target_url: `/api/chatbot-media/${asset.id}`
            }));
        const indexedDriveMedia: TestMedia[] = driveFiles
            .filter((file) => file.auto_send)
            .map((file) => ({
                id: file.id,
                title: file.name,
                usage_notes: `${file.media_type === 'image' ? 'Image' : 'Video'} sample from Google Drive`,
                media_type: file.media_type,
                preview_url: file.thumbnail_url,
                target_url: file.web_view_url
            }));
        const readyMedia = [...indexedDriveMedia, ...uploadedMedia].slice(0, 10);
        const sampleMedia: TestMedia[] = [
            { id: 'carousel-demo-1', title: 'Sample service result', usage_notes: 'A relevant image selected from the Page media library.', media_type: 'image' },
            { id: 'carousel-demo-2', title: 'Behind the scenes', usage_notes: 'A short video customers can open from Messenger.', media_type: 'video' },
            { id: 'carousel-demo-3', title: 'More customer samples', usage_notes: 'Another related media card with its own button.', media_type: 'image' }
        ];
        const mediaItems = readyMedia.length >= 2
            ? readyMedia
            : [...readyMedia, ...sampleMedia].slice(0, 3);
        setTestConversation((current) => [...current, {
            id: `carousel-preview-${Date.now()}`,
            role: 'assistant',
            content: readyMedia.length >= 2
                ? 'Here are a few samples you can browse.'
                : 'This is how multiple media cards will appear after you upload at least two relevant assets.',
            label: readyMedia.length >= 2 ? 'Messenger carousel preview' : 'UI demo · not sent',
            media: mediaItems[0],
            mediaItems
        }]);
    };

    const testFollowUp = async () => {
        if (!selectedPageId || testConversation.length === 0 || testing) return;
        setTesting(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'follow_up',
                    contact_name: testContactName,
                    follow_up_type: testFollowUpType,
                    sequence_number: testFollowUpCount + 1,
                    history: testConversation.map(({ role, content }) => ({ role, content })),
                    collected_details: testCollectedDetails,
                    draft_config: config
                })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Follow-up test failed');
            const sources = Array.isArray(body.sources) ? body.sources : [];
            setTestConversation((current) => [...current, {
                id: `follow-up-${Date.now()}`,
                role: 'assistant',
                content: body.reply,
                label: body.follow_up_label || 'Follow-up preview',
                sources,
                media: body.media || null,
                mediaItems: Array.isArray(body.media_items) ? body.media_items : body.media ? [body.media] : []
            }]);
            setTestTokenUsage(body.token_usage || null);
            setTestFollowUpCount((current) => current + 1);
            if (body.retrieval_warning) setStatus('Follow-up generated, but knowledge retrieval was unavailable: ' + body.retrieval_warning);
        } catch (followUpError) {
            setError((followUpError as Error).message);
        } finally {
            setTesting(false);
        }
    };

    const loadKnowledgeFile = async (file: File | undefined) => {
        if (!file) return;
        const extension = file.name.split('.').pop()?.toLowerCase();
        if (!extension || !['txt', 'md', 'csv', 'json'].includes(extension)) {
            setError('Use a .txt, .md, .csv, or .json knowledge file.');
            return;
        }
        if (file.size > 1_000_000) {
            setError('Knowledge files must be 1 MB or smaller.');
            return;
        }
        try {
            const content = await file.text();
            setKnowledgeContent(content.slice(0, 100_000));
            setKnowledgeTitle((current) => current || file.name.replace(/\.[^.]+$/, ''));
            setKnowledgeFilename(file.name);
            setError('');
        } catch {
            setError('Could not read that file.');
        }
    };

    const indexKnowledge = async () => {
        if (!selectedPageId || !knowledgeTitle.trim() || knowledgeContent.trim().length < 20) return;
        setIndexingKnowledge(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/knowledge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    title: knowledgeTitle,
                    content: knowledgeContent,
                    source_type: knowledgeFilename ? 'file' : 'manual',
                    original_filename: knowledgeFilename
                })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to index knowledge');
            setKnowledgeTitle('');
            setKnowledgeContent('');
            setKnowledgeFilename(null);
            setStatus(`Knowledge indexed into ${body.document.chunk_count} searchable chunks.`);
            await loadKnowledge();
        } catch (indexError) {
            setError((indexError as Error).message);
            await loadKnowledge();
        } finally {
            setIndexingKnowledge(false);
        }
    };

    const deleteKnowledge = async (documentId: string) => {
        if (!selectedPageId) return;
        setDeletingDocumentId(documentId);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/knowledge', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ document_id: documentId })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to delete knowledge');
            setKnowledgeDocuments((current) => current.filter((document) => document.id !== documentId));
            setMediaAssets((current) => current.filter((asset) => asset.knowledge_document_id !== documentId));
            setDriveFolders((current) => current.filter((folder) => folder.knowledge_document_id !== documentId));
            setStatus('Knowledge document deleted.');
        } catch (deleteError) {
            setError((deleteError as Error).message);
        } finally {
            setDeletingDocumentId('');
        }
    };

    const addMediaFiles = (files: File[]) => {
        const mimeByExtension: Record<string, string> = {
            jpg: 'image/jpeg',
            jpeg: 'image/jpeg',
            png: 'image/png',
            webp: 'image/webp',
            gif: 'image/gif',
            mp4: 'video/mp4',
            mov: 'video/quicktime',
            webm: 'video/webm'
        };
        const supportedTypes = new Set(Object.values(mimeByExtension));
        const existing = new Set(pendingMediaUploads.map((item) =>
            `${item.sourceRelativePath}:${item.file.size}:${item.file.lastModified}`
        ));
        const rejected: string[] = [];
        const accepted: PendingMediaUpload[] = [];
        const availableSlots = Math.max(0, 100 - pendingMediaUploads.length);

        for (const file of files) {
            if (accepted.length >= availableSlots) {
                rejected.push(`${file.name} (100-file batch limit)`);
                continue;
            }
            const extension = file.name.split('.').pop()?.toLowerCase() || '';
            const providedMimeType = file.type.toLowerCase();
            const mimeType = supportedTypes.has(providedMimeType)
                ? providedMimeType
                : mimeByExtension[extension] || providedMimeType;
            const sourceRelativePath = file.webkitRelativePath || file.name;
            const sourceFolder = sourceRelativePath.includes('/') ? sourceRelativePath.split('/')[0] : '';
            const signature = `${sourceRelativePath}:${file.size}:${file.lastModified}`;
            if (!supportedTypes.has(mimeType)) {
                rejected.push(`${file.name} (unsupported format)`);
                continue;
            }
            if (file.size <= 0 || file.size > 50 * 1024 * 1024) {
                rejected.push(`${file.name} (must be 50 MB or smaller)`);
                continue;
            }
            if (existing.has(signature)) continue;
            existing.add(signature);
            accepted.push({
                id: `${Date.now()}-${accepted.length}-${file.lastModified}`,
                file,
                mimeType,
                sourceRelativePath,
                sourceFolder,
                title: file.name
                    .replace(/\.[^.]+$/, '')
                    .replace(/[_-]+/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 160),
                status: 'queued'
            });
        }

        if (accepted.length > 0) {
            setPendingMediaUploads((current) => [...current, ...accepted]);
        }
        setError(rejected.length > 0
            ? `Skipped ${rejected.length} file${rejected.length === 1 ? '' : 's'}: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? '...' : ''}`
            : '');
    };

    const uploadMedia = async () => {
        if (!selectedPageId || pendingMediaUploads.length === 0) return;
        if (pendingMediaUploads.some((item) => !item.title.trim())) {
            setError('Every selected media file needs a title.');
            return;
        }
        setUploadingMedia(true);
        setError('');
        setStatus('');
        const updatePending = (id: string, changes: Partial<PendingMediaUpload>) => {
            setPendingMediaUploads((current) => current.map((item) =>
                item.id === id ? { ...item, ...changes } : item
            ));
        };
        const uploadOne = async (item: PendingMediaUpload) => {
            try {
                updatePending(item.id, { status: 'uploading', error: undefined });
                const prepareResponse = await fetch('/api/pages/' + selectedPageId + '/chatbot/media', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        file_name: item.file.name,
                        file_size: item.file.size,
                        mime_type: item.mimeType,
                        source_relative_path: item.sourceRelativePath
                    })
                });
                const prepared = await readJsonResponse(prepareResponse);
                if (!prepareResponse.ok) throw new Error(prepared.message || prepared.error || 'Failed to prepare media upload');

                const { error: uploadError } = await getSupabaseClient().storage
                    .from(prepared.bucket)
                    .uploadToSignedUrl(prepared.path, prepared.token, item.file, {
                        contentType: item.mimeType
                    });
                if (uploadError) throw uploadError;

                updatePending(item.id, { status: 'analyzing' });
                const finalizeResponse = await fetch('/api/pages/' + selectedPageId + '/chatbot/media', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        path: prepared.path,
                        title: item.title.trim(),
                        usage_notes: mediaUsage,
                        file_name: item.file.name,
                        file_size: item.file.size,
                        mime_type: item.mimeType,
                        source_relative_path: item.sourceRelativePath,
                        auto_send: true
                    })
                });
                const finalized = await readJsonResponse(finalizeResponse);
                if (!finalizeResponse.ok) throw new Error(finalized.message || finalized.error || 'Failed to analyze media');
                return {
                    id: item.id,
                    ok: true as const,
                    mediaType: prepared.media_type as 'image' | 'video',
                    warning: typeof finalized.warning === 'string' ? finalized.warning : ''
                };
            } catch (uploadError) {
                const message = (uploadError as Error).message;
                updatePending(item.id, { status: 'failed', error: message });
                return { id: item.id, ok: false as const, error: message };
            }
        };

        try {
            const results: Awaited<ReturnType<typeof uploadOne>>[] = [];
            for (let index = 0; index < pendingMediaUploads.length; index += 2) {
                const batch = pendingMediaUploads.slice(index, index + 2);
                setStatus(`Processing ${index + 1}-${Math.min(index + batch.length, pendingMediaUploads.length)} of ${pendingMediaUploads.length}...`);
                results.push(...await Promise.all(batch.map(uploadOne)));
            }

            const failedIds = new Set(results.filter((result) => !result.ok).map((result) => result.id));
            const warningCount = results.filter((result) => result.ok && result.warning).length;
            const succeeded = results.length - failedIds.size;
            setPendingMediaUploads((current) => current.filter((item) => failedIds.has(item.id)));
            if (failedIds.size === 0) setMediaUsage('');
            if (succeeded > 0) {
                setStatus(`${succeeded} media file${succeeded === 1 ? '' : 's'} uploaded and added to this Page's RAG knowledge.${warningCount > 0 ? ` ${warningCount} used folder/file names because visual analysis was unavailable.` : ''}`);
            }
            if (failedIds.size > 0) {
                setError(`${failedIds.size} media file${failedIds.size === 1 ? '' : 's'} failed. Review the messages below and retry.`);
            }
            await Promise.all([loadMedia(), loadKnowledge()]);
        } finally {
            setUploadingMedia(false);
        }
    };

    const deleteMedia = async (assetId: string) => {
        if (!selectedPageId) return;
        setDeletingMediaId(assetId);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/media', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ asset_id: assetId })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to delete media');
            const deleted = mediaAssets.find((asset) => asset.id === assetId);
            setMediaAssets((current) => current.filter((asset) => asset.id !== assetId));
            if (deleted?.knowledge_document_id) {
                setKnowledgeDocuments((current) => current.filter((document) => document.id !== deleted.knowledge_document_id));
            }
            setStatus('Chatbot media deleted.');
        } catch (deleteError) {
            setError((deleteError as Error).message);
        } finally {
            setDeletingMediaId('');
        }
    };

    const addDriveFolder = async () => {
        if (!selectedPageId || !driveFolderName.trim() || !driveFolderUrl.trim()) return;
        setAddingDriveFolder(true);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: driveFolderName,
                    folder_url: driveFolderUrl,
                    usage_notes: driveFolderUsage,
                    button_text: driveFolderButtonText,
                    auto_send: true
                })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to add Drive folder');
            setDriveFolderName('');
            setDriveFolderUrl('');
            setDriveFolderUsage('');
            setDriveFolderButtonText('View media samples');
            setStatus(body.sync_warning
                ? `Drive folder saved, but file sync needs attention: ${body.sync_warning}`
                : `Drive folder "${body.folder.name}" synced. ${body.indexed || 0} individual media files are ready for AI selection.`);
            await Promise.all([loadDriveFolders(), loadKnowledge()]);
        } catch (folderError) {
            setError((folderError as Error).message);
        } finally {
            setAddingDriveFolder(false);
        }
    };

    const syncDriveFolder = async (folderId: string) => {
        if (!selectedPageId) return;
        setSyncingDriveFolderId(folderId);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/folders', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'sync', folder_id: folderId })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to sync Drive folder');
            setStatus(`Drive sync complete. ${body.indexed || 0} individual media files are ready for AI selection.`);
            await Promise.all([loadDriveFolders(), loadKnowledge()]);
        } catch (syncError) {
            setError((syncError as Error).message);
            await loadDriveFolders();
        } finally {
            setSyncingDriveFolderId('');
        }
    };

    const deleteDriveFolder = async (folderId: string) => {
        if (!selectedPageId) return;
        setDeletingDriveFolderId(folderId);
        setError('');
        setStatus('');
        try {
            const response = await fetch('/api/pages/' + selectedPageId + '/chatbot/folders', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ folder_id: folderId })
            });
            const body = await readJsonResponse(response);
            if (!response.ok) throw new Error(body.message || body.error || 'Failed to delete Drive folder');
            const deleted = driveFolders.find((folder) => folder.id === folderId);
            setDriveFolders((current) => current.filter((folder) => folder.id !== folderId));
            setDriveFiles((current) => current.filter((file) => file.folder_id !== folderId));
            if (deleted?.knowledge_document_id) {
                setKnowledgeDocuments((current) => current.filter((document) => document.id !== deleted.knowledge_document_id));
            }
            setStatus('Drive folder removed from the chatbot.');
        } catch (folderError) {
            setError((folderError as Error).message);
        } finally {
            setDeletingDriveFolderId('');
        }
    };

    const selectedPageName = pages.find((page) => page.id === selectedPageId)?.name || 'this Page';
    const selectedTrialContact = trialContacts.find((contact) => contact.id === trialContactId)
        || (liveTrialStatus?.contact?.id === trialContactId ? liveTrialStatus.contact : null);
    const latestTestAssistantMessage = [...testConversation].reverse().find((message) => message.role === 'assistant');
    const testReply = latestTestAssistantMessage?.content || '';
    const testSources = latestTestAssistantMessage?.sources || [];
    const testMedia = latestTestAssistantMessage?.media || null;
    const pipelineMaximum = analytics
        ? Math.max(1, ...Object.values(analytics.pipeline).map((value) => Number(value) || 0))
        : 1;

    return (
        <div className="max-w-6xl mx-auto pb-20">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 border-2 border-black bg-white flex items-center justify-center shadow-[3px_3px_0_#000]">
                        <Bot className="w-6 h-6" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-black">AI Chatbot</h1>
                        <p className="mt-1 text-sm text-gray-600">
                            Train, test, and control your Page&apos;s Messenger assistant.
                        </p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={saveConfig}
                    disabled={!config || saving}
                    className="btn-wireframe min-w-40 bg-black text-white hover:bg-gray-800 flex items-center justify-center gap-2 px-5 py-3 disabled:opacity-50"
                >
                    <Save className="w-4 h-4" />
                    {saving ? 'Saving...' : 'Save settings'}
                </button>
            </div>

            <div className="border-2 border-black p-5 mb-4 bg-white">
                <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Facebook Page</label>
                <select
                    value={selectedPageId}
                    onChange={(event) => setSelectedPageId(event.target.value)}
                    className="input-wireframe w-full text-sm"
                >
                    {pages.map((page) => <option key={page.id} value={page.id}>{page.name}</option>)}
                </select>
            </div>

            {error && (
                <div className="border-2 border-red-600 bg-red-50 text-red-800 p-3 mb-4 text-sm">
                    {error}
                </div>
            )}
            {status && (
                <div className="border-2 border-green-700 bg-green-50 text-green-800 p-3 mb-4 text-sm">
                    {status}
                </div>
            )}

            {loading || !config ? (
                <div className="border-2 border-black p-8 text-center font-mono text-sm text-gray-500">
                    {selectedPageId ? 'Loading chatbot settings...' : 'Connect a Facebook Page to configure the chatbot.'}
                </div>
            ) : (
                <>
                    <nav className="sticky top-0 z-20 mb-4 grid grid-cols-2 gap-1 border-2 border-black bg-white p-2 shadow-[3px_3px_0_rgba(0,0,0,0.18)] sm:grid-cols-5" aria-label="Chatbot workspace sections">
                        {([
                            ['overview', 'Overview', BarChart3],
                            ['behavior', 'Behavior', Bot],
                            ['sales', 'Sales & follow-ups', ListChecks],
                            ['knowledge', 'Knowledge & media', BookOpen],
                            ['test', 'Test chatbot', MessageSquare]
                        ] as const).map(([value, label, Icon]) => (
                            <button
                                key={value}
                                type="button"
                                onClick={() => setActiveSection(value)}
                                aria-pressed={activeSection === value}
                                className={`flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-[11px] font-bold uppercase sm:text-xs ${activeSection === value ? 'bg-black text-white' : 'border border-transparent bg-white hover:border-black hover:bg-gray-100'}`}
                            >
                                <Icon className="h-4 w-4 flex-shrink-0" />
                                <span>{label}</span>
                            </button>
                        ))}
                    </nav>

                    <div className={`border-2 border-black p-5 mb-4 bg-white ${activeSection !== 'overview' ? 'hidden' : ''}`}>
                        <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                                {config.enabled ? <Power className="w-5 h-5 text-green-700" /> : <PowerOff className="w-5 h-5 text-gray-400" />}
                                <div>
                                    <p className="font-bold text-sm">
                                        {config.enabled
                                            ? config.trial_mode_enabled ? 'Chatbot active for one trial contact' : 'Chatbot active'
                                            : 'Chatbot disabled'}
                                    </p>
                                    <p className="text-xs text-gray-500 font-mono">
                                        {config.enabled
                                            ? config.trial_mode_enabled
                                                ? 'Only the selected Messenger trial contact can receive AI replies and follow-ups.'
                                                : 'Incoming text messages to ' + selectedPageName + ' receive an automatic reply.'
                                            : 'Turn this on after testing the instructions below.'}
                                    </p>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => updateConfig({ enabled: !config.enabled })}
                                disabled={!providerConfigured}
                                aria-label={config.enabled ? 'Disable chatbot' : 'Enable chatbot'}
                                className={'relative w-12 h-6 rounded-full transition-colors disabled:opacity-40 ' + (config.enabled ? 'bg-green-600' : 'bg-gray-300')}
                            >
                                <span className={'absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ' + (config.enabled ? 'translate-x-6' : 'translate-x-0.5')} />
                            </button>
                        </div>
                        <div className="mt-3 pt-3 border-t border-gray-300 flex items-center gap-2 text-xs font-mono">
                            <ShieldCheck className="w-4 h-4" />
                            OpenRouter: {providerConfigured ? 'configured' : 'missing OPENROUTER_API_KEY'}
                        </div>
                        <div className="mt-3 border border-blue-400 bg-blue-50 p-3 text-xs leading-5 text-blue-950">
                            <b>Conversation identity:</b> the bot is told it represents <b>{selectedPageName}</b> and receives each customer&apos;s saved Messenger profile name. Page and contact identities are kept separate in replies and follow-ups.
                        </div>
                    </div>

                    <section id="performance" className={`scroll-mt-20 border-2 border-black p-5 md:p-6 mb-4 bg-white ${activeSection !== 'overview' ? 'hidden' : ''}`}>
                        <div className="mb-5 flex flex-col gap-4 border-b border-gray-300 pb-4 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex items-start gap-3">
                                <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center border border-black bg-gray-50">
                                    <BarChart3 className="h-5 w-5" />
                                </div>
                                <div>
                                    <h2 className="text-base font-bold">Bot performance</h2>
                                    <p className="mt-1 text-xs text-gray-500">Live results from Messenger contacts for {selectedPageName}. Test-chat messages are not included.</p>
                                </div>
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                                {[
                                    [1, '24h'],
                                    [7, '7d'],
                                    [30, '30d'],
                                    [90, '90d']
                                ].map(([days, label]) => (
                                    <button
                                        key={days}
                                        type="button"
                                        onClick={() => setAnalyticsDays(Number(days))}
                                        className={`border border-black px-3 py-2 font-mono text-xs font-bold ${analyticsDays === days ? 'bg-black text-white' : 'bg-white hover:bg-gray-100'}`}
                                    >
                                        {label}
                                    </button>
                                ))}
                                <button
                                    type="button"
                                    onClick={() => void loadAnalytics()}
                                    disabled={analyticsLoading}
                                    className="ml-1 flex h-9 w-9 items-center justify-center border border-black bg-white hover:bg-gray-100 disabled:opacity-50"
                                    aria-label="Refresh analytics"
                                    title="Refresh analytics"
                                >
                                    <RefreshCw className={`h-4 w-4 ${analyticsLoading ? 'animate-spin' : ''}`} />
                                </button>
                            </div>
                        </div>

                        {analyticsError && (
                            <div className="mb-4 border border-red-600 bg-red-50 p-3 text-sm text-red-800">{analyticsError}</div>
                        )}

                        {!analytics ? (
                            <div className="flex min-h-36 items-center justify-center border border-dashed border-gray-400 bg-gray-50 font-mono text-xs text-gray-500">
                                {analyticsLoading ? 'Calculating Page analytics...' : 'No analytics available yet.'}
                            </div>
                        ) : (
                            <>
                                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                                    {[
                                        {
                                            label: 'Contacts today',
                                            value: formatMetric(analytics.contacts.today),
                                            note: `${formatMetric(analytics.contacts.total)} total contacts`,
                                            icon: Users
                                        },
                                        {
                                            label: `New contacts · ${analyticsDays}d`,
                                            value: formatMetric(analytics.contacts.new_in_range),
                                            note: `${formatMetric(analytics.contacts.active_in_range)} sent a message`,
                                            icon: TrendingUp
                                        },
                                        {
                                            label: 'Bot conversations',
                                            value: formatMetric(analytics.conversations.conversations),
                                            note: `${formatMetric(analytics.current_states.active)} currently active`,
                                            icon: MessageSquare
                                        },
                                        {
                                            label: 'AI response rate',
                                            value: percentage(analytics.conversations.latest_inbound_replied, analytics.conversations.response_eligible),
                                            note: `${formatMetric(analytics.conversations.latest_inbound_replied)} of ${formatMetric(analytics.conversations.response_eligible)} latest messages`,
                                            icon: Bot
                                        },
                                        {
                                            label: 'Details captured',
                                            value: formatMetric(analytics.conversations.details_collected),
                                            note: `${formatMetric(analytics.conversations.contacts_with_details)} contacts shared details`,
                                            icon: ListChecks
                                        },
                                        {
                                            label: 'Follow-up response rate',
                                            value: percentage(analytics.follow_ups.responded, analytics.follow_ups.contacted),
                                            note: `${formatMetric(analytics.follow_ups.responded)} of ${formatMetric(analytics.follow_ups.contacted)} contacts replied`,
                                            icon: Clock3
                                        }
                                    ].map((metric) => (
                                        <div key={metric.label} className="border border-black bg-[#fafafa] p-4">
                                            <div className="flex items-center justify-between gap-3">
                                                <p className="font-mono text-[10px] font-bold uppercase tracking-wide text-gray-500">{metric.label}</p>
                                                <metric.icon className="h-4 w-4 text-gray-500" />
                                            </div>
                                            <p className="mt-3 text-3xl font-black tracking-tight">{metric.value}</p>
                                            <p className="mt-2 text-xs text-gray-500">{metric.note}</p>
                                        </div>
                                    ))}
                                </div>

                                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                                    <div className="border border-black p-4">
                                        <h3 className="flex items-center gap-2 text-sm font-bold"><Users className="h-4 w-4" /> Contact activity</h3>
                                        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden border border-gray-300 bg-gray-300 sm:grid-cols-4">
                                            {[
                                                ['All contacts', analytics.contacts.total],
                                                [`New · ${analyticsDays}d`, analytics.contacts.new_in_range],
                                                [`Active · ${analyticsDays}d`, analytics.contacts.active_in_range],
                                                ['In 7-day window', analytics.contacts.within_7_day_window]
                                            ].map(([label, value]) => (
                                                <div key={String(label)} className="bg-white p-3">
                                                    <p className="font-mono text-[10px] uppercase text-gray-500">{label}</p>
                                                    <p className="mt-1 text-lg font-bold">{formatMetric(Number(value))}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="border border-black p-4">
                                        <h3 className="flex items-center gap-2 text-sm font-bold"><ListChecks className="h-4 w-4" /> Detail capture</h3>
                                        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden border border-gray-300 bg-gray-300 sm:grid-cols-4">
                                            {[
                                                ['With details', analytics.conversations.contacts_with_details],
                                                ['Avg. per contact', analytics.conversations.average_details_per_contact],
                                                ['Still missing', analytics.conversations.details_missing],
                                                ['Completed / qualified', analytics.conversations.completed_or_qualified]
                                            ].map(([label, value]) => (
                                                <div key={String(label)} className="bg-white p-3">
                                                    <p className="font-mono text-[10px] uppercase text-gray-500">{label}</p>
                                                    <p className="mt-1 text-lg font-bold">{formatMetric(Number(value))}</p>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="border border-black p-4">
                                        <h3 className="flex items-center gap-2 text-sm font-bold"><MessageSquare className="h-4 w-4" /> Message delivery</h3>
                                        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                                            <div><dt className="text-xs text-gray-500">AI replies sent</dt><dd className="font-bold">{formatMetric(analytics.reply_events.sent)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Reply failures</dt><dd className="font-bold">{formatMetric(analytics.reply_events.failed)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Unique contacts replied</dt><dd className="font-bold">{formatMetric(analytics.reply_events.contacts_replied)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Outbound bot messages</dt><dd className="font-bold">{formatMetric(analytics.outbound.total)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Conversation replies</dt><dd className="font-bold">{formatMetric(analytics.outbound.conversation_replies)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Media attachments</dt><dd className="font-bold">{formatMetric(analytics.outbound.media_attachments)}</dd></div>
                                        </dl>
                                    </div>

                                    <div className="border border-black p-4">
                                        <h3 className="flex items-center gap-2 text-sm font-bold"><Clock3 className="h-4 w-4" /> Follow-up delivery</h3>
                                        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
                                            <div><dt className="text-xs text-gray-500">Scheduled</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.scheduled)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Pending now</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.pending_now)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Sent</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.sent)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Failed</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.failed)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Quick replies</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.quick_sent)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">2–7 day HUMAN_AGENT</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.human_agent_sent)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">With media</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.with_media)}</dd></div>
                                            <div><dt className="text-xs text-gray-500">Cancelled</dt><dd className="font-bold">{formatMetric(analytics.follow_ups.cancelled)}</dd></div>
                                        </dl>
                                    </div>

                                    <div className="border border-black p-4">
                                        <h3 className="flex items-center gap-2 text-sm font-bold"><TrendingUp className="h-4 w-4" /> Contact pipeline</h3>
                                        <div className="mt-3 space-y-2">
                                            {Object.entries(analytics.pipeline).map(([stage, count]) => (
                                                <div key={stage} className="grid grid-cols-[120px_1fr_auto] items-center gap-2 text-xs">
                                                    <span className="truncate text-gray-600">{PIPELINE_LABELS[stage] || stage}</span>
                                                    <div className="h-2 border border-gray-300 bg-gray-100">
                                                        <div className="h-full bg-black" style={{ width: `${Math.max(count > 0 ? 1 : 0, (count / pipelineMaximum) * 100)}%` }} />
                                                    </div>
                                                    <span className="min-w-12 text-right font-mono font-bold">{formatMetric(count)}</span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>

                                    <div className="border border-black p-4">
                                        <h3 className="flex items-center gap-2 text-sm font-bold"><Database className="h-4 w-4" /> Bot outcomes and readiness</h3>
                                        <div className="mt-3 grid gap-4 sm:grid-cols-2">
                                            <div>
                                                <p className="font-mono text-[10px] font-bold uppercase text-gray-500">Conversation outcomes</p>
                                                {Object.keys(analytics.stop_reasons).length === 0 ? (
                                                    <p className="mt-2 text-xs text-gray-500">No stopped conversations in this period.</p>
                                                ) : (
                                                    <dl className="mt-2 space-y-1 text-xs">
                                                        {Object.entries(analytics.stop_reasons).map(([reason, count]) => (
                                                            <div key={reason} className="flex justify-between gap-3"><dt>{STOP_REASON_LABELS[reason] || reason.replaceAll('_', ' ')}</dt><dd className="font-bold">{formatMetric(count)}</dd></div>
                                                        ))}
                                                    </dl>
                                                )}
                                            </div>
                                            <dl className="space-y-1 text-xs">
                                                <div className="flex justify-between gap-3"><dt>Active / stopped</dt><dd className="font-bold">{formatMetric(analytics.current_states.active)} / {formatMetric(analytics.current_states.stopped)}</dd></div>
                                                <div className="flex justify-between gap-3"><dt>Knowledge ready</dt><dd className="font-bold">{formatMetric(analytics.knowledge.ready_documents)} docs · {formatMetric(analytics.knowledge.ready_chunks)} chunks</dd></div>
                                                <div className="flex justify-between gap-3"><dt>Knowledge failed</dt><dd className="font-bold">{formatMetric(analytics.knowledge.failed_documents)}</dd></div>
                                                <div className="flex justify-between gap-3"><dt>Media ready</dt><dd className="font-bold">{formatMetric(analytics.media.ready_assets)} / {formatMetric(analytics.media.assets)}</dd></div>
                                                <div className="flex justify-between gap-3"><dt>Images / videos</dt><dd className="font-bold">{formatMetric(analytics.media.ready_images)} / {formatMetric(analytics.media.ready_videos)}</dd></div>
                                                <div className="flex justify-between gap-3"><dt>Details requested</dt><dd className="font-bold">{formatMetric(analytics.configuration.details_requested)} · {analytics.configuration.details_completion_percent}% target</dd></div>
                                            </dl>
                                        </div>
                                        <div className="mt-4 flex flex-wrap gap-2 border-t border-gray-300 pt-3 font-mono text-[10px] font-bold uppercase">
                                            <span className={`border px-2 py-1 ${analytics.configuration.enabled ? 'border-green-700 bg-green-50 text-green-800' : 'border-gray-400 text-gray-500'}`}>Bot {analytics.configuration.enabled ? 'on' : 'off'}</span>
                                            <span className={`border px-2 py-1 ${analytics.configuration.follow_up_enabled ? 'border-green-700 bg-green-50 text-green-800' : 'border-gray-400 text-gray-500'}`}>Follow-up {analytics.configuration.follow_up_enabled ? 'on' : 'off'}</span>
                                            <span className={`border px-2 py-1 ${analytics.configuration.rag_enabled ? 'border-green-700 bg-green-50 text-green-800' : 'border-gray-400 text-gray-500'}`}>RAG {analytics.configuration.rag_enabled ? 'on' : 'off'}</span>
                                        </div>
                                    </div>
                                </div>

                                <p className="mt-4 border-t border-gray-300 pt-3 font-mono text-[10px] leading-5 text-gray-500">
                                    AI response rate checks whether the bot replied after each contact&apos;s latest inbound message in the selected period. Follow-up response rate counts unique contacts who sent a new message after their latest delivered follow-up. “Today” follows Asia/Manila time. Updated {new Date(analytics.generated_at).toLocaleString()}.
                                </p>
                            </>
                        )}
                    </section>

                    <section id="behavior" className={`scroll-mt-20 border-2 border-black p-5 md:p-6 mb-4 bg-white ${activeSection !== 'behavior' ? 'hidden' : ''}`}>
                        <div className="mb-4 flex items-start gap-3 border-b border-gray-300 pb-4">
                            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center border border-black bg-gray-50">
                                <Bot className="h-5 w-5" />
                            </div>
                            <div>
                                <h2 className="text-base font-bold">Bot personality and behavior</h2>
                                <p className="mt-1 text-xs text-gray-500">Give the AI enough room to understand your business, tone, boundaries, and handoff rules.</p>
                            </div>
                        </div>
                        <div className="mb-2 flex items-end justify-between gap-3">
                            <label htmlFor="bot-instructions" className="font-mono text-xs font-bold uppercase text-gray-600">
                                Main bot instructions
                            </label>
                            <span className="font-mono text-[10px] text-gray-400">{config.instructions.length.toLocaleString()} / 5,000</span>
                        </div>
                        <textarea
                            id="bot-instructions"
                            value={config.instructions}
                            onChange={(event) => updateConfig({ instructions: event.target.value })}
                            rows={14}
                            maxLength={5000}
                            className="input-wireframe min-h-[320px] w-full resize-y px-4 py-3 text-[15px] leading-6"
                            placeholder="Explain your business, services, policies, tone, and when the bot should hand off to a person."
                        />
                        <p className="mt-2 text-xs text-gray-500 font-mono">
                            Include only facts the bot is allowed to use. It sees up to 20 recent messages and automatically mirrors English, Filipino, or Taglish.
                        </p>

                        <div className="grid lg:grid-cols-2 gap-4 mt-5 pt-5 border-t border-gray-300">
                            <label className="block">
                                <span className="font-mono text-xs font-bold uppercase text-green-700 mb-2 block">Bot should</span>
                                <textarea
                                    value={config.bot_dos}
                                    onChange={(event) => updateConfig({ bot_dos: event.target.value })}
                                    rows={8}
                                    maxLength={3000}
                                    className="input-wireframe min-h-[210px] w-full resize-y px-4 py-3 text-sm leading-6"
                                    placeholder={'Example:\nUse the customer\'s first name.\nGive prices only from RAG.\nOffer a human handoff when unsure.'}
                                />
                            </label>
                            <label className="block">
                                <span className="font-mono text-xs font-bold uppercase text-red-700 mb-2 block">Bot should not</span>
                                <textarea
                                    value={config.bot_donts}
                                    onChange={(event) => updateConfig({ bot_donts: event.target.value })}
                                    rows={8}
                                    maxLength={3000}
                                    className="input-wireframe min-h-[210px] w-full resize-y px-4 py-3 text-sm leading-6"
                                    placeholder={'Example:\nDo not offer discounts.\nDo not promise unavailable stock.\nDo not argue with customers.'}
                                />
                            </label>
                        </div>
                    </section>

                    <div className={`grid md:grid-cols-2 gap-4 mb-4 ${activeSection !== 'behavior' ? 'hidden' : ''}`}>
                        <div className="border-2 border-black p-5 bg-white">
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">
                                Fallback reply
                            </label>
                            <textarea
                                value={config.fallback_reply}
                                onChange={(event) => updateConfig({ fallback_reply: event.target.value })}
                                rows={6}
                                maxLength={1000}
                                className="input-wireframe min-h-[150px] w-full resize-y px-4 py-3 text-sm leading-6"
                            />
                            <p className="mt-2 text-xs text-gray-500">Sent if AI generation fails.</p>
                        </div>
                        <div className="border-2 border-black p-5 bg-white">
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">
                                OpenRouter model
                            </label>
                            <input
                                value={config.model}
                                onChange={(event) => updateConfig({ model: event.target.value })}
                                maxLength={200}
                                className="input-wireframe w-full text-sm"
                            />
                            <p className="mt-2 text-xs text-gray-500">
                                The default follows OpenRouter&apos;s latest DeepSeek Flash model.
                            </p>
                        </div>
                    </div>

                    <section id="sales-flow" className={`scroll-mt-20 border-2 border-black p-5 md:p-6 mb-4 bg-white ${activeSection !== 'sales' ? 'hidden' : ''}`}>
                        <div className="flex items-start gap-3 mb-4">
                            <div className="w-9 h-9 border border-black flex items-center justify-center flex-shrink-0">
                                <ListChecks className="w-4 h-4" />
                            </div>
                            <div>
                                <h2 className="font-bold text-sm">Sales conversation flow</h2>
                                <p className="text-xs text-gray-500 font-mono mt-1">
                                    Guide the next question, collect lead details, then hand the conversation to your team.
                                </p>
                            </div>
                        </div>

                        <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">
                            Follow-up prompt
                        </label>
                        <textarea
                            value={config.follow_up_prompt}
                            onChange={(event) => updateConfig({ follow_up_prompt: event.target.value })}
                            rows={7}
                            maxLength={3000}
                            className="input-wireframe min-h-[180px] w-full resize-y px-4 py-3 text-sm leading-6"
                            placeholder="Example: Ask what service they need, their preferred date, and budget. Ask only one question at a time."
                        />

                        <label className="font-mono text-xs font-bold uppercase text-gray-500 mt-4 mb-2 block">
                            Details to collect — one per line
                        </label>
                        <textarea
                            value={config.details_to_collect.join('\n')}
                            onChange={(event) => updateConfig({
                                details_to_collect: event.target.value
                                    .split('\n')
                                    .slice(0, 20)
                            })}
                            rows={8}
                            className="input-wireframe min-h-[210px] w-full resize-y px-4 py-3 text-sm leading-6"
                            placeholder={'Full name\nMobile number\nService needed\nPreferred schedule\nBudget'}
                        />
                        <p className="mt-2 text-xs text-gray-500 font-mono">
                            The bot remembers customer-provided values and asks for only one missing detail at a time.
                        </p>

                        <div className="mt-4 border border-black p-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <p className="text-sm font-bold">Collection target</p>
                                <p className="text-xs text-gray-500 mt-1">
                                    Stop collecting after {config.details_to_collect.length > 0
                                        ? `${Math.max(1, Math.ceil(config.details_to_collect.length * config.details_completion_percent / 100))} of ${config.details_to_collect.length}`
                                        : 'the target number of'} details are received.
                                </p>
                            </div>
                            <label className="flex items-center gap-2 font-mono text-sm flex-shrink-0">
                                <input
                                    type="number"
                                    min={1}
                                    max={100}
                                    step={5}
                                    value={config.details_completion_percent}
                                    onChange={(event) => updateConfig({
                                        details_completion_percent: Math.min(100, Math.max(1, Number(event.target.value) || 100))
                                    })}
                                    className="input-wireframe w-20 text-sm"
                                />
                                %
                            </label>
                        </div>

                        <div className="grid md:grid-cols-2 gap-4 mt-4">
                            <label className="border border-black p-3 flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={config.split_messages}
                                    onChange={(event) => updateConfig({ split_messages: event.target.checked })}
                                    className="w-4 h-4 mt-0.5"
                                />
                                <span>
                                    <span className="block text-sm font-bold">Natural message bubbles</span>
                                    <span className="block text-xs text-gray-500 mt-1">Split a reply into short conversational messages.</span>
                                </span>
                            </label>
                            <div className="border border-black p-3">
                                <span className="block text-sm font-bold">Automatic bubble count</span>
                                <span className="block text-xs text-gray-500 mt-1">
                                    No fixed maximum. The bot uses only as many short bubbles as the reply naturally needs.
                                </span>
                            </div>
                        </div>

                        <div className="mt-4 border border-black bg-[#f8f8f8] p-3 flex items-start gap-2">
                            <Clock3 className="w-4 h-4 mt-0.5 flex-shrink-0" />
                            <p className="text-xs font-mono">
                                Bot state uses a rolling seven-day activity window from the customer&apos;s latest message. Day 2–7 follow-ups require Meta Human Agent access for the connected app.
                            </p>
                        </div>

                        <div className="mt-4 border-2 border-black p-4 bg-white">
                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={config.follow_up_enabled}
                                    onChange={(event) => updateConfig({ follow_up_enabled: event.target.checked })}
                                    className="w-4 h-4 mt-0.5"
                                />
                                <span>
                                    <span className="block text-sm font-bold">No-reply follow-ups</span>
                                    <span className="block text-xs text-gray-500 mt-1">
                                        Cancel immediately when the customer replies or the bot reaches a stop condition.
                                    </span>
                                </span>
                            </label>

                            <label className="font-mono text-xs block mt-4">
                                AI follow-up instructions
                                <textarea
                                    value={config.follow_up_ai_instructions}
                                    onChange={(event) => updateConfig({ follow_up_ai_instructions: event.target.value })}
                                    disabled={!config.follow_up_enabled}
                                    rows={8}
                                    maxLength={3000}
                                    className="input-wireframe min-h-[200px] w-full mt-2 resize-y px-4 py-3 text-sm leading-6"
                                    placeholder="Personalize every follow-up from the conversation. When relevant, send samples of previous work, a product photo, or a promotional video from the knowledge base. Never repeat the same wording."
                                />
                                <span className="block text-[10px] text-gray-500 mt-1">
                                    VeoBot reads the existing conversation and saved contact details before writing, then uses Page RAG for relevant facts and media. If history cannot be read or a genuinely personalized message cannot be validated, nothing is sent and the job retries.
                                </span>
                            </label>

                            <div className="grid md:grid-cols-2 gap-3 mt-4">
                                <label className="text-xs font-mono">
                                    First 24 hours — delays in minutes
                                    <input
                                        value={config.follow_up_quick_delays_minutes.join(', ')}
                                        onChange={(event) => updateConfig({
                                            follow_up_quick_delays_minutes: Array.from(new Set(event.target.value
                                                .split(/[\s,]+/)
                                                .map(Number)
                                                .filter((value) => Number.isFinite(value) && value >= 1 && value <= 1439)))
                                                .sort((a, b) => a - b)
                                                .slice(0, 10)
                                        })}
                                        disabled={!config.follow_up_enabled}
                                        className="input-wireframe w-full mt-2 text-sm"
                                        placeholder="10, 60, 240, 720, 1380"
                                    />
                                    <span className="block text-[10px] text-gray-500 mt-1">Uses RESPONSE and may include the selected media.</span>
                                </label>
                                <label className="text-xs font-mono">
                                    Best-time follow-up days
                                    <input
                                        value={config.follow_up_best_time_days.join(', ')}
                                        onChange={(event) => updateConfig({
                                            follow_up_best_time_days: Array.from(new Set(event.target.value
                                                .split(/[\s,]+/)
                                                .map(Number)
                                                .filter((value) => Number.isFinite(value) && value >= 2 && value <= 7)))
                                                .sort((a, b) => a - b)
                                        })}
                                        disabled={!config.follow_up_enabled}
                                        className="input-wireframe w-full mt-2 text-sm"
                                        placeholder="2, 3, 5, 7"
                                    />
                                    <span className="block text-[10px] text-gray-500 mt-1">Days 2–7 send automatically with HUMAN_AGENT at the contact&apos;s best Philippine-time hour.</span>
                                </label>
                            </div>

                            <div className="mt-3 border border-green-700 bg-green-50 p-3 text-xs text-green-900">
                                <span className="block font-bold">Every follow-up is written by AI at send time</span>
                                <span className="mt-1 block">There are no user-prefilled follow-up messages or fallback copy. The AI uses the latest Messenger conversation, saved contact details, your instructions, and Page knowledge. If it cannot create a validated personalized message, nothing is sent.</span>
                            </div>

                            <div className="mt-3 border border-black bg-gray-50 p-3 text-xs">
                                <span className="block font-bold">AI-selected sample cards</span>
                                <span className="mt-1 block text-gray-600">Most follow-ups are text-only. When the customer asks for samples or a relevant video would genuinely help the sale, AI can choose one specific image or video card from Page knowledge. It creates a swipeable carousel only when several relevant options are useful.</span>
                            </div>

                            <p className="mt-3 border border-amber-500 bg-amber-50 p-2 text-[11px] text-amber-900 font-mono">
                                First-day sends use RESPONSE. On days 2–7, VeoBot sends the AI-personalized follow-up automatically with HUMAN_AGENT. Meta must approve Human Agent access for the connected app.
                            </p>
                        </div>

                        <p className="font-mono text-xs font-bold uppercase text-gray-500 mt-5 mb-2">Stop the bot when</p>
                        <div className="grid sm:grid-cols-2 gap-2">
                            {([
                                ['stop_when_details_collected', 'Collection percentage target is reached'],
                                ['stop_on_opt_out', 'Customer asks the Page to stop'],
                                ['stop_on_refusal', 'Customer clearly refuses or is not interested'],
                                ['stop_on_qualified', 'Meta lead stage becomes Qualified'],
                                ['stop_on_not_qualified', 'Meta lead stage becomes Not Qualified'],
                                ['stop_on_converted', 'Meta lead stage becomes Converted'],
                                ['stop_on_order_created', 'An order is created in Messenger']
                            ] as Array<[keyof ChatbotConfig, string]>).map(([key, label]) => (
                                <label key={key} className="border border-gray-400 p-2 flex items-start gap-2 text-xs cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={Boolean(config[key])}
                                        onChange={(event) => updateConfig({ [key]: event.target.checked })}
                                        className="w-4 h-4 mt-0.5"
                                    />
                                    <span>{label}</span>
                                </label>
                            ))}
                        </div>
                        <p className="mt-2 text-[11px] text-gray-500 font-mono">
                            Meta lead-stage and order stops are detected by the existing Messenger history synchronization job.
                        </p>
                    </section>

                    <section id="knowledge" className={`scroll-mt-20 border-2 border-black p-5 md:p-6 mb-4 bg-white ${activeSection !== 'knowledge' ? 'hidden' : ''}`}>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-4">
                            <div className="flex items-start gap-3">
                                <div className="w-9 h-9 border border-black flex items-center justify-center flex-shrink-0">
                                    <BookOpen className="w-4 h-4" />
                                </div>
                                <div>
                                    <h2 className="font-bold text-sm">Knowledge base (RAG)</h2>
                                    <p className="text-xs text-gray-500 font-mono mt-1">
                                        Add services, prices, FAQs, policies, product details, and other facts for this Page.
                                    </p>
                                </div>
                            </div>
                            <label className="flex items-center gap-2 text-xs font-mono cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={config.rag_enabled}
                                    onChange={(event) => updateConfig({ rag_enabled: event.target.checked })}
                                    className="w-4 h-4"
                                />
                                Use knowledge in replies
                            </label>
                        </div>

                        <div className="grid sm:grid-cols-[1fr_auto] gap-2 mb-2">
                            <input
                                value={knowledgeTitle}
                                onChange={(event) => setKnowledgeTitle(event.target.value)}
                                maxLength={160}
                                className="input-wireframe w-full text-sm"
                                placeholder="Knowledge title, e.g. Services and prices"
                            />
                            <label className="btn-wireframe bg-white flex items-center justify-center gap-2 px-4 py-2 cursor-pointer">
                                <Upload className="w-4 h-4" />
                                Load file
                                <input
                                    type="file"
                                    accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
                                    className="hidden"
                                    onChange={(event) => {
                                        loadKnowledgeFile(event.target.files?.[0]);
                                        event.currentTarget.value = '';
                                    }}
                                />
                            </label>
                        </div>
                        {knowledgeFilename && (
                            <p className="mb-2 text-xs font-mono text-gray-600 flex items-center gap-1">
                                <FileText className="w-3 h-3" /> {knowledgeFilename}
                            </p>
                        )}
                        <textarea
                            value={knowledgeContent}
                            onChange={(event) => {
                                setKnowledgeContent(event.target.value);
                                if (knowledgeFilename) setKnowledgeFilename(null);
                            }}
                            rows={14}
                            maxLength={100000}
                            className="input-wireframe min-h-[360px] w-full resize-y px-4 py-3 text-sm leading-6"
                            placeholder={'Paste business knowledge here.\n\nExample:\nHaircut: ₱350\nOpen Monday-Saturday, 9 AM-7 PM.\nAppointments can be rescheduled up to 24 hours before the booking.'}
                        />
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mt-2">
                            <p className="text-xs text-gray-500 font-mono">
                                {knowledgeContent.length.toLocaleString()} / 100,000 characters · Files: TXT, MD, CSV, JSON
                            </p>
                            <button
                                type="button"
                                onClick={indexKnowledge}
                                disabled={indexingKnowledge || !knowledgeTitle.trim() || knowledgeContent.trim().length < 20}
                                className="btn-wireframe bg-black text-white hover:bg-gray-800 px-4 py-2 disabled:opacity-50"
                            >
                                {indexingKnowledge ? 'Embedding and indexing...' : 'Add to knowledge base'}
                            </button>
                        </div>

                        <div className="mt-5 border-t border-gray-300 pt-4">
                            <div className="flex items-center justify-between mb-2">
                                <p className="font-mono text-xs font-bold uppercase text-gray-500">
                                    Indexed documents
                                </p>
                                <span className="text-xs font-mono text-gray-500">{knowledgeDocuments.length}</span>
                            </div>
                            {knowledgeDocuments.length === 0 ? (
                                <div className="border border-dashed border-gray-400 p-4 text-center text-xs text-gray-500 font-mono">
                                    No knowledge yet. Paste data or load a text file above.
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {knowledgeDocuments.map((document) => (
                                        <div key={document.id} className="border border-black p-3 flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <p className="font-bold text-sm truncate">{document.title}</p>
                                                <p className="text-xs text-gray-500 font-mono mt-1">
                                                    {document.status === 'ready'
                                                        ? `${document.chunk_count} chunks · ${document.char_count.toLocaleString()} characters`
                                                        : document.status}
                                                    {document.original_filename ? ` · ${document.original_filename}` : ''}
                                                </p>
                                                {document.error_message && (
                                                    <p className="text-xs text-red-700 mt-1">{document.error_message}</p>
                                                )}
                                            </div>
                                            <button
                                                type="button"
                                                onClick={() => deleteKnowledge(document.id)}
                                                disabled={deletingDocumentId === document.id}
                                                className="p-2 border border-black hover:bg-red-50 disabled:opacity-50 flex-shrink-0"
                                                aria-label={'Delete ' + document.title}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>

                    <section id="drive-folders" className={`scroll-mt-20 border-2 border-black p-5 md:p-6 mb-4 bg-white ${activeSection !== 'knowledge' ? 'hidden' : ''}`}>
                        <div className="flex items-start gap-3 mb-4">
                            <div className="w-9 h-9 border border-black flex items-center justify-center flex-shrink-0">
                                <FolderOpen className="w-4 h-4" />
                            </div>
                            <div>
                                <h2 className="font-bold text-sm">Google Drive folders <span className="font-mono text-[10px] font-normal uppercase text-gray-500">optional</span></h2>
                                <p className="text-xs text-gray-500 font-mono mt-1">
                                    Use this only when media must stay in Drive. For the easiest setup without Google API credentials, use “Choose entire folder” under Photos and videos below.
                                </p>
                            </div>
                        </div>

                        <div className="grid gap-3 md:grid-cols-2">
                            <label>
                                <span className="font-mono text-[10px] font-bold uppercase text-gray-500">Folder name</span>
                                <input
                                    value={driveFolderName}
                                    onChange={(event) => setDriveFolderName(event.target.value.slice(0, 160))}
                                    maxLength={160}
                                    className="input-wireframe mt-1 w-full"
                                    placeholder="Hair color transformation samples"
                                />
                            </label>
                            <label>
                                <span className="font-mono text-[10px] font-bold uppercase text-gray-500">Google Drive folder link</span>
                                <input
                                    value={driveFolderUrl}
                                    onChange={(event) => setDriveFolderUrl(event.target.value)}
                                    className="input-wireframe mt-1 w-full"
                                    placeholder="https://drive.google.com/drive/folders/..."
                                />
                            </label>
                        </div>
                        <div className="mt-3 grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                            <label>
                                <span className="font-mono text-[10px] font-bold uppercase text-gray-500">What is inside and when to share it</span>
                                <textarea
                                    value={driveFolderUsage}
                                    onChange={(event) => setDriveFolderUsage(event.target.value.slice(0, 3000))}
                                    rows={3}
                                    maxLength={3000}
                                    className="input-wireframe mt-1 w-full resize-y"
                                    placeholder="Before-and-after samples for balayage and hair coloring. Share when someone asks for color pegs, previous work, or style examples."
                                />
                            </label>
                            <label>
                                <span className="font-mono text-[10px] font-bold uppercase text-gray-500">Button text</span>
                                <input
                                    value={driveFolderButtonText}
                                    onChange={(event) => setDriveFolderButtonText(event.target.value.slice(0, 20))}
                                    maxLength={20}
                                    className="input-wireframe mt-1 w-full"
                                    placeholder="View media samples"
                                />
                                <span className="mt-2 block text-[10px] text-gray-500">Maximum 20 characters for Messenger.</span>
                            </label>
                        </div>
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                            <div className="text-xs text-gray-500 font-mono">
                                <p>Set the folder and its nested files to Anyone with the link → Viewer. VeoBot indexes only filenames, folder categories, thumbnails and links; videos remain in Google Drive.</p>
                                <p className={`mt-1 break-all ${driveSyncStatus?.configured ? 'text-green-700' : 'text-amber-700'}`}>
                                    {driveSyncStatus?.message || (driveSyncStatus?.service_account_email
                                        ? `Drive sync account: ${driveSyncStatus.service_account_email}`
                                        : 'Public-link Drive indexer is active.')}
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => void addDriveFolder()}
                                disabled={addingDriveFolder || !providerConfigured || !driveFolderName.trim() || !driveFolderUrl.trim() || !driveFolderButtonText.trim()}
                                className="btn-wireframe bg-black text-white hover:bg-gray-800 px-4 py-2 disabled:opacity-50"
                            >
                                {addingDriveFolder ? 'Indexing folder...' : 'Add folder to chatbot'}
                            </button>
                        </div>

                        <div className="mt-5 border-t border-gray-300 pt-4">
                            <div className="flex items-center justify-between mb-2">
                                <p className="font-mono text-xs font-bold uppercase text-gray-500">Linked folders</p>
                                <span className="text-xs font-mono text-gray-500">{driveFolders.length}</span>
                            </div>
                            {driveFolders.length === 0 ? (
                                <div className="border border-dashed border-gray-400 p-4 text-center text-xs text-gray-500 font-mono">
                                    No Drive folders linked to this Page yet.
                                </div>
                            ) : (
                                <div className="grid gap-3 sm:grid-cols-2">
                                    {driveFolders.map((folder) => (
                                        <div key={folder.id} className="border border-black p-3">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="font-bold text-sm truncate">{folder.name}</p>
                                                    <a
                                                        href={folder.folder_url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="mt-1 inline-flex items-center gap-1 text-[10px] font-mono text-blue-700 hover:underline"
                                                    >
                                                        Open folder <ExternalLink className="h-3 w-3" />
                                                    </a>
                                                    <p className="mt-2 text-[10px] font-mono uppercase text-gray-500">Button: {folder.button_text}</p>
                                                    <p className={`mt-1 text-[10px] font-mono uppercase ${folder.sync_status === 'ready' ? 'text-green-700' : folder.sync_status === 'failed' ? 'text-red-700' : 'text-gray-500'}`}>
                                                        {folder.sync_status} · {folder.file_count || 0} indexed file{folder.file_count === 1 ? '' : 's'}
                                                    </p>
                                                    {folder.last_synced_at && <p className="mt-1 text-[10px] text-gray-500">Last synced {new Date(folder.last_synced_at).toLocaleString()}</p>}
                                                    {folder.sync_error && <p className="mt-2 text-xs text-red-700">{folder.sync_error}</p>}
                                                    {folder.usage_notes && <p className="mt-2 text-xs text-gray-600 line-clamp-3">{folder.usage_notes}</p>}
                                                    {driveFiles.some((file) => file.folder_id === folder.id) && (
                                                        <div className="mt-3 flex flex-wrap gap-1">
                                                            {driveFiles.filter((file) => file.folder_id === folder.id).slice(0, 8).map((file) => (
                                                                <a key={file.id} href={file.web_view_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 border border-gray-300 px-2 py-1 text-[9px] hover:border-black">
                                                                    {file.media_type === 'image' ? <ImageIcon className="h-3 w-3" /> : <Video className="h-3 w-3" />}
                                                                    <span className="max-w-32 truncate" title={file.relative_path || file.name}>{file.name}</span>
                                                                </a>
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex flex-shrink-0 gap-1">
                                                    <button
                                                        type="button"
                                                        onClick={() => void syncDriveFolder(folder.id)}
                                                        disabled={syncingDriveFolderId === folder.id || !driveSyncStatus?.configured}
                                                        className="p-2 border border-black hover:bg-gray-100 disabled:opacity-40"
                                                        aria-label={'Sync ' + folder.name}
                                                        title="Sync individual Drive files"
                                                    >
                                                        <RefreshCw className={`w-4 h-4 ${syncingDriveFolderId === folder.id ? 'animate-spin' : ''}`} />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => void deleteDriveFolder(folder.id)}
                                                        disabled={deletingDriveFolderId === folder.id}
                                                        className="p-2 border border-black hover:bg-red-50 disabled:opacity-50"
                                                        aria-label={'Delete ' + folder.name}
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>

                    <section id="media" className={`scroll-mt-20 border-2 border-black p-5 md:p-6 mb-4 bg-white ${activeSection !== 'knowledge' ? 'hidden' : ''}`}>
                        <div className="flex items-start gap-3 mb-4">
                            <div className="w-9 h-9 border border-black flex items-center justify-center flex-shrink-0">
                                <ImageIcon className="w-4 h-4" />
                            </div>
                            <div>
                                <h2 className="font-bold text-sm">Photos and videos</h2>
                                <p className="text-xs text-gray-500 font-mono mt-1">
                                    Upload files or a whole folder for {selectedPageName}. Folder and file names become searchable AI context, so VeoBot can pick only the relevant sample.
                                </p>
                            </div>
                        </div>

                        <div className="grid gap-2 sm:grid-cols-2">
                            <label className={`btn-wireframe bg-white flex items-center justify-center gap-2 px-4 py-3 cursor-pointer ${uploadingMedia ? 'opacity-50 pointer-events-none' : ''}`}>
                                <Upload className="w-4 h-4" />
                                {pendingMediaUploads.length > 0
                                    ? `Add files (${pendingMediaUploads.length} selected)`
                                    : 'Choose individual files'}
                                <input
                                    type="file"
                                    multiple
                                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm"
                                    className="hidden"
                                    onChange={(event) => {
                                        addMediaFiles(Array.from(event.target.files || []));
                                        event.currentTarget.value = '';
                                    }}
                                />
                            </label>
                            <label className={`btn-wireframe bg-black text-white flex items-center justify-center gap-2 px-4 py-3 cursor-pointer hover:bg-gray-800 ${uploadingMedia ? 'opacity-50 pointer-events-none' : ''}`}>
                                <FolderOpen className="w-4 h-4" />
                                Choose entire folder
                                <input
                                    ref={folderMediaInputRef}
                                    type="file"
                                    multiple
                                    accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm,.jpg,.jpeg,.png,.webp,.gif,.mp4,.mov,.webm"
                                    className="hidden"
                                    onChange={(event) => {
                                        addMediaFiles(Array.from(event.target.files || []));
                                        event.currentTarget.value = '';
                                    }}
                                />
                            </label>
                        </div>

                        {pendingMediaUploads.length > 0 && (
                            <div className="mt-3 border border-black divide-y divide-gray-300">
                                {pendingMediaUploads.map((item, index) => (
                                    <div key={item.id} className="p-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                                        <div className="min-w-0">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="w-5 h-5 border border-black flex items-center justify-center font-mono text-[10px] flex-shrink-0">
                                                    {index + 1}
                                                </span>
                                                <p className="text-xs font-mono truncate">{item.file.name}</p>
                                                <span className="text-[10px] font-mono uppercase text-gray-500 flex-shrink-0">
                                                    {(item.file.size / 1024 / 1024).toFixed(1)} MB
                                                </span>
                                            </div>
                                            {item.sourceFolder && (
                                                <p className="mb-2 truncate text-[10px] font-mono text-gray-500" title={item.sourceRelativePath}>
                                                    Folder: {item.sourceRelativePath}
                                                </p>
                                            )}
                                            <input
                                                value={item.title}
                                                onChange={(event) => setPendingMediaUploads((current) => current.map((candidate) =>
                                                    candidate.id === item.id
                                                        ? { ...candidate, title: event.target.value }
                                                        : candidate
                                                ))}
                                                maxLength={160}
                                                disabled={uploadingMedia}
                                                className="input-wireframe w-full text-sm"
                                                placeholder="Media title"
                                                aria-label={`Title for ${item.file.name}`}
                                            />
                                            {item.status !== 'queued' && (
                                                <p className={`mt-1 text-[10px] font-mono ${item.status === 'failed' ? 'text-red-700' : 'text-gray-500'}`}>
                                                    {item.status === 'uploading' && 'Uploading file...'}
                                                    {item.status === 'analyzing' && 'Analyzing and adding to RAG...'}
                                                    {item.status === 'failed' && (item.error || 'Upload failed')}
                                                </p>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setPendingMediaUploads((current) => current.filter((candidate) => candidate.id !== item.id))}
                                            disabled={uploadingMedia}
                                            className="p-2 border border-black hover:bg-red-50 disabled:opacity-50 justify-self-end"
                                            aria-label={`Remove ${item.file.name} from upload`}
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                ))}
                            </div>
                        )}
                        <textarea
                            value={mediaUsage}
                            onChange={(event) => setMediaUsage(event.target.value)}
                            rows={5}
                            maxLength={3000}
                            className="input-wireframe min-h-[130px] w-full resize-y px-4 py-3 text-sm leading-6"
                            placeholder="Shared guidance for this batch. When should the bot send these files? Add facts the media may not make clear."
                        />
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mt-2">
                            <p className="text-xs text-gray-500 font-mono">
                                Up to 100 files per batch · max 50 MB each · JPG, PNG, WebP, GIF, MP4, MOV, WebM · Page-specific
                            </p>
                            <button
                                type="button"
                                onClick={uploadMedia}
                                disabled={uploadingMedia || pendingMediaUploads.length === 0 || pendingMediaUploads.some((item) => !item.title.trim()) || !providerConfigured}
                                className="btn-wireframe bg-black text-white hover:bg-gray-800 px-4 py-2 disabled:opacity-50"
                            >
                                {uploadingMedia
                                    ? `Uploading and analyzing ${pendingMediaUploads.length}...`
                                    : `Upload ${pendingMediaUploads.length || ''} and auto-RAG`}
                            </button>
                        </div>

                        <div className="mt-5 border-t border-gray-300 pt-4">
                            <div className="flex items-center justify-between mb-2">
                                <p className="font-mono text-xs font-bold uppercase text-gray-500">Page media library</p>
                                <span className="text-xs font-mono text-gray-500">{mediaAssets.length}</span>
                            </div>
                            {mediaAssets.length === 0 ? (
                                <div className="border border-dashed border-gray-400 p-4 text-center text-xs text-gray-500 font-mono">
                                    No media yet for this Page.
                                </div>
                            ) : (
                                <div className="grid sm:grid-cols-2 gap-3">
                                    {mediaAssets.map((asset) => (
                                        <div key={asset.id} className="border border-black overflow-hidden">
                                            <div className="h-40 bg-gray-100 flex items-center justify-center overflow-hidden">
                                                {asset.preview_url && asset.media_type === 'image' ? (
                                                    // eslint-disable-next-line @next/next/no-img-element
                                                    <img src={asset.preview_url} alt={asset.title} className="w-full h-full object-contain" />
                                                ) : asset.preview_url && asset.media_type === 'video' ? (
                                                    <video src={asset.preview_url} controls preload="metadata" className="w-full h-full object-contain" />
                                                ) : asset.media_type === 'video' ? (
                                                    <Video className="w-8 h-8 text-gray-400" />
                                                ) : (
                                                    <ImageIcon className="w-8 h-8 text-gray-400" />
                                                )}
                                            </div>
                                            <div className="p-3 flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="font-bold text-sm truncate">{asset.title}</p>
                                                    <p className="text-[10px] text-gray-500 font-mono mt-1 uppercase">
                                                        {asset.media_type} · {asset.status} · {(asset.file_size / 1024 / 1024).toFixed(1)} MB
                                                    </p>
                                                    {asset.source_relative_path && asset.source_relative_path !== asset.original_filename && (
                                                        <p className="mt-1 truncate text-[10px] font-mono text-gray-500" title={asset.source_relative_path}>
                                                            {asset.source_relative_path}
                                                        </p>
                                                    )}
                                                    {asset.usage_notes && <p className="text-xs text-gray-600 mt-2 line-clamp-2">{asset.usage_notes}</p>}
                                                    {asset.error_message && <p className="text-xs text-red-700 mt-2">{asset.error_message}</p>}
                                                </div>
                                                <button
                                                    type="button"
                                                    onClick={() => deleteMedia(asset.id)}
                                                    disabled={deletingMediaId === asset.id}
                                                    className="p-2 border border-black hover:bg-red-50 disabled:opacity-50 flex-shrink-0"
                                                    aria-label={'Delete ' + asset.title}
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </section>

                    <section id="test-chatbot" className={`scroll-mt-20 border-2 border-black p-5 md:p-6 bg-[#f8f8f8] ${activeSection !== 'test' ? 'hidden' : ''}`}>
                        <div className="flex items-start gap-3 mb-4">
                            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center border border-black bg-white">
                                <MessageSquare className="w-5 h-5" />
                            </div>
                            <div>
                                <h2 className="font-bold text-base">Test before enabling</h2>
                                <p className="mt-1 text-xs text-gray-500">Try a realistic customer message and review the answer, media, and knowledge sources.</p>
                            </div>
                        </div>

                        <div className="mb-5 border-2 border-black bg-white p-4">
                            <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                <div className="max-w-2xl">
                                    <div className="flex items-center gap-2">
                                        <ShieldCheck className="h-5 w-5" />
                                        <h3 className="text-sm font-bold">Live Messenger trial with one contact</h3>
                                        <span className={`border px-2 py-0.5 font-mono text-[9px] font-bold uppercase ${liveTrialStatus?.enabled ? 'border-green-700 bg-green-50 text-green-800' : 'border-gray-400 bg-gray-100 text-gray-600'}`}>
                                            {liveTrialStatus?.enabled ? 'Active' : 'Off'}
                                        </span>
                                    </div>
                                    <p className="mt-2 text-xs leading-5 text-gray-600">
                                        Choose one real Messenger contact. While the trial is active, the AI chatbot and its follow-ups are blocked for every other contact on {selectedPageName}.
                                    </p>
                                </div>
                                {liveTrialStatus?.enabled && selectedTrialContact && (
                                    <div className="border border-green-700 bg-green-50 px-3 py-2 text-xs">
                                        <b>{selectedTrialContact.name || 'Messenger contact'}</b>
                                        <span className="ml-2 font-mono text-[9px] uppercase text-green-800">Only allowed contact</span>
                                    </div>
                                )}
                            </div>

                            <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                                <label>
                                    <span className="font-mono text-[10px] font-bold uppercase text-gray-500">Find a contact</span>
                                    <input
                                        value={trialContactSearch}
                                        onChange={(event) => setTrialContactSearch(event.target.value.slice(0, 120))}
                                        disabled={liveTrialLoading}
                                        className="input-wireframe mt-1 w-full text-sm"
                                        placeholder="Search Messenger contact name"
                                    />
                                </label>
                                <label>
                                    <span className="font-mono text-[10px] font-bold uppercase text-gray-500">Trial contact</span>
                                    <select
                                        value={trialContactId}
                                        onChange={(event) => setTrialContactId(event.target.value)}
                                        disabled={liveTrialLoading}
                                        className="input-wireframe mt-1 w-full bg-white text-sm"
                                    >
                                        <option value="">Choose one Messenger contact</option>
                                        {trialContacts.map((contact) => (
                                            <option key={contact.id} value={contact.id}>
                                                {contact.name || 'Unnamed contact'}{contact.pipeline_stage ? ` · ${PIPELINE_LABELS[contact.pipeline_stage] || contact.pipeline_stage}` : ''}
                                            </option>
                                        ))}
                                    </select>
                                </label>
                            </div>

                            {selectedTrialContact && (
                                <div className="mt-3 grid gap-2 border border-gray-300 bg-gray-50 p-3 text-xs sm:grid-cols-3">
                                    <div><span className="block font-mono text-[9px] uppercase text-gray-500">Contact</span><b>{selectedTrialContact.name || 'Unnamed contact'}</b></div>
                                    <div><span className="block font-mono text-[9px] uppercase text-gray-500">Pipeline</span><b>{PIPELINE_LABELS[selectedTrialContact.pipeline_stage || 'new'] || selectedTrialContact.pipeline_stage || 'New'}</b></div>
                                    <div><span className="block font-mono text-[9px] uppercase text-gray-500">Pending bot follow-ups</span><b>{liveTrialStatus?.contact?.id === selectedTrialContact.id ? liveTrialStatus.pending_follow_ups : 0}</b></div>
                                </div>
                            )}

                            <div className="mt-4 flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => void configureLiveTrial(true)}
                                    disabled={liveTrialLoading || !trialContactId || !providerConfigured}
                                    className="btn-wireframe flex items-center gap-2 bg-black px-4 py-2 text-xs font-bold text-white disabled:opacity-40"
                                >
                                    <Power className="h-4 w-4" />
                                    {liveTrialStatus?.enabled ? 'Update allowed contact' : 'Enable one-contact trial'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void configureLiveTrial(false)}
                                    disabled={liveTrialLoading || !trialContactId || !liveTrialStatus?.enabled}
                                    className="btn-wireframe flex items-center gap-2 bg-white px-4 py-2 text-xs font-bold disabled:opacity-40"
                                >
                                    <PowerOff className="h-4 w-4" />
                                    Stop live trial
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void resetLiveTrialContact()}
                                    disabled={liveTrialLoading || !trialContactId}
                                    className="btn-wireframe flex items-center gap-2 bg-white px-4 py-2 text-xs font-bold disabled:opacity-40"
                                >
                                    <RotateCcw className="h-4 w-4" />
                                    Reset selected contact
                                </button>
                            </div>
                            <p className="mt-3 text-[10px] leading-4 text-gray-500">
                                After enabling, send a new message to {selectedPageName} from the selected contact&apos;s Messenger account. Reset clears the bot&apos;s collected details and stop state, cancels pending bot follow-ups, and returns the contact to Engaged. It does not delete Messenger history.
                            </p>
                        </div>

                        <div className="mb-3 flex flex-wrap justify-end gap-2">
                            <button
                                type="button"
                                onClick={previewTestCarousel}
                                disabled={testing}
                                className="btn-wireframe flex items-center justify-center gap-2 bg-white px-3 py-2 text-xs disabled:opacity-40"
                            >
                                <ImageIcon className="h-3.5 w-3.5" />
                                Preview carousel
                            </button>
                            <button
                                type="button"
                                onClick={resetTestConversation}
                                disabled={testing || (testConversation.length === 0 && !testMessage)}
                                className="btn-wireframe flex items-center justify-center gap-2 bg-white px-3 py-2 text-xs disabled:opacity-40"
                            >
                                <RotateCcw className="h-3.5 w-3.5" />
                                New conversation
                            </button>
                        </div>

                        <div className="mb-3 grid gap-3 md:grid-cols-2">
                            <label className="border border-black bg-white p-3">
                                <span className="font-mono text-[10px] font-bold uppercase text-gray-500">Test contact name</span>
                                <input
                                    value={testContactName}
                                    onChange={(event) => setTestContactName(event.target.value.slice(0, 120))}
                                    disabled={testing}
                                    maxLength={120}
                                    className="input-wireframe mt-2 w-full text-sm"
                                    placeholder="Test Customer"
                                />
                                <span className="mt-2 block text-[10px] leading-4 text-gray-500">
                                    The live bot receives each contact&apos;s saved Messenger profile name. Change this value to test personalized replies.
                                </span>
                            </label>
                            <div className="border border-black bg-white p-3">
                                <p className="font-mono text-[10px] font-bold uppercase text-gray-500">Model context tokens</p>
                                {testTokenUsage ? (
                                    <>
                                        <div className="mt-2 flex items-end justify-between gap-3">
                                            <div>
                                                <p className="text-2xl font-bold leading-none">
                                                    {testTokenUsage.remaining_tokens === null ? 'Unavailable' : testTokenUsage.remaining_tokens.toLocaleString()}
                                                </p>
                                                <p className="mt-1 text-[10px] text-gray-500">remaining after the last test request</p>
                                            </div>
                                            {testTokenUsage.context_length !== null && (
                                                <p className="text-right font-mono text-[10px] text-gray-500">
                                                    of {testTokenUsage.context_length.toLocaleString()}
                                                </p>
                                            )}
                                        </div>
                                        <div className="mt-3 grid grid-cols-3 gap-1 border-t border-gray-300 pt-2 text-center">
                                            <div><b className="block text-xs">{testTokenUsage.prompt_tokens.toLocaleString()}</b><span className="text-[9px] uppercase text-gray-500">Prompt</span></div>
                                            <div><b className="block text-xs">{testTokenUsage.completion_tokens.toLocaleString()}</b><span className="text-[9px] uppercase text-gray-500">Reply</span></div>
                                            <div><b className="block text-xs">{testTokenUsage.total_tokens.toLocaleString()}</b><span className="text-[9px] uppercase text-gray-500">Total</span></div>
                                        </div>
                                    </>
                                ) : (
                                    <p className="mt-2 text-xs leading-5 text-gray-500">Send a test message or test follow-up to see exact provider-reported token usage and remaining context.</p>
                                )}
                            </div>
                        </div>

                        {Object.keys(testCollectedDetails).length > 0 && (
                            <div className="mb-3 border border-black bg-white p-3">
                                <p className="mb-2 font-mono text-[10px] font-bold uppercase text-gray-500">Details collected in this test</p>
                                <div className="flex flex-wrap gap-2">
                                    {Object.entries(testCollectedDetails).map(([key, value]) => (
                                        <span key={key} className="border border-gray-400 bg-gray-50 px-2 py-1 text-[11px]">
                                            <b>{key}:</b> {value}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="mb-3 flex h-[420px] flex-col border-2 border-black bg-white">
                            <div className="flex items-center gap-2 border-b border-black bg-gray-100 px-3 py-2">
                                <div className="flex h-7 w-7 items-center justify-center border border-black bg-white">
                                    <Bot className="h-4 w-4" />
                                </div>
                                <div>
                                    <p className="text-xs font-bold">{selectedPageName} chatbot</p>
                                    <p className="font-mono text-[9px] uppercase text-green-700">Test mode · not sent to Messenger</p>
                                </div>
                            </div>
                            <div className="flex-1 space-y-3 overflow-y-auto bg-[#f7f7f7] p-4" aria-live="polite">
                                {testConversation.length === 0 && (
                                    <div className="flex h-full items-center justify-center text-center">
                                        <div className="max-w-sm">
                                            <Bot className="mx-auto h-8 w-8 text-gray-400" />
                                            <p className="mt-3 text-sm font-bold text-gray-700">Start a fresh test conversation</p>
                                            <p className="mt-1 text-xs leading-5 text-gray-500">Ask about a service, price, policy, or pretend to be a lead to test detail collection.</p>
                                        </div>
                                    </div>
                                )}
                                {testConversation.map((chatMessage) => (
                                    <div key={chatMessage.id} className={`flex ${chatMessage.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                        <div className={`max-w-[86%] border-2 border-black px-3 py-2 text-sm leading-5 shadow-[2px_2px_0_rgba(0,0,0,0.16)] ${chatMessage.role === 'user' ? 'bg-black text-white' : 'bg-white text-black'}`}>
                                            {chatMessage.label && (
                                                <p className="mb-1 font-mono text-[9px] font-bold uppercase text-blue-700">{chatMessage.label}</p>
                                            )}
                                            <p className="whitespace-pre-wrap">{chatMessage.content}</p>
                                            {chatMessage.mediaItems && chatMessage.mediaItems.length > 1 && (
                                                <MessengerCarouselPreview mediaItems={chatMessage.mediaItems} />
                                            )}
                                            {chatMessage.media && (!chatMessage.mediaItems || chatMessage.mediaItems.length <= 1) && (
                                                <p className="mt-2 border-t border-gray-300 pt-2 font-mono text-[10px]">
                                                    Would attach: {chatMessage.media.title} ({chatMessage.media.media_type})
                                                </p>
                                            )}
                                            {chatMessage.folder && (
                                                <div className="mt-2 border-t border-gray-300 pt-2">
                                                    <p className="mb-1 font-mono text-[9px] uppercase text-gray-500">
                                                        Would add folder button for {chatMessage.folder.name}
                                                    </p>
                                                    <a
                                                        href={chatMessage.folder.folder_url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="inline-flex items-center gap-1 border border-black bg-white px-3 py-1.5 text-[10px] font-bold hover:bg-gray-100"
                                                    >
                                                        {chatMessage.folder.button_text}
                                                        <ExternalLink className="h-3 w-3" />
                                                    </a>
                                                </div>
                                            )}
                                            {chatMessage.sources && chatMessage.sources.length > 0 && (
                                                <div className="mt-2 border-t border-gray-300 pt-2">
                                                    <p className="mb-1 font-mono text-[9px] uppercase text-gray-500">Knowledge used</p>
                                                    <div className="flex flex-wrap gap-1">
                                                        {chatMessage.sources.map((source) => (
                                                            <span key={source.document_id + ':' + source.similarity} className="border border-gray-300 px-1.5 py-0.5 font-mono text-[9px]">
                                                                {source.title} · {Math.round(source.similarity * 100)}%
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                {testing && (
                                    <div className="flex justify-start">
                                        <div className="border-2 border-black bg-white px-3 py-2 text-xs text-gray-500 shadow-[2px_2px_0_rgba(0,0,0,0.16)]">VeoBot is typing…</div>
                                    </div>
                                )}
                                <div ref={testChatEndRef} />
                            </div>
                        </div>

                        <form
                            className="grid grid-cols-[minmax(0,1fr)_auto] gap-2"
                            onSubmit={(event) => {
                                event.preventDefault();
                                void testChatbot();
                            }}
                        >
                            <textarea
                                value={testMessage}
                                onChange={(event) => setTestMessage(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' && !event.shiftKey) {
                                        event.preventDefault();
                                        void testChatbot();
                                    }
                                }}
                                rows={2}
                                maxLength={2000}
                                disabled={testing}
                                className="input-wireframe max-h-32 min-h-[52px] w-full resize-none px-3 py-2 text-sm leading-5 disabled:bg-gray-100"
                                placeholder="Type a customer message… (Shift + Enter for a new line)"
                                aria-label="Test customer message"
                            />
                            <button
                                type="submit"
                                disabled={testing || !providerConfigured || !testMessage.trim()}
                                className="btn-wireframe flex h-[52px] w-[52px] items-center justify-center bg-black p-0 text-white hover:bg-gray-800 disabled:opacity-40"
                                aria-label="Send test message"
                                title="Send test message"
                            >
                                <Send className="h-5 w-5" />
                            </button>
                        </form>

                        <div className="mt-3 border border-black bg-white p-3">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                <div>
                                    <p className="text-xs font-bold">Preview the next automated follow-up</p>
                                    <p className="mt-1 text-[10px] text-gray-500">Uses this test conversation and your saved AI follow-up instructions. It will not schedule or send anything.</p>
                                </div>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                    <select
                                        value={testFollowUpType}
                                        onChange={(event) => setTestFollowUpType(event.target.value as 'quick' | 'human_agent')}
                                        disabled={testing}
                                        className="input-wireframe h-10 bg-white px-3 text-xs font-semibold"
                                        aria-label="Follow-up preview type"
                                    >
                                        <option value="quick">Quick · first 24 hours</option>
                                        <option value="human_agent">Day 2–7 · Human Agent</option>
                                    </select>
                                    <button
                                        type="button"
                                        onClick={() => void testFollowUp()}
                                        disabled={testing || !providerConfigured || testConversation.length === 0}
                                        className="btn-wireframe flex h-10 items-center justify-center gap-2 bg-white px-4 text-xs font-bold disabled:opacity-40"
                                    >
                                        <Clock3 className="h-4 w-4" />
                                        Test follow-up
                                    </button>
                                </div>
                            </div>
                        </div>
                        {false && testReply && (
                            <div className="mt-4 border-2 border-black bg-white p-4 text-sm leading-6 whitespace-pre-wrap">
                                <p className="font-mono text-[10px] uppercase text-gray-500 mb-1">Bot reply</p>
                                {testReply}
                                {testMedia && (
                                    <p className="mt-3 border-t border-gray-300 pt-2 text-xs font-mono">
                                        Would attach: {testMedia?.title} ({testMedia?.media_type})
                                    </p>
                                )}
                                {testSources.length > 0 && (
                                    <div className="mt-3 pt-2 border-t border-gray-300">
                                        <p className="font-mono text-[10px] uppercase text-gray-500 mb-1">Knowledge used</p>
                                        <div className="flex flex-wrap gap-1">
                                            {testSources.map((source) => (
                                                <span
                                                    key={source.document_id + ':' + source.similarity}
                                                    className="border border-gray-400 px-2 py-1 text-[10px] font-mono"
                                                >
                                                    {source.title} · {Math.round(source.similarity * 100)}%
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}
