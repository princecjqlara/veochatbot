'use client';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
export default function VeoTelegramReminder({ username }: { username?: string | null }) {
    const [linked, setLinked] = useState<boolean | null>(null), pathname = usePathname();
    useEffect(() => {
        const c = new AbortController();
        void (async () => { try { const r = await fetch('/api/workspace/profile/telegram-link', { cache: 'no-store', signal: c.signal }), b = await r.json();if (r.ok && !c.signal.aborted) setLinked(b.linked); } catch { /* Retry when the user returns to another page. */ } })();
        return () => c.abort();
    }, [pathname]);
    if (username && linked !== false) return null;
    return <aside role="status" className="m-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-slate-900">{!username ? 'Add your Telegram username and link your Telegram account to sync your team groups and Pages.' : 'Link your Telegram account once to sync your team groups and Pages automatically.'} <Link className="underline font-semibold" href="/dashboard/workspace?view=profile">Update Telegram profile</Link></aside>;
}
