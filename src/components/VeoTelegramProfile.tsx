'use client';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';

export default function VeoTelegramProfile({ confirmation = false }: { confirmation?: boolean }) {
    const { data: session, update } = useSession();
    const [username, setUsername] = useState(session?.user.telegramUsername || '');
    const [noUsername, setNoUsername] = useState(Boolean(session?.user.telegramProfileCompleted && !session?.user.telegramUsername));
    const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const [pairingCode, setPairingCode] = useState('');
    const [linked, setLinked] = useState<boolean | null>(null);
    useEffect(() => {
        if (confirmation) return;
        const c = new AbortController();
        const check = async () => { try { const r = await fetch('/api/workspace/profile/telegram-link', { cache: 'no-store', signal: c.signal }), b = await r.json(); if (r.ok && !c.signal.aborted) setLinked(b.linked); } catch { /* Keep the current form during a status outage. */ } };
        void check(); const timer = setInterval(() => void check(), 8000);
        return () => { c.abort(); clearInterval(timer); };
    }, [confirmation]);
    return <form className="rounded-xl border bg-white p-6 space-y-4 text-slate-900" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setMessage('');
        try {
            const r = await fetch('/api/workspace/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: noUsername ? '' : username, no_username: noUsername || !username.trim() }) });
            const body = await r.json(); if (!r.ok) throw new Error(body.error);
            await update(); setMessage('Telegram profile saved.');
        } catch (error: any) { setMessage(error.message || 'Please retry.'); } finally { setBusy(false); }
    }}>
        <h1 className="text-2xl font-bold">{confirmation ? 'Confirm your Telegram username' : 'Your Telegram profile'}</h1>
        <p className="text-sm text-slate-600">Link your Telegram account with a one-time code. Your Telegram username is optional and fills in automatically when available.</p>
        <label className="block text-sm font-semibold">Telegram username (optional)
            <input className="block w-full border rounded p-3 mt-2 disabled:bg-slate-100" name="telegram_username" placeholder="@your_username" value={username} onChange={e => { setUsername(e.target.value); setNoUsername(!e.target.value.trim()); }} disabled={busy} maxLength={33} pattern="@?[A-Za-z0-9_]{1,32}" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <p className="text-xs text-slate-500">The code confirms your Telegram account. The username is only a display detail.</p>
        {message && <p role="status" className="text-sm">{message}</p>}
        <button className="rounded bg-slate-900 text-white px-4 py-3 disabled:opacity-40" disabled={busy}>{busy ? 'Saving…' : confirmation ? 'Continue to VEO' : 'Save Telegram profile'}</button>
        {!confirmation && <section className="border-t pt-4 space-y-3"><h2 className="font-semibold">Link your Telegram account</h2>{linked === true ? <p role="status" className="text-sm text-green-800">Telegram account linked. VEO checks your team groups and Pages automatically.</p> : <><p className="text-sm">In Telegram, open a private chat with Jaucian and send <code>/link</code>. Jaucian checks your team group and replies with a code. Enter it here within 10 minutes.</p><label className="block text-sm font-semibold">One-time code<input value={pairingCode} onChange={e => setPairingCode(e.target.value.trim())} className="block w-full border rounded p-3 mt-2 font-mono" placeholder="Paste the code from Jaucian" maxLength={48} pattern="[a-f0-9]{48}" autoComplete="one-time-code" /></label><button type="button" className="rounded bg-slate-900 text-white px-4 py-3 disabled:opacity-40" disabled={busy || pairingCode.length !== 48} onClick={async () => { setBusy(true); setMessage(''); try { const r = await fetch('/api/workspace/profile/telegram-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairingCode }) }), b = await r.json(); if (!r.ok) throw Error(b.error); setLinked(true); setPairingCode(''); setMessage('Telegram account linked.'); } catch (e: any) { setMessage(e.message || 'Please retry.'); } finally { setBusy(false); } }}>Link Telegram</button></>}</section>}
    </form>;
}
