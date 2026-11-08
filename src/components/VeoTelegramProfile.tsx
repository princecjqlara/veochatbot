'use client';
import { useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';

export default function VeoTelegramProfile({ confirmation = false }: { confirmation?: boolean }) {
    const { data: session, update } = useSession();
    const [username, setUsername] = useState(session?.user.telegramUsername || '');
    const [noUsername, setNoUsername] = useState(Boolean(session?.user.telegramProfileCompleted && !session?.user.telegramUsername));
    const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const [command, setCommand] = useState('');
    const [linked, setLinked] = useState<boolean | null>(null);
    useEffect(() => {
        if (confirmation) return;
        const c = new AbortController();
        const check = async () => { try { const r = await fetch('/api/workspace/profile/telegram-link', { cache: 'no-store', signal: c.signal }), b = await r.json();if (r.ok && !c.signal.aborted) setLinked(b.linked); } catch { /* Keep the user's current form during a status outage. */ } };
        void check();const timer = command ? setInterval(() => void check(), 5000) : null;
        return () => { c.abort();if (timer) clearInterval(timer); };
    }, [confirmation, command]);
    return <form className="rounded-xl border bg-white p-6 space-y-4 text-slate-900" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setMessage('');
        try {
            const r = await fetch('/api/workspace/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: noUsername ? '' : username, no_username: noUsername }) });
            const body = await r.json(); if (!r.ok) throw new Error(body.error);
            await update(); setMessage('Telegram profile saved.');
        } catch (error: any) { setMessage(error.message || 'Please retry.'); } finally { setBusy(false); }
    }}>
        <h1 className="text-2xl font-bold">{confirmation ? 'Confirm your Telegram username' : 'Your Telegram profile'}</h1>
        <p className="text-sm text-slate-600">Enter the username shown in Telegram Settings. Keep it current so your supervisor can identify you in team groups.</p>
        <label className="block text-sm font-semibold">Telegram username
            <input className="block w-full border rounded p-3 mt-2 disabled:bg-slate-100" name="telegram_username" placeholder="@your_username" value={username} onChange={e => setUsername(e.target.value)} required={!noUsername} disabled={noUsername || busy} maxLength={33} pattern="@?[A-Za-z0-9_]{1,32}" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={noUsername} disabled={busy} onChange={e => setNoUsername(e.target.checked)} />I do not have a Telegram username</label>
        <p className="text-xs text-slate-500">Your supervisor will confirm the Telegram account used for team reports.</p>
        {message && <p role="status" className="text-sm">{message}</p>}
        <button className="rounded bg-slate-900 text-white px-4 py-3 disabled:opacity-40" disabled={busy}>{busy ? 'Saving…' : confirmation ? 'Continue to VEO' : 'Save Telegram profile'}</button>
        {!confirmation && <section className="border-t pt-4 space-y-3"><h2 className="font-semibold">Link your Telegram account</h2>{linked === true ? <p role="status" className="text-sm text-green-800">Telegram account linked. VEO checks your team groups and Pages automatically.</p> : <><p className="text-sm">Link once to let VEO find your team groups and assign their Pages automatically. Your supervisor’s branch and Page permissions apply.</p><button type="button" className="underline text-sm" disabled={busy} onClick={async () => {
            setBusy(true);setMessage('');
            try { const r = await fetch('/api/workspace/profile/telegram-link', { method: 'POST' }), b = await r.json();if (!r.ok) throw Error(b.error);setCommand(b.command); }
            catch (e: any) { setMessage(e.message || 'Please retry.'); } finally { setBusy(false); }
        }}>Create Telegram link command</button>{command && <div className="rounded border bg-slate-50 p-3 text-sm space-y-2"><p>Send this command yourself in one of your approved VEO Telegram groups with Jaucian. It expires in 15 minutes.</p><code className="block break-all select-all">{command}</code><p>Return here after sending. Group and Page checks run automatically within a few minutes. Team leaders and managers must be a Telegram group administrator for automatic group discovery; the Head can also configure groups.</p></div>}</>}</section>}
    </form>;
}
