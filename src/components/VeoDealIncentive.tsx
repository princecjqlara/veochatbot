'use client';
import { useState } from 'react';
export default function VeoDealIncentive({ kind, id }: { kind: 'receipt' | 'review'; id: string }) {
    const [data, setData] = useState<any>(null), [percent, setPercent] = useState(''), [reason, setReason] = useState(''), [saveReason, setSaveReason] = useState(false), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [request, setRequest] = useState('');
    async function load() {
        setBusy(true); try {
            const r = await fetch('/api/workspace/incentives?' + new URLSearchParams({ kind, id }), { cache: 'no-store' }), b = await r.json();
            if (!r.ok) throw Error(b.error); setData(b); setPercent(String(b.incentive?.percent || '')); setReason(b.incentive?.reason || ''); setRequest(crypto.randomUUID());
        } catch (e: any) { setMessage(e.message); } finally { setBusy(false); }
    }
    return <details onToggle={e => { if (e.currentTarget.open && !data && !busy) void load(); }} className="rounded border border-indigo-200 p-3">
        <summary className="cursor-pointer text-sm font-medium">Optional deal incentive</summary>
        <p className="mt-2 text-sm">Extra percentage of verified paid principal, added to normal commission when the deal qualifies for salary. Tips excluded. One incentive per order, shared by Close and Done Deal receipts.</p>
        {data?.incentive && <p className="text-sm">Current: +{data.incentive.percent}% · {data.incentive.reason}</p>}
        {data && !data.can_edit && <p className="text-sm">A Manager or Team Leader can award this after approval and order linking.</p>}
        {data?.can_edit && <form className="mt-3 space-y-2" onSubmit={async e => {
            e.preventDefault(); setBusy(true); setMessage('');
            try {
                const r = await fetch('/api/workspace/incentives', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, id, percent: Number(percent), reason, expected_version: data.incentive?.version || 0, request_id: request, save_reason: saveReason }) }), b = await r.json();
                if (!r.ok) throw Error(b.error); setData(b); setRequest(crypto.randomUUID()); setMessage('Incentive saved. Telegram notification will queue automatically when the team route is ready.');
            } catch (e: any) { setMessage(e.message); } finally { setBusy(false); }
        }}>
            <label className="block text-sm">Extra percentage<input aria-label="Incentive percentage" className="ml-2 rounded border p-2" type="number" required min="0" max="60" step="0.01" value={percent} onChange={e => setPercent(e.target.value)} /></label>
            {!!data.saved_reasons?.length && <label className="block text-sm">Saved reason<select className="ml-2 max-w-full rounded border p-2" value="" onChange={e => setReason(e.target.value)}><option value="">Choose a saved reason</option>{data.saved_reasons.map((r: string) => <option key={r} value={r}>{r}</option>)}</select></label>}
            <label className="block text-sm">Reason<textarea required minLength={3} maxLength={500} className="block w-full rounded border p-2" value={reason} onChange={e => setReason(e.target.value)} /></label>
            <label className="block text-sm"><input type="checkbox" checked={saveReason} onChange={e => setSaveReason(e.target.checked)} /> Save reason for reuse</label>
            <p className="text-xs">Saving replaces the existing percentage. Enter 0% with a reason to remove it.</p>
            <button disabled={busy || !percent} className="rounded bg-indigo-700 px-3 py-2 text-sm text-white disabled:opacity-40">Save incentive</button>
        </form>}{message && <p role="status" className="mt-2 text-sm">{message}</p>}
    </details>;
}
