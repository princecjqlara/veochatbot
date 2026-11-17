'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';

const field = 'block w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm';
const button = 'rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40';
const pht = (value: string) => new Date(value).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }) + ' PHT';
const minutes = (amount: string, unit: string) => Number(amount) * Number(unit);

export default function VeoDisciplineControls({ workers, policy, onChanged }: { workers: any[]; policy: any; onChanged: () => void }) {
    const members = workers.filter(w => w.role === 'member' && w.active !== false);
    const [member, setMember] = useState(''), [action, setAction] = useState('issue'), [reason, setReason] = useState(''), [warning, setWarning] = useState('');
    const [release, setRelease] = useState('manual'), [amount, setAmount] = useState('1'), [unit, setUnit] = useState('1440');
    const [limit, setLimit] = useState(String(policy.warning_limit || 3)), [automatic, setAutomatic] = useState(policy.auto_suspend === true);
    const [policyRelease, setPolicyRelease] = useState(policy.suspension_minutes == null ? 'manual' : 'timed'), [policyMinutes, setPolicyMinutes] = useState(String(policy.suspension_minutes || 1440));
    const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const requests = useRef(new Map<string, string>());
    const selected = members.find(w => w.id === member), suspension = selected?.suspension;
    const removable = (selected?.warnings || []).filter((w: any) => w.severity === 'warning');
    useEffect(() => {
        setLimit(String(policy.warning_limit || 3));setAutomatic(policy.auto_suspend === true);
        setPolicyRelease(policy.suspension_minutes == null ? 'manual' : 'timed');setPolicyMinutes(String(policy.suspension_minutes || 1440));
    }, [policy.warning_limit, policy.auto_suspend, policy.suspension_minutes]);
    useEffect(() => { setReason('');setWarning('');setAction(selected?.suspension ? 'lift' : 'issue'); }, [member]); // eslint-disable-line react-hooks/exhaustive-deps

    async function save(payload: any, success: string) {
        const key = JSON.stringify(payload);
        if (['issue', 'suspend'].includes(payload.action)) {
            if (!requests.current.has(key)) requests.current.set(key, crypto.randomUUID());
            payload = { ...payload, request_id: requests.current.get(key) };
        }
        setBusy(true);setMessage('');
        try {
            const response = await fetch('/api/workspace/warnings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            const body = await response.json();
            if (!response.ok) throw Error(body.error || 'Could not save this change');
            requests.current.delete(key);setReason('');setMessage(body.suspension ? success + ' The member is now suspended.' : success);onChanged();
        } catch (error: any) { setMessage(error.message); } finally { setBusy(false); }
    }
    function submit(e: FormEvent) {
        e.preventDefault();
        const payload: any = { action, user_id: member, reason };
        if (action === 'remove') payload.source_key = warning;
        if (action === 'suspend') payload.duration_minutes = release === 'manual' ? null : minutes(amount, unit);
        if (action === 'lift') payload.suspension_id = suspension?.id;
        void save(payload, action === 'issue' ? 'Warning recorded.' : action === 'remove' ? 'Warning removed from the member’s active record.' : action === 'lift' ? 'Suspension lifted. The member can use their account again.' : 'Suspension saved. Account access is blocked.');
    }
    return <section aria-label="Member warning and suspension controls" className="space-y-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
        <div><h3 className="font-semibold">Member warnings and suspensions</h3><p className="mt-1 text-xs text-slate-600">Manage members in your branch. Managers and Team Leaders are exempt. Changes retain an audit record and do not deduct earned salary.</p></div>
        {message && <p role="status" className="rounded border bg-white p-3 text-sm">{message}</p>}
        <details className="rounded border bg-white p-3"><summary className="cursor-pointer font-medium text-sm">Set my team’s warning limit</summary>
            <form className="mt-3 space-y-3" onSubmit={e => { e.preventDefault();void save({ action: 'policy', warning_limit: Number(limit), auto_suspend: automatic, suspension_minutes: policyRelease === 'manual' ? null : Number(policyMinutes) }, 'Warning policy saved and applied to current member warnings.'); }}>
                <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm">Warnings before suspension<input aria-label="Warnings before suspension" required type="number" min="1" max="100" step="1" className={field} value={limit} onChange={e => setLimit(e.target.value)} /></label>
                    <label className="text-sm">Default suspension ending<select aria-label="Default suspension ending" className={field} value={policyRelease} onChange={e => setPolicyRelease(e.target.value)}><option value="manual">Until a supervisor lifts it</option><option value="timed">After a set duration</option></select></label>
                    {policyRelease === 'timed' && <label className="text-sm">Suspension duration in minutes<input aria-label="Policy suspension minutes" required type="number" min="1" max="525600" step="1" className={field} value={policyMinutes} onChange={e => setPolicyMinutes(e.target.value)} /></label>}
                    <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={automatic} onChange={e => setAutomatic(e.target.checked)} />Automatically suspend members who reach this limit</label>
                    <p className="text-xs text-slate-600 sm:col-span-2">A member uses their Manager’s saved rule first, then their Team Leader’s rule. Turning automatic suspension on also applies to current warnings. With it off, supervisors suspend members manually.</p>
                    <button className={button + ' sm:col-span-2'}>Save policy and apply to current warnings</button>
                </fieldset>
            </form>
        </details>
        <form onSubmit={submit} className="space-y-3">
            <fieldset disabled={busy} className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                    <label className="text-sm">Member<select aria-label="Discipline member" required className={field} value={member} onChange={e => setMember(e.target.value)}><option value="">Choose a member</option>{members.map(w => <option key={w.id} value={w.id}>{w.name}{w.suspension ? ' — suspended' : ''}</option>)}</select></label>
                    <label className="text-sm">Action<select aria-label="Discipline action" className={field} value={action} onChange={e => { setAction(e.target.value);setReason(''); }}><option value="issue" disabled={!!suspension}>Issue a warning</option><option value="remove" disabled={!removable.length}>Remove a warning</option><option value="suspend" disabled={!!suspension}>Suspend member</option><option value="lift" disabled={!suspension}>Lift suspension</option></select></label>
                </div>
                {selected && <div className="rounded border bg-white p-3 text-sm"><p><strong>{selected.name}</strong>: {selected.warning_count || 0} warnings toward the next suspension · Limit: {selected.discipline_policy?.warning_limit || 3}</p>
                    <p className="mt-1 text-xs">{selected.discipline_policy?.auto_suspend ? 'Automatic suspension is enabled.' : 'Suspension requires a supervisor’s manual action.'}</p>
                    {suspension && <p className="mt-2 text-red-800">Suspended: {suspension.reason}. {suspension.ends_at ? 'Ends ' + pht(suspension.ends_at) : 'A Manager or Team Leader must lift it.'}</p>}
                </div>}
                {action === 'remove' && <label className="block text-sm">Warning to remove<select aria-label="Warning to remove" required className={field} value={warning} onChange={e => setWarning(e.target.value)}><option value="">Choose a warning</option>{removable.map((w: any) => <option key={w.key} value={w.key}>{w.title}</option>)}</select></label>}
                {action === 'suspend' && <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">Suspension ending<select aria-label="Suspension ending" className={field} value={release} onChange={e => setRelease(e.target.value)}><option value="manual">Until manually lifted</option><option value="timed">After a set duration</option></select></label>
                    {release === 'timed' && <><label className="text-sm">Duration<input aria-label="Suspension duration" required type="number" min="1" max="525600" step="1" className={field} value={amount} onChange={e => setAmount(e.target.value)} /></label><label className="text-sm">Unit<select aria-label="Suspension duration unit" className={field} value={unit} onChange={e => setUnit(e.target.value)}><option value="1">Minutes</option><option value="60">Hours</option><option value="1440">Days</option></select></label></>}
                </div>}
                <label className="block text-sm">{action === 'issue' ? 'Warning reason' : action === 'remove' ? 'Reason for removing the warning' : action === 'lift' ? 'Reason for lifting the suspension' : 'Suspension reason'}<textarea aria-label="Discipline reason" required minLength={3} maxLength={500} rows={2} className={field} value={reason} onChange={e => setReason(e.target.value)} /></label>
                <p className="text-xs text-slate-600">Suspension blocks sign-in, existing sessions, receipt submissions and staff actions. Timed suspensions expire automatically; a supervisor can lift either type early. Warnings already used for a suspension do not immediately suspend the member again after lifting.</p>
                <button disabled={!selected || busy || action === 'remove' && !warning || action === 'lift' && !suspension} className={button + (action === 'suspend' ? ' bg-red-700' : '')}>{busy ? 'Saving…' : action === 'issue' ? 'Record warning' : action === 'remove' ? 'Remove warning' : action === 'lift' ? 'Lift suspension' : 'Suspend member'}</button>
            </fieldset>
        </form>
    </section>;
}
