'use client';
import { useEffect, useState } from 'react';
export default function VeoQuotaPolicy({ accounts }: { accounts: any[] }) {
    const workers = accounts.filter(a => a.active !== false && ['member', 'manager'].includes(a.role));
    const [worker, setWorker] = useState(''), [policy, setPolicy] = useState<any>(null), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => {
        setPolicy(null); if (!worker) return; const c = new AbortController();
        fetch('/api/workspace/quota-policy?worker_id=' + worker, { cache: 'no-store', signal: c.signal }).then(async r => { const b = await r.json(); if (!r.ok) throw Error(b.error); if (!c.signal.aborted) setPolicy(b.policy); }).catch(e => { if (!c.signal.aborted) setMessage(e.message); });
        return () => c.abort();
    }, [worker]);
    return <details className="rounded border bg-white p-4"><summary className="cursor-pointer font-semibold">Flexible quota settings</summary>
        <p className="my-2 text-sm">Daily base = capacity capped by funded clients and existing paid work. Unfinished quota carries forward, but only available work can raise tomorrow’s target. Unfunded carryover stays deferred within the carryover limit. Today stays provisional as spend changes.</p>
        <label className="block text-sm">Employee<select className="ml-2 rounded border p-2" value={worker} onChange={e => setWorker(e.target.value)}><option value="">Choose an employee</option>{workers.map(a => <option key={a.id || a.user_id} value={a.id || a.user_id}>{a.name}</option>)}</select></label>
        {policy && <form key={worker} className="mt-3 space-y-2" onSubmit={async e => {
            e.preventDefault(); setBusy(true); setMessage(''); const f = new FormData(e.currentTarget);
            try {
                const r = await fetch('/api/workspace/quota-policy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker_id: worker, carry_enabled: f.get('carry') === 'on', max_carry: Number(f.get('max')), capacity_multiplier: Number(f.get('multiplier')), fallback_cpa_minor: Math.round(Number(f.get('cpa')) * 100) }) }), b = await r.json();
                if (!r.ok) throw Error(b.error); setPolicy(b.policy); setMessage('Saved. Current and future quotas use these settings; completed days stay unchanged.');
            } catch (e: any) { setMessage(e.message); } finally { setBusy(false); }
        }}>
            <label className="block text-sm"><input type="checkbox" name="carry" defaultChecked={policy.carry_enabled} /> Carry unfinished quota to the next day</label>
            <label className="block text-sm">Maximum carried deals<input className="ml-2 rounded border p-2" name="max" required type="number" min="0" max="100" defaultValue={policy.max_carry} /></label>
            <label className="block text-sm">Daily capacity ceiling ×<input className="ml-2 rounded border p-2" name="multiplier" required type="number" min="1" max="3" step="0.1" defaultValue={policy.capacity_multiplier} /></label>
            <label className="block text-sm">Estimated cost per paying client (PHP)<input className="ml-2 rounded border p-2" name="cpa" required type="number" min="1" max="1000000" step="0.01" defaultValue={Number(policy.fallback_cpa_minor) / 100} /></label>
            <p className="text-xs text-slate-500">The estimate is used only when there is no observed 14-day acquisition cost. Spend is shared across eligible selling staff on each Page. Missing ad data is shown as unknown and never treated as zero spend. Both CD and DD use the larger unfinished target, so the same deal is not carried twice.</p>
            <button disabled={busy} className="rounded bg-indigo-700 px-3 py-2 text-sm text-white disabled:opacity-40">Save quota settings</button>
        </form>}{message && <p role="status" className="mt-2 text-sm">{message}</p>}
    </details>;
}
