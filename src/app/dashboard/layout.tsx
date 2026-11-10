'use client';

import { useSession, signOut } from 'next-auth/react';
import { useRouter, usePathname } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { LogOut, Menu, MessageCircle, X } from 'lucide-react';
import VeoTelegramProfile from '@/components/VeoTelegramProfile';
import VeoTelegramReminder from '@/components/VeoTelegramReminder';
import VeoDashboardNavigation from '@/components/VeoDashboardNavigation';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
    const { data: session, status } = useSession();
    const router = useRouter(), pathname = usePathname();
    const [navigationOpen, setNavigationOpen] = useState(false);
    const adsBlocked = !!session?.user.role && !['owner', 'team_leader'].includes(session.user.role) && pathname.startsWith('/dashboard/ad-');
    useEffect(() => { if (adsBlocked) router.replace('/dashboard/workspace'); }, [adsBlocked, router]);
    useEffect(() => {
        if (status === 'authenticated' && !session?.user.id) { void signOut({ callbackUrl: '/' }); return; }
        if (status === 'unauthenticated') router.push('/');
    }, [status, router, session?.user.id]);
    useEffect(() => { setNavigationOpen(false); }, [pathname]);

    if (status !== 'authenticated' || !session) return <div className="flex min-h-screen items-center justify-center bg-slate-50"><p role="status" className="text-sm text-slate-600">{status === 'loading' ? 'Loading your workspace…' : 'Returning to sign in…'}</p></div>;
    if (adsBlocked) return <p role="status" className="p-6">Returning to your workspace…</p>;
    if (session.user.role && !session.user.telegramProfileConfirmed) return <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6"><section className="w-full max-w-lg"><VeoTelegramProfile confirmation /><button className="mx-auto mt-4 block text-sm text-slate-600 underline" onClick={() => void signOut({ callbackUrl: '/' })}>Sign out</button></section></main>;

    return <div className="min-h-screen bg-slate-50 md:flex">
        <aside className="shrink-0 border-b border-slate-200 bg-white md:sticky md:top-0 md:flex md:h-screen md:w-60 md:flex-col md:border-b-0 md:border-r">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
                <Link href={session.user.role ? '/dashboard/workspace' : '/dashboard'} prefetch={false} className="flex items-center gap-3 font-bold text-slate-900"><span className="rounded-lg bg-slate-900 p-2 text-white"><MessageCircle className="h-5 w-5" /></span><span>VEO</span></Link>
                <button type="button" aria-label={navigationOpen ? 'Close menu' : 'Open menu'} aria-expanded={navigationOpen} aria-controls="dashboard-menu" onClick={() => setNavigationOpen(!navigationOpen)} className="flex items-center gap-2 rounded border border-slate-200 px-3 py-2 text-sm md:hidden">{navigationOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}Menu</button>
            </div>
            <div id="dashboard-menu" className={`${navigationOpen ? 'flex' : 'hidden'} min-h-0 flex-1 flex-col md:flex`}>
                <div className="flex-1 overflow-y-auto"><Suspense fallback={<p className="p-4 text-sm text-slate-500">Loading menu…</p>}><VeoDashboardNavigation role={session.user.role} onNavigate={() => setNavigationOpen(false)} /></Suspense></div>
                <div className="space-y-3 border-t border-slate-200 p-4">
                    <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-900">{session.user.name || 'My account'}</p><p className="truncate text-xs text-slate-500">{session.user.email || ''}</p></div>
                    <button type="button" onClick={() => void signOut({ callbackUrl: '/' })} className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"><LogOut className="h-4 w-4" />Sign out</button>
                </div>
            </div>
        </aside>
        <main id="main-content" className="min-w-0 flex-1 p-3 sm:p-5 lg:p-6">{session.user.role && <VeoTelegramReminder username={session.user.telegramUsername} />}{children}</main>
    </div>;
}
