'use client';
import { useSession, signIn, signOut } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MessageCircle, ArrowRight } from 'lucide-react';
import { signInErrorMessage } from '@/lib/veo-sign-in-errors';
export default function VeoSignIn() {
    const { status, data: session } = useSession(), router = useRouter(), params = useSearchParams();
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    useEffect(() => {
        if (status !== 'authenticated') return;
        if (session?.user.workspaceUnavailable) { setError(signInErrorMessage('DatabaseUnavailable')); return; }
        if (!session?.user.id) { void signOut({ callbackUrl: '/' }); return; }
        router.replace('/dashboard/workspace');
    }, [status, router, session?.user.id, session?.user.workspaceUnavailable]);
    return <main className="flex min-h-[100dvh] items-center justify-center px-4 py-10 text-slate-900"><section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-10"><div className="mb-8 flex items-center gap-3"><span className="rounded-xl bg-slate-900 p-3 text-white"><MessageCircle aria-hidden="true" className="h-6 w-6" /></span><div><p className="text-lg font-bold tracking-tight">VEO</p><p className="text-xs text-slate-500">CJ Lara’s workspace</p></div></div><h1 className="text-3xl font-bold tracking-tight">Welcome back</h1><p className="mb-7 mt-3 text-sm leading-6 text-slate-500">Sign in with your administrator-created account, then confirm your Telegram username.</p><form className="space-y-5" aria-busy={busy} onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError('');
        const f = new FormData(e.currentTarget);
        try { const r = await signIn('credentials', { email: f.get('email'), password: f.get('password'), redirect: false });
            if (r?.ok && !r.error) router.push('/dashboard/workspace'); else setError(signInErrorMessage(r?.error));
        } catch { setError(signInErrorMessage('NetworkUnavailable')); } finally { setBusy(false); }
    }}><label className="block text-sm font-medium">Email<input className="input-wireframe mt-2 h-12" name="email" type="email" autoComplete="username" placeholder="you@example.com" required /></label><label className="block text-sm font-medium">Password<input className="input-wireframe mt-2 h-12" name="password" type="password" autoComplete="current-password" required /></label><button disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 p-3 text-sm font-semibold text-white transition-colors hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 disabled:opacity-50">{busy ? 'Signing in…' : 'Sign in'}<ArrowRight aria-hidden="true" className="h-4 w-4" /></button></form>{(error || params.get('error')) && <p role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-6 text-red-700">{error || signInErrorMessage(params.get('error'))}</p>}<p className="mt-7 border-t border-slate-100 pt-5 text-xs leading-5 text-slate-500">Your account permissions are applied automatically after sign-in.</p></section></main>;
}
