'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, Filter, GitBranch, RefreshCw, Search, Users } from 'lucide-react';
import Pagination from '@/components/Pagination';
import type { Page } from '@/types';
import {
    CONTACT_PIPELINE_LABELS,
    CONTACT_PIPELINE_STAGES,
    type ContactPipelineStage
} from '@/lib/contact-pipeline';

type ChatbotState = {
    status: 'active' | 'stopped';
    collected_details: Record<string, string> | null;
    missing_details: string[] | null;
    stop_reason: string | null;
    last_inbound_at: string | null;
    last_bot_reply_at: string | null;
    updated_at: string;
};

type PipelineContact = {
    id: string;
    psid: string;
    name: string | null;
    profile_pic: string | null;
    last_interaction_at: string | null;
    pipeline_stage: ContactPipelineStage;
    pipeline_stage_source: 'system' | 'chatbot' | 'messenger' | 'manual';
    pipeline_stage_updated_at: string;
    chatbot_state: ChatbotState | null;
};

type PipelineResponse = {
    contacts: PipelineContact[];
    page: number;
    pageSize: number;
    total: number;
    stageCounts: Record<ContactPipelineStage, number>;
};

const STAGE_COLORS: Record<ContactPipelineStage, string> = {
    new: 'bg-gray-100 text-gray-800 border-gray-400',
    engaged: 'bg-blue-50 text-blue-800 border-blue-400',
    collecting_details: 'bg-cyan-50 text-cyan-800 border-cyan-500',
    qualified: 'bg-amber-50 text-amber-900 border-amber-500',
    order_created: 'bg-orange-50 text-orange-900 border-orange-500',
    converted: 'bg-green-50 text-green-900 border-green-600',
    not_qualified: 'bg-red-50 text-red-800 border-red-400',
    opted_out: 'bg-slate-100 text-slate-700 border-slate-500'
};

const emptyCounts = Object.fromEntries(CONTACT_PIPELINE_STAGES.map((stage) => [stage, 0])) as Record<ContactPipelineStage, number>;

const FUNNEL_STAGES: ContactPipelineStage[] = [
    'new', 'engaged', 'collecting_details', 'qualified', 'order_created', 'converted'
];
const OUTCOME_STAGES: ContactPipelineStage[] = ['not_qualified', 'opted_out'];
const FUNNEL_WIDTHS = [100, 92, 84, 76, 68, 60];

function formatDate(value: string | null) {
    if (!value) return '—';
    return new Intl.DateTimeFormat(undefined, {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    }).format(new Date(value));
}

