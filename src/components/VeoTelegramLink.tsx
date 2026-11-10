'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { startAdaptivePolling } from '@/lib/adaptive-polling';

export default function VeoTelegramLink() {
    const { update } = useSession();
    const [linked, setLinked] = useState<boolean | null>(null), [identity, setIdentity] = useState('');
    const [relink, setRelink] = useState(false), [expected, setExpected] = useState(''), [code, setCode] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
    const load = useCallback(async (signal?: AbortSignal) => {
        try {
            const response = await fetch('/api/workspace/profile/telegram-link', { cache: 'no-store', signal });
            const body = await response.json();
            if (!response.ok || typeof body.linked !== 'boolean') throw Error(body.error || 'Telegram link status is unavailable.');
            if (!signal?.aborted) { setLinked(body.linked); setIdentity(body.telegram_user_id || ''); setError(''); }
        } catch (e: any) { if (!signal?.aborted) setError(e.message || 'Telegram link status is unavailable.'); throw e; }
    }, []);
    useEffect(() => {
        if (linked === true) return;
        return startAdaptivePolling(load, { intervalMs: code ? 8000 : 30000, immediate: true });
    }, [linked, code, load]);
    async function confirm() {
        if (busy || linked === null || code.length !== 48) return;
        setBusy(true); setError(''); setMessage('');
        try {
            const response = await fetch('/api/workspace/profile/telegram-link', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code, ...(relink ? { relink: true, expected_telegram_user_id: expected } : {}) }) });
            const body = await response.json();
            if (!response.ok || body.linked !== true) throw Error(body.error || 'Telegram could not be linked. Your current link is retained.');
            setLinked(true); if (body.telegram_user_id) setIdentity(body.telegram_user_id);
            setCode(''); setRelink(false); setExpected('');
            setMessage(relink ? 'Telegram account relinked. Your team membership will be checked automatically.' : 'Telegram account linked.');
            await update(); await load();
        } catch (e: any) { setError(e.message || 'Please retry. Your current link is retained.'); }
        finally { setBusy(false); }
    }
    return <section className="border-t pt-4 space-y-3" aria-label="Telegram account connection">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Telegram account connection</h2><button type="button" disabled={busy || relink} className="text-sm underline disabled:opacity-40" onClick={() => void load().catch(() => {})}>Refresh link status</button></div>
        {linked === null && <p role="status" className="text-sm">Checking your Telegram link...</p>}
        {linked === true && <p className="text-sm text-green-800">Telegram account linked{identity ? ` · ID ${identity}` : ''}. VEO checks your team groups and Pages automatically.</p>}
        {message && <p role="status" className="text-sm text-green-800">{message}</p>}
        {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
        {linked === true && !relink && <button type="button" disabled={busy || !identity} className="rounded border px-4 py-2 text-sm" onClick={() => { setExpected(identity); setRelink(true); setCode(''); setError(''); setMessage(''); }}>Relink Telegram account</button>}
        {(linked === false || relink) && <div className="space-y-3">
            <p className="text-sm">Open Jaucian in Telegram using the account you want to link and send <code>/link</code>. Paste the private code here within 10 minutes.</p>
            {relink && <p className="rounded border border-amber-200 bg-amber-50 p-3 text-sm">Your current link stays active until the new code is verified. Changing accounts requires a fresh team membership check. Existing sales, salary and attendance history remain attached to your VEO account.</p>}
            <label className="block text-sm font-semibold">One-time Telegram code<input aria-label="One-time Telegram code" value={code} onChange={e => setCode(e.target.value.trim().toLowerCase())} disabled={busy} className="mt-2 block w-full rounded border p-3 font-mono" placeholder="Paste the code from Jaucian" maxLength={48} pattern="[a-f0-9]{48}" autoComplete="one-time-code" /></label>
            <div className="flex flex-wrap gap-3"><button type="button" disabled={busy || code.length !== 48} className="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-40" onClick={() => void confirm()}>{busy ? 'Verifying Telegram...' : relink ? 'Verify and relink Telegram' : 'Link Telegram'}</button>{relink && <button type="button" disabled={busy} className="rounded border px-4 py-2 text-sm" onClick={() => { setRelink(false); setExpected(''); setCode(''); setError(''); }}>Cancel relink</button>}</div>
        </div>}
        <Link className="inline-block text-sm underline" href="/dashboard/workspace?view=telegram">Manage Telegram groups and Page routing</Link>
    </section>;
}
