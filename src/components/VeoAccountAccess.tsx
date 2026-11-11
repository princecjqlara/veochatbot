'use client';
import { useEffect, useState } from 'react';
import VeoAccountLoginSetup from './VeoAccountLoginSetup';
const labels: Record<string, string> = { ready: 'Sign-in configured', email_required: 'Login email and password required', password_required: 'New password required', disabled: 'Sign-in disabled', temporarily_locked: 'Temporarily locked', departed: 'Departed account' };
export default function VeoAccountAccess({ onSaved }: { onSaved: () => void }) {
    const [data, setData] = useState<any>(null), [error, setError] = useState(''), [version, setVersion] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        void fetch('/api/workspace/account-access', { cache: 'no-store', signal: controller.signal }).then(async response => {
            const body = await response.json();if (!response.ok || !Array.isArray(body.accounts)) throw Error(body.error || 'Sign-in status unavailable');
            if (!controller.signal.aborted) { setData(body);setError(''); }
        }).catch(e => { if (!controller.signal.aborted) setError(e.message); });
        return () => controller.abort();
    }, [version]);
    const pending = data?.accounts.filter((a: any) => a.active && !['ready', 'departed'].includes(a.status)).length;
    return <section aria-label="Account sign-in access" className="rounded-xl border bg-white p-5 space-y-4">
        <div className="flex flex-wrap justify-between gap-3"><h2 className="font-bold text-xl">Account sign-in access</h2><button type="button" className="text-sm underline" onClick={() => setVersion(v => v + 1)}>Refresh sign-in status</button></div>
        <p className="text-sm text-slate-600">Existing logins stay unchanged. Restored staff keep their roles, teams and Page assignments. For accounts without login details, enter the existing email and password to keep the same sign-in. Saving sign-in also clears the login cooldown for that email.</p>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {!data && !error && <p role="status">Checking account sign-in...</p>}
        {data && <><p role="status" className="text-sm font-medium">{pending ? `${pending} account${pending === 1 ? '' : 's'} need sign-in attention.` : 'All active accounts have sign-in configured.'}</p>
            {data.accounts.map((account: any) => <details key={account.id} className="rounded-lg border p-3" open={account.active && account.status !== 'ready'}>
                <summary className="cursor-pointer text-sm"><strong>{account.name}</strong> · {account.role.replaceAll('_', ' ')} · {labels[account.status] || 'Status unavailable'}</summary>
                <p className="mt-2 text-sm text-slate-600">{account.email || 'No login email has been set.'}</p>
                {account.retry_at && <p className="mt-2 text-sm">Cooldown ends {new Date(account.retry_at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })} PHT. Saving new sign-in details clears it immediately.</p>}
                {account.active && account.status !== 'departed' && <div className="mt-3"><VeoAccountLoginSetup account={account} onSaved={() => { setVersion(v => v + 1);onSaved(); }} /></div>}
            </details>)}</>}
    </section>;
}
