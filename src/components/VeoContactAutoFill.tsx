'use client';
import { useEffect, useRef, useState } from 'react';
import { startAdaptivePolling } from '@/lib/adaptive-polling';
export default function VeoContactAutoFill({ contactId, data, onChanged }: { contactId: string; data: any; onChanged: () => Promise<any> }) {
    const [current, setCurrent] = useState(data), [label, setLabel] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const active = useRef(contactId); active.current = contactId;
    useEffect(() => { setCurrent(data); }, [contactId, data]);
    useEffect(() => { setLabel(''); setMessage(''); setBusy(false); }, [contactId]);
    useEffect(() => {
        if (!['queued', 'processing'].includes(current?.analysis?.status)) return;
        return startAdaptivePolling(async signal => {
            try {
                const response = await fetch('/api/workspace/profile-details?contact_id=' + contactId, { cache: 'no-store', signal });
                const body = await response.json(); if (!response.ok) throw Error(body.error);
                if (active.current !== contactId || signal.aborted) return;
                setCurrent(body);
                if (body.analysis?.analyzed_at && body.analysis.analyzed_at !== current?.analysis?.analyzed_at) await onChanged();
            } catch (e: any) { if (active.current === contactId && !signal.aborted) setMessage(e.message); throw e; }
        }, { intervalMs: 15000 });
    }, [contactId, current?.analysis?.status, current?.analysis?.analyzed_at, onChanged]);
    async function submit(action: 'request' | 'refresh') {
        const requested = contactId; setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/workspace/profile-details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: requested, action, label }) });
            const body = await response.json(); if (!response.ok) throw Error(body.error);
            if (active.current !== requested) return;
            setCurrent(body); setLabel(''); setMessage(body.duplicate ? 'This detail is already tracked; the existing field and value are retained.' : 'Chatbot profile auto-fill queued from saved customer messages.');
            await onChanged();
        } catch (e: any) { if (active.current === requested) setMessage(e.message); }
        finally { if (active.current === requested) setBusy(false); }
    }
    return <section className="rounded-xl border bg-white p-5 space-y-3" aria-label="Chatbot profile auto-fill"><div className="flex flex-wrap justify-between gap-3"><h2 className="font-semibold">Chatbot profile auto-fill</h2><button disabled={busy || ['queued', 'processing'].includes(current?.analysis?.status)} className="text-sm underline disabled:opacity-40" onClick={() => void submit('refresh')}>Auto-fill from customer messages</button></div><p className="text-xs text-slate-500">Purpose, problems, stated contact time and requested customer answers fill automatically when supported by customer messages. Manual corrections and saved answers take priority. Verified payments and lead stages use their existing records.</p><p className="text-xs text-slate-600">Status: {current?.analysis?.status || 'Not analyzed'}{current?.analysis?.analyzed_at && ` · ${new Date(current.analysis.analyzed_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`}{current?.analysis?.last_error && ` · ${current.analysis.last_error}`}</p>{message && <p role="status" className="text-sm">{message}</p>}
        <form className="flex flex-wrap gap-2 items-end" onSubmit={e => { e.preventDefault(); void submit('request'); }}><label className="text-sm flex-1 min-w-48">Additional detail for the chatbot to fill<input aria-label="Additional detail for chatbot" className="block w-full rounded border p-2 mt-1" maxLength={80} minLength={2} required value={label} placeholder="e.g. Delivery deadline or preferred video style" onChange={e => setLabel(e.target.value)} /></label><button disabled={busy} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40">Add auto-fill detail</button></form>
        {!!current?.requested_fields?.length && <div className="flex flex-wrap gap-2 text-xs">{current.requested_fields.map((f: any) => <span className="rounded bg-slate-100 px-2 py-1" key={f.key}>{f.label} · {current.fields?.find((v: any) => v.key === f.key)?.value && current.fields.find((v: any) => v.key === f.key).value !== 'Unknown' ? 'Filled' : 'Unknown'}</span>)}</div>}
        <p className="text-xs text-slate-500">New messages update the profile automatically. Unknown answers remain unknown until the customer provides them. This adds a profile detail to extract; Page-wide questions the bot asks are configured in AI Chatbot settings.</p>
    </section>;
}