function formatDetailLabel(value: string) {
    return value
        .replaceAll('_', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function contactReadiness(state: ChatbotState | null) {
    if (!state) {
        return {
            label: 'Bot not started',
            description: 'No chatbot conversation yet',
            className: 'border-gray-400 bg-gray-50 text-gray-700',
            icon: CircleDashed
        };
    }

    const collectedCount = Object.values(state.collected_details || {})
        .filter((value) => typeof value === 'string' && value.trim().length > 0).length;
    const missingCount = state.missing_details?.length || 0;

    if (collectedCount > 0 && missingCount === 0) {
        return {
            label: 'Contact details complete',
            description: `${collectedCount} detail${collectedCount === 1 ? '' : 's'} available`,
            className: 'border-green-700 bg-green-50 text-green-900',
            icon: CheckCircle2
        };
    }

    if (missingCount > 0) {
        return {
            label: 'Needs more details',
            description: `${missingCount} field${missingCount === 1 ? '' : 's'} still missing`,
            className: 'border-amber-600 bg-amber-50 text-amber-900',
            icon: AlertCircle
        };
    }

    return {
        label: 'No details yet',
        description: 'Waiting for contact information',
        className: 'border-blue-500 bg-blue-50 text-blue-900',
        icon: CircleDashed
    };
}

export default function PipelinePage() {
    const [pages, setPages] = useState<Page[]>([]);
    const [pageId, setPageId] = useState('');
    const [contacts, setContacts] = useState<PipelineContact[]>([]);
    const [counts, setCounts] = useState(emptyCounts);
    const [stage, setStage] = useState<ContactPipelineStage | 'all'>('all');
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [savingContactId, setSavingContactId] = useState('');
    const [expandedContactId, setExpandedContactId] = useState('');

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setSearch(searchInput.trim());
            setPage(1);
        }, 300);
        return () => window.clearTimeout(timer);
    }, [searchInput]);

    useEffect(() => {
        void fetch('/api/pages')
            .then(async (response) => {
                if (!response.ok) throw new Error('Could not load your Pages');
                return response.json();
            })
            .then((data) => {
                const availablePages = data.pages || [];
                setPages(availablePages);
                setPageId((current) => current || availablePages[0]?.id || '');
                if (availablePages.length === 0) setLoading(false);
            })
            .catch((fetchError) => {
                setError(fetchError.message);
                setLoading(false);
            });
    }, []);

    const loadPipeline = useCallback(async () => {
        if (!pageId) return;
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
            if (stage !== 'all') params.set('stage', stage);
            if (search) params.set('search', search);
            const response = await fetch(`/api/pages/${pageId}/pipeline?${params}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not load the pipeline');
            const pipeline = data as PipelineResponse;
            setContacts(pipeline.contacts);
            setCounts(pipeline.stageCounts);
            setTotal(pipeline.total);
        } catch (fetchError) {
            setError(fetchError instanceof Error ? fetchError.message : 'Could not load the pipeline');
        } finally {
            setLoading(false);
        }
    }, [pageId, page, pageSize, stage, search]);

    useEffect(() => { void loadPipeline(); }, [loadPipeline]);

    const totalContacts = useMemo(
        () => Object.values(counts).reduce((sum, count) => sum + count, 0),
        [counts]
    );

    async function updateStage(contactId: string, nextStage: ContactPipelineStage) {
        const previous = contacts;
        setSavingContactId(contactId);
        setContacts((items) => items.map((contact) => contact.id === contactId
            ? { ...contact, pipeline_stage: nextStage, pipeline_stage_source: 'manual', pipeline_stage_updated_at: new Date().toISOString() }
            : contact));
        try {
            const response = await fetch(`/api/pages/${pageId}/pipeline`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ contact_id: contactId, stage: nextStage })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Could not update stage');
            await loadPipeline();
        } catch (updateError) {
            setContacts(previous);
            setError(updateError instanceof Error ? updateError.message : 'Could not update stage');
        } finally {
            setSavingContactId('');
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                    <div className="flex items-center gap-3">
                        <GitBranch className="h-7 w-7" />
                        <h1 className="text-2xl font-bold text-black">Contact Pipeline</h1>
                    </div>
                    <p className="mt-2 text-sm text-gray-600">
                        Chatbot progress and Messenger lead events move contacts automatically. Every Page collaborator can review and edit stages.
                    </p>
                </div>
                <div className="flex gap-2">
                    <select
                        value={pageId}
                        onChange={(event) => { setPageId(event.target.value); setPage(1); }}
                        className="h-10 min-w-48 border border-black bg-white px-3 text-sm font-semibold"
                    >
                        {pages.map((connectedPage) => <option key={connectedPage.id} value={connectedPage.id}>{connectedPage.name}</option>)}
                    </select>
                    <button onClick={() => void loadPipeline()} disabled={loading || !pageId} className="btn-wireframe flex h-10 items-center gap-2 bg-white">
                        <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
                    </button>
                </div>
            </div>

            <section className="border-2 border-black bg-white p-4 md:p-5">
                <div className="mb-4 flex flex-col gap-2 border-b border-gray-300 pb-4 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                        <div className="flex items-center gap-2">
                            <Filter className="h-5 w-5" />
                            <h2 className="font-bold">Live pipeline funnel</h2>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">Current contact stage snapshot. Select a stage to filter the contact list below.</p>
                    </div>
                    <div className="font-mono text-xs text-gray-500"><b className="text-lg text-black">{totalContacts.toLocaleString()}</b> contacts</div>
                </div>

                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_250px]">
                    <div className="flex flex-col items-center gap-1" aria-label="Active sales funnel stages">
                        {FUNNEL_STAGES.map((pipelineStage, index) => {
                            const count = counts[pipelineStage] || 0;
                            const share = totalContacts > 0 ? Math.round((count / totalContacts) * 100) : 0;
                            return (
                                <button
                                    key={pipelineStage}
                                    type="button"
                                    aria-pressed={stage === pipelineStage}
                                    onClick={() => { setStage(stage === pipelineStage ? 'all' : pipelineStage); setPage(1); }}
                                    style={{ width: `${FUNNEL_WIDTHS[index]}%` }}
                                    className={`min-h-14 border px-8 py-2 transition-all hover:brightness-95 ${STAGE_COLORS[pipelineStage]} ${stage === pipelineStage ? 'ring-2 ring-black ring-offset-2' : ''}`}
                                >
                                    <span className="flex items-center justify-between gap-4">
                                        <span className="text-left">
                                            <span className="block text-[10px] font-bold uppercase tracking-wide opacity-70">Stage {index + 1}</span>
                                            <span className="block text-xs font-black uppercase sm:text-sm">{CONTACT_PIPELINE_LABELS[pipelineStage]}</span>
                                        </span>
                                        <span className="text-right">
                                            <span className="block text-xl font-black leading-none">{count.toLocaleString()}</span>
                                            <span className="font-mono text-[10px] opacity-70">{share}% of all</span>
                                        </span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>

                    <div className="border border-black bg-gray-50 p-3">
                        <p className="font-mono text-[10px] font-bold uppercase text-gray-500">Exit outcomes</p>
                        <div className="mt-3 grid gap-2">
                            {OUTCOME_STAGES.map((pipelineStage) => (
                                <button
                                    key={pipelineStage}
                                    type="button"
                                    aria-pressed={stage === pipelineStage}
                                    onClick={() => { setStage(stage === pipelineStage ? 'all' : pipelineStage); setPage(1); }}
                                    className={`border p-3 text-left hover:shadow-[2px_2px_0_#000] ${STAGE_COLORS[pipelineStage]} ${stage === pipelineStage ? 'ring-2 ring-black ring-offset-1' : ''}`}
                                >
                                    <span className="block text-2xl font-black">{(counts[pipelineStage] || 0).toLocaleString()}</span>
                                    <span className="mt-1 block text-[11px] font-bold uppercase">{CONTACT_PIPELINE_LABELS[pipelineStage]}</span>
                                </button>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={() => { setStage('all'); setPage(1); }}
                            className="mt-3 w-full border border-black bg-white px-3 py-2 text-xs font-bold hover:bg-gray-100"
                        >
                            Show all stages
                        </button>
                    </div>
                </div>
            </section>

            <div className="flex flex-col gap-3 border border-black bg-gray-50 p-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-500" />
                    <input
                        value={searchInput}
                        onChange={(event) => setSearchInput(event.target.value)}
                        placeholder="Search contact name or Messenger ID"
                        className="h-9 w-full border border-black bg-white pl-9 pr-3 text-sm outline-none"
                    />
                </div>
                <select
                    value={stage}
                    onChange={(event) => { setStage(event.target.value as ContactPipelineStage | 'all'); setPage(1); }}
                    className="h-9 border border-black bg-white px-3 text-sm font-semibold"
                >
                    <option value="all">All stages ({totalContacts})</option>
                    {CONTACT_PIPELINE_STAGES.map((pipelineStage) => (
                        <option key={pipelineStage} value={pipelineStage}>{CONTACT_PIPELINE_LABELS[pipelineStage]} ({counts[pipelineStage] || 0})</option>
                    ))}
                </select>
            </div>

            {error && <div className="border border-red-600 bg-red-50 p-3 text-sm text-red-800">{error}</div>}

            <div className="overflow-x-auto border-2 border-black bg-white">
                <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
                    <thead className="bg-black text-white">
                        <tr>
                            <th className="p-3">Contact</th>
                            <th className="p-3">Current stage</th>
                            <th className="w-[36%] p-3">Details gathered by bot</th>
                            <th className="p-3">Bot status</th>
                            <th className="p-3">Last activity</th>
                        </tr>
                    </thead>
                    <tbody>
                        {!loading && contacts.map((contact) => {
                            const collectedDetails = Object.entries(contact.chatbot_state?.collected_details || {})
                                .filter(([, value]) => typeof value === 'string' && value.trim().length > 0);
                            const collectedCount = collectedDetails.length;
                            const missingCount = contact.chatbot_state?.missing_details?.length || 0;
                            const readiness = contactReadiness(contact.chatbot_state);
                            const ReadinessIcon = readiness.icon;
                            const expanded = expandedContactId === contact.id;
                            return (
                                <Fragment key={contact.id}>
                                    <tr className="border-b border-gray-300 align-top hover:bg-gray-50">
                                        <td className="p-3">
                                            <div className="flex items-center gap-3">
                                                {contact.profile_pic ? (
                                                    <img src={contact.profile_pic} alt="" className="h-10 w-10 border border-black object-cover" />
                                                ) : (
                                                    <div className="flex h-10 w-10 items-center justify-center border border-black bg-gray-100"><Users className="h-4 w-4" /></div>
                                                )}
                                                <div className="min-w-0">
                                                    <div className="max-w-52 truncate font-semibold text-black">{contact.name || 'Messenger Contact'}</div>
                                                    <div className="max-w-52 truncate font-mono text-[10px] text-gray-500" title={contact.psid}>{contact.psid}</div>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="p-3">
                                            <select
                                                value={contact.pipeline_stage}
                                                disabled={savingContactId === contact.id}
                                                onChange={(event) => void updateStage(contact.id, event.target.value as ContactPipelineStage)}
                                                className={`h-9 min-w-40 border px-2 text-xs font-bold ${STAGE_COLORS[contact.pipeline_stage]}`}
                                            >
                                                {CONTACT_PIPELINE_STAGES.map((pipelineStage) => <option key={pipelineStage} value={pipelineStage}>{CONTACT_PIPELINE_LABELS[pipelineStage]}</option>)}
                                            </select>
                                            <div className="mt-2 text-[10px] text-gray-500">
                                                <span className="font-bold uppercase">{contact.pipeline_stage_source}</span> · {formatDate(contact.pipeline_stage_updated_at)}
                                            </div>
                                        </td>
                                        <td className="p-3">
                                            <div className={`mb-2 inline-flex items-center gap-1.5 border px-2 py-1 text-[11px] font-bold ${readiness.className}`}>
                                                <ReadinessIcon className="h-3.5 w-3.5" />
                                                {readiness.label}
                                            </div>
                                            <div className="mb-2 text-[10px] text-gray-500">{readiness.description}</div>
                                            {collectedCount > 0 ? (
                                                <div className="flex flex-wrap gap-1.5">
                                                    {collectedDetails.slice(0, 3).map(([key, value]) => (
                                                        <span key={key} className="max-w-64 truncate border border-green-700 bg-green-50 px-2 py-1 text-[11px] text-green-900" title={`${formatDetailLabel(key)}: ${value}`}>
                                                            <b>{formatDetailLabel(key)}:</b> {value}
                                                        </span>
                                                    ))}
                                                    {collectedCount > 3 && <span className="border border-gray-400 bg-gray-50 px-2 py-1 text-[11px] font-bold">+{collectedCount - 3} more</span>}
                                                </div>
                                            ) : (
                                                <div className="text-xs text-gray-400">
                                                    {contact.chatbot_state ? 'No requested details gathered yet' : 'No bot activity yet'}
                                                </div>
                                            )}
                                            {contact.chatbot_state && (collectedCount > 0 || missingCount > 0) && (
                                                <button
                                                    type="button"
                                                    onClick={() => setExpandedContactId(expanded ? '' : contact.id)}
                                                    className="mt-2 flex items-center gap-1 text-[11px] font-bold underline underline-offset-2"
                                                >
                                                    {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                                    {expanded ? 'Hide contact details' : 'View all gathered details'}
                                                </button>
                                            )}
                                        </td>
                                        <td className="p-3">
                                            {contact.chatbot_state ? (
                                                <div className="space-y-2 text-xs">
                                                    <span className={`inline-flex items-center gap-1 border px-2 py-1 font-bold uppercase ${contact.chatbot_state.status === 'active' ? 'border-green-600 bg-green-50 text-green-800' : 'border-gray-500 bg-gray-100 text-gray-700'}`}>
                                                        <Bot className="h-3 w-3" /> {contact.chatbot_state.status}
                                                    </span>
                                                    <div><b>{collectedCount}</b> collected · <b>{missingCount}</b> missing</div>
                                                    {contact.chatbot_state.stop_reason && <div className="text-gray-600">Stopped: {contact.chatbot_state.stop_reason.replaceAll('_', ' ')}</div>}
                                                </div>
                                            ) : <span className="text-xs text-gray-400">Not started</span>}
                                        </td>
                                        <td className="p-3 text-xs text-gray-700">
                                            <div>{formatDate(contact.last_interaction_at)}</div>
                                            {contact.chatbot_state?.last_bot_reply_at && (
                                                <div className="mt-2 text-[10px] text-gray-500">Bot replied {formatDate(contact.chatbot_state.last_bot_reply_at)}</div>
                                            )}
                                        </td>
                                    </tr>
                                    {expanded && (
                                        <tr className="border-b border-black bg-[#f7fbf8]">
                                            <td colSpan={5} className="p-4 md:p-5">
                                                <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
                                                    <div>
                                                        <h3 className="text-sm font-bold">Details gathered from {contact.name || 'this contact'}</h3>
                                                        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                                            {collectedDetails.map(([key, value]) => (
                                                                <div key={key} className="border border-green-700 bg-white p-3">
                                                                    <p className="font-mono text-[10px] font-bold uppercase text-green-800">{formatDetailLabel(key)}</p>
                                                                    <p className="mt-1 break-words text-sm text-black">{value}</p>
                                                                </div>
                                                            ))}
                                                            {collectedCount === 0 && (
                                                                <p className="text-xs text-gray-500">The bot has not gathered any contact details yet.</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="border border-black bg-white p-3">
                                                        <p className="font-mono text-[10px] font-bold uppercase text-gray-500">Still missing</p>
                                                        {missingCount > 0 ? (
                                                            <div className="mt-2 flex flex-wrap gap-1.5">
                                                                {contact.chatbot_state?.missing_details?.map((detail) => (
                                                                    <span key={detail} className="border border-amber-500 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">{formatDetailLabel(detail)}</span>
                                                                ))}
                                                            </div>
                                                        ) : <p className="mt-2 text-xs font-semibold text-green-700">No missing requested details.</p>}
                                                        <dl className="mt-4 space-y-2 border-t border-gray-300 pt-3 text-xs">
                                                            <div className="flex justify-between gap-3"><dt className="text-gray-500">Last customer message</dt><dd className="text-right font-semibold">{formatDate(contact.chatbot_state?.last_inbound_at || null)}</dd></div>
                                                            <div className="flex justify-between gap-3"><dt className="text-gray-500">Last bot reply</dt><dd className="text-right font-semibold">{formatDate(contact.chatbot_state?.last_bot_reply_at || null)}</dd></div>
                                                            <div className="flex justify-between gap-3"><dt className="text-gray-500">Bot record updated</dt><dd className="text-right font-semibold">{formatDate(contact.chatbot_state?.updated_at || null)}</dd></div>
                                                        </dl>
                                                    </div>
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
                        {loading && <tr><td colSpan={5} className="p-10 text-center text-gray-500">Loading pipeline…</td></tr>}
                        {!loading && contacts.length === 0 && <tr><td colSpan={5} className="p-10 text-center text-gray-500">No contacts match this view.</td></tr>}
                    </tbody>
                </table>
            </div>

            <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
            />
        </div>
    );
}
